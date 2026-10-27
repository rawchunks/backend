import { createHash, randomUUID } from 'node:crypto';
import { getTaskContext, setTaskContext, withJobLock } from '../broker/valkey.js';
import { generateSchema } from './schema.js';
import { client, refinementShift, type Release, type AudioMeta } from './client.js';
import { createSong, finalizeSong, getSongById, countUntitledSongsByCreator } from '../databases/songs.js';
import { addSongToAlbum } from '../databases/albums.js';
import { resolveVoice } from '../voice/service.js';
import { persistAudioToR2 } from '../storage/r2.js';
import { alignVocalStemLyrics, transcribeVocalStemOnce } from '../editing/scribe.js';

export interface Generate {
  creatorAddress: string;
  title?: string;
  image?: string;
  albumId?: string;
  prompt?: string;
  lyrics?: string;
  instrumental?: boolean;
  vocalLanguage?: string;
  modelVariant?: 'turbo' | 'sft';
  bpm?: number;
  keyScale?: string;
  audioDuration?: number;
  seed?: number;
  voiceId?: string;
  voiceMode?: 'reference' | 'trained';
  voiceReferenceUrl?: string;
  voiceCoverStrength?: number;
  tags?: string[];
  licenses?: number;
  stream_price?: number;
  license_price?: number;
}

interface Context {
  kind: 'generate';
  dispatch?: Release;
  dispatched?: boolean;
  workerTaskId?: string;
  songId: string;
  prompt: string;
  lyrics: string;
  model: string;
  creator: string;
  submitted?: Generate;
  urls?: string[];
  durations?: Array<number | undefined>;
  metas?: AudioMeta[];
  audioUrls?: string[];
  voice?: Record<string, unknown>;
  result?: any;
}

function failure(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}

function duration(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === '' || (typeof value === 'string' && Number.isNaN(Number(value)))) return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value)) || Number(value) <= 0) throw failure('Invalid worker output duration', 502);
  return Math.max(1, Math.round(Number(value)));
}

async function guarded<T>(assertLease: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  await assertLease();
  return operation();
}

