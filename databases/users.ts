import { randomUUID } from 'node:crypto';
import { userSql, songSql } from './client.js';
import type { FastifyRequest } from 'fastify';
import { getSongById } from './songs.js';
import { verifyCachedTokenAddress } from '../credits/auth.js';
import { cacheGet, cacheMGet, cacheSet, singleFlight } from './cache.js';

export const STARTER_SONG_ID = 'sng-95ee3b8a-e8a0-4f6d-bef4-69bac7528e35';

const PAIR_L2_TTL_SEC = 3600;
const PAIR_L1_TTL_MS = 300_000;
const pairCacheKey = (addr: string) => `rawchunks:id:pair:${addr}`;

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
  evmAddress: string;
  svmAddress: string;
  consentedAt?: string | null;
  consentVersion?: string | null;
  consentSignature?: string | null;
  consentMessage?: string | null;
  consentMetadata?: Record<string, unknown> | null;
  nickname?: string | null;
  avatar?: string | null;
  bio?: string | null;
  guidesSeen?: string[];
}

export interface UserConsentRecord {
  evmAddress: string;
  svmAddress: string;
  policyVersion: string;
  signature: string;
  message: string;
  metadata?: Record<string, unknown>;
  signedAt: string;
}

export interface RecordConsentInput {
  address: string;
  svmAddress?: string;
  disclaimerType?: string;
  policyVersion?: string;
  signature: string;
  message?: string;
  metadata?: Record<string, unknown>;
  chainId?: number;
}

export interface ConsentLookupQuery {
  address: string;
  disclaimerType?: string;
  policyVersion?: string;
}

export function parseAddress(raw: unknown): { kind: 'evm' | 'svm'; value: string } {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Invalid wallet address');
  const clean = raw.trim();
  if (EVM_REGEX.test(clean)) return { kind: 'evm', value: clean.toLowerCase() };
  const svm = clean.startsWith('svm:') ? clean.slice(4) : clean;
  if (isSvmAddress(svm)) return { kind: 'svm', value: svm };
  throw new Error('Invalid wallet address');
}

async function cachePair(pair: WalletPair): Promise<void> {
  const writes: Promise<void>[] = [];
  if (pair.evmAddress) {
    writes.push(cacheSet(pairCacheKey(pair.evmAddress.toLowerCase()), pair, PAIR_L2_TTL_SEC, PAIR_L1_TTL_MS));
  }
  if (pair.svmAddress) {
    writes.push(cacheSet(pairCacheKey(pair.svmAddress), pair, PAIR_L2_TTL_SEC, PAIR_L1_TTL_MS));
  }
  if (writes.length > 0) {
    await Promise.all(writes);
  }
}

function pairFromRow(row: any): WalletPair | null {
  if (!row) return null;
  const evm = row.evm_address ? parseAddress(row.evm_address) : null;
  const svm = row.svm_address ? parseAddress(row.svm_address) : null;
  if ((evm && evm.kind !== 'evm') || (svm && svm.kind !== 'svm') || (!evm && !svm)) {
    throw new Error('Invalid wallet pair');
  }
  return {
    evmAddress: evm?.value ?? '',
    svmAddress: svm?.value ?? '',
    consentedAt: row.consented_at ? new Date(row.consented_at).toISOString() : null,
    consentVersion: row.consent_version ?? null,
    consentSignature: row.consent_signature ?? null,
    consentMessage: row.consent_message ?? null,
    consentMetadata: row.consent_metadata ?? null,
    nickname: row.nickname ?? null,
    avatar: row.avatar ?? null,
    bio: row.bio ?? null,
    guidesSeen: Array.isArray(row.guides_seen)
      ? row.guides_seen.filter((item: unknown): item is string => typeof item === 'string')
      : [],
  };
}

function consentFromPair(pair: WalletPair | null): UserConsentRecord | null {
  if (!pair?.consentedAt || !pair.consentSignature || !pair.consentVersion) return null;
  return {
    evmAddress: pair.evmAddress,
    svmAddress: pair.svmAddress,
    policyVersion: pair.consentVersion,
    signature: pair.consentSignature,
    message: pair.consentMessage ?? '',
    metadata: pair.consentMetadata ?? undefined,
    signedAt: pair.consentedAt,
  };
}

