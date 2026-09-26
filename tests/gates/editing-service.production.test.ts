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
import { Service } from '../../editing/service.js';
function fixtureWave() { const b = Buffer.alloc(44 + 60 * 8 * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8, 24); b.writeUInt32LE(16, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b; }
let api: Service;
const base = { songId: 'song-1', userAddress: '0xABCDEF0123', task: 'cover' as const, prompt: 'new style', coverStrength: 0.6 };
beforeEach(() => {
  vi.resetAllMocks(); resetContexts(); editContext(); api = new Service(); vi.spyOn(Date, 'now').mockReturnValue(1728000000000);
  m.getSongById.mockResolvedValue({ id: 'song-1', title: 'Song', creator: 'owner', url: 'original.wav', duration: 60 });
  m.releaseTask.mockResolvedValue({ task_id: 'task-1', status: 'pending' });
  m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'ready', audio_urls: ['generated.wav'] } } });
  m.separate.mockResolvedValue({ task_id: 'sep-1', status: 'ready', stems: { vocals: 'v.wav' } });
  m.getTakeById.mockResolvedValue(null); m.listStemsBySong.mockResolvedValue([]); m.listTakesBySong.mockResolvedValue([]); m.listCommitsBySong.mockResolvedValue([]);
  m.createStem.mockImplementation(async input => input); m.createTake.mockImplementation(async input => { m.getTakeById.mockResolvedValue(input); return input; }); m.createCommit.mockImplementation(async input => input);
  m.persistAudioToR2.mockImplementation(async (bucket, key) => `https://r2.test/${bucket}/${key}`);
});
afterEach(() => vi.restoreAllMocks());

