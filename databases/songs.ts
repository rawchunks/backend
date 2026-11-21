import { eq, desc, asc, inArray, sql, and } from 'drizzle-orm';
import { songDb, songSql } from './client.js';
import { songs, songComments, songLikes, type Song, type NewSong, type SongComment } from './schema/songs.js';
import { stems, type Stem, type NewStem } from './schema/stems.js';
import { takes, type Take, type NewTake } from './schema/takes.js';
import { commits } from './schema/commits.js';
import { getWalletPair, getWalletPairsByAddresses, resolveIdentityAddresses, getWalletPairByAddressOrNickname, normalizeUrlSlug, parseAddress, RequestError } from './users.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';
import { ensureGenreCovers, normalizeGenreSlug } from './genres.js';
import { isNonGenreTag, partitionSongTags } from '../options.js';
import { getActiveNetworkSet, getActiveNetworks, getNetworkMode } from '../broker/payment.js';
import { enqueueScribe } from '../broker/valkey.js';
import { randomUUID } from 'node:crypto';

const MARKET_FOLDS_CACHE_PREFIX = 'songs:market:folds:';
const MARKET_FOLDS_TTL = 60;
const PLAY_DEDUP_PREFIX = 'songs:play-dedup:';
const PLAY_DEDUP_TTL = 45;

function toMarketSong(song: Song): Song {
  return song.published_at ? { ...song, created_at: song.published_at } : song;
}

/** Whether a song row is publicly visible in the active NETWORK_MODE. */
export function isPublicInMode(song: Partial<Song>): boolean {
  if (!song.public) return false;
  const mode = getNetworkMode();
  if (song.chain_song_id?.[mode]) return true;
  return !song.testnet && !song.mainnet && !song.chain_song_id;
}

/** Project a multi-mode DB song row to the flat wire shape for the active NETWORK_MODE. */
export function projectSong<T extends Partial<Song>>(song: T, creatorOverride?: string) {
  const mode = getNetworkMode();
  const network = song[mode] ?? null;
  const chainSongId = song.chain_song_id?.[mode] ?? null;
  const txHash = song.tx_hash?.[mode] ?? null;
  const { testnet: _t, mainnet: _m, ...rest } = song;
  return {
    ...rest,
    ...(creatorOverride ? { creator: creatorOverride } : {}),
    ...(network !== null || 'testnet' in song || 'mainnet' in song ? { network } : {}),
    ...(chainSongId !== null ? { chain_song_id: chainSongId } : 'chain_song_id' in song ? { chain_song_id: null } : {}),
    ...(txHash !== null ? { tx_hash: txHash } : 'tx_hash' in song ? { tx_hash: null } : {}),
    ...(typeof song.public === 'boolean' ? { public: isPublicInMode(song) } : {}),
  };
}

/** Resolve cross-family paired creator addresses for rows whose stored creator does not match the active mode's network family. */
async function resolveModeCreators<T extends Partial<Song>>(rows: T[]): Promise<Map<string, string>> {
  const mode = getNetworkMode();
  const mismatched = new Set<string>();
  for (const row of rows) {
    const net = row[mode];
    const creator = row.creator;
    if (!net || !creator) continue;
    const needsEvm = net.startsWith('eip155:') && !creator.startsWith('0x');
    const needsSvm = net.startsWith('solana:') && creator.startsWith('0x');
    if (needsEvm || needsSvm) mismatched.add(creator);
  }
  const overrides = new Map<string, string>();
  if (mismatched.size === 0) return overrides;
  const pairs = await getWalletPairsByAddresses([...mismatched]).catch(() => []);
  for (const pair of pairs) {
    if (pair.evmAddress && pair.svmAddress) {
      overrides.set(pair.evmAddress.toLowerCase(), pair.svmAddress);
      overrides.set(pair.svmAddress, pair.evmAddress.toLowerCase());
    }
  }
  return overrides;
}

function resolveRowCreator(row: Partial<Song>, overrides: Map<string, string>): string | undefined {
  const net = row[getNetworkMode()];
  const creator = row.creator;
  if (!net || !creator) return undefined;
  if (net.startsWith('eip155:') && !creator.startsWith('0x')) return overrides.get(creator);
  if (net.startsWith('solana:') && creator.startsWith('0x')) return overrides.get(creator.toLowerCase());
  return undefined;
}

/** Project a batch of songs, resolving cross-family paired creator addresses when needed. */
export async function projectSongs<T extends Partial<Song>>(rows: T[]) {
  const overrides = await resolveModeCreators(rows);
  if (overrides.size === 0) return rows.map(row => projectSong(row));
  return rows.map(row => projectSong(row, resolveRowCreator(row, overrides)));
}

function modePublicCondition() {
  const mode = getNetworkMode();
  const activeNetworks = [...getActiveNetworks()];
  const modeCol = mode === 'mainnet' ? songs.mainnet : songs.testnet;
  return and(eq(songs.public, true), inArray(modeCol, activeNetworks))!;
}

export async function invalidateMarketSongCache(): Promise<void> {
  const keys: string[] = [];
  for (const mode of ['testnet', 'mainnet'] as const) {
    keys.push(`songs:all:${mode}`);
    for (const limit of [12, 20, 50, 100]) {
      keys.push(`${MARKET_FOLDS_CACHE_PREFIX}${mode}:${limit}`);
      for (const win of [15, 30, 60]) {
        keys.push(`${MARKET_FOLDS_CACHE_PREFIX}${mode}:${limit}:${win}`);
      }
    }
  }
  await Promise.all(keys.map((k) => cacheDel(k)));
}

