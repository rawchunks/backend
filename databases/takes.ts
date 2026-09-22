import { eq, and, sql, inArray } from 'drizzle-orm';
import { songDb } from './client.js';
import { takes, type Take, type NewTake } from './schema/takes.js';
import { songs } from './schema/songs.js';
import { stems, type NewStem } from './schema/stems.js';
import { commits, type NewCommit } from './schema/commits.js';

export async function createTake(takeData: NewTake): Promise<Take> {
  const insert = songDb
    .insert(takes)
    .values(takeData.is_active ? { ...takeData, is_active: false } : takeData)
    .onConflictDoUpdate({
      target: takes.id,
      set: {
        url: takeData.url,
        is_active: takeData.is_active ? false : takeData.is_active,
      },
      setWhere: and(eq(takes.song_id, takeData.song_id), sql`${takes.stem_id} is not distinct from ${takeData.stem_id ?? null}`),
    })
    .returning();
  const scope = takeScope(takeData.song_id, takeData.stem_id ?? null);
  const result = takeData.is_active
    ? (await songDb.batch([
      songDb.select({ id: songs.id }).from(songs).where(eq(songs.id, takeData.song_id)).for('update'),
      insert,
      songDb.update(takes).set({ is_active: false }).where(and(scope, sql`exists (
        select 1 from takes target where target.id = ${takeData.id} and target.song_id = ${takeData.song_id}
        and target.stem_id is not distinct from ${takeData.stem_id ?? null}
      )`)),
      songDb.update(takes).set({ is_active: true }).where(and(eq(takes.id, takeData.id), eq(takes.song_id, takeData.song_id), sql`${takes.stem_id} is not distinct from ${takeData.stem_id ?? null}`)).returning(),
    ]))[3]
    : await insert;
  if (!result[0]) throw new Error('Take ID belongs to another song or stem');
  return result[0];
}

export async function listTakesBySong(songId: string): Promise<Take[]> {
  return await songDb.select().from(takes).where(eq(takes.song_id, songId));
}

export async function getTakeById(id: string): Promise<Take | null> {
  const result = await songDb.select().from(takes).where(eq(takes.id, id)).limit(1);
  return result[0] ?? null;
}

export async function listTakesByStem(songId: string, stemId: string): Promise<Take[]> {
  return await songDb
    .select()
    .from(takes)
    .where(and(eq(takes.song_id, songId), eq(takes.stem_id, stemId)));
}

export async function activateTake(songId: string, stemId: string | null, takeId: string, merge?: { stem?: NewStem; take?: NewTake; consume?: string[]; remaining?: { id: string; provenance: Take['provenance'] }[]; commit: NewCommit; master: boolean; duration?: number; url?: string; provenance?: Take['provenance'] }): Promise<void> {
  if (merge) {
    // Persist the lane, selected take, playback URLs and history in one Neon
    // transaction. A failed write leaves the original arrangement intact.
    const target = and(eq(takes.song_id, songId), eq(takes.id, takeId));
    const scope = and(eq(takes.song_id, songId), sql`${takes.stem_id} is not distinct from ${stemId}`);
    const statements: any[] = [songDb.select({ id: songs.id }).from(songs).where(eq(songs.id, songId)).for('update')];
    if (merge.take) statements.push(songDb.insert(takes).values({ ...merge.take, is_active: false }).onConflictDoNothing());
    if (merge.consume?.length) statements.push(songDb.delete(takes).where(and(eq(takes.song_id, songId), inArray(takes.id, merge.consume))));
    for (const candidate of merge.remaining ?? []) statements.push(songDb.update(takes).set({ provenance: candidate.provenance }).where(and(eq(takes.song_id, songId), eq(takes.id, candidate.id))));
    if (merge.url) statements.push(songDb.update(takes).set({ url: merge.url, ...(merge.provenance ? { provenance: merge.provenance } : {}) }).where(target));
    if (merge.stem) {
      statements.push(songDb.insert(stems).values(merge.stem).onConflictDoNothing());
      statements.push(songDb.update(takes).set({ stem_id: merge.stem.id }).where(target));
    }
    statements.push(songDb.update(takes).set({ is_active: false }).where(scope));
    statements.push(songDb.update(takes).set({ is_active: true }).where(target));
    if (stemId !== null) statements.push(songDb.update(stems).set({ url: sql`(select url from takes where id = ${takeId} and song_id = ${songId})` }).where(and(eq(stems.id, stemId), eq(stems.song_id, songId))));
    if (merge.master) statements.push(songDb.update(songs).set({ url: sql`(select url from takes where id = ${takeId} and song_id = ${songId})`, ...(merge.duration === undefined ? {} : { duration: merge.duration }) }).where(eq(songs.id, songId)));
    statements.push(songDb.insert(commits).values(merge.commit));
    await songDb.batch(statements as [any, ...any[]]);
    return;
  }
  const target = and(eq(takes.song_id, songId), eq(takes.id, takeId), stemId === null ? undefined : eq(takes.stem_id, stemId));
  // Neon HTTP supports noninteractive batches. Lock the parent first so each
  // later statement observes the preceding selection at READ COMMITTED.
  await songDb.batch([
    songDb.select({ id: songs.id }).from(songs).where(eq(songs.id, songId)).for('update'),
    songDb.select({ id: takes.id }).from(takes).where(target).for('update'),
    songDb.update(takes).set({ is_active: false }).where(and(takeScope(songId, stemId), sql`exists (
      select 1 from takes target where target.id = ${takeId} and target.song_id = ${songId}
      and (${stemId}::text is null or target.stem_id = ${stemId})
    )`)),
    songDb.update(takes).set({ is_active: true }).where(target),
  ]);
}

function takeScope(songId: string, stemId: string | null) {
  // A null stem keeps the existing song-wide selection behavior.
  return and(eq(takes.song_id, songId), stemId === null ? undefined : eq(takes.stem_id, stemId));
}

export async function deleteTake(id: string, songId?: string, inactiveOnly = false): Promise<boolean> {
  const result = await songDb.delete(takes).where(and(eq(takes.id, id), songId === undefined ? undefined : eq(takes.song_id, songId), inactiveOnly ? eq(takes.is_active, false) : undefined)).returning({ id: takes.id });
  return result.length > 0;
}
