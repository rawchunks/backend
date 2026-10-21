import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChainByNetwork, getDefaultNetwork, getEvmChainObject, getNetworkRpcUrl, setChainRegistry } from '../../../app/src/lib/chains';
import type { FacilitatorChain } from '@compose-market/sdk/chains';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('chain registry', () => {
  it('registers an EVM chain absent from the installed wallet presets', () => {
    const chain: FacilitatorChain = {
      network: 'eip155:42431', namespace: 'eip155', name: 'Tempo Moderato',
      rpcUrl: 'https://rpc.fixture.invalid', explorer: 'https://explorer.fixture.invalid',
      isTestnet: true, asset: 'USDC', assetAddress: `0x${'1'.repeat(40)}`, decimals: 6, schemes: ['exact'],
    };
    setChainRegistry([chain], chain.network);
    expect(getEvmChainObject(chain.network as 'eip155:42431')).toMatchObject({ id: 42431, name: chain.name, rpc: chain.rpcUrl, testnet: true });
    expect(getNetworkRpcUrl(chain.network)).toBe(chain.rpcUrl);
  });

  it('uses the selected Solana registry entry without an EVM preset', () => {
    const chain: FacilitatorChain = {
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', namespace: 'solana', name: 'Solana Mainnet',
      rpcUrl: 'https://solana.fixture.invalid', explorer: 'https://explorer.fixture.invalid',
      isTestnet: false, asset: 'USDC', assetAddress: 'So11111111111111111111111111111111111111112', decimals: 6, schemes: ['exact'],
    };
    setChainRegistry([chain], chain.network);
    expect(getChainByNetwork(chain.network)?.namespace).toBe('solana');
    expect(getDefaultNetwork()).toBe(chain.network);
    expect(getNetworkRpcUrl(chain.network)).toBe(chain.rpcUrl);
  });

  it('retains the configured Devnet entry and default when the remote list omits it', async () => {
    const devnet: FacilitatorChain = { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', namespace: 'solana', name: 'Solana Devnet', rpcUrl: 'https://devnet.fixture.invalid', explorer: 'https://explorer.fixture.invalid', explorerQuery: 'cluster=devnet', isTestnet: true, asset: 'USDC', assetAddress: 'So11111111111111111111111111111111111111112', decimals: 6, schemes: [] };
    vi.stubEnv('VITE_NETWORKS', JSON.stringify([devnet]));
    vi.stubEnv('VITE_DEFAULT_NETWORK', devnet.network);
    vi.resetModules();
    const chains = await import('../../../app/src/lib/chains');
    expect(chains.getChains()).toMatchObject([devnet]);
    chains.setChainRegistry([], 'eip155:5042');
    expect(chains.getDefaultNetwork()).toBe(devnet.network);
    expect(chains.getChains()).toMatchObject([devnet]);
    expect(chains.getNetworkRpcUrl(devnet.network)).toBe(devnet.rpcUrl);
    expect(chains.getExplorerTxUrl(devnet.network, 'signature')).toBe('https://explorer.fixture.invalid/tx/signature?cluster=devnet');
    chains.setChainRegistry([devnet], devnet.network);
    expect(chains.getChains()).toHaveLength(1);
    expect(chains.getEvmChains()).toHaveLength(0);
  });

  it('rejects an absent default and unavailable RPC instead of inventing a network', () => {
    expect(() => setChainRegistry([], 'eip155:123')).toThrow('default network');
    expect(() => getNetworkRpcUrl('solana:unconfigured')).toThrow('RPC URL not configured');
  });

  it('aggregates CAIP-2 networkIds into isTestnet and isMainnet and respects NETWORK_MODE', async () => {
    const chains = await import('../../../app/src/lib/chains');
    expect(chains.TESTNET_NETWORKS).toEqual([
      'eip155:84532',
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      'eip155:42431',
    ]);
    expect(chains.MAINNET_NETWORKS).toEqual([
      'eip155:8453',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    ]);
    expect(chains.isTestnet('eip155:84532')).toBe(true);
    expect(chains.isTestnet('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(true);
    expect(chains.isTestnet('eip155:42431')).toBe(true);
    expect(chains.isTestnet('eip155:8453')).toBe(false);
    expect(chains.isMainnet('eip155:8453')).toBe(true);
    expect(chains.isMainnet('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(true);
    expect(chains.isMainnet('eip155:84532')).toBe(false);

    vi.stubEnv('NETWORK_MODE', 'mainnet');
    expect(chains.getNetworkMode()).toBe('mainnet');
    expect(chains.isMainnet()).toBe(true);
    expect(chains.isTestnet()).toBe(false);

    vi.stubEnv('NETWORK_MODE', 'testnet');
    expect(chains.getNetworkMode()).toBe('testnet');
    expect(chains.isTestnet()).toBe(true);
    expect(chains.isMainnet()).toBe(false);
  });
});