export async function createSong(songData: NewSong): Promise<Song> {
  const partitioned = partitionSongTags({
    genres: songData.genres,
    production: songData.production,
    mood: songData.mood,
    vocal: songData.vocal,
    tags: songData.tags,
  });
  const isRemix = Boolean(songData.is_remix || songData.source);
  let inheritedTestnet = songData.testnet ?? null;
  let inheritedMainnet = songData.mainnet ?? null;
  let inheritedParentChainSongId = songData.parent_chain_song_id ?? null;
  if (songData.source && ((!inheritedTestnet && !inheritedMainnet) || !inheritedParentChainSongId)) {
    const parentSong = await getSongById(songData.source);
    if (parentSong) {
      const mode = getNetworkMode();
      if (mode === 'mainnet' && !inheritedMainnet && parentSong.mainnet) inheritedMainnet = parentSong.mainnet;
      if (mode === 'testnet' && !inheritedTestnet && parentSong.testnet) inheritedTestnet = parentSong.testnet;
      if (!inheritedParentChainSongId && parentSong.chain_song_id?.[mode]) {
        inheritedParentChainSongId = parentSong.chain_song_id[mode] ?? null;
      }
    }
  }
  const result = await songDb.insert(songs).values({
    ...songData,
    tags: partitioned.genres,
    genres: partitioned.genres,
    production: partitioned.production,
    mood: partitioned.mood,
    vocal: partitioned.vocal,
    is_remix: isRemix,
    parent_chain_song_id: inheritedParentChainSongId,
    testnet: inheritedTestnet,
    mainnet: inheritedMainnet,
    ...(isRemix ? { licenses: 0, license_price: 0 } : {}),
    creator: /^0x/i.test(songData.creator) ? songData.creator.toLowerCase() : songData.creator,
  }).returning();
  const created = result[0];
  if (created && songData.source) {
    const sourceStems = await songDb.select().from(stems).where(eq(stems.song_id, songData.source));
    if (sourceStems.length > 0) {
      for (const stem of sourceStems) {
        await songDb
          .insert(stems)
          .values({
            id: randomUUID(),
            song_id: created.id,
            name: stem.name,
            url: stem.url,
            waveform_peaks_url: stem.waveform_peaks_url,
            volume: stem.volume,
            pan: stem.pan,
            is_muted: stem.is_muted,
            is_solo: stem.is_solo,
          })
          .onConflictDoNothing();
      }
    }
  }
  if (partitioned.genres.length > 0) {
    void ensureGenreCovers(partitioned.genres).catch(() => { });
  }
  await invalidateMarketSongCache();
  return created;
}

