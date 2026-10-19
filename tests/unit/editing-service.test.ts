import { broker, contexts, resetContexts, generationContext, editContext } from '../support/task-context.js';
vi.mock('../../broker/valkey.js', () => broker);
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ releaseTask: vi.fn(), queryResult: vi.fn(), separate: vi.fn(), getSongById: vi.fn(), createTake: vi.fn(), activateTake: vi.fn(), listTakesBySong: vi.fn(), getTakeById: vi.fn(), deleteTake: vi.fn(), createStem: vi.fn(), updateStemMixer: vi.fn(), listStemsBySong: vi.fn(), createCommit: vi.fn(), listCommitsBySong: vi.fn(), persistAudioToR2: vi.fn() }));
vi.mock('../../generation/client.js', async () => ({ ...(await vi.importActual<any>('../../generation/client.js')), client: { releaseTask: m.releaseTask, queryResult: m.queryResult, separate: m.separate } }));
vi.mock('../../databases/songs.js', () => ({ getSongById: m.getSongById }));
vi.mock('../../databases/takes.js', () => ({ createTake: m.createTake, activateTake: m.activateTake, listTakesBySong: m.listTakesBySong, getTakeById: m.getTakeById, deleteTake: m.deleteTake }));
vi.mock('../../databases/stems.js', () => ({ createStem: m.createStem, updateStemMixer: m.updateStemMixer, listStemsBySong: m.listStemsBySong }));
vi.mock('../../databases/commits.js', () => ({ createCommit: m.createCommit, listCommitsBySong: m.listCommitsBySong }));
vi.mock('../../storage/r2.js', () => ({ persistAudioToR2: m.persistAudioToR2, readAudio: async () => ({ buffer: fixtureWave(), contentType: 'audio/wav' }), uploadToR2: m.persistAudioToR2 }));
import { Service, editingService, service } from '../../editing/service.js';

