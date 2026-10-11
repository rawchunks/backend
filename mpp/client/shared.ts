import { Credential, Method, Receipt, Store } from 'mppx';
import type { x402Client } from '@x402/core/client';
import type { PaymentRequirements } from '@x402/core/types';
import { atomic, batch, canonical, checkPayment, upto } from '../methods.js';
import type { Definition, Intent, PaymentReceipt } from '../methods.js';

export type ClientOptions = {
  /** A configured official client retains network mechanisms, policies and extension hooks. */
  client: x402Client;
  networks: readonly string[];
  /** Persist this with channel state to retain receipt deduplication across restarts. */
  receipts?: Store.AtomicStore;
};

export type ClientMethod = Method.Client<Definition, undefined> & {
  onResponse(event: { credential: string; response: Response }): Promise<void>;
};
export function createMethod(intent: Intent, options: ClientOptions): ClientMethod {
  if (!options.networks.length) throw new Error('At least one supported network is required');
  const definition = intent === 'upto' ? upto : batch;
  const receipts = options.receipts ?? Store.memory();
  const method = Method.toClient(definition, {
    canHandleChallenge({ challenge }) {
      const result = definition.schema.request.safeParse(challenge.request);
      return result.success && result.data.methodDetails.requirements.scheme === intent && options.networks.includes(result.data.methodDetails.requirements.network);
    },
    async createCredential({ challenge }) {
      const request = definition.schema.request.parse(challenge.request);
      if (!options.networks.includes(request.methodDetails.requirements.network)) throw new Error('Unsupported network');
      const d = request.methodDetails;
      const payment = await options.client.createPaymentPayload({ x402Version: 2, resource: d.resource, accepts: [d.requirements as PaymentRequirements], extensions: d.extensions });
      checkPayment({ payment }, request, intent);
      return Credential.serialize({ challenge, payload: { payment } });
    },
  });

  async function onResponse({ credential, response }: { credential: string; response: Response }) {
    const submitted = Credential.deserialize(credential);
    const { payment, request } = checkPayment(submitted.payload, submitted.challenge.request, intent);
    const encoded = response.headers.get('Payment-Receipt');
    if (encoded) {
      const receipt = Receipt.deserialize(encoded) as PaymentReceipt;
      const x = receipt.x402;
      if (receipt.method !== definition.name || !x || x.version !== 1 || x.intent !== intent || x.challengeId !== submitted.challenge.id)
        throw new Error('Receipt does not match the payment');
      if (!x.settlement.success || x.settlement.network !== payment.accepted.network || atomic(x.chargedAmount) > atomic(request.amount))
        throw new Error('Invalid settlement receipt');
      if (intent === 'batch-settlement' && x.chargedAmount !== request.amount) throw new Error('Batch receipt charged the wrong amount');
      if (intent === 'upto' && x.stage !== 'settled' && x.stage !== 'no-charge') throw new Error('Invalid upto receipt stage');
      if (x.stage === 'no-charge' && x.chargedAmount !== '0') throw new Error('Invalid no-charge receipt');
      const key = `mpp:x402:receipt:${intent}:${submitted.challenge.realm}:${submitted.challenge.id}`;
      const identity = canonical(receipt);
      const state = await receipts.update<string, 'new' | 'done' | 'pending'>(key, current => {
        if (current) {
          const saved = current as { identity: string; state: string };
          if (saved.identity !== identity) throw new Error('Challenge received conflicting receipts');
          return { op: 'noop', result: saved.state === 'done' ? 'done' : 'pending' };
        }
        return { op: 'set', value: { identity, state: 'pending' }, result: 'new' };
      });
      if (state === 'done') return;
      if (state === 'pending') throw new Error('Receipt reconciliation is pending; inspect client channel state');
      await options.client.handlePaymentResponse({ paymentPayload: payment, requirements: payment.accepted, settleResponse: x.settlement });
      await receipts.put(key, { identity, state: 'done' });
      return;
    }
    if (response.ok) throw new Error('Successful paid response omitted its Payment-Receipt');
    if (response.status === 402) {
      const body: unknown = await response.clone().json();
      const candidate = body as { paymentRequired?: { x402Version: number; accepts: typeof payment.accepted[]; resource: typeof payment.resource } };
      const correction = candidate.paymentRequired;
      if (correction && correction.x402Version === 2 && correction.resource && canonical(correction.resource) === canonical(payment.resource)) {
        await options.client.handlePaymentResponse({ paymentPayload: payment, requirements: payment.accepted, paymentRequired: correction as Parameters<x402Client['handlePaymentResponse']>[0]['paymentRequired'] });
      }
    }
  }
  return Object.assign(method, { onResponse });
}
