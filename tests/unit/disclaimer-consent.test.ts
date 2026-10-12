import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from '../../../app/node_modules/react';
import { renderToString } from '../../../app/node_modules/react-dom/server';
import { QueryClient, QueryClientProvider } from '../../../app/node_modules/@tanstack/react-query';

const identity = vi.hoisted(() => ({ evmAddress: `0x${'ab'.repeat(20)}`, userAddress: `0x${'ab'.repeat(20)}` as string | null }));
vi.mock('../../../app/src/hooks/use-address', () => ({ useSelectedUserAddress: () => identity }));
vi.mock('../../../app/src/lib/sdk', () => ({ sdk: { user: { getConsent: vi.fn() } } }));
vi.mock('../../../app/src/components/disclaimer', () => ({ DISCLAIMER_POLICY_VERSION: '1.0.0', DISCLAIMER_TYPE: 'ai_passthrough' }));
import { useDisclaimerConsent } from '../../../app/src/hooks/use-disclaimer';

describe('consent belongs to the connected account pair', () => {
  beforeEach(() => {
    identity.evmAddress = `0x${'ab'.repeat(20)}`;
    identity.userAddress = identity.evmAddress;
  });

  it('retains recorded consent when switching from EVM to Solana and while Solana resolves', () => {
    const client = new QueryClient();
    client.setQueryData(['user-consent', `0x${'ab'.repeat(20)}`, '1.0.0'], { consented: true, record: { policyVersion: '1.0.0' } });
    function State() {
      const consent = useDisclaimerConsent();
      return createElement('span', null, consent.hasConsented ? 'accepted' : 'required');
    }
    const render = () => renderToString(createElement(QueryClientProvider, { client }, createElement(State)));
    expect(render()).toContain('accepted');
    identity.userAddress = null;
    expect(render()).toContain('accepted');
    identity.userAddress = 'So11111111111111111111111111111111111111112';
    expect(render()).toContain('accepted');
    identity.evmAddress = `0x${'AB'.repeat(20)}`;
    expect(render()).toContain('accepted');
    identity.evmAddress = `0x${'cd'.repeat(20)}`;
    identity.userAddress = identity.evmAddress;
    expect(render()).toContain('required');
    client.clear();
  });
});
