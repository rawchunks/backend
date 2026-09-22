import { eq, desc, inArray, sql, and } from 'drizzle-orm';
import { songDb } from './client.js';
import { songs, type Song, type NewSong } from './schema/songs.js';
import { stems, type Stem, type NewStem } from './schema/stems.js';
import { takes, type Take, type NewTake } from './schema/takes.js';
import { commits } from './schema/commits.js';
import { getWalletPair, RequestError } from './users.js';
import { randomUUID } from 'node:crypto';

export async function createSong(songData: NewSong): Promise<Song> {
  const result = await songDb.insert(songs).values({ ...songData, ...(songData.source ? { licenses: 0, license_price: 0 } : {}), creator: /^0x/i.test(songData.creator) ? songData.creator.toLowerCase() : songData.creator }).returning();
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
    insert into songs (id, title, family, basis, creator, source, version, url, duration, tags, licenses, stream_price, license_price, network, image, album_id)
    select ${next}, title, ${family}, ${id}, creator, source,
      (select coalesce(max(version), 0) + 1 from songs where coalesce(family, id) = ${family}),
      url, duration, tags, case when source is null then licenses else 0 end, stream_price, case when source is null then license_price else 0 end, network, image, album_id
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
  const addr = /^0x/i.test(creatorAddress) ? creatorAddress.toLowerCase() : creatorAddress;
  const addresses = [addr];
  try {
    const pair = await getWalletPair(addr);
    if (pair) {
      if (pair.evmAddress && !addresses.includes(pair.evmAddress.toLowerCase())) {
        addresses.push(pair.evmAddress.toLowerCase());
      }
      if (pair.svmAddress && !addresses.includes(pair.svmAddress)) {
        addresses.push(pair.svmAddress);
      }
    }
  } catch (error) { throw error; }

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
  const result = await songDb
    .update(songs)
    .set(updates)
    .where(eq(songs.id, id))
    .returning();
  return result[0] || null;
}

export async function deleteSong(id: string): Promise<boolean> {
  const result = await songDb.delete(songs).where(eq(songs.id, id)).returning({ id: songs.id });
  return result.length > 0;
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
  const normalized = /^0x/i.test(creator) ? creator.toLowerCase() : creator;
  const result = await songDb
    .select({ count: sql<number>`count(*)::int` })
    .from(songs)
    .where(and(eq(songs.creator, normalized), sql`${songs.title} ~* '^Untitled( #[0-9]+)?$'`));
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
  for (const output of outputs.slice(1)) statements.push(songDb.execute(sql`
    insert into songs (id, title, version, source, creator, url, licenses, stream_price, license_price, duration, tags, image, album_id)
    select ${output.id}, ${output.title}, ${output.version ?? 1}, ${output.source ?? null}, ${output.creator}, ${output.url},
      ${output.source ? 0 : output.licenses ?? 0}, ${output.stream_price ?? .02}, ${output.source ? 0 : output.license_price ?? 25},
      ${output.duration ?? null}, ${JSON.stringify(output.tags ?? [])}::jsonb, ${output.image ?? null}, ${output.album_id ?? null}
    where ${pending} on conflict (id) do nothing
  `));
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
