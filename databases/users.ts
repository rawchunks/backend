import { userSql, songSql } from './client.js';
import type { FastifyRequest } from 'fastify';
import { getSongById } from './songs.js';

export class RequestError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}


const EVM_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SVM_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function isSvmAddress(value: string): boolean {
  if (!SVM_REGEX.test(value)) return false;
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(BASE58_ALPHABET.indexOf(character));
  let bytes = value.match(/^1*/)?.[0].length ?? 0;
  while (number > 0n) { bytes++; number >>= 8n; }
  return bytes === 32;
}
export interface WalletPair {
  evmAddress: string; svmAddress: string;
  consentedAt?: string | null; consentVersion?: string | null; consentSignature?: string | null;
  consentMessage?: string | null; consentMetadata?: Record<string, unknown> | null;
  nickname?: string | null; avatar?: string | null;
  guidesSeen?: string[];
}
export interface UserConsentRecord {
  evmAddress: string; svmAddress: string; policyVersion: string; signature: string; message: string;
  metadata?: Record<string, unknown>; signedAt: string;
}
export interface RecordConsentInput {
  address: string; svmAddress?: string; disclaimerType?: string; policyVersion?: string;
  signature: string; message?: string; metadata?: Record<string, unknown>; chainId?: number;
}
export interface ConsentLookupQuery { address: string; disclaimerType?: string; policyVersion?: string }
export function parseAddress(raw: unknown): { kind: 'evm' | 'svm'; value: string } {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Invalid wallet address');
  const clean = raw.trim();
  if (EVM_REGEX.test(clean)) return { kind: 'evm', value: clean.toLowerCase() };
  const svm = clean.startsWith('svm:') ? clean.slice(4) : clean;
  if (isSvmAddress(svm)) return { kind: 'svm', value: svm };
  throw new Error('Invalid wallet address');
}
function pairFromRow(row: any): WalletPair | null {
  if (!row) return null;
  const evm = parseAddress(row.evm_address);
  if (evm.kind !== 'evm') throw new Error('Invalid wallet pair');
  return {
    evmAddress: evm.value,
    svmAddress: row.svm_address ?? '',
    consentedAt: row.consented_at ? new Date(row.consented_at).toISOString() : null,
    consentVersion: row.consent_version ?? null,
    consentSignature: row.consent_signature ?? null,
    consentMessage: row.consent_message ?? null,
    consentMetadata: row.consent_metadata ?? null,
    nickname: row.nickname ?? null,
    avatar: row.avatar ?? null,
    guidesSeen: Array.isArray(row.guides_seen)
      ? row.guides_seen.filter((item: unknown): item is string => typeof item === 'string')
      : [],
  };
}
function consentFromRow(row: any): UserConsentRecord | null {
  if (!row?.consented_at || !row.consent_signature || !row.consent_version) return null;
  const pair = pairFromRow(row);
  return pair ? { evmAddress: pair.evmAddress, svmAddress: pair.svmAddress, policyVersion: row.consent_version, signature: row.consent_signature, message: row.consent_message, metadata: row.consent_metadata ?? undefined, signedAt: new Date(row.consented_at).toISOString() } : null;
}

export interface UpdateProfileInput {
  address: string;
  nickname?: string | null;
  avatar?: string | null;
  svmAddress?: string | null;
}

export async function updateProfile(input: UpdateProfileInput): Promise<WalletPair> {
  const parsed = parseAddress(input.address);
  const nickname = input.nickname !== undefined ? (input.nickname ? input.nickname.trim() : null) : undefined;
  const avatar = input.avatar !== undefined ? (input.avatar ? input.avatar.trim() : null) : undefined;

  let existing = await getWalletPair(parsed.value);
  if (existing) {
    const rows = await userSql`
      UPDATE public.wallet_pairs
      SET
        nickname = COALESCE(${nickname !== undefined ? nickname : null}, nickname),
        avatar = COALESCE(${avatar !== undefined ? avatar : null}, avatar)
      WHERE evm_address = ${existing.evmAddress}
      RETURNING *
    `;
    const pair = pairFromRow(rows[0]);
    if (!pair) throw new RequestError('Failed to update profile');
    return pair;
  } else {
    if (parsed.kind === 'evm') {
      const svm = input.svmAddress ? parseAddress(input.svmAddress).value : null;
      const rows = await userSql`
        INSERT INTO public.wallet_pairs (evm_address, svm_address, nickname, avatar)
        VALUES (${parsed.value}, ${svm}, ${nickname ?? null}, ${avatar ?? null})
        ON CONFLICT (evm_address) DO UPDATE SET
          nickname = COALESCE(EXCLUDED.nickname, wallet_pairs.nickname),
          avatar = COALESCE(EXCLUDED.avatar, wallet_pairs.avatar)
        RETURNING *
      `;
      const pair = pairFromRow(rows[0]);
      if (!pair) throw new RequestError('Failed to create profile');
      return pair;
    } else {
      const rows = await userSql`
        SELECT * FROM public.wallet_pairs WHERE svm_address = ${parsed.value} LIMIT 1
      `;
      if (rows[0]) {
        const updated = await userSql`
          UPDATE public.wallet_pairs
          SET
            nickname = COALESCE(${nickname !== undefined ? nickname : null}, nickname),
            avatar = COALESCE(${avatar !== undefined ? avatar : null}, avatar)
          WHERE svm_address = ${parsed.value}
          RETURNING *
        `;
        const pair = pairFromRow(updated[0]);
        if (!pair) throw new RequestError('Failed to update profile');
        return pair;
      }
      throw new RequestError('EVM address required to initialize profile');
    }
  }
}

