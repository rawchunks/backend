import { eq, desc, and } from 'drizzle-orm';
import { songDb } from './client.js';
import { albums, type Album, type NewAlbum } from './schema/albums.js';
import { songs } from './schema/songs.js';

export async function createAlbum(data: NewAlbum): Promise<Album> {
  const [album] = await songDb.insert(albums).values(data).returning();
  return album;
}

export async function getAlbumById(id: string): Promise<Album | null> {
  const [album] = await songDb.select().from(albums).where(eq(albums.id, id));
  return album || null;
}

export async function listAlbumsByCreator(creator: string): Promise<Album[]> {
  const normalized = creator.startsWith('0x') ? creator.toLowerCase() : creator;
  return songDb
    .select()
    .from(albums)
    .where(eq(albums.creator, normalized))
    .orderBy(desc(albums.created_at));
}

export async function listPublicAlbums(): Promise<Album[]> {
  return songDb
    .select()
    .from(albums)
    .where(eq(albums.public, true))
    .orderBy(desc(albums.created_at));
}

export async function updateAlbum(id: string, data: Partial<Omit<NewAlbum, 'id' | 'created_at'>>): Promise<Album | null> {
  const [updated] = await songDb
    .update(albums)
    .set(data)
    .where(eq(albums.id, id))
    .returning();
  return updated || null;
}

export async function deleteAlbum(id: string): Promise<boolean> {
  // Clear album_id on any associated songs
  await songDb.update(songs).set({ album_id: null }).where(eq(songs.album_id, id));
  const result = await songDb.delete(albums).where(eq(albums.id, id)).returning();
  return result.length > 0;
}

export async function addSongToAlbum(albumId: string, songId: string): Promise<boolean> {
  const result = await songDb
    .update(songs)
    .set({ album_id: albumId })
    .where(eq(songs.id, songId))
    .returning();
  return result.length > 0;
}

export async function removeSongFromAlbum(songId: string): Promise<boolean> {
  const result = await songDb
    .update(songs)
    .set({ album_id: null })
    .where(eq(songs.id, songId))
    .returning();
  return result.length > 0;
}

export async function getSongsByAlbum(albumId: string) {
  return songDb
    .select()
    .from(songs)
    .where(eq(songs.album_id, albumId))
    .orderBy(desc(songs.created_at));
}