export async function copySong(id: string): Promise<Song> {
  const song = await getSongById(id);
  if (!song) throw new Error('Song not found');
  if (!song.metadata_cid) return song;
  const family = song.family ?? song.id;
  const next = `sng-${randomUUID()}`;
  const mapping: Record<string, string> = { [id]: next };
  const [lanes, versions, history] = await Promise.all([
    songDb.select().from(stems).where(eq(stems.song_id, id)),
    songDb.select().from(takes).where(eq(takes.song_id, id)),
    songDb.select().from(commits).where(eq(commits.song_id, id)).orderBy(desc(commits.created_at)),
  ]);
  for (const row of [...lanes, ...versions, ...history]) mapping[row.id] = randomUUID();
  const replace = (value: any): any => typeof value === 'string' ? mapping[value] ?? value
    : Array.isArray(value) ? value.map(replace)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [mapping[key] ?? key, replace(item)])) : value;
  const draft = sql`select id from songs where basis = ${id} and metadata_cid is null order by version desc limit 1`;
  const destination = sql`coalesce((${draft}), ${next})`;
  const inserted = sql`exists (select 1 from songs where id = ${next})`;
  const mode = getNetworkMode();
  const statements: any[] = [
    songDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${family}, 0))`),
    songDb.execute(sql`
    insert into songs (id, title, family, basis, creator, source, is_remix, version, url, duration, tags, genres, production, mood, vocal, licenses, stream_price, license_price, testnet, mainnet, image, video, album_id)
    select ${next}, title, ${family}, ${id}, creator, source, is_remix,
      (select coalesce(max(version), 0) + 1 from songs where coalesce(family, id) = ${family}),
      url, duration, tags, genres, production, mood, vocal,
      case when source is null and not is_remix then licenses else 0 end,
      stream_price,
      case when source is null and not is_remix then license_price else 0 end,
      case when (source is not null or is_remix) and ${mode} = 'testnet' then testnet else null end,
      case when (source is not null or is_remix) and ${mode} = 'mainnet' then mainnet else null end,
      image, video, album_id
    from songs where id = ${id} and not exists (${draft})
    `),
  ];
  for (const lane of lanes) statements.push(songDb.execute(sql`
    insert into stems (id, song_id, name, url, waveform_peaks_url, volume, pan, is_muted, is_solo)
    select ${mapping[lane.id]}, ${next}, ${lane.name}, ${lane.url}, ${lane.waveform_peaks_url}, ${lane.volume}, ${lane.pan}, ${lane.is_muted}, ${lane.is_solo}
    where ${inserted}
  `));
  for (const take of versions) statements.push(songDb.execute(sql`
    insert into takes (id, song_id, stem_id, take_number, model, task, prompt, lyrics, repainting_start, repainting_end, url, waveform_url, is_active, seed, provenance)
    select ${mapping[take.id]}, ${next}, ${take.stem_id ? mapping[take.stem_id] : null}, ${take.take_number}, ${take.model}, ${take.task}, ${take.prompt}, ${take.lyrics}, ${take.repainting_start}, ${take.repainting_end}, ${take.url}, ${take.waveform_url}, ${take.is_active}, ${take.seed}, ${take.provenance ? JSON.stringify(replace(take.provenance)) : null}::jsonb
    where ${inserted}
  `));
  if (history.length) statements.push(songDb.execute(sql`
    insert into commits (id, song_id, user_address, parent_commit_id, message, timeline_snapshot, created_at)
    select copied.id, ${next}, copied.user_address, copied.parent_commit_id, copied.message, copied.timeline_snapshot, copied.created_at
    from (values ${sql.join(history.map(commit => sql`(${mapping[commit.id]}::text, ${commit.user_address}::text, ${commit.parent_commit_id ? mapping[commit.parent_commit_id] : null}::text, ${commit.message}::text, ${JSON.stringify(replace(commit.timeline_snapshot))}::jsonb, ${commit.created_at.toISOString()}::timestamptz)`), sql`, `)})
      as copied(id, user_address, parent_commit_id, message, timeline_snapshot, created_at)
    where ${inserted}
  `));
  statements.push(songDb.select().from(songs).where(sql`${songs.id} = ${destination}`));
  const result = await songDb.batch(statements as [any, ...any[]]);
  return result[result.length - 1][0] as Song;
}

export async function getSongById(id: string): Promise<Song | null> {
  const result = await songDb.select().from(songs).where(eq(songs.id, id)).limit(1);
  return result[0] || null;
}

export async function getSongByTitleSlug(raw: string, creator?: string): Promise<Song | null> {
  const slug = normalizeUrlSlug(raw);
  if (!slug) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const clean = decoded.trim().toLowerCase();
  const titleMatch = sql`(LOWER(TRIM(${songs.title})) = ${clean} OR REGEXP_REPLACE(LOWER(TRIM(${songs.title})), '[\\s-]+', '-', 'g') = ${slug})`;
  const publishedOrder = sql`coalesce(${songs.published_at}, ${songs.created_at}) desc`;
  try {
    if (creator && creator.trim()) {
      const addresses = new Set<string>();
      const pair = await getWalletPairByAddressOrNickname(creator).catch(() => null);
      if (pair?.evmAddress) addresses.add(pair.evmAddress);
      if (pair?.svmAddress) addresses.add(pair.svmAddress);
      try {
        addresses.add(parseAddress(creator).value);
      } catch {
        // Creator param may be a nickname resolved above
      }
      if (addresses.size > 0) {
        const scoped = await songDb
          .select()
          .from(songs)
          .where(and(modePublicCondition(), inArray(songs.creator, [...addresses]), titleMatch))
          .orderBy(publishedOrder)
          .limit(1);
        if (scoped[0]) return toMarketSong(scoped[0]);
      }
    }

    const rows = await songDb
      .select()
      .from(songs)
      .where(and(modePublicCondition(), titleMatch))
      .orderBy(publishedOrder)
      .limit(1);
    return rows[0] ? toMarketSong(rows[0]) : null;
  } catch {
    return null;
  }
}

export async function listSongsByCreator(creatorAddress: string, limit?: number, offset = 0): Promise<Song[]> {
  validatePagination(limit, offset);
  const addresses = await resolveIdentityAddresses(creatorAddress);

  const query = songDb
    .select()
    .from(songs)
    .where(inArray(songs.creator, addresses))
    .orderBy(desc(songs.created_at)).$dynamic();
  if (limit !== undefined) query.limit(limit);
  if (offset) query.offset(offset);
  return await query;
}

export async function listAllSongs(limit?: number, offset = 0): Promise<Song[]> {
  validatePagination(limit, offset);
  const query = songDb
    .select()
    .from(songs)
    .where(modePublicCondition())
    .orderBy(sql`coalesce(${songs.published_at}, ${songs.created_at}) desc`).$dynamic();
  if (limit !== undefined) query.limit(limit);
  if (offset) query.offset(offset);
  const rows = await query;
  return rows.map(toMarketSong);
}

function validatePagination(limit: number | undefined, offset: number) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('Song limit must be a positive safe integer');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Song offset must be a nonnegative safe integer');
}

const IMMUTABLE_PUBLISHED_KEYS = [
  'title',
  'url',
  'duration',
  'source',
  'is_remix',
  'version',
  'family',
  'basis',
  'licenses',
  'license_price',
  'stream_price',
  'tags',
  'genres',
  'production',
  'mood',
  'vocal',
  'image',
] as const;

export async function updateSong(id: string, updates: Partial<NewSong>): Promise<Song | null> {
  if (Object.keys(updates).length === 0) {
    throw new Error('No values to set');
  }
  if (['id', 'creator', 'created_at', 'published_at'].some((key) => key in updates)) {
    throw new Error('Song identity and ownership cannot be updated');
  }
  const song = await getSongById(id);
  if (!song) return null;

  if (song.metadata_cid) {
    if (IMMUTABLE_PUBLISHED_KEYS.some((key) => key in updates)) {
      throw new RequestError('Open an editable version before changing this song', 409);
    }
    if ('metadata_cid' in updates && updates.metadata_cid !== song.metadata_cid) {
      throw new RequestError('Open an editable version before changing this song', 409);
    }
  }
  if ((song.source || song.is_remix || updates.source || updates.is_remix) && (updates.licenses || updates.license_price)) {
    throw new RequestError('Remixes cannot be licensed');
  }
  if (
    (song.testnet && 'testnet' in updates && updates.testnet !== song.testnet) ||
    (song.chain_song_id?.testnet && updates.chain_song_id?.testnet && updates.chain_song_id.testnet !== song.chain_song_id.testnet)
  ) {
    throw new RequestError('Testnet mint record cannot be overwritten', 409);
  }
  if (
    (song.mainnet && 'mainnet' in updates && updates.mainnet !== song.mainnet) ||
    (song.chain_song_id?.mainnet && updates.chain_song_id?.mainnet && updates.chain_song_id.mainnet !== song.chain_song_id.mainnet)
  ) {
    throw new RequestError('Mainnet mint record cannot be overwritten', 409);
  }
  if (updates.testnet && !getActiveNetworkSet().has(updates.testnet) && getNetworkMode() === 'testnet') {
    throw new RequestError(`Network is not active in testnet mode: ${updates.testnet}`, 409);
  }
  if (updates.mainnet && !getActiveNetworkSet().has(updates.mainnet) && getNetworkMode() === 'mainnet') {
    throw new RequestError(`Network is not active in mainnet mode: ${updates.mainnet}`, 409);
  }

  const normalizedUpdates: Partial<NewSong> = { ...updates };
  if (updates.source) {
    normalizedUpdates.is_remix = true;
  }
  const otherMode = getNetworkMode() === 'mainnet' ? 'testnet' : 'mainnet';
  if (updates.chain_song_id !== undefined) {
    normalizedUpdates.chain_song_id = updates.chain_song_id
      ? { ...(song.chain_song_id ?? {}), ...updates.chain_song_id }
      : song.chain_song_id?.[otherMode]
        ? { [otherMode]: song.chain_song_id[otherMode] }
        : null;
  }
  if (updates.tx_hash !== undefined) {
    normalizedUpdates.tx_hash = updates.tx_hash
      ? { ...(song.tx_hash ?? {}), ...updates.tx_hash }
      : song.tx_hash?.[otherMode]
        ? { [otherMode]: song.tx_hash[otherMode] }
        : null;
  }

  const mintNetwork = updates.mainnet ?? updates.testnet;
  if (updates.chain_song_id && mintNetwork && !song.chain_song_id?.testnet && !song.chain_song_id?.mainnet) {
    const wantsEvm = mintNetwork.startsWith('eip155:');
    const wantsSvm = mintNetwork.startsWith('solana:');
    const hasEvm = song.creator.startsWith('0x');
    if ((wantsEvm && !hasEvm) || (wantsSvm && hasEvm)) {
      const pair = await getWalletPair(song.creator).catch(() => null);
      const pairedCreator = wantsEvm ? pair?.evmAddress?.toLowerCase() : pair?.svmAddress;
      if (pairedCreator) normalizedUpdates.creator = pairedCreator;
    }
  }
  if (
    !song.published_at &&
    (Boolean(updates.chain_song_id) || Boolean(updates.tx_hash) || (updates.public === true && !song.public))
  ) {
    normalizedUpdates.published_at = new Date();
  }
  if (['tags', 'genres', 'production', 'mood', 'vocal'].some((key) => key in updates)) {
    const partitioned = partitionSongTags({
      genres: updates.genres,
      production: updates.production,
      mood: updates.mood,
      vocal: updates.vocal,
      tags: updates.tags,
    });
    if ('tags' in updates || 'genres' in updates) {
      normalizedUpdates.genres = partitioned.genres;
      normalizedUpdates.tags = partitioned.genres;
    }
    if ('production' in updates || partitioned.production.length > 0) {
      normalizedUpdates.production = partitioned.production;
    }
    if ('mood' in updates || partitioned.mood.length > 0) {
      normalizedUpdates.mood = partitioned.mood;
    }
    if ('vocal' in updates || partitioned.vocal.length > 0) {
      normalizedUpdates.vocal = partitioned.vocal;
    }
  }
  const result = await songDb
    .update(songs)
    .set(normalizedUpdates)
    .where(eq(songs.id, id))
    .returning();
  if (Array.isArray(normalizedUpdates.genres) && normalizedUpdates.genres.length > 0) {
    void ensureGenreCovers(normalizedUpdates.genres).catch(() => { });
  }
  const updated = result[0] || null;
  if (
    updated &&
    (updates.public === true || Boolean(updates.chain_song_id) || Boolean(updates.tx_hash))
  ) {
    void enqueueScribe(id, { priority: 'urgent' }).catch(() => {});
  }
  await Promise.all([cacheDel(`songs:id:${id}`), invalidateMarketSongCache()]);
  return updated;
}

/**
 * Lists songs with audio that still need unified reference-guided lyrics alignment/transcription,
 * prioritizing published Market tracks before existing drafts (newest first).
 */
export async function listSongsNeedingLyrics(limit = 50): Promise<string[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const rows = await songSql`
    SELECT s.id
    FROM songs s
    WHERE s.url <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM takes t
        WHERE t.song_id = s.id
          AND (
            t.provenance->'parameters'->>'lyricsStatus' IN ('instrumental', 'empty')
            OR (
              t.provenance->'parameters'->>'lyricsStatus' = 'ready'
              AND t.provenance->'parameters'->>'lyricsAlignmentAudioUrl' IS NOT NULL
              AND (
                t.provenance->'parameters'->>'lyricsAlignmentSource' = 'vocals'
                OR NOT EXISTS (
                  SELECT 1
                  FROM stems st
                  WHERE st.song_id = s.id
                    AND LOWER(st.name) = 'vocals'
                    AND st.url <> ''
                )
              )
            )
          )
      )
    ORDER BY s.public DESC, COALESCE(s.published_at, s.created_at) DESC
    LIMIT ${safeLimit}
  `;
  return rows.map((row: any) => String(row.id)).filter(Boolean);
}

export async function preserveLicensedRemixesBeforeDelete(id: string, licensees?: string[]): Promise<void> {
  const song = await getSongById(id);
  if (!song || song.source || song.is_remix) return;

  const mode = getNetworkMode();
  const parentChainSongId = song.chain_song_id?.[mode] ?? null;
  const sourceStems = await songDb.select().from(stems).where(eq(stems.song_id, id));
  const existingRemixes = await songDb.select().from(songs).where(eq(songs.source, id));
  if (existingRemixes.length > 0) {
    await songDb
      .update(songs)
      .set({
        is_remix: true,
        parent_chain_song_id: sql`coalesce(${songs.parent_chain_song_id}, ${parentChainSongId})`,
        testnet: sql`coalesce(${songs.testnet}, ${song.testnet ?? null})`,
        mainnet: sql`coalesce(${songs.mainnet}, ${song.mainnet ?? null})`,
      })
      .where(eq(songs.source, id));

    if (sourceStems.length > 0) {
      for (const remix of existingRemixes) {
        const remixStems = await songDb.select({ id: stems.id }).from(stems).where(eq(stems.song_id, remix.id));
        if (remixStems.length === 0) {
          await songDb.insert(stems).values(
            sourceStems.map((stem) => ({
              id: `stm-${randomUUID()}`,
              song_id: remix.id,
              name: stem.name,
              url: stem.url,
              waveform_peaks_url: stem.waveform_peaks_url,
              volume: stem.volume,
              pan: stem.pan,
              is_muted: stem.is_muted,
              is_solo: stem.is_solo,
            })),
          );
        }
      }
    }
  }

  if (Array.isArray(licensees) && licensees.length > 0) {
    const creatorNorm = song.creator.toLowerCase();
    const existingCreators = new Set(existingRemixes.map((r) => r.creator.toLowerCase()));
    for (const licensee of licensees) {
      const trimmed = licensee?.trim();
      if (!trimmed) continue;
      const norm = trimmed.toLowerCase();
      if (norm === creatorNorm || existingCreators.has(norm)) continue;
      existingCreators.add(norm);
      await createSong({
        id: `sng-${randomUUID()}`,
        title: song.title,
        source: song.id,
        is_remix: true,
        creator: trimmed,
        url: song.url,
        duration: song.duration,
        tags: song.genres?.length ? song.genres : song.tags,
        genres: song.genres,
        production: song.production,
        mood: song.mood,
        vocal: song.vocal,
        licenses: 0,
        license_price: 0,
        stream_price: song.stream_price,
        image: song.image,
        testnet: song.testnet ?? null,
        mainnet: song.mainnet ?? null,
      });
    }
  }
}

export async function deleteSong(id: string, licensees?: string[]): Promise<boolean> {
  if (licensees !== undefined) {
    await preserveLicensedRemixesBeforeDelete(id, licensees);
  }
  const result = await songDb.delete(songs).where(eq(songs.id, id)).returning({ id: songs.id });
  if (result.length > 0) {
    await Promise.all([cacheDel(`songs:id:${id}`), invalidateMarketSongCache()]);
  }
  return result.length > 0;
}

export interface MarketQueryParams {
  sort?: 'new' | 'popular';
  limit?: number;
  offset?: number;
  creator?: string;
  genre?: string;
  search?: string;
  sinceMinutes?: number;
}

export interface MarketQueryResult {
  items: Song[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export async function queryPublicSongs(params: MarketQueryParams = {}): Promise<MarketQueryResult> {
  const limit = Math.min(Math.max(Number(params.limit) || 24, 1), 100);
  const offset = Math.max(Number(params.offset) || 0, 0);
  validatePagination(limit, offset);

  const conditions: any[] = [modePublicCondition()];

  if (params.creator && params.creator !== 'all') {
    let addresses: string[] = [];
    try {
      addresses = await resolveIdentityAddresses(params.creator);
    } catch {
      const pair = await getWalletPairByAddressOrNickname(params.creator);
      if (pair) {
        if (pair.evmAddress) addresses.push(pair.evmAddress);
        if (pair.svmAddress) addresses.push(pair.svmAddress);
      }
    }
    if (addresses.length === 0) {
      return { items: [], total: 0, limit, offset, hasMore: false };
    }
    conditions.push(inArray(songs.creator, addresses));
  }

  if (params.genre && params.genre !== 'all') {
    const g = params.genre.trim();
    conditions.push(sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${songs.genres}) AS tag
      WHERE lower(tag) = lower(${g}) OR lower(tag) = lower(${`genre:${g}`})
    )`);
  }

  if (params.search && params.search.trim()) {
    const pattern = `%${params.search.trim()}%`;
    const searchSlug = normalizeUrlSlug(params.search);
    const slugPattern = searchSlug ? `%${searchSlug}%` : pattern;
    conditions.push(sql`(
      ${songs.title} ILIKE ${pattern}
      OR REGEXP_REPLACE(LOWER(${songs.title}), '[\\s-]+', '-', 'g') LIKE ${slugPattern}
      OR ${songs.creator} ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${songs.genres}) AS tag
        WHERE tag ILIKE ${pattern}
      )
    )`);
  }

  if (params.sinceMinutes && Number.isFinite(params.sinceMinutes) && params.sinceMinutes > 0) {
    const mins = Math.floor(params.sinceMinutes);
    conditions.push(sql`coalesce(${songs.published_at}, ${songs.created_at}) >= NOW() - (${mins} * INTERVAL '1 minute')`);
  }

  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
  const publishedOrder = sql`coalesce(${songs.published_at}, ${songs.created_at}) desc`;
  const orderByClause = params.sort === 'popular'
    ? [desc(songs.plays), publishedOrder]
    : [publishedOrder];

  const [items, countRows] = await Promise.all([
    songDb
      .select()
      .from(songs)
      .where(whereClause)
      .orderBy(...orderByClause)
      .limit(limit)
      .offset(offset),
    songDb
      .select({ count: sql<number>`count(*)::int` })
      .from(songs)
      .where(whereClause),
  ]);

  const total = countRows[0]?.count ?? 0;
  return {
    items: items.map(toMarketSong),
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
  };
}