function remapJsonIds(value: unknown, idMap: Map<string, string>): unknown {
  if (!value || idMap.size === 0) return value;
  let serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [oldId, newId] of idMap.entries()) {
    if (oldId && oldId !== newId) {
      serialized = serialized.split(oldId).join(newId);
    }
  }
  try {
    return JSON.parse(serialized);
  } catch {
    return value;
  }
}

export async function seedStarterSongForNewUser(rawAddress: string): Promise<void> {
  try {
    if (typeof songSql !== 'function') return;
    const normalized = parseAddress(rawAddress).value;

    const templateRows = await songSql`SELECT * FROM songs WHERE id = ${STARTER_SONG_ID} LIMIT 1`;
    if (!Array.isArray(templateRows) || !templateRows[0]) return;
    const template = templateRows[0];
    if (String(template.creator ?? '').trim().toLowerCase() === normalized.toLowerCase()) return;

    const newSongId = `sng-${randomUUID()}`;
    const tagsJson = JSON.stringify(Array.isArray(template.tags) ? template.tags : []);
    const insertedSongs = await songSql`
      INSERT INTO songs (
        id, title, family, basis, creator, source, version, url, duration, tags,
        licenses, stream_price, license_price, network, image, album_id, public, metadata_cid
      )
      SELECT
        ${newSongId},
        ${template.title ?? 'Playground'},
        NULL,
        NULL,
        ${normalized},
        ${template.source ?? null},
        1,
        ${template.url},
        ${template.duration != null ? Number(template.duration) : null},
        ${tagsJson}::jsonb,
        ${Number(template.licenses ?? 0)},
        ${Number(template.stream_price ?? 0.01)},
        ${Number(template.license_price ?? 5)},
        ${template.network ?? null},
        ${template.image ?? null},
        NULL,
        false,
        NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM songs WHERE creator = ${normalized}
      )
      RETURNING id
    `;
    if (!Array.isArray(insertedSongs) || !insertedSongs[0]) return;

    const stems = await songSql`SELECT * FROM stems WHERE song_id = ${STARTER_SONG_ID} ORDER BY created_at ASC`;
    const takes = await songSql`SELECT * FROM takes WHERE song_id = ${STARTER_SONG_ID} ORDER BY created_at ASC`;
    const commits = await songSql`SELECT * FROM commits WHERE song_id = ${STARTER_SONG_ID} ORDER BY created_at ASC`;

    const idMap = new Map<string, string>([
      [STARTER_SONG_ID, newSongId],
      [String(template.creator ?? ''), normalized],
    ]);

    const stemRows = Array.isArray(stems) ? stems : [];
    const takeRows = Array.isArray(takes) ? takes : [];
    const commitRows = Array.isArray(commits) ? commits : [];

    for (const stem of stemRows) {
      idMap.set(String(stem.id), `stm-${stem.name ?? 'master'}-${randomUUID()}`);
    }
    for (const take of takeRows) {
      idMap.set(String(take.id), `take-${randomUUID()}`);
    }
    for (const commit of commitRows) {
      idMap.set(String(commit.id), `cmt-${randomUUID()}`);
    }

    for (const stem of stemRows) {
      const newStemId = idMap.get(String(stem.id))!;
      await songSql`
        INSERT INTO stems (
          id, song_id, name, url, waveform_peaks_url, volume, pan, is_muted, is_solo
        ) VALUES (
          ${newStemId},
          ${newSongId},
          ${stem.name},
          ${stem.url},
          ${stem.waveform_peaks_url ?? null},
          ${Number(stem.volume ?? 1.0)},
          ${Number(stem.pan ?? 0.0)},
          ${Boolean(stem.is_muted)},
          ${Boolean(stem.is_solo)}
        )
      `;
    }

    for (const take of takeRows) {
      const newTakeId = idMap.get(String(take.id))!;
      const mappedStemId = take.stem_id ? (idMap.get(String(take.stem_id)) ?? null) : null;
      const mappedProvenance = take.provenance
        ? JSON.stringify(remapJsonIds(take.provenance, idMap))
        : null;
      await songSql`
        INSERT INTO takes (
          id, song_id, stem_id, take_number, model, task, prompt, lyrics,
          repainting_start, repainting_end, url, waveform_url, is_active, seed, provenance
        ) VALUES (
          ${newTakeId},
          ${newSongId},
          ${mappedStemId},
          ${Number(take.take_number ?? 1)},
          ${take.model},
          ${take.task},
          ${take.prompt ?? null},
          ${take.lyrics ?? null},
          ${take.repainting_start != null ? Number(take.repainting_start) : null},
          ${take.repainting_end != null ? Number(take.repainting_end) : null},
          ${take.url},
          ${take.waveform_url ?? null},
          ${Boolean(take.is_active)},
          ${take.seed != null ? Number(take.seed) : null},
          ${mappedProvenance}::jsonb
        )
      `;
    }

    for (const commit of commitRows) {
      const newCommitId = idMap.get(String(commit.id))!;
      const mappedParentCommitId = commit.parent_commit_id
        ? (idMap.get(String(commit.parent_commit_id)) ?? null)
        : null;
      const mappedSnapshot = JSON.stringify(remapJsonIds(commit.timeline_snapshot ?? {}, idMap));
      await songSql`
        INSERT INTO commits (
          id, song_id, user_address, parent_commit_id, message, timeline_snapshot
        ) VALUES (
          ${newCommitId},
          ${newSongId},
          ${normalized},
          ${mappedParentCommitId},
          ${commit.message ?? 'Initial playground state'},
          ${mappedSnapshot}::jsonb
        )
      `;
    }
  } catch {
    // Non-fatal: starter song seeding should never block account creation
  }
}

