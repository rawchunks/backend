import { eq, desc } from 'drizzle-orm';
import { songDb } from './client.js';
import { commits, type Commit, type NewCommit } from './schema/commits.js';

export async function createCommit(commitData: NewCommit): Promise<Commit> {
  const result = await songDb.insert(commits).values(commitData).returning();
  return result[0];
}

export async function listCommitsBySong(songId: string): Promise<Commit[]> {
  return await songDb
    .select()
    .from(commits)
    .where(eq(commits.song_id, songId))
    .orderBy(desc(commits.created_at));
}
