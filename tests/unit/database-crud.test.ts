import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { databaseCause } from '../support/database-postgres.js';
const mocks = vi.hoisted(() => ({ driver: vi.fn(), userSql: vi.fn() }));
vi.mock('../../databases/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  return { songDb: drizzle(mocks.driver as any), userSql: mocks.userSql };
});
import { createSong, deleteSong, getFullSongProject, getSongById, listAllSongs, listSongsByCreator, updateSong } from '../../databases/songs.js';
import { createVoice, getVoiceById, listVoicesByCreator, updateVoice } from '../../databases/voices.js';
import { createStem, listStemsBySong, updateStemMixer } from '../../databases/stems.js';
import { activateTake, createTake, deleteTake, listTakesBySong, listTakesByStem } from '../../databases/takes.js';
import { createCommit, listCommitsBySong } from '../../databases/commits.js';
import { songs, voices, stems, takes, commits } from '../../databases/schema/index.js';

const evm = `0x${'AB'.repeat(20)}`;
const svm = 'So11111111111111111111111111111111111111112';
const date = new Date('2026-10-08T12:00:00.000Z');
const song = { id: 'song-1', title: 'Fixture', creator: evm.toLowerCase(), url: 'https://fixture.invalid/song.wav', version: 1, licenses: 0, stream_price: 0.02, license_price: 25, duration: 120, tags: ['fixture'], created_at: date };
const stem = { id: 'stem-1', song_id: song.id, name: 'vocals', url: song.url, volume: 1, pan: 0, is_muted: false, is_solo: false, created_at: date };
const take = { id: 'take-1', song_id: song.id, stem_id: stem.id, take_number: 1, model: 'fixture-model', task: 'repaint', url: song.url, is_active: false, seed: '123', created_at: date };
const voice = { id: 'voice-1', name: 'Fixture', creator: evm.toLowerCase(), url: null, sample_url: song.url, status: 'ready', created_at: date };
const commit = { id: 'commit-1', song_id: song.id, user_address: evm, message: 'Fixture', timeline_snapshot: { tracks: [stem] }, created_at: date };
function result(table: any, record: Record<string, unknown>) {
  return { rows: [Object.keys(getTableColumns(table)).map((key) => key === 'tags' || key === 'timeline_snapshot' ? JSON.stringify(record[key] ?? null) : record[key] instanceof Date ? (record[key] as Date).toISOString() : record[key] ?? null)] };
}
const query = (index = 0) => mocks.driver.mock.calls[index][0] as string;
const params = (index = 0) => mocks.driver.mock.calls[index][1] as unknown[];
beforeEach(() => {
  mocks.driver.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.userSql.mockReset().mockResolvedValue([]);
});

describe('real Drizzle inserts and row decoding with a stubbed Neon HTTP transport', () => {
  it.each([
    ['songs', songs, createSong, song], ['voices', voices, createVoice, voice],
    ['stems', stems, createStem, stem], ['takes', takes, createTake, take], ['commits', commits, createCommit, commit],
  ])('creates %s, binds all user values and decodes timestamp columns', async (tableName, table, create, fixture) => {
    mocks.driver.mockResolvedValueOnce(result(table, fixture));
    const created = await (create as any)(fixture);
    expect(created.id).toBe(fixture.id);
    expect(created.created_at).toEqual(new Date(date));
    expect(query()).toContain(`insert into "${tableName}"`);
    expect(query()).toContain('returning');
    expect(params()).toContain(fixture.id);
    expect(query()).not.toContain(fixture.id);
    expect(mocks.driver.mock.calls[0][2]).toMatchObject({ arrayMode: true, fullResults: true });
  });
  it('decodes song JSON tags', async () => {
    mocks.driver.mockResolvedValueOnce(result(songs, song));
    expect((await createSong(song as any)).tags).toEqual(['fixture']);
  });
  it('decodes commit JSON snapshots', async () => {
    mocks.driver.mockResolvedValueOnce(result(commits, commit));
    expect((await createCommit(commit as any)).timeline_snapshot).toEqual(JSON.parse(JSON.stringify(commit.timeline_snapshot)));
  });
  it('decodes take bigint seed in the schema number mode', async () => {
    mocks.driver.mockResolvedValueOnce(result(takes, take));
    expect((await createTake(take as any)).seed).toBe(123);
  });
  it('upserts stems by id and updates URL/name only', async () => {
    mocks.driver.mockResolvedValueOnce(result(stems, stem));
    await createStem(stem as any);
    expect(query()).toMatch(/on conflict \("id"\) do update set "name" = \$\d+, "url" = \$\d+/);
    expect(query().split('do update set')[1].split(' where')[0]).not.toContain('"song_id"');
  });
  it('upserts takes by id and updates URL/active state only', async () => {
    mocks.driver.mockResolvedValueOnce(result(takes, take));
    await createTake(take as any);
    expect(query()).toMatch(/on conflict \("id"\) do update set "url" = \$\d+, "is_active" = \$\d+/);
    expect(query().split('do update set')[1].split(' where')[0]).not.toContain('"song_id"');
  });
  it.each([createSong, createVoice, createStem, createTake, createCommit])('propagates insert transport failures for %s', async (create) => {
    mocks.driver.mockRejectedValueOnce(new Error('fixture driver failure'));
    await expect((create as any)({ ...song, ...stem, ...take, ...voice, ...commit }).catch(error => { throw databaseCause(error); })).rejects.toThrow('fixture driver failure');
  });
});

