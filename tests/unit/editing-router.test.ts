import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ dispatchEditTask: vi.fn(), separateStems: vi.fn(), createCommitSnapshot: vi.fn(), finalizeEditResult: vi.fn(), switchActiveTake: vi.fn(), deleteTake: vi.fn(), updateTrackMixer: vi.fn(), getTimelineHistory: vi.fn(), uploadToR2: vi.fn() }));
vi.mock('../../editing/service.js', () => ({ service: m }));
vi.mock('../../databases/users.js', () => ({ readSong: async () => ({ userAddress: '0x1234567890' }), readTake: async () => ({}), readUser: () => '0x1234567890', checkUser: () => { } }));
vi.mock('../../databases/client.js', () => ({ songSql: async () => [{ song_id: 's' }] }));
vi.mock('../../storage/r2.js', () => ({ uploadToR2: m.uploadToR2 }));
import { editingRouter } from '../../editing/router.js';
let app: FastifyInstance;
const base = { songId: 'song-1', userAddress: '0x1234567890' };
beforeEach(async () => {
  vi.resetAllMocks(); app = Fastify(); await app.register(multipart, { limits: { fileSize: 1024 } }); await app.register(editingRouter, { prefix: '/api/edit' });
  m.dispatchEditTask.mockResolvedValue({ taskId: 't', status: 'pending' });
  m.separateStems.mockResolvedValue({ status: 'ready', stems: [] });
  m.createCommitSnapshot.mockResolvedValue({ success: true, commit: { id: 'c' } });
  m.finalizeEditResult.mockResolvedValue({ status: 'pending', progress: 0 });
  m.switchActiveTake.mockResolvedValue({ success: true }); m.deleteTake.mockResolvedValue({ success: true });
  m.updateTrackMixer.mockResolvedValue({ id: 's', volume: 1 }); m.getTimelineHistory.mockResolvedValue({ stems: [], takes: [], commits: [] });
  m.uploadToR2.mockResolvedValue('https://audio.test/reference.wav');
});
afterEach(async () => { await app.close(); vi.restoreAllMocks(); });

