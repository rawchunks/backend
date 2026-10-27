import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { readUser, ensureSessionPairLinked } from '../databases/users.js';
import { z } from 'zod';
import { resolveCreditAddresses } from './identity.js';
import { cacheGet, cacheSet, l1Get, singleFlight } from '../databases/cache.js';

export interface CreditIdentity {
  owner: string;
  userAddress: string;
  addresses: string[];
  promoIdentityHash?: string | null;
}

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com',
  'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com',
  'temp-mail.org', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com',
]);
const VERIFIED_AUTH_PROVIDERS = new Set([
  'google', 'github', 'discord', 'x', 'twitter', 'farcaster', 'email', 'passkey', 'apple',
]);

export function canonicalizePromoEmail(raw: string): string | null {
  const parts = raw.trim().toLowerCase().split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const domain = parts[1] === 'googlemail.com' ? 'gmail.com' : parts[1];
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return null;
  let local = parts[0].split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : null;
}

export function extractPromoIdentity(accountId: string, linkedAccounts: unknown[]): string | null {
  for (const entry of linkedAccounts) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, any>;
    const type = typeof rec.type === 'string' ? rec.type.toLowerCase() : '';
    if (!VERIFIED_AUTH_PROVIDERS.has(type)) continue;
    const details = rec.details && typeof rec.details === 'object' ? (rec.details as Record<string, any>) : rec;
    const rawEmail = typeof details.email === 'string' ? details.email : typeof rec.email === 'string' ? rec.email : '';
    if (rawEmail) {
      const email = canonicalizePromoEmail(rawEmail);
      if (!email) continue;
      return createHash('sha256').update(`email:${email}`).digest('hex');
    }
    if (type === 'email') continue;
    const subject = [details.id, details.userId, details.fid, details.username, details.credentialId, rec.id, accountId]
      .find(v => (typeof v === 'string' || typeof v === 'number') && String(v).trim().length > 0);
    if (subject) {
      return createHash('sha256').update(`${type}:${String(subject).trim().toLowerCase()}`).digest('hex');
    }
  }
  return null;
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
    ensureSessionPairLinked([pair[0].toLowerCase(), pair[1]]);
    const promoIdentityHash = extractPromoIdentity(result.data.id, result.data.linkedAccounts);
    return { owner: pair[0].toLowerCase(), userAddress, addresses: [pair[0].toLowerCase(), pair[1]], ...(promoIdentityHash ? { promoIdentityHash } : {}) };
  };
}

interface CachedTokenEntry {
  pairs: [string, string][];
  promoIdentityHash: string | null;
}

const TOKEN_L2_TTL_SEC = 15 * 60; // 15 minutes
const TOKEN_L1_TTL_MS = 15 * 60 * 1000;
const tokenCacheKey = (hash: string) => `rawchunks:id:tw:${hash}`;

function identityFromEntry(entry: CachedTokenEntry, userAddress: string): CreditIdentity | null {
  const pair = entry.pairs.find(([evm, svm]) => evm.toLowerCase() === userAddress || svm === userAddress);
  if (!pair) return null;
  return {
    owner: pair[0].toLowerCase(),
    userAddress,
    addresses: [pair[0].toLowerCase(), pair[1]],
    ...(entry.promoIdentityHash ? { promoIdentityHash: entry.promoIdentityHash } : {}),
  };
}

export function getCachedTokenIdentity(token: string, userAddress: string): CreditIdentity | null {
  const hash = createHash('sha256').update(token).digest('hex');
  const entry = l1Get<CachedTokenEntry>(tokenCacheKey(hash));
  if (!entry) return null;
  return identityFromEntry(entry, userAddress);
}

export async function getCachedTokenIdentityAsync(token: string, userAddress: string): Promise<CreditIdentity | null> {
  const hash = createHash('sha256').update(token).digest('hex');
  const entry = await cacheGet<CachedTokenEntry>(tokenCacheKey(hash), TOKEN_L1_TTL_MS);
  if (!entry) return null;
  return identityFromEntry(entry, userAddress);
}

export function verifyCachedTokenAddress(token: string, userAddress: string): boolean {
  const hash = createHash('sha256').update(token).digest('hex');
  const entry = l1Get<CachedTokenEntry>(tokenCacheKey(hash));
  if (!entry) return true;
  return entry.pairs.some(([evm, svm]) => evm.toLowerCase() === userAddress || svm === userAddress);
}

export async function authenticate(request: FastifyRequest): Promise<CreditIdentity> {
  const walletToken = request.headers['x-wallet-auth-token'];

  if (typeof walletToken === 'string' && walletToken.length > 0 && walletToken.length <= 8192 && !/\s/.test(walletToken)) {
    const userAddress = readUser(request);
    const cached = await getCachedTokenIdentityAsync(walletToken, userAddress);
    if (cached) return cached;
    const hash = createHash('sha256').update(walletToken).digest('hex');
    return singleFlight(`tw:${hash}:${userAddress}`, async () => {
      const identity = await createWalletAuthenticator({
        clientId: process.env.THIRDWEB_CLIENT_ID || '',
        resolveAddresses: resolveCreditAddresses,
      })(request);
      await cacheSet<CachedTokenEntry>(
        tokenCacheKey(hash),
        {
          pairs: [[identity.addresses[0], identity.addresses[1]]],
          promoIdentityHash: identity.promoIdentityHash ?? null,
        },
        TOKEN_L2_TTL_SEC,
        TOKEN_L1_TTL_MS,
      );
      return identity;
    });
  }

  return createWalletAuthenticator({
    clientId: process.env.THIRDWEB_CLIENT_ID || '',
    resolveAddresses: resolveCreditAddresses,
  })(request);
}
