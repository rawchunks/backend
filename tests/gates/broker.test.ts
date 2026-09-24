import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisFixture } from '../support/voice-storage-broker.js';
const h = vi.hoisted(() => ({ redis: null as any, ctor: vi.fn() }));
vi.mock('ioredis', () => ({ Redis: class { constructor(uri: string, options: any) { h.ctor(uri, options); return h.redis; } } }));
let fixture: ReturnType<typeof redisFixture>;
let broker: typeof import('../../broker/valkey.js');
const job = { id: 'j1', type: 'generate' as const, payload: { prompt: 'song' } };
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
  fixture = redisFixture(); h.redis = fixture.redis; broker = await import('../../broker/valkey.js');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('Valkey integrity', () => {
  it('rejects an invalid queue type without creating a job', async () => {
    fixture.values.set('queue:generate', { value: 'wrong-type' });
    await expect(broker.enqueueJob('generate', job)).rejects.toThrow('WRONGTYPE');
    expect(fixture.values.has('job:j1')).toBe(false);
  });
  it('duplicate submissions must be idempotent and preserve existing progress', async () => {
    await broker.enqueueJob('generate', job); await broker.updateJobStatus(job.id, { status: 'processing', progress: 50 });
    await broker.enqueueJob('generate', job);
    expect(fixture.queues.get('queue:generate')).toEqual([job.id]); expect((await broker.getJob(job.id))?.progress).toBe(50);
  });
  it('merges simultaneous state changes atomically', async () => {
    await broker.enqueueJob('generate', job);
    await Promise.all([broker.updateJobStatus(job.id, { status: 'processing' }), broker.updateJobStatus(job.id, { progress: 50 })]);
    expect(await broker.getJob(job.id)).toMatchObject({ status: 'processing', progress: 50 });
  });
  it('does not resurrect an absent job during update', async () => {
    expect(await broker.updateJobStatus(job.id, { progress: 50 })).toBeNull();
    expect(fixture.values.has('job:j1')).toBe(false);
  });
  it('queued work must retain retrievable state beyond a fixed 24h outage', async () => {
    await broker.enqueueJob('generate', job); await vi.advanceTimersByTimeAsync(86400 * 1000);
    expect(await broker.getJob(job.id)).not.toBeNull();
  });
  it('terminal ready jobs must reject transition back to queued', async () => {
    await broker.enqueueJob('generate', job); await broker.updateJobStatus(job.id, { status: 'ready', progress: 100 });
    await expect(broker.updateJobStatus(job.id, { status: 'queued', progress: 0 })).rejects.toThrow();
  });
  it.each([-1, 101, NaN, Infinity])('invalid progress %s must be rejected', async progress => {
    await broker.enqueueJob('generate', job); await expect(broker.updateJobStatus(job.id, { progress })).rejects.toThrow();
  });
  it.each(['unknown', 'DONE', ''])('runtime-invalid status %s must be rejected', async status => {
    await broker.enqueueJob('generate', job); await expect(broker.updateJobStatus(job.id, { status: status as any })).rejects.toThrow();
  });
  it.each([['', job], ['generate', { ...job, id: '' }], ['generate', { ...job, type: 'unknown' as any }], ['generate', { ...job, payload: null as any }]])('reject invalid queue/job %j %j before persistence', async (queue, data) => {
    await expect(broker.enqueueJob(queue, data)).rejects.toThrow(); expect(fixture.redis.set).not.toHaveBeenCalled();
  });
  it('update must consistently accept the same prefixed ID as retrieval', async () => {
    await broker.enqueueJob('generate', job); expect(await broker.updateJobStatus('job:j1', { progress: 50 })).toMatchObject({ progress: 50 });
  });
  it('runtime updates must not overwrite immutable job ID/payload', async () => {
    await broker.enqueueJob('generate', job); await broker.updateJobStatus(job.id, { id: 'other', payload: { injected: true }, status: 'processing' } as any);
    expect(JSON.parse(fixture.values.get('job:j1')!.value)).toMatchObject({ id: 'j1', payload: { prompt: 'song' } });
  });
  it('corrupt cached JSON must be quarantined or returned as absent rather than crash retrieval', async () => {
    fixture.values.set('job:j1', { value: '{broken' }); expect(await broker.getJob(job.id)).toBeNull();
  });
  it.each(['null', '42', '{}', '{"id":"other","status":"ready"}'])('malformed job schema %s must not be returned as valid', async raw => {
    fixture.values.set('job:j1', { value: raw }); const result = await broker.getJob(job.id); expect(result).toBeNull();
  });
  it('TLS must verify server certificates for rediss', async () => {
    vi.stubEnv('VALKEY_REQUESTS_SERVICE_URI', 'rediss://default:test@tls.invalid:6379'); vi.resetModules(); await import('../../broker/valkey.js');
    expect(h.ctor.mock.calls.at(-1)?.[1].tls?.rejectUnauthorized).not.toBe(false);
  });
  it('host fallback must encode password characters in the URI', async () => {
    vi.stubEnv('VALKEY_REQUESTS_SERVICE_URI', ''); vi.stubEnv('VALKEY_URI', ''); vi.stubEnv('VALKEY_REQUESTS_HOST', 'tls.invalid'); vi.stubEnv('VALKEY_REQUESTS_PASSWORD', 'test@:/#pass');
    vi.resetModules(); await import('../../broker/valkey.js'); expect(new URL(h.ctor.mock.calls.at(-1)![0]).password).toBe(encodeURIComponent('test@:/#pass'));
  });
});
