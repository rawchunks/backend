import { createHash, randomUUID } from 'node:crypto';
import { Challenge, Credential, Receipt } from 'mppx';
import type { Store } from 'mppx';
import { canonical, toRequest } from '../methods.js';
import type { Offer } from '../methods.js';
import { PaymentError } from './shared.js';
import type { Work, createMethod } from './shared.js';

type Issued = { challenge: Challenge.Challenge; url: string; verb: string; digest: string };
export type HttpOptions = {
  method: ReturnType<typeof createMethod>; offer: Offer;
  store: Store.AtomicStore; namespace: string; realm: string;
  expiresSeconds?: number; header?: string;
};

/** Stateful MPP challenge issuance and binding, with no implicit server secrets. */
export function createHandler(options: HttpOptions) {
  if (!options.namespace || !options.realm) throw new Error('A namespace and realm are required');
  const ttl = options.expiresSeconds ?? Math.min(300, options.offer.requirements.maxTimeoutSeconds);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > options.offer.requirements.maxTimeoutSeconds) throw new Error('Invalid challenge lifetime');
  const terms = toRequest(options.offer, options.method.intent);
  const credentialHeader = options.header ?? 'Authorization';
  // Validate the field name without storing or transmitting a credential.
  new Headers({ [credentialHeader]: 'Payment' });
  const prefix = `mpp:${options.namespace}:challenge:`;
  return async function handle(input: Request, work: Work): Promise<Response> {
    const bytes = new Uint8Array(await input.clone().arrayBuffer());
    const digest = `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
    const authorization = input.headers.get(credentialHeader);
    if (!authorization || !Credential.extractPaymentScheme(authorization)) {
      const challenge = Challenge.from({ id: randomUUID(), realm: options.realm, method: options.method.name, intent: options.method.intent,
        request: terms, expires: new Date(Date.now() + ttl * 1000).toISOString(), digest,
        ...(options.header ? { header: options.header } : {}) });
      await options.store.put(prefix + challenge.id, { challenge, url: input.url, verb: input.method, digest } satisfies Issued);
      return new Response(JSON.stringify({ error: 'payment_required' }), { status: 402, headers: { 'WWW-Authenticate': Challenge.serialize(challenge), 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
    }
    try {
      const credential = Credential.deserialize(authorization);
      const issued = await options.store.get(prefix + credential.challenge.id) as Issued | null;
      if (!issued || canonical(issued.challenge) !== canonical(credential.challenge) || issued.url !== input.url || issued.verb !== input.method || issued.digest !== digest || canonical(terms) !== canonical(issued.challenge.request))
        throw new PaymentError('binding', 'Challenge was not issued for these terms and request');
      const result = await options.method.execute(credential, work);
      const response = result.response ?? new Response(null, { status: 204 });
      const headers = new Headers(response.headers);
      headers.set('Payment-Receipt', Receipt.serialize(result.receipt));
      headers.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      const state = error instanceof PaymentError ? error.code : 'invalid';
      const status = state === 'running' ? 409 : state === 'uncertain' ? 503 : state === 'handler' || state === 'failed' ? 500 : 402;
      return new Response(JSON.stringify({ error: state, message: error instanceof Error ? error.message : 'Payment rejected' }),
        { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
    }
  };
}
