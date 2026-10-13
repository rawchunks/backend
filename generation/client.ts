import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const ACESTEP_API_URL = process.env.ACESTEP_API_URL || '';
const ACESTEP_API_KEY = process.env.ACESTEP_API_KEY || '';

export interface Release {
  model?: 'acestep-v15-turbo' | 'acestep-v15-xl-turbo' | 'acestep-v15-xl-sft' | 'acestep-v15-xl-base' | string;
  task?: 'text2music' | 'repaint' | 'lego' | 'complete' | 'cover' | 'extract';
  task_type?: 'text2music' | 'repaint' | 'lego' | 'complete' | 'cover' | 'extract';
  prompt?: string;
  lyrics?: string;
  instrumental?: boolean;
  sample_mode?: boolean;
  sample_query?: string;
  use_format?: boolean;
  use_cot_caption?: boolean;
  use_cot_language?: boolean;
  use_random_seed?: boolean;
  vocal_language?: string;
  bpm?: number;
  key_scale?: string;
  time_signature?: string;
  audio_duration?: number;
  batch_size?: number;
  inference_steps?: number;
  guidance_scale?: number;
  shift?: number;
  seed?: number;
  src_audio_path?: string;
  repainting_start?: number;
  repainting_end?: number;
  repaint_mode?: 'conservative' | 'balanced' | 'aggressive';
  repaint_strength?: number;
  repaint_latent_crossfade_frames?: number;
  repaint_wav_crossfade_sec?: number;
  reference_audio_path?: string;
  audio_cover_strength?: number;
  cover_noise_strength?: number;
  track_name?: string;
  track_classes?: string[];
  global_caption?: string;
  lora_path?: string;
  lora_alpha?: number;
  lora_manifest_url?: string;
  lora_manifest_digest?: string;
  audio_format?: 'wav';
  chunk_mask_mode?: 'explicit' | 'auto';
}

/** Checkpoint-specific noise schedule, as documented by the ACE-Step 1.5 XL inference API (shift = 3.0 across all XL variants). */
export function refinementShift(model: string): number {
  if (model === 'acestep-v15-xl-turbo' || model === 'acestep-v15-xl-sft' || model === 'acestep-v15-xl-base') return 3.0;
  throw Object.assign(new Error(`No documented refinement schedule for ${model}`), { statusCode: 400 });
}

export interface TrainingOptions {
  role?: string;
  models: Array<{ model: string; checkpoint_fingerprint: string; training_config: Record<string, unknown> }>;
}
export interface TrainingArtifact {
  files: Array<{ filename: string; digest: string; content_type?: string }>;
  manifest: string;
  digest: string;
  checkpoint_fingerprint: string;
  metrics?: Record<string, unknown>;
}
export interface TrainingItem {
  task_id: string;
  status: Item['status'];
  stage?: string;
  step?: number;
  total_steps?: number;
  loss?: number;
  error?: string;
  artifact?: TrainingArtifact;
}

export function cleanAudioPath(rawPath?: string): string | undefined {
  if (typeof rawPath !== 'string' || !rawPath) return undefined;
  let path = rawPath;
  for (let depth = 0; depth < 16; depth++) {
    try {
      const url = new URL(path, 'https://api.rawchunks.space');
      if (!['/v1/audio', '/api/audio'].includes(url.pathname)) break;
      const encoded = url.search.slice(1).split('&').find((part) => part.split('=')[0] === 'path');
      if (!encoded) break;
      const next = decodeURIComponent(encoded.slice(5).replace(/\+/g, ' '));
      if (!next || next === path) break;
      path = next;
    } catch { break; }
  }
  return path.startsWith('/app/ACE-Step-1.5/') ? path.slice('/app/ACE-Step-1.5/'.length) : path;
}

export interface Result {
  task_id: string;
  status: 'pending' | 'processing' | 'ready' | 'error';
  message?: string;
}

export interface AudioMeta {
  prompt?: string;
  lyrics?: string;
  seed?: number;
  language?: string;
  bpm?: number;
  duration?: number;
  genres?: string;
  keyscale?: string;
  timesignature?: string;
}

export interface Item {
  task_id: string;
  status: 'pending' | 'processing' | 'ready' | 'error';
  progress?: number;
  audio_urls?: string[];
  stems?: Record<string, string>;
  metas?: AudioMeta[];
  error?: string;
}

export interface Query {
  results: Record<string, Item>;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function state(value: unknown): Item['status'] {
  if (value === 1 || value === 'succeeded' || value === 'ready') return 'ready';
  if (value === 2 || value === 'failed' || value === 'error') return 'error';
  if (value === 'processing' || value === 'running') return 'processing';
  return 'pending';
}

function transportError(message: string, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function timeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : fallback;
}

export class Client {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private separationTimeoutMs: number;

