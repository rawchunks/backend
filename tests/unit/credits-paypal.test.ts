import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditStore } from '../../credits/store.js';
import { PayPal } from '../../credits/paypal.js';

let db: PGlite, store: CreditStore, paypal: PayPal;
const owner = '0x1111111111111111111111111111111111111111';
const stranger = '0x2222222222222222222222222222222222222222';
let order: any, captureRequests: string[], failCaptureResponse: boolean;
beforeEach(async () => {
  Object.assign(process.env, { PAYPAL_CLIENT_ID: 'client', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_MERCHANT_ID: 'merchant', PAYPAL_WEBHOOK_ID: 'webhook' });
  db = new PGlite(); await db.waitReady;
  let previous = Promise.resolve();
  store = new CreditStore({ connect: async () => {
    const wait = previous; let release!: () => void;
    previous = new Promise<void>(done => { release = done; }); await wait;
    return { query: (sql, values) => db.query(sql, values), release };
  } }, 'sandbox');
  await store.migrate();
  order = null; captureRequests = []; failCaptureResponse = false;
  paypal = new PayPal(store, async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/oauth2/token') return Response.json({ access_token: 'provider-token', expires_in: 3600 });
    if (path === '/v2/checkout/orders' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body));
      order = { id: 'order-1', status: 'CREATED', intent: 'CAPTURE', purchase_units: input.purchase_units.map((unit: any) => ({ ...unit, payee: { merchant_id: 'merchant', email_address: 'merchant@example.invalid' } })) };
      return Response.json(order);
    }
    if (path === '/v2/checkout/orders/order-1/capture') {
      captureRequests.push(new Headers(init?.headers).get('PayPal-Request-Id')!);
      order.status = 'COMPLETED';
      order.purchase_units[0].payments = { captures: [{ id: 'capture-1', status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' } }] };
      if (failCaptureResponse) throw new Error('Browser response lost');
      return Response.json(order);
    }
    if (path === '/v2/checkout/orders/order-1') return Response.json(order);
    if (path === '/v1/notifications/verify-webhook-signature') return Response.json({ verification_status: 'FAILURE' });
    return new Response('{}', { status: 404 });
  });
});
afterEach(async () => { await db.close(); vi.unstubAllEnvs(); });

