import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisFixture } from '../support/voice-storage-broker.js';
const h = vi.hoisted(() => ({ redis: null as any, ctor: vi.fn() }));
vi.mock('ioredis', () => ({ Redis: class { constructor(uri: string, options: any) { h.ctor(uri, options); return h.redis; } } }));
let fixture: ReturnType<typeof redisFixture>;
let broker: typeof import('../../broker/valkey.js');
const job = { id: 'job-1', type: 'generate' as const, payload: { prompt: 'Song' } };
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
  fixture = redisFixture(); h.redis = fixture.redis; broker = await import('../../broker/valkey.js');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('Valkey broker', () => {
  it('bounds connection attempts and command duration', () => {
    expect(h.ctor).toHaveBeenCalledWith('redis://127.0.0.1:1', expect.objectContaining({ maxRetriesPerRequest: 3, connectTimeout: 10000, commandTimeout: 10000, tls: undefined }));
  });
  it.each([[1, 100], [2, 200], [29, 2900], [30, 3000], [100, 3000]])('retry %s waits %s ms', (attempt, expected) => {
    expect(h.ctor.mock.calls[0][1].retryStrategy(attempt)).toBe(expected);
  });
  it('handles provider error events', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fixture.listeners.get('error')!(new Error('socket down'));
    expect(console.warn).toHaveBeenCalledWith('[Valkey]', 'socket down');
  });
  it.each(['generate', 'edit', 'clone', 'separate'] as const)('queues %s with retrievable state', async type => {
    const result = await broker.enqueueJob(type, { ...job, type });
    expect(result).toEqual({ ...job, type, status: 'queued', progress: 0, createdAt: Date.now(), updatedAt: Date.now() });
    expect(fixture.queues.get(`queue:${type}`)).toEqual([job.id]);
    expect(await broker.getJob(`job:${job.id}`)).toEqual(result);
  });
  it('preserves the original payload and progress on duplicate admission', async () => {
    await broker.enqueueJob('generate', job);
    await broker.updateJobStatus(job.id, { progress: 50 });
    expect(await broker.enqueueJob('generate', { ...job, payload: { prompt: 'New' } })).toMatchObject({ payload: job.payload, progress: 50 });
    expect(fixture.queues.get('queue:generate')).toEqual([job.id]);
  });
  it('rejects nonserializable payloads before issuing commands', async () => {
    const payload: any = {}; payload.self = payload;
    await expect(broker.enqueueJob('generate', { ...job, payload })).rejects.toThrow();
    await expect(broker.enqueueJob('generate', { ...job, payload: { value: 1n } })).rejects.toThrow();
    expect(fixture.redis.eval).not.toHaveBeenCalled();
  });
  it('merges concurrent updates and preserves immutable fields', async () => {
    const first = await broker.enqueueJob('generate', job);
    await Promise.all([broker.updateJobStatus(job.id, { progress: 50 }), broker.updateJobStatus(job.id, { result: { url: 'stored.wav' } })]);
    await broker.updateJobStatus(job.id, { id: 'other', payload: {}, status: 'processing' } as any);
    expect(await broker.getJob(job.id)).toMatchObject({ id: job.id, payload: job.payload, progress: 50, result: { url: 'stored.wav' }, createdAt: first.createdAt });
  });
  it('retains active jobs and expires terminal jobs after 24 hours', async () => {
    await broker.enqueueJob('generate', job);
    await vi.advanceTimersByTimeAsync(86400000);
    expect(await broker.getJob(job.id)).not.toBeNull();
    await broker.updateJobStatus(job.id, { status: 'ready', progress: 100 });
    expect(fixture.queues.get('queue:generate')).toEqual([]);
    await vi.advanceTimersByTimeAsync(86400000);
    expect(await broker.getJob(job.id)).toBeNull();
  });
  it('does not reset the terminal retention deadline on later updates', async () => {
    await broker.enqueueJob('generate', job);
    await broker.updateJobStatus(job.id, { status: 'failed', error: 'OOM' });
    await vi.advanceTimersByTimeAsync(23 * 3600000);
    await broker.updateJobStatus(job.id, { error: 'GPU OOM' });
    await vi.advanceTimersByTimeAsync(3600000);
    expect(await broker.getJob(job.id)).toBeNull();
  });
  it.each(['{broken', 'null', '{}', '42', '{"id":"other"}'])('discards invalid cached record %s', async raw => {
    fixture.values.set(`job:${job.id}`, { value: raw });
    expect(await broker.getJob(job.id)).toBeNull();
    expect(fixture.values.has(`job:${job.id}`)).toBe(false);
  });
  it('propagates transport failures without replacing existing state', async () => {
    fixture.redis.get.mockRejectedValueOnce(new Error('connection dropped'));
    await expect(broker.getJob(job.id)).rejects.toThrow('connection dropped');
    await broker.enqueueJob('generate', job);
    fixture.redis.eval.mockRejectedValueOnce(new Error('command failed'));
    await expect(broker.updateJobStatus(job.id, { progress: 2 })).rejects.toThrow('command failed');
    expect((await broker.getJob(job.id))?.progress).toBe(0);
  });
  it('stores task context across service instances and preserves active retention', async () => {
    await broker.setTaskContext('task-1', { songId: 'song-1', stage: 'dispatched' });
    await vi.advanceTimersByTimeAsync(86400000);
    expect(await broker.getTaskContext('task-1')).toEqual({ songId: 'song-1', stage: 'dispatched' });
    await broker.setTaskContext('task-1', { done: true }, { terminal: true });
    await vi.advanceTimersByTimeAsync(86400000);
    expect(await broker.getTaskContext('task-1')).toBeNull();
  });
  it('releases an owned finalization lease after success or failure', async () => {
    expect(await broker.withJobLock('task-1', async () => 5)).toBe(5);
    expect(fixture.values.has('rawchunks:lock:task-1')).toBe(false);
    await expect(broker.withJobLock('task-1', async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    expect(fixture.values.has('rawchunks:lock:task-1')).toBe(false);
  });
  it.each([
    ['VALKEY_URI', 'redis://generic.invalid:6379'],
    ['VALKEY_REQUESTS_SERVICE_URI', 'rediss://default:test@tls.invalid:6379'],
  ])('honors %s', async (name, value) => {
    vi.stubEnv('VALKEY_REQUESTS_SERVICE_URI', ''); vi.stubEnv(name, value);
    vi.resetModules(); await import('../../broker/valkey.js');
    expect(h.ctor.mock.calls.at(-1)?.[0]).toBe(value);
  });
});
