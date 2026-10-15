import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createPublicClient, http, isAddress, parseAbi, type Address } from 'viem';

const { findSwigPda, findSwigSystemAddressPdaRaw } = createRequire(import.meta.url)('@swig-wallet/kit') as typeof import('@swig-wallet/kit');
const abi = parseAbi(['function getAddress(address admin, bytes data) view returns (address)']);

export async function resolveCreditAddresses(admin: string): Promise<[string, string]> {
  const rpc = process.env.CREDITS_IDENTITY_RPC_URL;
  const factory = process.env.CREDITS_IDENTITY_FACTORY_ADDRESS;
  if (!rpc || !factory || !isAddress(factory) || !isAddress(admin)) {
    throw new Error('Trusted smart-account configuration unavailable');
  }
  const client = createPublicClient({ transport: http(rpc, { timeout: 10000, retryCount: 0 }) });
  const smart = await client.readContract({ address: factory as Address, abi, functionName: 'getAddress', args: [admin as Address, '0x'] });
  const swigId = new Uint8Array(createHash('sha256').update(`compose.market:${admin.toLowerCase()}`).digest());
  const config = await findSwigPda(swigId);
  const [wallet] = await findSwigSystemAddressPdaRaw(config);
  return [smart.toLowerCase(), wallet.toBase58()];
}
