import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeAbiParameters, parseAbi, verifyTypedData } from 'viem';
import { x402Client } from '@x402/core/client';
import type { FacilitatorClient } from '@x402/core/server';
import type { FacilitatorEvmSigner } from '@x402/evm';
import { UptoEvmScheme as UptoClient } from '@x402/evm/upto/client';
import { UptoEvmScheme as UptoServer } from '@x402/evm/upto/server';
import { UptoEvmScheme as UptoFacilitator } from '@x402/evm/upto/facilitator';
import { BatchSettlementEvmScheme as BatchClient, InMemoryClientChannelStorage } from '@x402/evm/batch-settlement/client';
import { BatchSettlementEvmScheme as BatchServer, InMemoryChannelStorage } from '@x402/evm/batch-settlement/server';
import { BatchSettlementEvmScheme as BatchFacilitator } from '@x402/evm/batch-settlement/facilitator';
import { Store } from 'mppx';
import { upto, batch, createHandler, createResourceServer } from '../server/index.js';
import { upto as uptoClient, batch as batchClient, createClient } from '../client/index.js';
import type { Intent } from '../methods.js';

// Public, deterministic test keys. No production wallet or RPC is used.
export const payer = privateKeyToAccount(`0x${'1'.repeat(64)}`);
export const receiver = privateKeyToAccount(`0x${'2'.repeat(64)}`);
export const authorizer = privateKeyToAccount(`0x${'3'.repeat(64)}`);
export const asset = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const network = 'eip155:84532' as const;
export const url = 'https://merchant.example/generate';

