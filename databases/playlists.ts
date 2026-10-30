import { eq, desc, inArray, sql } from 'drizzle-orm';
import { songDb } from './client.js';
import { playlists, type Playlist, type NewPlaylist } from './schema/playlists.js';
import { songs, type Song } from './schema/songs.js';
import { resolveIdentityAddresses, RequestError } from './users.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';

const PLAYLIST_CACHE_TTL = 90;

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


