import { eq, desc, inArray, sql } from 'drizzle-orm';
import { songDb } from './client.js';
import { playlists, type Playlist, type NewPlaylist } from './schema/playlists.js';
import { songs, type Song } from './schema/songs.js';
import { resolveIdentityAddresses, RequestError } from './users.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';

const PLAYLIST_CACHE_TTL = 90;

export async function createPlaylist(data: NewPlaylist): Promise<Playlist> {
  const creator = /^0x/i.test(data.creator) ? data.creator.toLowerCase() : data.creator;
  const cleanIds = Array.isArray(data.song_ids)
    ? Array.from(new Set(data.song_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
    : [];

  const [created] = await songDb
    .insert(playlists)
    .values({
      ...data,
      creator,
      song_ids: cleanIds,
      public: data.public ?? false,
      plays: data.plays ?? 0,
      updated_at: new Date(),
    })
    .returning();

  await Promise.all([
    cacheDel('playlists:public'),
    cacheDel(`playlists:creator:${creator}`),
  ]);
  return created;
}

export async function getPlaylistById(id: string): Promise<Playlist | null> {
  const cached = await cacheGet<Playlist>(`playlists:id:${id}`);
  if (cached) return cached;
  const [playlist] = await songDb.select().from(playlists).where(eq(playlists.id, id)).limit(1);
  if (playlist) {
    await cacheSet(`playlists:id:${id}`, playlist, PLAYLIST_CACHE_TTL);
  }
  return playlist || null;
}

export async function getPlaylistWithSongs(id: string): Promise<{ playlist: Playlist | null; songs: Song[] }> {
  const playlist = await getPlaylistById(id);
  if (!playlist) return { playlist: null, songs: [] };

  const ids = Array.isArray(playlist.song_ids) ? playlist.song_ids.filter(Boolean) : [];
  if (ids.length === 0) return { playlist, songs: [] };

  const rows = await songDb
    .select()
    .from(songs)
    .where(inArray(songs.id, ids));

  const map = new Map(rows.map((s) => [s.id, s]));
  const ordered = ids.map((songId) => map.get(songId)).filter((s): s is Song => Boolean(s));
  return { playlist, songs: ordered };
}

export async function getPublicPlaylists(limit = 50, offset = 0): Promise<Playlist[]> {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  if (safeLimit === 50 && safeOffset === 0) {
    const cached = await cacheGet<Playlist[]>('playlists:public');
    if (cached) return cached;
  }

  const rows = await songDb
    .select()
    .from(playlists)
    .where(eq(playlists.public, true))
    .orderBy(desc(playlists.plays), desc(playlists.updated_at))
    .limit(safeLimit)
    .offset(safeOffset);

  if (safeLimit === 50 && safeOffset === 0) {
    await cacheSet('playlists:public', rows, PLAYLIST_CACHE_TTL);
  }
  return rows;
}

export async function getPlaylistsByCreator(creator: string): Promise<Playlist[]> {
  const addresses = await resolveIdentityAddresses(creator);
  if (addresses.length === 0) return [];
  return await songDb
    .select()
    .from(playlists)
    .where(inArray(playlists.creator, addresses))
    .orderBy(desc(playlists.updated_at));
}

export async function updatePlaylist(
  id: string,
  updates: Partial<Pick<NewPlaylist, 'title' | 'description' | 'cover' | 'song_ids' | 'public'>>,
): Promise<Playlist | null> {
  const patch: Record<string, any> = { updated_at: new Date() };
  if (typeof updates.title === 'string') patch.title = updates.title.trim();
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.cover !== undefined) patch.cover = updates.cover;
  if (typeof updates.public === 'boolean') patch.public = updates.public;
  if (Array.isArray(updates.song_ids)) {
    patch.song_ids = Array.from(
      new Set(updates.song_ids.filter((sid): sid is string => typeof sid === 'string' && sid.trim().length > 0)),
    );
  }

  const [updated] = await songDb
    .update(playlists)
    .set(patch)
    .where(eq(playlists.id, id))
    .returning();

  if (updated) {
    await Promise.all([
      cacheSet(`playlists:id:${id}`, updated, PLAYLIST_CACHE_TTL),
      cacheDel('playlists:public'),
      cacheDel(`playlists:creator:${updated.creator}`),
    ]);
  }
  return updated || null;
}

export async function addSongToPlaylist(id: string, songId: string): Promise<Playlist | null> {
  const existing = await getPlaylistById(id);
  if (!existing) throw new RequestError('Playlist not found', 404);
  const current = Array.isArray(existing.song_ids) ? existing.song_ids : [];
  if (current.includes(songId)) return existing;
  return await updatePlaylist(id, { song_ids: [...current, songId] });
}

export async function removeSongFromPlaylist(id: string, songId: string): Promise<Playlist | null> {
  const existing = await getPlaylistById(id);
  if (!existing) throw new RequestError('Playlist not found', 404);
  const current = Array.isArray(existing.song_ids) ? existing.song_ids : [];
  return await updatePlaylist(id, { song_ids: current.filter((item) => item !== songId) });
}

export async function deletePlaylist(id: string): Promise<boolean> {
  const existing = await getPlaylistById(id);
  const result = await songDb.delete(playlists).where(eq(playlists.id, id)).returning({ id: playlists.id });
  if (result.length > 0) {
    await Promise.all([
      cacheDel(`playlists:id:${id}`),
      cacheDel('playlists:public'),
      existing ? cacheDel(`playlists:creator:${existing.creator}`) : Promise.resolve(),
    ]);
    return true;
  }
  return false;
}