export async function putWalletPair(input: {
  evmAddress: string;
  svmAddress: string;
  nickname?: string | null;
  avatar?: string | null;
}): Promise<WalletPair> {
  const evm = parseAddress(input.evmAddress), svm = parseAddress(input.svmAddress);
  if (evm.kind !== 'evm' || svm.kind !== 'svm') throw new Error('evmAddress must be EVM (0x...) and svmAddress must be Solana base58');
  // Completing an EVM-only or legacy pending pair retains its signed policy.
  const rows = await userSql`
    INSERT INTO public.wallet_pairs (evm_address, svm_address, nickname, avatar)
    VALUES (${evm.value}, ${svm.value}, ${input.nickname ?? null}, ${input.avatar ?? null})
    ON CONFLICT (evm_address) DO UPDATE SET
      svm_address = EXCLUDED.svm_address,
      nickname = COALESCE(EXCLUDED.nickname, wallet_pairs.nickname),
      avatar = COALESCE(EXCLUDED.avatar, wallet_pairs.avatar),
      consented_at = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND LEFT(wallet_pairs.svm_address, 12) <> 'svm_pending_' AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consented_at END,
      consent_version = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND LEFT(wallet_pairs.svm_address, 12) <> 'svm_pending_' AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consent_version END,
      consent_signature = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND LEFT(wallet_pairs.svm_address, 12) <> 'svm_pending_' AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consent_signature END,
      consent_message = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND LEFT(wallet_pairs.svm_address, 12) <> 'svm_pending_' AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consent_message END,
      consent_metadata = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND LEFT(wallet_pairs.svm_address, 12) <> 'svm_pending_' AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consent_metadata END
    RETURNING *
  `;
  const pair = pairFromRow(rows[0]);
  if (!pair) throw new Error('Failed to create or update wallet pair');
  return pair;
}
export async function getWalletPair(rawAddress: string): Promise<WalletPair | null> {
  const parsed = parseAddress(rawAddress);
  const rows = parsed.kind === 'evm'
    ? await userSql`SELECT * FROM public.wallet_pairs WHERE evm_address = ${parsed.value} LIMIT 1`
    : await userSql`SELECT * FROM public.wallet_pairs WHERE svm_address = ${parsed.value} LIMIT 1`;
  return pairFromRow(rows[0]);
}
export async function putUserConsent(input: RecordConsentInput): Promise<UserConsentRecord> {
  const parsed = parseAddress(input.address);
  if (!input.signature?.trim() || input.signature === '0x' || !input.message?.trim()) throw new RequestError('A signature and signed message are required');
  let pair = await getWalletPair(parsed.value);
  if (!pair && parsed.kind === 'evm' && !input.svmAddress) pair = await updateProfile({ address: parsed.value });
  if (!pair?.svmAddress && input.svmAddress) {
    const evm = parseAddress(parsed.kind === 'evm' ? parsed.value : input.metadata?.evmAddress);
    const svm = parseAddress(input.svmAddress);
    if (evm.kind !== 'evm' || svm.kind !== 'svm' || parsed.value !== evm.value && parsed.value !== svm.value) throw new RequestError('Invalid wallet pair');
    pair = await putWalletPair({ evmAddress: evm.value, svmAddress: svm.value });
  }
  if (!pair || input.svmAddress && input.svmAddress !== pair.svmAddress) throw new RequestError('Wallet pair not found');
  const version = input.policyVersion ?? '1.0.0';
  const metadata = JSON.stringify({ ...input.metadata, disclaimerType: input.disclaimerType });
  const updated = await userSql`
    UPDATE public.wallet_pairs SET consented_at = NOW(), consent_version = ${version},
      consent_signature = ${input.signature}, consent_message = ${input.message}, consent_metadata = ${metadata}::jsonb
    WHERE evm_address = ${pair.evmAddress} AND svm_address IS NOT DISTINCT FROM ${pair.svmAddress || null} RETURNING *
  `;
  const record = consentFromRow(updated[0]);
  if (!record) throw new RequestError('Account pair changed while recording consent', 409);
  return record;
}

