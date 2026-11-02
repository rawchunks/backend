import { eq, desc, inArray } from 'drizzle-orm';
import { songDb } from './client.js';
import { albums, type Album, type NewAlbum } from './schema/albums.js';
import { songs } from './schema/songs.js';
import { resolveIdentityAddresses } from './users.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';

const ALBUM_CACHE_TTL = 90;

export async function createAlbum(data: NewAlbum): Promise<Album> {
  const [album] = await songDb.insert(albums).values(data).returning();
  await Promise.all([cacheDel('albums:public'), cacheDel(`albums:creator:${album.creator}`)]);
  return album;
}

export async function getAlbumById(id: string): Promise<Album | null> {
  const cached = await cacheGet<Album>(`albums:id:${id}`);
  if (cached) return cached;
  const [album] = await songDb.select().from(albums).where(eq(albums.id, id));
  if (album) await cacheSet(`albums:id:${id}`, album, ALBUM_CACHE_TTL);
  return album || null;
}

export async function listAlbumsByCreator(creator: string): Promise<Album[]> {
  const addresses = await resolveIdentityAddresses(creator);
  return songDb
    .select()
    .from(albums)
    .where(inArray(albums.creator, addresses))
    .orderBy(desc(albums.created_at));
}

export async function listPublicAlbums(): Promise<Album[]> {
  const cached = await cacheGet<Album[]>('albums:public');
  if (cached) return cached;
  const rows = await songDb
    .select()
    .from(albums)
    .where(eq(albums.public, true))
    .orderBy(desc(albums.created_at));
  await cacheSet('albums:public', rows, ALBUM_CACHE_TTL);
  return rows;
}

export async function updateAlbum(id: string, data: Partial<Omit<NewAlbum, 'id' | 'created_at'>>): Promise<Album | null> {
  const [updated] = await songDb
    .update(albums)
    .set(data)
    .where(eq(albums.id, id))
    .returning();
  if (updated) {
    await Promise.all([
      cacheSet(`albums:id:${id}`, updated, ALBUM_CACHE_TTL),
      cacheDel('albums:public'),
      cacheDel(`albums:creator:${updated.creator}`),
    ]);
  }
  return updated || null;
}

export async function deleteAlbum(id: string): Promise<boolean> {
  await songDb.update(songs).set({ album_id: null }).where(eq(songs.album_id, id));
  const result = await songDb.delete(albums).where(eq(albums.id, id)).returning();
  if (result.length > 0) {
    await Promise.all([cacheDel(`albums:id:${id}`), cacheDel('albums:public')]);
  }
  return result.length > 0;
}

export async function addSongToAlbum(albumId: string, songId: string): Promise<boolean> {
  const result = await songDb
    .update(songs)
    .set({ album_id: albumId })
    .where(eq(songs.id, songId))
    .returning();
  if (result.length > 0) await cacheDel(`songs:id:${songId}`);
  return result.length > 0;
}

export async function removeSongFromAlbum(songId: string): Promise<boolean> {
  const result = await songDb
    .update(songs)
    .set({ album_id: null })
    .where(eq(songs.id, songId))
    .returning();
  if (result.length > 0) await cacheDel(`songs:id:${songId}`);
  return result.length > 0;
}

export async function getSongsByAlbum(albumId: string) {
  return songDb
    .select()
    .from(songs)
    .where(eq(songs.album_id, albumId))
    .orderBy(desc(songs.created_at));
}