export interface MarketFoldGroup {
  key: string;
  label: string;
  total: number;
  image?: string | null;
  imageStatus?: 'pending' | 'ready' | 'failed';
  songs: Song[];
}

export interface MarketFoldsResponse {
  generatedAt: string;
  foldLimit: number;
  newReleases: {
    total: number;
    lastHourCount: number;
    songs: Song[];
  };
  popular: {
    total: number;
    songs: Song[];
  };
  genres: MarketFoldGroup[];
  creators: MarketFoldGroup[];
}

function extractPrimaryGenre(song: Pick<Song, 'genres' | 'tags'>): string {
  const candidates = Array.isArray(song.genres) && song.genres.length > 0 ? song.genres : song.tags;
  if (!Array.isArray(candidates)) return 'Uncategorized';
  const genreTag = candidates.find((t) => typeof t === 'string' && t.toLowerCase().startsWith('genre:'));
  if (genreTag) {
    const val = genreTag.slice(6).trim();
    return val && !isNonGenreTag(val) ? val : 'Uncategorized';
  }
  const fallback = candidates.find(
    (t) => typeof t === 'string' && !t.includes(':') && t.trim().length > 0 && !isNonGenreTag(t),
  );
  return fallback ? fallback.trim() : 'Uncategorized';
}

