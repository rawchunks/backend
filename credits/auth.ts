import type { FastifyRequest } from 'fastify';
import { readUser } from '../databases/users.js';
import { z } from 'zod';
import { resolveCreditAddresses } from './identity.js';

export interface CreditIdentity {
  owner: string;
  userAddress: string;
  addresses: string[];
}

export interface WalletAuthOptions {
  clientId: string;
  resolveAddresses: (admin: string) => Promise<[string, string]>;
  fetch?: typeof fetch;
}

const providerResponse = z.object({
  id: z.string().min(1),
  linkedAccounts: z.array(z.unknown()),
  wallets: z.array(z.object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    type: z.enum(['enclave', 'sharded']),
    createdAt: z.string(),
  })).min(1).max(20),
});

function failure(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

export function createWalletAuthenticator(options: WalletAuthOptions) {
  return async (request: FastifyRequest): Promise<CreditIdentity> => {
    const token = request.headers['x-wallet-auth-token'];
    if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token)) {
      throw failure('Wallet authentication required', 401);
    }
    const userAddress = readUser(request);
    if (!options.clientId) throw failure('Wallet verification unavailable', 503);
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)('https://embedded-wallet.thirdweb.com/api/2024-05-05/accounts', {
        method: 'GET',
        headers: {
          Authorization: `Bearer embedded-wallet-token:${token}`,
          'x-client-id': options.clientId,
        },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw failure('Wallet verification unavailable', 503);
    }
    if (response.status === 401 || response.status === 403) {
      throw failure('Invalid wallet authentication', 401);
    }
    if (!response.ok) throw failure('Wallet verification unavailable', 503);
    const result = providerResponse.safeParse(await response.json().catch(() => null));
    if (!result.success) throw failure('Invalid wallet verification response', 503);
    const admins = [...new Set(result.data.wallets.map(wallet => wallet.address.toLowerCase()))];
    let addresses: [string, string][];
    try {
      addresses = await Promise.all(admins.map(options.resolveAddresses));
    } catch {
      throw failure('Smart-account verification unavailable', 503);
    }
    const pair = addresses.find(([evm, svm]) => evm.toLowerCase() === userAddress || svm === userAddress);
    if (!pair) throw failure('userAddress does not belong to authenticated wallet', 403);
    return { owner: pair[0].toLowerCase(), userAddress, addresses: [pair[0].toLowerCase(), pair[1]] };
  };
}

export async function authenticate(request: FastifyRequest): Promise<CreditIdentity> {
  return createWalletAuthenticator({
    clientId: process.env.THIRDWEB_CLIENT_ID || '',
    resolveAddresses: resolveCreditAddresses,
  })(request);
}
