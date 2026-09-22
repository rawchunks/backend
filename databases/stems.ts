import { eq } from 'drizzle-orm';
import { songDb } from './client.js';
import { stems, type Stem, type NewStem } from './schema/stems.js';

export async function createStem(stemData: NewStem): Promise<Stem> {
  const result = await songDb
    .insert(stems)
    .values(stemData)
    .onConflictDoUpdate({
      target: stems.id,
      set: {
        url: stemData.url,
        name: stemData.name,
      },
      setWhere: eq(stems.song_id, stemData.song_id),
    })
    .returning();
  if (!result[0]) throw new Error('Stem ID belongs to another song');
  return result[0];
}

export async function listStemsBySong(songId: string): Promise<Stem[]> {
  return await songDb.select().from(stems).where(eq(stems.song_id, songId));
}

export async function updateStemMixer(
  id: string,
  mixerState: {
    volume?: number;
    pan?: number;
    is_muted?: boolean;
    is_solo?: boolean;
  }
): Promise<Stem | null> {
  const result = await songDb
    .update(stems)
    .set(mixerState)
    .where(eq(stems.id, id))
    .returning();
  return result[0] || null;
}