export interface UpdateProfileInput {
  address: string;
  nickname?: string | null;
  avatar?: string | null;
  bio?: string | null;
  svmAddress?: string | null;
  evmAddress?: string | null;
}

export async function updateProfile(input: UpdateProfileInput): Promise<WalletPair> {
  const parsed = parseAddress(input.address);
  const nickname = input.nickname !== undefined ? (input.nickname ? input.nickname.trim() : null) : undefined;
  const avatar = input.avatar !== undefined ? (input.avatar ? input.avatar.trim() : null) : undefined;
  const hasBio = input.bio !== undefined;
  const bio = hasBio ? (input.bio ? input.bio.trim().slice(0, 280) : null) : null;

  const existing = await getWalletPair(parsed.value);
  if (existing) {
    const nextSvm = input.svmAddress && !existing.svmAddress ? parseAddress(input.svmAddress).value : null;
    const nextEvm = input.evmAddress && !existing.evmAddress ? parseAddress(input.evmAddress).value : null;
    const rows = existing.evmAddress
      ? await userSql`
          UPDATE public.wallet_pairs
          SET
            svm_address = COALESCE(${nextSvm}, svm_address),
            nickname = COALESCE(${nickname !== undefined ? nickname : null}, nickname),
            avatar = COALESCE(${avatar !== undefined ? avatar : null}, avatar),
            bio = CASE WHEN ${hasBio} THEN ${bio} ELSE bio END
          WHERE evm_address = ${existing.evmAddress}
          RETURNING *
        `
      : await userSql`
          UPDATE public.wallet_pairs
          SET
            evm_address = COALESCE(${nextEvm}, evm_address),
            nickname = COALESCE(${nickname !== undefined ? nickname : null}, nickname),
            avatar = COALESCE(${avatar !== undefined ? avatar : null}, avatar),
            bio = CASE WHEN ${hasBio} THEN ${bio} ELSE bio END
          WHERE svm_address = ${existing.svmAddress}
          RETURNING *
        `;
    const pair = pairFromRow(rows[0]);
    if (!pair) throw new RequestError('Failed to update profile');
    await cachePair(pair);
    return pair;
  }

  if (parsed.kind === 'evm') {
    const svm = input.svmAddress ? parseAddress(input.svmAddress).value : null;
    const rows = await userSql`
      INSERT INTO public.wallet_pairs (evm_address, svm_address, nickname, avatar, bio)
      VALUES (${parsed.value}, ${svm}, ${nickname ?? null}, ${avatar ?? null}, ${bio ?? null})
      ON CONFLICT (evm_address) DO UPDATE SET
        svm_address = COALESCE(wallet_pairs.svm_address, EXCLUDED.svm_address),
        nickname = COALESCE(EXCLUDED.nickname, wallet_pairs.nickname),
        avatar = COALESCE(EXCLUDED.avatar, wallet_pairs.avatar),
        bio = CASE WHEN ${hasBio} THEN EXCLUDED.bio ELSE wallet_pairs.bio END
      RETURNING *
    `;
    const pair = pairFromRow(rows[0]);
    if (!pair) throw new RequestError('Failed to create profile');
    await cachePair(pair);
    await seedStarterSongForNewUser(pair.evmAddress);
    return pair;
  } else {
    const evm = input.evmAddress ? parseAddress(input.evmAddress).value : null;
    const rows = await userSql`
      INSERT INTO public.wallet_pairs (evm_address, svm_address, nickname, avatar, bio)
      VALUES (${evm}, ${parsed.value}, ${nickname ?? null}, ${avatar ?? null}, ${bio ?? null})
      ON CONFLICT (svm_address) DO UPDATE SET
        evm_address = COALESCE(wallet_pairs.evm_address, EXCLUDED.evm_address),
        nickname = COALESCE(EXCLUDED.nickname, wallet_pairs.nickname),
        avatar = COALESCE(EXCLUDED.avatar, wallet_pairs.avatar),
        bio = CASE WHEN ${hasBio} THEN EXCLUDED.bio ELSE wallet_pairs.bio END
      RETURNING *
    `;
    const pair = pairFromRow(rows[0]);
    if (!pair) throw new RequestError('Failed to create profile');
    await cachePair(pair);
    await seedStarterSongForNewUser(pair.evmAddress || pair.svmAddress);
    return pair;
  }
}

