import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../databases/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const pg = await import('../support/database-postgres.js');
  return { songDb: drizzle(pg.neonTransport as any), userSql: pg.sqlTag('user'), songSql: pg.sqlTag('song') };
});
import { databaseCause, clearPostgres, closePostgres, fixtures as f, initializePostgres, postgres } from '../support/database-postgres.js';
import { runMigrations } from '../../databases/migrate.js';
import { getUserConsent, putUserConsent, putWalletPair } from '../../databases/users.js';
import { copySong, createSong, finalizeSong, getSongById, getFullSongProject, listAllSongs, listSongsByCreator, updateSong } from '../../databases/songs.js';
import { createStem, listStemsBySong, updateStemMixer } from '../../databases/stems.js';
import { activateTake, createTake, listTakesBySong } from '../../databases/takes.js';
import { createCommit, listCommitsBySong } from '../../databases/commits.js';
import { createVoice } from '../../databases/voices.js';
beforeAll(async () => { await initializePostgres(); await runMigrations(); });
beforeEach(clearPostgres);
afterAll(closePostgres);

describe('production gates exercised on fresh PostgreSQL initialized by production migrations', () => {
  it('creates and copies remixes without license amounts or prices', async () => {
    await createSong({ ...f.song, source: 'original', licenses: 10, license_price: 25, metadata_cid: 'cid' });
    expect(await getSongById(f.song.id)).toMatchObject({ licenses: 0, license_price: 0, source: 'original' });
    const draft = await copySong(f.song.id);
    expect(draft).toMatchObject({ licenses: 0, license_price: 0, source: 'original', public: false, metadata_cid: null });
    await expect(updateSong(draft.id, { licenses: 10 })).rejects.toThrow('Remixes cannot be licensed');
    await expect(updateSong(draft.id, { license_price: 25 })).rejects.toThrow('Remixes cannot be licensed');
    expect(await updateSong(draft.id, { stream_price: .03 })).toMatchObject({ stream_price: expect.closeTo(.03) });
  });
  it('opens an unminted song without creating a new version', async () => {
    await createSong(f.song);
    expect((await copySong(f.song.id)).id).toBe(f.song.id);
    expect(await listSongsByCreator(f.evm)).toHaveLength(1);
  });
  it('copies the full arrangement and history while preserving the minted version', async () => {
    const original = await createSong({ ...f.song, public: true, metadata_cid: 'cid', chain_song_id: '1', tx_hash: 'tx', network: 'network', licenses: 10, license_price: 25 });
    await createStem({ ...f.stem, volume: .7, pan: -.4, is_muted: true, waveform_peaks_url: 'peaks.json' });
    await createTake({ ...f.take, provenance: { taskId: 'task', sourceUrl: f.song.url, sourceTakeId: f.take.id, sourceDuration: 120, target: 'stem', targetStemId: f.stem.id, region: { start: 10, end: 20 }, outputDuration: 120, parameters: {} } });
    const snapshot = { songId: f.song.id, tracks: [
      { id: f.stem.id, activeTakeId: f.take.id, clips: [{ id: 'clip', url: f.stem.url, startTime: 4, offset: 3, duration: 8 }], fx: { delay: { wet: .2 } }, mixer: { volume: .7, pan: -.4 } },
      { id: 'keys', pianoRollNotes: [{ id: 'note', pitch: 60, start: 2, duration: 1 }], sequencerVoices: [{ steps: [1, 0] }], strudelCode: 'sound("bd")' },
    ], activeTakeId: f.take.id, selection: { start: 10, end: 20 }, selected: { [f.stem.id]: f.take.id } };
    const date = new Date('2026-01-01');
    await createCommit({ id: 'parent', song_id: f.song.id, user_address: f.evm, message: 'First', timeline_snapshot: snapshot, created_at: date });
    await createCommit({ id: 'child', song_id: f.song.id, user_address: f.evm, parent_commit_id: 'parent', message: 'Second', timeline_snapshot: snapshot, created_at: date });
    const draft = await copySong(f.song.id), project = await getFullSongProject(draft.id), history = await listCommitsBySong(draft.id);
    expect(draft).toMatchObject({ family: f.song.id, basis: f.song.id, version: 2, public: false, metadata_cid: null, chain_song_id: null, tx_hash: null, url: f.song.url, licenses: 10, license_price: 25 });
    expect(project.stems).toHaveLength(1); expect(project.takes).toHaveLength(1); expect(history).toHaveLength(2);
    const lane = project.stems[0], take = project.takes[0], child = history.find(commit => commit.message === 'Second')!, parent = history.find(commit => commit.message === 'First')!;
    expect(lane.id).not.toBe(f.stem.id); expect(take.id).not.toBe(f.take.id);
    expect(lane).toMatchObject({ volume: expect.closeTo(.7), pan: expect.closeTo(-.4), is_muted: true, waveform_peaks_url: 'peaks.json' });
    expect(take).toMatchObject({ stem_id: lane.id, provenance: { targetStemId: lane.id, sourceTakeId: take.id } });
    expect(child.parent_commit_id).toBe(parent.id);
    expect(child.timeline_snapshot).toEqual({ ...snapshot, songId: draft.id, tracks: [{ ...snapshot.tracks[0], id: lane.id, activeTakeId: take.id }, snapshot.tracks[1]], activeTakeId: take.id, selected: { [lane.id]: take.id } });
    expect(await getSongById(f.song.id)).toEqual(original);
    await updateSong(draft.id, { url: 'changed.wav' });
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
    await expect(updateSong(f.song.id, { url: 'changed.wav' })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('reuses the editable version under repeated concurrent requests', async () => {
    await createSong({ ...f.song, metadata_cid: 'cid' });
    await createStem(f.stem);
    const copies = await Promise.all(Array.from({ length: 5 }, () => copySong(f.song.id)));
    expect(new Set(copies.map(song => song.id)).size).toBe(1);
    expect(await listSongsByCreator(f.evm)).toHaveLength(2);
    expect(await listStemsBySong(copies[0].id)).toHaveLength(1);
    await updateSong(copies[0].id, { metadata_cid: 'next-cid' });
    expect(await copySong(copies[0].id)).toMatchObject({ family: f.song.id, basis: copies[0].id, version: 3 });
    expect(await copySong(f.song.id)).toMatchObject({ family: f.song.id, basis: f.song.id, version: 4 });
  });
  it('rolls back the song and children when copying history fails', async () => {
    await createSong({ ...f.song, metadata_cid: 'cid' }); await createStem(f.stem); await createTake(f.take);
    await createCommit({ id: 'parent', song_id: f.song.id, user_address: f.evm, message: 'First', timeline_snapshot: {} });
    await postgres.song.exec(`CREATE FUNCTION reject_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.song_id != 'song-a' THEN RAISE EXCEPTION 'copy failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_copy BEFORE INSERT ON commits FOR EACH ROW EXECUTE FUNCTION reject_copy();`);
    try {
      await expect(copySong(f.song.id).catch(error => { throw databaseCause(error); })).rejects.toThrow('copy failure');
      expect(await listSongsByCreator(f.evm)).toHaveLength(1);
      for (const table of ['stems', 'takes', 'commits']) expect((await postgres.song.query(`select count(*)::int as count from ${table}`)).rows).toEqual([{ count: 1 }]);
    } finally { await postgres.song.exec('DROP TRIGGER reject_copy ON commits; DROP FUNCTION reject_copy()'); }
  });
  it('returns all public songs across creators, excludes private songs and honors explicit pages', async () => {
    const records = Array.from({ length: 61 }, (_, i) => ({
      ...f.song, id: `public-${i}`, creator: i % 2 ? f.evm : f.svm, public: true,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }));
    for (const record of records) await createSong(record);
    await createSong(f.song);
    const expected = records.toReversed().map(song => song.id);
    expect((await listAllSongs()).map(song => song.id)).toEqual(expected);
    expect((await listAllSongs(5, 10)).map(song => song.id)).toEqual(expected.slice(10, 15));
    expect((await listAllSongs(undefined, 60)).map(song => song.id)).toEqual(expected.slice(60));
  });
  it('indexes the public catalogue in newest-first order', async () => {
    const result = await postgres.song.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='songs_public_created_idx'");
    expect(result.rows[0]?.indexdef).toMatch(/created_at DESC.*WHERE.*public/);
  });
  it('persists a saved voice separately from checkpoint adapters', async () => {
    await expect(createVoice({ id: 'voice-a', name: 'Fixture', creator: f.evm, training_group: 'group-a', sample_url: 'https://fixture.invalid/sample.wav', status: 'saved' })).resolves.toMatchObject({ id: 'voice-a' });
  });
  it('persists a pending song with the nullable duration allowed by the runtime schema', async () => {
    await expect(createSong({ ...f.song, duration: null })).resolves.toMatchObject({ duration: null });
  });
  it('rejects incomplete consent before writing persistent rows', async () => {
    await putWalletPair({ evmAddress: f.evm, svmAddress: f.svm });
    await expect(putUserConsent({ address: f.evm, signature: '0x', message: 'fixture' })).rejects.toThrow();
    expect(await getUserConsent(f.evm)).toBeNull();
  });
  it('records first consent for either selected account and reads it from both addresses', async () => {
    const input = { address: f.svm, svmAddress: f.svm, metadata: { evmAddress: f.evm }, signature: 'signed', message: 'terms', disclaimerType: 'generation', policyVersion: '1.0.0' };
    await putUserConsent(input);
    for (const address of [f.evm, f.svm]) expect(await getUserConsent({ address, disclaimerType: 'generation', policyVersion: '1.0.0' })).toMatchObject({ signature: 'signed', message: 'terms' });
  });
  it('concurrent take activation has exactly one persistent active row', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take); await createTake({ ...f.take, id: 'take-b', is_active: false });
    await Promise.all([activateTake(f.song.id, f.stem.id, f.take.id), activateTake(f.song.id, f.stem.id, 'take-b')]);
    expect((await listTakesBySong(f.song.id)).filter((take) => take.is_active)).toHaveLength(1);
  });
  it('second activation write failure restores the prior persistent active take', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take); await createTake({ ...f.take, id: 'take-b', is_active: false });
    await postgres.song.exec(`
      CREATE OR REPLACE FUNCTION fixture_reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = 'take-b' AND NEW.is_active THEN RAISE EXCEPTION 'fixture activation failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_activation_failure BEFORE UPDATE ON takes FOR EACH ROW EXECUTE FUNCTION fixture_reject_activation();
    `);
    try {
      await expect(activateTake(f.song.id, f.stem.id, 'take-b')).rejects.toThrow('fixture activation failure');
      expect((await listTakesBySong(f.song.id)).find((take) => take.id === f.take.id)?.is_active).toBe(true);
    } finally {
      await postgres.song.exec('DROP TRIGGER fixture_activation_failure ON takes; DROP FUNCTION fixture_reject_activation()');
    }
  });
  it('activation cannot persist a take selected through another song', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await createSong({ ...f.song, id: 'song-b' }); await createTake({ ...f.take, id: 'take-other', song_id: 'song-b', stem_id: null, is_active: false });
    await activateTake(f.song.id, f.stem.id, 'take-other');
    expect((await listTakesBySong('song-b'))[0].is_active).toBe(false);
  });
  it('foreign key rejects a take referring to a stem in a different song', async () => {
    await createSong(f.song); await createSong({ ...f.song, id: 'song-b' }); await createStem(f.stem);
    await expect(createTake({ ...f.take, song_id: 'song-b' }).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23503' });
  });
  it('stem upsert cannot overwrite an ID belonging to another song', async () => {
    await createSong(f.song); await createSong({ ...f.song, id: 'song-b' }); await createStem(f.stem);
    await expect(createStem({ ...f.stem, song_id: 'song-b', url: 'https://fixture.invalid/attacker.wav' })).rejects.toThrow('another song');
    expect((await listStemsBySong(f.song.id))[0].url).toBe(f.stem.url);
  });
  it('take upsert cannot overwrite an ID belonging to another song', async () => {
    await createSong(f.song); await createSong({ ...f.song, id: 'song-b' }); await createStem(f.stem); await createTake(f.take);
    await expect(createTake({ ...f.take, song_id: 'song-b', stem_id: null, url: 'https://fixture.invalid/attacker.wav' })).rejects.toThrow('another song');
    expect((await listTakesBySong(f.song.id))[0].url).toBe(f.take.url);
  });
  it('active take insertion atomically replaces the current selection', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await createTake({ ...f.take, id: 'take-b', is_active: true });
    expect((await listTakesBySong(f.song.id)).filter(take => take.is_active).map(take => take.id)).toEqual(['take-b']);
  });
  it('failed active take insertion preserves the current selection', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await expect(createTake({ ...f.take, id: 'take-b', model: null } as any).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23502' });
    expect((await listTakesBySong(f.song.id)).filter(take => take.is_active).map(take => take.id)).toEqual([f.take.id]);
  });
  it('missing activation target leaves the current selection intact', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await activateTake(f.song.id, f.stem.id, 'missing');
    expect((await listTakesBySong(f.song.id))[0].is_active).toBe(true);
  });
  it('null-stem activation retains the established song-wide selection behavior', async () => {
    await createSong(f.song); await createStem(f.stem); await createTake(f.take);
    await createStem({ ...f.stem, id: 'stem-b' });
    await createTake({ ...f.take, id: 'take-b', stem_id: 'stem-b', is_active: true });
    await activateTake(f.song.id, null, f.take.id);
    expect((await listTakesBySong(f.song.id)).filter(take => take.is_active).map(take => take.id)).toEqual([f.take.id]);
  });
  it.each([{ license_price: -1 }, { stream_price: -1 }, { duration: -1 }, { licenses: -1 }, { version: 0 }])('database rejects invalid commerce/metadata values %j', async (changes) => {
    await createSong(f.song);
    await expect(updateSong(f.song.id, changes).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23514' });
  });
  it.each([{ pan: 2 }, { pan: -2 }, { volume: -1 }, { volume: Infinity }])('database rejects invalid mixer values %j', async (state) => {
    await createSong(f.song); await createStem(f.stem);
    await expect(updateStemMixer(f.stem.id, state).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23514' });
  });
  it('database rejects inverted repaint intervals', async () => {
    await createSong(f.song); await createStem(f.stem);
    await expect(createTake({ ...f.take, repainting_start: 20, repainting_end: 10 }).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23514' });
  });
  it('database rejects a nonexistent commit parent', async () => {
    await createSong(f.song);
    await expect(createCommit({ id: 'commit-a', song_id: f.song.id, user_address: f.evm, parent_commit_id: 'missing', message: 'Fixture', timeline_snapshot: {} }).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23503' });
  });
  it('database rejects unsupported voice lifecycle status', async () => {
    await expect(createVoice({ id: 'voice-a', name: 'Fixture', creator: f.evm, training_group: 'group-a', status: 'nonexistent' as any }).catch(error => { throw databaseCause(error); })).rejects.toMatchObject({ code: '23514' });
  });
  it('mixed-case EVM creation is visible through normalized creator listing', async () => {
    await createSong({ ...f.song, creator: f.evm.toUpperCase().replace('0X', '0x') });
    expect(await listSongsByCreator(f.evm)).toHaveLength(1);
  });
  it('song ownership remains immutable through generic updates', async () => {
    await createSong(f.song); await expect(updateSong(f.song.id, { creator: `0x${'b'.repeat(40)}` })).rejects.toThrow('ownership');
    expect((await getSongById(f.song.id))?.creator).toBe(f.evm);
  });
  it('primary-key indexes also provide a creator filter index for growing song catalogs', async () => {
    const indexes = await postgres.song.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename='songs'");
    expect(indexes.rows.some((row) => row.indexdef.includes('(creator'))).toBe(true);
  });
});


describe('generation transaction', () => {
  const audio = 'https://fixture.invalid/generated.wav';
  const master = { ...f.stem, name: 'master', url: audio };
  const initial: any = { ...f.take, task: 'text2music', url: audio };
  it('commits the master and initial take together and replays without resetting edits', async () => {
    await createSong({ ...f.song, url: '' });
    initial.provenance = { taskId:'generation', sourceUrl:audio, sourceTakeId:null, sourceDuration:30, target:'master', targetStemId:master.id, region:null, outputDuration:30, parameters:{ submitted:{ bpm:100, lyrics:'[Verse]\n[whispered]\nHello' }, resolved:{ bpm:100 } } };
    await finalizeSong(f.song.id, [{ ...f.song, url: audio }], master, [initial]);
    expect((await listTakesBySong(f.song.id))[0].provenance).toEqual(initial.provenance);
    expect(await getFullSongProject(f.song.id)).toMatchObject({ song: { url: audio }, stems: [{ url: audio }], takes: [{ url: audio, is_active: true }] });
    await updateSong(f.song.id, { url: 'https://fixture.invalid/merged.wav' });
    await finalizeSong(f.song.id, [{ ...f.song, url: audio }], master, [initial]);
    expect((await getFullSongProject(f.song.id)).song?.url).toBe('https://fixture.invalid/merged.wav');
    expect(await listTakesBySong(f.song.id)).toHaveLength(1);
  });
  it('rolls back all rows when the take insert fails', async () => {
    await createSong({ ...f.song, url: '' });
    await expect(finalizeSong(f.song.id, [{ ...f.song, url: audio }], master, [{ ...initial, take_number: -1 }])).rejects.toThrow();
    expect(await getFullSongProject(f.song.id)).toMatchObject({ song: { url: '' }, stems: [], takes: [] });
    await finalizeSong(f.song.id, [{ ...f.song, url: audio }], master, [initial]);
    expect((await getFullSongProject(f.song.id)).takes).toHaveLength(1);
  });
  it('rejects an immutable song without creating a master or take', async () => {
    await createSong({ ...f.song, metadata_cid: 'cid' });
    await expect(finalizeSong(f.song.id, [{ ...f.song, url: audio }], master, [initial])).rejects.toThrow();
    expect(await getFullSongProject(f.song.id)).toMatchObject({ song: { url: f.song.url }, stems: [], takes: [] });
  });
  it('rejects a foreign stem identifier and rolls back the master URL', async () => {
    await createSong({ ...f.song, url: '' });
    await createSong({ ...f.song, id: 'song-b' });
    await createStem({ ...master, song_id: 'song-b' });
    await expect(finalizeSong(f.song.id, [{ ...f.song, url: audio }], master, [initial])).rejects.toThrow();
    expect((await getSongById(f.song.id))?.url).toBe('');
    expect((await listStemsBySong('song-b'))[0].url).toBe(audio);
  });
});