export class Service {
  async initiateGeneration(params: Generate) {
    if (params.modelVariant && !['turbo', 'sft'].includes(params.modelVariant)) throw failure(`Invalid modelVariant '${params.modelVariant}'`);
    generateSchema.parse(params);
    const sft = params.modelVariant === 'sft';
    const model = sft ? 'acestep-v15-xl-sft' : 'acestep-v15-xl-turbo';
    const steps = sft ? 50 : 8;
    const promptText = params.prompt?.trim() || '';
    const lyrics = params.instrumental ? '[Instrumental]' : params.lyrics?.trim() ? params.lyrics : '';
    const sampleMode = !params.instrumental && !lyrics;
    const payload: Release = {
      model, task: 'text2music', task_type: 'text2music', prompt: promptText, lyrics,
      instrumental: !!params.instrumental, sample_mode: sampleMode, sample_query: sampleMode ? promptText : undefined,
      vocal_language: params.vocalLanguage, bpm: params.bpm, key_scale: params.keyScale, seed: params.seed,
      use_format: false, use_cot_caption: false, use_cot_language: false, use_random_seed: params.seed === undefined,
      batch_size: 1, inference_steps: steps, guidance_scale: sft ? 7.0 : 1.0, shift: refinementShift(model), audio_format: 'wav',
      ...(params.audioDuration === undefined ? {} : { audio_duration: params.audioDuration }),
    };
    let voiceProvenance: Record<string, unknown> | undefined;
    if (params.voiceId) {
      if (!params.voiceMode) throw failure('Choose reference audio or a prepared saved voice');
      const strength = params.voiceCoverStrength ?? 0.7;
      const voice = await resolveVoice(params.voiceId, model, params.voiceMode, strength, params.creatorAddress);
      if (params.voiceMode === 'trained') {
        payload.lora_manifest_url = voice.artifactUrl;
        payload.lora_manifest_digest = voice.artifactDigest;
        payload.lora_alpha = strength;
      } else {
        payload.reference_audio_path = voice.sampleUrl;
        payload.audio_cover_strength = strength;
      }
      voiceProvenance = voice.provenance;
    } else if (params.voiceReferenceUrl) {
      payload.reference_audio_path = params.voiceReferenceUrl;
      payload.audio_cover_strength = params.voiceCoverStrength ?? 0.65;
    }
    const songId = `sng-${randomUUID()}`;
    const creator = params.creatorAddress.startsWith('0x') ? params.creatorAddress.toLowerCase() : params.creatorAddress;
    const ctx: Context = { kind: 'generate', songId, prompt: promptText, lyrics, model, creator, submitted: params, voice: voiceProvenance };
    let songTitle = params.title?.trim();
    if (!songTitle) {
      const untitledCount = await countUntitledSongsByCreator(creator);
      songTitle = `Untitled #${untitledCount + 1}`;
    }
    const song = await createSong({
      id: songId, title: songTitle,
      version: 1, source: null, creator, url: '', licenses: params.licenses ?? 0, stream_price: params.stream_price ?? 0.02, license_price: params.license_price ?? 25,
      duration: params.audioDuration, tags: params.tags || [],
      image: params.image || '',
      album_id: params.albumId || null,
    });
    if (params.albumId) {
      await addSongToAlbum(params.albumId, songId);
    }
    const taskId = `gen-${randomUUID()}`;
    ctx.dispatch = payload;
    await setTaskContext(taskId, ctx);
    const response = await client.releaseTask(payload, { idempotencyKey: taskId });
    if (typeof response.task_id !== 'string' || !response.task_id.trim() || !['pending', 'processing', 'ready'].includes(response.status)) throw failure('Invalid worker task release response', 502);
    if (response.task_id === taskId) {
      ctx.dispatched = true;
      await setTaskContext(taskId, ctx);
    } else {
      await withJobLock(`task:${response.task_id}`, async (assertLease) => {
        const existing = await getTaskContext<Context>(response.task_id);
        if (existing && response.task_id !== taskId) throw failure('Worker returned an already bound task identifier', 502);
        ctx.dispatched = true;
        await assertLease.save(response.task_id, ctx);
      });
      await setTaskContext(taskId, { ...ctx, workerTaskId: response.task_id }, { terminal: true });
    }
    return { songId: song.id, taskId: response.task_id, status: response.status, model, steps, lyrics: lyrics || undefined };
  }