export async function getUserConsent(lookup: ConsentLookupQuery | string): Promise<UserConsentRecord | null> {
  const parsed = parseAddress(typeof lookup === 'string' ? lookup : lookup.address);
  const rows = await userSql`SELECT * FROM public.wallet_pairs WHERE evm_address = ${parsed.value} OR svm_address = ${parsed.value} LIMIT 1`;
  const record = consentFromRow(rows[0]);
  if (!record) return null;
  const version = typeof lookup === 'object' ? lookup.policyVersion : undefined;
  const type = typeof lookup === 'object' ? lookup.disclaimerType : undefined;
  return (!version || record.policyVersion === version) && (!type || !record.metadata?.disclaimerType || record.metadata.disclaimerType === type) ? record : null;
}
export async function checkUserConsent(address: string): Promise<{ hasConsented: boolean; evmAddress?: string | null; svmAddress?: string | null; record: UserConsentRecord | null }> {
  if (!address) return { hasConsented: false, record: null };
  const record = await getUserConsent(address);
  return { hasConsented: Boolean(record), evmAddress: record?.evmAddress ?? null, svmAddress: record?.svmAddress ?? null, record };
}

export async function getUserGuides(rawAddress: string): Promise<string[]> {
  const parsed = parseAddress(rawAddress);
  const rows = parsed.kind === 'evm'
    ? await userSql`SELECT guides_seen FROM public.wallet_pairs WHERE evm_address = ${parsed.value} LIMIT 1`
    : await userSql`SELECT guides_seen FROM public.wallet_pairs WHERE svm_address = ${parsed.value} LIMIT 1`;
  const raw = rows[0]?.guides_seen;
  return Array.isArray(raw) ? raw.filter((item: unknown): item is string => typeof item === 'string') : [];
}

export async function putUserGuides(input: {
  address: string;
  svmAddress?: string | null;
  guides: string[];
}): Promise<string[]> {
  const parsed = parseAddress(input.address);
  const incoming = Array.from(new Set((input.guides || []).map(item => String(item).trim()).filter(Boolean)));
  let existing = await getWalletPair(parsed.value);
  if (!existing && parsed.kind === 'evm') {
    existing = await updateProfile({ address: parsed.value, svmAddress: input.svmAddress ?? null });
  }
  if (!existing) throw new RequestError('Wallet pair not found', 404);
  const merged = Array.from(new Set([...(existing.guidesSeen ?? []), ...incoming]));
  const serialized = JSON.stringify(merged);
  await userSql`
    UPDATE public.wallet_pairs
    SET guides_seen = ${serialized}::jsonb
    WHERE evm_address = ${existing.evmAddress}
  `;
  return merged;
}

export function readUser(request: FastifyRequest): string {
  const value = (request.headers['x-session-user-address'] as string | undefined)
    || (request.headers['x-user-address'] as string | undefined)
    || (request.headers['x-account-address'] as string | undefined)
    || (request.query as Record<string, string>)?.userAddress;
  if (value === undefined) throw new RequestError('userAddress header is required');
  try { return parseAddress(value).value; }
  catch { throw new RequestError('Invalid userAddress header'); }
}
export async function checkUser(userAddress: string, raw: string): Promise<void> {
  let value: string;
  try { value = parseAddress(raw).value; }
  catch { throw new RequestError('Invalid userAddress'); }
  if (value === userAddress) return;
  try {
    const pair = await getWalletPair(userAddress);
    if (pair && (value === pair.svmAddress || value === parseAddress(pair.evmAddress).value)) {
      return;
    }
    const targetPair = await getWalletPair(value);
    if (targetPair && (userAddress === targetPair.svmAddress || userAddress === parseAddress(targetPair.evmAddress).value)) {
      return;
    }
  } catch {}
  throw new RequestError('userAddress does not match this resource', 403);
}
export async function readSong(request: FastifyRequest, songId: string) {
  const song = await getSongById(songId);
  if (!song) throw new RequestError('Song not found', 404);
  let userAddress: string;
  try {
    userAddress = readUser(request);
  } catch (err) {
    if (request.method === 'GET' && song.creator) {
      userAddress = song.creator;
    } else {
      throw err;
    }
  }
  await checkUser(userAddress, song.creator);
  return { userAddress, song };
}
export async function readTake(request: FastifyRequest, takeId: string, songId?: string) {
  readUser(request);
  const rows = await songSql`SELECT song_id FROM takes WHERE id = ${takeId} LIMIT 1`;
  if (!rows[0] || songId && rows[0].song_id !== songId) throw new RequestError('Take not found', 404);
  return readSong(request, rows[0].song_id);
}
