import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { broker, resetContexts } from '../support/task-context.js';

vi.mock('../../broker/valkey.js', () => broker);
vi.mock('../../databases/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/neon-http');
  const pg = await import('../support/database-postgres.js');
  return { songDb: drizzle(pg.neonTransport as any), userSql: pg.sqlTag('user'), songSql: pg.sqlTag('song') };
});
const worker = vi.hoisted(() => ({ releaseTask: vi.fn(), queryResult: vi.fn() }));
const audio = vi.hoisted(() => new Map<string, Buffer>());
function sourceWave() {
  const data = Buffer.alloc(44 + 120 * 8 * 2); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8); data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8, 24); data.writeUInt32LE(16, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40); return data;
}
vi.mock('../../generation/client.js', async () => ({ ...(await vi.importActual<any>('../../generation/client.js')), client: worker }));
vi.mock('../../storage/r2.js', () => ({
  persistAudioToR2: async (_bucket: string, key: string) => `https://fixture.invalid/${key}`,
  readAudio: async (url: string) => ({ buffer: audio.get(url) ?? sourceWave(), contentType: 'audio/wav' }),
  uploadToR2: async (_bucket: string, key: string, buffer: Buffer) => { const url = `https://fixture.invalid/${key}`; audio.set(url, buffer); return url; },
}));
import { clearPostgres, closePostgres, fixtures as f, initializePostgres, postgres } from '../support/database-postgres.js';
import { runMigrations } from '../../databases/migrate.js';
import { createSong, getSongById } from '../../databases/songs.js';
import { createStem, listStemsBySong } from '../../databases/stems.js';
import { createTake, listTakesBySong } from '../../databases/takes.js';
import { listCommitsBySong } from '../../databases/commits.js';
import { readWave } from '../../editing/audio.js';
import { Service } from '../../editing/service.js';

const edit = { songId: f.song.id, userAddress: f.evm, task: 'cover' as const, prompt: 'new style', coverStrength: 0.6 };
beforeAll(async () => { await initializePostgres(); await runMigrations(); });
afterAll(closePostgres);
beforeEach(async () => {
  await clearPostgres(); resetContexts(); vi.resetAllMocks(); audio.clear();
  await createSong(f.song);
  await createStem({ ...f.stem, name: 'master', url: f.song.url });
  await createTake({ ...f.take, task: 'text2music', url: f.song.url });
  worker.releaseTask.mockResolvedValue({ task_id: 'worker-edit', status: 'pending' });
  worker.queryResult.mockResolvedValue({ results: { 'worker-edit': { status: 'ready', audio_urls: ['https://worker.invalid/generated.wav'] } } });
});

async function generateVersion(service = new Service(), params = edit) {
  await service.dispatchEditTask(params);
  return service.finalizeEditResult({ ...params, taskId: 'worker-edit' });
}

