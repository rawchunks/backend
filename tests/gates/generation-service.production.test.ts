import { broker, contexts, resetContexts, generationContext, editContext } from '../support/task-context.js';
vi.mock('../../broker/valkey.js', () => broker);
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ releaseTask: vi.fn(), queryResult: vi.fn(), createSong: vi.fn(), finalizeSong: vi.fn(), getSongById: vi.fn(), countUntitledSongsByCreator: vi.fn(), resolveVoice: vi.fn(), persistAudioToR2: vi.fn() }));
vi.mock('../../generation/client.js', async () => ({ ...(await vi.importActual<any>('../../generation/client.js')), client: { releaseTask: m.releaseTask, queryResult: m.queryResult } }));
vi.mock('../../databases/songs.js', () => ({ createSong: m.createSong, finalizeSong: m.finalizeSong, getSongById: m.getSongById, countUntitledSongsByCreator: m.countUntitledSongsByCreator }));
vi.mock('../../voice/service.js', () => ({ resolveVoice: m.resolveVoice }));
vi.mock('../../storage/r2.js', () => ({ persistAudioToR2: m.persistAudioToR2 }));
import { Service } from '../../generation/service.js';
import { STRUCTURED_TAGS, createBlock, serializeBlocksToLyrics } from '../../../app/src/lib/lyrics.js';
let api: Service;
const base = { creatorAddress: '0x1234567890', prompt: 'a soulful song', lyrics: 'lyrics' };
const task = (extras = {}) => ({ results: { 'task-1': { task_id: 'task-1', status: 'ready', audio_urls: ['raw.wav'], ...extras } } });
beforeEach(() => {
  vi.resetAllMocks(); resetContexts(); generationContext(); api = new Service(); vi.spyOn(Date, 'now').mockReturnValue(1728000000000);
  m.releaseTask.mockResolvedValue({ task_id: 'task-1', status: 'pending' });
  m.queryResult.mockResolvedValue(task()); m.createSong.mockImplementation(async input => input);
  m.countUntitledSongsByCreator.mockResolvedValue(0);
  m.getSongById.mockImplementation(async id => ({ id, title: 'Song', duration: 45, creator: 'creator', tags: [] }));
  m.finalizeSong.mockResolvedValue(undefined);
  m.resolveVoice.mockResolvedValue(null); m.persistAudioToR2.mockImplementation(async (bucket, key) => `https://r2.test/${bucket}/${key}`);
});
afterEach(() => vi.restoreAllMocks());