export async function fixture(intent: Intent) {
  const balances = new Map<string, [bigint, bigint]>();
  const writes: { name: string; args: readonly unknown[] }[] = [];
  const reads: string[] = [];
  let verifyCalls = 0;
  let settleCalls = 0;
  let failSettle = false;
  const signer: FacilitatorEvmSigner = {
    getAddresses: () => [authorizer.address],
    async getCode({ address }) { return address.toLowerCase() === payer.address.toLowerCase() ? '0x' : '0x6000'; },
    async verifyTypedData(args) { return verifyTypedData(args as Parameters<typeof verifyTypedData>[0]); },
    async readContract({ functionName, args }) {
      reads.push(functionName);
      if (functionName === 'tryAggregate') {
        const abi = parseAbi(['function channels(bytes32) view returns (uint128,uint128)', 'function pendingWithdrawals(bytes32) view returns (uint128,uint64)', 'function refundNonce(bytes32) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function nonceBitmap(address,uint256) view returns (uint256)']);
        const calls = args?.[1] as { target: `0x${string}`; callData: `0x${string}` }[];
        return Promise.all(calls.map(async call => {
          const decoded = decodeFunctionData({ abi, data: call.callData });
          const result = await signer.readContract({ address: call.target, abi, functionName: decoded.functionName, args: decoded.args });
          const definition = abi.find(x => x.name === decoded.functionName)!;
          return { success: true, returnData: encodeAbiParameters(definition.outputs, (Array.isArray(result) ? result : [result]) as any) };
        }));
      }
      if (functionName === 'channels') return balances.get(String(args?.[0]).toLowerCase()) ?? [0n, 0n];
      if (functionName === 'pendingWithdrawals') return [0n, 0n];
      if (functionName === 'refundNonce') return 0n;
      if (functionName === 'balanceOf') return 10_000_000_000n;
      if (functionName === 'authorizationState') return false;
      if (functionName === 'allowance') return 10_000_000_000n;
      if (functionName === 'nonceBitmap') return 0n;
      if (functionName === 'settle' || functionName === 'deposit' || functionName === 'claimWithSignature') return undefined;
      if (functionName === 'receivers') return [Array.from(balances.values()).reduce((sum, value) => sum + value[1], 0n), 0n];
      throw new Error(`Unexpected contract read: ${functionName}`);
    },
    async writeContract({ functionName, args }) {
      writes.push({ name: functionName, args });
      if (functionName === 'deposit') {
        const { computeChannelId } = await import('@x402/evm/batch-settlement/client');
        const config = args[0] as Parameters<typeof computeChannelId>[0];
        const channelId = computeChannelId(config, network).toLowerCase();
        const existing = balances.get(channelId) ?? [0n, 0n];
        balances.set(channelId, [existing[0] + BigInt(String(args[1])), existing[1]]);
      }
      if (functionName === 'claimWithSignature') {
        const claims = args[0] as { voucher: { channel: Parameters<typeof import('@x402/evm/batch-settlement/client')['computeChannelId']>[0]; maxClaimableAmount: bigint }; totalClaimed: bigint }[];
        const { computeChannelId } = await import('@x402/evm/batch-settlement/client');
        for (const claim of claims) {
          const id = computeChannelId(claim.voucher.channel, network).toLowerCase();
          const current = balances.get(id)!;
          balances.set(id, [current[0], claim.voucher.maxClaimableAmount]);
        }
      }
      return `0x${writes.length.toString(16).padStart(64, '0')}`;
    },
    async sendTransaction() { throw new Error('Unexpected transaction'); },
    async waitForTransactionReceipt({ hash }) { return { status: 'success', transactionHash: hash, logs: [] }; },
  };
  const mechanism = intent === 'upto' ? new UptoFacilitator(signer) : new BatchFacilitator(signer, authorizer);
  const facilitator: FacilitatorClient = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: intent, network, extra: mechanism.getExtra(network) }], extensions: [], signers: { [network]: [authorizer.address] } }; },
    async verify(payment, requirements) { verifyCalls++; return mechanism.verify(payment, requirements); },
    async settle(payment, requirements) {
      settleCalls++;
      if (failSettle) throw new Error('Simulated lost facilitator response');
      return mechanism.settle(payment, requirements);
    },
  };
  const storage = new InMemoryChannelStorage();
  const scheme = intent === 'upto' ? new UptoServer() : new BatchServer(receiver.address, { storage, receiverAuthorizerSigner: authorizer });
  const server = createResourceServer(facilitator, [{ network, scheme }]);
  await server.initialize();
  const requirements = (await server.buildPaymentRequirements({ scheme: intent, network, payTo: receiver.address, price: { amount: '1000', asset, extra: { name: 'USDC', version: '2' } }, maxTimeoutSeconds: 300 }))[0]!;
  const store = Store.memory();
  const method = (intent === 'upto' ? upto : batch)({ server, facilitator, store, namespace: 'merchant' });
  const clientStorage = new InMemoryClientChannelStorage();
  const clientSigner = { address: payer.address, signTypedData: payer.signTypedData,
    async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
      if (functionName === 'channels') return balances.get(String(args?.[0]).toLowerCase()) ?? [0n, 0n];
      throw new Error(`Unexpected client read ${functionName}`);
    } };
  const clientScheme = intent === 'upto' ? new UptoClient(payer) : new BatchClient(clientSigner, { storage: clientStorage, payerAuthorizer: payer.address });
  const coreClient = new x402Client().register(network, clientScheme);
  const clientMethod = (intent === 'upto' ? uptoClient : batchClient)({ client: coreClient, networks: [network] });
  const offer = { requirements, resource: { url } };
  const handle = createHandler({ method, offer, store, namespace: 'merchant', realm: 'merchant.example' });
  return { signer, server, facilitator, method, clientMethod, offer, handle, store, storage, scheme, balances, clientStorage, writes, reads,
    counts: () => ({ verifyCalls, settleCalls }), failSettle: () => { failSettle = true; },
    client(work: Parameters<typeof handle>[1]) {
      const fetcher: typeof fetch = async (input, init) => handle(new Request(input, init), work);
      return createClient({ methods: [clientMethod], fetch: fetcher, maxPaymentRetries: 1 });
    },
  };
}
