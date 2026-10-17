import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import * as dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: resolve(process.cwd(), '.env') });
const uri = process.env.VALKEY_REQUESTS_SERVICE_URI || process.env.VALKEY_URI ||
  (process.env.VALKEY_REQUESTS_HOST
    ? `rediss://default:${encodeURIComponent(process.env.VALKEY_REQUESTS_PASSWORD || '')}@${process.env.VALKEY_REQUESTS_HOST}:24348`
    : 'redis://127.0.0.1:6379');
export const valkey = new Redis(uri, {
  maxRetriesPerRequest: 3, connectTimeout: 10000, commandTimeout: 10000,
  retryStrategy: times => Math.min(times * 100, 3000),
  tls: uri.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
});
valkey.on('error', err => console.warn('[Valkey]', err.message));
export interface TaskJob {
  id: string;
  type: 'generate' | 'edit' | 'clone' | 'separate';
  payload: Record<string, unknown>;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  progress: number;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
const statuses = new Set(['queued', 'processing', 'ready', 'failed']);
const types = new Set(['generate', 'edit', 'clone', 'separate']);
const retention = 86400;
const bareId = (id: string) => id.startsWith('job:') ? id.slice(4) : id;
function assertId(id: string) {
  if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error('Invalid job identifier');
}
function parseJob(raw: unknown, id: string): TaskJob | null {
  if (typeof raw !== 'string') return null;
  try {
    const job = JSON.parse(raw);
    if (!job || job.id !== id || !types.has(job.type) || !statuses.has(job.status) ||
      !job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload) ||
      !Number.isFinite(job.progress) || job.progress < 0 || job.progress > 100 ||
      !Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt)) return null;
    return job;
  } catch { return null; }
}
// Scripts are atomic but Redis does not roll back writes after a command error.
const enqueueScript = `-- enqueue_job
local queue_type = redis.call('TYPE', KEYS[2]).ok
if queue_type ~= 'none' and queue_type ~= 'list' then return redis.error_reply('WRONGTYPE queue must be a list') end
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[3], KEYS[2])
redis.call('RPUSH', KEYS[2], ARGV[2])
return ARGV[1]`;
const updateScript = `-- update_job
local pointer_type = redis.call('TYPE', KEYS[2]).ok
if pointer_type ~= 'none' and pointer_type ~= 'string' then return redis.error_reply('WRONGTYPE queue pointer must be a string') end
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local ok, job = pcall(cjson.decode, raw)
if not ok or type(job) ~= 'table' or job.id ~= ARGV[1] or type(job.payload) ~= 'table' then return nil end
local patch = cjson.decode(ARGV[2])
if (job.status == 'ready' or job.status == 'failed') and patch.status and patch.status ~= job.status then
  return redis.error_reply('Terminal job state cannot change')
end
for k, v in pairs(patch) do job[k] = v end
job.updatedAt = tonumber(ARGV[3])
local out = cjson.encode(job)
if job.status == 'ready' or job.status == 'failed' then
  local ttl = redis.call('TTL', KEYS[1])
  redis.call('SET', KEYS[1], out)
  redis.call('EXPIRE', KEYS[1], ttl > 0 and ttl or tonumber(ARGV[4]))
  local queue = redis.call('GET', KEYS[2])
  if queue and redis.call('TYPE', queue).ok == 'list' then redis.call('LREM', queue, 0, ARGV[1]) end
  redis.call('DEL', KEYS[2])
else redis.call('SET', KEYS[1], out) end
return out`;
const cleanupScript = `-- cleanup_job
local queue = redis.call('GET', KEYS[2])
if queue and redis.call('TYPE', queue).ok == 'list' then redis.call('LREM', queue, 0, ARGV[1]) end
redis.call('DEL', KEYS[1], KEYS[2])
return 1`;
export async function enqueueJob(queueName: string, job: Omit<TaskJob, 'status' | 'progress' | 'createdAt' | 'updatedAt'>): Promise<TaskJob> {
  assertId(queueName); assertId(job.id);
  if (!types.has(job.type) || !job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) throw new Error('Invalid job');
  const fullJob = { ...job, status: 'queued', progress: 0, createdAt: Date.now(), updatedAt: Date.now() };
  const raw = await valkey.eval(enqueueScript, 3, `job:${job.id}`, `queue:${queueName}`, `jobqueue:${job.id}`, JSON.stringify(fullJob), job.id);
  const result = parseJob(raw, job.id);
  if (!result) throw new Error('Invalid cached job');
  return result;
}
export async function getJob(jobId: string): Promise<TaskJob | null> {
  const id = bareId(jobId); assertId(id);
  const job = parseJob(await valkey.get(`job:${id}`), id);
  if (!job) await valkey.eval(cleanupScript, 2, `job:${id}`, `jobqueue:${id}`, id);
  return job;
}
export async function updateJobStatus(jobId: string, update: Partial<Pick<TaskJob, 'status' | 'progress' | 'result' | 'error'>>): Promise<TaskJob | null> {
  const id = bareId(jobId); assertId(id);
  if (update.status !== undefined && !statuses.has(update.status)) throw new Error('Invalid job status');
  if (update.progress !== undefined && (!Number.isFinite(update.progress) || update.progress < 0 || update.progress > 100)) throw new Error('Invalid job progress');
  const patch = Object.fromEntries(Object.entries(update).filter(([key, value]) => ['status', 'progress', 'result', 'error'].includes(key) && value !== undefined));
  const raw = await valkey.eval(updateScript, 2, `job:${id}`, `jobqueue:${id}`, id, JSON.stringify(patch), Date.now(), retention);
  return parseJob(raw, id);
}
export async function setTaskContext(taskId: string, context: unknown, options: { terminal?: boolean } = {}): Promise<void> {
  const { bindCreditTask } = await import('../credits/billing.js');
  await bindCreditTask(taskId, context);
  assertId(taskId);
  const raw = JSON.stringify(context);
  if (raw === undefined) throw new Error('Task context is required');
  const key = `rawchunks:context:${taskId}`;
  if (options.terminal) await valkey.set(key, raw, 'EX', retention);
  else await valkey.set(key, raw);
}
export async function getTaskContext<T>(taskId: string): Promise<T | null> {
  assertId(taskId);
  const raw = await valkey.get(`rawchunks:context:${taskId}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; }
  catch { throw new Error('Invalid task context'); }
}
const renewScript = `-- renew_lock
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`;
const releaseScript = `-- release_lock
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
export interface JobLease {
  (): Promise<void>;
  save(taskId: string, context: unknown, options?: { terminal?: boolean }): Promise<void>;
}
const saveContextScript = `-- save_context
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[3] == '1' then redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
else redis.call('SET', KEYS[2], ARGV[2]) end
return 1`;
export async function withJobLock<T>(resource: string, operation: (assertLease: JobLease) => Promise<T>): Promise<T> {
  assertId(resource);
  const key = `rawchunks:lock:${resource}`;
  const token = randomUUID();
  const leaseMs = 120000;
  const deadline = Date.now() + leaseMs;
  while (await valkey.set(key, token, 'PX', leaseMs, 'NX') !== 'OK') {
    if (Date.now() >= deadline) throw new Error('Task is being finalized; retry polling');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  let lost = false;
  let renewing: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!renewing) renewing = valkey.eval(renewScript, 1, key, token, leaseMs)
      .then(result => { if (result !== 1) lost = true; })
      .catch(() => { lost = true; })
      .finally(() => { renewing = undefined; });
  }, leaseMs / 3);
  timer.unref();
  let released = false;
  try {
    const assertLease = Object.assign(async () => {
      if (renewing) await renewing;
      if (lost || await valkey.get(key) !== token) throw new Error('Finalization lease lost');
    }, {
      save: async (taskId: string, context: unknown, options: { terminal?: boolean } = {}) => {
        const { bindCreditTask } = await import('../credits/billing.js');
        await bindCreditTask(taskId, context);
        assertId(taskId);
        const raw = JSON.stringify(context);
        if (raw === undefined) throw new Error('Task context is required');
        if (renewing) await renewing;
        if (lost || await valkey.eval(saveContextScript, 2, key, `rawchunks:context:${taskId}`, token, raw, options.terminal ? '1' : '0', retention) !== 1) throw new Error('Finalization lease lost');
      },
    });
    const result = await operation(assertLease);
    clearInterval(timer);
    if (renewing) await renewing;
    const owned = await valkey.eval(releaseScript, 1, key, token);
    released = true;
    if (lost || owned !== 1) throw new Error('Finalization lease lost');
    return result;
  } finally {
    clearInterval(timer);
    if (renewing) await renewing;
    if (!released) await valkey.eval(releaseScript, 1, key, token);
  }
}

