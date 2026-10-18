import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from './auth.js';
import { verifySession } from './session.js';
import { creditStore } from './store.js';
import type { SessionPaymentConfig, SessionPaymentOptions, SessionPaymentResolver } from '../broker/payment.js';

interface Billing { owner: string; hold: string }
const context = new AsyncLocalStorage<Billing>();
export async function bindCreditTask(taskId: string, worker: any) {
  const billing = context.getStore();
  if (!billing) return;
  const store = creditStore();
  await store.tx(c => c.query('UPDATE credit_holds SET context=$3 WHERE environment=$1 AND id=$2 AND NOT closed', [store.environment, billing.hold, JSON.stringify({ kind: worker.kind, taskId, worker })]));
}
export async function admitCredits(req: FastifyRequest, reply: FastifyReply, resolver: SessionPaymentConfig | SessionPaymentResolver, options?: SessionPaymentOptions) {
  if (process.env.CREDITS_ENABLED !== 'true') throw Object.assign(new Error('Prepaid Credits unavailable'), { statusCode: 503 });
  const identity = await authenticate(req), store = creditStore();
  const token = req.headers['x-credit-session-token'];
  if (typeof token !== 'string') throw Object.assign(new Error('Credit session required'), { statusCode: 401 });
  const claims = verifySession(token, identity.owner, store.environment);
  const session = await store.session(identity.owner, claims.sid);
  if (session.closed || new Date(session.expires_at).getTime() <= Date.now()) throw Object.assign(new Error('Credit session closed'), { statusCode: 401 });
  const supplied = req.body as any;
  for (const name of ['userAddress', 'creatorAddress', 'creator']) {
    const value = supplied?.[name];
    if (typeof value === 'string' && !identity.addresses.includes(value.startsWith('0x') ? value.toLowerCase() : value)) throw Object.assign(new Error('Operation owner is not authenticated'), { statusCode: 403 });
  }
  let config: SessionPaymentConfig | null;
  if (options?.metered) {
    const { getSongById } = await import('../databases/songs.js');
    const song = await getSongById((req.params as any).id);
    if (!song) throw Object.assign(new Error('Song not found'), { statusCode: 404 });
    (req as any).song = song;
    if (identity.addresses.includes(song.creator.startsWith('0x') ? song.creator.toLowerCase() : song.creator)) { reply.header('x-creator-exempt', 'true'); return; }
    const rate = Math.round(song.stream_price * 1000000), durationMs = Math.ceil((song.duration || 0) * 1000);
    if (!Number.isSafeInteger(rate) || rate < 0 || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('Streaming price or duration unavailable');
    const maximum = (BigInt(rate) * BigInt(durationMs) + 59999n) / 60000n;
    if (!maximum) return;
    config = { amountWei: String(maximum), priceUsd: Number(maximum) / 1000000, action: 'stream-playback', creatorAddress: song.creator };
  } else config = typeof resolver === 'function' ? await resolver(req) : resolver;
  if (!config) return;
  const key = req.headers['x-idempotency-key'];
  const holdId = typeof key === 'string' && key.length <= 80 ? `${claims.sid.slice(0, 32)}:${key}` : randomUUID();
  const hold = await store.reserve(identity.owner, claims.sid, holdId, BigInt(config.amountWei), req.url.split('?')[0], config.creatorAddress);
  if (hold.context && !options?.metered) throw Object.assign(new Error('This operation has already been admitted'), { statusCode: 409 });
  const billing = { owner: identity.owner, hold: hold.id };
  (req as any).creditBilling = billing;
  (req as any).creditMetered = Boolean(options?.metered);
  (req as any).paymentIntentId = hold.id;
  if (options?.metered && !hold.context) {
    const song = (req as any).song;
    await store.tx(c => c.query('UPDATE credit_holds SET context=$3 WHERE environment=$1 AND id=$2 AND context IS NULL', [store.environment, hold.id, JSON.stringify({ kind: 'stream', songId: song.id, userAddress: identity.userAddress, rate: String(Math.round(song.stream_price * 1000000)), durationMs: Math.ceil(song.duration * 1000), startedAt: Date.now() })]));
  }
  reply.header('x-credit-hold-id', hold.id);
}
export async function checkpointCredits(req: FastifyRequest) {
  const identity = await authenticate(req), store = creditStore();
  const input = req.body as { paymentIntentId?: string; listenedSeconds?: number; terminal?: boolean };
  if (!input?.paymentIntentId || !Number.isFinite(input.listenedSeconds) || input.listenedSeconds! < 0) throw Object.assign(new Error('Invalid playback checkpoint'), { statusCode: 400 });
  const row = await store.tx(async c => (await c.query('SELECT h.* FROM credit_holds h JOIN credit_sessions s ON s.environment=h.environment AND s.id=h.session_id WHERE h.environment=$1 AND h.id=$2 AND s.owner=$3', [store.environment, input.paymentIntentId, identity.owner])).rows[0]);
  if (!row || row.context?.kind !== 'stream' || row.context.songId !== (req.params as any).id || !identity.addresses.includes(row.context.userAddress)) throw Object.assign(new Error('Unknown playback operation'), { statusCode: 404 });
  const millis = Math.min(row.context.durationMs, Math.floor(input.listenedSeconds! * 1000), Math.max(0, Date.now() - row.context.startedAt));
  const cumulative = BigInt(millis) * BigInt(row.context.rate) / 60000n;
  await store.commit(identity.owner, row.id, cumulative);
  if (input.terminal) await store.release(identity.owner, row.id);
  return { success: true, result: { billedWei: String(cumulative), status: 'credited' } };
}
export function installCreditBilling(app: FastifyInstance) {
  app.addHook('onRoute', route => {
    const original = route.handler;
    route.handler = function(req, reply) {
      const billing = (req as any).creditBilling as Billing | undefined;
      return billing ? context.run(billing, () => original.call(this, req, reply)) : original.call(this, req, reply);
    };
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const billing = (req as any).creditBilling as Billing | undefined;
    if (!billing || (req as any).creditMetered) return payload;
    const store = creditStore();
    const row = await store.tx(async c => (await c.query('SELECT * FROM credit_holds WHERE environment=$1 AND id=$2', [store.environment, billing.hold])).rows[0]);
    if (reply.statusCode >= 400 && !row.context) await store.release(billing.owner, billing.hold);
    else if (reply.statusCode < 400 && !row.context) {
      await store.commit(billing.owner, billing.hold, BigInt(row.maximum));
      await store.release(billing.owner, billing.hold);
    }
    return payload;
  });
}

