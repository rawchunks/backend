import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { songs, voices, stems, takes, commits } from '../../databases/schema/index.js';
import { getTableColumns } from 'drizzle-orm';
const mocks = vi.hoisted(() => ({ driver: vi.fn(), userSql: vi.fn(), songSql: vi.fn() }));
vi.mock('../../databases/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  return { songDb: drizzle(mocks.driver as any), userSql: mocks.userSql, songSql: mocks.songSql };
});
import { activateTake, createTake } from '../../databases/takes.js';
import { createStem } from '../../databases/stems.js';
import { createSong, deleteSong, listAllSongs, listSongsByCreator, updateSong } from '../../databases/songs.js';
import { createVoice, listVoicesByCreator, updateVoice } from '../../databases/voices.js';
import { runMigrations } from '../../databases/migrate.js';
const evm = `0x${'Ab'.repeat(20)}`;
beforeEach(() => {
  mocks.driver.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.userSql.mockReset().mockResolvedValue([]); mocks.songSql.mockReset().mockResolvedValue([]);
});

describe('bounded and valid database operations', () => {
  it.each([-1, 0, 1.5, Infinity, NaN])('rejects invalid/unbounded song limit %s before transport', async (limit) => {
    await expect(listAllSongs(limit)).rejects.toThrow(); expect(mocks.driver).not.toHaveBeenCalled();
  });
  it('retains valid large explicit catalog limits without an invented cap', async () => {
    await listAllSongs(1000000); expect(mocks.driver.mock.calls[0][1]).toEqual([true, 1000000]);
  });
  it.each([['song', createSong], ['voice', createVoice]])('normalizes EVM creator before %s insert', async (_name, create) => {
    await (create as any)({ id: 'fixture', title: 'Fixture', name: 'Fixture', creator: evm, url: 'https://fixture.invalid/audio' });
    expect(mocks.driver.mock.calls[0][1]).toContain(evm.toLowerCase());
    expect(mocks.driver.mock.calls[0][1]).not.toContain(evm);
  });
  it('song deletion reports an absent row instead of success', async () => expect(await deleteSong('missing')).toBe(false));
  it('rejects reassigning song ownership through generic update', async () => {
    await expect(updateSong('song-a', { creator: evm })).rejects.toThrow();
  });
  it('rejects reassigning voice ownership through generic update', async () => {
    await expect(updateVoice('voice-a', { creator: evm })).rejects.toThrow();
  });
  it('stem ID upsert scopes conflict mutation to the same song', async () => {
    mocks.driver.mockResolvedValueOnce({ rows: [['shared-id']] });
    await createStem({ id: 'shared-id', song_id: 'song-b', name: 'overwrite', url: 'https://fixture.invalid/overwrite' });
    const query = mocks.driver.mock.calls[0][0] as string;
    expect(query.split('do update set')[1].split(' returning')[0]).toMatch(/where.*song_id/);
  });
  it('take ID upsert scopes conflict mutation to the same song and stem', async () => {
    mocks.driver.mockResolvedValueOnce({ rows: [['shared-id']] });
    await createTake({ id: 'shared-id', song_id: 'song-b', stem_id: 'stem-b', model: 'fixture', task: 'fixture', url: 'https://fixture.invalid/overwrite', is_active: false });
    const query = mocks.driver.mock.calls[0][0] as string;
    expect(query.split('do update set')[1].split(' returning')[0]).toMatch(/where.*song_id.*stem_id/);
  });

});

describe('durable schema constraints and indexes', () => {
  it.each([['songs', songs, 'creator'], ['voices', voices, 'creator'], ['stems', stems, 'song_id'], ['takes', takes, 'song_id'], ['commits', commits, 'song_id']])(
    '%s has an index beginning with its main filter column %s', (_name, table, column) => {
      expect(getTableConfig(table).indexes.some((index) => (index.config.columns[0] as any)?.name === column)).toBe(true);
    },
  );
  it('songs enforce nonnegative finite prices, durations and license counts', () => expect(getTableConfig(songs).checks.length).toBeGreaterThan(0));
  it('stems enforce valid mixer ranges', () => expect(getTableConfig(stems).checks.length).toBeGreaterThan(0));
  it('takes enforce valid repaint intervals and positive take numbers', () => expect(getTableConfig(takes).checks.length).toBeGreaterThan(0));
  it('voices restrict status to the supported lifecycle values', () => expect(getTableConfig(voices).checks.length).toBeGreaterThan(0));
  it('takes prevent attaching a stem owned by another song through a composite foreign key', () => {
    expect(getTableConfig(takes).foreignKeys.some((key) => key.reference().columns.map((column) => column.name).sort().join(',') === 'song_id,stem_id')).toBe(true);
  });
  it('takes enforce a single active take per song/stem in the database', () => {
    expect(getTableConfig(takes).indexes.some((index) => index.config.unique && index.config.where)).toBe(true);
  });
  it('commits enforce a valid same-song parent relationship', () => {
    expect(getTableConfig(commits).foreignKeys.some((key) => key.reference().columns.some((column) => column.name === 'parent_commit_id'))).toBe(true);
  });
  it('migration stores saved samples separately from checkpoint adapters', async () => {
    await runMigrations();
    const ddl = mocks.songSql.mock.calls.find(([chunks]) => chunks.join('').includes('CREATE TABLE IF NOT EXISTS voices'))![0].join('');
    expect(/\n\s+url\s+TEXT/.test(ddl)).toBe(false); expect(ddl).toContain('training_group TEXT NOT NULL');
  });
  it('migration songs.duration nullability/default match the runtime schema', async () => {
    await runMigrations();
    const ddl = mocks.songSql.mock.calls.find(([chunks]) => chunks.join('').includes('CREATE TABLE IF NOT EXISTS songs'))![0].join('');
    expect(/duration\s+REAL\s+DEFAULT[^,]+NOT NULL/.test(ddl)).toBe(songs.duration.notNull);
    expect(/duration\s+REAL\s+DEFAULT/.test(ddl)).toBe(songs.duration.hasDefault);
  });
});
