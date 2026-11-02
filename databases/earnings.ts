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
  txHash?: string | null;
  payer?: string | null;
}

export interface SongEarningsItem {
  songId: string;
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
  plays: number;
  streamSettlements: number;
}

export interface NetworkEarningsBreakdown {
  network: string;
  family: 'base' | 'tempo' | 'solana' | 'other';
  label: string;
  songCount: number;
  licensesSold: number;
  licensesRemaining: number;
  plays: number;
  licenseProfitUsd: number;
  streamProfitUsd: number;
  totalProfitUsd: number;
}

export interface CreatorEarningsSummary {
  totalProfitUsd: number;
  licenseProfitUsd: number;
  streamProfitUsd: number;
  licensesSold: number;
  licensesRemaining: number;
  licensesMinted: number;
  totalPlays: number;
  publishedCount: number;
  activeNetworkFilter: string;
}

export interface CreatorEarningsResponse {
  creator: string;
  updatedAt: number;
  summary: CreatorEarningsSummary;
  networks: NetworkEarningsBreakdown[];
  songs: Record<string, SongEarningsItem>;
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
  if (gross <= 0n && creatorShare <= 0n) return;

  await songSql`
    INSERT INTO song_earnings (
      id, song_id, creator, network, kind, gross_atomics, creator_atomics, tx_hash, payer
    ) VALUES (
      ${id},
      ${songId},
      ${creator},
      ${network},
      ${input.kind},
      ${gross.toString()}::bigint,
      ${creatorShare.toString()}::bigint,
      ${input.txHash ?? null},
      ${input.payer ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET
      gross_atomics = GREATEST(song_earnings.gross_atomics, EXCLUDED.gross_atomics),
      creator_atomics = GREATEST(song_earnings.creator_atomics, EXCLUDED.creator_atomics),
      tx_hash = COALESCE(EXCLUDED.tx_hash, song_earnings.tx_hash),
      payer = COALESCE(EXCLUDED.payer, song_earnings.payer)
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

async function syncValkeyStreamPayments(creatorAddresses: Set<string>, songMap: Map<string, { creator: string; network: string | null }>): Promise<void> {
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
          songId?: string;
          creator?: string;
          payer?: string;
          network?: string;
          billedWei?: string;
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
        let lastTxHash: string | null = null;
        let lastPayer: string | null = state.payer || null;
        let lastNetwork: string | null = state.network || songMeta?.network || null;

        if (Array.isArray(state.obligations) && state.obligations.length > 0) {
          for (const ob of state.obligations) {
            const obGross = toBigIntSafe(ob.settle?.finalAmountWei || ob.receipt?.deltaWei || ob.deltaWei);
            sumObligationGross += obGross;
            if (ob.receipt?.txHash || ob.settle?.txHash) {
              lastTxHash = ob.receipt?.txHash || ob.settle?.txHash || lastTxHash;
            }
            if (ob.receipt?.payer) lastPayer = ob.receipt.payer;
            if (ob.receipt?.network) lastNetwork = ob.receipt.network;
          }
        }

        const totalGross = billedAtomics >= sumObligationGross ? billedAtomics : sumObligationGross;
        if (totalGross <= 0n) return;

        const creatorShare = (totalGross * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
        const network = lastNetwork || 'eip155:84532';

        await recordSongEarning({
          id: `x402:${sessionId}`,
          songId: state.songId,
          creator: normalizedCreator,
          network,
          kind: 'stream',
          grossAtomics: totalGross,
          creatorAtomics: creatorShare,
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

async function syncCreditStreamHolds(songIds: string[], songMap: Map<string, { creator: string; network: string | null }>): Promise<void> {
  if (!songIds.length || process.env.CREDITS_ENABLED !== 'true') return;
  try {
    const { creditStore } = await import('../credits/store.js');
    const store = creditStore();
    const res = await store.tx((c) =>
      c.query(
        `SELECT id, owner AS account, settled, context
         FROM credit_holds
         WHERE environment = $1
           AND settled > 0
           AND context->>'kind' = 'stream'
           AND context->>'songId' = ANY($2)`,
        [store.environment, songIds],
      ),
    );
    const rows = (res.rows || []) as Array<{
      id: string;
      account: string;
      settled: string | number;
      context?: { songId?: string; creator?: string };
    }>;

    for (const row of rows) {
      const songId = row.context?.songId;
      if (!songId) continue;
      const meta = songMap.get(songId);
      if (!meta) continue;
      const gross = toBigIntSafe(row.settled);
      if (gross <= 0n) continue;
      const creatorShare = (gross * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
      await recordSongEarning({
        id: `crd:${row.id}`,
        songId,
        creator: meta.creator,
        network: meta.network || 'eip155:84532',
        kind: 'stream',
        grossAtomics: gross,
        creatorAtomics: creatorShare,
        payer: row.account,
      });
    }
  } catch {
    // Non-fatal credit hold sync
  }
}

export async function getCreatorEarnings(
  creatorInput: string,
  options?: { network?: string; refresh?: boolean },
): Promise<CreatorEarningsResponse> {
  const normalizedInput = normalizeCreator(creatorInput);
  const addresses = await resolveIdentityAddresses(normalizedInput);
  const normalizedAddresses = Array.from(new Set([normalizedInput, ...addresses.map(normalizeCreator)]));
  const cacheKey = `earnings:creator:${normalizedAddresses.slice().sort().join(',')}`;

  let baseData: CreatorEarningsResponse | undefined;
  if (!options?.refresh) {
    baseData = await cacheGet<CreatorEarningsResponse>(cacheKey, 15_000);
  }

  if (!baseData) {
    const allCreatorSongs = await listSongsByCreator(normalizedInput);
    const publishedSongs = allCreatorSongs.filter(
      (s) => Boolean((s.public || s.chain_song_id || s.metadata_cid) && !s.source),
    );
    const songMap = new Map<string, { creator: string; network: string | null }>();
    for (const s of allCreatorSongs) {
      songMap.set(s.id, { creator: normalizeCreator(s.creator), network: s.network || null });
    }

    const creatorSet = new Set(normalizedAddresses);
    const allSongIds = allCreatorSongs.map((s) => s.id);

    await Promise.all([
      syncValkeyStreamPayments(creatorSet, songMap),
      syncCreditStreamHolds(allSongIds, songMap),
    ]);

    const chains = await getComposeChains();

    const [rawEarningsRows, rawRemixRows] = allSongIds.length > 0
      ? await Promise.all([
          songSql`
            SELECT song_id, kind, creator_atomics, gross_atomics, tx_hash, network
            FROM song_earnings
            WHERE song_id = ANY(${allSongIds})
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
      song_id: string;
      kind: string;
      creator_atomics: string;
      gross_atomics: string;
      tx_hash: string | null;
      network: string;
    }>;
    const remixRows = rawRemixRows as Array<{ source: string; cnt: number }>;

    const remixCountBySong = new Map<string, number>();
    for (const r of remixRows) {
      if (r.source && r.cnt > 0) remixCountBySong.set(r.source, Number(r.cnt));
    }

    const streamAtomicsBySong = new Map<string, { atomics: bigint; count: number; lastTxHash: string | null }>();
    const recordedLicenseAtomicsBySong = new Map<string, bigint>();

    for (const row of dbEarningsRows) {
      const share = toBigIntSafe(row.creator_atomics);
      if (row.kind === 'stream') {
        const prev = streamAtomicsBySong.get(row.song_id) || { atomics: 0n, count: 0, lastTxHash: null };
        prev.atomics += share;
        prev.count += 1;
        if (row.tx_hash) prev.lastTxHash = row.tx_hash;
        streamAtomicsBySong.set(row.song_id, prev);
      } else if (row.kind === 'license') {
        recordedLicenseAtomicsBySong.set(
          row.song_id,
          (recordedLicenseAtomicsBySong.get(row.song_id) || 0n) + share,
        );
      }
    }

    const songsRecord: Record<string, SongEarningsItem> = {};

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

        const dbAllocation = Math.max(0, Number(song.licenses || 0));
        const onChainRemaining = onChain ? Number(onChain.licenseAmount) : dbAllocation;
        const remixCount = remixCountBySong.get(song.id) || 0;
        const chainDiffSold = Math.max(0, Math.max(dbAllocation, onChainRemaining) - Math.max(0, onChainRemaining));
        const licensesSold = Math.max(chainDiffSold, remixCount);
        const licensesRemaining = Math.max(0, onChainRemaining);
        const licensesMinted = Math.max(dbAllocation, licensesRemaining + licensesSold);

        const licensePriceAtomics = onChain
          ? onChain.licensePrice
          : BigInt(Math.round(Math.max(0, Number(song.license_price || 0)) * 1_000_000));
        const streamPriceAtomics = onChain
          ? onChain.streamPrice
          : BigInt(Math.round(Math.max(0, Number(song.stream_price || 0)) * 1_000_000));

        const computedLicenseProfitAtomics =
          BigInt(licensesSold) * ((licensePriceAtomics * CREATOR_SHARE_BPS) / BPS_DENOMINATOR);
        const dbLicenseProfitAtomics = recordedLicenseAtomicsBySong.get(song.id) || 0n;
        const licenseProfitAtomics =
          computedLicenseProfitAtomics >= dbLicenseProfitAtomics
            ? computedLicenseProfitAtomics
            : dbLicenseProfitAtomics;

        const streamEntry = streamAtomicsBySong.get(song.id) || {
          atomics: 0n,
          count: 0,
          lastTxHash: null,
        };
        const streamProfitAtomics = streamEntry.atomics;
        const totalProfitAtomics = licenseProfitAtomics + streamProfitAtomics;

        const txHash = song.tx_hash || streamEntry.lastTxHash || null;

        songsRecord[song.id] = {
          songId: song.id,
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
          plays: Math.max(0, Number(song.plays || 0)),
          streamSettlements: streamEntry.count,
        };
      }),
    );

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
        licenseProfitUsd: 0,
        streamProfitUsd: 0,
        totalProfitUsd: 0,
      };
      existing.songCount += 1;
      existing.licensesSold += item.licensesSold;
      existing.licensesRemaining += item.licensesRemaining;
      existing.plays += item.plays;
      existing.licenseProfitUsd = Number((existing.licenseProfitUsd + item.licenseProfitUsd).toFixed(6));
      existing.streamProfitUsd = Number((existing.streamProfitUsd + item.streamProfitUsd).toFixed(6));
      existing.totalProfitUsd = Number((existing.totalProfitUsd + item.totalProfitUsd).toFixed(6));
      networkBuckets.set(key, existing);
    }

    const allItems = Object.values(songsRecord);
    const summary: CreatorEarningsSummary = {
      totalProfitUsd: Number(allItems.reduce((acc, s) => acc + s.totalProfitUsd, 0).toFixed(6)),
      licenseProfitUsd: Number(allItems.reduce((acc, s) => acc + s.licenseProfitUsd, 0).toFixed(6)),
      streamProfitUsd: Number(allItems.reduce((acc, s) => acc + s.streamProfitUsd, 0).toFixed(6)),
      licensesSold: allItems.reduce((acc, s) => acc + s.licensesSold, 0),
      licensesRemaining: allItems.reduce((acc, s) => acc + s.licensesRemaining, 0),
      licensesMinted: allItems.reduce((acc, s) => acc + s.licensesMinted, 0),
      totalPlays: allItems.reduce((acc, s) => acc + s.plays, 0),
      publishedCount: allItems.length,
      activeNetworkFilter: 'all',
    };

    baseData = {
      creator: normalizedInput,
      updatedAt: Date.now(),
      summary,
      networks: Array.from(networkBuckets.values()).sort((a, b) => b.totalProfitUsd - a.totalProfitUsd),
      songs: songsRecord,
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

  return {
    ...baseData,
    summary: {
      totalProfitUsd: Number(filteredItems.reduce((acc, s) => acc + s.totalProfitUsd, 0).toFixed(6)),
      licenseProfitUsd: Number(filteredItems.reduce((acc, s) => acc + s.licenseProfitUsd, 0).toFixed(6)),
      streamProfitUsd: Number(filteredItems.reduce((acc, s) => acc + s.streamProfitUsd, 0).toFixed(6)),
      licensesSold: filteredItems.reduce((acc, s) => acc + s.licensesSold, 0),
      licensesRemaining: filteredItems.reduce((acc, s) => acc + s.licensesRemaining, 0),
      licensesMinted: filteredItems.reduce((acc, s) => acc + s.licensesMinted, 0),
      totalPlays: filteredItems.reduce((acc, s) => acc + s.plays, 0),
      publishedCount: filteredItems.length,
      activeNetworkFilter: filter,
    },
    songs: filteredSongs,
  };
}