const subscriptions = new Map<string, Set<{ message: (value: string) => void; error: (error: Error) => void }>>();
let subscriber: Redis | undefined;
async function subscribeChannel(channel: string, message: (value: string) => void, error: (error: Error) => void): Promise<() => Promise<void>> {
  if (!subscriber) {
    subscriber = valkey.duplicate();
    subscriber.on('message', (channel, value) => { for (const observer of subscriptions.get(channel) ?? []) observer.message(value); });
    subscriber.on('ready', () => { for (const observers of subscriptions.values()) for (const observer of observers) observer.message('reconnected'); });
    subscriber.on('error', cause => { for (const observers of subscriptions.values()) for (const observer of observers) observer.error(cause); });
  }
  const observers = subscriptions.get(channel) ?? new Set();
  const observer = { message, error };
  observers.add(observer); subscriptions.set(channel, observers);
  const stop = async () => {
    observers.delete(observer);
    if (!observers.size && subscriptions.get(channel) === observers) {
      subscriptions.delete(channel);
      await subscriber?.unsubscribe(channel);
    }
  };
  try { await subscriber.subscribe(channel); }
  catch (cause) { await stop(); throw cause; }
  return stop;
}
export async function subscribeTask(taskId: string, message: (value: string) => void, error: (error: Error) => void): Promise<() => Promise<void>> {
  assertId(taskId);
  return subscribeChannel(`rawchunks:worker:events:${taskId}`, message, error);
}
export async function subscribeVoice(voiceId: string, message: (value: string) => void, error: (error: Error) => void): Promise<() => Promise<void>> {
  assertId(voiceId);
  return subscribeChannel(`rawchunks:voice:events:${voiceId}`, message, error);
}
export async function publishVoice(voiceId: string): Promise<void> {
  assertId(voiceId);
  await valkey.publish(`rawchunks:voice:events:${voiceId}`, JSON.stringify({ voice_id: voiceId }));
}
export async function closeSubscriptions(): Promise<void> {
  for (const observers of subscriptions.values()) for (const observer of observers) observer.error(new Error('Server is shutting down'));
  subscriptions.clear();
  await subscriber?.quit(); subscriber = undefined;
}