describe('edit validation and submitted model fidelity', () => {
  it.each([[5, 2], [5, 5], [-1, 3], [NaN, 3], [0, Infinity]])('rejects invalid repaint interval [%s, %s] before worker dispatch', async (repaintingStart, repaintingEnd) => {
    await expect(api.dispatchEditTask({ ...base, task: 'repaint', repaintingStart, repaintingEnd })).rejects.toThrow();
    expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it.each([0, -1, Infinity, NaN])('rejects invalid extension duration %s', async (audioDuration) => {
    await expect(api.dispatchEditTask({ ...base, task: 'complete', audioDuration })).rejects.toThrow();
  });
  it('rejects an extension that shortens the original song', async () => {
    await expect(api.dispatchEditTask({ ...base, task: 'complete', audioDuration: 5 })).rejects.toThrow();
  });
  it.each([-1, 2, NaN])('rejects out-of-range cover strength %s', async coverStrength => {
    await expect(api.dispatchEditTask({ ...base, coverStrength })).rejects.toThrow();
  });
  it('rejects conflicting modelQuality and modelVariant instead of silently choosing turbo', async () => {
    await expect(api.dispatchEditTask({ ...base, modelQuality: 'base', modelVariant: 'turbo' })).rejects.toThrow();
  });
  it('conditions a layer on rendered audio and preserves reference lane IDs in provenance', async () => {
    contexts.delete('task-1');
    await api.dispatchEditTask({ ...base, task: 'lego', trackName: 'bass', srcAudioUrl: 'rendered.wav', legoContextTrackIds: ['drums', 'bass'] });
    expect(m.releaseTask).toHaveBeenCalledWith(expect.objectContaining({ src_audio_path: 'rendered.wav', track_name: 'bass' }), expect.anything());
    expect(contexts.get('task-1').provenance.parameters.legoContextTrackIds).toEqual(['drums', 'bass']);
  });
  it('stores the exact worker task key before dispatch', async () => {
    contexts.delete('task-1');
    m.releaseTask.mockImplementation(async (payload, options) => {
      expect(contexts.get(options.idempotencyKey)).toMatchObject({ kind: 'edit', params: base, dispatch: payload });
      return { task_id: options.idempotencyKey, status: 'pending' };
    });
    const initial = await api.dispatchEditTask(base);
    expect(contexts.get(initial.taskId)).toMatchObject({ dispatched: true });
  });
  it('preserves the selected turbo model in the finalized take', async () => {
    contexts.delete('task-1');
    await api.dispatchEditTask({ ...base, modelQuality: 'turbo' });
    await api.finalizeEditResult({ ...base, taskId: 'task-1' });
    expect(m.createTake).toHaveBeenCalledWith(expect.objectContaining({ model: 'acestep-v15-xl-turbo' }));
  });
  it('preserves a valid zero repaint start in take history', async () => {
    editContext('task-1', { task: 'repaint', repaintingStart: 0, repaintingEnd: 5 });
    await api.finalizeEditResult({ ...base, task: 'repaint', taskId: 'task-1', repaintingStart: 0, repaintingEnd: 5 });
    expect(m.createTake).toHaveBeenCalledWith(expect.objectContaining({ repainting_start: 0 }));
  });
  it('refuses finalization when supplied song differs from the dispatched song', async () => {
    contexts.delete('task-1');
    await api.dispatchEditTask(base);
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1', songId: 'other-users-song' })).rejects.toThrow();
    expect(m.createTake).not.toHaveBeenCalled();
  });
  it('refuses finalization when supplied task kind differs from the dispatched kind', async () => {
    contexts.delete('task-1');
    await api.dispatchEditTask(base);
    await expect(api.finalizeEditResult({ ...base, task: 'lego', taskId: 'task-1' })).rejects.toThrow();
  });
});

describe('edit finalization idempotency, atomicity and empty results', () => {
  it('shares a completion receipt across API instances', async () => {
    const second = new Service();
    const [first, last] = await Promise.all([api.finalizeEditResult({ ...base, taskId: 'task-1' }), second.finalizeEditResult({ ...base, taskId: 'task-1' })]);
    expect(last).toEqual(first);
    expect(m.createTake).toHaveBeenCalledOnce();
    expect(m.createCommit).not.toHaveBeenCalled();
  });
  it('uses submitted metadata when status query fields change', async () => {
    contexts.delete('task-1');
    await api.dispatchEditTask({ ...base, prompt: 'original', lyrics: 'saved lyrics' });
    await api.finalizeEditResult({ ...base, taskId: 'task-1', prompt: 'substituted', repaintingStart: 12 });
    expect(m.createTake).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'original', lyrics: 'saved lyrics', repainting_start: null }));
  });
  it('rejects an unbound task before worker polling', async () => {
    await expect(api.finalizeEditResult({ ...base, taskId: 'unknown' })).rejects.toMatchObject({ statusCode: 404 });
    expect(m.queryResult).not.toHaveBeenCalled();
  });
  it('rejects a substituted user before persistence', async () => {
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1', userAddress: '0xOTHER000000' })).rejects.toMatchObject({ statusCode: 409 });
    expect(m.createTake).not.toHaveBeenCalled();
  });
  it('reuses a take written before its checkpoint failed', async () => {
    const write = broker.setTaskContext; let take: any;
    m.createTake.mockImplementation(async input => { take = input; m.getTakeById.mockResolvedValue(input); return input; });
    m.listTakesBySong.mockImplementation(async () => take ? [take] : []);
    const spy = vi.spyOn(broker, 'setTaskContext').mockImplementation(async (id, value: any) => {
      if (value.take && !value.result) throw new Error('checkpoint unavailable');
      return write(id, value);
    });
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1' })).rejects.toThrow('checkpoint unavailable');
    spy.mockRestore(); await api.finalizeEditResult({ ...base, taskId: 'task-1' });
    expect(m.createTake).toHaveBeenCalledOnce(); expect(m.createCommit).not.toHaveBeenCalled();
  });
  it('stops writes after losing the finalization lease', async () => {
    vi.spyOn(broker, 'withJobLock').mockImplementation(async (_key, fn) => fn(async () => { throw new Error('lease lost'); }));
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1' })).rejects.toThrow('lease lost');
    expect(m.persistAudioToR2).not.toHaveBeenCalled();
    expect(m.createCommit).not.toHaveBeenCalled();
  });
  it('sequential ready status polls produce one pending take without merging', async () => {
    await api.finalizeEditResult({ ...base, taskId: 'task-1' });
    await api.finalizeEditResult({ ...base, taskId: 'task-1' });
    expect(m.createTake).toHaveBeenCalledTimes(1);
    expect(m.createCommit).not.toHaveBeenCalled();
    expect(m.persistAudioToR2).toHaveBeenCalledTimes(1);
  });
  it('100 concurrent ready status polls claim one finalization', async () => {
    await Promise.all(Array.from({ length: 100 }, () => api.finalizeEditResult({ ...base, taskId: 'task-1' })));
    expect(m.createTake).toHaveBeenCalledTimes(1);
    expect(m.createCommit).not.toHaveBeenCalled();
  });
  it('allocates globally distinct take IDs for separate songs in the same millisecond', async () => {
    editContext('task-a', { songId: 'song-a' }); editContext('task-b', { songId: 'song-b' });
    m.queryResult.mockImplementation(async ([taskId]) => ({ results: { [taskId]: { status: 'ready', audio_urls: ['generated.wav'] } } }));
    await Promise.all(['a', 'b'].map(id => api.finalizeEditResult({ ...base, taskId: `task-${id}`, songId: `song-${id}` })));
    expect(new Set(m.createTake.mock.calls.map(([take]) => take.id)).size).toBe(2);
    expect(m.createCommit).not.toHaveBeenCalled();
  });
  it('allocates the next take number using the maximum existing number rather than row count', async () => {
    m.listTakesBySong.mockResolvedValue([{ id: 'take-a', take_number: 1 }, { id: 'take-z', take_number: 8 }]);
    await api.finalizeEditResult({ ...base, taskId: 'task-1' });
    expect(m.createTake).toHaveBeenCalledWith(expect.objectContaining({ take_number: 9 }));
  });
  it.each([undefined, []])('does not report ready for an empty worker audio result %j', async audio_urls => {
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'ready', audio_urls } } });
    expect((await api.finalizeEditResult({ ...base, taskId: 'task-1' })).status).not.toBe('ready');
  });
  it('does not treat unrelated existing master stems as proof extraction succeeded', async () => {
    editContext('task-1', { task: 'extract' });
    m.listStemsBySong.mockResolvedValue([{ id: 'master', name: 'Master' }]);
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'error', error: 'separation failed' } } });
    expect((await api.finalizeEditResult({ ...base, task: 'extract', taskId: 'task-1' })).status).toBe('error');
  });
  it('returns percent progress for a persisted separation receipt', async () => {
    editContext('task-1', { task: 'extract' });
    contexts.get('task-1').result = { status: 'ready', progress: 100, stems: [{ id: 'vocal', name: 'vocals' }] };
    m.listStemsBySong.mockResolvedValue([{ id: 'vocal', name: 'vocals' }]);
    expect((await api.finalizeEditResult({ ...base, task: 'extract', taskId: 'task-1' })).progress).toBe(100);
  });
  it('links a new commit to the existing history head', async () => {
    m.listCommitsBySong.mockResolvedValue([{ id: 'head-commit' }]);
    await api.createCommitSnapshot({ songId: 'song-1', message: 'checkpoint', userAddress: base.userAddress });
    expect(m.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parent_commit_id: 'head-commit' }));
  });
  it('retries a failed take write without duplicating persisted audio', async () => {
    m.createTake.mockRejectedValueOnce(new Error('take write failed')).mockImplementation(async input => { m.getTakeById.mockResolvedValue(input); return input; });
    await expect(api.finalizeEditResult({ ...base, taskId: 'task-1' })).rejects.toThrow('take write failed');
    await api.finalizeEditResult({ ...base, taskId: 'task-1' });
    expect(m.createTake).toHaveBeenCalledTimes(2); expect(m.persistAudioToR2).toHaveBeenCalledTimes(1);
  });
});

