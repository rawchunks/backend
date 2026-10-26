import { valkeyCache } from '../broker/valkey.js';

interface L1Entry<T = unknown> {
  value: T;
  expiresAt: number;
}

const MAX_L1_ENTRIES = 10_000;
const l1 = new Map<string, L1Entry>();
const inflight = new Map<string, Promise<unknown>>();

function isCacheEnabled(): boolean {
  return !process.env.VITEST || process.env.TEST_CACHE_ENABLED === 'true';
}

export function l1Get<T>(key: string): T | undefined {
  if (!isCacheEnabled()) return undefined;
  const entry = l1.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    l1.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function l1Set<T>(key: string, value: T, ttlMs: number): void {
  if (!isCacheEnabled()) return;
  if (l1.size >= MAX_L1_ENTRIES && !l1.has(key)) {
    const oldestKey = l1.keys().next().value;
    if (oldestKey !== undefined) l1.delete(oldestKey);
  }
  l1.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function l1Del(...keys: string[]): void {
  for (const key of keys) {
    if (key) l1.delete(key);
  }
}

export async function cacheGet<T>(key: string, l1TtlMs = 30_000): Promise<T | undefined> {
  if (!isCacheEnabled()) return undefined;
  const hit = l1Get<T>(key);
  if (hit !== undefined) return hit;
  try {
    const raw = await valkeyCache.get(key);
    if (raw === null || raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as T;
    l1Set(key, parsed, l1TtlMs);
    return parsed;
  } catch {
    return undefined;
  }
}

export async function cacheMGet<T>(keys: string[], l1TtlMs = 30_000): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (!isCacheEnabled() || keys.length === 0) return result;
  const missing: string[] = [];
  for (const key of keys) {
    const hit = l1Get<T>(key);
    if (hit !== undefined) {
      result.set(key, hit);
    } else {
      missing.push(key);
    }
  }
  if (missing.length === 0) return result;
  try {
    const raws = await valkeyCache.mget(...missing);
    for (let i = 0; i < missing.length; i++) {
      const raw = raws[i];
      if (raw !== null && raw !== undefined) {
        const parsed = JSON.parse(raw) as T;
        l1Set(missing[i], parsed, l1TtlMs);
        result.set(missing[i], parsed);
      }
    }
  } catch {
    // Non-fatal L2 read failure
  }
  return result;
}

export async function cacheSet<T>(
  key: string,
  value: T,
  l2TtlSeconds = 300,
  l1TtlMs = Math.min(l2TtlSeconds * 1000, 60_000),
): Promise<void> {
  if (!isCacheEnabled()) return;
  l1Set(key, value, l1TtlMs);
  try {
    await valkeyCache.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(l2TtlSeconds)));
  } catch {
    // Non-fatal L2 write failure; L1 still serves in-process
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  const valid = keys.filter(Boolean);
  if (valid.length === 0) return;
  l1Del(...valid);
  if (!isCacheEnabled()) return;
  try {
    await valkeyCache.del(...valid);
  } catch {
    // Non-fatal L2 delete failure
  }
}

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!isCacheEnabled()) return fn();
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fn().finally(() => {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  });
  inflight.set(key, promise);
  return promise;
}

export async function cached<T>(
  key: string,
  l2TtlSeconds: number,
  l1TtlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key, l1TtlMs);
  if (hit !== undefined) return hit;
  return singleFlight(`sf:${key}`, async () => {
    const recheck = l1Get<T>(key);
    if (recheck !== undefined) return recheck;
    const result = await fn();
    if (result !== undefined && result !== null) {
      await cacheSet(key, result, l2TtlSeconds, l1TtlMs);
    }
    return result;
  });
}