const base = { songId: 'song-1', userAddress: '0xABCDEF0123', task: 'cover' as const, prompt: 'new style', coverStrength: 0.6 };
const parent = { id: 'song-1', title: 'Song', creator: '0xCreator', url: 'original.wav', duration: 60, tags: [] };
function fixtureWave() { const b = Buffer.alloc(44 + 60 * 8 * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8, 24); b.writeUInt32LE(16, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b; }
let api: Service;
beforeEach(() => {
  vi.resetAllMocks(); resetContexts(); editContext(); api = new Service(); vi.spyOn(Date, 'now').mockReturnValue(1728000000000);
  m.getSongById.mockResolvedValue(parent); m.releaseTask.mockResolvedValue({ task_id: 'task-1', status: 'pending' });
  m.queryResult.mockResolvedValue({ results: {} }); m.separate.mockResolvedValue({ task_id: 'sep-1', status: 'ready', stems: { vocals: 'v.wav' } });
  m.getTakeById.mockResolvedValue(null); m.listStemsBySong.mockResolvedValue([]); m.deleteTake.mockResolvedValue(true); m.listTakesBySong.mockResolvedValue([]); m.listCommitsBySong.mockResolvedValue([]);
  m.createStem.mockImplementation(async input => input); m.createTake.mockImplementation(async input => { m.getTakeById.mockResolvedValue(input); return input; }); m.createCommit.mockImplementation(async input => input);
  m.persistAudioToR2.mockImplementation(async (bucket, key) => `https://r2.test/${bucket}/${key}`);
});
afterEach(() => vi.restoreAllMocks());

describe('editing Service: dispatch and model routing', () => {
  it('exports stable compatibility aliases', () => expect(editingService).toBe(service));
  it('rejects unknown editing tasks before database or worker effects', async () => {
    await expect(api.dispatchEditTask({ ...base, task: 'unknown' as any })).rejects.toThrow('Invalid editing task');
    expect(m.getSongById).not.toHaveBeenCalled(); expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it('rejects a missing source song', async () => {
    m.getSongById.mockResolvedValue(null);
    await expect(api.dispatchEditTask(base)).rejects.toThrow('Song song-1 not found');
    expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it('rejects a song with no audio and no source override', async () => {
    m.getSongById.mockResolvedValue({ ...parent, url: '' });
    await expect(api.dispatchEditTask(base)).rejects.toThrow('Source audio URL is required');
  });
  it('uses a source override and forwards stem identity', async () => {
    contexts.delete('task-1');
    m.listStemsBySong.mockResolvedValue([{ id: 'stem-1', name: 'vocals' }]);
    const result = await api.dispatchEditTask({ ...base, srcAudioUrl: 'override.wav', stemId: 'stem-1' });
    expect(m.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ src_audio_path: 'override.wav', reference_audio_path: 'override.wav', batch_size: 1 }));
    expect(result).toEqual({ taskId: 'task-1', status: 'pending', songId: 'song-1', stemId: 'stem-1', task: 'cover' });
  });
  it.each([
    [{}, 'acestep-v15-xl-base', 50, 7], [{ modelQuality: 'base' }, 'acestep-v15-xl-base', 50, 7],
    [{ modelQuality: 'sft' }, 'acestep-v15-xl-sft', 50, 7], [{ modelVariant: 'sft' }, 'acestep-v15-xl-sft', 50, 7],
    [{ modelQuality: 'turbo' }, 'acestep-v15-xl-turbo', 8, 1], [{ modelVariant: 'turbo' }, 'acestep-v15-xl-turbo', 8, 1],
  ])('routes model selection %j to %s', async (selection, model, inference_steps, guidance_scale) => {
    contexts.delete('task-1');
    await api.dispatchEditTask({ ...base, ...selection } as any);
    expect(m.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ model, inference_steps, guidance_scale }));
  });
  it('requires both repaint bounds before dispatch', async () => {
    await expect(api.dispatchEditTask({ ...base, task: 'repaint', repaintingStart: 0 })).rejects.toThrow('start and end bounds');
    expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it('forwards repaint zero-valued controls and bounds', async () => {
    contexts.delete('task-1');
    await api.dispatchEditTask({ ...base, task: 'repaint', repaintingStart: 0, repaintingEnd: 5, repaintMode: 'conservative', repaintStrength: 0, repaintLatentCrossfadeFrames: 0, repaintWavCrossfadeSec: 0, lyrics: 'new words' });
    expect(m.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ task: 'repaint', task_type: 'repaint', repainting_start: 0, repainting_end: 5, repaint_mode: 'conservative', repaint_strength: 0, repaint_latent_crossfade_frames: 0, repaint_wav_crossfade_sec: 0, lyrics: 'new words' }));
  });
  it('forwards supported lego caption and track class controls', async () => {
    contexts.delete('task-1');
    await api.dispatchEditTask({ ...base, task: 'lego', globalCaption: 'mix', trackName: 'drums', trackClasses: ['drums'] });
    expect(m.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ task: 'lego', global_caption: 'mix', track_name: 'drums', track_classes: ['drums'] }));
  });
  it('requires an explicit extension duration', async () => {
    await expect(api.dispatchEditTask({ ...base, task: 'extend' })).rejects.toThrow('duration');
  });
  it('extends from actual decoded duration rather than stale song metadata', async () => {
    contexts.delete('task-1'); m.getSongById.mockResolvedValue({ ...parent, duration: 0 });
    await api.dispatchEditTask({ ...base, task: 'extend', audioDuration: 120 });
    const payload = m.releaseTask.mock.calls[0][0];
    expect(payload).toMatchObject({ task_type: 'repaint', repainting_start: 60, repainting_end: 120, audio_duration: 120 });
    expect(payload.src_audio_path).not.toBe(parent.url);
    const uploaded = m.persistAudioToR2.mock.calls.find(call => call[1].startsWith('sources/'))!;
    expect(uploaded[2].readUInt32LE(40) / 16).toBe(120);
    expect(uploaded[2].subarray(44, 44 + 60 * 16)).toEqual(fixtureWave().subarray(44));
  });
  it('provides complete source seconds for fractional extensions while preserving the requested boundary', async () => {
    contexts.delete('task-1');
    await api.dispatchEditTask({ ...base, task: 'extend', audioDuration: 61.251 });
    expect(m.releaseTask.mock.calls[0][0]).toMatchObject({ repainting_start: 60, repainting_end: 61.251, audio_duration: 61.251 });
    const uploaded = m.persistAudioToR2.mock.calls.find(call => call[1].startsWith('sources/'))!;
    expect(uploaded[2].readUInt32LE(40) / 16).toBe(62);
  });
  it('inherits source metadata through a consumed source snapshot and removes silent-tail reinjection', async () => {
    contexts.delete('task-1');
    m.listTakesBySong.mockResolvedValue([{ id: 'merged', url: parent.url, stem_id: null, is_active: true, provenance: { sourceTakeId: 'original', parameters: {} } }]);
    m.listCommitsBySong.mockResolvedValue([{ timeline_snapshot: { takes: [{ id: 'original', lyrics: '[Verse]\n[whispered]\nHello', provenance: { parameters: { submitted: { bpm: 100, keyScale: 'C major', vocalLanguage: 'en' } } } }] } }]);
    await api.dispatchEditTask({ ...base, task: 'extend', audioDuration: 75, seed: 7301 });
    expect(m.releaseTask.mock.calls[0][0]).toMatchObject({ lyrics: '[Verse]\n[whispered]\nHello', bpm: 100, key_scale: 'C major', vocal_language: 'en', seed: 7301, use_random_seed: false, use_format: false, repaint_mode: 'balanced', repaint_strength: 0.5, shift: 3 });
    expect(contexts.get('task-1').provenance.parameters).toMatchObject({ submitted: { seed: 7301 }, resolved: { bpm: 100 } });
  });
  it('keeps explicit extension choices including empty lyrics instead of inherited values', async () => {
    contexts.delete('task-1');
    m.listTakesBySong.mockResolvedValue([{ id: 'original', url: parent.url, stem_id: null, is_active: true, lyrics: 'old lyrics', provenance: { parameters: { submitted: { bpm: 100, keyScale: 'C major', vocalLanguage: 'en' } } } }]);
    await api.dispatchEditTask({ ...base, task: 'extend', audioDuration: 75, lyrics: '', bpm: 120, keyScale: 'D minor', vocalLanguage: 'it', seed: 0 });
    expect(m.releaseTask.mock.calls[0][0]).toMatchObject({ lyrics: '', bpm: 120, key_scale: 'D minor', vocal_language: 'it', seed: 0, use_random_seed: false });
  });
  it.each([0, 1])('preserves cover strength %s and noise zero', async coverStrength => {
    contexts.delete('task-1'); await api.dispatchEditTask({ ...base, coverStrength, coverNoiseStrength: 0 });
    expect(m.releaseTask.mock.calls[0][0]).toMatchObject({ audio_cover_strength: coverStrength, cover_noise_strength: 0 });
  });
  it('delegates extract to actual separation instead of release_task', async () => {
    contexts.delete('task-1');
    expect(await api.dispatchEditTask({ ...base, task: 'extract' })).toMatchObject({ task: 'extract', taskId: 'sep-1' });
    expect(m.separate.mock.calls[0][0]).toEqual({ src_audio_path: 'original.wav', stem_type: 'all' });
    expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it('propagates failed worker dispatch', async () => {
    m.releaseTask.mockRejectedValue(new Error('GPU unavailable'));
    await expect(api.dispatchEditTask(base)).rejects.toThrow('GPU unavailable');
  });
});

describe('editing Service: real separation and snapshots', () => {
  it.each([
    [null, 'not found'], [{ ...parent, url: '' }, 'No audio source'], [{ ...parent, creator: '' }, 'User address or song creator'],
  ])('rejects invalid separation preconditions', async (song, error) => {
    m.getSongById.mockResolvedValue(song);
    await expect(api.separateStems({ songId: 'song-1' })).rejects.toThrow(error);
    expect(m.separate).not.toHaveBeenCalled();
  });
  it('persists each nonempty stem with independent takes and a timeline snapshot', async () => {
    m.separate.mockResolvedValue({ task_id: 'sep-1', status: 'ready', stems: { Vocals: 'v.wav', drums: 'd.wav', empty: '' } });
    const result = await api.separateStems({ songId: 'song-1', userAddress: '0xABC', srcAudioUrl: 'override.wav', stemType: 'vocals' });
    expect(m.separate.mock.calls[0][0]).toEqual({ src_audio_path: 'override.wav', stem_type: 'vocals' });
    expect(m.persistAudioToR2.mock.calls).toEqual([['versions', expect.stringMatching(/^stems\/[a-f0-9]+-0\.wav$/), 'v.wav'], ['versions', expect.stringMatching(/^stems\/[a-f0-9]+-1\.wav$/), 'd.wav']]);
    expect(m.createStem.mock.calls.map(([stem]) => stem.name)).toEqual(['vocals', 'drums']);
    expect(m.createTake.mock.calls.map(([take]) => [take.model, take.task, take.is_active])).toEqual([['demucs-htdemucs', 'extract', true], ['demucs-htdemucs', 'extract', true]]);
    expect(m.createCommit).toHaveBeenCalledWith(expect.objectContaining({ user_address: '0xabc', timeline_snapshot: expect.objectContaining({ stemsCount: 2 }) }));
    expect(result).toMatchObject({ taskId: 'sep-1', task: 'extract', status: 'ready', stems: expect.any(Array) });
  });
  it('uses the song creator when an explicit separation address is omitted', async () => {
    await api.separateStems({ songId: 'song-1' });
    expect(m.createCommit).toHaveBeenCalledWith(expect.objectContaining({ user_address: '0xcreator' }));
  });
  it('retains the generated fallback separation ID for a synchronous worker response', async () => {
    m.separate.mockResolvedValue({ status: 'ready', stems: { vocals: 'v.wav' } });
    expect(await api.separateStems({ songId: 'song-1' })).toMatchObject({ taskId: expect.stringMatching(/^sep-[a-f0-9-]+$/) });
  });
  it('propagates separation worker failures before DB writes', async () => {
    m.separate.mockRejectedValue(new Error('demucs failed'));
    await expect(api.separateStems({ songId: 'song-1' })).rejects.toThrow('demucs failed');
    expect(m.createStem).not.toHaveBeenCalled(); expect(m.createCommit).not.toHaveBeenCalled();
  });
  it.each(['persistAudioToR2', 'createStem', 'createTake', 'createCommit'])('propagates separation %s failure rather than returning ready', async method => {
    m.separate.mockResolvedValue({ task_id: 'sep-1', status: 'ready', stems: { vocals: 'v.wav' } });
    m[method as 'createStem'].mockRejectedValue(new Error(`${method} failed`));
    await expect(api.separateStems({ songId: 'song-1' })).rejects.toThrow(`${method} failed`);
  });
  it('builds a default commit from current stems and first active take', async () => {
    m.listStemsBySong.mockResolvedValue([{ id: 'stem-1', name: 'vocals' }]);
    m.listTakesBySong.mockResolvedValue([{ id: 'inactive', is_active: false }, { id: 'active', is_active: true }]);
    const result = await api.createCommitSnapshot({ songId: 'song-1', message: 'checkpoint', userAddress: '0xABCDEF' });
    expect(m.createCommit).toHaveBeenCalledWith(expect.objectContaining({ message: 'checkpoint', user_address: '0xabcdef', timeline_snapshot: expect.objectContaining({ stems: [{ id: 'stem-1', name: 'vocals' }], activeTakeId: 'active', takesCount: 2 }) }));
    expect(result.success).toBe(true);
  });
  it('preserves a caller-provided timeline snapshot', async () => {
    const timelineSnapshot = { tracks: [], layout: 'custom' };
    await api.createCommitSnapshot({ songId: 'song-1', message: 'checkpoint', userAddress: '0xABCDEF', timelineSnapshot });
    expect(m.createCommit).toHaveBeenCalledWith(expect.objectContaining({ timeline_snapshot: timelineSnapshot }));
  });
  it('sets null activeTakeId for an empty project', async () => {
    await api.createCommitSnapshot({ songId: 'song-1', message: 'checkpoint', userAddress: '0xABCDEF' });
    expect(m.createCommit).toHaveBeenCalledWith(expect.objectContaining({ timeline_snapshot: expect.objectContaining({ activeTakeId: null, takesCount: 0 }) }));
  });
});

describe('editing Service: finalize, activation, mixer and history', () => {
  it('returns pending when the queried task is absent', async () => {
    expect(await api.finalizeEditResult({ ...base, taskId: 'task-1' })).toEqual({ status: 'pending', progress: 0 });
    expect(m.persistAudioToR2).not.toHaveBeenCalled();
  });
  it.each(['pending', 'processing', 'error'])('returns %s without storage writes', async (status) => {
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status, progress: 24, error: 'reason' } } });
    expect(await api.finalizeEditResult({ ...base, taskId: 'task-1' })).toEqual({ status, progress: 24, error: 'reason' });
    expect(m.createTake).not.toHaveBeenCalled();
  });
  it('finalizes ready repaint audio as a pending version', async () => {
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'ready', audio_urls: ['generated.wav'] } } });
    m.listTakesBySong.mockResolvedValue([{ id: 'prior', take_number: 1 }]);
    editContext('task-1', { task: 'repaint', stemId: 'stem-1', repaintingStart: 3, repaintingEnd: 6 });
    const result = await api.finalizeEditResult({ ...base, task: 'repaint', taskId: 'task-1', stemId: 'stem-1', repaintingStart: 3, repaintingEnd: 6 });
    expect(m.persistAudioToR2).toHaveBeenCalledWith('versions', expect.stringMatching(/^edits\/[a-f0-9]+\.wav$/), 'generated.wav');
    expect(m.createTake).toHaveBeenCalledWith(expect.objectContaining({ song_id: 'song-1', stem_id: 'stem-1', take_number: 2, repainting_start: 3, repainting_end: 6, is_active: false }));
    expect(m.activateTake).not.toHaveBeenCalled();
    expect(m.createCommit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'ready', progress: 100, audioUrl: expect.stringMatching(/^https:\/\/r2\.test\/versions\/edits\/[a-f0-9]+\.wav$/) });
  });
  it('keeps a LEGO take pending without creating an audible lane', async () => {
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'ready', audio_urls: ['generated.wav'] } } });
    editContext('task-1', { task: 'lego', trackName: 'bass' });
    await api.finalizeEditResult({ ...base, task: 'lego', taskId: 'task-1' });
    expect(m.createStem).not.toHaveBeenCalled();
    expect(m.createTake).toHaveBeenCalledWith(expect.objectContaining({ stem_id: null, is_active: false }));
  });
  it('skips finalization writes if persistence fails', async () => {
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'ready', audio_urls: ['generated.wav'] } } });
    m.persistAudioToR2.mockRejectedValue(new Error('R2 failed'));
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1' })).rejects.toThrow('R2 failed');
    expect(m.createTake).not.toHaveBeenCalled(); expect(m.activateTake).not.toHaveBeenCalled(); expect(m.createCommit).not.toHaveBeenCalled();
  });
  it('stops before committing if active take insertion fails', async () => {
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'ready', audio_urls: ['generated.wav'] } } });
    m.createTake.mockRejectedValue(new Error('activation failed'));
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1' })).rejects.toThrow('activation failed');
    expect(m.createCommit).not.toHaveBeenCalled();
  });
  it.each(['createTake', 'listTakesBySong'])('propagates ready finalization %s failure', async method => {
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'ready', audio_urls: ['generated.wav'] } } });
    m[method as 'createTake'].mockRejectedValue(new Error(`${method} failed`));
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1' })).rejects.toThrow(`${method} failed`);
  });
  it('propagates query failure before persistence', async () => {
    m.queryResult.mockRejectedValue(new Error('query failed'));
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1' })).rejects.toThrow('query failed');
    expect(m.persistAudioToR2).not.toHaveBeenCalled();
  });
  it('forwards switch, delete and mixer operations to their database functions', async () => {
    m.listTakesBySong.mockResolvedValue([{ id: 'take-1', song_id: 'song-1', stem_id: 'stem-1', task: 'cover', is_active: false, url: 'version.wav' }]); m.getTakeById.mockResolvedValue({ id: 'take-1', song_id: 'song-1', is_active: false });
    expect(await api.switchActiveTake('song-1', 'stem-1', 'take-1')).toMatchObject({ success: true, activeTakeId: 'take-1' });
    expect(m.activateTake).toHaveBeenCalledWith('song-1', 'stem-1', 'take-1', expect.any(Object));
    expect(await api.deleteTake('take-1')).toEqual({ success: true, deletedTakeId: 'take-1' });
    expect(m.deleteTake).toHaveBeenCalledWith('take-1', 'song-1', true);
    m.updateStemMixer.mockResolvedValue({ id: 'stem-1', volume: 0 });
    expect(await api.updateTrackMixer('stem-1', { volume: 0, pan: -1, is_muted: true })).toEqual({ id: 'stem-1', volume: 0 });
    expect(m.updateStemMixer).toHaveBeenCalledWith('stem-1', { volume: 0, pan: -1, is_muted: true });
  });
  it('returns existing history without initializing a master track', async () => {
    m.listStemsBySong.mockResolvedValue([{ id: 's' }]); m.listTakesBySong.mockResolvedValue([{ id: 't' }]); m.listCommitsBySong.mockResolvedValue([{ id: 'c' }]);
    expect(await api.getTimelineHistory('song-1')).toEqual({ stems: [{ id: 's' }], takes: [{ id: 't' }], commits: [{ id: 'c' }] });
    expect(m.getSongById).not.toHaveBeenCalled(); expect(m.createStem).not.toHaveBeenCalled();
  });
  it('initializes master stem, take and commit for a song missing a timeline', async () => {
    const result = await api.getTimelineHistory('song-1');
    expect(m.createStem).toHaveBeenCalledWith(expect.objectContaining({ id: 'stem-master-song-1', name: 'Master', url: 'original.wav' }));
    expect(m.createTake).toHaveBeenCalledWith(expect.objectContaining({ id: 'take-1-song-1', stem_id: 'stem-master-song-1', take_number: 1, is_active: true }));
    expect(m.createCommit).toHaveBeenCalledWith(expect.objectContaining({ id: 'commit-init-song-1', message: 'Initial Master Track (Song)' }));
    expect(result.stems).toHaveLength(1); expect(result.takes).toHaveLength(1); expect(result.commits).toHaveLength(1);
  });
  it.each([null, { ...parent, url: '' }])('returns empty history when the song has no playable source', async song => {
    m.getSongById.mockResolvedValue(song);
    expect(await api.getTimelineHistory('song-1')).toEqual({ stems: [], takes: [], commits: [] });
    expect(m.createStem).not.toHaveBeenCalled();
  });
  it.each(['activateTake', 'deleteTake', 'updateStemMixer'])('propagates database %s failure for track-management operations', async method => {
    m.listTakesBySong.mockResolvedValue([{ id: 't', song_id: 's', stem_id: null, is_active: false, task: 'cover', url: 'v.wav' }]); m.getTakeById.mockResolvedValue({ id: 't', song_id: 's', is_active: false });
    m[method as 'activateTake'].mockRejectedValue(new Error(`${method} failed`));
    const operation = method === 'activateTake' ? api.switchActiveTake('s', null, 't') : method === 'deleteTake' ? api.deleteTake('t') : api.updateTrackMixer('s', { volume: 1 });
    await expect(operation).rejects.toThrow(`${method} failed`);
  });
  it.each(['listStemsBySong', 'listTakesBySong', 'listCommitsBySong', 'getSongById', 'createStem', 'createTake', 'createCommit'])('propagates history %s failure', async method => {
    m[method as 'createStem'].mockRejectedValue(new Error(`${method} failed`));
    await expect(api.getTimelineHistory('song-1')).rejects.toThrow(`${method} failed`);
  });
});