describe('PayPal capture authority', () => {
  it('creates a server-priced order and issues no credits before a completed capture', async () => {
    const op = await paypal.create(owner, 'usd-10', 'request-a');
    expect(op.orderId).toBe('order-1');
    expect(order.purchase_units[0].amount).toEqual({ value: '10.00', currency_code: 'USD' });
    expect((await store.balance(owner)).availableAtomics).toBe('0');
  });
  it('issues once across capture, retry and reconciliation', async () => {
    const op = await paypal.create(owner, 'usd-10', 'request-a');
    await paypal.capture(owner, op.operationId, op.orderId);
    await paypal.capture(owner, op.operationId, op.orderId);
    await paypal.reconcile(op.operationId);
    expect((await store.balance(owner)).availableAtomics).toBe('10000000');
    expect(captureRequests).toHaveLength(1);
  });
  it('recovers a captured payment whose response was lost', async () => {
    const op = await paypal.create(owner, 'usd-10', 'request-a'); failCaptureResponse = true;
    expect((await paypal.capture(owner, op.operationId, op.orderId)).status).toBe('credited');
    expect((await store.balance(owner)).availableAtomics).toBe('10000000');
  });
  it('credits balance directly during reconciliation without a browser callback', async () => {
    const op = await paypal.create(owner, 'usd-10', 'request-a', { kind: 'balance' });
    order.status = 'APPROVED';
    await paypal.reconcile(op.operationId);
    await paypal.reconcile(op.operationId);
    const completed = await paypal.operation(op.operationId, owner);
    expect(completed.status).toBe('credited');
    expect(await store.balance(owner)).toMatchObject({ availableAtomics: '10000000', reservedAtomics: '0' });
  });
  it('does not capture another owners order', async () => {
    const op = await paypal.create(owner, 'usd-10', 'request-a');
    await expect(paypal.capture(stranger, op.operationId, op.orderId)).rejects.toMatchObject({ statusCode: 404 });
    expect(captureRequests).toHaveLength(0);
  });
  it.each(['merchant', 'amount', 'currency', 'operation', 'capture-status'])('rejects mismatched %s without issuing credits', async mismatch => {
    const op = await paypal.create(owner, 'usd-10', 'request-a');
    order.status = 'COMPLETED';
    const unit = order.purchase_units[0];
    unit.payments = { captures: [{ id: 'capture-1', status: 'COMPLETED', amount: { value: '10.00', currency_code: 'USD' } }] };
    if (mismatch === 'merchant') unit.payee.merchant_id = 'different-merchant';
    if (mismatch === 'amount') unit.payments.captures[0].amount.value = '1.00';
    if (mismatch === 'currency') unit.payments.captures[0].amount.currency_code = 'EUR';
    if (mismatch === 'operation') unit.custom_id = 'other-operation';
    if (mismatch === 'capture-status') unit.payments.captures[0].status = 'PENDING';
    await expect(paypal.reconcile(op.operationId)).rejects.toThrow();
    expect((await store.balance(owner)).availableAtomics).toBe('0');
  });
  it('does not change price when an idempotency key is replayed', async () => {
    await paypal.create(owner, 'usd-10', 'request-a');
    await expect(paypal.create(owner, 'usd-100', 'request-a')).rejects.toMatchObject({ statusCode: 409 });
  });
  it('rejects unverified webhooks', async () => {
    await expect(paypal.webhook({}, { id: 'forged-event' })).rejects.toMatchObject({ statusCode: 401 });
    expect((await db.query('SELECT count(*)::integer count FROM credit_events')).rows).toEqual([{ count: 0 }]);
  });
  it('creates a license order, captures PayPal payment, and executes Coinflow Sandbox checkout', async () => {
    process.env.COINFLOW_SANDBOX_API_KEY = 'coinflow-sandbox-key';
    let coinflowPayload: any = null;
    const licensePaypal = new PayPal(store, async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'provider-token', expires_in: 3600 });
      if (parsed.pathname === '/v2/checkout/orders' && init?.method === 'POST') {
        const input = JSON.parse(String(init.body));
        order = {
          id: 'order-license-1',
          status: 'CREATED',
          intent: 'CAPTURE',
          purchase_units: input.purchase_units.map((unit: any) => ({
            ...unit,
            payee: { merchant_id: 'merchant', email_address: 'merchant@example.invalid' },
          })),
        };
        return Response.json(order);
      }
      if (parsed.pathname === '/v2/checkout/orders/order-license-1/capture') {
        order.status = 'COMPLETED';
        const val = order.purchase_units[0].amount.value;
        order.purchase_units[0].payments = {
          captures: [{ id: 'capture-license-1', status: 'COMPLETED', amount: { value: val, currency_code: 'USD' } }],
        };
        return Response.json(order);
      }
      if (parsed.pathname === '/v2/checkout/orders/order-license-1') return Response.json(order);
      if (parsed.pathname === '/api/auth/session-key') return Response.json({ key: 'session-key-1' });
      if (parsed.pathname === '/api/checkout/paypal/rawchunks') {
        coinflowPayload = JSON.parse(String(init?.body));
        return Response.json({ paymentId: 'CF-PAY-123' });
      }
      return new Response('{}', { status: 404 });
    });

    const created = await licensePaypal.createLicense(owner, {
      songId: 'song-1',
      chainSongId: '7',
      network: 'eip155:84532',
      amountAtomics: '2500000',
      walletAddress: owner,
    }, 'license-req-1');
    expect(created.orderId).toBe('order-license-1');
    expect(created.status).toBe('CREATED');

    const captured = await licensePaypal.capture(owner, created.operationId, created.orderId);
    expect(captured.status).toBe('completed');
    expect(captured.coinflowPaymentId).toBe('CF-PAY-123');
    expect(coinflowPayload).toMatchObject({
      subtotal: { cents: 250, currency: 'USD' },
      webhookInfo: {
        songId: 'song-1',
        chainSongId: '7',
        network: 'eip155:84532',
        paypalOrderId: 'order-license-1',
        paypalCaptureId: 'capture-license-1',
      },
    });
  });
});
