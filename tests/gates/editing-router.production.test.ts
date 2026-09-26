import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ dispatchEditTask: vi.fn(), separateStems: vi.fn(), createCommitSnapshot: vi.fn(), finalizeEditResult: vi.fn(), switchActiveTake: vi.fn(), deleteTake: vi.fn(), updateTrackMixer: vi.fn(), getTimelineHistory: vi.fn() }));
const scope = vi.hoisted(() => ({ song: { metadata_cid: undefined as string | undefined } }));
vi.mock('../../editing/service.js', () => ({ service: m }));
vi.mock('../../databases/users.js', () => ({ readSong: async () => ({ userAddress: '0x1234567890', song: scope.song }), readTake: async () => ({ song: scope.song }), readUser: () => '0x1234567890', checkUser: () => {} }));
vi.mock('../../databases/client.js', () => ({ songSql: async () => [{ song_id: 's' }] }));
import { editingRouter } from '../../editing/router.js';
let app: FastifyInstance;
const base = { songId: 'song-1', userAddress: '0x1234567890' };
beforeEach(async () => { vi.resetAllMocks(); scope.song.metadata_cid = undefined; app = Fastify(); await app.register(editingRouter, { prefix: '/api/edit' }); for (const fn of Object.values(m)) fn.mockResolvedValue({ status: 'pending' }); });
afterEach(async () => { await app.close(); vi.restoreAllMocks(); });

describe('editing API payload fidelity and numerical validation', () => {
  it.each([
    ['POST', '/api/edit/activate', { ...base, takeId: 'take' }, 'switchActiveTake'],
    ['DELETE', '/api/edit/takes/take', undefined, 'deleteTake'],
    ['PATCH', '/api/edit/mixer/stem', { volume: .5 }, 'updateTrackMixer'],
    ['POST', '/api/edit/commit', { ...base, message: 'Edit' }, 'createCommitSnapshot'],
  ] as const)('rejects %s %s on a pinned version before mutation', async (method, url, payload, handler) => {
    scope.song.metadata_cid = 'metadata';
    const response = await app.inject({ method, url, payload });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Open an editable version before changing this song' });
    expect(m[handler]).not.toHaveBeenCalled();
  });
  it.each([
    ['repaint', { start: 0, end: 5 }], ['layer', { prompt: 'bass' }], ['extend', { audioDuration: 120 }], ['remix', { prompt: 'style' }], ['apply', { task: 'cover' }],
  ])('%s preserves requested modelQuality and modelVariant', async (route, controls) => {
    await app.inject({ method: 'POST', url: `/api/edit/${route}`, payload: { ...base, ...controls, modelQuality: 'turbo', modelVariant: 'turbo' } });
    expect(m.dispatchEditTask).toHaveBeenCalledWith(expect.objectContaining({ modelQuality: 'turbo', modelVariant: 'turbo' }));
  });
  it.each([[5, 2], [5, 5]])('repaint rejects non-positive interval [%s, %s]', async (start, end) => {
    expect((await app.inject({ method: 'POST', url: '/api/edit/repaint', payload: { ...base, start, end } })).statusCode).toBe(400);
    expect(m.dispatchEditTask).not.toHaveBeenCalled();
  });
  it('repaint rejects fractional frame counts', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/edit/repaint', payload: { ...base, start: 0, end: 5, repaintLatentCrossfadeFrames: .5 } })).statusCode).toBe(400);
  });
  it.each(['javascript:alert(1)', 'file:///etc/passwd'])('rejects unsupported source URL %s', async srcAudioUrl => {
    expect((await app.inject({ method: 'POST', url: '/api/edit/remix', payload: { ...base, prompt: 'style', srcAudioUrl } })).statusCode).toBe(400);
  });
  it.each([
    ['task=unknown', 'unknown task'], ['task=cover&repaintingStart=NaN', 'NaN'],
    ['task=repaint&repaintingStart=-1&repaintingEnd=3', 'negative start'],
    ['task=repaint&repaintingStart=12garbage&repaintingEnd=20', 'partial numeric parse'],
    ['task=cover&userAddress=x', 'short address'],
  ])('status rejects %s (%s) before side effects', async (query, _label) => {
    const result = await app.inject(`/api/edit/status/t?songId=s&userAddress=0x1234567890&${query}`);
    expect(result.statusCode).toBe(400); expect(m.finalizeEditResult).not.toHaveBeenCalled();
  });
  it.each([null, { songId: 23, takeId: 't' }, { songId: 's', takeId: ['t'] }])('activation rejects invalid body %j', async payload => {
    expect((await app.inject({ method: 'POST', url: '/api/edit/activate', payload })).statusCode).toBe(400);
    expect(m.switchActiveTake).not.toHaveBeenCalled();
  });
  it.each([null, { volume: -1 }, { volume: 'loud' }, { pan: 2 }, { pan: -2 }, { is_muted: 'false' }, { is_solo: 1 }])('mixer rejects invalid settings %j before DB access', async payload => {
    expect((await app.inject({ method: 'PATCH', url: '/api/edit/mixer/stem', payload })).statusCode).toBe(400);
    expect(m.updateTrackMixer).not.toHaveBeenCalled();
  });
  it('returns an operational edit failure as a server error for valid input', async () => {
    m.dispatchEditTask.mockRejectedValue(new Error('worker unavailable'));
    expect((await app.inject({ method: 'POST', url: '/api/edit/remix', payload: { ...base, prompt: 'style' } })).statusCode).toBeGreaterThanOrEqual(500);
  });
});
