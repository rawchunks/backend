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
  
}