describe('editing Fastify task routes and payload contracts', () => {
  it.each([
    ['repaint', { start: 0, end: 5 }, 'repaint'], ['layer', { prompt: 'add bass' }, 'lego'],
    ['extend', { audioDuration: 120 }, 'extend'], ['remix', { prompt: 'new style' }, 'cover'],
    ['apply', { task: 'cover' }, 'cover'],
  ])('accepts valid %s and dispatches %s', async (route, extras, task) => {
    const result = await app.inject({ method: 'POST', url: `/api/edit/${route}`, payload: { ...base, ...extras } });
    expect(result.statusCode).toBe(202); expect(m.dispatchEditTask).toHaveBeenCalledWith(expect.objectContaining({ ...base, task }));
  });
  it('maps all supported repaint aliases and honors explicit camel-case zero strength', async () => {
    await app.inject({ method: 'POST', url: '/api/edit/repaint', payload: { ...base, stemId: 's', start: 0, end: 5, repaintMode: 'aggressive', repaint_mode: 'balanced', repaintStrength: 0, repaint_strength: .8, repaintLatentCrossfadeFrames: 2, repaintWavCrossfadeSec: .1, srcAudioUrl: 'source.wav', lyrics: 'lyrics' } });
    expect(m.dispatchEditTask).toHaveBeenCalledWith(expect.objectContaining({ task: 'repaint', repaintingStart: 0, repaintingEnd: 5, repaintMode: 'aggressive', repaintStrength: 0, repaintLatentCrossfadeFrames: 2, repaintWavCrossfadeSec: .1, srcAudioUrl: 'source.wav', lyrics: 'lyrics' }));
  });
  it('uses snake_case repaint aliases when camel-case fields are absent', async () => {
    await app.inject({ method: 'POST', url: '/api/edit/repaint', payload: { ...base, start: 0, end: 5, repaint_mode: 'conservative', repaint_strength: .2 } });
    expect(m.dispatchEditTask).toHaveBeenCalledWith(expect.objectContaining({ repaintMode: 'conservative', repaintStrength: .2 }));
  });
  it('passes layer metadata and context tracks to the service', async () => {
    const controls = { prompt: 'add bass', globalCaption: 'mix', trackName: 'bass', trackClasses: ['bass'], audioDuration: 60, legoContextTrackIds: ['drums'], srcAudioUrl: 'src.wav' };
    await app.inject({ method: 'POST', url: '/api/edit/layer', payload: { ...base, ...controls } });
    expect(m.dispatchEditTask).toHaveBeenCalledWith(expect.objectContaining(controls));
  });
  it('forwards the selected transition length for extension, including zero', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/edit/extend', payload: { ...base, audioDuration: 120, repaintWavCrossfadeSec: 0 } });
    expect(result.statusCode).toBe(202);
    expect(m.dispatchEditTask).toHaveBeenCalledWith(expect.objectContaining({ repaintWavCrossfadeSec: 0 }));
  });
  it('passes remix noise and zero strength to the service', async () => {
    await app.inject({ method: 'POST', url: '/api/edit/remix', payload: { ...base, prompt: 'style', coverStrength: 0, coverNoiseStrength: 1 } });
    expect(m.dispatchEditTask).toHaveBeenCalledWith(expect.objectContaining({ coverStrength: 0, coverNoiseStrength: 1 }));
  });
  it('creates timeline snapshots at the commits route', async () => {
    const payload = { ...base, message: 'checkpoint', timelineSnapshot: { tracks: [] } };
    const result = await app.inject({ method: 'POST', url: '/api/edit/commits', payload });
    expect(result.statusCode).toBe(201); expect(m.createCommitSnapshot).toHaveBeenCalledWith(payload);
    expect(result.json()).toEqual({ success: true, commit: { id: 'c' } });
  });
  it('accepts the editor commit endpoint and snapshot field', async () => {
    const snapshot = { tracks: [], bpm: 120, duration: 60 };
    const result = await app.inject({ method: 'POST', url: '/api/edit/commit', payload: { ...base, message: 'checkpoint', snapshot } });
    expect(result.statusCode).toBe(201);
    expect(m.createCommitSnapshot).toHaveBeenCalledWith({ ...base, message: 'checkpoint', timelineSnapshot: snapshot });
  });
  it('isolates stems synchronously via /isolate and defaults stemType to all', async () => {
    const resIsolate = await app.inject({ method: 'POST', url: '/api/edit/isolate', payload: base });
    expect(resIsolate.statusCode).toBe(200); expect(m.separateStems).toHaveBeenCalledWith(expect.objectContaining({ ...base, stemType: 'all' }));
  });
  it('dispatches ACE-Step base instrument extraction on POST /extract when trackName is provided', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/edit/extract', payload: { ...base, trackName: 'guitar' } });
    expect(result.statusCode).toBe(202);
    expect(m.dispatchEditTask).toHaveBeenCalledWith(expect.objectContaining({ ...base, task: 'extract', trackName: 'guitar', modelQuality: 'base' }));
  });
  it.each([
    ['repaint', { start: -1, end: 5 }], ['repaint', { start: 0 }], ['repaint', { start: '0', end: 5 }],
    ['repaint', { start: 0, end: 5, repaintStrength: 1.1 }], ['repaint', { start: 0, end: 5, repaintMode: 'unsafe' }],
    ['repaint', { start: 0, end: 5, repaintLatentCrossfadeFrames: -1 }], ['repaint', { start: 0, end: 5, repaintWavCrossfadeSec: -1 }],
    ['layer', {}], ['layer', { prompt: '' }], ['layer', { prompt: 'bass', trackClasses: [1] }], ['layer', { prompt: 'bass', audioDuration: 4 }],
    ['layer', { prompt: 'bass', legoContextTrackIds: [1] }], ['extend', { audioDuration: 4 }],
    ['remix', { prompt: '' }], ['remix', { prompt: 'style', coverStrength: -1 }], ['remix', { prompt: 'style', coverNoiseStrength: 1.1 }],
    ['apply', { task: 'unknown' }], ['apply', { task: 'repaint', repaintingStart: -1 }],
    ['commits', { message: '' }], ['commits', { message: 'snapshot', timelineSnapshot: [] }],
  ])('rejects invalid %s controls %j before invoking any service', async (route, controls) => {
    const result = await app.inject({ method: 'POST', url: `/api/edit/${route}`, payload: { ...base, ...controls } });
    expect(result.statusCode).toBe(400); expect(m.dispatchEditTask).not.toHaveBeenCalled(); expect(m.createCommitSnapshot).not.toHaveBeenCalled();
  });
  it.each(['repaint', 'layer', 'extend', 'remix', 'isolate', 'commits', 'apply'])('%s rejects empty bodies with a client error', async route => {
    const result = await app.inject({ method: 'POST', url: `/api/edit/${route}`, payload: {} });
    expect(result.statusCode).toBe(400); expect(result.json()).toHaveProperty('error');
  });
  it.each([
    ['repaint', { start: 0, end: 5 }], ['layer', { prompt: 'bass' }], ['extend', { audioDuration: 120 }], ['remix', { prompt: 'style' }], ['apply', { task: 'cover' }],
  ])('%s returns caught dispatch failures', async (route, controls) => {
    m.dispatchEditTask.mockRejectedValue(new Error('worker failed'));
    const result = await app.inject({ method: 'POST', url: `/api/edit/${route}`, payload: { ...base, ...controls } });
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'worker failed' });
  });
  it.each([['isolate', 'separateStems', {}], ['commits', 'createCommitSnapshot', { message: 'checkpoint' }]])('%s returns caught service failures', async (route, method, controls) => {
    m[method as 'separateStems'].mockRejectedValue(new Error('database failed'));
    const result = await app.inject({ method: 'POST', url: `/api/edit/${route}`, payload: { ...base, ...controls } });
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'database failed' });
  });
  it.each([
    ['repaint', 'dispatchEditTask', { start: 0, end: 5 }, 'Repaint failed to initiate'],
    ['layer', 'dispatchEditTask', { prompt: 'bass' }, 'Layer failed to initiate'],
    ['extend', 'dispatchEditTask', { audioDuration: 120 }, 'Extend failed to initiate'],
    ['remix', 'dispatchEditTask', { prompt: 'style' }, 'Remix failed to initiate'],
    ['apply', 'dispatchEditTask', { task: 'cover' }, 'Failed to dispatch edit task'],
    ['isolate', 'separateStems', {}, 'Isolate failed to initiate'],
    ['commits', 'createCommitSnapshot', { message: 'checkpoint' }, 'Failed to create commit'],
  ])('%s uses a stable fallback for message-less dependency failures', async (route, method, controls, error) => {
    m[method as 'dispatchEditTask'].mockRejectedValue({});
    const result = await app.inject({ method: 'POST', url: `/api/edit/${route}`, payload: { ...base, ...controls } });
    expect(result.json()).toEqual({ error });
  });
});

