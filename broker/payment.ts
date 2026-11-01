import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { valkey, getTaskContext, withJobLock, type JobLease } from './valkey.js';

export interface KeyPayload {
  sub: string;
  keyId: string;
  network?: string;
  budgetLimit: number;
  budgetUsed: number;
  exp?: number;
  iat?: number;
}

export interface SessionPaymentConfig {
  amountWei: string;
  priceUsd: number;
  action: string;
  payTo?: string;
  creatorAddress?: string;
  durationMs?: number;
}

export const PRICING = {
  vibe: { amountWei: '30000', priceUsd: 0.03, action: 'vibe' },
} as const satisfies Record<string, SessionPaymentConfig>;

export type SessionPaymentResolver = (
  req: FastifyRequest
) => Promise<SessionPaymentConfig | null> | SessionPaymentConfig | null;

export interface SessionPaymentOptions {
  isExempt?: (req: FastifyRequest) => Promise<boolean> | boolean;
  metered?: boolean;
}

// In-memory cache to track local budget increments during burst/concurrent requests (zero latency)
const localBudgetCache = new Map<string, { used: number; expiresAt: number }>();
const revokedSessionTokens = new Map<string, number>();

function isRevokedToken(token: string): boolean {
  const hash = createHash('sha256').update(token).digest('hex');
  const expiresAt = revokedSessionTokens.get(hash);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    revokedSessionTokens.delete(hash);
    return false;
  }
  return true;
}

function revokeToken(token: string): void {
  const hash = createHash('sha256').update(token).digest('hex');
  revokedSessionTokens.set(hash, Date.now() + 30 * 60 * 1000);
}

function getTrackedBudgetUsed(keyId: string, initialUsed: number): number {
  const now = Date.now();
  const cached = localBudgetCache.get(keyId);
  if (cached && cached.expiresAt > now) {
    return Math.max(cached.used, initialUsed);
  }
  return initialUsed;
}

function trackBudgetUsed(keyId: string, newUsed: number): void {
  localBudgetCache.set(keyId, { used: newUsed, expiresAt: Date.now() + 30 * 60 * 1000 });
}

export function extractSessionToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && typeof auth === 'string') {
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    if (auth.startsWith('compose-')) return auth.trim();
  }
  const keyToken = req.headers['x-key-token'];
  if (keyToken && typeof keyToken === 'string') {
    return keyToken.trim();
  }
  return null;
}

export function parseComposeToken(token: string): KeyPayload | null {
  if (!token || typeof token !== 'string') return null;
  const clean = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  if (!clean.startsWith('compose-')) return null;
  if (isRevokedToken(clean)) return null;
  const jwt = clean.slice('compose-'.length);
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string };
    if (!header || typeof header !== 'object' || String(header.alg || '').toLowerCase() === 'none') return null;
    const secret = process.env.COMPOSE_JWT_SECRET || process.env.COMPOSE_SESSION_SECRET;
    if (secret) {
      const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
      if (expected.length !== parts[2].length || !timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) {
        return null;
      }
    }
    const jsonStr = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(jsonStr) as KeyPayload;
    if (!payload.sub || !payload.keyId) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getPlatformTreasury(network: string): string {
  if (!network || typeof network !== 'string') {
    throw new Error('Network ID is required to resolve platform treasury');
  }
  const isSolana = network.startsWith('solana:');
  const address = isSolana
    ? process.env.RAWCHUNKS_SOLANA_TREASURY_ADDRESS
    : (process.env.RAWCHUNKS_TREASURY_ADDRESS || process.env.PAY_TO_ADDRESS);
  if (!address) {
    throw new Error(`Platform treasury address not configured for network: ${network}`);
  }
  return address;
}

