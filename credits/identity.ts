import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createPublicClient, http, isAddress, parseAbi, type Address } from 'viem';
import { cached } from '../databases/cache.js';
import { getWalletPair } from '../databases/users.js';
import { getFacilitatorChains } from '../broker/payment.js';

const { findSwigPda, findSwigSystemAddressPdaRaw } = createRequire(import.meta.url)('@swig-wallet/kit') as typeof import('@swig-wallet/kit');
const abi = parseAbi(['function getAddress(address admin, bytes data) view returns (address)']);

const AA_L2_TTL_SEC = 30 * 24 * 3600; // 30 days (smart account derivation is deterministic)
const AA_L1_TTL_MS = 24 * 3600 * 1000; // 24 hours

export async function resolveCreditAddresses(admin: string): Promise<[string, string]> {
  const factory = process.env.CREDITS_IDENTITY_FACTORY_ADDRESS;
  if (!factory || !isAddress(factory) || !isAddress(admin)) {
    throw new Error('Trusted smart-account configuration unavailable');
  }
  const cacheKey = `id:aa:${factory.toLowerCase()}:${admin.toLowerCase()}`;
  return cached<[string, string]>(cacheKey, AA_L2_TTL_SEC, AA_L1_TTL_MS, async () => {
    const swigId = new Uint8Array(createHash('sha256').update(`compose.market:${admin.toLowerCase()}`).digest());
    const config = await findSwigPda(swigId);
    const [wallet] = await findSwigSystemAddressPdaRaw(config);
    const svmAddress = wallet.toBase58();
    const existingPair = await getWalletPair(svmAddress).catch(() => null);
    if (existingPair?.evmAddress) {
      return [existingPair.evmAddress.toLowerCase(), svmAddress];
    }
    const chains = await getFacilitatorChains();
    const evmChain = chains.find((chain) => chain.namespace === 'eip155' && Boolean(chain.rpcUrl));
    if (!evmChain?.rpcUrl) {
      throw new Error('Trusted smart-account RPC unavailable');
    }
    const client = createPublicClient({ transport: http(evmChain.rpcUrl, { timeout: 4000, retryCount: 0 }) });
    const smart = await client.readContract({ address: factory as Address, abi, functionName: 'getAddress', args: [admin as Address, '0x'] });
    return [smart.toLowerCase(), svmAddress];
  });
}