describe('generation finalization invariants', () => {
  it('shares one stored object between the master and initial take', async () => {
    const result = await api.checkStatusAndFinalize('task-1', 'song-1');
    expect(m.persistAudioToR2).toHaveBeenCalledTimes(1);
    const [, outputs, master, versions] = m.finalizeSong.mock.calls[0];
    expect([outputs[0].url, master.url, versions[0].url]).toEqual(Array(3).fill(result.primaryUrl));
  });
  it('sequential completion reads finalize once', async () => {
    await api.checkStatusAndFinalize('task-1', 'song-1');
    await api.checkStatusAndFinalize('task-1', 'song-1');
    expect(m.finalizeSong).toHaveBeenCalledOnce();
    expect(m.persistAudioToR2).toHaveBeenCalledTimes(1);
  });
  it('100 simultaneous completed polls claim the task once', async () => {
    await Promise.all(Array.from({ length: 100 }, () => api.checkStatusAndFinalize('task-1', 'song-1')));
    expect(m.finalizeSong).toHaveBeenCalledOnce();
  });
  it('shares a completion receipt across API instances', async () => {
    const second = new Service();
    const [first, last] = await Promise.all([api.checkStatusAndFinalize('task-1', 'song-1'), second.checkStatusAndFinalize('task-1', 'song-1')]);
    expect(last).toEqual(first);
    expect(m.finalizeSong).toHaveBeenCalledOnce();
    expect(m.queryResult).toHaveBeenCalledOnce();
  });
  it('rejects an unbound task before polling or persistence', async () => {
    await expect(api.checkStatusAndFinalize('unknown', 'song-1')).rejects.toMatchObject({ statusCode: 404 });
    expect(m.queryResult).not.toHaveBeenCalled();
    expect(m.persistAudioToR2).not.toHaveBeenCalled();
  });
  it('replays the same transaction after terminal checkpoint failure without uploading again', async () => {
    const write = broker.setTaskContext;
    const spy = vi.spyOn(broker, 'setTaskContext').mockImplementation(async (id, value: any) => {
      if (value.result) throw new Error('checkpoint unavailable');
      return write(id, value);
    });
    await expect(api.checkStatusAndFinalize('task-1', 'song-1')).rejects.toThrow('checkpoint unavailable');
    spy.mockRestore();
    await api.checkStatusAndFinalize('task-1', 'song-1');
    expect(m.finalizeSong).toHaveBeenCalledTimes(2);
    expect(m.finalizeSong.mock.calls[1]).toEqual(m.finalizeSong.mock.calls[0]);
    expect(m.persistAudioToR2).toHaveBeenCalledTimes(1);
  });
  it('stops writes after losing the finalization lease', async () => {
    vi.spyOn(broker, 'withJobLock').mockImplementation(async (_key, fn) => fn(Object.assign(async () => { throw new Error('lease lost'); }, { save: async () => { throw new Error('lease lost'); } })));
    await expect(api.checkStatusAndFinalize('task-1', 'song-1')).rejects.toThrow('lease lost');
    expect(m.persistAudioToR2).not.toHaveBeenCalled();
    expect(m.finalizeSong).not.toHaveBeenCalled();
  });
  it('rejects finalization of a task into a different song than the originating song', async () => {
    contexts.delete('task-1');
    const initial = await api.initiateGeneration(base);
    await expect(api.checkStatusAndFinalize(initial.taskId, 'other-users-song')).rejects.toThrow();
    expect(m.finalizeSong).not.toHaveBeenCalled();
  });
  it('rejects unknown target songs before persisting any audio', async () => {
    m.getSongById.mockResolvedValue(null);
    await expect(api.checkStatusAndFinalize('task-1', 'missing')).rejects.toThrow();
    expect(m.persistAudioToR2).not.toHaveBeenCalled();
  });
  it.each([undefined, []])('does not advertise ready when the ready task has no output %j', async (audio_urls) => {
    m.queryResult.mockResolvedValue(task({ audio_urls }));
    expect((await api.checkStatusAndFinalize('task-1', 'song-1')).status).not.toBe('ready');
  });
  it.each([-12, Infinity])('rejects invalid output duration %s before writing song metadata', async (duration) => {
    m.queryResult.mockResolvedValue(task({ metas: [{ duration }] }));
    await expect(api.checkStatusAndFinalize('task-1', 'song-1')).rejects.toThrow();
    expect(m.finalizeSong).not.toHaveBeenCalled();
  });
  it('does not return a non-existent secondary song ID for a single output', async () => {
    const result = await api.checkStatusAndFinalize('task-1', 'song-1');
    expect(result).not.toHaveProperty('songBId', 'song-1-var2');
  });
  it('retains every generated variation in the returned audio list', async () => {
    m.queryResult.mockResolvedValue(task({ audio_urls: ['a.wav', 'b.wav', 'c.wav'] }));
    expect((await api.checkStatusAndFinalize('task-1', 'song-1')).audioUrls).toHaveLength(3);
  });
  it('preserves original generation model and prompt across a service restart', async () => {
    contexts.delete('task-1');
    const initial = await api.initiateGeneration({ ...base, modelVariant: 'sft' });
    const restarted = new Service();
    await restarted.checkStatusAndFinalize('task-1', initial.songId);
    expect(m.finalizeSong.mock.calls[0][3][0]).toMatchObject({ model: 'acestep-v15-xl-sft', prompt: base.prompt, lyrics: base.lyrics });
  });
  it('does not allocate conflicting master and take IDs to distinct tasks in the same millisecond', async () => {
    m.queryResult.mockImplementation(async ([id]) => ({ results: { [id]: { task_id: id, status: 'ready', audio_urls: ['raw.wav'] } } }));
    generationContext('a', 'song-a'); generationContext('b', 'song-b');
    await Promise.all(['a', 'b'].map(id => api.checkStatusAndFinalize(id, `song-${id}`)));
    expect(new Set(m.finalizeSong.mock.calls.map(([, , stem]) => stem.id)).size).toBe(2);
    expect(new Set(m.finalizeSong.mock.calls.map(([, , , versions]) => versions[0].id)).size).toBe(2);
  });
  it('retries a failed transaction without uploading again', async () => {
    m.finalizeSong.mockRejectedValueOnce(new Error('DB write failed'));
    await expect(api.checkStatusAndFinalize('task-1', 'song-1')).rejects.toThrow('DB write failed');
    await api.checkStatusAndFinalize('task-1', 'song-1');
    expect(m.persistAudioToR2).toHaveBeenCalledTimes(1);
    expect(m.finalizeSong).toHaveBeenCalledTimes(2);
  });
});