  constructor(baseUrl = ACESTEP_API_URL, apiKey = ACESTEP_API_KEY, options: { timeoutMs?: number; separationTimeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeout(options.timeoutMs ?? process.env.ACESTEP_TIMEOUT_MS, 30_000);
    this.separationTimeoutMs = timeout(options.separationTimeoutMs ?? process.env.ACESTEP_SEPARATION_TIMEOUT_MS, 600_000);
  }

  private async request(path: string, body?: unknown, timeoutMs = this.timeoutMs, idempotencyKey?: string): Promise<any> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw transportError(`AceStep ${path} failed: ${res.status} - ${await res.text()}`);
      return await res.json();
    } catch (error: any) {
      if (error?.statusCode) throw error;
      throw transportError(`AceStep ${path}: ${error?.message || 'Worker transport failed'}`, error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502);
    }
  }

  private unwrap(json: any): Record<string, any> {
    const data = record(json?.data) ? json.data : json;
    if (!record(data)) throw transportError('Invalid AceStep response envelope');
    return data;
  }

  async health(): Promise<{ status: string; gpu_memory?: string }> {
    return this.request('/health');
  }

  async options(): Promise<Record<string, any>> {
    return this.unwrap(await this.request('/options'));
  }

  async trainingOptions(): Promise<TrainingOptions> {
    const data = this.unwrap(await this.request('/v1/training/options'));
    if (!Array.isArray(data.models) || data.models.some((model: any) => !record(model) || typeof model.model !== 'string' || !/^[a-f0-9]{64}$/.test(model.checkpoint_fingerprint) || !record(model.training_config))) throw transportError('Invalid training checkpoint options');
    return data as unknown as TrainingOptions;
  }

  async train(payload: { model: string; source_audio_url: string; sample_metadata: Record<string, unknown>; training_config: Record<string, unknown>; checkpoint_fingerprint: string }, options: { idempotencyKey?: string } = {}): Promise<Result> {
    const data = this.unwrap(await this.request('/v1/training/start', payload, this.timeoutMs, options.idempotencyKey));
    if (typeof data.task_id !== 'string' || !data.task_id || (options.idempotencyKey && data.task_id !== options.idempotencyKey)) throw transportError('Invalid training admission identity');
    if (state(data.status) === 'error') throw transportError(data.error || 'Training admission failed');
    return { task_id: data.task_id, status: state(data.status) };
  }

  async queryTraining(taskIds: string[]): Promise<{ results: Record<string, TrainingItem> }> {
    const json = await this.request('/v1/training/query_result', { task_id_list: taskIds, task_ids: taskIds });
    const data = json?.data ?? json?.results ?? json;
    const entries = Array.isArray(data) ? data.map(item => [undefined, item]) : record(data) ? Object.entries(data) : [];
    const results: Record<string, TrainingItem> = Object.create(null);
    for (const [key, item] of entries) {
      if (!record(item)) continue;
      const id = item.task_id ?? key;
      if (typeof id !== 'string' || !taskIds.includes(id)) continue;
      // The bundled protocol uses an empty legacy result for an unknown ID.
      if (item.status === 0 && item.result === '[]' && item.stage === undefined) continue;
      const status = state(item.status);
      results[id] = { ...item, task_id: id, status: status === 'pending' && typeof item.stage === 'string' && !['queued', 'pending'].includes(item.stage) ? 'processing' : status } as TrainingItem;
    }
    return { results };
  }