export async function putWalletPair(input: {
  evmAddress?: string | null;
  svmAddress?: string | null;
  nickname?: string | null;
  avatar?: string | null;
}): Promise<WalletPair> {
  const hasEvm = typeof input.evmAddress === 'string' && input.evmAddress.trim().length > 0;
  const hasSvm = typeof input.svmAddress === 'string' && input.svmAddress.trim().length > 0;
  if (!hasEvm && !hasSvm) {
    throw new Error('At least one wallet address (evmAddress or svmAddress) is required');
  }
  const evm = hasEvm ? parseAddress(input.evmAddress) : null;
  const svm = hasSvm ? parseAddress(input.svmAddress) : null;
  if ((evm && evm.kind !== 'evm') || (svm && svm.kind !== 'svm')) {
    throw new Error('evmAddress must be EVM (0x...) and svmAddress must be Solana base58');
  }

  let rows: any[];
  if (evm && svm) {
    rows = await userSql`
      INSERT INTO public.wallet_pairs (evm_address, svm_address, nickname, avatar)
      VALUES (${evm.value}, ${svm.value}, ${input.nickname ?? null}, ${input.avatar ?? null})
      ON CONFLICT (evm_address) DO UPDATE SET
        svm_address = EXCLUDED.svm_address,
        nickname = COALESCE(EXCLUDED.nickname, wallet_pairs.nickname),
        avatar = COALESCE(EXCLUDED.avatar, wallet_pairs.avatar),
        consented_at = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consented_at END,
        consent_version = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consent_version END,
        consent_signature = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consent_signature END,
        consent_message = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consent_message END,
        consent_metadata = CASE WHEN wallet_pairs.svm_address IS NOT NULL AND wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address THEN NULL ELSE wallet_pairs.consent_metadata END
      RETURNING *
    `;
  } else if (evm) {
    rows = await userSql`
      INSERT INTO public.wallet_pairs (evm_address, svm_address, nickname, avatar)
      VALUES (${evm.value}, NULL, ${input.nickname ?? null}, ${input.avatar ?? null})
      ON CONFLICT (evm_address) DO UPDATE SET
        nickname = COALESCE(EXCLUDED.nickname, wallet_pairs.nickname),
        avatar = COALESCE(EXCLUDED.avatar, wallet_pairs.avatar)
      RETURNING *
    `;
  } else {
    rows = await userSql`
      INSERT INTO public.wallet_pairs (evm_address, svm_address, nickname, avatar)
      VALUES (NULL, ${svm!.value}, ${input.nickname ?? null}, ${input.avatar ?? null})
      ON CONFLICT (svm_address) DO UPDATE SET
        nickname = COALESCE(EXCLUDED.nickname, wallet_pairs.nickname),
        avatar = COALESCE(EXCLUDED.avatar, wallet_pairs.avatar)
      RETURNING *
    `;
  }

  const pair = pairFromRow(rows[0]);
  if (!pair) throw new Error('Failed to create or update wallet pair');
  await cachePair(pair);
  if (!pair.consentedAt) {
    await seedStarterSongForNewUser(pair.evmAddress || pair.svmAddress);
  }
  return pair;
}