describe('rendered reference upload', () => {
  function wave() {
    const data = Buffer.alloc(60);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8); data.write('fmt ', 12);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24);
    data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(16, 40);
    return data;
  }
  function upload(audio: Buffer, query = '?songId=song-1') {
    const boundary = 'reference-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      audio, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: 'POST', url: `/api/edit/source${query}`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  }
  it('persists the rendered WAV bytes under the source song', async () => {
    const audio = wave();
    const result = await upload(audio);
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ url: 'https://audio.test/reference.wav' });
    expect(m.uploadToR2).toHaveBeenCalledWith('versions', expect.stringMatching(/^sources\/song-1\/[a-f0-9-]+\.wav$/), audio, 'audio/wav');
  });
  it.each([Buffer.from('not audio'), Buffer.alloc(0)])('rejects invalid WAV bytes before persistence', async audio => {
    expect((await upload(audio)).statusCode).toBe(400);
    expect(m.uploadToR2).not.toHaveBeenCalled();
  });
  it('requires a source song', async () => {
    expect((await upload(wave(), '')).statusCode).toBe(400);
    expect(m.uploadToR2).not.toHaveBeenCalled();
  });
  it('rejects a missing file', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/edit/source?songId=song-1', headers: { 'content-type': 'multipart/form-data; boundary=empty' }, payload: '--empty--\r\n' });
    expect(result.statusCode).toBe(400);
    expect(m.uploadToR2).not.toHaveBeenCalled();
  });
  it('rejects an upload exceeding the multipart limit', async () => {
    expect((await upload(Buffer.alloc(2048))).statusCode).toBe(413);
    expect(m.uploadToR2).not.toHaveBeenCalled();
  });
  it('reports a storage failure without claiming a saved source', async () => {
    m.uploadToR2.mockRejectedValue(new Error('Storage unavailable'));
    const result = await upload(wave());
    expect(result.statusCode).toBe(500);
    expect(result.json()).toEqual({ error: 'Could not save reference audio' });
  });
});

