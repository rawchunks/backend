import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { walletPairs, users, songs, stems, takes, commits, voices, voiceAdapters } from '../../databases/schema/index.js';
const mocks = vi.hoisted(() => ({ userSql: vi.fn(), songSql: vi.fn() }));
vi.mock('../../databases/client.js', () => mocks);
import { runMigrations } from '../../databases/migrate.js';

beforeEach(() => { mocks.userSql.mockReset().mockResolvedValue([]); mocks.songSql.mockReset().mockResolvedValue([]); });
describe('all Drizzle table contracts', () => {
  it('exports the complete database public API without bootstrapping the backend server', async () => {
    const api = await import('../../databases/index.js');
    expect(Object.keys(api)).toEqual(expect.arrayContaining(['createSong', 'getFullSongProject', 'putUserConsent', 'createTake', 'activateTake', 'createStem', 'createCommit', 'walletPairs', 'voices']));
  });
  it.each([walletPairs, users, songs, stems, takes, commits, voices])('has a primary key and timezone creation timestamp', (table) => {
    const columns = getTableColumns(table);
    expect(Object.values(columns).filter((column) => column.primary)).toHaveLength(1);
    expect(columns.created_at).toMatchObject({ notNull: true, hasDefault: true, withTimezone: true });
  });
  it('makes wallet pairs one-to-one across both chain addresses', () => {
    expect(getTableColumns(walletPairs).evm_address.primary).toBe(true);
    expect(getTableColumns(walletPairs).svm_address).toMatchObject({ notNull: false, isUnique: true });
  });
  it.each([[stems, 1], [takes, 3], [commits, 2]])('declares parent foreign keys for %s', (table, count) => {
    expect(getTableConfig(table).foreignKeys).toHaveLength(count);
    const songKey = getTableConfig(table).foreignKeys.find((key) => key.reference().columns[0].name === 'song_id')!;
    expect(songKey.onDelete).toBe('cascade');
    expect(getTableName(songKey.reference().foreignTable)).toBe('songs');
  });
  it('sets deleted take stems to null', () => {
    const stemKey = getTableConfig(takes).foreignKeys.find((key) => key.reference().columns[0].name === 'stem_id')!;
    expect(stemKey.onDelete).toBe('set null');
    expect(getTableName(stemKey.reference().foreignTable)).toBe('stems');
  });
  it('retains nullable song duration and stores checkpoint adapters separately', () => {
    expect(songs.duration.notNull).toBe(false); expect(songs.duration.hasDefault).toBe(false);
    expect('url' in voices).toBe(false); expect(voiceAdapters.model.notNull).toBe(true); expect(voices.sample_url.notNull).toBe(false);
  });
  it('declares mixer and take defaults', () => {
    expect(stems.volume.default).toBe(1); expect(stems.pan.default).toBe(0);
    expect(stems.is_muted.default).toBe(false); expect(stems.is_solo.default).toBe(false);
    expect(takes.take_number.default).toBe(1); expect(takes.is_active.default).toBe(false);
  });
  it('declares song commerce defaults and required JSON fields', () => {
    expect(songs.version.default).toBe(1); expect(songs.licenses.default).toBe(0);
    expect(songs.stream_price.default).toBe(0.02); expect(songs.license_price.default).toBe(25);
    expect(songs.tags.default).toEqual([]); expect(songs.tags.notNull).toBe(true);
    expect(commits.timeline_snapshot.notNull).toBe(true);
  });
});

describe('actual migration SQL emitted to isolated transports', () => {
  it('creates every table in its separate user/song database', async () => {
    await runMigrations();
    const userDdl = mocks.userSql.mock.calls.map(([chunks]) => chunks.join('')).join('\n');
    const songDdl = mocks.songSql.mock.calls.map(([chunks]) => chunks.join('')).join('\n');
    expect(mocks.userSql).toHaveBeenCalledTimes(5); expect(mocks.songSql.mock.calls.length).toBeGreaterThan(6);
    for (const table of ['wallet_pairs', 'users']) expect(userDdl).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    for (const table of ['songs', 'stems', 'takes', 'commits', 'voices']) expect(songDdl).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(songDdl).toContain('ALTER TABLE songs ADD COLUMN IF NOT EXISTS metadata_cid TEXT');
    expect(userDdl).not.toContain('CREATE TABLE IF NOT EXISTS songs');
  });
  it('repeated runs emit idempotent CREATE/ADD IF NOT EXISTS statements', async () => {
    await runMigrations();
    const ddl = mocks.songSql.mock.calls.map(([chunks]) => chunks.join(''));
    mocks.songSql.mockClear();
    await runMigrations();
    expect(mocks.songSql.mock.calls.map(([chunks]) => chunks.join(''))).toEqual(ddl);
  });
  it('preserves cascade and set-null actions in emitted DDL', async () => {
    await runMigrations();
    const ddl = mocks.songSql.mock.calls.map(([chunks]) => chunks.join('')).join('\n');
    expect(ddl.match(/REFERENCES songs\(id\) ON DELETE CASCADE/g)).toHaveLength(3);
    expect(ddl).toContain('REFERENCES stems(id) ON DELETE SET NULL');
  });
  it('stops all subsequent migrations when the first user database call fails', async () => {
    mocks.userSql.mockRejectedValueOnce(new Error('user migration failed'));
    await expect(runMigrations()).rejects.toThrow('user migration failed');
    expect(mocks.userSql).toHaveBeenCalledTimes(1); expect(mocks.songSql).not.toHaveBeenCalled();
  });
  it('propagates song migration failures and stops later table creation', async () => {
    mocks.songSql.mockRejectedValueOnce(new Error('song migration failed'));
    await expect(runMigrations()).rejects.toThrow('song migration failed');
    expect(mocks.userSql).toHaveBeenCalledTimes(5); expect(mocks.songSql).toHaveBeenCalledTimes(1);
  });
});
