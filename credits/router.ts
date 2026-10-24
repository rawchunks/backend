import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { creditStore } from './store.js';
import { PayPal, packs } from './paypal.js';
import { signSession } from './session.js';

const id = z.string().min(1).max(128);
const amount = z.string().regex(/^[1-9][0-9]{0,17}$/);
const PROMO_SUBNET_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROMO_SUBNET_MAX_CLAIMS = 3;
const promoSubnetClaims = new Map<string, number[]>();

function clientSubnetKey(req: { headers: Record<string, unknown>; ip?: string }): string {
  const cf = typeof req.headers['cf-connecting-ip'] === 'string' ? req.headers['cf-connecting-ip'].trim() : '';
  const xff = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0]?.trim() ?? '' : '';
  const raw = (cf || xff || req.ip || 'unknown').replace(/^::ffff:/i, '');
  const ipv4 = raw.split('.');
  if (ipv4.length === 4 && ipv4.every(part => /^\d+$/.test(part))) {
    return `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.0/24`;
  }
  if (raw.includes(':')) {
    const parts = raw.toLowerCase().split(':').slice(0, 3);
    return `${parts.join(':')}::/48`;
  }
  return raw;
}

function checkPromoSubnetLimit(subnet: string): number[] {
  const now = Date.now();
  const active = (promoSubnetClaims.get(subnet) ?? []).filter(ts => now - ts < PROMO_SUBNET_WINDOW_MS);
  if (active.length >= PROMO_SUBNET_MAX_CLAIMS) {
    throw Object.assign(new Error('Too many campaign claims from this network. Please try again later.'), { statusCode: 429 });
  }
  return active;
}
const checkout = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('balance') }).strict(),
  z.object({ kind: z.literal('start'), durationSeconds: z.number().int().min(60).max(604800) }).strict(),
  z.object({ kind: z.literal('topup'), sessionId: id }).strict(),
]);
function body<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw Object.assign(new Error('Invalid payment request'), { statusCode: 400 });
  return parsed.data;
}
export function sessionView(row: any) {
  return { id: row.id, budgetAtomics: String(row.budget), remainingAtomics: String(row.remaining), reservedAtomics: String(row.reserved), spentAtomics: String(row.spent), expiresAt: new Date(row.expires_at).getTime(), closed: row.closed, fundingSource: 'prepaid' as const };
}
export const creditsRouter: FastifyPluginAsync = async app => {
  const store = creditStore(), paypal = new PayPal(store);
  const key = (headers: Record<string, unknown>) => body(z.string().min(8).max(128), headers['x-idempotency-key']);
  const sessionResponse = (row: any, owner: string) => ({ ...sessionView(row), token: signSession({ sub: owner, sid: row.id, env: store.environment, exp: Math.floor(new Date(row.expires_at).getTime() / 1000) }) });
  app.get('/credits/balance', async req => {
    const identity = await authenticate(req);
    return { userAddress: identity.userAddress, ...await store.balance(identity.owner, identity.promoIdentityHash), packs, paypalClientId: process.env.PAYPAL_CLIENT_ID, environment: store.environment };
  });
  app.post('/credits/promo/claim', async req => {
    const identity = await authenticate(req);
    const input = body(z.object({ durationSeconds: z.number().int().min(60).max(604800).optional() }).strict().optional(), req.body);
    const subnet = clientSubnetKey(req);
    const activeClaims = checkPromoSubnetLimit(subnet);
    const row = await store.claimPromo(identity.owner, identity.promoIdentityHash, input?.durationSeconds ?? 21600, key(req.headers));
    promoSubnetClaims.set(subnet, [...activeClaims, Date.now()]);
    return sessionResponse(row, identity.owner);
  });
  app.post('/credits/paypal/create-order', async req => {
    const identity = await authenticate(req);
    const input = body(z.object({ packId: z.enum(['usd-10', 'usd-25', 'usd-100']), checkout: checkout.optional() }).strict(), req.body);
    return paypal.create(identity.owner, input.packId, key(req.headers), input.checkout);
  });
  app.post('/credits/paypal/capture-order', async req => {
    const identity = await authenticate(req);
    const input = body(z.object({ operationId: id, orderId: id }).strict(), req.body);
    return paypal.capture(identity.owner, input.operationId, input.orderId);
  });
  app.post('/credits/license/create-order', async req => {
    const identity = await authenticate(req);
    const input = body(
      z.object({
        songId: id,
        chainSongId: id,
        network: id,
        walletAddress: id,
        amountAtomics: amount,
      }).strict(),
      req.body,
    );
    return paypal.createLicense(identity.owner, input, key(req.headers));
  });
  app.post('/credits/license/capture-order', async req => {
    const identity = await authenticate(req);
    const input = body(
      z.object({
        operationId: id,
        orderId: id,
        card: z
          .object({
            number: z.string().min(12).max(24),
            expiry: z.string().min(4).max(10),
            securityCode: z.string().min(3).max(4),
            name: z.string().max(128).optional(),
          })
          .strict()
          .optional(),
      }).strict(),
      req.body,
    );
    return paypal.capture(identity.owner, input.operationId, input.orderId, input.card);
  });
  app.get('/credits/operations/:id', async req => {
    const identity = await authenticate(req);
    const input = body(z.object({ id }), req.params);
    const op = await paypal.operation(input.id, identity.owner);
    return {
      id: op.id,
      status: op.status,
      amountAtomics: String(op.amount),
      orderId: op.order_id,
      kind: op.kind,
      sessionId: op.context.sessionId ?? null,
      coinflowPaymentId: op.context.coinflowPaymentId ?? null,
    };
  });
  app.post('/credits/session/start', async req => {
    const identity = await authenticate(req);
    const input = body(z.object({ budgetAtomics: amount, durationSeconds: z.number().int().min(60).max(604800) }).strict(), req.body);
    return sessionResponse(await store.start(identity.owner, BigInt(input.budgetAtomics), input.durationSeconds, key(req.headers)), identity.owner);
  });
  app.get('/credits/sessions', async req => {
    const identity = await authenticate(req);
    await store.balance(identity.owner);
    const rows = await store.tx(c => c.query('SELECT * FROM credit_sessions WHERE environment=$1 AND owner=$2 AND NOT closed AND expires_at>now() ORDER BY created_at DESC', [store.environment, identity.owner]));
    return { sessions: rows.rows.map(sessionView) };
  });
  app.post('/credits/session/resume', async req => {
    const identity = await authenticate(req);
    const input = body(z.object({ sessionId: id }).strict(), req.body);
    const row = await store.session(identity.owner, input.sessionId);
    if (row.closed || new Date(row.expires_at).getTime() <= Date.now()) throw Object.assign(new Error('Session is closed or expired'), { statusCode: 409 });
    return sessionResponse(row, identity.owner);
  });
  app.get('/credits/session/:id', async req => {
    const identity = await authenticate(req), input = body(z.object({ id }), req.params);
    await store.balance(identity.owner);
    return sessionView(await store.session(identity.owner, input.id));
  });
  app.post('/credits/session/topup', async req => {
    const identity = await authenticate(req);
    const input = body(z.object({ sessionId: id, amountAtomics: amount }).strict(), req.body);
    return sessionView(await store.topup(identity.owner, input.sessionId, BigInt(input.amountAtomics), key(req.headers)));
  });
  app.post('/credits/session/end', async req => {
    const identity = await authenticate(req), input = body(z.object({ sessionId: id }).strict(), req.body);
    return sessionView(await store.end(identity.owner, input.sessionId));
  });
  app.post('/credits/paypal/webhook', async req => { await paypal.webhook(req.headers, req.body); return { received: true }; });
  app.post('/payments/paypal/webhook', async req => { await paypal.webhook(req.headers, req.body); return { received: true }; });
};