function groupSongsByFamilyLimit(rows: Song[], maxFamilies: number): Song[] {
  const familyOrder: string[] = [];
  const familyMap = new Map<string, Song[]>();
  for (const song of rows) {
    const fam = song.family || song.id;
    let bucket = familyMap.get(fam);
    if (!bucket) {
      if (familyOrder.length >= maxFamilies) continue;
      bucket = [];
      familyMap.set(fam, bucket);
      familyOrder.push(fam);
    }
    bucket.push(song);
  }
  const result: Song[] = [];
  for (const fam of familyOrder) {
    const bucket = familyMap.get(fam);
    if (bucket) result.push(...bucket);
  }
  return result;
}

export async function getMarketFolds(foldLimit = 50, windowMinutes = 60): Promise<MarketFoldsResponse> {
  const safeLimit = Math.min(Math.max(Number(foldLimit) || 50, 4), 100);
  const safeWindow = [15, 30, 60].includes(Number(windowMinutes)) ? Number(windowMinutes) : 60;
  const mode = getNetworkMode();
  const cacheKey = `${MARKET_FOLDS_CACHE_PREFIX}${mode}:${safeLimit}:${safeWindow}`;
  const cached = await cacheGet<MarketFoldsResponse>(cacheKey, 0);
  if (cached) return cached;

  const rawFetchLimit = Math.min(safeLimit * 3, 250);
  const windowCutoff = new Date(Date.now() - safeWindow * 60 * 1000).toISOString();
  const publicCond = modePublicCondition();

  const publishedOrder = sql`coalesce(${songs.published_at}, ${songs.created_at}) desc`;
  const [newReleasesRaw, popularRaw, recentPool, statsRows] = await Promise.all([
    songDb
      .select()
      .from(songs)
      .where(publicCond)
      .orderBy(publishedOrder)
      .limit(rawFetchLimit),
    songDb
      .select()
      .from(songs)
      .where(publicCond)
      .orderBy(desc(songs.plays), publishedOrder)
      .limit(rawFetchLimit),
    songDb
      .select()
      .from(songs)
      .where(publicCond)
      .orderBy(publishedOrder)
      .limit(250),
    songDb
      .select({
        total: sql<number>`count(*)::int`,
        lastHour: sql<number>`count(*) filter (where coalesce(${songs.published_at}, ${songs.created_at}) >= ${windowCutoff}::timestamptz)::int`,
      })
      .from(songs)
      .where(publicCond),
  ]);

  const newReleases = groupSongsByFamilyLimit(newReleasesRaw.map(toMarketSong), safeLimit);
  const popular = groupSongsByFamilyLimit(popularRaw.map(toMarketSong), safeLimit);
  const totalPublic = statsRows[0]?.total ?? recentPool.length;
  const lastHourCount = statsRows[0]?.lastHour ?? 0;

  const creatorOverrides = await resolveModeCreators(recentPool);
  const genreMap = new Map<string, Song[]>();
  const creatorMap = new Map<string, Song[]>();

  for (const rawSong of recentPool) {
    const song = toMarketSong(rawSong);
    const genre = extractPrimaryGenre(song);
    const gList = genreMap.get(genre) || [];
    gList.push(song);
    genreMap.set(genre, gList);

    const resolvedCreator = resolveRowCreator(rawSong, creatorOverrides) ?? song.creator;
    const creator = resolvedCreator.startsWith('0x') ? resolvedCreator.toLowerCase() : resolvedCreator;
    const cList = creatorMap.get(creator) || [];
    cList.push(song);
    creatorMap.set(creator, cList);
  }

  const topGenreEntries = Array.from(genreMap.entries())
    .sort((a, b) => {
      if (a[0] === 'Uncategorized') return 1;
      if (b[0] === 'Uncategorized') return -1;
      return b[1].length - a[1].length;
    })
    .slice(0, 16);

  const genreCoversBySlug = await ensureGenreCovers(topGenreEntries.map(([g]) => g));

  const genres: MarketFoldGroup[] = topGenreEntries.map(([genre, list]) => {
    const grouped = groupSongsByFamilyLimit(list, safeLimit);
    const slug = normalizeGenreSlug(genre);
    const coverInfo = slug ? genreCoversBySlug[slug] : undefined;
    return {
      key: genre,
      label: genre,
      total: new Set(list.map((s) => s.family || s.id)).size,
      image: coverInfo?.imageUrl ?? null,
      imageStatus: coverInfo?.status,
      songs: grouped,
    };
  });

  const creators: MarketFoldGroup[] = Array.from(creatorMap.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 16)
    .map(([creator, list]) => {
      const grouped = groupSongsByFamilyLimit(list, safeLimit);
      return {
        key: creator,
        label: creator,
        total: new Set(list.map((s) => s.family || s.id)).size,
        songs: grouped,
      };
    });

  const payload: MarketFoldsResponse = {
    generatedAt: new Date().toISOString(),
    foldLimit: safeLimit,
    newReleases: {
      total: totalPublic,
      lastHourCount,
      songs: newReleases,
    },
    popular: {
      total: totalPublic,
      songs: popular,
    },
    genres,
    creators,
  };

  await cacheSet(cacheKey, payload, MARKET_FOLDS_TTL, 0);
  return payload;
}

