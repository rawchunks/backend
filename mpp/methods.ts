import { Method, z } from 'mppx';
import type { PaymentPayload, PaymentRequirements, ResourceInfo, SettleResponse } from '@x402/core/types';
import type { Receipt } from 'mppx';

export type Intent = 'upto' | 'batch-settlement';
const integer = z.string().check(z.regex(/^(0|[1-9][0-9]*)$/));
const record = z.record(z.string(), z.unknown());
const requirements = z.object({
  scheme: z.string(), network: z.string().check(z.regex(/^[a-z0-9-]+:[a-zA-Z0-9_-]+$/)),
  asset: z.string().check(z.minLength(1)), amount: integer,
  payTo: z.string().check(z.minLength(1)),
  maxTimeoutSeconds: z.number().check(z.int(), z.minimum(1)), extra: record,
});
const resource = z.looseObject({ url: z.string().check(z.minLength(1)) });
const payment = z.object({
  x402Version: z.literal(2), accepted: requirements, resource,
  payload: record, extensions: z.optional(record),
});
const request = z.object({
  amount: integer, currency: z.string(), recipient: z.string(),
  methodDetails: z.object({
    version: z.literal(1), requirements, resource, extensions: z.optional(record),
  }),
});
const payload = z.object({ payment });

/** These are extension identities, not the built-in tempo/charge or tempo/session rails. */
export const upto = Method.from({ name: 'x402', intent: 'upto', schema: { request, credential: { payload } } });
export const batch = Method.from({ name: 'x402', intent: 'batch-settlement', schema: { request, credential: { payload } } });
export type Definition = typeof upto | typeof batch;
export type PaymentRequest = z.output<typeof request>;
export type PaymentCredential = z.output<typeof payload>;
export type Offer = { requirements: PaymentRequirements; resource: ResourceInfo; extensions?: Record<string, unknown> };
export type PaymentReceipt = Receipt.Receipt & {
  x402: {
    version: 1; intent: Intent; challengeId: string;
    stage: 'settled' | 'funded' | 'accepted' | 'no-charge';
    chargedAmount: string; settlement: SettleResponse;
  };
};

export function canonical(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  function encode(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item !== null && typeof item === 'object') {
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(item);
  }
  return encode(normalized);
}

export function toRequest(offer: Offer, intent: Intent): PaymentRequest {
  const r = offer.requirements;
  if (r.scheme !== intent) throw new Error(`Expected x402 ${intent} requirements`);
  return request.parse({ amount: r.amount, currency: r.asset, recipient: r.payTo,
    methodDetails: { version: 1, requirements: r, resource: offer.resource, ...(offer.extensions ? { extensions: offer.extensions } : {}) } });
}

/** Require the complete accepted terms and resource to match; never reconstruct a proof. */
export function checkPayment(input: unknown, terms: unknown, intent: Intent): { payment: PaymentPayload; request: PaymentRequest } {
  const parsed = payload.parse(input);
  const normalized = request.parse(terms);
  const r = normalized.methodDetails.requirements;
  if (r.scheme !== intent || normalized.amount !== r.amount || normalized.currency !== r.asset || normalized.recipient !== r.payTo)
    throw new Error('Inconsistent MPP/x402 terms');
  if (canonical(parsed.payment.accepted) !== canonical(r) || canonical(parsed.payment.resource) !== canonical(normalized.methodDetails.resource))
    throw new Error('Payment does not match the issued requirements/resource');
  return { payment: parsed.payment as PaymentPayload, request: normalized };
}

export function atomic(value: string): bigint {
  integer.parse(value);
  return BigInt(value);
}
