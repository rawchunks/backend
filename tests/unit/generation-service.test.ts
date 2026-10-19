import { broker, contexts, resetContexts, generationContext, editContext } from '../support/task-context.js';
vi.mock('../../broker/valkey.js', () => broker);
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  releaseTask: vi.fn(), queryResult: vi.fn(), createSong: vi.fn(), finalizeSong: vi.fn(), getSongById: vi.fn(), countUntitledSongsByCreator: vi.fn(),
  resolveVoice: vi.fn(), persistAudioToR2: vi.fn(),
}));
vi.mock('../../generation/client.js', async () => ({ ...(await vi.importActual<any>('../../generation/client.js')), client: { releaseTask: mocks.releaseTask, queryResult: mocks.queryResult } }));
vi.mock('../../databases/songs.js', () => ({ createSong: mocks.createSong, finalizeSong: mocks.finalizeSong, getSongById: mocks.getSongById, countUntitledSongsByCreator: mocks.countUntitledSongsByCreator }));
vi.mock('../../databases/albums.js', () => ({ addSongToAlbum: vi.fn() }));
vi.mock('../../voice/service.js', () => ({ resolveVoice: mocks.resolveVoice }));
vi.mock('../../storage/r2.js', () => ({ persistAudioToR2: mocks.persistAudioToR2 }));
import { Service, generationService, service } from '../../generation/service.js';

const base = { creatorAddress: '0xABCDEF012345', prompt: 'a soulful song', lyrics: '  [Verse]\nHello  ' };
const parent = { id: 'song-1', title: 'Song', creator: 'creator', duration: 45, tags: ['SOUL'] };
const ready = (audio = ['raw-a.wav'], metas: unknown[] = []) => ({ results: { 'task-1': { task_id: 'task-1', status: 'ready', audio_urls: audio, metas } } });
let api: Service;
beforeEach(() => {
  vi.resetAllMocks(); resetContexts(); generationContext();
  vi.spyOn(Date, 'now').mockReturnValue(1728000000000);
  vi.spyOn(Math, 'random').mockReturnValue(.123456);
  api = new Service();
  mocks.releaseTask.mockResolvedValue({ task_id: 'task-1', status: 'pending' });
  mocks.queryResult.mockResolvedValue({ results: {} });
  mocks.createSong.mockImplementation(async (input) => input);
  mocks.countUntitledSongsByCreator.mockResolvedValue(0);
  mocks.getSongById.mockImplementation(async (id) => id === 'song-1' ? parent : null);
  mocks.finalizeSong.mockResolvedValue(undefined);
  mocks.resolveVoice.mockResolvedValue(null);
  mocks.persistAudioToR2.mockImplementation(async (bucket, key) => `https://r2.test/${bucket}/${key}`);
});
afterEach(() => vi.restoreAllMocks());