  async trainingArtifact(taskId: string, filename: string): Promise<Buffer> {
    if (!filename || filename !== filename.split('/').pop() || /[\\\x00-\x1f]/.test(filename) || filename === '.' || filename === '..') throw transportError('Invalid training artifact filename', 400);
    const path = `/v1/training/artifact/${encodeURIComponent(taskId)}/${encodeURIComponent(filename)}`;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw transportError(`AceStep artifact read failed: ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error: any) {
      if (error?.statusCode) throw error;
      throw transportError(`AceStep artifact read: ${error?.message || 'Transport failed'}`);
    }
  }

  async releaseTask(payload: Release, options: { idempotencyKey?: string } = {}): Promise<Result> {
    if (!payload.model) throw Object.assign(new Error('Model specification is required for AceStep task release'), { statusCode: 400 });
    const taskType = payload.task_type || payload.task || 'text2music';
    const body = { ...payload, task: taskType, task_type: taskType };
    if (body.src_audio_path) body.src_audio_path = cleanAudioPath(body.src_audio_path);
    if (body.reference_audio_path) body.reference_audio_path = cleanAudioPath(body.reference_audio_path);
    const json = await this.request('/release_task', body, this.timeoutMs, options.idempotencyKey);
    const data = this.unwrap(json);
    const id = data.task_id ?? data.id;
    if (typeof id !== 'string' || !id.trim()) throw transportError('AceStep release response is missing a task identifier');
    if (options.idempotencyKey !== undefined && id !== options.idempotencyKey) throw transportError('AceStep release task identifier does not match the admission key');
    if (state(data.status) === 'error') throw transportError(data.error || data.message || json.error || 'AceStep rejected task');
    return { task_id: id, status: state(data.status), message: data.message ?? json.error };
  }

  async separate(payload: { src_audio_path: string; stem_type?: string }, options: { idempotencyKey?: string } = {}): Promise<{
    task_id: string;
    status: string;
    stems: { vocals?: string; drums?: string; bass?: string; other?: string; instrumental?: string };
    audio_paths?: string[];
  }> {
    const data = this.unwrap(await this.request('/separate', { ...payload, src_audio_path: cleanAudioPath(payload.src_audio_path), wait: false }, this.timeoutMs, options.idempotencyKey));
    const id = data.task_id ?? data.id;
    if (options.idempotencyKey !== undefined && id !== options.idempotencyKey) throw transportError('AceStep separation task identifier does not match the admission key');
    return { ...data, task_id: id, status: state(data.status), stems: record(data.stems) ? data.stems : {} } as any;
  }

  async queryResult(taskIds: string[]): Promise<Query> {
    const json = await this.request('/query_result', { task_id_list: taskIds, task_ids: taskIds });
    const data = json?.data ?? json?.results ?? json;
    const results: Record<string, Item> = Object.create(null);
    const entries = Array.isArray(data) ? data.map((item) => [undefined, item]) : record(data) ? Object.entries(data) : [];
    for (const [key, item] of entries) {
      if (!record(item)) continue;
      const id = item.task_id ?? item.id ?? key;
      if (typeof id !== 'string' || !id) continue;
      let status = state(item.status);
      let parsed: unknown = item.result;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { parsed = []; }
      }
      const audioUrls: string[] = [];
      const metas: AudioMeta[] = Array.isArray(item.metas) ? item.metas.filter(record) : [];
      const addAudio = (raw: unknown) => {
        if (typeof raw !== 'string' || !raw) return;
        const path = cleanAudioPath(raw);
        if (path) audioUrls.push(/^https?:\/\//i.test(path) ? path : `/api/audio?path=${encodeURIComponent(path)}`);
      };
      if (Array.isArray(item.audio_urls)) item.audio_urls.forEach(addAudio);
      if (Array.isArray(item.audio_paths)) item.audio_paths.forEach(addAudio);
      let error = typeof item.error === 'string' ? item.error : undefined;
      let progress = typeof item.progress === 'number' && Number.isFinite(item.progress) ? item.progress : undefined;
      for (const part of Array.isArray(parsed) ? parsed : []) {
        if (!record(part)) continue;
        addAudio(part.file);
        if (record(part.metas)) metas.push({ ...part.metas, ...(typeof part.prompt === 'string' && !part.metas.prompt ? { prompt: part.prompt } : {}), ...(typeof part.lyrics === 'string' && !part.metas.lyrics ? { lyrics: part.lyrics } : {}) });
        if (!error && typeof part.error === 'string') error = part.error;
        if (typeof part.progress === 'number' && Number.isFinite(part.progress)) progress = Math.round(part.progress * 100);
        if (status === 'pending' && part.stage && part.stage !== 'queued') status = 'processing';
      }
      results[id] = {
        task_id: id, status,
        ...(record(item.stems) ? { stems: Object.fromEntries(Object.entries(item.stems).filter((entry) => typeof entry[1] === 'string' && !!entry[1])) } : {}),
        ...(progress === undefined && status !== 'ready' ? {} : { progress: Math.min(100, Math.max(0, progress ?? 100)) }),
        audio_urls: audioUrls.length ? audioUrls : undefined,
        metas: metas.length ? metas : undefined,
        error,
      };
    }
    return { results };
  }

  async formatInput(caption: string, lyrics?: string): Promise<{ formatted_caption: string; formatted_lyrics: string }> {
    const data = this.unwrap(await this.request('/format_input', { prompt: caption, lyrics }));
    return { formatted_caption: data.formatted_caption ?? data.caption ?? caption, formatted_lyrics: data.formatted_lyrics ?? data.lyrics ?? lyrics ?? '' };
  }

  async createRandomSample(query: string): Promise<{ caption: string; lyrics: string; bpm: number; key_scale: string; audio_duration: number }> {
    const data = this.unwrap(await this.request('/create_random_sample', { query }));
    return { caption: data.caption ?? '', lyrics: data.lyrics ?? '', bpm: data.bpm, key_scale: data.key_scale, audio_duration: data.audio_duration };
  }

  async createSample(query: string, instrumental = false, vocalLanguage?: string): Promise<{ caption: string; lyrics: string; bpm?: number; key_scale?: string; duration?: number }> {
    const data = this.unwrap(await this.request('/v1/create_sample', { query, instrumental, ...(vocalLanguage ? { vocal_language: vocalLanguage } : {}) }));
    return { caption: data.caption ?? '', lyrics: data.lyrics ?? '', bpm: data.bpm, key_scale: data.keyscale ?? data.key_scale, duration: data.duration };
  }
}

export const client = new Client();
export type ReleaseTaskPayload = Release;
export type ReleaseTaskResponse = Result;
export type QueryResultItem = Item;
export type QueryResultResponse = Query;
export const acestepClient = client;
