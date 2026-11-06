import { eq, desc, asc, inArray, sql, and } from 'drizzle-orm';
import { songDb, songSql } from './client.js';
import { songs, songComments, songLikes, type Song, type NewSong, type SongComment } from './schema/songs.js';
import { stems, type Stem, type NewStem } from './schema/stems.js';
import { takes, type Take, type NewTake } from './schema/takes.js';
import { commits } from './schema/commits.js';
import { resolveIdentityAddresses, getWalletPairByAddressOrNickname, normalizeUrlSlug, parseAddress, RequestError } from './users.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';
import { ensureGenreCovers, normalizeGenreSlug } from './genres.js';
import { isNonGenreTag, partitionSongTags } from '../options.js';
import { randomUUID } from 'node:crypto';

const MARKET_FOLDS_CACHE_PREFIX = 'songs:market:folds:';
const MARKET_FOLDS_TTL = 60;
const PLAY_DEDUP_PREFIX = 'songs:play-dedup:';
const PLAY_DEDUP_TTL = 45;

function toMarketSong(song: Song): Song {
  return song.published_at ? { ...song, created_at: song.published_at } : song;
}

export async function invalidateMarketSongCache(): Promise<void> {
  const keys = ['songs:all'];
  for (const limit of [12, 20, 50, 100]) {
    keys.push(`${MARKET_FOLDS_CACHE_PREFIX}${limit}`);
    for (const win of [15, 30, 60]) {
      keys.push(`${MARKET_FOLDS_CACHE_PREFIX}${limit}:${win}`);
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
  let parentChainSongId = songData.parent_chain_song_id ?? null;
  let inheritedNetwork = songData.network ?? null;
  if (songData.source && (!parentChainSongId || !inheritedNetwork)) {
    const parentSong = await getSongById(songData.source);
    if (parentSong) {
      if (!parentChainSongId && parentSong.chain_song_id) {
        parentChainSongId = parentSong.chain_song_id;
      }
      if (!inheritedNetwork && parentSong.network) {
        inheritedNetwork = parentSong.network;
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
    parent_chain_song_id: parentChainSongId,
    network: inheritedNetwork,
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
  const statements: any[] = [
    songDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${family}, 0))`),
    songDb.execute(sql`
    insert into songs (id, title, family, basis, creator, source, is_remix, parent_chain_song_id, version, url, duration, tags, genres, production, mood, vocal, licenses, stream_price, license_price, network, image, album_id)
    select ${next}, title, ${family}, ${id}, creator, source, is_remix, parent_chain_song_id,
      (select coalesce(max(version), 0) + 1 from songs where coalesce(family, id) = ${family}),
      url, duration, tags, genres, production, mood, vocal, case when source is null and not is_remix then licenses else 0 end, stream_price, case when source is null and not is_remix then license_price else 0 end, network, image, album_id
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
    .where(eq(songs.public, true))
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

export async function updateSong(id: string, updates: Partial<NewSong>): Promise<Song | null> {
  if (['id', 'creator', 'created_at', 'published_at'].some((key) => key in updates)) throw new Error('Song identity and ownership cannot be updated');
  let song: Song | null = null;
  if (['url', 'duration', 'source', 'is_remix', 'version', 'family', 'basis', 'licenses', 'license_price', 'chain_song_id', 'tx_hash', 'public'].some(key => key in updates)) {
    song = await getSongById(id);
    if (song?.metadata_cid && ['url', 'duration', 'source', 'is_remix', 'version', 'family', 'basis'].some(key => key in updates)) throw new RequestError('Open an editable version before changing this song', 409);
    if ((song?.source || song?.is_remix || updates.source || updates.is_remix) && (updates.licenses || updates.license_price)) throw new RequestError('Remixes cannot be licensed');
  }
  const normalizedUpdates: Partial<NewSong> = { ...updates };
  if (updates.source) {
    normalizedUpdates.is_remix = true;
  }
  if (
    (updates.chain_song_id && !song?.chain_song_id) ||
    (updates.tx_hash && !song?.tx_hash) ||
    (updates.public === true && !song?.public)
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
  await Promise.all([cacheDel(`songs:id:${id}`), invalidateMarketSongCache()]);
  return result[0] || null;
}

export async function preserveLicensedRemixesBeforeDelete(id: string, licensees?: string[]): Promise<void> {
  const song = await getSongById(id);
  if (!song || song.source || song.is_remix) return;

  const sourceStems = await songDb.select().from(stems).where(eq(stems.song_id, id));
  const existingRemixes = await songDb.select().from(songs).where(eq(songs.source, id));
  if (existingRemixes.length > 0) {
    await songDb
      .update(songs)
      .set({
        is_remix: true,
        parent_chain_song_id: sql`coalesce(${songs.parent_chain_song_id}, ${song.chain_song_id ?? null})`,
        network: sql`coalesce(${songs.network}, ${song.network ?? null})`,
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
        parent_chain_song_id: song.chain_song_id ?? null,
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
        network: song.network ?? null,
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

  const conditions: any[] = [eq(songs.public, true)];

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
  const cacheKey = `${MARKET_FOLDS_CACHE_PREFIX}${safeLimit}:${safeWindow}`;
  const cached = await cacheGet<MarketFoldsResponse>(cacheKey);
  if (cached) return cached;

  const rawFetchLimit = Math.min(safeLimit * 3, 250);
  const windowCutoff = new Date(Date.now() - safeWindow * 60 * 1000).toISOString();

  const publishedOrder = sql`coalesce(${songs.published_at}, ${songs.created_at}) desc`;
  const [newReleasesRaw, popularRaw, recentPool, statsRows] = await Promise.all([
    songDb
      .select()
      .from(songs)
      .where(eq(songs.public, true))
      .orderBy(publishedOrder)
      .limit(rawFetchLimit),
    songDb
      .select()
      .from(songs)
      .where(eq(songs.public, true))
      .orderBy(desc(songs.plays), publishedOrder)
      .limit(rawFetchLimit),
    songDb
      .select()
      .from(songs)
      .where(eq(songs.public, true))
      .orderBy(publishedOrder)
      .limit(250),
    songDb
      .select({
        total: sql<number>`count(*)::int`,
        lastHour: sql<number>`count(*) filter (where coalesce(${songs.published_at}, ${songs.created_at}) >= ${windowCutoff}::timestamptz)::int`,
      })
      .from(songs)
      .where(eq(songs.public, true)),
  ]);

  const newReleases = groupSongsByFamilyLimit(newReleasesRaw.map(toMarketSong), safeLimit);
  const popular = groupSongsByFamilyLimit(popularRaw.map(toMarketSong), safeLimit);
  const totalPublic = statsRows[0]?.total ?? recentPool.length;
  const lastHourCount = statsRows[0]?.lastHour ?? 0;

  const genreMap = new Map<string, Song[]>();
  const creatorMap = new Map<string, Song[]>();

  for (const rawSong of recentPool) {
    const song = toMarketSong(rawSong);
    const genre = extractPrimaryGenre(song);
    const gList = genreMap.get(genre) || [];
    gList.push(song);
    genreMap.set(genre, gList);

    const creator = song.creator;
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

  await cacheSet(cacheKey, payload, MARKET_FOLDS_TTL);
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

export async function getDeletedParentSongProject(id: string): Promise<{
  song: Song | null;
  stems: Stem[];
  takes: Take[];
}> {
  const remixRows = await songDb
    .select()
    .from(songs)
    .where(eq(songs.source, id))
    .limit(10);
  const candidate = remixRows.find((r) => Boolean(r.parent_chain_song_id)) ?? remixRows[0];
  if (!candidate) {
    return { song: null, stems: [], takes: [] };
  }
  const synthesizedSong: Song = {
    ...candidate,
    id,
    family: id,
    basis: null,
    source: null,
    is_remix: false,
    parent_chain_song_id: null,
    chain_song_id: candidate.parent_chain_song_id ?? null,
    public: true,
  };
  const remixStems = await songDb.select().from(stems).where(eq(stems.song_id, candidate.id));
  return { song: synthesizedSong, stems: remixStems, takes: [] };
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
      insert into songs (id, title, version, source, is_remix, parent_chain_song_id, creator, url, licenses, stream_price, license_price, duration, tags, genres, production, mood, vocal, image, album_id)
      select ${output.id}, ${output.title}, ${output.version ?? 1}, ${output.source ?? null}, ${isRemix}, ${output.parent_chain_song_id ?? null}, ${output.creator}, ${output.url},
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