describe('editing Fastify status and track-management routes', () => {
  it.each(['', '?songId=s', '?songId=s&task=cover', '?userAddress=address&task=cover'])('requires all status query parameters: %s', async query => {
    const result = await app.inject(`/api/edit/status/t${query}`);
    expect(result.statusCode).toBe(400); expect(m.finalizeEditResult).not.toHaveBeenCalled();
  });
  it('forwards status query values and parses repaint bounds including zero', async () => {
    const result = await app.inject('/api/edit/status/t?songId=s&userAddress=0x1234567890&task=repaint&stemId=stem&prompt=bass&repaintingStart=0&repaintingEnd=5.5');
    expect(result.statusCode).toBe(200);
    expect(m.finalizeEditResult).toHaveBeenCalledWith({ taskId: 't', songId: 's', userAddress: '0x1234567890', task: 'repaint', stemId: 'stem', prompt: 'bass', repaintingStart: 0, repaintingEnd: 5.5 });
  });
  it('reports finalization failure as 500', async () => {
    m.finalizeEditResult.mockRejectedValue(new Error('persist failed'));
    const result = await app.inject('/api/edit/status/t?songId=s&userAddress=0x1234567890&task=cover');
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'persist failed' });
  });
  it('status uses a stable fallback for message-less dependency failures', async () => {
    m.finalizeEditResult.mockRejectedValue({});
    const result = await app.inject('/api/edit/status/t?songId=s&userAddress=0x1234567890&task=cover');
    expect(result.json()).toEqual({ error: 'Failed to check edit status' });
  });
  it.each(['activate', 'takes/activate'])('activates a take through /%s', async route => {
    expect((await app.inject({ method: 'POST', url: `/api/edit/${route}`, payload: { songId: 's', takeId: 't', stemId: 'stem' } })).statusCode).toBe(200);
    expect(m.switchActiveTake).toHaveBeenCalledWith('s', 'stem', 't', undefined);
  });
  it('defaults activation stem identity to null', async () => {
    await app.inject({ method: 'POST', url: '/api/edit/activate', payload: { songId: 's', takeId: 't' } });
    expect(m.switchActiveTake).toHaveBeenCalledWith('s', null, 't', undefined);
  });
  it.each([{}, { songId: 's' }, { takeId: 't' }])('rejects missing activation identifiers %j', async payload => {
    expect((await app.inject({ method: 'POST', url: '/api/edit/activate', payload })).statusCode).toBe(400);
    expect(m.switchActiveTake).not.toHaveBeenCalled();
  });
  it('reports activation failures as 500', async () => {
    m.switchActiveTake.mockRejectedValue(new Error('activation failed'));
    const result = await app.inject({ method: 'POST', url: '/api/edit/activate', payload: { songId: 's', takeId: 't' } });
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'activation failed' });
  });
  it('deletes the requested take', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/edit/takes/t' })).statusCode).toBe(200);
    expect(m.deleteTake).toHaveBeenCalledWith('t');
  });
  it('reports take deletion failure as 500', async () => {
    m.deleteTake.mockRejectedValue(new Error('delete failed'));
    const result = await app.inject({ method: 'DELETE', url: '/api/edit/takes/t' });
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'delete failed' });
  });
  it('forwards zero volume, pan and boolean mixer settings', async () => {
    const mixer = { volume: 0, pan: -1, is_muted: true, is_solo: false };
    expect((await app.inject({ method: 'PATCH', url: '/api/edit/mixer/stem', payload: mixer })).statusCode).toBe(200);
    expect(m.updateTrackMixer).toHaveBeenCalledWith('stem', mixer);
  });
  it('reports mixer update failures as 500', async () => {
    m.updateTrackMixer.mockRejectedValue(new Error('mixer failed'));
    const result = await app.inject({ method: 'PATCH', url: '/api/edit/mixer/stem', payload: { volume: 1 } });
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'mixer failed' });
  });
  it('returns timeline history for the requested song', async () => {
    const result = await app.inject('/api/edit/history/song');
    expect(result.statusCode).toBe(200); expect(m.getTimelineHistory).toHaveBeenCalledWith('song');
    expect(result.json()).toEqual({ stems: [], takes: [], commits: [] });
  });
  it('reports history retrieval failures as 500', async () => {
    m.getTimelineHistory.mockRejectedValue(new Error('history failed'));
    const result = await app.inject('/api/edit/history/song');
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'history failed' });
  });
});
