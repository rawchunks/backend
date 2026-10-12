import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../databases/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const pg = await import('../support/database-postgres.js');
  return { songDb: drizzle(pg.neonTransport as any), userSql: pg.sqlTag('user'), songSql: pg.sqlTag('song') };
});
import { databaseCause, clearPostgres, closePostgres, fixtures as f, initializePostgres, postgres } from '../support/database-postgres.js';
import { runMigrations } from '../../databases/migrate.js';
import { getUserConsent, getWalletPair, putUserConsent, putWalletPair, updateProfile } from '../../databases/users.js';
import { createSong, deleteSong, getFullSongProject, getSongById, listAllSongs, listSongsByCreator, updateSong } from '../../databases/songs.js';
import { createStem, listStemsBySong, updateStemMixer } from '../../databases/stems.js';
import { activateTake, createTake, deleteTake, listTakesBySong, listTakesByStem } from '../../databases/takes.js';
import { createCommit, listCommitsBySong } from '../../databases/commits.js';
import { createVoice, getVoiceById, listVoicesByCreator, updateVoice } from '../../databases/voices.js';
beforeAll(async () => { await initializePostgres(); await runMigrations(); });
beforeEach(clearPostgres);
afterAll(closePostgres);

describe('production DDL and queries on disposable PostgreSQL engines', () => {
  it('migrates repeatedly and keeps user/song tables on separate engines', async () => {
    await runMigrations();
    const userTables = (await postgres.user.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((row) => row.table_name);
    const songTables = (await postgres.song.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((row) => row.table_name);
    expect(userTables.sort()).toEqual(['users', 'wallet_pairs']); expect(songTables.sort()).toEqual(['albums', 'commits', 'songs', 'stems', 'takes', 'voice_adapters', 'voices']);
  });
  it('repairs stale active flags by matching the persisted lane URL without changing any audio', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake({ ...f.take, url: f.stem.url });
    await postgres.song.exec('DROP INDEX takes_active_stem_idx');
    await postgres.song.query('INSERT INTO takes (id,song_id,stem_id,model,task,url,is_active) VALUES ($1,$2,$3,$4,$5,$6,true)', ['stale', f.song.id, f.stem.id, 'fixture', 'extract', 'https://fixture.invalid/old.wav']);
    await runMigrations();
    const versions = await listTakesBySong(f.song.id);
    expect(versions).toHaveLength(2);
    expect(versions.filter(take => take.is_active).map(take => take.id)).toEqual([f.take.id]);
    expect(versions.find(take => take.id === 'stale')?.url).toBe('https://fixture.invalid/old.wav');
    expect((await listStemsBySong(f.song.id))[0].url).toBe(f.stem.url);
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
  });
  it('preserves conflicting versions when the current lane does not identify one active take', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await postgres.song.exec('DROP INDEX takes_active_stem_idx');
    await postgres.song.query('INSERT INTO takes (id,song_id,stem_id,model,task,url,is_active) VALUES ($1,$2,$3,$4,$5,$6,true)', ['stale', f.song.id, f.stem.id, 'fixture', 'extract', 'https://fixture.invalid/old.wav']);
    try {
      await expect(runMigrations()).rejects.toThrow('no unique match');
      expect((await listTakesBySong(f.song.id)).filter(take => take.is_active)).toHaveLength(2);
    } finally {
      await clearPostgres();
      await runMigrations();
    }
  });
  it('enforces primary key uniqueness on song inserts', async () => {
    await createSong(f.song);
    await expect(createSong(f.song).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23505' });
    expect(await getSongById(f.song.id)).toMatchObject(f.song);
  });
  it('enforces required song fields and leaves no partial row', async () => {
    await expect(createSong({ ...f.song, title: null } as any).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23502' });
    expect(await getSongById(f.song.id)).toBeNull();
  });
  it('enforces song and stem foreign keys', async () => {
    await expect(createStem(f.stem).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23503' });
    await createSong(f.song);
    await expect(createTake(f.take).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23503' });
  });
  it('CRUD operations actually roundtrip all song/project entities', async () => {
    const song = await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    expect(song.created_at).toBeInstanceOf(Date);
    expect((await getFullSongProject(f.song.id)).stems).toHaveLength(1);
    expect((await getFullSongProject(f.song.id)).takes).toHaveLength(1);
    expect(await updateSong(f.song.id, { title: 'Renamed', tags: ['one', 'two'] })).toMatchObject({ title: 'Renamed', tags: ['one', 'two'] });
    expect(await listStemsBySong(f.song.id)).toHaveLength(1); expect(await listTakesBySong(f.song.id)).toHaveLength(1);
    expect(await listTakesByStem(f.song.id, f.stem.id)).toHaveLength(1);
    expect(await updateStemMixer(f.stem.id, { volume: 0.5, pan: -0.5, is_muted: true })).toMatchObject({ volume: 0.5, pan: -0.5, is_muted: true });
  });
  it('stem upserts keep one row with changed URL/name and original mixer state', async () => {
    await createSong(f.song); await createStem({ ...f.stem, volume: 0.4 });
    await createStem({ ...f.stem, name: 'new', url: 'https://fixture.invalid/new.wav', volume: 0.9 });
    const rows = await listStemsBySong(f.song.id);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ name: 'new', url: 'https://fixture.invalid/new.wav' });
    expect(rows[0].volume).toBeCloseTo(0.4);
  });
  it('take upserts keep one row with changed URL/active flag and original task', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await createTake({ ...f.take, url: 'https://fixture.invalid/new.wav', is_active: false, task: 'other' });
    const rows = await listTakesBySong(f.song.id);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ url: 'https://fixture.invalid/new.wav', is_active: false, task: 'repaint' });
  });
  it('normal sequential activation and take deletion affect persistent rows', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await createTake({ ...f.take, id: 'take-b', is_active: false });
    await activateTake(f.song.id, f.stem.id, 'take-b');
    const active = (await listTakesBySong(f.song.id)).filter((take) => take.is_active);
    expect(active.map((take) => take.id)).toEqual(['take-b']);
    await deleteTake('take-b'); expect(await listTakesBySong(f.song.id)).toHaveLength(1);
  });
  it('deleting a song cascades actual stems, takes and commits', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await createCommit({ id: 'commit-a', song_id: f.song.id, user_address: f.evm, message: 'Fixture', timeline_snapshot: { tracks: [] } });
    await deleteSong(f.song.id);
    expect(await listStemsBySong(f.song.id)).toEqual([]); expect(await listTakesBySong(f.song.id)).toEqual([]); expect(await listCommitsBySong(f.song.id)).toEqual([]);
  });
  it('deleting a stem actually preserves the take with a null stem reference', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await postgres.song.query('DELETE FROM stems WHERE id=$1', [f.stem.id]);
    expect((await listTakesBySong(f.song.id))[0].stem_id).toBeNull();
  });
  it('commit JSON roundtrips nested snapshots and bound quote characters', async () => {
    await createSong(f.song);
    const snapshot = { tracks: [{ name: "vocals'; SELECT 1 --", active: true, mixer: { pan: -1 } }] };
    const created = await createCommit({ id: 'commit-a', song_id: f.song.id, user_address: f.evm, message: 'Fixture', timeline_snapshot: snapshot });
    expect(created.timeline_snapshot).toEqual(snapshot); expect(await listCommitsBySong(f.song.id)).toHaveLength(1);
  });
  it('voice sample CRUD roundtrips without single checkpoint weights URL', async () => {
    const data = { id: 'voice-a', name: 'Fixture', creator: f.evm, sample_url: 'https://fixture.invalid/sample.wav', training_group: 'group-a' };
    await createVoice(data); expect(await getVoiceById(data.id)).toMatchObject(data);
    expect(await listVoicesByCreator(f.evm)).toHaveLength(1);
    expect(await updateVoice(data.id, { status: 'training' })).toMatchObject({ status: 'training' });
  });
  it('wallet pairing is idempotent and enforces Solana uniqueness', async () => {
    await putWalletPair({ evmAddress: f.evm, svmAddress: f.svm }); await putWalletPair({ evmAddress: f.evm, svmAddress: f.svm });
    expect((await postgres.user.query('SELECT * FROM wallet_pairs')).rows).toHaveLength(1);
    await expect(putWalletPair({ evmAddress: `0x${'b'.repeat(40)}`, svmAddress: f.svm }).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23505' });
  });
  it('persists the signed policy on the paired accounts', async () => {
    await putWalletPair({ evmAddress: f.evm, svmAddress: f.svm });
    const signedAt = '2026-10-09T10:00:00.000Z', signature = `0x${'ab'.repeat(65)}`;
    const message = 'Signed disclaimer';
    const consent = await putUserConsent({ address: f.evm, signature, message, metadata: { signedAt }, chainId: 8453, policyVersion: '1.0.0', disclaimerType: 'generation' });
    expect(consent.message).toBe(message);
    expect(await getUserConsent(f.svm)).toMatchObject({ signature, metadata: { signedAt, disclaimerType: 'generation' } });
    expect((await postgres.user.query('SELECT consented_at FROM wallet_pairs')).rows[0].consented_at).toBeTruthy();
  });
  it('records first consent for an EVM account without a Solana counterpart', async () => {
    const input = { address: f.evm, signature: 'isolated-fixture', message: 'Isolated signed policy', disclaimerType: 'ai_passthrough' };
    await putUserConsent(input);
    expect(await getUserConsent(f.evm)).toMatchObject({ evmAddress: f.evm, svmAddress: '', signature: input.signature, message: input.message });
    await putUserConsent({ ...input, message: 'Updated isolated signed policy' });
    expect((await postgres.user.query('SELECT svm_address, consent_message FROM wallet_pairs')).rows).toEqual([{ svm_address: null, consent_message: 'Updated isolated signed policy' }]);
  });
  it('records consent for a profile whose Solana counterpart is null', async () => {
    await updateProfile({ address: f.evm, nickname: 'Existing profile' });
    await putUserConsent({ address: f.evm, signature: 'isolated-fixture', message: 'Isolated signed policy' });
    expect(await getUserConsent(f.evm)).toMatchObject({ evmAddress: f.evm, signature: 'isolated-fixture' });
    expect((await getWalletPair(f.evm))?.nickname).toBe('Existing profile');
  });
  it.each([null, 'svm_pending_aaaaaaaa'])('retains EVM consent when completing an initial pair from %s', async counterpart => {
    await updateProfile({ address: f.evm });
    if (counterpart) await postgres.user.query('UPDATE wallet_pairs SET svm_address=$1 WHERE evm_address=$2', [counterpart, f.evm]);
    const signed = await putUserConsent({ address: f.evm, signature: 'isolated-fixture', message: 'Original signed policy', policyVersion: '1.0.0', disclaimerType: 'ai_passthrough', metadata: { signedAt: '2026-10-11T10:00:00.000Z' } });
    await putWalletPair({ evmAddress: f.evm, svmAddress: f.svm });
    await putWalletPair({ evmAddress: f.evm, svmAddress: f.svm });
    for (const address of [f.evm, f.svm]) {
      expect(await getUserConsent({ address, policyVersion: '1.0.0', disclaimerType: 'ai_passthrough' })).toEqual({ ...signed, svmAddress: f.svm });
    }
    expect(await getUserConsent(`0x${'b'.repeat(40)}`)).toBeNull();
    expect(await getUserConsent({ address: f.svm, policyVersion: '2.0.0' })).toBeNull();
  });
  it('clears consent when replacing an established Solana counterpart', async () => {
    await putWalletPair({ evmAddress: f.evm, svmAddress: f.svm });
    await putUserConsent({ address: f.evm, signature: 'isolated-fixture', message: 'Original signed policy' });
    const replacement = '11111111111111111111111111111111';
    await putWalletPair({ evmAddress: f.evm, svmAddress: replacement });
    expect(await getUserConsent(f.evm)).toBeNull();
    expect(await getUserConsent(replacement)).toBeNull();
    expect(await getUserConsent(f.svm)).toBeNull();
  });
  it('links a supplied counterpart when a profile exists without Solana', async () => {
    await updateProfile({ address: f.evm, nickname: 'Existing profile' });
    await putUserConsent({ address: f.evm, svmAddress: f.svm, signature: 'isolated-fixture', message: 'Isolated signed policy' });
    expect(await getUserConsent(f.svm)).toMatchObject({ evmAddress: f.evm, svmAddress: f.svm });
    expect((await getWalletPair(f.evm))?.nickname).toBe('Existing profile');
  });
  it('real paired creator listing merges EVM and case-sensitive Solana songs', async () => {
    await putWalletPair({ evmAddress: f.evm, svmAddress: f.svm });
    await createSong(f.song); await createSong({ ...f.song, id: 'song-svm', creator: f.svm });
    await createSong({ ...f.song, id: 'song-unpaired', creator: 'so11111111111111111111111111111111111111112' });
    expect((await listSongsByCreator(f.evm)).map((song) => song.id).sort()).toEqual(['song-a', 'song-svm']);
    expect((await getWalletPair(` ${f.evm.toUpperCase().replace('0X', '0x')} `))?.evmAddress).toBe(f.evm);
  });
});
