import { createHash } from 'node:crypto';
import { CreditStore, type CreditCheckoutIntent } from './store.js';

export const packs = [
  { id: 'usd-10', amountAtomics: '10000000', usd: '10.00' },
  { id: 'usd-25', amountAtomics: '25000000', usd: '25.00' },
  { id: 'usd-100', amountAtomics: '100000000', usd: '100.00' },
] as const;
const fail = (message: string, statusCode = 502) => Object.assign(new Error(message), { statusCode });

export class PayPal {
  private access?: { value: string; expires: number };
  constructor(public readonly store: CreditStore, private readonly transport: typeof fetch = fetch) {}
  private get base() { return this.store.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
  async request(path: string, method = 'GET', body?: unknown, id?: string): Promise<any> {
    if (!/^\/(v2\/checkout\/orders|v2\/payments\/captures|v1\/identity\/generate-token|v1\/notifications\/verify-webhook-signature)(\/|$)/.test(path)) {
      throw new Error('Unsupported PayPal operation');
    }
    if (!this.access || this.access.expires <= Date.now()) {
      const client = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
      if (!client || !secret) throw fail('PayPal configuration unavailable', 503);
      const auth = await this.transport(`${this.base}/v1/oauth2/token`, {
        method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${client}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!auth.ok) throw fail('PayPal authentication unavailable');
      const result = await auth.json() as any;
      if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in)) throw fail('Invalid PayPal authentication response');
      this.access = { value: result.access_token, expires: Date.now() + Math.max(0, result.expires_in - 60) * 1000 };
    }
    const response = await this.transport(`${this.base}${path}`, {
      method, headers: { Authorization: `Bearer ${this.access.value}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(id ? { 'PayPal-Request-Id': `${this.store.environment}-${id}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as any;
      const issue = typeof error.details?.[0]?.issue === 'string' ? error.details[0].issue : undefined;
      throw Object.assign(fail(`PayPal request failed (${response.status})${issue ? `: ${issue}` : ''}`), { providerStatus: response.status });
    }
    return response.status === 204 ? {} : response.json();
  }
  async operation(id: string, owner?: string) {
    return this.store.tx(async c => {
      const row = (await c.query('SELECT * FROM credit_operations WHERE environment=$1 AND id=$2', [this.store.environment, id])).rows[0];
      if (!row || owner && row.owner !== owner) throw fail('Unknown payment operation', 404);
      return row;
    });
  }
  private expectedUsd(op: any): string | undefined {
    if (op.kind === 'license') return typeof op.context?.usd === 'string' ? op.context.usd : undefined;
    return packs.find(p => p.amountAtomics === String(op.amount))?.usd;
  }
  async create(owner: string, packId: string, key: string, checkout: CreditCheckoutIntent = { kind: 'balance' }) {
    const pack = packs.find(p => p.id === packId);
    if (!pack) throw fail('Unknown credit package', 400);
    if (checkout.kind === 'topup') {
      const target = await this.store.session(owner, checkout.sessionId);
      if (target.closed || new Date(target.expires_at).getTime() <= Date.now()) throw fail('Session is closed or expired', 409);
    }
    const id = createHash('sha256').update(`${this.store.environment}:${owner}:${key}`).digest('hex').slice(0, 36);
    await this.store.tx(async c => {
      await c.query('INSERT INTO credit_accounts(environment,owner) VALUES($1,$2) ON CONFLICT DO NOTHING', [this.store.environment, owner]);
      await c.query("INSERT INTO credit_operations(environment,id,owner,kind,amount,context) VALUES($1,$2,$3,'purchase',$4,$5) ON CONFLICT DO NOTHING", [this.store.environment, id, owner, pack.amountAtomics, JSON.stringify({ packId, checkout })]);
    });
    const existing = await this.operation(id, owner);
    if (String(existing.amount) !== pack.amountAtomics) throw fail('Idempotency key reused for a different package', 409);
    if (JSON.stringify(existing.context.checkout ?? { kind: 'balance' }) !== JSON.stringify(checkout)) throw fail('Idempotency key reused for a different checkout intent', 409);
    return this.createOrder(id);
  }
  async createLicense(
    owner: string,
    input: { songId: string; chainSongId: string; network: string; walletAddress: string; amountAtomics: string },
    key: string,
  ) {
    const blockchain =
      input.network === 'eip155:84532'
        ? 'base'
        : input.network === 'eip155:42431'
          ? 'tempo'
          : input.network === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
            ? 'solana'
            : null;
    if (!blockchain) throw fail(`Unsupported testnet network for Coinflow license checkout: ${input.network}`, 400);
    const atomics = BigInt(input.amountAtomics);
    if (atomics <= 0n) throw fail('Invalid license price', 400);
    const cents = Math.max(1, Math.round(Number(atomics) / 10000));
    const usd = (cents / 100).toFixed(2);
    const id = createHash('sha256').update(`${this.store.environment}:${owner}:license:${key}`).digest('hex').slice(0, 36);
    const context = {
      songId: input.songId,
      chainSongId: input.chainSongId,
      network: input.network,
      blockchain,
      walletAddress: input.walletAddress,
      cents,
      usd,
    };
    await this.store.tx(async c => {
      await c.query('INSERT INTO credit_accounts(environment,owner) VALUES($1,$2) ON CONFLICT DO NOTHING', [this.store.environment, owner]);
      await c.query(
        "INSERT INTO credit_operations(environment,id,owner,kind,amount,context) VALUES($1,$2,$3,'license',$4,$5) ON CONFLICT DO NOTHING",
        [this.store.environment, id, owner, input.amountAtomics, JSON.stringify(context)],
      );
    });
    const existing = await this.operation(id, owner);
    if (
      existing.kind !== 'license' ||
      String(existing.amount) !== input.amountAtomics ||
      existing.context?.songId !== input.songId ||
      existing.context?.network !== input.network
    ) {
      throw fail('Idempotency key reused for a different license checkout', 409);
    }
    return this.createOrder(id);
  }
  private merchant(op: any) {
    return { id: op.context.merchantId || process.env.PAYPAL_MERCHANT_ID, email: op.context.merchantEmail || (process.env.PAYPAL_MERCHANT_EMAIL || process.env.PAYPAL_EMAIL)?.toLowerCase() };
  }
  private async validateOrder(op: any, order: any) {
    const unit = order.purchase_units?.[0], expected = this.merchant(op), usd = this.expectedUsd(op);
    if (order.id !== op.order_id || order.purchase_units?.length !== 1 || unit.custom_id !== op.id || unit.invoice_id !== `${this.store.environment}-${op.id}` || unit.amount?.currency_code !== 'USD' || unit.amount.value !== usd) {
      throw fail('PayPal order does not match the payment operation');
    }
    if (expected.id ? unit.payee?.merchant_id !== expected.id : !expected.email || unit.payee?.email_address?.toLowerCase() !== expected.email) throw fail('PayPal merchant mismatch');
    if (!unit.payee?.merchant_id) throw fail('PayPal merchant identity unavailable');
    await this.store.tx(c => c.query('UPDATE credit_operations SET context=context||$3::jsonb WHERE environment=$1 AND id=$2', [this.store.environment, op.id, JSON.stringify({ merchantId: unit.payee.merchant_id, merchantEmail: expected.email || null, orderValidated: true })]));
    return unit;
  }
  async createOrder(id: string) {
    const op = await this.operation(id);
    if (op.order_id) return { operationId: id, orderId: op.order_id, status: op.status };
    const expected = this.merchant(op), usd = this.expectedUsd(op);
    if (!usd || !expected.id && !expected.email) throw fail('PayPal merchant configuration unavailable', 503);
    if (op.context.orderRequestedAt && Date.now() - Date.parse(op.context.orderRequestedAt) > 6 * 3600000) throw fail('Order creation could not be recovered; start a new checkout', 409);
    await this.store.tx(c => c.query("UPDATE credit_operations SET context=context||jsonb_build_object('orderRequestedAt',coalesce(context->>'orderRequestedAt',$3)) WHERE environment=$1 AND id=$2", [this.store.environment, id, new Date().toISOString()]));
    const order = await this.request('/v2/checkout/orders', 'POST', { intent: 'CAPTURE', purchase_units: [{ custom_id: id, invoice_id: `${this.store.environment}-${id}`, amount: { currency_code: 'USD', value: usd }, payee: expected.id ? { merchant_id: expected.id } : { email_address: expected.email } }] }, `order-${id}`);
    if (typeof order.id !== 'string') throw fail('PayPal returned no order ID');
    await this.store.tx(c => c.query('UPDATE credit_operations SET order_id=$3,updated_at=now() WHERE environment=$1 AND id=$2', [this.store.environment, id, order.id]));
    await this.validateOrder({ ...op, order_id: order.id }, await this.request(`/v2/checkout/orders/${encodeURIComponent(order.id)}`));
    return { operationId: id, orderId: order.id, status: order.status };
  }
  private async coinflowCheckout(op: any, captureId: string, payerEmail?: string) {
    const apiKey = process.env.COINFLOW_SANDBOX_API_KEY;
    if (!apiKey) throw fail('Coinflow Sandbox configuration unavailable', 503);
    const coinflowBase = 'https://api-sandbox.coinflow.cash';
    const blockchain = op.context?.blockchain || (
      op.context?.network === 'eip155:84532'
        ? 'base'
        : op.context?.network === 'eip155:42431'
          ? 'tempo'
          : 'solana'
    );
    const walletAddress = op.context?.walletAddress;
    if (typeof walletAddress !== 'string' || !walletAddress) throw fail('Missing wallet address for Coinflow checkout', 400);

    const sessionRes = await this.transport(`${coinflowBase}/api/auth/session-key`, {
      method: 'GET',
      headers: {
        Authorization: apiKey,
        'x-coinflow-auth-user-id': op.id,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!sessionRes.ok) throw fail(`Coinflow session-key request failed (${sessionRes.status})`);
    const { key: sessionKey } = (await sessionRes.json()) as { key?: string };
    if (typeof sessionKey !== 'string' || !sessionKey) throw fail('Invalid Coinflow session-key response');

    const email = (payerEmail || process.env.PAYPAL_CREATOR_EMAIL || 'sb-1llge53425539@personal.example.com').toLowerCase();
    const checkoutRes = await this.transport(`${coinflowBase}/api/checkout/paypal/rawchunks`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'x-coinflow-auth-session-key': sessionKey,
        'x-coinflow-auth-user-id': op.id,
        'x-coinflow-auth-wallet': walletAddress,
        'x-coinflow-auth-blockchain': blockchain,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subtotal: { cents: Number(op.context.cents), currency: 'USD' },
        email,
        paypal: { email },
        webhookInfo: {
          operationId: op.id,
          songId: op.context.songId,
          chainSongId: op.context.chainSongId,
          network: op.context.network,
          paypalOrderId: op.order_id,
          paypalCaptureId: captureId,
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!checkoutRes.ok) {
      const errBody = await checkoutRes.json().catch(() => ({})) as any;
      throw fail(`Coinflow PayPal checkout failed (${checkoutRes.status})${errBody?.details ? `: ${JSON.stringify(errBody.details)}` : ''}`);
    }
    const { paymentId } = (await checkoutRes.json()) as { paymentId?: string };
    if (typeof paymentId !== 'string' || !paymentId) throw fail('Coinflow returned no paymentId');

    await this.store.tx(c =>
      c.query(
        "UPDATE credit_operations SET status='completed',capture_id=$3,context=context||$4::jsonb,updated_at=now() WHERE environment=$1 AND id=$2",
        [
          this.store.environment,
          op.id,
          captureId,
          JSON.stringify({ coinflowPaymentId: paymentId, coinflowBlockchain: blockchain }),
        ],
      ),
    );
    return {
      operationId: op.id,
      status: 'completed',
      orderId: op.order_id,
      captureId,
      coinflowPaymentId: paymentId,
    };
  }
  async capture(
    owner: string,
    id: string,
    orderId: string,
    card?: { number: string; expiry: string; securityCode: string; name?: string },
  ) {
    const op = await this.operation(id, owner);
    if (op.order_id !== orderId) throw fail('Order does not belong to this operation', 409);
    if (op.status === 'credited' || op.status === 'completed') {
      return {
        operationId: id,
        status: op.status,
        ...(op.context?.coinflowPaymentId ? { coinflowPaymentId: op.context.coinflowPaymentId } : {}),
      };
    }
    const order = await this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    await this.validateOrder(op, order);
    if (order.status !== 'COMPLETED') {
      const captureBody = card
        ? {
            payment_source: {
              card: {
                number: card.number,
                expiry: card.expiry,
                security_code: card.securityCode,
                name: card.name || 'License Buyer',
              },
            },
          }
        : {};
      try {
        await this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, 'POST', captureBody, `capture-${id}`);
      } catch (error) {
        if ((await this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`)).status !== 'COMPLETED') throw error;
      }
    }
    return this.reconcile(id);
  }
  async reconcile(id: string): Promise<{ operationId: string; status: string; coinflowPaymentId?: string; orderId?: string; captureId?: string }> {
    const op = await this.operation(id);
    if (op.status === 'credited' || op.status === 'completed') {
      return {
        operationId: id,
        status: op.status,
        ...(op.context?.coinflowPaymentId ? { coinflowPaymentId: op.context.coinflowPaymentId } : {}),
      };
    }
    if (!op.order_id) return this.createOrder(id);
    let order = await this.request(`/v2/checkout/orders/${encodeURIComponent(op.order_id)}`);
    let unit = await this.validateOrder(op, order);
    if (order.status === 'APPROVED') {
      await this.request(`/v2/checkout/orders/${encodeURIComponent(op.order_id)}/capture`, 'POST', {}, `capture-${id}`);
      order = await this.request(`/v2/checkout/orders/${encodeURIComponent(op.order_id)}`);
      unit = await this.validateOrder(await this.operation(id), order);
    }
    if (order.status !== 'COMPLETED') return { operationId: id, status: order.status };
    const capture = unit.payments?.captures?.[0], usd = this.expectedUsd(op);
    if (unit.payments?.captures?.length !== 1 || capture?.status !== 'COMPLETED' || capture.amount?.currency_code !== 'USD' || capture.amount.value !== usd || typeof capture.id !== 'string') throw fail('PayPal capture verification failed');
    if (op.kind === 'license') {
      return this.coinflowCheckout(op, capture.id, order.payer?.email_address);
    }
    await this.store.creditCapture(op.owner, id, capture.id, BigInt(op.amount));
    return { operationId: id, status: 'credited' };
  }
  async webhook(headers: Record<string, unknown>, event: any) {
    if (!process.env.PAYPAL_WEBHOOK_ID) throw fail('PayPal webhook verification unavailable', 503);
    const verified = await this.request('/v1/notifications/verify-webhook-signature', 'POST', {
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: event,
    });
    if (verified.verification_status !== 'SUCCESS' || typeof event?.id !== 'string') throw fail('Unverified PayPal webhook', 401);
    await this.store.tx(c => c.query('INSERT INTO credit_events(environment,id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [this.store.environment, event.id, JSON.stringify(event)]));
  }
}