describe('song and voice read/filter/update behavior', () => {
  it.each([[getSongById, songs, song], [getVoiceById, voices, voice]])('reads an ID with bound value and one-row limit', async (read, table, fixture) => {
    mocks.driver.mockResolvedValueOnce(result(table, fixture));
    expect((await read("id'; DROP TABLE songs; --"))?.id).toBe(fixture.id);
    expect(params()).toEqual(["id'; DROP TABLE songs; --", 1]);
    expect(query()).toMatch(/where "(?:songs|voices)"\."id" = \$1 limit \$2/);
  });
  it.each([getSongById, getVoiceById])('returns null for missing ID', async (read) => expect(await read('missing')).toBeNull());
  it.each([listSongsByCreator])('merges wallet-pair chain addresses while normalizing EVM only', async (list) => {
    mocks.userSql.mockResolvedValueOnce([{ evm_address: evm.toLowerCase(), svm_address: svm }]);
    await list(evm);
    expect(params()).toEqual([evm.toLowerCase(), svm]);
    expect(query()).toMatch(/"creator" in \(\$1, \$2\)/);
    expect(query()).toContain('"created_at" desc');
  });
  it.each([listSongsByCreator])('preserves Solana case and merges paired EVM address', async (list) => {
    mocks.userSql.mockResolvedValueOnce([{ evm_address: evm.toLowerCase(), svm_address: svm }]);
    await list(svm);
    expect(params()).toEqual([svm, evm.toLowerCase()]);
  });
  it.each([listSongsByCreator])('propagates an unavailable account-pair database', async (list) => {
    mocks.userSql.mockRejectedValueOnce(new Error('pair unavailable'));
    await expect(list(evm)).rejects.toThrow('pair unavailable');
    expect(mocks.driver).not.toHaveBeenCalled();
  });
  it('lists every public song newest first without an implicit limit', async () => {
    await listAllSongs();
    expect(query()).toContain('order by "songs"."created_at" desc');
    expect(query()).not.toContain(' limit ');
    expect(params()).toEqual([true]);
  });
  it('forwards an explicit song limit', async () => { await listAllSongs(3); expect(params()).toEqual([true, 3]); });
  it('binds a requested catalog limit and offset', async () => {
    await listAllSongs(5, 10); expect(params()).toEqual([true, 5, 10]);
    expect(query()).toContain('limit $2 offset $3');
  });
  it('binds explicitly requested creator pagination', async () => {
    await listSongsByCreator(evm, 5, 10); expect(params()).toEqual([evm.toLowerCase(), 5, 10]);
    expect(query()).toContain('limit $2 offset $3');
  });
  it('voice catalog scopes the exact connected creator independently of paired wallets', async () => {
    await listVoicesByCreator(evm); expect(params()).toEqual([evm.toLowerCase()]); expect(mocks.userSql).not.toHaveBeenCalled();
    mocks.driver.mockClear(); await listVoicesByCreator(svm); expect(params()).toEqual([svm]);
  });
  it.each([[updateSong, songs, song, { title: 'Renamed' }], [updateVoice, voices, voice, { status: 'training' }]])('updates a bound ID and returns decoded row', async (update, table, fixture, changes) => {
    mocks.driver.mockResolvedValueOnce(result(table, { ...fixture, ...changes }));
    expect(await (update as any)(fixture.id, changes)).toMatchObject(changes);
    expect(query()).toMatch(/^update "/);
    expect(params()).toContain(fixture.id);
  });
  it.each([updateSong, updateVoice])('returns null for updating a missing row', async (update) => {
    expect(await (update as any)('missing', { name: 'x', title: 'x' })).toBeNull();
  });
  it.each([updateSong, updateVoice])('rejects empty updates in Drizzle before transport', async (update) => {
    await expect(update('x', {})).rejects.toThrow('No values to set');
    expect(mocks.driver).not.toHaveBeenCalled();
  });
  it('returns a complete project using independently scoped child queries', async () => {
    mocks.driver.mockResolvedValueOnce(result(songs, song)).mockResolvedValueOnce(result(stems, stem)).mockResolvedValueOnce(result(takes, take));
    const project = await getFullSongProject(song.id);
    expect(project.song?.id).toBe(song.id); expect(project.stems[0].id).toBe(stem.id); expect(project.takes[0].id).toBe(take.id);
    expect(params(1)).toEqual([song.id]); expect(params(2)).toEqual([song.id]);
    expect(query(1)).toContain('"stems"."song_id" = $1'); expect(query(2)).toContain('"takes"."song_id" = $1');
  });
  it('short-circuits missing projects without child queries', async () => {
    expect(await getFullSongProject('missing')).toEqual({ song: null, stems: [], takes: [] });
    expect(mocks.driver).toHaveBeenCalledTimes(1);
  });
  it('propagates child query errors instead of returning a partial successful project', async () => {
    mocks.driver.mockResolvedValueOnce(result(songs, song)).mockRejectedValueOnce(new Error('stems unavailable'));
    await expect(getFullSongProject(song.id).catch(error => { throw databaseCause(error); })).rejects.toThrow('stems unavailable');
  });
});

describe('stem, take and commit query semantics', () => {
  it.each([[listStemsBySong, 'stems'], [listTakesBySong, 'takes'], [listCommitsBySong, 'commits']])('scopes %s to the song ID', async (list, tableName) => {
    await list(song.id);
    expect(query()).toContain(`"${tableName}"."song_id" = $1`);
    expect(params()).toEqual([song.id]);
    if (tableName === 'commits') expect(query()).toContain('"created_at" desc');
  });
  it('scopes take listing to both song and stem', async () => {
    await listTakesByStem(song.id, stem.id);
    expect(query()).toContain('("takes"."song_id" = $1 and "takes"."stem_id" = $2)');
    expect(params()).toEqual([song.id, stem.id]);
  });
  it('updates false/zero mixer values without dropping them', async () => {
    const state = { volume: 0, pan: 0, is_muted: false, is_solo: false };
    mocks.driver.mockResolvedValueOnce(result(stems, { ...stem, ...state }));
    expect(await updateStemMixer(stem.id, state)).toMatchObject(state);
    expect(params()).toEqual([0, 0, false, false, stem.id]);
  });
  it('returns null for mixer update of a missing stem', async () => expect(await updateStemMixer('missing', { volume: 1 })).toBeNull());
  it.each([[deleteSong, 'songs'], [deleteTake, 'takes']])('deletes %s using a bound ID', async (remove, tableName) => {
    expect(await remove('fixture-id')).toBe(false);
    expect(query()).toBe(`delete from "${tableName}" where "${tableName}"."id" = $1 returning "id"`);
    expect(params()).toEqual(['fixture-id']);
  });
  it.each([deleteSong, deleteTake])('propagates delete failures', async (remove) => {
    mocks.driver.mockRejectedValueOnce(new Error('delete failed'));
    await expect(remove('fixture-id').catch(error => { throw databaseCause(error); })).rejects.toThrow('delete failed');
  });
});
