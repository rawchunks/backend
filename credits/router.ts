import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, resolveCreditOwner } from './auth.js';
import { creditStore } from './store.js';
import { PayPal, packs } from './paypal.js';

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

function body<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw Object.assign(new Error('Invalid payment request'), { statusCode: 400 });
  return parsed.data;
}

export const creditsRouter: FastifyPluginAsync = async app => {
  const store = creditStore();
  const paypal = new PayPal(store);
  const key = (headers: Record<string, unknown>) => body(z.string().min(8).max(128), headers['x-idempotency-key']);

  app.get('/credits/promo', async () => {
    const promo = await store.publicPromoStatus();
    return {
      promo,
      packs,
      paypalClientId: process.env.PAYPAL_CLIENT_ID,
      environment: store.environment,
    };
  });

  app.get('/credits/balance', async req => {
    const identity = await resolveCreditOwner(req);
    const bal = await store.balance(identity.owner);
    return {
      userAddress: identity.userAddress,
      ...bal,
      packs,
      paypalClientId: process.env.PAYPAL_CLIENT_ID,
      environment: store.environment,
    };
  });

  app.post('/credits/promo/claim', async req => {
    const identity = await authenticate(req);
    const subnet = clientSubnetKey(req);
    const activeClaims = checkPromoSubnetLimit(subnet);
    const bal = await store.claimPromo(identity.owner, identity.promoIdentityHash, key(req.headers));
    promoSubnetClaims.set(subnet, [...activeClaims, Date.now()]);
    return {
      userAddress: identity.userAddress,
      ...bal,
      packs,
      paypalClientId: process.env.PAYPAL_CLIENT_ID,
      environment: store.environment,
    };
  });

  app.post('/credits/paypal/create-order', async req => {
    const identity = await resolveCreditOwner(req);
    const input = body(
      z.object({
        packId: z.enum(['usd-10', 'usd-25', 'usd-100']),
        checkout: z.object({ kind: z.literal('balance') }).optional(),
      }).strict(),
      req.body,
    );
    return paypal.create(identity.owner, input.packId, key(req.headers));
  });

  app.post('/credits/paypal/capture-order', async req => {
    const identity = await resolveCreditOwner(req);
    const input = body(z.object({ operationId: id, orderId: id }).strict(), req.body);
    return paypal.capture(identity.owner, input.operationId, input.orderId);
  });

  app.post('/credits/license/create-order', async req => {
    const identity = await resolveCreditOwner(req);
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
    const identity = await resolveCreditOwner(req);
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
    const identity = await resolveCreditOwner(req);
    const input = body(z.object({ id }), req.params);
    const op = await paypal.operation(input.id, identity.owner);
    return {
      id: op.id,
      status: op.status,
      amountAtomics: String(op.amount),
      orderId: op.order_id,
      kind: op.kind,
      coinflowPaymentId: op.context.coinflowPaymentId ?? null,
    };
  });

  app.post('/credits/paypal/webhook', async req => {
    await paypal.webhook(req.headers, req.body);
    return { received: true };
  });

  app.post('/payments/paypal/webhook', async req => {
    await paypal.webhook(req.headers, req.body);
    return { received: true };
  });
};