export async function incrementSongPlay(id: string, viewerKey?: string | string[]): Promise<Song | null> {
  const song = await getSongById(id);
  if (!song || !song.public) return song;

  const rawViewers = (Array.isArray(viewerKey) ? viewerKey : viewerKey ? [viewerKey] : [])
    .map(v => v.trim())
    .filter(Boolean);

  if (rawViewers.length > 0) {
    const creatorAddresses = new Set(
      (await resolveIdentityAddresses(song.creator)).map(a => (a.startsWith('0x') ? a.toLowerCase() : a)),
    );
    creatorAddresses.add(song.creator.startsWith('0x') ? song.creator.toLowerCase() : song.creator);

    for (const raw of rawViewers) {
      const normalized = raw.startsWith('0x') ? raw.toLowerCase() : raw;
      if (creatorAddresses.has(normalized)) return song;
      try {
        const parsed = parseAddress(raw).value;
        const normParsed = parsed.startsWith('0x') ? parsed.toLowerCase() : parsed;
        if (creatorAddresses.has(normParsed)) return song;
        const linked = await resolveIdentityAddresses(parsed);
        for (const addr of linked) {
          if (creatorAddresses.has(addr.startsWith('0x') ? addr.toLowerCase() : addr)) return song;
        }
      } catch {}
    }

    const dedupSubject = rawViewers[0].startsWith('0x') ? rawViewers[0].toLowerCase() : rawViewers[0];
    const dedupKey = `${PLAY_DEDUP_PREFIX}${id}:${dedupSubject}`;
    if (await cacheGet<number>(dedupKey)) return song;
    await cacheSet(dedupKey, 1, PLAY_DEDUP_TTL);
  }

  const result = await songDb
    .update(songs)
    .set({
      plays: sql`coalesce(${songs.plays}, 0) + 1`,
      last_played_at: new Date(),
    })
    .where(eq(songs.id, id))
    .returning();

  const updated = result[0] || null;
  if (updated) {
    await Promise.all([
      cacheSet(`songs:id:${id}`, updated, 120),
      invalidateMarketSongCache(),
    ]);
  }
  return updated;
}

