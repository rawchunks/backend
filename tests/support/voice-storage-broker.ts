import { vi } from 'vitest';

/** In-memory fixture, not a Redis protocol/server durability simulation. */
export function redisFixture() {
  const values = new Map<string, { value: string; expiresAt?: number }>();
  const queues = new Map<string, string[]>();
  const listeners = new Map<string, Function>();
  const redis = {
    on: vi.fn((event: string, listener: Function) => { listeners.set(event, listener); return redis; }),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      const current = values.get(key);
      if (current?.expiresAt !== undefined && current.expiresAt <= Date.now()) values.delete(key);
      if (args.includes('NX') && values.has(key)) return null;
      const ex = args.indexOf('EX'); const px = args.indexOf('PX');
      values.set(key, { value, expiresAt: ex >= 0 ? Date.now() + Number(args[ex + 1]) * 1000 : px >= 0 ? Date.now() + Number(args[px + 1]) : undefined });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => {
      const entry = values.get(key);
      if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) { values.delete(key); return null; }
      return entry?.value ?? null;
    }),
    rpush: vi.fn(async (key: string, value: string) => {
      const queue = queues.get(key) ?? [];
      queue.push(value); queues.set(key, queue); return queue.length;
    }),
    del: vi.fn(async (key: string) => Number(values.delete(key))),
    multi: vi.fn(),
    eval: vi.fn(async (script: string, count: number, ...params: unknown[]) => {
      const keys = params.slice(0, count) as string[];
      const args = params.slice(count);
      const read = (key: string) => {
        const entry = values.get(key);
        if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) { values.delete(key); return null; }
        return entry?.value ?? null;
      };
      if (script.startsWith('-- enqueue_job')) {
        if (values.has(keys[1])) throw new Error('WRONGTYPE queue must be a list');
        const existing = read(keys[0]); if (existing) return existing;
        const full = String(args[0]); const id = String(args[1]);
        values.set(keys[0], { value: full }); values.set(keys[2], { value: keys[1] });
        const queue = queues.get(keys[1]) ?? []; queue.push(id); queues.set(keys[1], queue);
        return full;
      }
      if (script.startsWith('-- update_job')) {
        const raw = read(keys[0]); if (!raw) return null;
        let job; try { job = JSON.parse(raw); } catch { return null; }
        if (!job || job.id !== args[0] || !job.payload || typeof job.payload !== 'object') return null;
        const patch = JSON.parse(String(args[1]));
        if (['ready', 'failed'].includes(job.status) && patch.status && patch.status !== job.status) throw new Error('Terminal job state cannot change');
        const full = JSON.stringify({ ...job, ...patch, updatedAt: Number(args[2]) });
        const expiresAt = ['ready', 'failed'].includes(patch.status ?? job.status) ? values.get(keys[0])?.expiresAt ?? Date.now() + Number(args[3]) * 1000 : undefined;
        values.set(keys[0], { value: full, expiresAt });
        if (expiresAt !== undefined) {
          const queue = read(keys[1]); if (queue) queues.set(queue, (queues.get(queue) ?? []).filter(id => id !== args[0]));
          values.delete(keys[1]);
        }
        return full;
      }
      if (script.startsWith('-- cleanup_job')) {
        const queue = read(keys[1]); if (queue) queues.set(queue, (queues.get(queue) ?? []).filter(id => id !== args[0]));
        keys.forEach(key => values.delete(key)); return 1;
      }
      if (script.startsWith('-- renew_lock')) {
        if (read(keys[0]) !== args[0]) return 0;
        values.get(keys[0])!.expiresAt = Date.now() + Number(args[1]); return 1;
      }
      if (script.startsWith('-- release_lock')) return read(keys[0]) === args[0] ? Number(values.delete(keys[0])) : 0;
      throw new Error('Unsupported fixture script');
    }),
    watch: vi.fn(), quit: vi.fn(),
  };
  return { redis, values, queues, listeners };
}

export type FixtureSong = { id: string; title: string; url: string | null; metadata_cid?: string | null; [key: string]: unknown };
export type Predicate = { op: 'in' | 'eq'; values: string[]; field: string };

/** Models data effects/constraints; does not establish PostgreSQL isolation or FK behavior. */
export function songDbFixture(initialRows: FixtureSong[] = []) {
  const rows = new Map(initialRows.map(row => [row.id, { ...row }]));
  const history: Array<{ operation: string; ids?: string[]; value?: any }> = [];
  const matches = (row: FixtureSong, p: Predicate) => p.values.includes(String(row[p.field]));
  const db = {
    select: vi.fn(() => ({ from: vi.fn(async () => Array.from(rows.values(), row => ({ ...row }))) })),
    delete: vi.fn(() => ({ where: vi.fn(async (p: Predicate) => {
      history.push({ operation: 'delete', ids: [...p.values] });
      for (const [id, row] of rows) if (matches(row, p)) rows.delete(id);
    }) })),
    insert: vi.fn(() => ({ values: vi.fn(async (value: FixtureSong) => {
      history.push({ operation: 'insert', value: { ...value } });
      if (rows.has(value.id)) throw new Error(`duplicate key ${value.id}`);
      rows.set(value.id, { ...value });
    }) })),
    update: vi.fn(() => ({ set: vi.fn((value: Partial<FixtureSong>) => ({ where: vi.fn(async (p: Predicate) => {
      history.push({ operation: 'update', ids: [...p.values], value });
      for (const [id, row] of rows) if (matches(row, p)) rows.set(id, { ...row, ...value });
    }) })) })),
    transaction: vi.fn(),
  };
  return { db, rows, history };
}

export const song = (id = 'sng-1', extra: Partial<FixtureSong> = {}): FixtureSong => ({
  id, title: `Title ${id}`, url: `https://storage.test/${id}.wav`, metadata_cid: null, ...extra,
});
export const object = (key: string) => ({ key, size: 128, lastModified: '2026-01-01T00:00:00.000Z' });
export function response(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), init);
}
