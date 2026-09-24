import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

// Deliberately independent from .env. Only a local isolated Valkey is allowed.
const uri = process.env.RAWCHUNKS_TEST_VALKEY_URI;
const enabled = !!uri && /^redis:\/\/127\.0\.0\.1:\d+$/.test(uri);
describe.skipIf(!enabled)('real isolated Valkey broker integration and stress', () => {
  let broker: typeof import('../../broker/valkey.js');
  let control: Redis;
  const prefix = `test-${randomUUID()}`;
  const queues = [prefix, `${prefix}-duplicates`, `${prefix}-expiry`];
  const ids = new Set<string>();
  beforeAll(async () => {
    vi.resetModules();
    vi.stubEnv('VALKEY_REQUESTS_SERVICE_URI', uri!);
    control = new Redis(uri!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await control.connect();
    broker = await import('../../broker/valkey.js');
    await broker.valkey.ping();
  });
  afterAll(async () => {
    // Never FLUSHDB/FLUSHALL. Clean up exact randomly namespaced keys only.
    const keys = [...queues.map(q => `queue:${q}`), ...Array.from(ids, id => `job:${id}`), ...Array.from(ids, id => `jobqueue:${id}`)];
    await control.del(...keys);
    await broker.closeSubscriptions();
    await broker.valkey.quit();
    await control.quit();
    vi.unstubAllEnvs();
  });
  const job = (id: string) => { ids.add(id); return { id, type: 'generate' as const, payload: { prompt: 'test' } }; };
  it('handles 1000 unique simultaneous jobs without lost queue entries or wrong states', async () => {
    const start = performance.now();
    const jobs = Array.from({ length: 1000 }, (_, i) => job(`${prefix}-${i}`));
    await Promise.all(jobs.map(j => broker.enqueueJob(prefix, j)));
    const queued = await control.lrange(`queue:${prefix}`, 0, -1);
    expect(queued.length).toBe(1000);
    expect(new Set(queued).size).toBe(1000);
    const states = await Promise.all(jobs.map(j => broker.getJob(j.id)));
    expect(states.every((x, i) => x?.id === jobs[i].id && x?.status === 'queued')).toBe(true);
    console.info(JSON.stringify({ metric: 'isolated_valkey_enqueue_1000', ms: Math.round(performance.now() - start) }));
  });
  it('retains queued jobs and reads prefixed/bare identifiers', async () => {
    const j = job(`${prefix}-retention`);
    await broker.enqueueJob(prefix, j);
    expect(await control.ttl(`job:${j.id}`)).toBe(-1);
    await broker.updateJobStatus(j.id, { status: 'ready', progress: 100 });
    expect(await control.ttl(`job:${j.id}`)).toBeGreaterThanOrEqual(86398);
    expect(await broker.getJob(j.id)).toEqual(await broker.getJob(`job:${j.id}`));
  });
  it('retries with the same job id do not enqueue duplicate work', async () => {
    const j = job(`${prefix}-retry`);
    await Promise.all(Array.from({ length: 50 }, () => broker.enqueueJob(queues[1], j)));
    expect(await control.llen(`queue:${queues[1]}`)).toBe(1);
  });
  it('concurrent disjoint progress/result updates are not lost', async () => {
    const j = job(`${prefix}-race`);
    await broker.enqueueJob(prefix, j);
    await Promise.all([
      broker.updateJobStatus(j.id, { progress: 50 }),
      broker.updateJobStatus(j.id, { result: { url: 'stored.wav' } }),
    ]);
    expect(await broker.getJob(j.id)).toMatchObject({ progress: 50, result: { url: 'stored.wav' } });
  });
  it('an expired job does not remain as executable dangling queue work', async () => {
    const j = job(`${prefix}-expired`);
    await broker.enqueueJob(queues[2], j);
    await control.pexpire(`job:${j.id}`, 5);
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(await broker.getJob(j.id)).toBeNull();
    expect(await control.llen(`queue:${queues[2]}`)).toBe(0);
  });
  it('rejects a corrupt queue pointer before changing terminal job state', async () => {
    const j = job(`${prefix}-pointer-wrongtype`);
    await broker.enqueueJob(prefix, j);
    await control.del(`jobqueue:${j.id}`);
    await control.rpush(`jobqueue:${j.id}`, 'wrong-type');
    const original = await control.get(`job:${j.id}`);
    await expect(broker.updateJobStatus(j.id, { status: 'ready', progress: 100 })).rejects.toThrow(/WRONGTYPE/);
    expect(await control.get(`job:${j.id}`)).toBe(original);
    expect(await control.ttl(`job:${j.id}`)).toBe(-1);
  });
  it('failed RPUSH does not leave an orphan queued job', async () => {
    const j = job(`${prefix}-wrongtype`);
    await control.set(`queue:${prefix}-duplicates`, 'wrong-type');
    await expect(broker.enqueueJob(queues[1], j)).rejects.toThrow(/WRONGTYPE/);
    expect(await broker.getJob(j.id)).toBeNull();
  });
  it('fences context writes in the same command and keeps the new owner intact', async () => {
    const id = `${prefix}-context`; ids.add(id);
    const lock = `rawchunks:lock:${id}`;
    try {
      await broker.withJobLock(id, async lease => {
        await lease.save(id, { value: 1 });
        expect(await broker.getTaskContext(id)).toEqual({ value: 1 });
        await control.set(lock, 'replacement', 'PX', 10000);
        await expect(lease.save(id, { value: 2 })).rejects.toThrow('lease lost');
        expect(await broker.getTaskContext(id)).toEqual({ value: 1 });
      });
    } catch (error) { expect(String(error)).toContain('lease lost'); }
    expect(await control.get(lock)).toBe('replacement');
    await control.del(lock, `rawchunks:context:${id}`);
  });
  it('releases without a separate ownership read and rejects a stale return', async () => {
    const id = `${prefix}-lease`;
    const get = vi.spyOn(broker.valkey, 'get');
    expect(await broker.withJobLock(id, async () => 'complete')).toBe('complete');
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    await expect(broker.withJobLock(id, async () => {
      await control.set(`rawchunks:lock:${id}`, 'replacement');
      return 'stale';
    })).rejects.toThrow('lease lost');
    await control.del(`rawchunks:lock:${id}`);
  });

  it('delivers completion signals and removes subscriptions on close', async () => {
    const id = `${prefix}-events`;
    const received: string[] = [];
    const stop = await broker.subscribeTask(id, value => received.push(value), () => {});
    expect(await control.publish(`rawchunks:worker:events:${id}`, 'succeeded')).toBe(1);
    await vi.waitFor(() => expect(received).toContain('succeeded'));
    await stop();
    expect(await control.publish(`rawchunks:worker:events:${id}`, 'failed')).toBe(0);
  });

});