describe('generation dispatch and voice integrity', () => {
  it('preserves every Lyrics Canvas directive and its section order through finalization', async () => {
    contexts.delete('task-1');
    const lyrics = serializeBlocksToLyrics(STRUCTURED_TAGS.map((tag, index) => createBlock([tag.token], `Line ${index + 1}`)));
    const initial = await api.initiateGeneration({ ...base, lyrics });
    expect(m.releaseTask.mock.calls[0][0].lyrics).toBe(lyrics);
    await api.checkStatusAndFinalize(initial.taskId, initial.songId);
    expect(m.finalizeSong.mock.calls[0][3][0].lyrics).toBe(lyrics);
    expect(m.finalizeSong.mock.calls[0][3][0].provenance.parameters.submitted.lyrics).toBe(lyrics);
  });
  it.each(['sft', 'turbo'] as const)('preserves Studio inputs for %s', async modelVariant => {
    contexts.delete('task-1');
    await api.initiateGeneration({ ...base, modelVariant, bpm: 100, keyScale: 'C major', audioDuration: 30, vocalLanguage: 'en', seed: 7301 });
    expect(m.releaseTask.mock.calls[0][0]).toMatchObject({ prompt: base.prompt, lyrics: base.lyrics, bpm: 100, key_scale: 'C major', audio_duration: 30, vocal_language: 'en', seed: 7301, use_random_seed: false, use_cot_caption: false, use_cot_language: false, use_format: false, inference_steps: modelVariant === 'sft' ? 50 : 8 });
  });
  it('retains random generation when no seed is supplied', async () => {
    contexts.delete('task-1');
    await api.initiateGeneration(base);
    expect(m.releaseTask.mock.calls[0][0].use_random_seed).toBe(true);
  });
  it('stores submitted and resolved settings with the generated take', async () => {
    contexts.delete('task-1');
    const initial = await api.initiateGeneration({ ...base, bpm: 100, seed: 7301 });
    m.queryResult.mockResolvedValue(task({ metas: [{ bpm: 100, duration: 30, keyscale: 'C major', prompt: base.prompt, lyrics: base.lyrics, seed: 7301 }] }));
    await api.checkStatusAndFinalize(initial.taskId, initial.songId);
    expect(m.finalizeSong.mock.calls[0][3][0]).toMatchObject({ seed: 7301, provenance: { parameters: { submitted: { bpm: 100 }, resolved: { bpm: 100, keyscale: 'C major' } } } });
  });
  it('requests lossless audio matching the persisted WAV object format', async () => {
    contexts.delete('task-1');
    await api.initiateGeneration(base);
    expect(m.releaseTask.mock.calls[0][0].audio_format).toBe('wav');
  });
  it('stores the exact worker task key before dispatch', async () => {
    contexts.delete('task-1');
    m.releaseTask.mockImplementation(async (payload, options) => {
      expect(contexts.get(options.idempotencyKey)).toMatchObject({ kind: 'generate', prompt: base.prompt, dispatch: payload });
      return { task_id: options.idempotencyKey, status: 'pending' };
    });
    const initial = await api.initiateGeneration(base);
    await new Service().checkStatusAndFinalize(initial.taskId, initial.songId);
    expect(contexts.get(initial.taskId)).toMatchObject({ dispatched: true });
  });
  it('does not dispatch when durable context storage is unavailable', async () => {
    vi.spyOn(broker, 'setTaskContext').mockRejectedValue(new Error('Valkey unavailable'));
    await expect(api.initiateGeneration(base)).rejects.toThrow('Valkey unavailable');
    expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it('does not dispatch an orphan task before the pending song is durably recorded', async () => {
    m.createSong.mockRejectedValue(new Error('DB unavailable'));
    await expect(api.initiateGeneration(base)).rejects.toThrow('DB unavailable');
    expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it('rejects a missing saved voice instead of silently generating without the requested clone', async () => {
    await expect(api.initiateGeneration({ ...base, voiceId: 'missing-voice' })).rejects.toThrow();
    expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it('rejects an incomplete voice with neither LoRA nor audio before worker dispatch', async () => {
    m.resolveVoice.mockResolvedValue({ id: 'v', url: '', sample_url: '' });
    await expect(api.initiateGeneration({ ...base, voiceId: 'v' })).rejects.toThrow();
  });
  it('rejects malformed release while retaining the durable pending intent', async () => {
    contexts.delete('task-1');
    m.releaseTask.mockResolvedValue({ status: 'pending' });
    await expect(api.initiateGeneration(base)).rejects.toThrow();
    expect(m.createSong).toHaveBeenCalledOnce();
    expect(contexts.has('task-1')).toBe(false);
  });
  it.each([0, -5, Infinity, NaN])('rejects invalid direct generation duration %s', async (audioDuration) => {
    await expect(api.initiateGeneration({ ...base, audioDuration })).rejects.toThrow();
    expect(m.releaseTask).not.toHaveBeenCalled();
  });
  it('rejects an empty prompt through the public service boundary', async () => {
    await expect(api.initiateGeneration({ ...base, prompt: '   ' })).rejects.toThrow();
  });
});