describe('generation Service: model, lyrics and initial song', () => {
  it('exports stable service aliases', () => expect(generationService).toBe(service));
  it.each([
    [undefined, 'acestep-v15-xl-turbo', 8, 1], ['turbo', 'acestep-v15-xl-turbo', 8, 1], ['sft', 'acestep-v15-xl-sft', 50, 7],
  ])('routes %s generation with its model, step count and guidance', async (modelVariant, model, inference_steps, guidance_scale) => {
    contexts.delete('task-1');
    const result = await api.initiateGeneration({ ...base, modelVariant: modelVariant as any, bpm: 120, keyScale: 'D minor', audioDuration: 80, vocalLanguage: 'it', tags: ['DANCE'] });
    expect(mocks.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ model, inference_steps, guidance_scale,
      task: 'text2music', task_type: 'text2music', batch_size: 1, bpm: 120, key_scale: 'D minor', audio_duration: 80, vocal_language: 'it' }));
    expect(result).toMatchObject({ taskId: 'task-1', status: 'pending', model, steps: inference_steps });
    expect(mocks.createSong).toHaveBeenCalledWith(expect.objectContaining({ creator: '0xabcdef012345', url: '', tags: ['DANCE'], duration: 80, version: 1, source: null }));
  });
  it('rejects an unsupported model variant before any worker or database side effect', async () => {
    await expect(api.initiateGeneration({ ...base, modelVariant: 'base' as any })).rejects.toThrow('Invalid modelVariant');
    expect(mocks.releaseTask).not.toHaveBeenCalled();
    expect(mocks.createSong).not.toHaveBeenCalled();
  });
  it('preserves supplied lyrics and bypasses sample completion', async () => {
    contexts.delete('task-1');
    const result = await api.initiateGeneration(base);
    expect(mocks.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ lyrics: '  [Verse]\nHello  ', sample_mode: false, sample_query: undefined, instrumental: false }));
    expect(result.lyrics).toBe(base.lyrics);
  });
  it.each([undefined, '', ' \n\t '])('uses sample mode when lyrics are %j', async (lyrics) => {
    contexts.delete('task-1');
    const result = await api.initiateGeneration({ ...base, lyrics });
    expect(mocks.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ lyrics: '', sample_mode: true, sample_query: base.prompt }));
    expect(result.lyrics).toBeUndefined();
  });
  it('makes instrumental lyrics authoritative over manual lyrics', async () => {
    contexts.delete('task-1');
    const result = await api.initiateGeneration({ ...base, instrumental: true });
    expect(mocks.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ lyrics: '[Instrumental]', sample_mode: false, instrumental: true }));
    expect(result.lyrics).toBe('[Instrumental]');
  });
  it('assigns Untitled #{count + 1} when no title is given', async () => {
    contexts.delete('task-1');
    mocks.countUntitledSongsByCreator.mockResolvedValueOnce(3);
    await api.initiateGeneration({ ...base, prompt: 'some prompt', creatorAddress: 'SolanaCaseSensitiveAddress' });
    expect(mocks.createSong).toHaveBeenCalledWith(expect.objectContaining({ title: 'Untitled #4', creator: 'SolanaCaseSensitiveAddress', tags: [] }));
  });
  it('records selected prices before dispatch, including zero', async () => {
    contexts.delete('task-1');
    await api.initiateGeneration({ ...base, licenses: 0, stream_price: 0, license_price: 11 });
    expect(mocks.createSong).toHaveBeenCalledWith(expect.objectContaining({ licenses: 0, stream_price: 0, license_price: 11 }));
  });
  it('preserves the explicit title', async () => {
    contexts.delete('task-1');
    await api.initiateGeneration({ ...base, title: 'Chosen title' });
    expect(mocks.createSong).toHaveBeenCalledWith(expect.objectContaining({ title: 'Chosen title' }));
  });
  it('retains a pending song and intent after an uncertain dispatch failure', async () => {
    mocks.releaseTask.mockRejectedValue(new Error('GPU unavailable'));
    await expect(api.initiateGeneration(base)).rejects.toThrow('GPU unavailable');
    expect(mocks.createSong).toHaveBeenCalledOnce();
  });
  it('propagates a failure creating the initial pending song', async () => {
    mocks.createSong.mockRejectedValue(new Error('database unavailable'));
    await expect(api.initiateGeneration(base)).rejects.toThrow('database unavailable');
  });
});