describe('separation and history stress factors', () => {
  it.each(['pending', 'processing', 'error'])('does not mark worker separation status %s as ready', async status => {
    m.separate.mockResolvedValue({ task_id: 'sep-1', status, stems: {} });
    expect((await api.separateStems({ songId: 'song-1' })).status).toBe(status);
    expect(m.createCommit).not.toHaveBeenCalled();
  });
  it('recovers separation stems after losing the synchronous response', async () => {
    editContext('task-1', { task: 'extract' });
    m.queryResult.mockResolvedValue({ results: { 'task-1': { status: 'ready', progress: 100, stems: { vocals: 'v.wav' } } } });
    const result = await new Service().finalizeEditResult({ ...base, task: 'extract', taskId: 'task-1' });
    expect(result).toMatchObject({ status: 'ready', progress: 100, stems: [{ name: 'vocals' }] });
    expect(m.separate).not.toHaveBeenCalled();
  });
  it('stores separation binding before worker dispatch', async () => {
    m.separate.mockImplementation(async (payload, options) => {
      expect(contexts.get(options.idempotencyKey)).toMatchObject({ kind: 'edit', params: { songId: 'song-1', task: 'extract' }, dispatch: payload });
      return { task_id: options.idempotencyKey, status: 'ready', stems: { vocals: 'v.wav' } };
    });
    const result = await api.separateStems({ songId: 'song-1', userAddress: base.userAddress });
    expect(result.status).toBe('ready');
  });
  it('rejects an empty successful separation instead of saving a success commit', async () => {
    m.separate.mockResolvedValue({ task_id: 'sep-1', status: 'ready', stems: {} });
    await expect(api.separateStems({ songId: 'song-1' })).rejects.toThrow();
    expect(m.createCommit).not.toHaveBeenCalled();
  });
  it('history initialization does not duplicate writes under concurrent first reads', async () => {
    await Promise.all(Array.from({ length: 20 }, () => api.getTimelineHistory('song-1')));
    expect(m.createStem).toHaveBeenCalledTimes(1); expect(m.createTake).toHaveBeenCalledTimes(1); expect(m.createCommit).toHaveBeenCalledTimes(1);
  });
  it('reports take deletion failure rather than unconditional success', async () => {
    m.deleteTake.mockResolvedValue(false);
    expect((await api.deleteTake('missing')).success).toBe(false);
  });
});
