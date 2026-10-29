import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('frontend API routing', () => {
  it.each(['https://app.rawchunks.space', 'https://rawchunks.vercel.app', 'http://localhost:3001'])('sends consent to the configured API from %s', async origin => {
    vi.stubEnv('VITE_API_URL', 'https://api.rawchunks.space/');
    vi.stubGlobal('window', { location: { origin } });
    const requests: { url: string; headers: Headers }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers) });
      return new Response('{}', { status: 200 });
    });
    const { sdk } = await import('../../../app/src/lib/sdk');
    const { store } = await import('../../../app/src/lib/store');
    store.setUserAddress(`0x${'a'.repeat(40)}`);
    await sdk.fetch('/api/user/consent', { method: 'POST' });
    expect(requests[0].url).toBe('https://api.rawchunks.space/api/user/consent');
    expect(requests[0].headers.get('x-session-user-address')).toBe(`0x${'a'.repeat(40)}`);
  });
  it('uses the HTTPS API when no API URL is configured', async () => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('window', { location: { origin: 'https://another-host.invalid' } });
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { urls.push(url); return new Response('{}'); });
    const { sdk } = await import('../../../app/src/lib/sdk');
    await sdk.fetch('/api/user/consent/account');
    expect(urls).toEqual(['https://api.rawchunks.space/api/user/consent/account']);
  });
});
