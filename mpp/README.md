# MPP x402 extensions

Separate `x402/upto` and `x402/batch-settlement` payment methods for MPP. Clients sign genuine x402 authorizations. Servers retain the official x402 verification, reservation, extension, cancellation, and settlement lifecycle. Merchant addresses, assets, networks, pricing, facilitators, signers, and storage are supplied by the host.

This package follows [MPP custom methods](https://mpp.dev/payment-methods/custom), [challenge binding](https://mpp.dev/protocol/challenges), and the installed `mppx` validation/broadcast contract. It uses `Method.from`, `Method.toClient`, `Method.toServer`, `Credential`, `Challenge`, `Receipt`, and `Store.AtomicStore`. The root exports shared definitions; `/client` and `/server` export their implementations. `mppx` and `@x402/core` are peer dependencies. The extension identifiers are experimental, unregistered methods; peers must install compatible implementations. They do not identify themselves as built-in `tempo/charge` or `tempo/session`.

## Build and test

From this directory:

```sh
npm run check
npm test
npm run build
```

Dependencies can resolve from the enclosing backend during local development. A standalone checkout needs `npm install`. The package exports compiled ESM and declarations from `dist`, with an MIT license matching Rawchunks' existing MIT license. No configuration files or secrets are generated at runtime.

The tests use public deterministic local keys and the official EVM client builders, EVM facilitator validators, resource-server hooks, and batch channel manager. Contract reads and writes are simulated; a separate test runs the HTTP flow over a local socket. These checks do not establish live-chain settlement, contract availability on a particular network, hosted wallet acceptance, or MACH checkout acceptance.

## `upto`: authorize a maximum, settle measured usage

The server advertises the maximum amount in base units. The client signs that maximum. The server verifies before work and settles only the handler's measured amount. Neither a client-submitted amount nor an HTTP settlement override is used for billing. Zero usage returns `no-charge` and performs no transfer.

Configure a facilitator and official resource scheme first. This example uses EVM Permit2; another network can inject its own genuine x402 mechanism.

```ts
import { HTTPFacilitatorClient, Store, createHandler, createResourceServer, upto } from 'mpp-x402/server';
import { UptoEvmScheme } from '@x402/evm/upto/server';
import type { Network } from '@x402/core/types';

export async function createUsageHandler(config: {
  facilitatorUrl: string;
  network: Network;
  recipient: string;
  asset: string;
  maximum: string;
  resourceUrl: string;
  realm: string;
  namespace: string;
  store: Store.AtomicStore;
}) {
  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const server = createResourceServer(facilitator, [{ network: config.network, scheme: new UptoEvmScheme() }]);
  await server.initialize();
  const [requirements] = await server.buildPaymentRequirements({
    scheme: 'upto', network: config.network, payTo: config.recipient,
    price: { asset: config.asset, amount: config.maximum }, maxTimeoutSeconds: 300,
  });
  if (!requirements) throw new Error('Facilitator does not support this offer');
  const method = upto({ server, facilitator, store: config.store, namespace: config.namespace });
  return createHandler({
    method, offer: { requirements, resource: { url: config.resourceUrl } },
    store: config.store, namespace: config.namespace, realm: config.realm,
  });
}
```

Use the returned handler with a Fetch API `Request`. The host supplies the business operation and billing policy:

```ts
const response = await handle(request, async ({ payment }) => {
  const result = await generateResource();
  const amount = priceMeasuredUsage(result.usage); // Integer base-unit string, <= payment.accepted.amount.
  return { response: Response.json(result.output), amount };
});
```

Do not return streaming content before its amount is final. Buffer/finalize usage first, or build a streaming lifecycle with separately authorized checkpoints. The helper executes work once per issued challenge; retries of a completed credential return its receipt with HTTP 204 and do not rerun work. Hosts that require the original output on retry should keep their business result under the challenge ID. Errors during resource work abort payment and cancel batch reservations; external business side effects still require the host's normal idempotency controls.

Configure the client with the official x402 client so its policies and extension hooks remain active:

```ts
import { x402Client } from '@x402/core/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { createClient, upto } from 'mpp-x402/client';

const core = new x402Client().register(network, new UptoEvmScheme(signer));
const client = createClient({ methods: [upto({ client: core, networks: [network] })], polyfill: false });
const response = await client.fetch(resourceUrl, { method: 'POST', body: JSON.stringify(input) });
```

`createClient` reconciles at MPP's custom fetch boundary before returning a paid response. Reconciliation errors reach the caller; MPP observation events swallow errors and are not a sufficient payment gate. When using `Mppx.create` directly, call `method.onResponse({ credential, response })` in your paid-response transport boundary. Preserve x402 client spend controls; do not disable them merely to make an unsupported asset payable.

## `batch-settlement`: fund, accept vouchers, then claim and settle

Use the dedicated `batch` client/server exports and the official `BatchSettlementEvmScheme`. A first request signs an ERC-3009 or Permit2 channel deposit and a cumulative voucher. Subsequent requests sign cumulative vouchers. A deposit receipt reports `funded`; a voucher receipt reports `accepted`. The full original x402 settlement response is retained for client reconciliation.

```ts
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/server';
import type { BatchSettlementEvmSchemeServerConfig } from '@x402/evm/batch-settlement/server';
import { batch, createResourceServer } from 'mpp-x402/server';

const scheme = new BatchSettlementEvmScheme(receiver, {
  storage: channelStorage,
  receiverAuthorizerSigner,
} satisfies BatchSettlementEvmSchemeServerConfig);
const server = createResourceServer(facilitator, [{ network, scheme }]);
await server.initialize();
const method = batch({ server, facilitator, store, namespace });
// Build the batch-settlement requirements, then pass method + offer to createHandler.
// EIP-3009 assets must advertise their real name/version domain metadata.
```

Run the official manager separately, with the SAME scheme, receiver, token, network and storage:

```ts
const manager = scheme.createChannelManager(facilitator, network, token);
const outstanding = await manager.getClaimableVouchers();
const result = await manager.claimAndSettle();
// result.claims holds claim transactions; result.settle holds the treasury transfer.
```

`manager.start(policy)` and `manager.stop()` support scheduled claim, settle, and refund operations. The host owns scheduling and reconciliation. A channel deposit or an accepted voucher does not prove that the treasury transfer has happened. Never turn an empty x402 transaction field into a chain receipt. The package does not sign or automatically run manager jobs.

Client setup:

```ts
import { x402Client } from '@x402/core/client';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client';
import { batch, createClient } from 'mpp-x402/client';

const core = new x402Client().register(network, new BatchSettlementEvmScheme(signer, {
  storage: clientChannelStorage,
  payerAuthorizer: signer.address,
}));
const method = batch({ client: core, networks: [network], receipts: clientReceiptStore });
const client = createClient({ methods: [method], polyfill: false });
```

Persist the client channel and receipt stores together. Repeated receipt processing is deduplicated; a reconciliation interrupted mid-update stays pending rather than applying a deposit/charge again. Inspect the channel and use the official recovery helpers before resolving that state. The package rejects stale vouchers; it does not automatically manufacture corrective channel state or silently retry a failed payment.

## Wire format

Both definitions use method `x402`, protocol revision `methodDetails.version = 1`, and distinct intents `upto` and `batch-settlement`.

```ts
// Challenge.request
{
  amount: requirements.amount,
  currency: requirements.asset,
  recipient: requirements.payTo,
  methodDetails: { version: 1, requirements, resource, extensions }
}

// Credential.payload
{ payment: { x402Version: 2, accepted: requirements, resource, payload: genuineSchemeProof, extensions } }

// Payment-Receipt (base64url MPP Receipt)
{
  method: 'x402', status: 'success', timestamp, reference,
  x402: {
    version: 1, intent, challengeId,
    stage: 'settled' | 'funded' | 'accepted' | 'no-charge',
    chargedAmount, settlement: originalX402SettleResponse
  }
}
```

Amounts are canonical nonnegative decimal strings in token base units; all arithmetic uses `bigint`. Requirements, resource, extension echoes, signatures, and official settlement responses are preserved. The server checks the full accepted terms against the issued challenge, the declared extensions, scheme, network, expiry and authorization flow. It rejects uninitialized or unsupported configuration. Clients must verify the server's TLS origin and apply their own spend policy.

## Binding, replay, concurrency and recovery

`createHandler` uses MPP's documented stateful binding: a randomly identified challenge is stored with its exact terms, expiry, method, intent, realm, advertised credential header, body digest, URL and HTTP verb. The returned credential must echo them. It uses `Authorization` by default; pass `header: 'Payment-Authorization'` to retain a separate application authorization header. Business identity/access control remains the host's responsibility. An ordinary Bearer header is not interpreted as a payment credential.

The host must supply an atomic store and stable merchant/service namespace. Share that namespace across protected routes when a proof must be consumed at most once across routes. Official Permit2 replay identity uses signer/spender/nonce; batch identity uses channel/cumulative amount. Another mechanism must provide `proofKey(payment)` for its native authorization identity. It must identify the authorization, not the signature encoding or transport header. For multi-currency/channel stores, namespace those appropriately as well.

The operation journal retains the exact payment and measured amount. It atomically blocks concurrent executions and consumes a proof at most once. A failed pre-settlement operation cancels its reservation and releases its proof for a NEW challenge. A completed or uncertain operation retains proof ownership. Terminal settlement is journaled as uncertain before sending it: timeouts, crashes during settlement, malformed success responses and storage failures cannot authorize an automatic second payment.

```ts
const operation = await method.inspect(challengeId);
// Reconcile independently through the facilitator's pending-transaction mechanism,
// authoritative channel state or transaction receipt; construct the matching receipt.
await method.reconcile(challengeId, confirmedReceipt);
```

`reconcile` accepts only an uncertain operation and checks the network, intent, challenge ID, successful outcome and persisted billed amount. It does not broadcast, repeat work, or verify an arbitrary receipt onchain. Call it from trusted server code only after independent reconciliation. A process crash during resource work leaves `running`; recover the business operation under exclusive coordination rather than assuming its side effects did not happen. Store pruning must retain proofs through their actual authorization lifetime and batch channel lifetime; do not prune merely because the HTTP challenge expired.

`Store.memory()` and the official in-memory channel stores are useful for tests or one process. Production requires durable backend atomic `update` for the journal/receipt stores and `updateChannel` for channel storage. A Redis wrapper without a backend atomic callback is insufficient. `createResourceServer` wraps scheme hooks so unexpected state errors abort admission or surface settlement uncertainty. Custom resource extensions/manual hooks must return x402 abort results for required checks, since core can log and continue after thrown extension/manual errors. Use `admitted` for an additional mandatory server check after reservation.

## Direct MPP composition

The exported factories are ordinary `Method.toClient`/`Method.toServer` implementations. A host can compose them with `Mppx.create({ methods, secretKey: hostSuppliedSecret })`. `upto` then requires a `meter` callback that obtains the finalized amount from trusted server state; its broadcast is terminal, so do not expect a later route handler to change that amount. Use `createHandler` for execute-then-meter billing.

`Method.validateCredential` only performs read-only facilitator verification; it creates no channel reservation, transfer or success receipt. Validate is a precheck, not proof that another request cannot spend the balance. Lower-level `Method.validateCredential`, `Method.broadcastCredential` and `method.execute` do not establish host challenge issuance or HTTP route binding. Use `createHandler`, high-level `Mppx` binding, or your own authoritative binding before accepting them. They still verify proof/terms, expiry, supported capabilities and replay state.

## Compatibility boundary

* **Facilitators:** any official-interface implementation advertising x402 v2 support for the selected scheme and network can be supplied, including Compose. Authentication, URLs, headers, asset metadata, signers and extensions are host configuration. The package does not change a facilitator API. Both read-only and terminal verification use genuine proofs.
* **Networks:** mechanism injection is network-neutral; this suite verifies the official EVM Permit2 and batch implementations. Another network requires its corresponding x402 scheme/client and replay identity. Contract deployment and provider support must be checked before offering a network.
* **Exact:** retain existing `mppx/x402` exact compatibility alongside these extensions when needed. This package implements the missing distinct `upto` and `batch-settlement` intents.
* **MACH/card:** Tempo's MACH charge approval/swap is not a Permit2, ERC-3009 or x402 checkpoint authorization. HTTP header translation cannot make an unchanged x402 facilitator verify it. This package does not claim native MACH/card support, charge cards, or convert MACH into a fabricated x402 proof. A separately specified MACH funding/payment mechanism is needed for that flow.
* **Rawchunks:** the package is independently configurable under `backend/mpp`. Existing backend endpoints, the embedded connector and public API discovery are not wired by this package's creation.

## References

* [MPP custom method and package practices](https://mpp.dev/payment-methods/custom)
* [MPP challenges and stateful binding](https://mpp.dev/protocol/challenges)
* [MPP protocol](https://paymentauth.org)
* [mppx](https://github.com/wevm/mppx)
* [x402 SDK](https://github.com/coinbase/x402)

Verified implementation versions: `mppx 0.13.4`, `@x402/core 2.28.0`, `@x402/evm 2.28.0`. Upgrades require repeating lifecycle and wire-compatibility tests.