export async function getWalletPair(rawAddress: string): Promise<WalletPair | null> {
  const parsed = parseAddress(rawAddress);
  const key = pairCacheKey(parsed.value);
  const hit = await cacheGet<WalletPair>(key, PAIR_L1_TTL_MS);
  if (hit !== undefined) return hit;

  return singleFlight(`sf:${key}`, async () => {
    const rows = parsed.kind === 'evm'
      ? await userSql`SELECT * FROM public.wallet_pairs WHERE evm_address = ${parsed.value} LIMIT 1`
      : await userSql`SELECT * FROM public.wallet_pairs WHERE svm_address = ${parsed.value} LIMIT 1`;
    const pair = pairFromRow(rows[0]);
    if (pair) {
      await cachePair(pair);
    }
    return pair;
  });
}

export async function resolveIdentityAddresses(rawAddress: string): Promise<string[]> {
  const parsed = parseAddress(rawAddress);
  const addresses = [parsed.value];
  const pair = await getWalletPair(parsed.value);
  if (pair) {
    if (pair.evmAddress && !addresses.includes(pair.evmAddress)) addresses.push(pair.evmAddress);
    if (pair.svmAddress && !addresses.includes(pair.svmAddress)) addresses.push(pair.svmAddress);
  }
  return addresses;
}

export async function getWalletPairsByAddresses(rawAddresses: string[]): Promise<WalletPair[]> {
  const parsedList: Array<{ kind: 'evm' | 'svm'; value: string }> = [];
  const seenAddr = new Set<string>();
  for (const raw of rawAddresses) {
    try {
      const parsed = parseAddress(raw);
      if (!seenAddr.has(parsed.value)) {
        seenAddr.add(parsed.value);
        parsedList.push(parsed);
      }
    } catch { }
  }
  if (parsedList.length === 0) return [];

  const keys = parsedList.map(p => pairCacheKey(p.value));
  const cachedMap = await cacheMGet<WalletPair>(keys, PAIR_L1_TTL_MS);

  const resultByIdentity = new Map<string, WalletPair>();
  const addPair = (pair: WalletPair) => {
    const idKey = `${pair.evmAddress}:${pair.svmAddress}`;
    resultByIdentity.set(idKey, pair);
  };

  const missingEvm: string[] = [];
  const missingSvm: string[] = [];
  for (const p of parsedList) {
    const hit = cachedMap.get(pairCacheKey(p.value));
    if (hit) {
      addPair(hit);
    } else if (p.kind === 'evm') {
      missingEvm.push(p.value);
    } else {
      missingSvm.push(p.value);
    }
  }

  if (missingEvm.length > 0 || missingSvm.length > 0) {
    const rows = await userSql`
      SELECT * FROM public.wallet_pairs
      WHERE evm_address = ANY(${missingEvm}) OR svm_address = ANY(${missingSvm})
    `;
    const cacheWrites: Promise<void>[] = [];
    for (const row of rows) {
      const pair = pairFromRow(row);
      if (pair) {
        addPair(pair);
        cacheWrites.push(cachePair(pair));
      }
    }
    if (cacheWrites.length > 0) {
      await Promise.all(cacheWrites);
    }
  }

  return Array.from(resultByIdentity.values());
}