export function buildPaymentRequiredHeader(
  amountWei: string,
  network: string,
  resource: string,
  payTo?: string
): string {
  const destination = payTo || getPlatformTreasury(network);
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network,
        amount: amountWei,
        asset: 'USDC',
        payTo: destination,
      },
    ],
    resource: {
      url: resource,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function getComposeApiUrl(): string {
  const url = process.env.COMPOSE_API_URL;
  if (!url) {
    throw new Error('COMPOSE_API_URL is required and must be configured');
  }
  return url.replace(/\/+$/, '');
}

export async function settleSessionPaymentAsync(params: {
  token: string;
  network: string;
  userAddress: string;
  amountWei: string;
  action: string;
  resource: string;
  method: string;
  payTo?: string;
  creatorAddress?: string;
}): Promise<void> {
  try {
    const composeUrl = getComposeApiUrl();
    const payTo = params.payTo || getPlatformTreasury(params.network);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'x-network-id': params.network,
      'x-session-user-address': params.userAddress,
    };

    const totalWei = BigInt(params.amountWei);
    const creatorAddress = params.creatorAddress;
    const treasuryAddress = payTo;
    const creatorShareWei = creatorAddress ? ((totalWei * 8000n) / 10000n).toString() : '0';
    const treasuryFeeWei = creatorAddress ? (totalWei - BigInt(creatorShareWei)).toString() : totalWei.toString();

    const prepareBody: Record<string, unknown> = {
      maxAmountWei: params.amountWei,
      service: 'rawchunks',
      action: params.action,
      resource: params.resource,
      method: params.method,
      payTo,
      royalties: {
        creator: creatorAddress,
        treasury: treasuryAddress,
      },
    };

    if (creatorAddress) {
      prepareBody.creatorAddress = creatorAddress;
    }

    const prepareRes = await fetch(`${composeUrl}/api/payments/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify(prepareBody),
    });

    if (!prepareRes.ok) {
      if (prepareRes.status === 401 || prepareRes.status === 403) revokeToken(params.token);
      const errText = await prepareRes.text().catch(() => '');
      console.warn(`[Payment] Async prepare failed (${prepareRes.status}):`, errText);
      return;
    }

    const prepareData = (await prepareRes.json()) as { paymentIntentId?: string };
    if (!prepareData.paymentIntentId) {
      console.warn('[Payment] Async prepare did not return paymentIntentId:', prepareData);
      return;
    }

    const settleBody: Record<string, unknown> = {
      paymentIntentId: prepareData.paymentIntentId,
      finalAmountWei: params.amountWei,
      executeImmediately: true,
      royalties: {
        creator: creatorAddress,
        treasury: treasuryAddress,
      },
    };

    if (creatorAddress) {
      settleBody.providerAmountWei = creatorShareWei;
      settleBody.platformFeeWei = treasuryFeeWei;
    }

    const settleRes = await fetch(`${composeUrl}/api/payments/settle`, {
      method: 'POST',
      headers,
      body: JSON.stringify(settleBody),
    });

    if (!settleRes.ok) {
      const errText = await settleRes.text().catch(() => '');
      console.warn(`[Payment] Async settle failed (${settleRes.status}):`, errText);
      return;
    }

    const settleData = (await settleRes.json()) as { status?: string; txHash?: string };
    console.log(`[Payment] Settled intent ${prepareData.paymentIntentId} on-chain: status=${settleData.status}, txHash=${settleData.txHash}`);
  } catch (err: any) {
    // Non-blocking background log
    console.warn('[Payment] Async settlement error:', err?.message || err);
  }
}

type PaymentBody = Record<string, unknown>;
export class PaymentError extends Error {
  constructor(public statusCode: number, public body: PaymentBody, public headers: Record<string, string> = {}) {
    super(typeof body.error === 'string' ? body.error : 'Payment request failed');
  }
}
export interface PlaybackReceipt {
  status: string;
  acceptedListenedSeconds: number;
  billedWei: string;
  deltaWei: string;
  txHash?: string;
  headers?: Record<string, string>;
}
interface PaymentObligation {
  millis: number;
  cumulativeWei: string;
  prepare: PaymentBody;
  settle?: PaymentBody;
  receipt?: PlaybackReceipt;
}
interface PlaybackPayment {
  id: string;
  token: string;
  network: string;
  account: string;
  songId: string;
  creator: string;
  treasury: string;
  rate: string;
  durationMs: number;
  admission: PaymentBody;
  intent?: string;
  observedMs: number;
  acceptedMs: number;
  billedWei: string;
  terminal: boolean;
  closed: boolean;
  usedAdmission: boolean;
  pending?: PaymentObligation;
  obligations: PaymentObligation[];
}
const recoverySet = 'rawchunks:payments';
const playbackKey = (intent: string) => `rawchunks:payment:${intent}`;
const durableStatuses = new Set(['queued', 'submitted', 'confirmed']);

async function sendPayment(state: PlaybackPayment, operation: string, body: PaymentBody) {
  let response: Response;
  try {
    response = await fetch(`${getComposeApiUrl()}/api/payments/${operation}`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', 'x-network-id': state.network, 'x-session-user-address': state.account },
      body: JSON.stringify(body),
    });
  } catch { throw new PaymentError(503, { error: 'Payment provider unavailable; obligation retained' }); }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (/^(payment-|x-payment-|x-session-|x-key-|x-settlement|x-transaction-|retry-after)/i.test(name)) headers[name] = value;
  });
  const result = await response.json().catch(() => null) as PaymentBody | null;
  if (!response.ok) throw new PaymentError(response.status, result || { error: 'Payment provider rejected the request' }, headers);
  if (!result || typeof result !== 'object') throw new PaymentError(502, { error: 'Invalid payment provider response' }, headers);
  return { result, headers };
}

async function admitPlayback(state: PlaybackPayment, lease: JobLease) {
  if (state.creator && state.creator.startsWith('0x') === state.network.startsWith('solana:')) {
    throw new PaymentError(409, { error: 'Playback payout belongs to another payment network; restart playback' });
  }
  if (!state.intent) {
    const { result } = await sendPayment(state, 'prepare', state.admission);
    if (typeof result.paymentIntentId !== 'string' || !result.paymentIntentId) throw new PaymentError(502, { error: 'Payment provider did not admit playback' });
    state.intent = result.paymentIntentId;
    await lease.save(state.id, state);
  }
  await valkey.set(playbackKey(state.intent), state.id);
}

function settlementBody(state: PlaybackPayment, intent: string, cumulative: bigint): PaymentBody {
  const previous = BigInt(state.billedWei);
  const delta = cumulative - previous;
  const creator = state.creator ? cumulative * 80n / 100n - previous * 80n / 100n : 0n;
  const treasury = delta - creator;
  // Zero-valued explicit split fields are rejected by Compose. Tiny tails may have only one recipient.
  if (!creator || !treasury) return {
    paymentIntentId: intent, finalAmountWei: String(delta), executeImmediately: true,
    royalties: creator ? { creator: state.creator, treasury: state.creator } : { treasury: state.treasury },
  };
  return {
    paymentIntentId: intent, finalAmountWei: String(delta), executeImmediately: true,
    providerAmountWei: String(creator), platformFeeWei: String(treasury),
    royalties: { creator: state.creator, treasury: state.treasury },
  };
}

async function resolveStreamCreator(creatorAddress: string, network: string): Promise<string> {
  if (!creatorAddress) return '';
  const { parseAddress, getWalletPair } = await import('../databases/users.js');
  const creator = parseAddress(creatorAddress);
  const kind = network.startsWith('solana:') ? 'svm' : 'evm';
  if (creator.kind === kind) return creator.value;
  const pair = await getWalletPair(creator.value);
  const payout = kind === 'svm' ? pair?.svmAddress : pair?.evmAddress;
  if (payout) {
    try {
      const parsed = parseAddress(payout);
      if (parsed.kind === kind) return parsed.value;
    } catch { /* An incomplete or invalid pair cannot receive this payment. */ }
  }
  throw new PaymentError(409, { error: 'Creator payout unavailable for the session payment network', network });
}

export async function prepareStreamPaymentIntent(params: {
  token: string; network: string; userAddress: string; maxAmountWei: string; songId: string;
  creatorAddress: string; payTo?: string; streamPriceUsd?: number; durationMs?: number; idempotencyKey?: string;
}): Promise<string> {
  const identity = params.idempotencyKey || randomUUID();
  const id = `payment:${createHash('sha256').update(`${params.token}:${params.network}:${params.songId}:${identity}`).digest('hex')}`;
  return withJobLock(id, async lease => {
    let state = await getTaskContext<PlaybackPayment>(id);
    if (!state) {
      const rate = Math.round((params.streamPriceUsd ?? Number(params.maxAmountWei) / 1000000) * 1000000);
      const durationMs = params.durationMs ?? 60000;
      if (!Number.isSafeInteger(rate) || rate < 0 || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new PaymentError(400, { error: 'Invalid playback price or duration' });
      const treasury = params.payTo || getPlatformTreasury(params.network);
      const creator = await resolveStreamCreator(params.creatorAddress, params.network);
      state = {
        id, token: params.token, network: params.network, account: params.userAddress, songId: params.songId,
        creator, treasury, rate: String(rate), durationMs,
        admission: {
          maxAmountWei: params.maxAmountWei, service: 'rawchunks', action: 'stream-playback',
          resource: `/api/songs/${params.songId}/stream`, method: 'GET', payTo: treasury,
          royalties: { creator: creator || undefined, treasury }, runId: id, idempotencyKey: `${id}:admission`,
        },
        observedMs: 0, acceptedMs: 0, billedWei: '0', terminal: false, closed: false, usedAdmission: false, obligations: [],
      };
      await valkey.sadd(recoverySet, id);
      await lease.save(id, state);
    }
    await admitPlayback(state, lease);
    return state.intent!;
  });
}

async function drainPayment(state: PlaybackPayment, lease: JobLease): Promise<PlaybackReceipt> {
  await admitPlayback(state, lease);
  const before = BigInt(state.billedWei);
  while (state.pending || state.observedMs > state.acceptedMs) {
    if (!state.pending) {
      const cumulative = BigInt(state.observedMs) * BigInt(state.rate) / 60000n;
      if (cumulative <= BigInt(state.billedWei)) { state.acceptedMs = state.observedMs; await lease.save(state.id, state); break; }
      const identity = `${state.id}:${state.observedMs}`;
      state.pending = {
        millis: state.observedMs, cumulativeWei: String(cumulative),
        prepare: { ...state.admission, maxAmountWei: String(cumulative - BigInt(state.billedWei)), runId: identity, idempotencyKey: identity },
        ...(!state.usedAdmission ? { settle: settlementBody(state, state.intent!, cumulative) } : {}),
      };
      await lease.save(state.id, state);
    }
    const pending = state.pending;
    if (!pending.settle) {
      const { result } = await sendPayment(state, 'prepare', pending.prepare);
      if (typeof result.paymentIntentId !== 'string' || !result.paymentIntentId) throw new PaymentError(502, { error: 'Missing checkpoint intent' });
      pending.settle = settlementBody(state, result.paymentIntentId, BigInt(pending.cumulativeWei));
      await lease.save(state.id, state);
    }
    const { result, headers } = await sendPayment(state, 'settle', pending.settle);
    const status = String(result.status || '');
    if (!durableStatuses.has(status)) throw new PaymentError(502, { error: 'Payment was not durably accepted', status }, headers);
    pending.receipt = {
      status, acceptedListenedSeconds: pending.millis / 1000, billedWei: pending.cumulativeWei,
      deltaWei: String(BigInt(pending.cumulativeWei) - BigInt(state.billedWei)), headers,
      ...(typeof result.txHash === 'string' ? { txHash: result.txHash } : {}),
    };
    state.billedWei = pending.cumulativeWei;
    state.acceptedMs = pending.millis;
    state.usedAdmission = true;
    state.obligations.push(pending);
    delete state.pending;
    await lease.save(state.id, state);
  }
  if (state.terminal && !state.closed) {
    if (!state.usedAdmission) await sendPayment(state, 'abort', { paymentIntentId: state.intent, reason: 'Playback ended without billable audio' });
    state.closed = true;
    await lease.save(state.id, state);
  }
  const latest = state.obligations.at(-1)?.receipt;
  const receipt = {
    status: latest?.status || 'skipped', acceptedListenedSeconds: state.acceptedMs / 1000,
    billedWei: state.billedWei, deltaWei: String(BigInt(state.billedWei) - before), txHash: latest?.txHash, headers: latest?.headers,
  };
  if (state.closed && state.obligations.every(item => item.receipt?.status === 'confirmed')) await valkey.srem(recoverySet, state.id);
  return receipt;
}

export async function settleStreamCheckpoint(params: {
  paymentIntentId: string; network: string; listenedSeconds: number; token?: string; songId?: string; terminal?: boolean;
  streamPriceUsd?: number; creatorAddress?: string; payTo?: string;
}): Promise<PlaybackReceipt> {
  if (!Number.isFinite(params.listenedSeconds) || params.listenedSeconds < 0) throw new PaymentError(400, { error: 'Invalid playback checkpoint' });
  const id = await valkey.get(playbackKey(params.paymentIntentId));
  if (!id) throw new PaymentError(404, { error: 'Unknown playback identifier; restart playback' });
  return withJobLock(id, async lease => {
    const state = await getTaskContext<PlaybackPayment>(id);
    if (!state) throw new PaymentError(404, { error: 'Unknown playback identifier; restart playback' });
    if (params.token !== state.token || params.network !== state.network || params.songId !== state.songId) throw new PaymentError(403, { error: 'Playback credential, network or song does not match' });
    const millis = Math.min(state.durationMs, Math.round(params.listenedSeconds * 1000));
    if (state.closed && millis > state.acceptedMs) throw new PaymentError(409, { error: 'Playback has already closed' });
    state.observedMs = Math.max(state.observedMs, millis);
    state.terminal ||= params.terminal === true;
    await lease.save(state.id, state);
    return drainPayment(state, lease);
  });
}

let recoveryCursor = '0';
export async function recoverPayments() {
  const [cursor, ids] = await valkey.sscan(recoverySet, recoveryCursor, 'COUNT', 30);
  recoveryCursor = cursor;
  for (const id of ids) {
    try {
      await withJobLock(id, async lease => {
        const state = await getTaskContext<PlaybackPayment>(id);
        if (!state) { await valkey.srem(recoverySet, id); return; }
        await drainPayment(state, lease);
        for (const item of state.obligations) {
          if (item.receipt?.status === 'confirmed' || !item.settle) continue;
          const { result, headers } = await sendPayment(state, 'settle', item.settle);
          const status = String(result.status || '');
          if (durableStatuses.has(status)) item.receipt = { ...item.receipt!, status, headers, txHash: typeof result.txHash === 'string' ? result.txHash : item.receipt?.txHash };
        }
        await lease.save(id, state);
        if (state.closed && state.obligations.every(item => item.receipt?.status === 'confirmed')) await valkey.srem(recoverySet, id);
      });
    } catch (error) { console.warn('[Payment] Recovery will retry:', error instanceof PaymentError ? error.statusCode : 'unavailable'); }
  }
}

export function requireSessionPayment(
  configOrResolver: SessionPaymentConfig | SessionPaymentResolver,
  options?: SessionPaymentOptions
) {
  return async function sessionPaymentPreHandler(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers['x-credit-source']) {
      const { admitCredits } = await import('../credits/billing.js');
      return admitCredits(request, reply, configOrResolver, options);
    }
    if (options?.isExempt) {
      const isExempt = await options.isExempt(request);
      if (isExempt) {
        reply.header('x-creator-exempt', 'true');
        return;
      }
    }

    const config = typeof configOrResolver === 'function' ? await configOrResolver(request) : configOrResolver;
    if (!config) {
      reply.header('x-creator-exempt', 'true');
      return;
    }

    const requiredAmount = Number(config.amountWei);
    const token = extractSessionToken(request);

    if (!token) {
      const isTestMode = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
      if (isTestMode && !request.headers['x-test-require-session']) {
        return;
      }
      const network = request.headers['x-network-id'] as string;
      if (!network) {
        return reply.status(400).send({ error: 'x-network-id header is required for payment challenge' });
      }
      const payHeader = buildPaymentRequiredHeader(config.amountWei, network, request.url, config.payTo);
      return reply.status(402)
        .header('PAYMENT-REQUIRED', payHeader)
        .header('access-control-expose-headers', 'PAYMENT-REQUIRED, x-session-budget-limit, x-session-budget-used, x-session-budget-remaining')
        .send({
          error: 'Payment required',
          pricing: {
            amountWei: config.amountWei,
            priceUsd: config.priceUsd,
            action: config.action,
            network,
            ...(config.creatorAddress ? { creatorAddress: config.creatorAddress } : {}),
          },
        });
    }

    const payload = parseComposeToken(token);
    if (!payload) {
      return reply.status(401).send({ error: 'Invalid Compose session token' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return reply.status(401).header('x-session-invalid', 'true').send({ error: 'Compose session has expired' });
    }

    const requestedNetwork = request.headers['x-network-id'];
    if (typeof requestedNetwork === 'string' && payload.network && requestedNetwork !== payload.network) {
      return reply.status(401).header('x-session-invalid', 'true').send({ error: 'The Compose session belongs to another network' });
    }

    const currentUsed = getTrackedBudgetUsed(payload.keyId, payload.budgetUsed || 0);
    const remaining = (payload.budgetLimit || 0) - currentUsed;

    if (!options?.metered && remaining < requiredAmount) {
      return reply.status(402)
        .header('x-session-budget-limit', String(payload.budgetLimit))
        .header('x-session-budget-used', String(currentUsed))
        .header('x-session-budget-remaining', String(Math.max(0, remaining)))
        .header('access-control-expose-headers', 'PAYMENT-REQUIRED, x-session-budget-limit, x-session-budget-used, x-session-budget-remaining')
        .send({
          error: 'Insufficient session budget',
          budgetLimit: payload.budgetLimit,
          budgetUsed: currentUsed,
          budgetRemaining: Math.max(0, remaining),
          required: requiredAmount,
        });
    }

    const resolvedNetwork = payload.network || (request.headers['x-network-id'] as string);
    if (!resolvedNetwork) {
      return reply.status(400).send({ error: 'Session token or request is missing network specification' });
    }

    if (options?.metered) {
      try {
        const intent = await prepareStreamPaymentIntent({
          token, network: resolvedNetwork, userAddress: payload.sub, maxAmountWei: config.amountWei,
          songId: (request.params as any)?.id || '', creatorAddress: config.creatorAddress || '', payTo: config.payTo,
          streamPriceUsd: config.priceUsd, durationMs: config.durationMs,
          idempotencyKey: typeof request.headers['x-idempotency-key'] === 'string' ? request.headers['x-idempotency-key'] : undefined,
        });
        request.headers['x-session-user-address'] = payload.sub;
        request.headers['x-network-id'] = resolvedNetwork;
        (request as any).paymentIntentId = intent;
      } catch (error) {
        if (!(error instanceof PaymentError)) throw error;
        for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
        reply.header('access-control-expose-headers', Object.keys(error.headers).join(', '));
        return reply.status(error.statusCode).send(error.body);
      }
      return;
    }

    // Update in-memory tracked budget
    const newUsed = currentUsed + requiredAmount;
    const newRemaining = Math.max(0, (payload.budgetLimit || 0) - newUsed);
    trackBudgetUsed(payload.keyId, newUsed);

    // Stamp response headers for frontend HUD
    reply.header('x-session-budget-limit', String(payload.budgetLimit));
    reply.header('x-session-budget-used', String(newUsed));
    reply.header('x-session-budget-remaining', String(newRemaining));
    reply.header('access-control-expose-headers', 'PAYMENT-REQUIRED, x-session-budget-limit, x-session-budget-used, x-session-budget-remaining');

    // In-memory identity injection: satisfies readUser(request) with ZERO db latency
    request.headers['x-session-user-address'] = payload.sub;
    request.headers['x-network-id'] = resolvedNetwork;

    // Schedule asynchronous settlement without adding request latency
    setImmediate(() => {
      void settleSessionPaymentAsync({
        token,
        network: resolvedNetwork,
        userAddress: payload.sub,
        amountWei: config.amountWei,
        action: config.action,
        resource: request.url,
        method: request.method,
        payTo: config.payTo,
        creatorAddress: config.creatorAddress,
      });
    });
  };
}
