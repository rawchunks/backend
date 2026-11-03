import { createPublicClient, http } from 'viem';
import { address as svmAddress, getAddressDecoder, getProgramDerivedAddress } from '@solana/kit';
import { songSql } from './client.js';
import { resolveIdentityAddresses } from './users.js';
import { listSongsByCreator } from './songs.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';
import { valkey } from '../broker/valkey.js';
import { getComposeApiUrl } from '../broker/payment.js';

const EARNINGS_CACHE_TTL = 45;
const CHAINS_CACHE_KEY = 'earnings:compose:chains';
const CHAINS_CACHE_TTL = 600;
const CREATOR_SHARE_BPS = 8000n;
const BPS_DENOMINATOR = 10000n;

const DEFAULT_FACTORY_EVM = (process.env.FACTORY_ADDRESS || process.env.VITE_FACTORY_ADDRESS || '0x4Ac838b970D44AB9056b4201e9ED3c1Ce271545e') as `0x${string}`;
const TEMPO_TESTNET_FACTORY_EVM = (process.env.TEMPO_TESTNET_FACTORY_ADDRESS || '0x76ab653224be0e5fb7ab6f8ba7fd23c0fb5e29e7') as `0x${string}`;
const DEFAULT_FACTORY_SVM = process.env.FACTORY_PROGRAM_ID || process.env.VITE_FACTORY_PROGRAM_ID || 'EPKxVRtMaZbnoPgtpycYhXX7EGM3PzyCM36upmwJyenD';

function resolveEvmFactoryAddress(network: string): `0x${string}` {
  if (network === 'eip155:42431') return TEMPO_TESTNET_FACTORY_EVM;
  return DEFAULT_FACTORY_EVM;
}

