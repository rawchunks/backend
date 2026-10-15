import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createWalletAuthenticator } from '../../credits/auth.js';

const admin = '0x1111111111111111111111111111111111111111';
const smart = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const svm = 'So11111111111111111111111111111111111111112';
const stranger = '0x2222222222222222222222222222222222222222';
const token = 'fixture-login-token';
const clientId = 'fixture-client-id';

async function request(headers: Record<string, string>, status = 200, payload: unknown = {
  wallets: [{ address: admin, type: 'enclave', createdAt: '2026-10-18T00:00:00Z' }],
  linkedAccounts: [], id: 'provider-user-id',
}, resolveAddresses = async (): Promise<[string, string]> => [smart, svm]) {
  const provider = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) !== 'https://embedded-wallet.thirdweb.com/api/2024-05-05/accounts') {
      return new Response('{}', { status: 404 });
    }
    const sent = new Headers(init?.headers);
    if (sent.get('authorization') !== `Bearer embedded-wallet-token:${token}` || sent.get('x-client-id') !== clientId) {
      return new Response('{}', { status: 401 });
    }
    return Response.json(payload, { status });
  });
  const authenticate = createWalletAuthenticator({ clientId, fetch: provider, resolveAddresses });
  const app = Fastify();
  app.get('/credits/balance', async req => authenticate(req));
  const result = await app.inject({ method: 'GET', url: '/credits/balance', headers });
  await app.close();
  return result;
}

const valid = { 'x-wallet-auth-token': token, 'x-session-user-address': smart };

describe('Credits wallet ownership', () => {
  it('rejects userAddress alone', async () => {
    expect((await request({ 'x-session-user-address': smart })).statusCode).toBe(401);
  });
  it('rejects an arbitrary login token', async () => {
    expect((await request({ ...valid, 'x-wallet-auth-token': 'forged' })).statusCode).toBe(401);
  });
  it('rejects a revoked or expired token rejected by Thirdweb', async () => {
    expect((await request(valid, 401)).statusCode).toBe(401);
  });
  it('rejects another userAddress even with a valid login', async () => {
    expect((await request({ ...valid, 'x-session-user-address': stranger })).statusCode).toBe(403);
  });
  it('binds the existing smart-account address without introducing an identity ID', async () => {
    const res = await request({ ...valid, 'x-session-user-address': smart.toUpperCase().replace('0X', '0x') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ owner: smart, userAddress: smart, addresses: [smart, svm] });
  });
  it('binds the derived Swig address to the same existing smart-account owner', async () => {
    const res = await request({ ...valid, 'x-session-user-address': svm });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ owner: smart, userAddress: svm, addresses: [smart, svm] });
  });
  it('preserves case-sensitive Solana ownership', async () => {
    expect((await request({ ...valid, 'x-session-user-address': svm.toLowerCase() })).statusCode).toBe(403);
  });
  it('does not accept the personal signer as the application smart account', async () => {
    expect((await request({ ...valid, 'x-session-user-address': admin })).statusCode).toBe(403);
  });
  it('does not trust linked external addresses in the provider response', async () => {
    expect((await request({ ...valid, 'x-session-user-address': stranger }, 200, {
      wallets: [{ address: admin, type: 'enclave', createdAt: '2026-10-18T00:00:00Z' }],
      linkedAccounts: [{ type: 'siwe', details: { address: stranger } }], id: 'provider-user-id',
    })).statusCode).toBe(403);
  });
  it('fails closed on a malformed successful provider response', async () => {
    expect((await request(valid, 200, { wallets: [{ address: stranger }] })).statusCode).toBe(503);
  });
  it('does not turn a Thirdweb outage into an unauthenticated success', async () => {
    expect((await request(valid, 503)).statusCode).toBe(503);
  });
  it('does not turn a failed account derivation into ownership', async () => {
    expect((await request(valid, 200, undefined, async () => { throw new Error('RPC unavailable'); })).statusCode).toBe(503);
  });
  it('rejects missing account selection rather than silently choosing a wallet', async () => {
    expect((await request({ 'x-wallet-auth-token': token })).statusCode).toBe(400);
  });
});