describe('reviewable edits on the production PostgreSQL persistence path', () => {
  it('commits the rendered working section atomically and leaves other candidates pending', async () => {
    const service = new Service();
    const first = await service.extractSection({ songId:f.song.id, userAddress:f.evm, start:10, end:20 });
    const second = await service.extractSection({ songId:f.song.id, userAddress:f.evm, start:10, end:20 });
    const rendered = sourceWave();
    rendered.writeInt16LE(1234, 44 + 10 * 8 * 2);
    audio.set('https://fixture.invalid/render.wav', rendered);
    const composition = { takeIds:[first.take.id], region:{start:10,end:20}, original:true, commitId:null, srcAudioUrl:'https://fixture.invalid/render.wav' };
    const result = await service.switchActiveTake(f.song.id, null, first.take.id, f.evm, 'merge', composition);
    expect(readWave(audio.get(result.take!.url)!).samples.readFloatLE(10 * 8 * 4)).toBeCloseTo(1234 / 32768, 7);
    const takes = await listTakesBySong(f.song.id);
    expect(takes.some(t => t.id === first.take.id)).toBe(false);
    expect(takes.find(t => t.id === second.take.id)?.provenance?.mergedInto).toBeUndefined();
    expect((await getSongById(f.song.id))?.url).toBe(result.take!.url);
    expect((await service.switchActiveTake(f.song.id, null, first.take.id, f.evm, 'merge', composition)).take!.id).toBe(result.take!.id);
    expect(await listCommitsBySong(f.song.id)).toHaveLength(1);
    expect((await listCommitsBySong(f.song.id))[0].timeline_snapshot).toMatchObject({
      takes: expect.arrayContaining([expect.objectContaining({id:first.take.id})]),
    });
  });
  it('keeps the uncommitted parts of overlapping candidates pending', async () => {
    const service = new Service();
    const candidate = await service.extractSection({ songId:f.song.id, userAddress:f.evm, start:5, end:25 });
    audio.set('https://fixture.invalid/render.wav', sourceWave());
    const merge = { takeIds:[candidate.take.id], region:{start:10,end:20}, original:false, commitId:null, srcAudioUrl:'https://fixture.invalid/render.wav' };
    const result = await service.switchActiveTake(f.song.id, null, candidate.take.id, f.evm, 'merge', merge);
    const saved = (await listTakesBySong(f.song.id)).find(t => t.id === candidate.take.id)!;
    expect(saved.provenance?.mergedInto).toBeUndefined();
    expect(saved.provenance).toMatchObject({ regions:[{start:5,end:10},{start:20,end:25}] });
    audio.set('https://fixture.invalid/retry.wav', sourceWave());
    const retry = await service.switchActiveTake(f.song.id, null, candidate.take.id, f.evm, 'merge', {...merge, srcAudioUrl:'https://fixture.invalid/retry.wav'});
    expect(retry.take!.id).toBe(result.take!.id);
    expect(await listCommitsBySong(f.song.id)).toHaveLength(1);
  });
  it('does not recreate a consumed worker result on a later status poll', async () => {
    const service = new Service();
    const params = {...edit,task:'repaint' as const,repaintingStart:10,repaintingEnd:20};
    const version = await generateVersion(service,params as typeof edit);
    await service.switchActiveTake(f.song.id,null,version.take.id,f.evm,'merge',{
      takeIds:[version.take.id],region:{start:10,end:20},original:false,commitId:null,srcAudioUrl:f.song.url,
    });
    expect((await listTakesBySong(f.song.id)).some(take => take.id === version.take.id)).toBe(false);
    expect(await service.finalizeEditResult({...params,taskId:'worker-edit'})).toMatchObject({status:'ready',versionState:'merged',take:null});
    expect((await listTakesBySong(f.song.id)).some(take => take.id === version.take.id)).toBe(false);
  });
  it('rolls back candidate deletion when the merged history cannot be saved', async () => {
    const service = new Service();
    const candidate = await service.extractSection({songId:f.song.id,userAddress:f.evm,start:10,end:20});
    await postgres.song.exec(`CREATE FUNCTION reject_section_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'section commit failure'; END $$;
      CREATE TRIGGER reject_section_commit BEFORE INSERT ON commits FOR EACH ROW EXECUTE FUNCTION reject_section_commit();`);
    try {
      await expect(service.switchActiveTake(f.song.id,null,candidate.take.id,f.evm,'merge',{
        takeIds:[candidate.take.id],region:{start:10,end:20},original:false,commitId:null,srcAudioUrl:f.song.url,
      })).rejects.toThrow('section commit failure');
      expect((await listTakesBySong(f.song.id)).some(take => take.id === candidate.take.id)).toBe(true);
      expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
      expect(await listCommitsBySong(f.song.id)).toEqual([]);
    } finally { await postgres.song.exec('DROP TRIGGER reject_section_commit ON commits; DROP FUNCTION reject_section_commit()'); }
  });
  it('commits a moved interval and retains unconsumed source regions', async () => {
    const service = new Service();
    const candidate = await service.extractSection({songId:f.song.id,userAddress:f.evm,start:5,end:25});
    audio.set('https://fixture.invalid/render.wav',sourceWave());
    const result = await service.switchActiveTake(f.song.id,null,candidate.take.id,f.evm,'merge',{
      takeIds:[candidate.take.id],region:{start:30,end:40},original:false,commitId:null,
      srcAudioUrl:'https://fixture.invalid/render.wav',placements:[{takeId:candidate.take.id,shift:20}],
    });
    const saved = (await listTakesBySong(f.song.id)).find(take => take.id === candidate.take.id)!;
    expect(saved.provenance?.regions).toEqual([{start:5,end:10},{start:20,end:25}]);
    expect(result.take!.provenance?.parameters).toMatchObject({placements:[{takeId:candidate.take.id,shift:20}]});
  });
  it('rejects a moved candidate before zero without consuming its source', async () => {
    const service = new Service();
    const candidate = await service.extractSection({songId:f.song.id,userAddress:f.evm,start:5,end:25});
    await expect(service.switchActiveTake(f.song.id,null,candidate.take.id,f.evm,'merge',{
      takeIds:[candidate.take.id],region:{start:0,end:10},original:false,commitId:null,
      srcAudioUrl:f.song.url,placements:[{takeId:candidate.take.id,shift:-10}],
    })).rejects.toThrow('placement');
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
  });
  it('rejects a stale merge without changing the song or candidate', async () => {
    const service = new Service();
    const result = await service.extractSection({ songId:f.song.id, userAddress:f.evm, start:10, end:20 });
    await expect(service.switchActiveTake(f.song.id, null, result.take.id, f.evm, 'merge', { takeIds:[result.take.id], region:{start:10,end:20}, original:false, commitId:'stale', srcAudioUrl:f.song.url })).rejects.toMatchObject({statusCode:409});
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
    expect((await listTakesBySong(f.song.id)).find(t => t.id === result.take.id)?.provenance?.mergedInto).toBeUndefined();
  });
  it('persists an extracted segment while leaving the source active', async () => {
    const result = await new Service().extractSection({ songId: f.song.id, userAddress: f.evm, start: 10, end: 20 });
    expect(result.take).toMatchObject({ is_active: false, repainting_start: 10, repainting_end: 20, provenance: { audioOffset: 0 } });
    expect(readWave(audio.get(result.take.url)!).duration).toBe(10);
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
    expect((await listTakesBySong(f.song.id)).find(take => take.is_active)?.id).toBe(f.take.id);
  });
  it('rejects merging a whole version and preserves the selected base', async () => {
    const service = new Service(), version = await generateVersion(service);
    await expect(service.switchActiveTake(f.song.id, null, version.take.id, f.evm, 'merge')).rejects.toThrow('segment');
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
  });
  it('keeps a generated edit pending while preserving the active original and history', async () => {
    const result = await generateVersion();
    expect(result).toMatchObject({ status: 'ready', versionState: 'pending', take: { is_active: false } });
    expect((await listTakesBySong(f.song.id)).filter(take => take.is_active).map(take => take.id)).toEqual([f.take.id]);
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
    expect((await listStemsBySong(f.song.id))[0].url).toBe(f.song.url);
    expect(await listCommitsBySong(f.song.id)).toEqual([]);
  });

  it('merges through activation, updates the persistent master and records the selected version', async () => {
    const service = new Service();
    const version = await generateVersion(service);
    const result = await service.switchActiveTake(f.song.id, null, version.take.id, f.evm);
    expect(result).toMatchObject({ success: true, activeTakeId: version.take.id, take: { is_active: true } });
    expect((await getSongById(f.song.id))?.url).toBe(version.take.url);
    expect((await listStemsBySong(f.song.id))[0].url).toBe(version.take.url);
    const history = await listCommitsBySong(f.song.id);
    expect(history).toHaveLength(1);
    expect(history[0].timeline_snapshot).toMatchObject({ activeTakeId: version.take.id, action: 'base' });
  });

  it('discards an inactive version without changing the original or recreating it on another poll', async () => {
    const service = new Service();
    const version = await generateVersion(service);
    expect(await service.deleteTake(version.take.id)).toMatchObject({ success: true });
    expect((await listTakesBySong(f.song.id)).map(take => take.id)).toEqual([f.take.id]);
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
    const result = await service.finalizeEditResult({ ...edit, taskId: 'worker-edit' });
    expect(result).toMatchObject({ status: 'ready', versionState: 'discarded' });
    expect((await listTakesBySong(f.song.id)).map(take => take.id)).toEqual([f.take.id]);
  });

  it('keeps a new instrument layer out of the arrangement until explicit merge', async () => {
    const service = new Service();
    const params = { ...edit, task: 'lego' as const, trackName: 'bass' };
    const version = await generateVersion(service, params as typeof edit);
    expect(version.take).toMatchObject({ stem_id: null, is_active: false, provenance: { target: 'layer', layerName: 'bass' } });
    expect(await listStemsBySong(f.song.id)).toHaveLength(1);
    await service.switchActiveTake(f.song.id, null, version.take.id, f.evm);
    const stems = await listStemsBySong(f.song.id);
    expect(stems).toHaveLength(2);
    expect(stems.find(stem => stem.name === 'bass')?.url).toBe(version.take.url);
    expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
    expect((await listTakesBySong(f.song.id)).filter(take => take.is_active)).toHaveLength(2);
  });

  it('cannot discard the active original', async () => {
    await expect(new Service().deleteTake(f.take.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await listTakesBySong(f.song.id)).toHaveLength(1);
  });

  it('rejects a nonexistent merge target instead of reporting success', async () => {
    await expect(new Service().switchActiveTake(f.song.id, null, 'missing', f.evm)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('dispatches explicit outpainting bounds for temporal extension', async () => {
    await new Service().dispatchEditTask({ ...edit, task: 'extend', audioDuration: 150 });
    expect(worker.releaseTask.mock.calls[0][0]).toMatchObject({ task_type: 'repaint', repainting_start: 120, repainting_end: 150, chunk_mask_mode: 'explicit', audio_format: 'wav' });
  });

  it('rejects missing extension duration instead of inventing thirty seconds', async () => {
    await expect(new Service().dispatchEditTask({ ...edit, task: 'extend' })).rejects.toThrow('duration');
    expect(worker.releaseTask).not.toHaveBeenCalled();
  });

  it('honors SFT for repaint rather than substituting Base', async () => {
    await new Service().dispatchEditTask({ ...edit, task: 'repaint', modelQuality: 'sft', repaintingStart: 0, repaintingEnd: 5, repaintMode: 'balanced', repaintStrength: .2 });
    expect(worker.releaseTask.mock.calls[0][0]).toMatchObject({ model: 'acestep-v15-xl-sft', task_type: 'repaint', repaint_mode: 'balanced', repaint_strength: .2, chunk_mask_mode: 'explicit' });
  });

  it('preserves the source and exact changed interval in persistent provenance', async () => {
    const service = new Service(), params = { ...edit, task: 'repaint' as const, repaintingStart: 0, repaintingEnd: 5, repaintMode: 'balanced' as const, repaintStrength: .2 };
    const version = await generateVersion(service, params as typeof edit);
    expect(version.take).toMatchObject({ repainting_start: 0, repainting_end: 5, provenance: { sourceUrl: f.song.url, sourceTakeId: f.take.id, sourceDuration: 120, region: { start: 0, end: 5 }, parameters: { repaintMode: 'balanced', repaintStrength: .2 } } });
  });

  it('merges two pending nonoverlapping regions without losing the first edit', async () => {
    const service = new Service();
    const firstAudio = sourceWave(), secondAudio = sourceWave();
    firstAudio.fill(0);
    sourceWave().copy(firstAudio, 0, 0, 44);
    sourceWave().copy(secondAudio, 0, 0, 44);
    for (let frame = 0; frame < 120 * 8; frame++) {
      firstAudio.writeInt16LE(1000, 44 + frame * 2);
      secondAudio.writeInt16LE(2000, 44 + frame * 2);
    }
    audio.set('https://worker.invalid/first.wav', firstAudio);
    audio.set('https://worker.invalid/second.wav', secondAudio);
    const versions = [];
    for (const [taskId, start, end, url] of [
      ['first', 10, 20, 'https://worker.invalid/first.wav'],
      ['second', 30, 40, 'https://worker.invalid/second.wav'],
    ] as const) {
      const params = { ...edit, task: 'repaint' as const, repaintingStart: start, repaintingEnd: end };
      worker.releaseTask.mockResolvedValueOnce({ task_id: taskId, status: 'pending' });
      worker.queryResult.mockResolvedValueOnce({ results: { [taskId]: { status: 'ready', audio_urls: [url] } } });
      await service.dispatchEditTask(params);
      versions.push((await service.finalizeEditResult({ ...params, taskId })).take);
    }
    for (const version of versions) await service.switchActiveTake(f.song.id, null, version.id, f.evm, 'merge');
    const song = await getSongById(f.song.id);
    const merged = readWave(audio.get(song!.url)!);
    const expected = Array.from({ length: 120 * 8 }, (_, frame) => frame >= 10 * 8 && frame < 20 * 8 ? 1000 : frame >= 30 * 8 && frame < 40 * 8 ? 2000 : 0);
    expect(Array.from({ length: merged.frames }, (_, frame) => merged.samples.readInt16LE(frame * 2))).toEqual(expected);
    const persisted = (await listTakesBySong(f.song.id)).find(take => take.id === versions[1].id)!;
    expect(persisted.url).toBe(song!.url);
    expect((await listStemsBySong(f.song.id))[0].url).toBe(song!.url);
    expect((await listCommitsBySong(f.song.id))).toHaveLength(2);
  });

  it('rolls back master selection and URL when the persistent activation fails', async () => {
    const service = new Service(); const version = await generateVersion(service);
    await postgres.song.exec(`CREATE FUNCTION reject_edit_merge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${version.take.id}' AND NEW.is_active THEN RAISE EXCEPTION 'merge failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_edit_merge BEFORE UPDATE ON takes FOR EACH ROW EXECUTE FUNCTION reject_edit_merge();`);
    try {
      await expect(service.switchActiveTake(f.song.id, null, version.take.id, f.evm)).rejects.toThrow('merge failure');
      expect((await getSongById(f.song.id))?.url).toBe(f.song.url);
      expect((await listTakesBySong(f.song.id)).filter(take => take.is_active).map(take => take.id)).toEqual([f.take.id]);
      expect(await listCommitsBySong(f.song.id)).toEqual([]);
    } finally { await postgres.song.exec('DROP TRIGGER reject_edit_merge ON takes; DROP FUNCTION reject_edit_merge()'); }
  });
});