  async checkStatusAndFinalize(taskId: string, songId: string): Promise<any> {
    const initial = await getTaskContext<Context>(taskId);
    if (!initial || initial.kind !== 'generate') throw failure('Unknown generation task', 404);
    if (initial.workerTaskId) return this.checkStatusAndFinalize(initial.workerTaskId, songId);
    if (initial.songId !== songId) throw failure('Task does not belong to the supplied song', 409);
    if (initial.result) return initial.result;
    return withJobLock(`song:${songId}`, async (assertLease) => {
      const ctx = await getTaskContext<Context>(taskId);
      if (!ctx || ctx.kind !== 'generate' || ctx.songId !== songId) throw failure('Unknown generation task', 404);
      if (ctx.result) return ctx.result;
      const parent = await getSongById(songId);
      if (!parent) throw failure(`Song ${songId} not found`, 404);
      const save = () => assertLease.save(taskId, ctx);
      if (!ctx.urls) {
        const task = (await client.queryResult([taskId])).results[taskId];
        if (!task) return { status: 'pending', progress: 0 };
        if (task.status !== 'ready') {
          const result = { status: task.status, progress: task.progress ?? 0, error: task.error };
          if (task.status === 'error') { ctx.result = result; await assertLease.save(taskId, ctx, { terminal: true }); }
          return result;
        }
        if (!Array.isArray(task.audio_urls) || !task.audio_urls.length || task.audio_urls.some((url) => typeof url !== 'string' || !url)) {
          ctx.result = { status: 'error', progress: 0, error: 'Worker completed without valid audio output' };
          await assertLease.save(taskId, ctx, { terminal: true });
          return ctx.result;
        }
        const fallback = typeof parent.duration === 'number' && Number.isFinite(parent.duration) && parent.duration > 0 ? parent.duration : undefined;
        const primary = duration(task.metas?.[0]?.duration, fallback);
        ctx.urls = task.audio_urls;
        ctx.durations = task.audio_urls.map((_, index) => duration(task.metas?.[index]?.duration, primary));
        ctx.metas = task.metas;
        await save();
      }
      const urls = ctx.urls;
      const audioUrls = ctx.audioUrls ??= [];
      const identity = createHash('sha256').update(`${songId}:${taskId}`).digest('hex');
      for (let index = 0; index < urls.length; index++) {
        if (!audioUrls[index]) {
          audioUrls[index] = await guarded(assertLease, () => persistAudioToR2('songs', `generated/${identity}/${index + 1}.wav`, urls[index]));
          await save();
        }
      }
      const master = { id: `stm-master-${identity}`, song_id: songId, name: 'master', url: audioUrls[0], waveform_peaks_url: null, volume: 1, pan: 0, is_muted: false, is_solo: false };
      const outputs = audioUrls.map((url, index) => ({
        id: index === 0 ? songId : `${songId}-var${index + 1}`,
        title: index === 0 ? parent.title : `${parent.title} (Var ${index + 1})`,
        version: 1, source: index === 0 ? parent.source : songId, creator: parent.creator, url,
        licenses: index === 0 ? parent.licenses : 0, stream_price: parent.stream_price, license_price: index === 0 ? parent.license_price : 0,
        duration: ctx.durations?.[index], tags: index === 0 ? parent.tags : [...parent.tags, 'ALT MIX'],
        image: parent.image, album_id: parent.album_id,
      }));
      const versions = audioUrls.map((url, index) => ({
        id: `take-${identity}-${index + 1}`, song_id: songId, stem_id: master.id, take_number: index + 1,
        model: ctx.model, task: 'text2music', prompt: ctx.prompt || null, lyrics: ctx.lyrics || ctx.metas?.[index]?.lyrics || null,
        repainting_start: null, repainting_end: null, url, waveform_url: null, is_active: index === 0, seed: ctx.submitted?.seed ?? ctx.metas?.[index]?.seed ?? null,
        provenance: { taskId, sourceUrl: url, sourceTakeId: null, sourceDuration: ctx.durations?.[index] ?? null, target: 'master' as const, targetStemId: master.id, region: null, outputDuration: ctx.durations?.[index] ?? null, parameters: { submitted: ctx.submitted ?? ctx.dispatch ?? {}, resolved: ctx.metas?.[index] ?? {}, ...(ctx.voice ? { voice: ctx.voice } : {}) } },
      }));
      await guarded(assertLease, () => finalizeSong(songId, outputs, master, versions));
      const isInstrumental = Boolean(ctx.submitted?.instrumental ?? ctx.dispatch?.instrumental);
      const primaryLyrics = (ctx.lyrics || ctx.metas?.[0]?.lyrics || '').trim();
      const vocalLanguage = ctx.submitted?.vocalLanguage || ctx.dispatch?.vocal_language || 'en';
      if (!isInstrumental && audioUrls[0]) {
        if (primaryLyrics && primaryLyrics.toLowerCase() !== '[instrumental]') {
          void alignVocalStemLyrics(songId, primaryLyrics, audioUrls[0], {
            languageCode: vocalLanguage,
            force: true,
          });
        } else {
          void transcribeVocalStemOnce(songId, audioUrls[0], {
            languageCode: vocalLanguage,
            force: true,
          });
        }
      }
      ctx.result = {
        status: 'ready', progress: 100, primaryUrl: audioUrls[0], audioUrls: ctx.audioUrls, songAId: songId,
        ...(urls.length > 1 ? { songBId: `${songId}-var2` } : {}), duration: ctx.durations?.[0], durations: ctx.durations, metas: ctx.metas,
      };
      await assertLease.save(taskId, ctx, { terminal: true });
      return ctx.result;
    });
  }
}

export const service = new Service();
export const generationService = service;
export type GenerateParams = Generate;
export type GenerationService = Service;
