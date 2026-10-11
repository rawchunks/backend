import { createHash } from 'node:crypto';
import { Method } from 'mppx';
import type { Credential, Store } from 'mppx';
import type { FacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, SettleResponse } from '@x402/core/types';
import { atomic, batch, canonical, checkPayment, upto } from '../methods.js';
import type { Definition, Intent, PaymentReceipt, PaymentRequest } from '../methods.js';

export type WorkResult = { response: Response; amount?: string };
export type Work = (context: { payment: PaymentPayload; request: PaymentRequest }) => Promise<WorkResult>;
export type ServerOptions = {
  server: x402ResourceServer;
  /** Must verify read-only and correspond to this server's selected facilitator. */
  facilitator: FacilitatorClient;
  /** Durable atomic storage is required in production; Store.memory() is for one process. */
  store: Store.AtomicStore;
  /** Namespace for a merchant/service. Sharing it protects against cross-route proof replay. */
  namespace: string;
  /** Server-owned metering for direct Mppx.broadcastCredential use. */
  meter?: (context: { payment: PaymentPayload; request: PaymentRequest }) => Promise<string>;
  /** Override when a mechanism has a stronger authorization identity than its proof fields. */
  proofKey?: (payment: PaymentPayload) => string;
  /** Optional batch readiness/extension checks after the official server reserves payment. */
  admitted?: (context: { payment: PaymentPayload; request: PaymentRequest }) => Promise<void>;
};
export type Journal = { fingerprint: string; payment: PaymentPayload; amount?: string; state: 'running' | 'done' | 'failed' | 'uncertain'; receipt?: PaymentReceipt; error?: string };
export type ServerMethod = Method.Server<Definition> & {
  execute(credential: Credential.Credential, work?: Work): Promise<{ receipt: PaymentReceipt; response?: Response }>;
  inspect(id: string): Promise<Journal | null>;
  /** Record an independently reconciled outcome. This never broadcasts or repeats resource work. */
  reconcile(id: string, receipt: PaymentReceipt): Promise<void>;
};
export class PaymentError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PaymentError'; }
}
function hash(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function proofIdentity(payment: PaymentPayload): unknown {
  const p = payment.payload;
  if (payment.accepted.scheme === 'batch-settlement' && p.voucher && typeof p.voucher === 'object') {
    const v = p.voucher as Record<string, unknown>;
    return { channelId: String(v.channelId).toLowerCase(), maxClaimableAmount: BigInt(String(v.maxClaimableAmount)).toString() };
  }
  if (p.permit2Authorization && typeof p.permit2Authorization === 'object') {
    const a = p.permit2Authorization as Record<string, unknown>;
    return { from: String(a.from).toLowerCase(), nonce: BigInt(String(a.nonce)).toString(), spender: String(a.spender).toLowerCase() };
  }
  throw new PaymentError('identity', 'Supply proofKey for this authorization mechanism');
}

export function createMethod(intent: Intent, options: ServerOptions): ServerMethod {
  if (!options.namespace || typeof options.store.update !== 'function') throw new Error('A namespace and atomic store are required');
  const definition = intent === 'upto' ? upto : batch;
  const prefix = `mpp:${options.namespace}:`;

  function prepare(credential: Credential.Credential) {
    if (credential.challenge.method !== definition.name || credential.challenge.intent !== intent) throw new PaymentError('method', 'Wrong MPP method/intent');
    if (!credential.challenge.expires || Date.parse(credential.challenge.expires) <= Date.now() || !Number.isFinite(Date.parse(credential.challenge.expires)))
      throw new PaymentError('expired', 'An unexpired challenge is required');
    const parsed = checkPayment(credential.payload, credential.challenge.request, intent);
    const { payment, request } = parsed;
    if (!options.server.hasRegisteredScheme(payment.accepted.network, intent) || !options.server.getSupportedKind(2, payment.accepted.network, intent))
      throw new PaymentError('unsupported', 'Initialize the resource server with a supported scheme/network');
    if (options.server.getPaymentFlow(payment, payment.accepted) !== 'authorization') throw new PaymentError('flow', 'This extension requires an authorization payment flow');
    const extensions = options.server.validateExtensions({ x402Version: 2, resource: payment.resource!, accepts: [payment.accepted], extensions: request.methodDetails.extensions }, payment);
    if (!extensions.valid) throw new PaymentError('extensions', 'Client modified declared x402 extensions');
    return parsed;
  }
  function key(id: string) { return `${prefix}operation:${id}`; }

  async function inspect(id: string) { return await options.store.get(key(id)) as Journal | null; }

  async function reconcile(id: string, receipt: PaymentReceipt) {
    await options.store.update<string, void>(key(id), current => {
      const journal = current as Journal | null;
      if (!journal || journal.state !== 'uncertain') throw new PaymentError('state', 'Only an uncertain operation can be reconciled');
      const x = receipt.x402;
      if (receipt.method !== definition.name || receipt.status !== 'success' || !x || x.version !== 1 || x.intent !== intent || x.challengeId !== id || !x.settlement.success || x.settlement.network !== journal.payment.accepted.network || x.chargedAmount !== journal.amount || atomic(x.chargedAmount) > atomic(journal.payment.accepted.amount))
        throw new PaymentError('receipt', 'Reconciled receipt does not match this payment');
      if (intent === 'upto' && atomic(x.chargedAmount) > 0n && (!x.settlement.transaction || x.stage !== 'settled'))
        throw new PaymentError('receipt', 'A charged upto payment requires confirmed settlement');
      return { op: 'set', value: { ...journal, state: 'done', receipt }, result: undefined };
    });
  }

  async function execute(credential: Credential.Credential, work?: Work): Promise<{ receipt: PaymentReceipt; response?: Response }> {
    const { payment, request } = prepare(credential);
    if (intent === 'upto' && !work && !options.meter) throw new PaymentError('meter', 'upto requires server-owned metering');
    const id = credential.challenge.id;
    const fingerprint = hash({ challenge: credential.challenge, payment });
    const previous = await options.store.update<string, Journal | null>(key(id), current => {
      if (current) return { op: 'noop', result: current as Journal };
      return { op: 'set', value: { fingerprint, payment, state: 'running' }, result: null };
    });
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PaymentError('replay', 'Challenge already used with another proof');
      if (previous.state === 'done' && previous.receipt) return { receipt: previous.receipt };
      throw new PaymentError(previous.state, previous.error ?? 'Payment already in progress');
    }
    let terminal = false;
    let admitted = false;
    let proof: string | undefined;
    let amount: string | undefined;
    const context = { request: credential.challenge, challengeId: id };
    async function write(value: Omit<Journal, 'fingerprint' | 'payment'>) {
      await options.store.put(key(id), { fingerprint, payment, amount, ...value });
    }
    try {
      const precheck = await options.facilitator.verify(payment, payment.accepted);
      if (!precheck.isValid) throw new PaymentError(precheck.invalidReason ?? 'invalid', precheck.invalidMessage ?? 'x402 proof rejected');
      const identity = hash({ scheme: intent, network: payment.accepted.network, asset: payment.accepted.asset,
        proof: options.proofKey?.(payment) ?? proofIdentity(payment) });
      const proofStorageKey = `${prefix}proof:${hash(identity)}`;
      const claimed = await options.store.update<string, boolean>(proofStorageKey, current => {
        if (current) return { op: 'noop', result: false };
        return { op: 'set', value: { challengeId: id }, result: true };
      });
      if (!claimed) throw new PaymentError('replay', 'Authorization already used by another challenge');
      proof = proofStorageKey;
      const verified = await options.server.verifyPayment(payment, payment.accepted, request.methodDetails.extensions, context);
      if (!verified.isValid) throw new PaymentError(verified.invalidReason ?? 'invalid', verified.invalidMessage ?? 'x402 verification failed');
      admitted = true;
      if (verified.skipHandler) throw new PaymentError('management', 'Management credentials are not resource payments');
      await options.admitted?.({ payment, request });
      const completed = work ? await work({ payment, request }) : undefined;
      if (completed && !completed.response.ok) throw new PaymentError('handler', 'Resource handler failed');
      amount = intent === 'batch-settlement' ? request.amount : completed?.amount ?? await options.meter?.({ payment, request });
      if (amount === undefined) throw new PaymentError('meter', 'Handler must return its measured amount');
      if (atomic(amount) > atomic(request.amount)) throw new PaymentError('cap', 'Measured usage exceeds the signed maximum');
      let settlement: SettleResponse;
      if (intent === 'upto' && atomic(amount) === 0n) {
        settlement = { success: true, transaction: '', network: payment.accepted.network, amount: '0', payer: verified.payer };
      } else {
        // Persist the exact billed amount before anything that could consume funds.
        await write({ state: 'uncertain' });
        terminal = true;
        settlement = await options.server.settlePayment(payment, payment.accepted, request.methodDetails.extensions, context,
          intent === 'upto' ? { amount } : undefined, 'after-handler');
        if (!settlement.success) throw new PaymentError('uncertain', settlement.errorMessage ?? settlement.errorReason ?? 'Settlement outcome requires reconciliation');
        if (settlement.network !== payment.accepted.network) throw new PaymentError('uncertain', 'Settlement returned the wrong network');
        if (intent === 'upto' && (!settlement.transaction || (settlement.amount !== undefined && atomic(settlement.amount) !== atomic(amount))))
          throw new PaymentError('uncertain', 'Invalid upto settlement response');
        if (intent === 'batch-settlement' && !settlement.transaction && (!settlement.extra?.channelState || settlement.extra?.chargedAmount !== amount))
          throw new PaymentError('uncertain', 'Batch acceptance lacks authoritative channel state');
      }
      const receipt: PaymentReceipt = { method: definition.name, status: 'success', timestamp: new Date().toISOString(),
        reference: settlement.transaction || id,
        x402: { version: 1, intent, challengeId: id, stage: amount === '0' ? 'no-charge' : intent === 'batch-settlement' ? settlement.transaction ? 'funded' : 'accepted' : 'settled', chargedAmount: amount, settlement } };
      await write({ state: 'done', receipt });
      return { receipt, response: completed?.response };
    } catch (error) {
      if (admitted && !terminal) {
        try { await options.server.createPaymentCancellationDispatcher(payment, payment.accepted, request.methodDetails.extensions, context).cancel({ reason: 'handler_threw', error }); }
        catch { terminal = true; }
      }
      if (proof && !terminal) {
        await options.store.update<string, void>(proof, current => {
          if ((current as { challengeId?: string } | null)?.challengeId === id) return { op: 'delete', result: undefined };
          return { op: 'noop', result: undefined };
        });
      }
      await write({ state: terminal ? 'uncertain' : 'failed', error: error instanceof Error ? error.message : 'Payment failed' });
      if (terminal) throw new PaymentError('uncertain', error instanceof Error ? error.message : 'Settlement outcome unknown');
      throw error;
    }
  }

  const method = Method.toServer(definition, {
    async validate({ credential, request: input }) {
      const { payment, request } = prepare(credential);
      if (canonical(input) !== canonical(request)) throw new PaymentError('binding', 'Route terms differ from challenge');
      // Direct /verify performs no resource-server channel reservations or settlement hooks.
      const details = await options.facilitator.verify(payment, payment.accepted);
      if (!details.isValid) throw new PaymentError(details.invalidReason ?? 'invalid', details.invalidMessage ?? 'x402 proof rejected');
      return { challenge: credential.challenge, credential, request, details, method: definition.name, intent: definition.intent, source: credential.source };
    },
    async broadcast({ credential, request }) {
      if (canonical(request) !== canonical(credential.challenge.request)) throw new PaymentError('binding', 'Route terms differ from challenge');
      return (await execute(credential)).receipt;
    },
  });
  return Object.assign(method, { execute, inspect, reconcile });
}
