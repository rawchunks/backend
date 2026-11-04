import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('window', { dispatchEvent: () => true, addEventListener: () => {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('Credits & Session action-aware routing', () => {
  it('revokes the captured session through the SDK after its active token is cleared', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, method: init.method, headers: new Headers(init.headers) }); return Response.json({ success: true }); });
    const { compose } = await import('../../../app/src/lib/compose');
    const original = `0x${'a'.repeat(40)}`;
    compose.wallets.attach({ address: original, network: 'eip155:84532' });
    compose.keys.use('captured-key');
    compose.keys.clearToken();
    await compose.fetch('/api/keys/captured-id', { method: 'DELETE', key: 'captured-key', paymentMode: 'key', userAddress: original, network: 'eip155:84532' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.compose.market/api/keys/captured-id');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].headers.get('authorization')).toBe('Bearer captured-key');
    expect(calls[0].headers.get('x-network-id')).toBe('eip155:84532');
    expect(calls[0].headers.get('x-session-user-address')).toBe(original);
    expect(compose.keys.currentToken()).toBeNull();
  });

  it('attributes a delayed playback budget response to its captured account', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>(done => { resolve = done; }));
    const { compose } = await import('../../../app/src/lib/compose');
    const apiMod = await import('../../../app/src/lib/api');
    const original = `0x${'a'.repeat(40)}`;
    compose.wallets.attach({ address: original, network: 'eip155:84532' });
    compose.keys.use('captured-key');
    const event = vi.fn(); compose.events.on('budget', event);
    const pending = apiMod.api.fetch('/api/songs/song/stream/checkpoint', apiMod.streamOptions({ source: 'usdc', token: 'captured-key', account: original, network: 'eip155:84532', walletToken: null }));
    compose.wallets.attach({ address: `0x${'b'.repeat(40)}`, network: 'eip155:8453' });
    compose.keys.use('current-key');
    resolve(Response.json({}, { headers: { 'x-session-budget-limit': '50000', 'x-session-budget-used': '10000', 'x-session-budget-remaining': '40000' } }));
    await pending;
    expect(event).toHaveBeenCalledWith(expect.objectContaining({ userAddress: original, network: 'eip155:84532' }));
    expect(compose.keys.currentToken()).toBe('current-key');
  });
  it.each(['card', 'usdc'] as const)('keeps captured %s checkpoint credentials after the account and preference change', async source => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({ error: 'Rejected' }, { status: 402 }); });
    const { compose } = await import('../../../app/src/lib/compose');
    const apiMod = await import('../../../app/src/lib/api');
    const account = `0x${'a'.repeat(40)}`;
    compose.wallets.attach({ address: account, network: 'eip155:84532' });
    compose.keys.use('captured-key');
    apiMod.setCreditRequestContext({ userAddress: account, authToken: 'captured-wallet', preferredSource: source, promoAvailableAtomics: '0', cardAvailableAtomics: '1000000', usdcActive: true });
    const captured = apiMod.captureStreamBilling(account)[0];
    compose.wallets.attach({ address: `0x${'b'.repeat(40)}`, network: 'eip155:8453' });
    compose.keys.use('current-key');
    apiMod.setCreditRequestContext({ userAddress: `0x${'b'.repeat(40)}`, authToken: 'current-wallet', preferredSource: source === 'card' ? 'usdc' : 'card', promoAvailableAtomics: '0', cardAvailableAtomics: '1000000', usdcActive: true });
    const result = await apiMod.api.fetch('/api/songs/song/stream/checkpoint', { ...apiMod.streamOptions(captured), method: 'POST', body: JSON.stringify({ paymentIntentId: 'intent', listenedSeconds: 2.003, terminal: true }) });
    expect(result.status).toBe(402);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('x-network-id')).toBe('eip155:84532');
    expect(calls[0].headers.get('x-session-user-address')).toBe(account);
    expect(calls[0].headers.get('x-wallet-auth-token')).toBe('captured-wallet');
    expect(calls[0].headers.get('authorization')).toBe(source === 'card' ? null : 'Bearer captured-key');
    expect(calls[0].headers.get('x-credit-source')).toBe(source === 'card' ? 'card' : null);
  });
  it('sends Credits balance requests to Rawchunks with verified wallet credentials', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const apiMod = await import('../../../app/src/lib/api');
    apiMod.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '0',
      usdcActive: false,
    });
    await apiMod.api.fetch('/api/credits/balance');
    expect(calls[0].url).toBe('https://api.rawchunks.space/api/credits/balance');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBe('wallet-auth');
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  it('never forwards wallet or credit source credentials to Compose Market (/api/session)', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const { compose } = await import('../../../app/src/lib/compose');
    const apiMod = await import('../../../app/src/lib/api');
    apiMod.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '1000000',
      usdcActive: true,
    });
    await compose.fetch('/api/session', { headers: { 'x-wallet-auth-token': 'wallet-auth', 'x-credit-source': 'promo' } });
    expect(calls[0].url).toBe('https://api.compose.market/api/session');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBeNull();
    expect(calls[0].headers.get('x-credit-source')).toBeNull();
  });

  it('routes studio generation to preferred promo pool without adding a Compose debit', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const apiMod = await import('../../../app/src/lib/api');
    apiMod.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '1000000',
      usdcActive: true,
    });
    await apiMod.api.fetch('/api/generation/generate', { method: 'POST' });
    expect(calls[0].headers.get('x-credit-source')).toBe('promo');
    expect(calls[0].headers.get('x-wallet-auth-token')).toBe('wallet-auth');
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  it('never uses promo credits for streaming (/api/songs/:id/stream), routing automatically to card or usdc', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return Response.json({}); });
    const apiMod = await import('../../../app/src/lib/api');
    apiMod.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '1000000',
      usdcActive: true,
    });
    await apiMod.api.fetch('/api/songs/song-123/stream');
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
    const apiMod = await import('../../../app/src/lib/api');
    apiMod.setCreditRequestContext({
      userAddress: `0x${'a'.repeat(40)}`,
      authToken: 'wallet-auth',
      preferredSource: 'promo',
      promoAvailableAtomics: '1000000',
      cardAvailableAtomics: '1000000',
      usdcActive: false,
    });
    const res = await apiMod.api.fetch('/api/generation/generate', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(calls.map(c => c.source)).toEqual(['promo', 'card']);
  });

  it('evicts unadmitted and rejected rawchunks:stream:* entries on restore without firing background /stream requests', async () => {
    const storageMap = new Map<string, string>([
      [
        'rawchunks:stream:dead-unadmitted',
        JSON.stringify({
          id: 'dead-unadmitted',
          songId: 'sng-65891b7d-a32e-4ffe-b231-1b919033a3f2',
          billing: { source: 'card', token: null, account: '0x1111111111111111111111111111111111111111', network: 'eip155:84532', walletToken: 'tok' },
          alternatives: [],
          intent: null,
          observedMs: 0,
          acceptedMs: 0,
          durationMs: 180000,
          terminal: true,
          rejected: false,
          exempt: false,
        }),
      ],
      [
        'rawchunks:stream:dead-rejected',
        JSON.stringify({
          id: 'dead-rejected',
          songId: 'sng-f6e9ba93-d506-46f7-b0b8-1e134cd83f73',
          billing: { source: 'card', token: null, account: '0x1111111111111111111111111111111111111111', network: 'eip155:84532', walletToken: 'tok' },
          alternatives: [],
          intent: null,
          observedMs: 0,
          acceptedMs: 0,
          durationMs: 180000,
          terminal: true,
          rejected: true,
          exempt: false,
        }),
      ],
      [
        'rawchunks:stream:valid-admitted',
        JSON.stringify({
          id: 'valid-admitted',
          songId: 'sng-valid-1',
          billing: { source: 'card', token: null, account: '0x1111111111111111111111111111111111111111', network: 'eip155:84532', walletToken: 'tok' },
          alternatives: [],
          intent: 'crd:0x1111111111111111:valid-admitted',
          observedMs: 12000,
          acceptedMs: 0,
          durationMs: 180000,
          terminal: false,
          rejected: false,
          exempt: false,
        }),
      ],
    ]);
    vi.stubGlobal('localStorage', {
      get length() { return storageMap.size; },
      key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => { storageMap.set(k, v); },
      removeItem: (k: string) => { storageMap.delete(k); },
    });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return Response.json({
        success: true,
        result: {
          status: 'credited',
          acceptedListenedSeconds: 12,
          billedWei: '6000',
          deltaWei: '6000',
        },
      });
    });

    const { store } = await import('../../../app/src/lib/store');
    await Promise.all(Array.from((store as any).playbacks.values()).map((l: any) => l.running));

    // Both dead entries are evicted without calling /api/songs/:id/stream
    expect(storageMap.has('rawchunks:stream:dead-unadmitted')).toBe(false);
    expect(storageMap.has('rawchunks:stream:dead-rejected')).toBe(false);
    expect(calls.some(u => u.endsWith('/stream'))).toBe(false);

    // Valid admitted entry sent its terminal checkpoint and cleaned itself up
    expect(calls).toEqual(['https://api.rawchunks.space/api/songs/sng-valid-1/stream/checkpoint']);
    expect(storageMap.has('rawchunks:stream:valid-admitted')).toBe(false);
    expect((store as any).playbacks.size).toBe(0);
  });
});
