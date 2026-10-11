import { x402ResourceServer } from '@x402/core/server';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network, SchemeNetworkServer, SchemeServerHooks } from '@x402/core/types';

/**
 * Resource-server hooks normally log unexpected errors and continue. Payment gates
 * must fail closed: retain the original scheme instance and its WeakMap contexts,
 * but turn before-hook exceptions into abort results and surface after-hook faults.
 */
export function createResourceServer(facilitator: FacilitatorClient | FacilitatorClient[], registrations: readonly { network: Network; scheme: SchemeNetworkServer }[]): x402ResourceServer {
  const faults = new WeakMap<object, unknown>();
  function scope(context: { paymentPayload: object; transportContext?: unknown }): object {
    return context.transportContext !== null && typeof context.transportContext === 'object' ? context.transportContext : context.paymentPayload;
  }
  class ResourceServer extends x402ResourceServer {
    override async verifyPayment(...args: Parameters<x402ResourceServer['verifyPayment']>) {
      const context = args[3] ?? {};
      const result = await super.verifyPayment(args[0], args[1], args[2], context);
      if (faults.has(scope({ paymentPayload: args[0], transportContext: context }))) throw new Error('x402 verification hook failed');
      return result;
    }
    override async settlePayment(...args: Parameters<x402ResourceServer['settlePayment']>) {
      const context = args[3] ?? {};
      const result = await super.settlePayment(args[0], args[1], args[2], context, args[4], args[5]);
      if (faults.has(scope({ paymentPayload: args[0], transportContext: context }))) throw new Error('x402 settlement hook failed; reconcile the payment');
      return result;
    }
  }
  const server = new ResourceServer(facilitator);
  for (const { network, scheme } of registrations) {
    const original = scheme.schemeHooks;
    const hooks: SchemeServerHooks = {};
    for (const phase of ['onBeforeVerify', 'onAfterVerify', 'onBeforeSettle'] as const) {
      const hook = original?.[phase];
      if (!hook) continue;
      Object.assign(hooks, { [phase]: async (context: Parameters<NonNullable<SchemeServerHooks[typeof phase]>>[0]) => {
        try { return await (hook as (input: typeof context) => Promise<unknown>)(context); }
        catch (error) { faults.set(scope(context), error); return { abort: true, reason: 'mpp_x402_hook_failed', message: 'Payment state unavailable' }; }
      } });
    }
    for (const phase of ['onAfterSettle', 'onVerifyFailure', 'onSettleFailure', 'onVerifiedPaymentCanceled'] as const) {
      const hook = original?.[phase];
      if (!hook) continue;
      Object.assign(hooks, { [phase]: async (context: Parameters<NonNullable<SchemeServerHooks[typeof phase]>>[0]) => {
        try { return await (hook as (input: typeof context) => Promise<unknown>)(context); }
        catch (error) { faults.set(scope(context), error); throw error; }
      } });
    }
    const wrapped = new Proxy(scheme, { get(target, property) {
      if (property === 'schemeHooks') return hooks;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    server.register(network, wrapped);
  }
  return server;
}
