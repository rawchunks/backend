import { afterAll, describe, expect, it, vi } from 'vitest';
import { createElement } from '../../../app/node_modules/react';
import { renderToString } from '../../../app/node_modules/react-dom/server';
import { QueryClient, QueryClientProvider } from '../../../app/node_modules/@tanstack/react-query';

const transport = vi.hoisted(() => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  return fetch;
});
vi.mock('../../../app/src/hooks/use-address', () => ({ useSelectedUserAddress: () => ({ evmAddress: `0x${'ab'.repeat(20)}`, userAddress: 'So11111111111111111111111111111111111111112' }) }));
vi.mock('../../../app/src/components/disclaimer', () => ({ DISCLAIMER_POLICY_VERSION: '1.0.0', DISCLAIMER_TYPE: 'ai_passthrough' }));
import { useDisclaimerConsent } from '../../../app/src/hooks/use-disclaimer';

afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('consent registration and lookup use the same database', () => {
  it.each([200, 503])('reads Rawchunks consent and preserves HTTP %i results', async status => {
    const urls: string[] = [];
    transport.mockImplementation(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(status === 200 ? { consented: true, record: { policyVersion: '1.0.0' } } : { error: 'Consent database unavailable' }), { status, headers: { 'content-type': 'application/json' } });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function State() {
      const consent = useDisclaimerConsent();
      return createElement('span', null, consent.hasConsented ? 'accepted' : 'required');
    }
    const render = () => renderToString(createElement(QueryClientProvider, { client }, createElement(State)));
    render();
    const query = client.getQueryCache().getAll()[0];
    const pending = client.fetchQuery({ ...query.options, retry: false });
    if (status === 200) {
      await expect(pending).resolves.toMatchObject({ consented: true });
      expect(render()).toContain('accepted');
    } else {
      await expect(pending).rejects.toThrow('Consent database unavailable');
      expect(query.state.status).toBe('error');
    }
    expect(urls.length).toBeGreaterThan(0);
    expect([...new Set(urls)]).toEqual([`https://api.rawchunks.space/api/user/consent/0x${'ab'.repeat(20)}?type=ai_passthrough&version=1.0.0`]);
    client.clear();
  });
});
