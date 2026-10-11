import { Mppx, Transport } from 'mppx/client';
import { Credential } from 'mppx';
import type { ClientMethod } from './shared.js';
export { Mppx };
export { upto } from './upto.js';
export { batch } from './batch.js';
export type { ClientOptions, ClientMethod } from './shared.js';

/** Wire receipt reconciliation before another cumulative voucher is created. */
export function createClient<const Methods extends readonly [ClientMethod, ...ClientMethod[]]>(config: Omit<Mppx.create.Config<Methods, Transport.Transport<RequestInit, Response>>, 'transport'>): Mppx.Mppx<Methods, Transport.Transport<RequestInit, Response>> {
  const raw = config.fetch ?? globalThis.fetch;
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    let submitted: { value: string; method: ClientMethod } | undefined;
    for (const value of headers.values()) {
      const payment = Credential.extractPaymentScheme(value);
      if (!payment) continue;
      const { challenge } = Credential.deserialize(payment);
      const method = config.methods.find(candidate => candidate.name === challenge.method && candidate.intent === challenge.intent && (!candidate.canHandleChallenge || candidate.canHandleChallenge({ challenge })));
      if (method) { submitted = { value: payment, method }; break; }
    }
    const response = await raw(input, init);
    // Observation events swallow errors in mppx. Reconcile at the fetch boundary
    // so failures reach the caller and paid 402 corrections are also inspected.
    if (submitted) await submitted.method.onResponse({ credential: submitted.value, response });
    return response;
  };
  return Mppx.create({ ...config, fetch: fetcher, polyfill: config.polyfill ?? false });
}