describe('generation Service: cloned voice and reference selection', () => {
  it.each(['turbo', 'sft'] as const)('dispatches the compatible trained adapter for %s without reference fallback', async modelVariant => {
    mocks.resolveVoice.mockResolvedValue({ artifactUrl: 'https://voice.test/manifest.json', artifactDigest: 'a'.repeat(64), provenance: { voiceId: 'voice-1', mode: 'trained' } });
    contexts.delete('task-1');
    await api.initiateGeneration({ ...base, modelVariant, voiceId: 'voice-1', voiceMode: 'trained', voiceCoverStrength: .4 });
    expect(mocks.resolveVoice).toHaveBeenCalledWith('voice-1', `acestep-v15-xl-${modelVariant}`, 'trained', .4, base.creatorAddress);
    expect(mocks.releaseTask.mock.calls[0][0]).toMatchObject({ lora_manifest_url: 'https://voice.test/manifest.json', lora_manifest_digest: 'a'.repeat(64), lora_alpha: .4 });
    expect(mocks.releaseTask.mock.calls[0][0].reference_audio_path).toBeUndefined();
  });
  it.each([0, 1, .4])('preserves reference voice strength %s including zero', async voiceCoverStrength => {
    mocks.resolveVoice.mockResolvedValue({ sampleUrl: 'https://voice.test/sample.wav', provenance: { voiceId: 'voice-1', mode: 'reference' } });
    contexts.delete('task-1');
    await api.initiateGeneration({ ...base, voiceId: 'voice-1', voiceMode: 'reference', voiceCoverStrength });
    expect(mocks.releaseTask.mock.calls[0][0]).toMatchObject({ reference_audio_path: 'https://voice.test/sample.wav', audio_cover_strength: voiceCoverStrength });
    expect(mocks.releaseTask.mock.calls[0][0].lora_manifest_url).toBeUndefined();
  });
  it('requires explicit voice mode before dispatch', async () => {
    await expect(api.initiateGeneration({ ...base, voiceId: 'voice-1' })).rejects.toThrow('Choose reference');
    expect(mocks.resolveVoice).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, 1])('uses direct reference with strength %s', async (voiceCoverStrength) => {
    contexts.delete('task-1');
    await api.initiateGeneration({ ...base, voiceReferenceUrl: 'https://voice.test/sample.wav', voiceCoverStrength });
    expect(mocks.resolveVoice).not.toHaveBeenCalled();
    expect(mocks.releaseTask.mock.calls[0][0]).toEqual(expect.objectContaining({ reference_audio_path: 'https://voice.test/sample.wav', audio_cover_strength: voiceCoverStrength ?? .65 }));
  });
  it('propagates voice database failure before dispatch', async () => {
    mocks.resolveVoice.mockRejectedValue(new Error('voice database unavailable'));
    await expect(api.initiateGeneration({ ...base, voiceId: 'voice-1', voiceMode: 'trained' })).rejects.toThrow('voice database unavailable');
    expect(mocks.releaseTask).not.toHaveBeenCalled();
  });
});