export async function putUserConsent(input: RecordConsentInput): Promise<UserConsentRecord> {
  const parsed = parseAddress(input.address);
  if (!input.signature?.trim() || input.signature === '0x' || !input.message?.trim()) {
    throw new RequestError('A signature and signed message are required');
  }
  let pair = await getWalletPair(parsed.value);
  const isNewAccount = !pair || !pair.consentedAt;

  if (!pair) {
    const rawEvm = parsed.kind === 'evm' ? parsed.value : (typeof input.metadata?.evmAddress === 'string' ? input.metadata.evmAddress : undefined);
    const rawSvm = parsed.kind === 'svm' ? parsed.value : input.svmAddress;
    const evm = rawEvm ? parseAddress(rawEvm) : null;
    const svm = rawSvm ? parseAddress(rawSvm) : null;
    if ((evm && evm.kind !== 'evm') || (svm && svm.kind !== 'svm') || (parsed.value !== evm?.value && parsed.value !== svm?.value)) {
      throw new RequestError('Invalid wallet pair');
    }
    pair = await putWalletPair({ evmAddress: evm?.value ?? null, svmAddress: svm?.value ?? null });
  } else if (!pair.svmAddress && input.svmAddress) {
    const evm = parseAddress(pair.evmAddress || input.metadata?.evmAddress);
    const svm = parseAddress(input.svmAddress);
    if (evm.kind !== 'evm' || svm.kind !== 'svm') throw new RequestError('Invalid wallet pair');
    pair = await putWalletPair({ evmAddress: evm.value, svmAddress: svm.value });
  } else if (!pair.evmAddress && typeof input.metadata?.evmAddress === 'string') {
    const evm = parseAddress(input.metadata.evmAddress);
    const svm = parseAddress(pair.svmAddress);
    if (evm.kind !== 'evm' || svm.kind !== 'svm') throw new RequestError('Invalid wallet pair');
    pair = await putWalletPair({ evmAddress: evm.value, svmAddress: svm.value });
  }

  if (!pair || (input.svmAddress && pair.svmAddress && parseAddress(input.svmAddress).value !== pair.svmAddress)) {
    throw new RequestError('Wallet pair not found');
  }

  const version = input.policyVersion ?? '1.0.0';
  const metadata = JSON.stringify({ ...input.metadata, disclaimerType: input.disclaimerType });
  const updated = pair.evmAddress
    ? await userSql`
        UPDATE public.wallet_pairs SET consented_at = NOW(), consent_version = ${version},
          consent_signature = ${input.signature}, consent_message = ${input.message}, consent_metadata = ${metadata}::jsonb
        WHERE evm_address = ${pair.evmAddress} AND svm_address IS NOT DISTINCT FROM ${pair.svmAddress || null} RETURNING *
      `
    : await userSql`
        UPDATE public.wallet_pairs SET consented_at = NOW(), consent_version = ${version},
          consent_signature = ${input.signature}, consent_message = ${input.message}, consent_metadata = ${metadata}::jsonb
        WHERE svm_address = ${pair.svmAddress} AND evm_address IS NULL RETURNING *
      `;
  const updatedPair = pairFromRow(updated[0]);
  if (updatedPair) await cachePair(updatedPair);
  const record = consentFromPair(updatedPair);
  if (!record) throw new RequestError('Account pair changed while recording consent', 409);
  if (isNewAccount) {
    await seedStarterSongForNewUser(record.evmAddress || record.svmAddress);
  }
  return record;
}

export async function getUserConsent(lookup: ConsentLookupQuery | string): Promise<UserConsentRecord | null> {
  const rawAddress = typeof lookup === 'string' ? lookup : lookup.address;
  const pair = await getWalletPair(rawAddress);
  const record = consentFromPair(pair);
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
  const pair = await getWalletPair(rawAddress);
  return pair?.guidesSeen ?? [];
}

