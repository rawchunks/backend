import * as storage from '../storage/r2.js';
import * as store from '../databases/voices.js';
import type { Voice, VoiceAdapter, NewVoice } from '../databases/schema/voices.js';
import { getSongById } from '../databases/songs.js';
import { listTakesBySong } from '../databases/takes.js';
import { listCommitsBySong } from '../databases/commits.js';
import { sourceSettings } from '../editing/service.js';
import { client } from '../generation/client.js';
import { withJobLock, publishVoice } from '../broker/valkey.js';
import { createHash, randomUUID } from 'node:crypto';
import { validateVoiceFormat, validateVoiceCreator, VoiceInputError } from './format.js';
import { RequestError } from '../databases/users.js';

export const VOICE_MODELS = { turbo: 'acestep-v15-xl-turbo', sft: 'acestep-v15-xl-sft' } as const;
export type VoiceMode = 'reference' | 'trained';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const trainingGroup = (_creator: string, digest: string) => `vg-${digest}`;
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function trainingMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const keys = ['caption', 'lyrics', 'raw_lyrics', 'bpm', 'keyscale', 'language', 'timesignature', 'is_instrumental'];
  return Object.fromEntries(keys.filter(key => metadata[key] !== undefined && metadata[key] !== null).map(key => [key, metadata[key]]));
}
class ArtifactError extends Error {}

export interface TrainingModel { model: string; checkpoint_fingerprint: string; training_config: Record<string, unknown>; }
export interface TrainingItem {
  task_id: string; status: string; stage?: string; step?: number; total_steps?: number; loss?: number; error?: string;
  artifact?: { files: Array<{ filename: string; digest: string; content_type?: string }>; manifest: string; digest: string; checkpoint_fingerprint: string; metrics?: Record<string, unknown> };
}
interface TrainingWorker {
  trainingOptions(): Promise<{ models: TrainingModel[] }>;
  train(payload: { model: string; source_audio_url: string; sample_metadata: Record<string, unknown>; training_config: Record<string, unknown>; checkpoint_fingerprint: string }, options: { idempotencyKey: string }): Promise<{ task_id: string; status?: string }>;
  queryTraining(taskIds: string[]): Promise<{ results: Record<string, TrainingItem> }>;
  trainingArtifact(taskId: string, filename: string): Promise<Buffer>;
  separate: typeof client.separate;
  queryResult: typeof client.queryResult;
}
interface VoiceDependencies {
  store: typeof store;
  worker: TrainingWorker;
  upload: typeof storage.uploadToR2;
  read: typeof storage.readAudio;
  remove: typeof storage.deleteFromR2;
  getSong: typeof getSongById;
  lock: typeof withJobLock;
  publish: typeof publishVoice;
  preparationEnabled: () => boolean;
  songMetadata: (song: { id: string; url: string }) => Promise<Record<string, unknown>>;
}
export interface CloneFromSongParams { songId: string; name?: string; creator: string; }
export interface CloneFromAudioParams { audioBuffer: Buffer; fileName: string; mimeType: string; name?: string; creator: string; }
export interface ResolvedVoice {
  voiceId: string; canonicalId: string; trainingGroup: string; mode: VoiceMode; sampleUrl?: string;
  artifactUrl?: string; artifactDigest?: string; checkpointFingerprint?: string; adapterId?: string; provenance: Record<string, unknown>;
}

