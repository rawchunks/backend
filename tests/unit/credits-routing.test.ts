import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('window', { dispatchEvent: () => true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe('Credits credentials routing', () => {
  it('sends Credits to Rawchunks with verified wallet credentials', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const api = await import('../../../app/src/lib/sdk');
    if ('setCreditRequestContext' in api) (api as any).setCreditRequestContext({ userAddress: `0x${'a'.repeat(40)}`, authToken: 'wallet-auth', sessionToken: 'credits-session' });
    await api.sdk.fetch('/api/credits/balance');
    expect(calls[0].url).toBe('https://api.rawchunks.space/api/credits/balance');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBe('wallet-auth');
    expect(calls[0].headers.get('authorization')).toBeNull();
  });
  it('never forwards wallet or credit session credentials to Compose', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const api = await import('../../../app/src/lib/sdk');
    if ('setCreditRequestContext' in api) (api as any).setCreditRequestContext({ userAddress: `0x${'a'.repeat(40)}`, authToken: 'wallet-auth', sessionToken: 'credits-session' });
    await api.sdk.fetch('/api/session', { headers: { 'x-wallet-auth-token': 'wallet-auth', 'x-credit-session-token': 'credits-session' } });
    expect(calls[0].url).toBe('https://api.compose.market/api/session');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBeNull();
    expect(calls[0].headers.get('x-credit-session-token')).toBeNull();
  });
  it('uses prepaid credentials for services without adding a Compose debit', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const api = await import('../../../app/src/lib/sdk');
    if ('setCreditRequestContext' in api) (api as any).setCreditRequestContext({ userAddress: `0x${'a'.repeat(40)}`, authToken: 'wallet-auth', sessionToken: 'credits-session' });
    await api.sdk.fetch('/api/generation/generate', { method: 'POST' });
    expect(calls[0].headers.get('x-credit-session-token')).toBe('credits-session');
    expect(calls[0].headers.get('authorization')).toBeNull();
  });
});