const FACTORY_GET_SONG_ABI = [
  {
    type: 'function',
    name: 'getSong',
    inputs: [{ name: 'songId', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct IFactory.Song',
        components: [
          { name: 'licenseAmount', type: 'uint256', internalType: 'uint256' },
          { name: 'licensePrice', type: 'uint256', internalType: 'uint256' },
          { name: 'streamPrice', type: 'uint256', internalType: 'uint256' },
          { name: 'creator', type: 'address', internalType: 'address' },
          { name: 'remixable', type: 'bool', internalType: 'bool' },
          { name: 'isRemix', type: 'bool', internalType: 'bool' },
          { name: 'parentSongId', type: 'uint256', internalType: 'uint256' },
          { name: 'metadataUri', type: 'string', internalType: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

export interface RecordSongEarningInput {
  id: string;
  songId: string;
  creator: string;
  network: string;
  kind: 'license' | 'stream';
  grossAtomics: bigint | number | string;
  creatorAtomics: bigint | number | string;
  streamedMs?: bigint | number | string | null;
  txHash?: string | null;
  payer?: string | null;
  createdAt?: Date | string | number | null;
}

export interface EarningEventItem {
  id: string;
  songId: string;
  songTitle: string;
  genre: string;
  network: string;
  networkFamily: 'base' | 'tempo' | 'solana' | 'other';
  networkLabel: string;
  kind: 'license' | 'stream';
  royaltiesUsd: number;
  platformFeeUsd: number;
  totalUsd: number;
  streamedMs: number;
  durationMs: number;
  ratioPct: number;
  txHash: string | null;
  explorerUrl: string | null;
  payer: string | null;
  timestamp: number;
}

export interface SongEarningsItem {
  songId: string;
  title: string;
  image: string | null;
  genres: string[];
  primaryGenre: string;
  durationSec: number;
  durationMs: number;
  chainSongId: string | null;
  network: string | null;
  networkFamily: 'base' | 'tempo' | 'solana' | 'other';
  networkLabel: string;
  explorerUrl: string | null;
  txHash: string | null;
  licensesMinted: number;
  licensesRemaining: number;
  licensesSold: number;
  licensePriceUsd: number;
  streamPriceUsd: number;
  licenseProfitUsd: number;
  streamProfitUsd: number;
  totalProfitUsd: number;
  platformFeeUsd: number;
  grossUsd: number;
  plays: number;
  streamSettlements: number;
  streamedMs: number;
  avgStreamedMs: number;
  ratioPct: number;
  lastPlayedAt: number;
}

export interface NetworkEarningsBreakdown {
  network: string;
  family: 'base' | 'tempo' | 'solana' | 'other';
  label: string;
  songCount: number;
  licensesSold: number;
  licensesRemaining: number;
  plays: number;
  streamedMs: number;
  licenseProfitUsd: number;
  streamProfitUsd: number;
  totalProfitUsd: number;
  platformFeeUsd: number;
  grossUsd: number;
}

export interface CreatorEarningsSummary {
  totalProfitUsd: number;
  licenseProfitUsd: number;
  streamProfitUsd: number;
  platformFeeUsd: number;
  grossUsd: number;
  licensesSold: number;
  licensesRemaining: number;
  licensesMinted: number;
  totalPlays: number;
  totalStreamedMs: number;
  avgStreamedMs: number;
  avgRatioPct: number;
  peakRatioPct: number;
  publishedCount: number;
  activeNetworkFilter: string;
}

export interface CreatorEarningsResponse {
  creator: string;
  updatedAt: number;
  summary: CreatorEarningsSummary;
  networks: NetworkEarningsBreakdown[];
  songs: Record<string, SongEarningsItem>;
  events: EarningEventItem[];
}

interface ComposeChainInfo {
  id: number | string;
  caip2?: string;
  name: string;
  type: 'evm' | 'solana';
  rpcUrl: string;
  explorer?: string;
}

function normalizeCreator(addr: string): string {
  const trimmed = addr.trim();
  return trimmed.startsWith('0x') ? trimmed.toLowerCase() : trimmed;
}

function toBigIntSafe(value: bigint | number | string | null | undefined): bigint {
  if (typeof value === 'bigint') return value >= 0n ? value : 0n;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0n;
    return BigInt(Math.round(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    try {
      const parsed = BigInt(trimmed);
      return parsed >= 0n ? parsed : 0n;
    } catch {
      const floatVal = Number(trimmed);
      if (Number.isFinite(floatVal) && floatVal > 0) {
        return BigInt(Math.round(floatVal));
      }
      return 0n;
    }
  }
  return 0n;
}

function toIsoTimestamp(val: Date | string | number | null | undefined): string | null {
  if (!val) return null;
  if (val instanceof Date) {
    return Number.isFinite(val.getTime()) ? val.toISOString() : null;
  }
  if (typeof val === 'number') {
    const d = new Date(val);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof val === 'string') {
    const ms = Date.parse(val);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function atomicsToUsd(atomics: bigint): number {
  return Number(atomics) / 1_000_000;
}

export function classifyNetwork(network?: string | null): {
  family: 'base' | 'tempo' | 'solana' | 'other';
  label: string;
} {
  if (!network) return { family: 'other', label: 'Unassigned' };
  const lower = network.toLowerCase();
  if (lower.startsWith('solana:')) {
    return {
      family: 'solana',
      label: lower.includes('etwtrab') ? 'Solana Devnet' : 'Solana',
    };
  }
  if (lower === 'eip155:84532') return { family: 'base', label: 'Base Sepolia' };
  if (lower === 'eip155:8453') return { family: 'base', label: 'Base' };
  if (lower === 'eip155:42431' || lower === 'eip155:4217') {
    return { family: 'tempo', label: lower === 'eip155:42431' ? 'Tempo Testnet' : 'Tempo' };
  }
  return { family: 'other', label: network };
}

function matchesNetworkFilter(network: string | null | undefined, filter?: string): boolean {
  if (!filter || filter === 'all') return true;
  if (!network) return false;
  const f = filter.trim().toLowerCase();
  const n = network.trim().toLowerCase();
  if (f === n) return true;
  const { family } = classifyNetwork(network);
  return family === f;
}

async function getComposeChains(): Promise<Map<string, ComposeChainInfo>> {
  const cached = await cacheGet<ComposeChainInfo[]>(CHAINS_CACHE_KEY, 60_000);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    const map = new Map<string, ComposeChainInfo>();
    for (const c of cached) {
      const caip = c.caip2 || (c.type === 'evm' ? `eip155:${c.id}` : `solana:${c.id}`);
      map.set(caip, c);
    }
    return map;
  }

  const map = new Map<string, ComposeChainInfo>();
  try {
    const res = await fetch(`${getComposeApiUrl()}/api/chains`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = (await res.json()) as { chains?: ComposeChainInfo[] };
      const list = Array.isArray(body?.chains) ? body.chains : [];
      if (list.length > 0) {
        await cacheSet(CHAINS_CACHE_KEY, list, CHAINS_CACHE_TTL);
        for (const c of list) {
          const caip = c.caip2 || (c.type === 'evm' ? `eip155:${c.id}` : `solana:${c.id}`);
          map.set(caip, c);
        }
      }
    }
  } catch {
    // Non-fatal; fallback RPC URLs below handle offline facilitator
  }
  return map;
}

function resolveRpcUrl(network: string, chains: Map<string, ComposeChainInfo>): string | null {
  const chain = chains.get(network);
  if (chain?.rpcUrl) return chain.rpcUrl;
  const qnUrl = process.env.QUICKNODE_RPC_URL?.trim();
  if (network === 'eip155:84532') return process.env.BASE_SEPOLIA_RPC_URL || qnUrl || 'https://sepolia.base.org';
  if (network === 'eip155:8453') return process.env.BASE_RPC_URL || qnUrl || 'https://mainnet.base.org';
  if (network === 'eip155:42431') return process.env.TEMPO_TESTNET_RPC_URL || 'https://rpc.moderato.tempo.xyz';
  if (network.startsWith('solana:')) {
    return network.includes('EtWTRAB')
      ? (process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com')
      : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
  }
  return null;
}

function resolveExplorerTxUrl(network: string | null, txHash: string | null, chains: Map<string, ComposeChainInfo>): string | null {
  if (!network || !txHash) return null;
  const chain = chains.get(network);
  const base = chain?.explorer
    || (network === 'eip155:84532'
      ? 'https://sepolia.basescan.org'
      : network === 'eip155:8453'
        ? 'https://basescan.org'
        : network === 'eip155:42431'
          ? 'https://explore.tempo.xyz'
          : network.startsWith('solana:')
            ? 'https://explorer.solana.com'
            : null);
  if (!base) return null;
  if (network.startsWith('solana:')) {
    const cluster = network.includes('EtWTRAB') ? '?cluster=devnet' : '';
    return `${base.replace(/\/+$/, '')}/tx/${txHash}${cluster}`;
  }
  return `${base.replace(/\/+$/, '')}/tx/${txHash}`;
}

export async function recordSongEarning(input: RecordSongEarningInput): Promise<void> {
  const id = String(input.id || '').trim();
  const songId = String(input.songId || '').trim();
  const creator = normalizeCreator(String(input.creator || ''));
  const network = String(input.network || '').trim();
  if (!id || !songId || !creator || !network) return;

  const gross = toBigIntSafe(input.grossAtomics);
  const creatorShare = toBigIntSafe(input.creatorAtomics);
  const streamedMs = toBigIntSafe(input.streamedMs);
  if (gross <= 0n && creatorShare <= 0n) return;

  const createdAtIso = toIsoTimestamp(input.createdAt);

  await songSql`
    INSERT INTO song_earnings (
      id, song_id, creator, network, kind, gross_atomics, creator_atomics, streamed_ms, tx_hash, payer, created_at
    ) VALUES (
      ${id},
      ${songId},
      ${creator},
      ${network},
      ${input.kind},
      ${gross.toString()}::bigint,
      ${creatorShare.toString()}::bigint,
      ${streamedMs.toString()}::bigint,
      ${input.txHash ?? null},
      ${input.payer ?? null},
      COALESCE(${createdAtIso}::timestamptz, NOW())
    )
    ON CONFLICT (id) DO UPDATE SET
      gross_atomics = GREATEST(song_earnings.gross_atomics, EXCLUDED.gross_atomics),
      creator_atomics = GREATEST(song_earnings.creator_atomics, EXCLUDED.creator_atomics),
      streamed_ms = GREATEST(song_earnings.streamed_ms, EXCLUDED.streamed_ms),
      tx_hash = COALESCE(EXCLUDED.tx_hash, song_earnings.tx_hash),
      payer = COALESCE(EXCLUDED.payer, song_earnings.payer),
      created_at = LEAST(song_earnings.created_at, EXCLUDED.created_at)
  `;

  await cacheDel(`earnings:creator:${creator}`);
}

interface OnChainSongState {
  licenseAmount: bigint;
  licensePrice: bigint;
  streamPrice: bigint;
}

async function readEvmSongState(rpcUrl: string, network: string, chainSongId: string): Promise<OnChainSongState | null> {
  try {
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    const data = await client.readContract({
      address: resolveEvmFactoryAddress(network),
      abi: FACTORY_GET_SONG_ABI,
      functionName: 'getSong',
      args: [BigInt(chainSongId)],
    });
    return {
      licenseAmount: BigInt(data.licenseAmount),
      licensePrice: BigInt(data.licensePrice),
      streamPrice: BigInt(data.streamPrice),
    };
  } catch {
    return null;
  }
}

function encodeU64Le(val: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, val, true);
  return buf;
}

async function readSolanaSongState(rpcUrl: string, chainSongId: string): Promise<OnChainSongState | null> {
  try {
    const programId = svmAddress(DEFAULT_FACTORY_SVM);
    const [pda] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [new TextEncoder().encode('song'), encodeU64Le(BigInt(chainSongId))],
    });
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [pda, { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      result?: { value?: { data?: [string, string]; owner?: string } | null };
    };
    const base64Data = payload?.result?.value?.data?.[0];
    if (!base64Data) return null;
    const raw = Buffer.from(base64Data, 'base64');
    if (raw.byteLength < 80 || raw[0] !== 2) return null;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const licenseAmount = view.getBigUint64(24, true);
    const licensePrice = view.getBigUint64(32, true);
    const streamPrice = view.getBigUint64(40, true);
    getAddressDecoder().decode(raw.subarray(48, 80));
    return { licenseAmount, licensePrice, streamPrice };
  } catch {
    return null;
  }
}

async function syncValkeyStreamPayments(
  creatorAddresses: Set<string>,
  songMap: Map<string, { creator: string; network: string | null; streamPrice: number }>,
): Promise<void> {
  try {
    const [activeIds, contextKeys] = await Promise.all([
      valkey.smembers('rawchunks:payments').catch(() => [] as string[]),
      valkey.keys('rawchunks:context:payment:*').catch(() => [] as string[]),
    ]);
    const allKeys = Array.from(
      new Set([
        ...contextKeys,
        ...activeIds.map((id) => (id.startsWith('rawchunks:context:') ? id : `rawchunks:context:${id}`)),
      ]),
    );
    if (!allKeys.length) return;

    await Promise.all(allKeys.map(async (key) => {
      try {
        const raw = await valkey.get(key);
        if (!raw) return;
        const state = JSON.parse(raw) as {
          id?: string;
          holdId?: string;
          songId?: string;
          creator?: string;
          payer?: string;
          account?: string;
          network?: string;
          billedWei?: string;
          acceptedMs?: number;
          obligations?: Array<{
            millis?: number;
            deltaWei?: string;
            status?: string;
            receipt?: {
              paymentIntentId?: string;
              txHash?: string;
              payer?: string;
              network?: string;
              deltaWei?: string;
              cumulativeWei?: string;
            };
            settle?: {
              paymentIntentId?: string;
              txHash?: string;
              providerAmountWei?: string;
              finalAmountWei?: string;
            };
          }>;
        };
        if (!state?.songId) return;
        const songMeta = songMap.get(state.songId);
        const normalizedCreator = state.creator ? normalizeCreator(state.creator) : songMeta?.creator;
        if (!normalizedCreator || (!creatorAddresses.has(normalizedCreator) && !songMeta)) return;

        const sessionId = state.id || key.replace(/^rawchunks:context:/, '');
        const billedAtomics = toBigIntSafe(state.billedWei);

        let sumObligationGross = 0n;
        let maxMillis = Math.max(0, Number(state.acceptedMs || 0));
        let lastTxHash: string | null = null;
        let lastPayer: string | null = state.payer || state.account || null;
        let lastNetwork: string | null = state.network || songMeta?.network || null;

        if (Array.isArray(state.obligations) && state.obligations.length > 0) {
          for (const ob of state.obligations) {
            const obGross = toBigIntSafe(ob.settle?.finalAmountWei || ob.receipt?.deltaWei || ob.deltaWei);
            sumObligationGross += obGross;
            if (typeof ob.millis === 'number' && ob.millis > maxMillis) {
              maxMillis = ob.millis;
            }
            if (ob.receipt?.txHash || ob.settle?.txHash) {
              lastTxHash = ob.receipt?.txHash || ob.settle?.txHash || lastTxHash;
            }
            if (ob.receipt?.payer) lastPayer = ob.receipt.payer;
            if (ob.receipt?.network) lastNetwork = ob.receipt.network;
          }
        }

        const totalGross = billedAtomics >= sumObligationGross ? billedAtomics : sumObligationGross;
        if (totalGross <= 0n) return;

        if (maxMillis <= 0 && songMeta && songMeta.streamPrice > 0) {
          maxMillis = Math.round((Number(totalGross) * 60000) / (songMeta.streamPrice * 1_000_000));
        }

        const creatorShare = (totalGross * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
        const network = lastNetwork || 'eip155:84532';
        const earningId = state.holdId ? `crd:${state.holdId}` : `x402:${sessionId}`;

        await recordSongEarning({
          id: earningId,
          songId: state.songId,
          creator: normalizedCreator,
          network,
          kind: 'stream',
          grossAtomics: totalGross,
          creatorAtomics: creatorShare,
          streamedMs: maxMillis,
          txHash: lastTxHash,
          payer: lastPayer,
        });
      } catch {
        // Ignore malformed Valkey entry
      }
    }));
  } catch {
    // Non-fatal Valkey sync
  }
}

async function syncCreditStreamHolds(
  songIds: string[],
  songMap: Map<string, { creator: string; network: string | null; streamPrice: number }>,
): Promise<void> {
  if (!songIds.length || process.env.CREDITS_ENABLED !== 'true') return;
  try {
    const { creditStore } = await import('../credits/store.js');
    const store = creditStore();
    const res = await store.tx((c) =>
      c.query(
        `SELECT id, owner AS account, charged, created_at, context
         FROM credit_holds
         WHERE environment = $1
           AND charged > 0
           AND context->>'kind' = 'stream'
           AND context->>'songId' = ANY($2)`,
        [store.environment, songIds],
      ),
    );
    const rows = (res.rows || []) as Array<{
      id: string;
      account: string;
      charged: string | number;
      created_at?: Date | string;
      context?: {
        songId?: string;
        creator?: string;
        network?: string;
        userAddress?: string;
        acceptedMs?: number | string;
        rate?: number | string;
        startedAt?: number | string;
      };
    }>;

    for (const row of rows) {
      const songId = row.context?.songId;
      if (!songId) continue;
      const meta = songMap.get(songId);
      if (!meta) continue;
      const gross = toBigIntSafe(row.charged);
      if (gross <= 0n) continue;
      const creatorShare = (gross * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
      let streamedMs = toBigIntSafe(row.context?.acceptedMs);
      if (streamedMs <= 0n) {
        const rate = toBigIntSafe(row.context?.rate);
        if (rate > 0n) {
          streamedMs = (gross * 60000n) / rate;
        } else if (meta.streamPrice > 0) {
          streamedMs = BigInt(Math.round((Number(gross) * 60000) / (meta.streamPrice * 1_000_000)));
        }
      }
      const startedAtMs = Number(row.context?.startedAt || 0);
      const createdAt = startedAtMs > 0 ? new Date(startedAtMs) : row.created_at;

      await recordSongEarning({
        id: `crd:${row.id}`,
        songId,
        creator: meta.creator,
        network: row.context?.network || meta.network || 'eip155:84532',
        kind: 'stream',
        grossAtomics: gross,
        creatorAtomics: creatorShare,
        streamedMs,
        payer: row.context?.userAddress || row.account,
        createdAt,
      });
    }
  } catch {
    // Non-fatal credit hold sync
  }
}

async function syncLicensedRemixEarnings(allSongIds: string[]): Promise<void> {
  if (!allSongIds.length) return;
  try {
    const rows = await songSql`
      SELECT
        r.id AS remix_id,
        r.source AS song_id,
        r.creator AS payer,
        r.tx_hash,
        r.created_at,
        p.creator AS parent_creator,
        COALESCE(r.network, p.network, 'eip155:84532') AS network,
        COALESCE(p.license_price, 0) AS license_price
      FROM songs r
      JOIN songs p ON p.id = r.source
      WHERE r.source = ANY(${allSongIds})
        AND LOWER(r.creator) <> LOWER(p.creator)
        AND COALESCE(p.license_price, 0) > 0
    `;
    for (const r of rows as Array<{
      remix_id: string;
      song_id: string;
      payer: string;
      tx_hash: string | null;
      created_at: Date | string;
      parent_creator: string;
      network: string;
      license_price: number;
    }>) {
      const gross = BigInt(Math.round(Number(r.license_price) * 1_000_000));
      if (gross <= 0n) continue;
      const creatorShare = (gross * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
      await recordSongEarning({
        id: `lic:${r.remix_id}`,
        songId: r.song_id,
        creator: r.parent_creator,
        network: r.network,
        kind: 'license',
        grossAtomics: gross,
        creatorAtomics: creatorShare,
        streamedMs: 0n,
        txHash: r.tx_hash,
        payer: r.payer,
        createdAt: r.created_at,
      });
    }
  } catch {
    // Non-fatal license remix sync
  }
}

export async function getCreatorEarnings(
  creatorInput: string,
  options?: { network?: string; refresh?: boolean },
): Promise<CreatorEarningsResponse> {
  const normalizedInput = normalizeCreator(creatorInput);
  const addresses = await resolveIdentityAddresses(normalizedInput);
  const normalizedAddresses = Array.from(new Set([normalizedInput, ...addresses.map(normalizeCreator)]));
  const cacheKey = `earnings:v2:creator:${normalizedAddresses.slice().sort().join(',')}`;

  let baseData: CreatorEarningsResponse | undefined;
  if (!options?.refresh) {
    baseData = await cacheGet<CreatorEarningsResponse>(cacheKey, 15_000);
  }

  if (!baseData) {
    const allCreatorSongs = await listSongsByCreator(normalizedInput);
    const publishedSongs = allCreatorSongs.filter(
      (s) => Boolean((s.public || s.chain_song_id || s.metadata_cid) && !s.source),
    );
    const songMap = new Map<string, { creator: string; network: string | null; streamPrice: number }>();
    for (const s of allCreatorSongs) {
      songMap.set(s.id, {
        creator: normalizeCreator(s.creator),
        network: s.network || null,
        streamPrice: Math.max(0, Number(s.stream_price || 0)),
      });
    }

    const creatorSet = new Set(normalizedAddresses);
    const allSongIds = allCreatorSongs.map((s) => s.id);

    await Promise.all([
      syncValkeyStreamPayments(creatorSet, songMap),
      syncCreditStreamHolds(allSongIds, songMap),
      syncLicensedRemixEarnings(allSongIds),
    ]);

    const chains = await getComposeChains();

    const [rawEarningsRows, rawRemixRows] = allSongIds.length > 0
      ? await Promise.all([
          songSql`
            SELECT id, song_id, kind, creator_atomics, gross_atomics, streamed_ms, tx_hash, payer, network, created_at
            FROM song_earnings
            WHERE song_id = ANY(${allSongIds})
            ORDER BY created_at DESC
          `,
          songSql`
            SELECT source, COUNT(DISTINCT creator)::int AS cnt
            FROM songs
            WHERE source = ANY(${allSongIds})
            GROUP BY source
          `,
        ])
      : [[], []];

    const dbEarningsRows = rawEarningsRows as Array<{
      id: string;
      song_id: string;
      kind: 'license' | 'stream';
      creator_atomics: string;
      gross_atomics: string;
      streamed_ms: string;
      tx_hash: string | null;
      payer: string | null;
      network: string;
      created_at: Date | string;
    }>;
    const remixRows = rawRemixRows as Array<{ source: string; cnt: number }>;

    const remixCountBySong = new Map<string, number>();
    for (const r of remixRows) {
      if (r.source && r.cnt > 0) remixCountBySong.set(r.source, Number(r.cnt));
    }

    const streamStatsBySong = new Map<
      string,
      {
        creatorAtomics: bigint;
        grossAtomics: bigint;
        streamedMs: bigint;
        count: number;
        lastTxHash: string | null;
        lastAt: number;
      }
    >();
    const licenseStatsBySong = new Map<
      string,
      {
        creatorAtomics: bigint;
        grossAtomics: bigint;
        count: number;
        lastTxHash: string | null;
        lastAt: number;
      }
    >();

    for (const row of dbEarningsRows) {
      const share = toBigIntSafe(row.creator_atomics);
      const gross = toBigIntSafe(row.gross_atomics);
      const ms = toBigIntSafe(row.streamed_ms);
      const ts = row.created_at ? new Date(row.created_at).getTime() : 0;

      if (row.kind === 'stream') {
        const prev = streamStatsBySong.get(row.song_id) || {
          creatorAtomics: 0n,
          grossAtomics: 0n,
          streamedMs: 0n,
          count: 0,
          lastTxHash: null,
          lastAt: 0,
        };
        prev.creatorAtomics += share;
        prev.grossAtomics += gross;
        prev.streamedMs += ms;
        prev.count += 1;
        if (row.tx_hash && !prev.lastTxHash) prev.lastTxHash = row.tx_hash;
        if (ts > prev.lastAt) prev.lastAt = ts;
        streamStatsBySong.set(row.song_id, prev);
      } else if (row.kind === 'license') {
        const prev = licenseStatsBySong.get(row.song_id) || {
          creatorAtomics: 0n,
          grossAtomics: 0n,
          count: 0,
          lastTxHash: null,
          lastAt: 0,
        };
        prev.creatorAtomics += share;
        prev.grossAtomics += gross;
        prev.count += 1;
        if (row.tx_hash && !prev.lastTxHash) prev.lastTxHash = row.tx_hash;
        if (ts > prev.lastAt) prev.lastAt = ts;
        licenseStatsBySong.set(row.song_id, prev);
      }
    }

    const songsRecord: Record<string, SongEarningsItem> = {};
    const publishedSongLookup = new Map<string, (typeof publishedSongs)[number]>();
    for (const s of publishedSongs) {
      publishedSongLookup.set(s.id, s);
    }

    await Promise.all(
      publishedSongs.map(async (song) => {
        const network = song.network || null;
        const { family, label } = classifyNetwork(network);
        let onChain: OnChainSongState | null = null;

        if (song.chain_song_id && network) {
          const rpcUrl = resolveRpcUrl(network, chains);
          if (rpcUrl) {
            onChain = network.startsWith('solana:')
              ? await readSolanaSongState(rpcUrl, song.chain_song_id)
              : await readEvmSongState(rpcUrl, network, song.chain_song_id);
          }
        }

        const licenseEntry = licenseStatsBySong.get(song.id) || {
          creatorAtomics: 0n,
          grossAtomics: 0n,
          count: 0,
          lastTxHash: null,
          lastAt: 0,
        };

        const dbAllocation = Math.max(0, Number(song.licenses || 0));
        const onChainRemaining = onChain ? Number(onChain.licenseAmount) : dbAllocation;
        const remixCount = remixCountBySong.get(song.id) || 0;
        const chainDiffSold = Math.max(0, Math.max(dbAllocation, onChainRemaining) - Math.max(0, onChainRemaining));
        const licensesSold = Math.max(chainDiffSold, remixCount, licenseEntry.count);
        const licensesRemaining = Math.max(0, onChainRemaining);
        const licensesMinted = Math.max(dbAllocation, licensesRemaining + licensesSold);

        const licensePriceAtomics = onChain
          ? onChain.licensePrice
          : BigInt(Math.round(Math.max(0, Number(song.license_price || 0)) * 1_000_000));
        const streamPriceAtomics = onChain
          ? onChain.streamPrice
          : BigInt(Math.round(Math.max(0, Number(song.stream_price || 0)) * 1_000_000));

        const computedLicenseGrossAtomics = BigInt(licensesSold) * licensePriceAtomics;
        const computedLicenseProfitAtomics =
          (computedLicenseGrossAtomics * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;

        const licenseProfitAtomics =
          computedLicenseProfitAtomics >= licenseEntry.creatorAtomics
            ? computedLicenseProfitAtomics
            : licenseEntry.creatorAtomics;
        const licenseGrossAtomics =
          computedLicenseGrossAtomics >= licenseEntry.grossAtomics
            ? computedLicenseGrossAtomics
            : licenseEntry.grossAtomics;

        // If on-chain shows more licenses sold than recorded in song_earnings, persist the on-chain license sale
        if (licensesSold > licenseEntry.count && licensePriceAtomics > 0n && network) {
          const missingCount = licensesSold - licenseEntry.count;
          const unitGross = licensePriceAtomics;
          const unitCreator = (unitGross * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
          for (let idx = 0; idx < missingCount; idx++) {
            const synId = `onc:lic:${song.id}:${licenseEntry.count + idx + 1}`;
            const synCreatedAt = song.last_played_at || song.created_at || new Date();
            await recordSongEarning({
              id: synId,
              songId: song.id,
              creator: song.creator,
              network,
              kind: 'license',
              grossAtomics: unitGross,
              creatorAtomics: unitCreator,
              streamedMs: 0n,
              txHash: song.tx_hash || null,
              createdAt: synCreatedAt,
            });
            if (!dbEarningsRows.some((r) => r.id === synId)) {
              dbEarningsRows.push({
                id: synId,
                song_id: song.id,
                kind: 'license',
                creator_atomics: unitCreator.toString(),
                gross_atomics: unitGross.toString(),
                streamed_ms: '0',
                tx_hash: song.tx_hash || null,
                payer: null,
                network,
                created_at: synCreatedAt,
              });
            }
          }
        }

        const streamEntry = streamStatsBySong.get(song.id) || {
          creatorAtomics: 0n,
          grossAtomics: 0n,
          streamedMs: 0n,
          count: 0,
          lastTxHash: null,
          lastAt: 0,
        };
        const streamProfitAtomics = streamEntry.creatorAtomics;
        const streamGrossAtomics =
          streamEntry.grossAtomics >= streamProfitAtomics
            ? streamEntry.grossAtomics
            : (streamProfitAtomics * BPS_DENOMINATOR) / CREATOR_SHARE_BPS;

        const totalProfitAtomics = licenseProfitAtomics + streamProfitAtomics;
        const totalGrossAtomics = licenseGrossAtomics + streamGrossAtomics;
        const totalFeeAtomics =
          totalGrossAtomics > totalProfitAtomics ? totalGrossAtomics - totalProfitAtomics : 0n;

        const durationSec = song.duration && song.duration > 0 ? Number(song.duration) : 180;
        const durationMs = Math.max(1000, Math.round(durationSec * 1000));
        const dbPlays = Math.max(0, Number(song.plays || 0));
        const plays = Math.max(dbPlays, streamEntry.count);

        let streamedMs = Number(streamEntry.streamedMs);
        if (streamedMs <= 0 && streamGrossAtomics > 0n && streamPriceAtomics > 0n) {
          streamedMs = Math.round(Number((streamGrossAtomics * 60000n) / streamPriceAtomics));
        }

        const effectivePlayCountForAvg = streamEntry.count > 0 ? streamEntry.count : plays;
        const avgStreamedMs =
          effectivePlayCountForAvg > 0 && streamedMs > 0
            ? Math.round(streamedMs / effectivePlayCountForAvg)
            : 0;
        const ratioPct =
          durationMs > 0 && avgStreamedMs > 0
            ? Number(Math.min(100, (avgStreamedMs / durationMs) * 100).toFixed(1))
            : 0;

        const genres = Array.isArray(song.genres) && song.genres.length > 0
          ? song.genres.filter(Boolean)
          : Array.isArray(song.tags) && song.tags.length > 0
            ? song.tags.filter(Boolean)
            : [];
        const primaryGenre = genres[0] || 'Uncategorized';

        const lastPlayedMs = Math.max(
          song.last_played_at ? new Date(song.last_played_at).getTime() : 0,
          streamEntry.lastAt,
          licenseEntry.lastAt,
          song.created_at ? new Date(song.created_at).getTime() : 0,
        );

        const txHash = song.tx_hash || streamEntry.lastTxHash || licenseEntry.lastTxHash || null;

        songsRecord[song.id] = {
          songId: song.id,
          title: song.title || 'Untitled',
          image: song.image || null,
          genres,
          primaryGenre,
          durationSec,
          durationMs,
          chainSongId: song.chain_song_id || null,
          network,
          networkFamily: family,
          networkLabel: label,
          explorerUrl: resolveExplorerTxUrl(network, txHash, chains),
          txHash,
          licensesMinted,
          licensesRemaining,
          licensesSold,
          licensePriceUsd: atomicsToUsd(licensePriceAtomics),
          streamPriceUsd: atomicsToUsd(streamPriceAtomics),
          licenseProfitUsd: atomicsToUsd(licenseProfitAtomics),
          streamProfitUsd: atomicsToUsd(streamProfitAtomics),
          totalProfitUsd: atomicsToUsd(totalProfitAtomics),
          platformFeeUsd: atomicsToUsd(totalFeeAtomics),
          grossUsd: atomicsToUsd(totalGrossAtomics),
          plays,
          streamSettlements: streamEntry.count,
          streamedMs,
          avgStreamedMs,
          ratioPct,
          lastPlayedAt: lastPlayedMs,
        };
      }),
    );

    // Build events array from song_earnings for published creator songs
    const events: EarningEventItem[] = [];
    for (const row of dbEarningsRows) {
      const songItem = songsRecord[row.song_id];
      if (!songItem) continue;
      const creatorAtomics = toBigIntSafe(row.creator_atomics);
      const rawGross = toBigIntSafe(row.gross_atomics);
      const grossAtomics =
        rawGross >= creatorAtomics
          ? rawGross
          : (creatorAtomics * BPS_DENOMINATOR) / CREATOR_SHARE_BPS;
      const feeAtomics = grossAtomics > creatorAtomics ? grossAtomics - creatorAtomics : 0n;

      const net = row.network || songItem.network || 'eip155:84532';
      const { family, label } = classifyNetwork(net);
      let evStreamedMs = Number(toBigIntSafe(row.streamed_ms));
      if (row.kind === 'stream' && evStreamedMs <= 0 && songItem.streamPriceUsd > 0) {
        evStreamedMs = Math.round((atomicsToUsd(grossAtomics) * 60000) / songItem.streamPriceUsd);
      }
      const evRatioPct =
        row.kind === 'stream' && songItem.durationMs > 0 && evStreamedMs > 0
          ? Number(Math.min(100, (evStreamedMs / songItem.durationMs) * 100).toFixed(1))
          : 0;
      const txHash = row.tx_hash || (row.kind === 'license' ? songItem.txHash : null);
      const ts = row.created_at ? new Date(row.created_at).getTime() : songItem.lastPlayedAt;

      events.push({
        id: row.id,
        songId: row.song_id,
        songTitle: songItem.title,
        genre: songItem.primaryGenre,
        network: net,
        networkFamily: family,
        networkLabel: label,
        kind: row.kind,
        royaltiesUsd: atomicsToUsd(creatorAtomics),
        platformFeeUsd: atomicsToUsd(feeAtomics),
        totalUsd: atomicsToUsd(grossAtomics),
        streamedMs: evStreamedMs,
        durationMs: songItem.durationMs,
        ratioPct: evRatioPct,
        txHash,
        explorerUrl: resolveExplorerTxUrl(net, txHash, chains),
        payer: row.payer || null,
        timestamp: ts,
      });
    }

    for (const songItem of Object.values(songsRecord)) {
      const extraPlays = Math.max(0, songItem.plays - songItem.streamSettlements);
      if (extraPlays > 0) {
        const net = songItem.network || 'eip155:84532';
        for (let idx = 0; idx < extraPlays; idx++) {
          events.push({
            id: `play:${songItem.songId}:${idx + 1}`,
            songId: songItem.songId,
            songTitle: songItem.title,
            genre: songItem.primaryGenre,
            network: net,
            networkFamily: songItem.networkFamily,
            networkLabel: songItem.networkLabel,
            kind: 'stream',
            royaltiesUsd: 0,
            platformFeeUsd: 0,
            totalUsd: 0,
            streamedMs: 0,
            durationMs: songItem.durationMs,
            ratioPct: 0,
            txHash: null,
            explorerUrl: null,
            payer: null,
            timestamp: songItem.lastPlayedAt,
          });
        }
      }
    }

    events.sort((a, b) => b.timestamp - a.timestamp);

    const networkBuckets = new Map<string, NetworkEarningsBreakdown>();
    for (const item of Object.values(songsRecord)) {
      const key = item.network || 'unassigned';
      const existing = networkBuckets.get(key) || {
        network: key,
        family: item.networkFamily,
        label: item.networkLabel,
        songCount: 0,
        licensesSold: 0,
        licensesRemaining: 0,
        plays: 0,
        streamedMs: 0,
        licenseProfitUsd: 0,
        streamProfitUsd: 0,
        totalProfitUsd: 0,
        platformFeeUsd: 0,
        grossUsd: 0,
      };
      existing.songCount += 1;
      existing.licensesSold += item.licensesSold;
      existing.licensesRemaining += item.licensesRemaining;
      existing.plays += item.plays;
      existing.streamedMs += item.streamedMs;
      existing.licenseProfitUsd = Number((existing.licenseProfitUsd + item.licenseProfitUsd).toFixed(6));
      existing.streamProfitUsd = Number((existing.streamProfitUsd + item.streamProfitUsd).toFixed(6));
      existing.totalProfitUsd = Number((existing.totalProfitUsd + item.totalProfitUsd).toFixed(6));
      existing.platformFeeUsd = Number((existing.platformFeeUsd + item.platformFeeUsd).toFixed(6));
      existing.grossUsd = Number((existing.grossUsd + item.grossUsd).toFixed(6));
      networkBuckets.set(key, existing);
    }

    const allItems = Object.values(songsRecord);
    const summary = buildSummaryFromItems(allItems, 'all');

    baseData = {
      creator: normalizedInput,
      updatedAt: Date.now(),
      summary,
      networks: Array.from(networkBuckets.values()).sort((a, b) => b.totalProfitUsd - a.totalProfitUsd),
      songs: songsRecord,
      events,
    };

    await cacheSet(cacheKey, baseData, EARNINGS_CACHE_TTL, 15_000);
  }

  const filter = options?.network?.trim().toLowerCase();
  if (!filter || filter === 'all') {
    return baseData;
  }

  const filteredSongs: Record<string, SongEarningsItem> = {};
  for (const [songId, item] of Object.entries(baseData.songs)) {
    if (matchesNetworkFilter(item.network, filter)) {
      filteredSongs[songId] = item;
    }
  }
  const filteredItems = Object.values(filteredSongs);
  const filteredEvents = baseData.events.filter((ev) => matchesNetworkFilter(ev.network, filter));

  return {
    ...baseData,
    summary: buildSummaryFromItems(filteredItems, filter),
    songs: filteredSongs,
    events: filteredEvents,
  };
}

function buildSummaryFromItems(items: SongEarningsItem[], activeNetworkFilter: string): CreatorEarningsSummary {
  const totalProfitUsd = Number(items.reduce((acc, s) => acc + s.totalProfitUsd, 0).toFixed(6));
  const licenseProfitUsd = Number(items.reduce((acc, s) => acc + s.licenseProfitUsd, 0).toFixed(6));
  const streamProfitUsd = Number(items.reduce((acc, s) => acc + s.streamProfitUsd, 0).toFixed(6));
  const platformFeeUsd = Number(items.reduce((acc, s) => acc + s.platformFeeUsd, 0).toFixed(6));
  const grossUsd = Number(items.reduce((acc, s) => acc + s.grossUsd, 0).toFixed(6));
  const licensesSold = items.reduce((acc, s) => acc + s.licensesSold, 0);
  const licensesRemaining = items.reduce((acc, s) => acc + s.licensesRemaining, 0);
  const licensesMinted = items.reduce((acc, s) => acc + s.licensesMinted, 0);
  const totalPlays = items.reduce((acc, s) => acc + s.plays, 0);
  const totalStreamedMs = items.reduce((acc, s) => acc + s.streamedMs, 0);
  const totalSettlements = items.reduce((acc, s) => acc + s.streamSettlements, 0);
  const effectivePlayDenom = totalSettlements > 0 ? totalSettlements : totalPlays;
  const avgStreamedMs = effectivePlayDenom > 0 ? Math.round(totalStreamedMs / effectivePlayDenom) : 0;

  // Weighted average ratio across songs with streams
  let weightedRatioNum = 0;
  let weightedRatioDen = 0;
  let peakRatioPct = 0;
  for (const s of items) {
    if (s.ratioPct > peakRatioPct) peakRatioPct = s.ratioPct;
    const weight = s.streamSettlements > 0 ? s.streamSettlements : s.plays;
    if (weight > 0 && s.ratioPct > 0) {
      weightedRatioNum += s.ratioPct * weight;
      weightedRatioDen += weight;
    }
  }
  const avgRatioPct = weightedRatioDen > 0 ? Number((weightedRatioNum / weightedRatioDen).toFixed(1)) : 0;

  return {
    totalProfitUsd,
    licenseProfitUsd,
    streamProfitUsd,
    platformFeeUsd,
    grossUsd,
    licensesSold,
    licensesRemaining,
    licensesMinted,
    totalPlays,
    totalStreamedMs,
    avgStreamedMs,
    avgRatioPct,
    peakRatioPct: Number(peakRatioPct.toFixed(1)),
    publishedCount: items.length,
    activeNetworkFilter,
  };
}