export class VoiceService {
  private readonly d: VoiceDependencies;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = true;
  private readonly queue = new Map<string, Promise<unknown>>();
  constructor(dependencies: Partial<VoiceDependencies> = {}) {
    this.d = { store, worker: client as unknown as TrainingWorker, upload: (...args) => storage.uploadToR2(...args), read: (...args) => storage.readAudio(...args), remove: (...args) => storage.deleteFromR2(...args), getSong: getSongById, lock: (resource, operation) => withJobLock(resource, operation), publish: id => publishVoice(id), preparationEnabled: () => process.env.VOICE_PREPARATION_ENABLED === 'true', songMetadata: async song => {
      const storedSong = await getSongById(song.id);
      const sourceIds = [song.id, ...(storedSong?.source && storedSong.source !== song.id ? [storedSong.source] : [])];
      const takeSets = await Promise.all(sourceIds.map(id => listTakesBySong(id)));
      const commitSets = await Promise.all(sourceIds.map(id => listCommitsBySong(id)));
      const takes = takeSets.flat(); const commits = commitSets.flat();
      const snapshots = commits.flatMap(commit => object(commit.timeline_snapshot) && Array.isArray(commit.timeline_snapshot.takes) ? commit.timeline_snapshot.takes : []);
      const matching = [...snapshots, ...takes].filter(take => take.url === song.url);
      const unique = [...new Map(matching.map(take => [take.id, take])).values()];
      const active = unique.filter(take => take.is_active);
      if (active.length > 1 || (!active.length && unique.length > 1)) throw new VoiceInputError('Saved song audio has ambiguous take metadata');
      const source = active[0] ?? unique[0];
      const settings = sourceSettings(source, takes, commits);
      const parameters = object(source?.provenance?.parameters) ? source.provenance.parameters : {};
      const submitted = object(parameters.submitted) ? parameters.submitted : parameters;
      const resolved = object(parameters.resolved) ? parameters.resolved : {};
      const timeSignature = submitted.timeSignature ?? resolved.timesignature ?? resolved.time_signature;
      const instrumental = submitted.instrumental ?? resolved.is_instrumental;
      return { ...(text(timeSignature) ? { timesignature: timeSignature } : {}), ...(typeof instrumental === 'boolean' ? { is_instrumental: instrumental } : {}), ...(source ? { source_take_id: source.id } : {}), ...(text(source?.prompt) ? { caption: source.prompt } : {}), ...(typeof settings.lyrics === 'string' ? { lyrics: settings.lyrics, raw_lyrics: settings.lyrics } : {}), ...(Number.isFinite(settings.bpm) ? { bpm: settings.bpm } : {}), ...(text(settings.keyScale) ? { keyscale: settings.keyScale } : {}), ...(text(settings.vocalLanguage) ? { language: settings.vocalLanguage } : {}) };
    }, ...dependencies };
  }
  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queue.get(key) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(operation); this.queue.set(key, result);
    try { return await result; } finally { if (this.queue.get(key) === result) this.queue.delete(key); }
  }
  private async emit(id: string) { await this.d.publish(id).catch(() => {}); }
  private async register(data: NewVoice, key?: string): Promise<Voice> {
    try { return await this.d.store.createVoiceDeduplicated(data); }
    catch (error) {
      try { if (key && !await this.d.store.getVoiceById(data.id) && (!data.hash || !await this.d.store.findVoiceByHash(data.creator, data.hash))) await this.d.remove('versions', key); } catch { /* A lost registration response must not destroy committed audio. */ }
      throw error;
    }
  }
  async cloneVoiceFromAudio(params: CloneFromAudioParams) {
    const creator = validateVoiceCreator(params.creator);
    if (params.name !== undefined && typeof params.name !== 'string') throw new VoiceInputError('name must be a string');
    const extension = validateVoiceFormat(params.audioBuffer, params.fileName, params.mimeType);
    const sampleHash = hash(params.audioBuffer); const group = trainingGroup(creator, sampleHash);
    const voice = await this.serial(group, () => this.d.lock(group, async lease => {
      const existing = await this.d.store.findVoiceByHash(creator, sampleHash);
      if (existing) {
        if (!Object.keys(trainingMetadata(existing.metadata)).length) return existing;
        const id = `voi-${hash(`${creator}:${sampleHash}:upload`)}`;
        await lease();
        return this.register({ id, creator, name: params.name || params.fileName.replace(/\.[^/.]+$/, ''), sample_url: existing.sample_url, hash: sampleHash, canonical_id: existing.id, training_group: existing.training_group, status: 'saved', metadata: { source: 'upload', filename: params.fileName, mime_type: params.mimeType, byte_length: params.audioBuffer.length }, error: null });
      }
      const id = `voi-${randomUUID()}`; const key = `uploads/${id}.${extension}`;
      const sampleUrl = await this.d.upload('versions', key, params.audioBuffer, params.mimeType);
      await lease();
      return this.register({ id, creator, name: params.name || params.fileName.replace(/\.[^/.]+$/, ''), sample_url: sampleUrl, hash: sampleHash, training_group: group, status: 'saved', metadata: { source: 'upload', filename: params.fileName, mime_type: params.mimeType, byte_length: params.audioBuffer.length }, error: null }, key);
    }));
    await this.emit(voice.id); return { success: true, voice: await this.serialize(voice) };
  }
  async cloneVoiceFromSong(params: CloneFromSongParams) {
    const creator = validateVoiceCreator(params.creator);
    if (!text(params.songId)) throw new VoiceInputError('songId is required');
    if (params.name !== undefined && typeof params.name !== 'string') throw new VoiceInputError('name must be a string');
    const song = await this.d.getSong(params.songId);
    if (!song || !text(song.url)) throw new Error(`Song ${params.songId} not found or has no audio.`);
    if (validateVoiceCreator(song.creator) !== creator) throw new RequestError('Account does not own this song', 403);
    const identity = hash(`${creator}:${song.id}:${song.url}`);
    const voice = await this.serial(identity, () => this.d.lock(`voice-source:${identity}`, async lease => {
      const existing = await this.d.store.findVoiceBySource(creator, song.id, song.url); if (existing) return existing;
      const id = `voi-${identity}`;
      const metadata = await this.d.songMetadata(song);
      await lease();
      return this.d.store.createVoiceFromSource({ id, creator, name: params.name || `${song.title} Voice`, sample_url: null, source_song_id: song.id, hash: null, canonical_id: null, training_group: `vg-${id}`, task_id: `voice-extract-${identity}`, status: 'extracting', error: null, metadata: { ...metadata, source: 'song', source_url: song.url, source_song_id: song.id } });
    }));
    await this.emit(voice.id); return { success: true, voice: await this.serialize(voice) };
  }
  private selectedAdapters(voice: Voice, adapters: VoiceAdapter[]): VoiceAdapter[] {
    const selection = object(voice.metadata.adapter_ids) ? voice.metadata.adapter_ids : {};
    const input = stable(trainingMetadata(voice.metadata));
    return Object.values(VOICE_MODELS).flatMap(model => {
      const adapter = adapters.find(a => a.model === model && stable(a.settings.sample_metadata ?? {}) === input && (!text(selection[model]) || a.id === selection[model]));
      return adapter ? [adapter] : [];
    });
  }
  private availability(adapter: VoiceAdapter | undefined, model: string) {
    const ready = adapter?.status === 'ready' && text(adapter.artifact_url) && digest(adapter.artifact_digest);
    const status = adapter ? (adapter.status === 'ready' && !ready ? 'error' : adapter.status) : 'unavailable';
    return { model, status, ...(adapter ? { adapter } : {}), ...(adapter?.metrics ?? {}), ...(adapter?.error ? { error: adapter.error } : {}) };
  }
  private async withCanonicalSample(voice: Voice): Promise<Voice> {
    const canonical = voice.canonical_id ? await this.d.store.getCanonicalVoice(voice.id) : voice;
    if (!canonical || canonical.creator !== voice.creator) throw new ArtifactError('Invalid voice canonical ownership');
    return { ...voice, sample_url: canonical.sample_url, hash: canonical.hash, training_group: canonical.training_group, canonical_id: voice.id === canonical.id ? null : canonical.id };
  }
  private async serialize(original: Voice) {
    const voice = await this.withCanonicalSample(original);
    const adapters = this.selectedAdapters(voice, await this.d.store.listAdaptersByGroup(voice.training_group));
    const status = voice.status === 'ready' && !Object.values(VOICE_MODELS).every(model => adapters.some(a => a.model === model && a.status === 'ready' && text(a.artifact_url) && digest(a.artifact_digest))) ? (adapters.length ? 'error' : 'saved') : voice.status;
    return { ...voice, status, availability: Object.fromEntries(Object.entries(VOICE_MODELS).map(([kind, model]) => [kind, this.availability(adapters.find(a => a.model === model), model)])) };
  }
  async listVoices(creator: string) {
    const voices = await Promise.all((await this.d.store.listVoicesByCreator(validateVoiceCreator(creator))).map(v => this.serialize(v)));
    const variants = new Map<string, typeof voices[number]>();
    for (const voice of voices) {
      const key = stable([voice.canonical_id ?? voice.id, trainingMetadata(voice.metadata)]);
      const existing = variants.get(key);
      const created = voice.created_at?.toISOString() ?? '';
      const prior = existing?.created_at?.toISOString() ?? '';
      if (!existing || !voice.canonical_id || (existing.canonical_id && (created < prior || (created === prior && voice.id < existing.id)))) variants.set(key, voice);
    }
    return [...variants.values()];
  }
  async getVoice(id: string) { const voice = await this.d.store.getVoiceById(id); return voice ? this.serialize(voice) : null; }
  async resolveVoice(id: string, model: string, mode: VoiceMode, strength: number, creator?: string): Promise<ResolvedVoice> {
    if (!Object.values(VOICE_MODELS).includes(model as any)) throw new VoiceInputError('Unsupported voice model');
    if (mode !== 'reference' && mode !== 'trained') throw new VoiceInputError('voiceMode must be reference or trained');
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new VoiceInputError('Voice strength must be between zero and one');
    const original = await this.d.store.getVoiceById(id); const voice = await this.d.store.getCanonicalVoice(id);
    if (!original || !voice || original.creator !== voice.creator) throw new RequestError('Voice not found', 404);
    if (creator !== undefined && validateVoiceCreator(creator) !== voice.creator) throw new RequestError('Account does not own this voice', 403);
    const base = { voiceId: id, canonicalId: voice.id, trainingGroup: voice.training_group, mode, provenance: { voice_id: id, canonical_voice_id: voice.id, training_group: voice.training_group, sample_hash: voice.hash, voice_mode: mode, voice_strength: strength } };
    if (mode === 'reference') {
      if (!text(voice.sample_url)) throw new RequestError('Voice reference is not ready', 409);
      return { ...base, sampleUrl: voice.sample_url };
    }
    const adapter = this.selectedAdapters(original, await this.d.store.listAdaptersByGroup(voice.training_group)).find(a => a.model === model && a.status === 'ready' && text(a.artifact_url) && digest(a.artifact_digest));
    if (!adapter) throw new RequestError(`Trained voice for ${model} is not ready`, 409);
    return { ...base, artifactUrl: adapter.artifact_url!, artifactDigest: adapter.artifact_digest!, checkpointFingerprint: adapter.checkpoint_fingerprint, adapterId: adapter.id, provenance: { ...base.provenance, adapter_id: adapter.id, model, checkpoint_fingerprint: adapter.checkpoint_fingerprint, settings_digest: adapter.settings_digest, artifact_url: adapter.artifact_url, artifact_digest: adapter.artifact_digest } };
  }
  private async extract(voice: Voice, lease: () => Promise<void>) {
    if (!voice.task_id || !text(voice.metadata.source_url)) throw new ArtifactError('Extraction receipt has no source or task identifier');
    let result = (await this.d.worker.queryResult([voice.task_id])).results[voice.task_id];
    if (!result || (result.status === 'pending' && !voice.metadata.extraction_dispatched)) {
      const receipt = await this.d.worker.separate({ src_audio_path: voice.metadata.source_url, stem_type: 'vocals' }, { idempotencyKey: voice.task_id });
      if (receipt.task_id !== voice.task_id) throw new ArtifactError('Extraction admission task identifier mismatch');
      await lease(); await this.d.store.updateVoice(voice.id, { metadata: { ...voice.metadata, extraction_dispatched: true }, error: null }); return;
    }
    if (result.status === 'error') throw new ArtifactError(result.error || 'Vocal separation failed');
    if (result.status !== 'ready') return;
    const vocal = result.stems?.vocals;
    if (!text(vocal) || vocal === voice.metadata.source_url) throw new ArtifactError('Vocal separation did not return an isolated vocal');
    const audio = await this.d.read(vocal); const sampleHash = hash(audio.buffer); const group = trainingGroup(voice.creator, sampleHash);
    await this.d.lock(group, async groupLease => {
      const existing = await this.d.store.findVoiceByHash(voice.creator, sampleHash);
      const sampleUrl = existing?.sample_url || await this.d.upload('versions', `vocals/${voice.id}.wav`, audio.buffer, audio.contentType);
      await lease(); await groupLease();
      await this.d.store.consolidateVoiceSample(voice.id, { hash: sampleHash, sample_url: sampleUrl, training_group: group, metadata: { ...voice.metadata, isolated_vocals: true, byte_length: audio.buffer.length } });
    });
  }
  private async prepare(voice: Voice, lease: () => Promise<void>) {
    if (!text(voice.sample_url) || !digest(voice.hash)) throw new ArtifactError('Voice has no hashed sample for training');
    const options = await this.d.worker.trainingOptions();
    const selection: Record<string, string> = {};
    for (const model of Object.values(VOICE_MODELS)) {
      const config = options.models.find(m => m.model === model);
      if (!config || !text(config.checkpoint_fingerprint) || !object(config.training_config)) throw new ArtifactError(`Training options missing ${model}`);
      const recipe = { sample_hash: voice.hash, sample_metadata: trainingMetadata(voice.metadata), training_config: config.training_config };
      const settingsDigest = hash(stable(recipe));
      const settings = { ...recipe, source_audio_url: voice.sample_url };
      const identity = hash(`${voice.training_group}:${model}:${config.checkpoint_fingerprint}:${settingsDigest}`);
      await lease();
      const adapter = await this.d.store.createVoiceAdapter({ id: `va-${identity}`, training_group: voice.training_group, model, checkpoint_fingerprint: config.checkpoint_fingerprint, settings, settings_digest: settingsDigest, task_id: `voice-train-${identity}`, status: 'queued', metrics: {} });
      selection[model] = adapter.id;
    }
    await lease(); await this.d.store.updateVoice(voice.id, { status: 'queued', error: null, metadata: { ...voice.metadata, adapter_ids: selection } });
  }
  private async persistArtifact(adapter: VoiceAdapter, result: TrainingItem, lease: () => Promise<void>) {
    const artifact = result.artifact;
    if (!artifact || artifact.manifest !== 'manifest.json' || !digest(artifact.digest) || artifact.checkpoint_fingerprint !== adapter.checkpoint_fingerprint || !Array.isArray(artifact.files)) throw new ArtifactError('Training result is missing a valid adapter artifact');
    const allowed = ['manifest.json', 'adapter_config.json', 'adapter_model.safetensors'];
    const declarations = new Map(artifact.files.map(file => [file.filename, file]));
    if (declarations.size !== 3 || allowed.some(name => !declarations.has(name)) || artifact.files.some(file => !allowed.includes(file.filename) || !digest(file.digest))) throw new ArtifactError('Adapter artifact has invalid file declarations');
    const bytes = new Map<string, Buffer>();
    for (const file of artifact.files) {
      const body = await this.d.worker.trainingArtifact(adapter.task_id, file.filename);
      if (!Buffer.isBuffer(body) || !body.length || hash(body) !== file.digest) throw new ArtifactError(`Adapter checksum mismatch: ${file.filename}`);
      bytes.set(file.filename, body);
    }
    if (hash(bytes.get('manifest.json')!) !== artifact.digest) throw new ArtifactError('Adapter manifest digest mismatch');
    let manifest: any; try { manifest = JSON.parse(bytes.get('manifest.json')!.toString('utf8')); } catch { throw new ArtifactError('Invalid adapter manifest'); }
    if (manifest.schema_version !== 1 || manifest.model !== adapter.model || manifest.checkpoint_fingerprint !== adapter.checkpoint_fingerprint || manifest.task_id !== adapter.task_id || stable(manifest.training_config) !== stable(adapter.settings.training_config) || !Array.isArray(manifest.files)) throw new ArtifactError('Adapter manifest does not match its training identity');
    for (const filename of ['adapter_config.json', 'adapter_model.safetensors']) {
      const declared = manifest.files.find((f: any) => f.filename === filename);
      if (!declared || declared.digest !== declarations.get(filename)!.digest) throw new ArtifactError('Adapter manifest file digest mismatch');
    }
    const metrics = { ...(artifact.metrics ?? {}), ...(manifest.metrics ?? {}), stage: 'ready' };
    if (!Number.isFinite(metrics.optimizer_steps) || Number(metrics.optimizer_steps) < 1 || !Number.isFinite(metrics.final_loss) || !Number.isFinite(metrics.effective_update_norm) || Number(metrics.effective_update_norm) <= 0) throw new ArtifactError('Training artifact does not prove an optimizer update');
    for (const filename of ['adapter_config.json', 'adapter_model.safetensors']) { await lease(); await this.d.upload('loras', `voices/${adapter.id}/${filename}`, bytes.get(filename)!, declarations.get(filename)!.content_type || (filename.endsWith('.json') ? 'application/json' : 'application/octet-stream')); }
    await lease(); const url = await this.d.upload('loras', `voices/${adapter.id}/manifest.json`, bytes.get('manifest.json')!, 'application/json');
    await lease(); await this.d.store.updateVoiceAdapter(adapter.id, { status: 'ready', artifact_url: url, artifact_digest: artifact.digest, metrics, error: null });
  }
  private async advanceAdapters(voice: Voice, lease: () => Promise<void>) {
    const adapters = this.selectedAdapters(voice, await this.d.store.listAdaptersByGroup(voice.training_group));
    for (const entry of adapters.filter(a => !['ready', 'error'].includes(a.status))) {
      await this.d.lock(`voice-adapter:${entry.id}`, async adapterLease => {
      const adapter = (await this.d.store.listAdaptersByGroup(voice.training_group)).find(a => a.id === entry.id);
      if (!adapter || ['ready', 'error'].includes(adapter.status)) return;
      const assertLease = async () => { await lease(); await adapterLease(); };
      try {
        const result = (await this.d.worker.queryTraining([adapter.task_id])).results[adapter.task_id];
        if (!result || (result.status === 'pending' && !adapter.metrics.dispatched)) {
          if (!this.d.preparationEnabled()) return;
          const config = adapter.settings.training_config; if (!object(config)) throw new ArtifactError('Adapter receipt is missing its training settings');
          const started = await this.d.worker.train({ model: adapter.model, source_audio_url: text(adapter.settings.source_audio_url) ? adapter.settings.source_audio_url : voice.sample_url!, sample_metadata: object(adapter.settings.sample_metadata) ? adapter.settings.sample_metadata : voice.metadata, training_config: config, checkpoint_fingerprint: adapter.checkpoint_fingerprint }, { idempotencyKey: adapter.task_id });
          if (started.task_id !== adapter.task_id) throw new ArtifactError('Training admission task identifier mismatch');
          await assertLease(); await this.d.store.updateVoiceAdapter(adapter.id, { metrics: { ...adapter.metrics, dispatched: true, stage: 'queued' }, error: null });
          return;
        }
        await assertLease();
        if (result.status === 'ready') await this.persistArtifact(adapter, result, assertLease);
        else if (result.status === 'error') await this.d.store.updateVoiceAdapter(adapter.id, { status: 'error', error: result.error || 'Voice training failed', metrics: { ...adapter.metrics, stage: result.stage || 'error' } });
        else await this.d.store.updateVoiceAdapter(adapter.id, { status: result.status === 'processing' ? 'training' : 'queued', error: null, metrics: { ...adapter.metrics, ...(text(result.stage) ? { stage: result.stage } : {}), ...(Number.isFinite(result.step) ? { step: result.step } : {}), ...(Number.isFinite(result.total_steps) ? { total_steps: result.total_steps } : {}), ...(Number.isFinite(result.loss) ? { loss: result.loss } : {}) } });
      } catch (error: any) {
        await assertLease();
        if (error instanceof ArtifactError) await this.d.store.updateVoiceAdapter(adapter.id, { status: 'error', error: error.message });
        else await this.d.store.updateVoiceAdapter(adapter.id, { error: error?.message || 'Training transport unavailable' });
      }
      });
    }
    const current = this.selectedAdapters(voice, await this.d.store.listAdaptersByGroup(voice.training_group));
    const targets = Object.values(VOICE_MODELS).map(model => current.find(a => a.model === model));
    const terminal = targets.every(a => a && ['ready', 'error'].includes(a.status));
    const failed = targets.find(a => a?.status === 'error');
    const status = terminal ? (failed ? 'error' : 'ready') : targets.some(a => a?.status === 'training') ? 'training' : 'queued';
    await lease(); await this.d.store.updateVoice(voice.id, { status, error: failed?.error ?? null });
  }
  /** One bounded pass; durable rows are the queue and every dispatch uses its persisted ID. */
  async reconcile(limit = 20): Promise<void> {
    const pending = await this.d.store.listPendingVoices(limit, this.d.preparationEnabled() ? undefined : ['extracting', 'queued', 'training']);
    for (const entry of pending) {
      await this.d.lock(`voice:${entry.id}`, async lease => {
        const original = await this.d.store.getVoiceById(entry.id); if (!original || ['ready','error'].includes(original.status)) return;
        try {
          const voice = await this.withCanonicalSample(original);
          if (voice.status === 'extracting') await this.extract(voice, lease);
          else if (voice.status === 'saved') { if (this.d.preparationEnabled()) await this.prepare(voice, lease); }
          else await this.advanceAdapters(voice, lease);
        } catch (error: any) {
          await lease(); await this.d.store.updateVoice(original.id, { ...(error instanceof ArtifactError ? { status: 'error' as const } : {}), error: error?.message || 'Voice preparation unavailable' });
        }
        const current = await this.d.store.getVoiceById(original.id);
        if (current) { await lease(); await this.d.store.updateVoice(original.id, { metadata: { ...current.metadata, reconciled_at: new Date().toISOString() } }); }
        await this.emit(original.id);
      }).catch(error => console.warn('[Voice coordinator]', entry.id, error.message));
    }
  }
  /** Explicit inventory backfill; never runs at startup or in ordinary API requests. */
  async reconcileInventory(): Promise<{ scanned: number; consolidated: number; errors: Array<{ id: string; error: string }> }> {
    const inventory = await this.d.store.listVoiceInventory(); let consolidated = 0; const errors: Array<{id:string;error:string}> = [];
    for (const voice of inventory) {
      if (voice.canonical_id || !text(voice.sample_url)) continue;
      try {
        const audio = await this.d.read(voice.sample_url); const sampleHash = hash(audio.buffer); const group = trainingGroup(voice.creator, sampleHash);
        await this.d.lock(group, async lease => { await lease(); await this.d.store.consolidateVoiceSample(voice.id, { hash: sampleHash, sample_url: voice.sample_url, training_group: group, metadata: { ...voice.metadata, byte_length: audio.buffer.length } }); });
        consolidated++; await this.emit(voice.id);
      } catch (error: any) { errors.push({ id: voice.id, error: error.message }); }
    }
    return { scanned: inventory.length, consolidated, errors };
  }
  start(intervalMs = 5000) {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.active = this.reconcile().catch(error => console.warn('[Voice coordinator]', error.message)).finally(() => { this.active = undefined; if (!this.stopped) { this.timer = setTimeout(tick, intervalMs); this.timer.unref(); } });
    };
    tick();
  }
  async stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.active; }
}
export const voiceService = new VoiceService();
export const resolveVoice = (id: string, model: string, mode: VoiceMode, strength: number, creator?: string) => voiceService.resolveVoice(id, model, mode, strength, creator);