export async function putUserGuides(input: {
  address: string;
  svmAddress?: string | null;
  guides: string[];
}): Promise<string[]> {
  const parsed = parseAddress(input.address);
  const incoming = Array.from(new Set((input.guides || []).map(item => String(item).trim()).filter(Boolean)));
  let existing = await getWalletPair(parsed.value);
  if (!existing) {
    existing = await updateProfile({ address: parsed.value, svmAddress: input.svmAddress ?? null });
  }
  const merged = Array.from(new Set([...(existing.guidesSeen ?? []), ...incoming]));
  const serialized = JSON.stringify(merged);
  if (existing.evmAddress) {
    await userSql`
      UPDATE public.wallet_pairs
      SET guides_seen = ${serialized}::jsonb
      WHERE evm_address = ${existing.evmAddress}
    `;
  } else {
    await userSql`
      UPDATE public.wallet_pairs
      SET guides_seen = ${serialized}::jsonb
      WHERE svm_address = ${existing.svmAddress}
    `;
  }
  await cachePair({ ...existing, guidesSeen: merged });
  return merged;
}

const syncedSessionPairs = new Set<string>();
export function ensureSessionPairLinked(addrs: string[]): void {
  if (process.env.VITEST) return;
  const evm = addrs.find(a => /^0x[0-9a-fA-F]{40}$/.test(a))?.toLowerCase();
  const svm = addrs.find(a => !a.startsWith('0x') && a.length >= 32);
  if (!evm && !svm) return;
  const key = `${evm ?? ''}:${svm ?? ''}`;
  if (syncedSessionPairs.has(key)) return;
  syncedSessionPairs.add(key);
  void putWalletPair({ evmAddress: evm ?? null, svmAddress: svm ?? null }).catch(() => {
    syncedSessionPairs.delete(key);
  });
}

export function readUser(request: FastifyRequest): string {
  const value = request.headers['x-session-user-address'];
  if (value === undefined) throw new RequestError('userAddress header is required');
  if (typeof value !== 'string') throw new RequestError('Invalid userAddress header');
  let parsed: string;
  try { parsed = parseAddress(value).value; }
  catch { throw new RequestError('Invalid userAddress header'); }
  const walletToken = request.headers['x-wallet-auth-token'];
  if (typeof walletToken === 'string' && walletToken.length > 0 && !verifyCachedTokenAddress(walletToken, parsed)) {
    throw new RequestError('userAddress does not belong to authenticated wallet', 403);
  }
  return parsed;
}

export function checkUser(userAddress: string, raw: string): void {
  let value: string;
  try { value = parseAddress(raw).value; }
  catch { throw new RequestError('Invalid userAddress'); }
  if (value !== userAddress) throw new RequestError('userAddress does not match this resource', 403);
}

export async function checkUserOrPair(userAddress: string, raw: string): Promise<void> {
  try {
    checkUser(userAddress, raw);
  } catch (error) {
    if (!(error instanceof RequestError) || error.statusCode !== 403) throw error;
    const userParsed = parseAddress(userAddress);
    const targetParsed = parseAddress(raw);
    if (userParsed.kind === targetParsed.kind) throw error;
    const target = targetParsed.value;
    const pair = (await getWalletPair(userParsed.value)) ?? (await getWalletPair(target));
    if (
      !pair ||
      !((userParsed.value === pair.evmAddress || userParsed.value === pair.svmAddress) &&
        (target === pair.evmAddress || target === pair.svmAddress))
    ) {
      throw error;
    }
  }
}

export async function readSong(request: FastifyRequest, songId: string) {
  const userAddress = readUser(request);
  const song = await getSongById(songId);
  if (!song) throw new RequestError('Song not found', 404);
  await checkUserOrPair(userAddress, song.creator);
  return { userAddress, song };
}

export async function readTake(request: FastifyRequest, takeId: string, songId?: string) {
  readUser(request);
  const rows = await songSql`SELECT song_id FROM takes WHERE id = ${takeId} LIMIT 1`;
  if (!rows[0] || (songId && rows[0].song_id !== songId)) throw new RequestError('Take not found', 404);
  return readSong(request, rows[0].song_id);
}