export async function getFullSongProject(id: string): Promise<{
  song: Song | null;
  stems: Stem[];
  takes: Take[];
}> {
  const song = await getSongById(id);
  if (!song) return { song: null, stems: [], takes: [] };
  const songStems = await songDb.select().from(stems).where(eq(stems.song_id, id));
  const songTakes = await songDb.select().from(takes).where(eq(takes.song_id, id));
  return { song, stems: songStems, takes: songTakes };
}

export async function countUntitledSongsByCreator(creator: string): Promise<number> {
  const addresses = await resolveIdentityAddresses(creator);
  const result = await songDb
    .select({ count: sql<number>`count(*)::int` })
    .from(songs)
    .where(and(inArray(songs.creator, addresses), sql`${songs.title} ~* '^Untitled( #[0-9]+)?$'`));
  return result[0]?.count ?? 0;
}


export async function finalizeSong(songId: string, outputs: NewSong[], master: NewStem, versions: NewTake[]): Promise<void> {
  if (!outputs.length || outputs[0].id !== songId || master.song_id !== songId || !versions.length ||
    versions.some(take => take.song_id !== songId || take.stem_id !== master.id)) throw new Error('Invalid generation project');
  const receipt = versions[0].id;
  const pending = sql`not exists (select 1 from takes where id = ${receipt})`;
  const statements: any[] = [
    songDb.select({ id: songs.id }).from(songs).where(eq(songs.id, songId)).for('update'),
    songDb.execute(sql`select 1 / case when
      exists (select 1 from songs where id = ${songId} and (metadata_cid is null or not (${pending})))
      and not exists (select 1 from stems where id = ${master.id} and song_id <> ${songId})
      and not exists (select 1 from takes where id in (${sql.join(versions.map(take => sql`${take.id}`), sql`, `)})
        and (song_id <> ${songId} or stem_id is distinct from ${master.id}))
      then 1 else 0 end as valid`),
    songDb.update(songs).set({ url: outputs[0].url, duration: outputs[0].duration })
      .where(and(eq(songs.id, songId), pending)),
  ];
  for (const output of outputs.slice(1)) {
    const partitioned = partitionSongTags({
      genres: output.genres,
      production: output.production,
      mood: output.mood,
      vocal: output.vocal,
      tags: output.tags,
    });
    const isRemix = Boolean(output.is_remix ?? (output.source && output.source !== songId));
    statements.push(songDb.execute(sql`
      insert into songs (id, title, version, source, is_remix, creator, url, licenses, stream_price, license_price, duration, tags, genres, production, mood, vocal, image, album_id)
      select ${output.id}, ${output.title}, ${output.version ?? 1}, ${output.source ?? null}, ${isRemix}, ${output.creator}, ${output.url},
        ${isRemix ? 0 : output.licenses ?? 0}, ${output.stream_price ?? .02}, ${isRemix ? 0 : output.license_price ?? 25},
        ${output.duration ?? null},
        ${JSON.stringify(partitioned.genres)}::jsonb,
        ${JSON.stringify(partitioned.genres)}::jsonb,
        ${JSON.stringify(partitioned.production)}::jsonb,
        ${JSON.stringify(partitioned.mood)}::jsonb,
        ${JSON.stringify(partitioned.vocal)}::jsonb,
        ${output.image ?? null}, ${output.album_id ?? null}
      where ${pending} on conflict (id) do nothing
    `));
  }
  statements.push(songDb.execute(sql`
    insert into stems (id, song_id, name, url, waveform_peaks_url, volume, pan, is_muted, is_solo)
    select ${master.id}, ${songId}, ${master.name}, ${master.url}, ${master.waveform_peaks_url ?? null},
      ${master.volume ?? 1}, ${master.pan ?? 0}, ${master.is_muted ?? false}, ${master.is_solo ?? false}
    where ${pending} on conflict (id) do nothing
  `));
  for (const take of [...versions].reverse()) statements.push(songDb.execute(sql`
    insert into takes (id, song_id, stem_id, take_number, model, task, prompt, lyrics, repainting_start, repainting_end, url, waveform_url, is_active, seed, provenance)
    select ${take.id}, ${songId}, ${master.id}, ${take.take_number ?? 1}, ${take.model}, ${take.task}, ${take.prompt ?? null}, ${take.lyrics ?? null},
      ${take.repainting_start ?? null}, ${take.repainting_end ?? null}, ${take.url}, ${take.waveform_url ?? null}, ${take.is_active ?? false}, ${take.seed ?? null}, ${take.provenance ? JSON.stringify(take.provenance) : null}::jsonb
    where ${pending} on conflict (id) do nothing
  `));
  await songDb.batch(statements as [any, ...any[]]);
}

const COMMENTS_CACHE_TTL_SEC = 180;
const LIKES_CACHE_TTL_SEC = 180;

export async function getSongComments(songId: string): Promise<SongComment[]> {
  const cacheKey = `comments:song:${songId}`;
  const cached = await cacheGet<SongComment[]>(cacheKey);
  if (cached) return cached;

  const rows = await songDb
    .select()
    .from(songComments)
    .where(eq(songComments.song_id, songId))
    .orderBy(asc(songComments.timestamp_sec), asc(songComments.created_at));

  await cacheSet(cacheKey, rows, COMMENTS_CACHE_TTL_SEC);
  return rows;
}