describe('generation Service: status, persistence and non-destructive takes', () => {
  it('returns pending when a requested result is absent', async () => {
    generationContext('unknown');
    expect(await api.checkStatusAndFinalize('unknown', 'song-1')).toEqual({ status: 'pending', progress: 0 });
    expect(mocks.queryResult).toHaveBeenCalledWith(['unknown']);
    expect(mocks.persistAudioToR2).not.toHaveBeenCalled();
  });
  it.each(['pending', 'processing', 'error'])('returns %s progress/error without persistence', async (status) => {
    mocks.queryResult.mockResolvedValue({ results: { 'task-1': { task_id: 'task-1', status, progress: 23, error: 'reason' } } });
    expect(await api.checkStatusAndFinalize('task-1', 'song-1')).toEqual({ status, progress: 23, error: 'reason' });
    expect(mocks.finalizeSong).not.toHaveBeenCalled();
  });
  it('finalizes one stored result with SFT metadata', async () => {
    contexts.delete('task-1');
    const initial = await api.initiateGeneration({ ...base, modelVariant: 'sft' });
    mocks.getSongById.mockImplementation(async id => id === initial.songId ? { ...parent, id } : null);
    mocks.queryResult.mockResolvedValue(ready(['raw-a.wav'], [{ duration: 52.7 }]));
    const result = await api.checkStatusAndFinalize('task-1', initial.songId);
    expect(mocks.persistAudioToR2).toHaveBeenCalledTimes(1);
    expect(mocks.persistAudioToR2.mock.calls[0]).toEqual(['songs', expect.stringMatching(/^generated\/[a-f0-9]+\/1\.wav$/), 'raw-a.wav']);
    expect(mocks.finalizeSong).toHaveBeenCalledExactlyOnceWith(initial.songId,
      [expect.objectContaining({ id: initial.songId, url: result.primaryUrl, duration: 53 })],
      expect.objectContaining({ song_id: initial.songId, name: 'master', url: result.primaryUrl, volume: 1, pan: 0, is_muted: false, is_solo: false }),
      [expect.objectContaining({ model: 'acestep-v15-xl-sft', lyrics: '  [Verse]\nHello  ', prompt: base.prompt, take_number: 1, is_active: true, url: result.primaryUrl })]);
    expect(result).toMatchObject({ status: 'ready', progress: 100, audioUrls: [result.primaryUrl], duration: 53 });
  });
  it('persists a secondary song and creates one take for each variation', async () => {
    mocks.queryResult.mockResolvedValue(ready(['raw-a.wav', 'raw-b.wav'], [{ duration: '41.6' }, { duration: 50.2 }]));
    const result = await api.checkStatusAndFinalize('task-1', 'song-1');
    const [, outputs, , versions] = mocks.finalizeSong.mock.calls[0];
    expect(outputs[1]).toMatchObject({ id: 'song-1-var2', title: 'Song (Var 2)', creator: 'creator', source: 'song-1', duration: 50, tags: ['SOUL', 'ALT MIX'] });
    expect(versions.map((take: any) => take.is_active)).toEqual([true, false]);
    expect(result).toMatchObject({ songAId: 'song-1', songBId: 'song-1-var2', durations: [42, 50], audioUrls: [expect.stringMatching(/\/1\.wav$/), expect.stringMatching(/\/2\.wav$/)] });
  });
  it('delegates secondary-song conflict handling to the database transaction', async () => {
    mocks.getSongById.mockImplementation(async id => id === 'song-1' ? parent : { id, tags: [] });
    mocks.queryResult.mockResolvedValue(ready(['raw-a.wav', 'raw-b.wav']));
    await api.checkStatusAndFinalize('task-1', 'song-1');
    expect(mocks.createSong).not.toHaveBeenCalled();
    expect(mocks.finalizeSong.mock.calls[0][1].map((song: any) => song.id)).toEqual(['song-1', 'song-1-var2']);
    expect(mocks.getSongById).toHaveBeenCalledExactlyOnceWith('song-1');
  });
  it.each([undefined, 'invalid'])('falls back to stored song duration for metadata %j', async (duration) => {
    mocks.queryResult.mockResolvedValue(ready(['raw-a.wav'], [{ duration }]));
    expect(await api.checkStatusAndFinalize('task-1', 'song-1')).toMatchObject({ duration: 45 });
  });
  it('falls back secondary duration to primary duration', async () => {
    mocks.queryResult.mockResolvedValue(ready(['raw-a.wav', 'raw-b.wav'], [{ duration: 35 }]));
    expect(await api.checkStatusAndFinalize('task-1', 'song-1')).toMatchObject({ durations: [35, 35] });
  });
  it('stops before DB writes when primary R2 persistence fails', async () => {
    mocks.queryResult.mockResolvedValue(ready());
    mocks.persistAudioToR2.mockRejectedValue(new Error('R2 unavailable'));
    await expect(api.checkStatusAndFinalize('task-1', 'song-1')).rejects.toThrow('R2 unavailable');
    expect(mocks.finalizeSong).not.toHaveBeenCalled();
  });
  it('propagates a transaction failure without recording completion', async () => {
    mocks.queryResult.mockResolvedValue(ready());
    mocks.finalizeSong.mockRejectedValue(new Error('database unavailable'));
    await expect(api.checkStatusAndFinalize('task-1', 'song-1')).rejects.toThrow('database unavailable');
    expect(mocks.persistAudioToR2).toHaveBeenCalledTimes(1);
    expect(contexts.get('task-1')).not.toHaveProperty('result');
  });
  it('propagates query failure without any side effects', async () => {
    mocks.queryResult.mockRejectedValue(new Error('timeout'));
    await expect(api.checkStatusAndFinalize('task-1', 'song-1')).rejects.toThrow('timeout');
    expect(mocks.persistAudioToR2).not.toHaveBeenCalled();
  });
  it('propagates secondary storage failure without committing partial database rows', async () => {
    mocks.queryResult.mockResolvedValue(ready(['raw-a.wav', 'raw-b.wav']));
    mocks.persistAudioToR2.mockResolvedValueOnce('https://r2.test/a.wav').mockRejectedValueOnce(new Error('secondary storage failed'));
    await expect(api.checkStatusAndFinalize('task-1', 'song-1')).rejects.toThrow('secondary storage failed');
    expect(mocks.finalizeSong).not.toHaveBeenCalled();
  });
  it('handles 100 concurrent pending polls without writing storage or database objects', async () => {
    for (let i = 0; i < 100; i++) generationContext(`task-${i}`);
    const result = await Promise.all(Array.from({ length: 100 }, (_, i) => api.checkStatusAndFinalize(`task-${i}`, 'song-1')));
    expect(result).toHaveLength(100);
    expect(result.every(r => r.status === 'pending')).toBe(true);
    expect(mocks.persistAudioToR2).not.toHaveBeenCalled();
    expect(mocks.finalizeSong).not.toHaveBeenCalled();
  });
});
