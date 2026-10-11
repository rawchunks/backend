import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Challenge, Credential, Method, Receipt } from 'mppx';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/server';
import { uptoPermit2WitnessTypes, PERMIT2_ADDRESS } from '@x402/evm';
import { verifyTypedData } from 'viem';
import { fixture, payer, url } from './fixtures.js';
import type { PaymentReceipt } from '../methods.js';

async function credential(f: Awaited<ReturnType<typeof fixture>>, body = '{}') {
  const request = new Request(url, { method: 'POST', body });
  const response = await f.handle(request, async () => { throw new Error('Unpaid handler executed'); });
  assert.equal(response.status, 402);
  const challenge = Challenge.fromResponse(response);
  const value = await f.clientMethod.createCredential({ challenge: challenge as Parameters<typeof f.clientMethod.createCredential>[0]['challenge'] });
  return { value, challenge, request, paid: new Request(url, { method: 'POST', body, headers: { Authorization: value } }) };
}
function readReceipt(response: Response) { return Receipt.deserialize(response.headers.get('Payment-Receipt')!) as PaymentReceipt; }

test('upto: HTTP negotiation, official Permit2 signature and actual partial settlement', async () => {
  const f = await fixture('upto');
  let work = 0;
  const client = f.client(async () => { work++; return { response: Response.json({ song: 'generated' }), amount: '375' }; });
  const response = await client.fetch(url, { method: 'POST', body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { song: 'generated' });
  const receipt = readReceipt(response);
  assert.equal(receipt.x402.stage, 'settled');
  assert.equal(receipt.x402.chargedAmount, '375');
  assert.equal(receipt.x402.settlement.amount, '375');
  assert.equal(work, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.name, 'settle');
});

test('upto: independent EIP712 check, non-mutating validation, replay and concurrent execution', async () => {
  const f = await fixture('upto');
  const c = await credential(f);
  const decoded = Credential.deserialize<any>(c.value);
  const p = decoded.payload.payment.payload;
  const a = p.permit2Authorization;
  assert.equal(await verifyTypedData({ address: payer.address, domain: { name: 'Permit2', chainId: 84532, verifyingContract: PERMIT2_ADDRESS },
    types: uptoPermit2WitnessTypes, primaryType: 'PermitWitnessTransferFrom', message: { permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, spender: a.spender,
      nonce: BigInt(a.nonce), deadline: BigInt(a.deadline), witness: { ...a.witness, validAfter: BigInt(a.witness.validAfter) } }, signature: p.signature }), true);
  await Method.validateCredential([f.method], c.value);
  assert.equal(f.writes.length, 0);
  assert.equal(await f.method.inspect(c.challenge.id), null);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = f.handle(c.paid, async () => { entered(); await gate; return { response: Response.json({ ok: true }), amount: '400' }; });
  await started;
  const second = await f.handle(c.paid, async () => { throw new Error('Duplicated work'); });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  const replay = await f.handle(c.paid, async () => { throw new Error('Replay executed'); });
  assert.equal(replay.status, 204);
  assert.equal(readReceipt(replay).x402.chargedAmount, '400');
  assert.equal(f.writes.length, 1);
  const other = await credential(f);
  const transplanted = Credential.serialize({ challenge: other.challenge, payload: decoded.payload });
  const cross = await f.handle(new Request(url, { method: 'POST', body: '{}', headers: { Authorization: transplanted } }), async () => { throw new Error('Proof reused'); });
  assert.equal(cross.status, 402);
  assert.equal((await cross.json()).error, 'replay');
});

test('challenge binding rejects altered terms, route, verb, body, header and expiration before work', async () => {
  const f = await fixture('upto');
  const c = await credential(f);
  const decoded = Credential.deserialize<any>(c.value);
  const variants = [
    { url: url + '?other=1', method: 'POST', body: '{}' },
    { url, method: 'PUT', body: '{}' },
    { url, method: 'POST', body: '{"other":true}' },
  ];
  for (const v of variants) {
    const response = await f.handle(new Request(v.url, { method: v.method, body: v.body, headers: { Authorization: c.value } }), async () => { throw new Error('Tampered work'); });
    assert.equal(response.status, 402);
  }
  for (const mutate of [
    (x: any) => { x.challenge.request.amount = '1'; },
    (x: any) => { x.challenge.header = 'Other'; },
    (x: any) => { x.challenge.expires = '2000-01-01T00:00:00Z'; },
    (x: any) => { x.challenge.realm = 'attacker'; },
  ]) {
    const changed = structuredClone(decoded); mutate(changed);
    const response = await f.handle(new Request(url, { method: 'POST', body: '{}', headers: { Authorization: Credential.serialize(changed) } }), async () => { throw new Error('Tampered work'); });
    assert.equal(response.status, 402);
  }
  assert.equal(f.counts().verifyCalls, 0);
  assert.equal(f.writes.length, 0);
});

test('upto: funding, forged proofs, cap overflow, handler failure and zero usage', async () => {
  for (const mode of ['signature', 'funding', 'cap', 'handler', 'zero'] as const) {
    const f = await fixture('upto');
    const c = await credential(f);
    let value = c.value;
    if (mode === 'signature') {
      const d = Credential.deserialize<any>(value); d.payload.payment.payload.signature = `0x${'0'.repeat(130)}`; value = Credential.serialize(d);
    }
    if (mode === 'funding') {
      const previous = f.signer.readContract;
      f.signer.readContract = async args => { if (args.functionName === 'settle') throw new Error('Insufficient balance'); if (args.functionName === 'balanceOf') return 0n; return previous(args); };
    }
    let called = false;
    const response = await f.handle(new Request(url, { method: 'POST', body: '{}', headers: { Authorization: value } }), async () => {
      called = true;
      if (mode === 'handler') throw new Error('Generation failed');
      return { response: Response.json({ ok: true }), amount: mode === 'cap' ? '1001' : '0' };
    });
    assert.equal(response.status, mode === 'zero' ? 200 : 402);
    assert.equal(called, mode !== 'signature' && mode !== 'funding');
    assert.equal(f.writes.length, 0);
    if (mode === 'zero') assert.equal(readReceipt(response).x402.stage, 'no-charge');
  }
});

test('ambiguous settlement blocks retries and exposes persisted state', async () => {
  const f = await fixture('upto');
  const c = await credential(f);
  f.failSettle();
  let work = 0;
  const job = async () => { work++; return { response: Response.json({ ok: true }), amount: '500' }; };
  assert.equal((await f.handle(c.paid, job)).status, 503);
  assert.equal((await f.method.inspect(c.challenge.id))?.state, 'uncertain');
  assert.equal((await f.handle(c.paid, job)).status, 503);
  assert.equal(work, 1);
  assert.equal(f.counts().settleCalls, 1);
  const recovered: PaymentReceipt = { method: 'x402', status: 'success', reference: `0x${'9'.repeat(64)}`, timestamp: new Date().toISOString(),
    x402: { version: 1, intent: 'upto', challengeId: c.challenge.id, stage: 'settled', chargedAmount: '500', settlement: { success: true, transaction: `0x${'9'.repeat(64)}`, network: f.offer.requirements.network, amount: '500' } } };
  await assert.rejects(f.method.reconcile(c.challenge.id, { ...recovered, x402: { ...recovered.x402, challengeId: 'wrong' } }));
  await f.method.reconcile(c.challenge.id, recovered);
  assert.equal((await f.handle(c.paid, job)).status, 204);
  assert.equal(work, 1);
  assert.equal(f.counts().settleCalls, 1);
});

test('batch: real deposit then sequential vouchers reconcile and claim/settle independently', async () => {
  const f = await fixture('batch-settlement');
  const client = f.client(async () => ({ response: Response.json({ ok: true }) }));
  const first = await client.fetch(url, { method: 'POST', body: '{}' });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.name, 'deposit');
  assert.equal(readReceipt(first).x402.stage, 'funded');
  for (let i = 0; i < 2; i++) {
    const response = await client.fetch(url, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(readReceipt(response).x402.stage, 'accepted');
    assert.equal(readReceipt(response).x402.settlement.transaction, '');
  }
  const channel = (await f.storage.list())[0]!;
  assert.equal(channel.chargedCumulativeAmount, '3000');
  assert.equal((await f.clientStorage.get(channel.channelId.toLowerCase()))?.chargedCumulativeAmount, '3000');
  assert.equal(f.writes.length, 1);
  const manager = (f.scheme as BatchSettlementEvmScheme).createChannelManager(f.facilitator, f.offer.requirements.network, f.offer.requirements.asset as `0x${string}`);
  assert.equal((await manager.getClaimableVouchers())[0]?.voucher.maxClaimableAmount, '3000');
  const result = await manager.claimAndSettle();
  assert.equal(result.claims[0]?.vouchers, 1);
  assert.ok(result.settle?.transaction);
  assert.deepEqual(f.writes.map(x => x.name), ['deposit', 'claimWithSignature', 'settle']);
});

test('batch validation reserves nothing; failed handler cancels reservation', async () => {
  const f = await fixture('batch-settlement');
  const client = f.client(async () => ({ response: Response.json({ ok: true }) }));
  assert.equal((await client.fetch(url, { method: 'POST', body: '{}' })).status, 200);
  const c = await credential(f);
  const before = await f.storage.list();
  await Method.validateCredential([f.method], c.value);
  assert.deepEqual(await f.storage.list(), before);
  await f.handle(c.paid, async () => { throw new Error('Failed job'); });
  const after = (await f.storage.list())[0]!;
  assert.equal(after.pendingRequest, undefined);
  assert.equal(after.chargedCumulativeAmount, '1000');
  assert.equal(f.writes.length, 1);
  const retry = await credential(f);
  const response = await f.handle(retry.paid, async () => ({ response: Response.json({ ok: true }) }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await f.storage.list())[0]?.chargedCumulativeAmount, '2000');
});

test('batch storage failure aborts before resource work', async () => {
  const f = await fixture('batch-settlement');
  const c = await credential(f);
  f.storage.get = async () => { throw new Error('Storage down'); };
  let called = false;
  const response = await f.handle(c.paid, async () => { called = true; return { response: Response.json({ ok: true }) }; });
  assert.equal(response.status, 402);
  assert.equal(called, false);
  assert.equal(f.writes.length, 0);
});

test('receipt mismatch is rejected before official client reconciliation', async () => {
  const f = await fixture('upto');
  const c = await credential(f);
  const response = await f.handle(c.paid, async () => ({ response: Response.json({ ok: true }), amount: '500' }));
  const receipt = readReceipt(response);
  receipt.x402.challengeId = 'other';
  await assert.rejects(f.clientMethod.onResponse({ credential: c.value, response: new Response(null, { headers: { 'Payment-Receipt': Receipt.serialize(receipt) } }) }), /Receipt does not match/);
});

test('MPP Method broadcast lifecycle works with server-owned metering', async () => {
  const f = await fixture('upto');
  const c = await credential(f);
  await assert.rejects(Method.broadcastCredential([f.method], c.value), /server-owned metering/);
  const { upto } = await import('../server/index.js');
  const method = upto({ server: f.server, facilitator: f.facilitator, store: f.store, namespace: 'merchant', meter: async () => '600' });
  const receipt = await Method.broadcastCredential([method], c.value) as PaymentReceipt;
  assert.equal(receipt.x402.chargedAmount, '600');
  assert.equal(f.writes.length, 1);
});

test('shared schemas keep base units, extension data and reject wrong network/scheme', async () => {
  const f = await fixture('upto');
  const { toRequest } = await import('../index.js');
  assert.throws(() => toRequest({ ...f.offer, requirements: { ...f.offer.requirements, amount: '0.1' } }, 'upto'));
  assert.throws(() => toRequest(f.offer, 'batch-settlement'));
  const c = await credential(f);
  const changed = Credential.deserialize<any>(c.value);
  changed.payload.payment.accepted.network = 'eip155:1';
  await assert.rejects(Method.validateCredential([f.method], Credential.serialize(changed)), /does not match/);
  assert.equal(f.clientMethod.canHandleChallenge?.({ challenge: { ...c.challenge, request: { ...c.challenge.request, methodDetails: { ...(c.challenge.request as any).methodDetails, requirements: { ...f.offer.requirements, network: 'eip155:1' } } } } }), false);
});

test('custom MPP credential header retains another authentication scheme', async () => {
  const f = await fixture('upto');
  const { createHandler } = await import('../server/index.js');
  const handler = createHandler({ method: f.method, offer: f.offer, store: f.store, namespace: 'custom', realm: 'merchant.example', header: 'Payment-Authorization' });
  const initial = await handler(new Request(url, { headers: { Authorization: 'Bearer application-key' } }), async () => { throw new Error('Unpaid'); });
  const challenge = Challenge.fromResponse(initial);
  assert.equal(challenge.header, 'Payment-Authorization');
  const value = await f.clientMethod.createCredential({ challenge: challenge as Parameters<typeof f.clientMethod.createCredential>[0]['challenge'] });
  const response = await handler(new Request(url, { headers: { Authorization: 'Bearer application-key', 'Payment-Authorization': value } }), async () => ({ response: Response.json({ ok: true }), amount: '10' }));
  assert.equal(response.status, 200);
});

test('MPP preserves genuine x402 extension echoes and calls resource-server hooks', async () => {
  const f = await fixture('upto');
  const { createHandler } = await import('../server/index.js');
  let hooks = 0;
  f.server.registerExtension({ key: 'metering', hooks: { onBeforeVerify: async () => { hooks++; } } });
  const offer = { ...f.offer, extensions: { metering: { info: { unit: 'token', ceiling: '1000' } } } };
  const handler = createHandler({ method: f.method, offer, store: f.store, namespace: 'extension', realm: 'merchant.example' });
  const response = await handler(new Request(url), async () => { throw new Error('Unpaid'); });
  const challenge = Challenge.fromResponse(response);
  const value = await f.clientMethod.createCredential({ challenge: challenge as Parameters<typeof f.clientMethod.createCredential>[0]['challenge'] });
  const submitted = Credential.deserialize<any>(value);
  assert.deepEqual(submitted.payload.payment.extensions, offer.extensions);
  const changed = structuredClone(submitted);
  changed.payload.payment.extensions.metering.info.ceiling = '999999';
  const invalid = await handler(new Request(url, { headers: { Authorization: Credential.serialize(changed) } }), async () => { throw new Error('Tampered'); });
  assert.equal(invalid.status, 402);
  const paid = await handler(new Request(url, { headers: { Authorization: value } }), async () => ({ response: Response.json({ ok: true }), amount: '20' }));
  assert.equal(paid.status, 200);
  assert.equal(hooks, 1);
});

test('duplicate receipt reconciliation does not double count a batch deposit', async () => {
  const f = await fixture('batch-settlement');
  const c = await credential(f);
  const response = await f.handle(c.paid, async () => ({ response: Response.json({ ok: true }) }));
  await f.clientMethod.onResponse({ credential: c.value, response });
  const before = await f.clientStorage.get((await f.storage.list())[0]!.channelId);
  await f.clientMethod.onResponse({ credential: c.value, response });
  assert.deepEqual(await f.clientStorage.get((await f.storage.list())[0]!.channelId), before);
});

test('actual local HTTP server handles MPP negotiation, signing and paid POST', async () => {
  const { createServer } = await import('node:http');
  const f = await fixture('upto');
  const { createHandler } = await import('../server/index.js');
  let handler!: ReturnType<typeof createHandler>;
  const socket = createServer(async (incoming, outgoing) => {
    try {
      const buffers: Buffer[] = [];
      for await (const chunk of incoming) buffers.push(Buffer.from(chunk));
      const target = `http://${incoming.headers.host}${incoming.url}`;
      const request = new Request(target, { method: incoming.method, headers: incoming.headers as Record<string, string>,
        ...(incoming.method === 'POST' ? { body: Buffer.concat(buffers) } : {}) });
      const response = await handler(request, async () => ({ response: Response.json({ generated: true }), amount: '250' }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  try {
    const address = socket.address();
    assert.ok(address && typeof address !== 'string');
    const target = `http://127.0.0.1:${address.port}/generate`;
    handler = createHandler({ method: f.method, offer: { ...f.offer, resource: { url: target } }, store: f.store, namespace: 'socket', realm: 'localhost' });
    const { createClient } = await import('../client/index.js');
    const client = createClient({ methods: [f.clientMethod], polyfill: false, maxPaymentRetries: 1 });
    const response = await client.fetch(target, { method: 'POST', body: '{"prompt":"test"}' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { generated: true });
    assert.equal(readReceipt(response).x402.chargedAmount, '250');
  } finally { await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve())); }
});

test('createClient surfaces a missing or inconsistent receipt instead of swallowing it as an event error', async () => {
  const f = await fixture('upto');
  const { createClient } = await import('../client/index.js');
  const client = createClient({ methods: [f.clientMethod], fetch: async (input, init) => {
    const response = await f.handle(new Request(input, init), async () => ({ response: Response.json({ ok: true }), amount: '10' }));
    if (response.ok) {
      const headers = new Headers(response.headers); headers.delete('Payment-Receipt');
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  } });
  await assert.rejects(client.fetch(url, { method: 'POST', body: '{}' }), /omitted its Payment-Receipt/);
  assert.equal(f.writes.length, 1);
});

test('high-level Mppx composition verifies a host-bound challenge then broadcasts', async () => {
  const { Mppx, upto } = await import('../server/index.js');
  const { toRequest } = await import('../index.js');
  const f = await fixture('upto');
  const method = upto({ server: f.server, facilitator: f.facilitator, store: f.store, namespace: 'bound', meter: async () => '321' });
  const server = Mppx.create({ methods: [method], secretKey: 'public-test-key-only-never-production-12345678', realm: 'merchant.example' });
  const challenge = Challenge.from({ secretKey: 'public-test-key-only-never-production-12345678', realm: 'merchant.example', method: 'x402', intent: 'upto', expires: new Date(Date.now() + 60000).toISOString(), request: toRequest(f.offer, 'upto') });
  const value = await f.clientMethod.createCredential({ challenge: challenge as Parameters<typeof f.clientMethod.createCredential>[0]['challenge'] });
  const validated = await server.validateCredential(value);
  assert.equal(validated.method, 'x402');
  assert.equal(f.writes.length, 0);
  const receipt = await server.broadcastCredential(value) as PaymentReceipt;
  assert.equal(receipt.x402.chargedAmount, '321');
  assert.equal(f.writes.length, 1);
});
