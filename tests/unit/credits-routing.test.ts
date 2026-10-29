import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('window', { dispatchEvent: () => true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('Credits & Session action-aware routing', () => {
  it('sends Credits balance requests to Rawchunks with verified wallet credentials', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const api = await import('../../../app/src/lib/sdk');
    api.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '0',
      usdcActive: false,
    });
    await api.sdk.fetch('/api/credits/balance');
    expect(calls[0].url).toBe('https://api.rawchunks.space/api/credits/balance');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBe('wallet-auth');
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  it('never forwards wallet or credit source credentials to Compose Market (/api/session)', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const api = await import('../../../app/src/lib/sdk');
    api.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '1000000',
      usdcActive: true,
    });
    await api.sdk.fetch('/api/session', { headers: { 'x-wallet-auth-token': 'wallet-auth', 'x-credit-source': 'promo' } });
    expect(calls[0].url).toBe('https://api.compose.market/api/session');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBeNull();
    expect(calls[0].headers.get('x-credit-source')).toBeNull();
  });

  it('routes studio generation to preferred promo pool without adding a Compose debit', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const api = await import('../../../app/src/lib/sdk');
    api.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '1000000',
      usdcActive: true,
    });
    await api.sdk.fetch('/api/generation/generate', { method: 'POST' });
    expect(calls[0].headers.get('x-credit-source')).toBe('promo');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBe('wallet-auth');
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  it('never uses promo credits for streaming (/api/songs/:id/stream), routing automatically to card or usdc', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const api = await import('../../../app/src/lib/sdk');
    api.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '1000000',
      usdcActive: true,
    });
    await api.sdk.fetch('/api/songs/song-123/stream');
    expect(calls[0].headers.get('x-credit-source')).toBe('card');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBe('wallet-auth');
  });

  it('falls back from promo to card when a studio endpoint returns 402 on promo', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({ url, source: headers.get('x-credit-source') });
      if (headers.get('x-credit-source') === 'promo') {
        return new Response(JSON.stringify({ error: 'Insufficient credits' }), { status: 402 });
      }
      return Response.json({ ok: true });
    });
    const api = await import('../../../app/src/lib/sdk');
    api.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '1000000',
      usdcActive: false,
    });
    const res = await api.sdk.fetch('/api/generation/generate', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(calls.map(c => c.source)).toEqual(['promo', 'card']);
  });
});
