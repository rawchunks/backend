import { eq, desc, inArray, sql, and } from 'drizzle-orm';
import { songDb } from './client.js';
import { songs, type Song, type NewSong } from './schema/songs.js';
import { stems, type Stem, type NewStem } from './schema/stems.js';
import { takes, type Take, type NewTake } from './schema/takes.js';
import { commits } from './schema/commits.js';
import { resolveIdentityAddresses, RequestError } from './users.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';
import { ensureGenreCovers, normalizeGenreSlug } from './genres.js';
import { isNonGenreTag, partitionSongTags } from '../options.js';
import { randomUUID } from 'node:crypto';

const MARKET_FOLDS_CACHE_PREFIX = 'songs:market:folds:';
const MARKET_FOLDS_TTL = 60;
const PLAY_DEDUP_PREFIX = 'songs:play-dedup:';
const PLAY_DEDUP_TTL = 45;

export async function invalidateMarketSongCache(): Promise<void> {
  const keys = ['songs:all'];
  for (const limit of [12, 20, 50]) {
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
  const result = await songDb.insert(songs).values({
    ...songData,
    tags: partitioned.genres,
    genres: partitioned.genres,
    production: partitioned.production,
    mood: partitioned.mood,
    vocal: partitioned.vocal,
    ...(songData.source ? { licenses: 0, license_price: 0 } : {}),
    creator: /^0x/i.test(songData.creator) ? songData.creator.toLowerCase() : songData.creator,
  }).returning();
  if (partitioned.genres.length > 0) {
    void ensureGenreCovers(partitioned.genres).catch(() => {});
  }
  await invalidateMarketSongCache();
  return result[0];
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
    insert into songs (id, title, family, basis, creator, source, version, url, duration, tags, genres, production, mood, vocal, licenses, stream_price, license_price, network, image, album_id)
    select ${next}, title, ${family}, ${id}, creator, source,
      (select coalesce(max(version), 0) + 1 from songs where coalesce(family, id) = ${family}),
      url, duration, tags, genres, production, mood, vocal, case when source is null then licenses else 0 end, stream_price, case when source is null then license_price else 0 end, network, image, album_id
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
    .orderBy(desc(songs.created_at)).$dynamic();
  if (limit !== undefined) query.limit(limit);
  if (offset) query.offset(offset);
  return await query;
}

function validatePagination(limit: number | undefined, offset: number) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('Song limit must be a positive safe integer');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Song offset must be a nonnegative safe integer');
}

export async function updateSong(id: string, updates: Partial<NewSong>): Promise<Song | null> {
  if (['id', 'creator', 'created_at'].some((key) => key in updates)) throw new Error('Song identity and ownership cannot be updated');
  if (['url', 'duration', 'source', 'version', 'family', 'basis', 'licenses', 'license_price'].some(key => key in updates)) {
    const song = await getSongById(id);
    if (song?.metadata_cid && ['url', 'duration', 'source', 'version', 'family', 'basis'].some(key => key in updates)) throw new RequestError('Open an editable version before changing this song', 409);
    if ((song?.source || updates.source) && (updates.licenses || updates.license_price)) throw new RequestError('Remixes cannot be licensed');
  }
  const normalizedUpdates: Partial<NewSong> = { ...updates };
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
    void ensureGenreCovers(normalizedUpdates.genres).catch(() => {});
  }
  await invalidateMarketSongCache();
  return result[0] || null;
}

export async function deleteSong(id: string): Promise<boolean> {
  const result = await songDb.delete(songs).where(eq(songs.id, id)).returning({ id: songs.id });
  if (result.length > 0) {
    await invalidateMarketSongCache();
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
    const addresses = await resolveIdentityAddresses(params.creator);
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
    conditions.push(sql`(
      ${songs.title} ILIKE ${pattern}
      OR ${songs.creator} ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${songs.genres}) AS tag
        WHERE tag ILIKE ${pattern}
      )
    )`);
  }

  if (params.sinceMinutes && Number.isFinite(params.sinceMinutes) && params.sinceMinutes > 0) {
    const mins = Math.floor(params.sinceMinutes);
    conditions.push(sql`${songs.created_at} >= NOW() - (${mins} * INTERVAL '1 minute')`);
  }

  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
  const orderByClause = params.sort === 'popular'
    ? [desc(songs.plays), desc(songs.created_at)]
    : [desc(songs.created_at)];

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
    items,
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

  const [newReleasesRaw, popularRaw, recentPool, statsRows] = await Promise.all([
    songDb
      .select()
      .from(songs)
      .where(eq(songs.public, true))
      .orderBy(desc(songs.created_at))
      .limit(rawFetchLimit),
    songDb
      .select()
      .from(songs)
      .where(eq(songs.public, true))
      .orderBy(desc(songs.plays), desc(songs.created_at))
      .limit(rawFetchLimit),
    songDb
      .select()
      .from(songs)
      .where(eq(songs.public, true))
      .orderBy(desc(songs.created_at))
      .limit(250),
    songDb
      .select({
        total: sql<number>`count(*)::int`,
        lastHour: sql<number>`count(*) filter (where ${songs.created_at} >= ${windowCutoff}::timestamptz)::int`,
      })
      .from(songs)
      .where(eq(songs.public, true)),
  ]);

  const newReleases = groupSongsByFamilyLimit(newReleasesRaw, safeLimit);
  const popular = groupSongsByFamilyLimit(popularRaw, safeLimit);
  const totalPublic = statsRows[0]?.total ?? recentPool.length;
  const lastHourCount = statsRows[0]?.lastHour ?? 0;

  const genreMap = new Map<string, Song[]>();
  const creatorMap = new Map<string, Song[]>();

  for (const song of recentPool) {
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

export async function incrementSongPlay(id: string, viewerKey?: string): Promise<Song | null> {
  if (viewerKey) {
    const dedupKey = `${PLAY_DEDUP_PREFIX}${id}:${viewerKey}`;
    const alreadyCounted = await cacheGet<number>(dedupKey);
    if (alreadyCounted) {
      return await getSongById(id);
    }
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
  if (!song) {
    return { song: null, stems: [], takes: [] };
  }
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
    statements.push(songDb.execute(sql`
      insert into songs (id, title, version, source, creator, url, licenses, stream_price, license_price, duration, tags, genres, production, mood, vocal, image, album_id)
      select ${output.id}, ${output.title}, ${output.version ?? 1}, ${output.source ?? null}, ${output.creator}, ${output.url},
        ${output.source ? 0 : output.licenses ?? 0}, ${output.stream_price ?? .02}, ${output.source ? 0 : output.license_price ?? 25},
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