export async function addSongComment(input: {
  songId: string;
  author: string;
  body: string;
  timestampSec: number;
}): Promise<SongComment> {
  const cleanBody = input.body.trim();
  if (!cleanBody || cleanBody.length > 280) {
    throw new RequestError('Comment must be between 1 and 280 characters', 400);
  }
  const parsedAuthor = parseAddress(input.author).value;
  const song = await getSongById(input.songId);
  if (!song) {
    throw new RequestError('Song not found', 404);
  }
  if (!song.public) {
    throw new RequestError('Comments are only enabled on published songs', 403);
  }

  const maxDur = typeof song.duration === 'number' && song.duration > 0 ? song.duration : 600;
  const clampedTime = Math.max(0, Math.min(maxDur, Number.isFinite(input.timestampSec) ? input.timestampSec : 0));
  const id = `cmt-${randomUUID()}`;

  const [inserted] = await songDb
    .insert(songComments)
    .values({
      id,
      song_id: input.songId,
      author: parsedAuthor,
      body: cleanBody,
      timestamp_sec: Number(clampedTime.toFixed(2)),
    })
    .returning();

  const [updatedSong] = await songDb
    .update(songs)
    .set({
      comments_count: sql`(SELECT count(*)::int FROM comments WHERE song_id = ${input.songId})`,
    })
    .where(eq(songs.id, input.songId))
    .returning();

  await Promise.all([
    cacheDel(`comments:song:${input.songId}`),
    updatedSong ? cacheSet(`songs:id:${input.songId}`, updatedSong, 120) : cacheDel(`songs:id:${input.songId}`),
    invalidateMarketSongCache(),
  ]);

  return inserted;
}

export async function deleteSongComment(
  songId: string,
  commentId: string,
  requesterAddress: string
): Promise<boolean> {
  const rows = await songDb
    .select()
    .from(songComments)
    .where(and(eq(songComments.id, commentId), eq(songComments.song_id, songId)))
    .limit(1);
  const existing = rows[0];
  if (!existing) return false;

  const requesterAddrs = await resolveIdentityAddresses(requesterAddress);
  const song = await getSongById(songId);
  const allowedAddrs = new Set(
    [
      existing.author,
      ...(song ? [song.creator] : []),
    ].map((a) => (a.startsWith('0x') ? a.toLowerCase() : a))
  );
  const isAuthorized = requesterAddrs.some((a) =>
    allowedAddrs.has(a.startsWith('0x') ? a.toLowerCase() : a)
  );
  if (!isAuthorized) {
    throw new RequestError('Not authorized to delete this comment', 403);
  }

  await songDb.delete(songComments).where(eq(songComments.id, commentId));
  const [updatedSong] = await songDb
    .update(songs)
    .set({
      comments_count: sql`(SELECT count(*)::int FROM comments WHERE song_id = ${songId})`,
    })
    .where(eq(songs.id, songId))
    .returning();

  await Promise.all([
    cacheDel(`comments:song:${songId}`),
    updatedSong ? cacheSet(`songs:id:${songId}`, updatedSong, 120) : cacheDel(`songs:id:${songId}`),
    invalidateMarketSongCache(),
  ]);

  return true;
}

export async function getUserLikedSongIds(userAddress: string): Promise<string[]> {
  const addrs = await resolveIdentityAddresses(userAddress);
  if (!addrs.length) return [];
  const primary = addrs[0];
  const cacheKey = `likes:user:${primary}`;
  const cached = await cacheGet<string[]>(cacheKey);
  if (cached) return cached;

  const rows = await songSql`
    SELECT l.song_id, MAX(l.created_at) AS latest
    FROM likes l
    JOIN songs s ON s.id = l.song_id
    WHERE l.user_address = ANY(${addrs})
      AND s.public = true
    GROUP BY l.song_id
    ORDER BY latest DESC
  `;
  const ids = rows.map((r: any) => String(r.song_id));
  await cacheSet(cacheKey, ids, LIKES_CACHE_TTL_SEC);
  return ids;
}

export async function toggleSongLike(
  songId: string,
  userAddress: string,
  explicitLike?: boolean
): Promise<{ songId: string; liked: boolean; likesCount: number }> {
  const addrs = await resolveIdentityAddresses(userAddress);
  const canonicalUser = addrs[0] || parseAddress(userAddress).value;

  const song = await getSongById(songId);
  if (!song) throw new RequestError('Song not found', 404);
  if (!song.public) throw new RequestError('Likes are only enabled on published songs', 403);

  const existing = await songSql`
    SELECT 1 FROM likes
    WHERE song_id = ${songId}
      AND user_address = ANY(${addrs})
    LIMIT 1
  `;
  const isCurrentlyLiked = existing.length > 0;
  const shouldLike = explicitLike !== undefined ? explicitLike : !isCurrentlyLiked;

  if (shouldLike && !isCurrentlyLiked) {
    await songSql`
      INSERT INTO likes (song_id, user_address)
      VALUES (${songId}, ${canonicalUser})
      ON CONFLICT (song_id, user_address) DO NOTHING
    `;
  } else if (!shouldLike && isCurrentlyLiked) {
    await songSql`
      DELETE FROM likes
      WHERE song_id = ${songId}
        AND user_address = ANY(${addrs})
    `;
  }

  const [updatedSong] = await songDb
    .update(songs)
    .set({
      likes: sql`(SELECT count(DISTINCT user_address)::int FROM likes WHERE song_id = ${songId})`,
    })
    .where(eq(songs.id, songId))
    .returning();

  const likesCount = Number(updatedSong?.likes ?? 0);

  await Promise.all([
    ...addrs.map((a) => cacheDel(`likes:user:${a}`)),
    updatedSong ? cacheSet(`songs:id:${songId}`, updatedSong, 120) : cacheDel(`songs:id:${songId}`),
    invalidateMarketSongCache(),
  ]);

  return {
    songId,
    liked: shouldLike,
    likesCount,
  };
}
