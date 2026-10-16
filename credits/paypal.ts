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
  
}
