import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getTaskContext, setTaskContext, withJobLock } from '../broker/valkey.js';
import { client, refinementShift, type Release } from '../generation/client.js';
import { getSongById } from '../databases/songs.js';
import { createTake, activateTake, listTakesBySong, getTakeById, deleteTake } from '../databases/takes.js';
import type { TakeProvenance } from '../databases/schema/takes.js';
import { createStem, updateStemMixer, listStemsBySong } from '../databases/stems.js';
import { createCommit, listCommitsBySong } from '../databases/commits.js';
import { persistAudioToR2, readAudio, uploadToR2 } from '../storage/r2.js';
import { composeEdit, decodeWave, readWave, sliceWave, padWave } from './audio.js';

export interface Edit {
  songId: string;
  stemId?: string;
  userAddress: string;
  task: 'repaint' | 'lego' | 'complete' | 'extend' | 'cover' | 'extract';
  prompt?: string;
  lyrics?: string;
  seed?: number;
  bpm?: number;
  keyScale?: string;
  vocalLanguage?: string;
  repaintingStart?: number;
  repaintingEnd?: number;
  repaintMode?: 'conservative' | 'balanced' | 'aggressive';
  repaintStrength?: number;
  repaintLatentCrossfadeFrames?: number;
  repaintWavCrossfadeSec?: number;
  globalCaption?: string;
  trackName?: string;
  trackClasses?: string[];
  legoContextTrackIds?: string[];
  audioDuration?: number;
  coverStrength?: number;
  coverNoiseStrength?: number;
  srcAudioUrl?: string;
  modelQuality?: 'turbo' | 'sft' | 'base';
  modelVariant?: 'turbo' | 'sft' | 'base';
}

export interface Merge {
  takeIds: string[];
  placements?: { takeId: string; shift: number }[];
  region: { start: number; end: number };
  original: boolean;
  commitId: string | null;
  srcAudioUrl: string;
}

interface Context {
  kind: 'edit';
  dispatch?: Release | { src_audio_path: string; stem_type: string };
  dispatched?: boolean;
  workerTaskId?: string;
  params: Edit;
  model: string;
  provenance?: TakeProvenance;
  rawUrl?: string;
  audioUrl?: string;
  stem?: any;
  take?: any;
  commit?: any;
  nextTake?: number;
  stems?: Record<string, string>;
  extracted?: any[];
  extractedTakes?: boolean[];
  result?: any;
}

const taskSchema = z.enum(['repaint', 'lego', 'complete', 'extend', 'cover', 'extract']);
const modelSchema = z.enum(['turbo', 'sft', 'base']);
const editSchema = z.object({
  songId: z.string().min(1), stemId: z.string().optional(), userAddress: z.string().min(1), task: taskSchema,
  prompt: z.string().optional(), lyrics: z.string().optional(), srcAudioUrl: z.string().refine((value) => !/^[a-z][a-z\d+.-]*:/i.test(value) || /^https?:\/\//i.test(value)).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), bpm: z.number().finite().min(30).max(300).optional(), keyScale: z.string().optional(), vocalLanguage: z.string().optional(),
  modelQuality: modelSchema.optional(), modelVariant: modelSchema.optional(),
  repaintingStart: z.number().finite().min(0).optional(), repaintingEnd: z.number().finite().min(0).optional(),
  repaintMode: z.enum(['conservative', 'balanced', 'aggressive']).optional(), repaintStrength: z.number().finite().min(0).max(1).optional(),
  repaintLatentCrossfadeFrames: z.number().finite().int().min(0).optional(), repaintWavCrossfadeSec: z.number().finite().min(0).optional(),
  audioDuration: z.number().finite().min(5).optional(), coverStrength: z.number().finite().min(0).max(1).optional(), coverNoiseStrength: z.number().finite().min(0).max(1).optional(),
  globalCaption: z.string().optional(), trackName: z.string().optional(), trackClasses: z.array(z.string()).optional(), legoContextTrackIds: z.array(z.string()).optional(),
});

function failure(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}

function identity(songId: string, taskId: string): string {
  return createHash('sha256').update(`${songId}:${taskId}`).digest('hex');
}

function address(value: string): string {
  return value.startsWith('0x') ? value.toLowerCase() : value;
}

function nextTake(takes: Array<{ take_number: number }>): number {
  return Math.max(0, ...takes.map((take) => Number.isInteger(take.take_number) && take.take_number > 0 ? take.take_number : 0)) + 1;
}

async function guarded<T>(assertLease: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  await assertLease();
  return operation();
}

/** Resolve musical choices through the actual source chain, including consumed take snapshots. */
export function sourceSettings(source: any, takes: any[], commits: any[], seen = new Set<string>()): Record<string, any> {
  if (!source || seen.has(source.id)) return {};
  seen.add(source.id);
  const parameters = source.provenance?.parameters ?? {};
  const submitted = parameters.submitted ?? parameters;
  const resolved = parameters.resolved ?? {};
  const own = {
    lyrics: submitted.lyrics ?? source.lyrics ?? resolved.lyrics,
    bpm: submitted.bpm ?? resolved.bpm,
    keyScale: submitted.keyScale ?? resolved.keyScale ?? resolved.keyscale ?? resolved.key_scale,
    vocalLanguage: submitted.vocalLanguage ?? resolved.vocalLanguage ?? resolved.language ?? resolved.vocal_language,
  };
  const parentId = source.provenance?.sourceTakeId;
  const saved = takes.find(take => take.id === parentId) ?? commits.flatMap(commit => (commit.timeline_snapshot as any)?.takes ?? []).find(take => take.id === parentId);
  return { ...sourceSettings(saved, takes, commits, seen), ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined && value !== null)) };
}

export class Service {
  async extractSection(params: { songId: string; stemId?: string; userAddress: string; start: number; end: number }) {
    return withJobLock(`song:${params.songId}`, async assertLease => {
      const song = await getSongById(params.songId);
      if (!song) throw failure('Song not found', 404);
      const stems = await listStemsBySong(song.id);
      const stem = params.stemId ? stems.find(stem => stem.id === params.stemId) : stems.find(stem => stem.name.toLowerCase() === 'master');
      if (params.stemId && !stem) throw failure('Stem does not belong to the song', 409);
      const sourceUrl = stem?.url ?? song.url;
      const source = await decodeWave((await readAudio(sourceUrl)).buffer);
      const region = { start: params.start, end: params.end };
      const section = sliceWave(source, region);
      const takes = await listTakesBySong(song.id);
      const id = randomUUID();
      const url = await guarded(assertLease, () => uploadToR2('versions', `sections/${id}.wav`, section, 'audio/wav'));
      const take = await guarded(assertLease, () => createTake({
        id, song_id: song.id, stem_id: stem?.id ?? null, take_number: nextTake(takes), model: 'slice', task: 'extract', url, is_active: false,
        repainting_start: region.start, repainting_end: region.end,
        provenance: { taskId: id, sourceUrl, sourceTakeId: takes.find(take => take.is_active && take.stem_id === (stem?.id ?? null))?.id ?? null, sourceDuration: readWave(source).duration, outputDuration: readWave(section).duration, audioOffset: 0, target: !stem || stem.name.toLowerCase() === 'master' ? 'master' : 'stem', targetStemId: stem?.id ?? null, region, parameters: params },
      }));
      return { success: true, take };
    });
  }

  async createCommitSnapshot(params: { songId: string; message: string; userAddress: string; timelineSnapshot?: any }) {
    return withJobLock(`song:${params.songId}`, async (assertLease) => {
      const stems = await listStemsBySong(params.songId);
      const takes = await listTakesBySong(params.songId);
      const commits = await listCommitsBySong(params.songId);
      const commit = await guarded(assertLease, () => createCommit({
        id: `commit-${randomUUID()}`, song_id: params.songId, user_address: address(params.userAddress), parent_commit_id: commits[0]?.id ?? null,
        message: params.message, timeline_snapshot: params.timelineSnapshot ?? { stems, activeTakeId: takes.find((take) => take.is_active)?.id ?? null, takesCount: takes.length, timestamp: new Date().toISOString() },
      }));
      return { success: true, commit };
    });
  }

  async separateStems(params: { songId: string; stemType?: string; srcAudioUrl?: string; userAddress?: string }) {
    const song = await getSongById(params.songId);
    if (!song) throw failure(`Song ${params.songId} not found`, 404);
    const srcAudio = params.srcAudioUrl || song.url;
    if (!srcAudio) throw failure(`No audio source available for song ${params.songId}`);
    const userAddress = params.userAddress || song.creator;
    if (!userAddress) throw failure(`User address or song creator is required to record separation for song ${params.songId}`);
    const operationId = `sep-${randomUUID()}`;
    const payload = { src_audio_path: srcAudio, stem_type: params.stemType || 'all' };
    const ctx: Context = { kind: 'edit', params: { songId: params.songId, userAddress, task: 'extract', srcAudioUrl: srcAudio }, model: 'demucs-htdemucs', dispatch: payload };
    await setTaskContext(operationId, ctx);
    const response = await client.separate(payload, { idempotencyKey: operationId });
    const taskId = response.task_id || operationId;
    ctx.dispatched = true;
    if (response.status === 'ready') {
      const stems = Object.fromEntries(Object.entries(response.stems ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]));
      if (!Object.keys(stems).length) throw failure('Separation completed without valid stems', 502);
      ctx.stems = stems;
    } else if (response.status === 'error') ctx.result = { taskId, status: 'error', progress: 0, songId: params.songId, task: 'extract' };
    await withJobLock(`task:${taskId}`, async (assertLease) => {
      if (taskId !== operationId && await getTaskContext(taskId)) throw failure('Worker returned an already bound task identifier', 502);
      await guarded(assertLease, () => setTaskContext(taskId, ctx, { terminal: !!ctx.result }));
    });
    if (taskId !== operationId) await setTaskContext(operationId, { ...ctx, workerTaskId: taskId }, { terminal: true });
    if (response.status !== 'ready') return { taskId, status: response.status, songId: params.songId, task: 'extract' };
    return { ...await this.finalizeEditResult({ ...ctx.params, taskId }), taskId, songId: params.songId, task: 'extract' };
  }

  async dispatchEditTask(params: Edit) {
    if (!taskSchema.safeParse(params.task).success) throw failure(`Invalid editing task '${params.task}'`);
    editSchema.parse(params);
    if (params.modelQuality && params.modelVariant && params.modelQuality !== params.modelVariant) throw failure('Conflicting modelQuality and modelVariant');
    if (params.task === 'extract') return this.separateStems({ songId: params.songId, stemType: (params as any).stemType || 'all', srcAudioUrl: params.srcAudioUrl, userAddress: params.userAddress });
    if (params.task === 'repaint' && (params.repaintingStart === undefined || params.repaintingEnd === undefined || params.repaintingEnd <= params.repaintingStart)) throw failure('Repainting start and end bounds must define a positive interval');
    if (params.task === 'extend' && params.audioDuration === undefined) throw failure('Target audio duration is required for extension');
    if (params.task === 'lego' && !params.trackName?.trim()) throw failure('Select the instrument track to generate');
    if (params.task === 'cover' && params.coverStrength === undefined) throw failure('Cover strength is required');
    const song = await getSongById(params.songId);
    if (!song) throw failure(`Song ${params.songId} not found`, 404);
    const stems = await listStemsBySong(params.songId);
    const master = stems.find(stem => stem.name.toLowerCase() === 'master');
    const targetStem = params.stemId ? stems.find(stem => stem.id === params.stemId) : master;
    if (params.stemId && !targetStem) throw failure('Stem does not belong to the song', 409);
    const targetStemId = params.task === 'lego' ? null : targetStem?.id ?? null;
    const takes = await listTakesBySong(params.songId);
    const currentTake = takes.find(take => take.is_active && take.stem_id === (targetStem?.id ?? null));
    const srcAudio = params.srcAudioUrl || currentTake?.url || targetStem?.url || song.url;
    if (!srcAudio) throw failure('Source audio URL is required for editing tasks');
    const submitted = { ...params };
    let sourceTake = currentTake;
    if (params.task === 'extend') {
      const commits = await listCommitsBySong(params.songId);
      sourceTake = takes.find(take => take.url === srcAudio) ?? commits.flatMap(commit => (commit.timeline_snapshot as any)?.takes ?? []).find(take => take.url === srcAudio) ?? (srcAudio === currentTake?.url ? currentTake : undefined);
      const inherited = sourceSettings(sourceTake, takes, commits);
      params = { ...params, lyrics: params.lyrics ?? inherited.lyrics, bpm: params.bpm ?? inherited.bpm, keyScale: params.keyScale ?? inherited.keyScale, vocalLanguage: params.vocalLanguage ?? inherited.vocalLanguage, repaintMode: 'balanced', repaintStrength: 1.0 };
    }
    const quality = params.modelQuality ?? params.modelVariant ?? 'base';
    if ((params.task === 'lego' || params.task === 'complete') && quality !== 'base') throw failure(`${params.task} requires the XL Base model`);
    const model = `acestep-v15-xl-${quality}`;
    const workerTask = params.task === 'extend' ? 'repaint' : params.task;
    const payload: Release = { model, task: workerTask, task_type: workerTask, src_audio_path: srcAudio, prompt: params.prompt ?? '', lyrics: params.lyrics ?? '', inference_steps: quality === 'turbo' ? 8 : 50, guidance_scale: quality === 'turbo' ? 1 : 5, shift: refinementShift(model), batch_size: 1, audio_format: 'wav', use_format: false, use_cot_caption: false, use_cot_language: false, seed: params.seed, use_random_seed: params.seed === undefined, bpm: params.bpm, key_scale: params.keyScale, vocal_language: params.vocalLanguage };
    let sourceDuration = currentTake?.provenance?.outputDuration ?? song.duration ?? null;
    if (params.task === 'extend' || params.task === 'repaint') {
      const source = await decodeWave((await readAudio(srcAudio)).buffer);
      sourceDuration = readWave(source).duration;
      if (params.task === 'extend') {
        if (params.audioDuration! <= sourceDuration) throw failure('Extension duration must be greater than the source duration');
        params = { ...params, repaintingStart: sourceDuration, repaintingEnd: params.audioDuration };
        payload.src_audio_path = await uploadToR2('versions', `sources/${params.songId}/${randomUUID()}.wav`, padWave(source, Math.ceil(params.audioDuration!)));
        payload.audio_duration = params.audioDuration;
      }
      Object.assign(payload, { chunk_mask_mode: 'explicit', repainting_start: params.repaintingStart, repainting_end: params.repaintingEnd, repaint_mode: params.repaintMode, repaint_strength: params.repaintStrength, repaint_latent_crossfade_frames: params.repaintLatentCrossfadeFrames, repaint_wav_crossfade_sec: params.repaintWavCrossfadeSec });
    }
    if (params.task === 'lego') {
      if (params.globalCaption) payload.global_caption = params.globalCaption;
      if (params.trackName) payload.track_name = params.trackName;
      if (params.trackClasses) payload.track_classes = params.trackClasses;
      if (params.audioDuration !== undefined) payload.audio_duration = params.audioDuration;
    }
    if (params.task === 'complete' && params.trackClasses) payload.track_classes = params.trackClasses;
    if (params.task === 'cover') Object.assign(payload, { reference_audio_path: srcAudio, audio_cover_strength: params.coverStrength, cover_noise_strength: params.coverNoiseStrength });
    const intentId = `edit-${randomUUID()}`;
    const ctx: Context = { kind: 'edit', params: { ...params }, model, dispatch: payload };
    ctx.provenance = {
      taskId: intentId, sourceUrl: srcAudio, sourceTakeId: sourceTake?.id ?? null,
      sourceDuration, target: params.task === 'lego' ? 'layer' : params.stemId && params.stemId !== master?.id ? 'stem' : 'master',
      targetStemId, ...(params.task === 'lego' ? { layerName: params.trackName ?? params.prompt ?? 'instrument' } : {}),
      region: params.repaintingStart !== undefined && params.repaintingEnd !== undefined ? { start: params.repaintingStart, end: params.repaintingEnd } : null,
      outputDuration: params.task === 'extend' ? params.audioDuration! : sourceDuration, parameters: { ...params, submitted, resolved: { lyrics: payload.lyrics, bpm: payload.bpm, keyScale: payload.key_scale, vocalLanguage: payload.vocal_language, seed: payload.seed, shift: payload.shift } },
    };
    await setTaskContext(intentId, ctx);
    const response = await client.releaseTask(payload, { idempotencyKey: intentId });
    if (typeof response.task_id !== 'string' || !response.task_id.trim() || !['pending', 'processing', 'ready'].includes(response.status)) throw failure('Invalid worker task release response', 502);
    await withJobLock(`task:${response.task_id}`, async (assertLease) => {
      if (response.task_id !== intentId && await getTaskContext(response.task_id)) throw failure('Worker returned an already bound task identifier', 502);
      ctx.dispatched = true;
      ctx.provenance!.taskId = response.task_id;
      await guarded(assertLease, () => setTaskContext(response.task_id, ctx));
    });
    if (response.task_id !== intentId) await setTaskContext(intentId, { ...ctx, workerTaskId: response.task_id }, { terminal: true });
    return { taskId: response.task_id, status: response.status, songId: params.songId, stemId: params.stemId, task: params.task };
  }

  async finalizeEditResult(params: { taskId: string; songId: string; stemId?: string; userAddress: string; task: Edit['task']; prompt?: string; repaintingStart?: number; repaintingEnd?: number }): Promise<any> {
    const initial = await getTaskContext<Context>(params.taskId);
    if (!initial || initial.kind !== 'edit') throw failure('Unknown edit task', 404);
    if (initial.workerTaskId) return this.finalizeEditResult({ ...params, taskId: initial.workerTaskId });
    const bound = initial.params;
    if (bound.songId !== params.songId || bound.task !== params.task || address(bound.userAddress) !== address(params.userAddress) || (params.stemId !== undefined && params.stemId !== bound.stemId)) throw failure('Task does not match supplied song, user, stem or task kind', 409);
    return withJobLock(`song:${params.songId}`, async (assertLease) => {
      const ctx = await getTaskContext<Context>(params.taskId);
      if (!ctx || ctx.kind !== 'edit') throw failure('Unknown edit task', 404);
      if (ctx.result) {
        if (ctx.result.take) {
          const take = await getTakeById(ctx.result.take.id);
          const committed = !take && (await listCommitsBySong(params.songId)).some(commit => (commit.timeline_snapshot as any)?.provenance?.candidates?.includes(ctx.result!.take.id));
          return { ...ctx.result, take: take ?? null, versionState: take ? take.is_active || take.provenance?.mergedInto ? 'merged' : 'pending' : committed ? 'merged' : 'discarded' };
        }
        return ctx.result;
      }
      if (!(await getSongById(params.songId))) throw failure(`Song ${params.songId} not found`, 404);
      const save = async () => { await guarded(assertLease, () => setTaskContext(params.taskId, ctx)); };
      const id = identity(params.songId, params.taskId);
      if (ctx.params.task === 'extract' && ctx.stems) return this.finalizeSeparation(params.taskId, ctx, id, assertLease);
      if (!ctx.rawUrl) {
        const task = (await client.queryResult([params.taskId])).results[params.taskId];
        if (!task) return { status: 'pending', progress: 0 };
        if (task.status !== 'ready') {
          const result = { status: task.status, progress: task.progress, error: task.error };
          if (task.status === 'error') { ctx.result = result; await guarded(assertLease, () => setTaskContext(params.taskId, ctx, { terminal: true })); }
          return result;
        }
        if (ctx.params.task === 'extract' && task.stems && Object.keys(task.stems).length) {
          ctx.stems = task.stems;
          await save();
          return this.finalizeSeparation(params.taskId, ctx, id, assertLease);
        }
        if (ctx.params.task === 'extract' || !Array.isArray(task.audio_urls) || typeof task.audio_urls[0] !== 'string' || !task.audio_urls[0]) {
          ctx.result = { status: 'error', progress: 0, error: 'Worker completed without valid output' };
          await guarded(assertLease, () => setTaskContext(params.taskId, ctx, { terminal: true })); return ctx.result;
        }
        ctx.rawUrl = task.audio_urls[0]; await save();
      }
      const rawUrl = ctx.rawUrl;
      if (!ctx.audioUrl) {
        if (ctx.provenance?.region) {
          const [source, generated] = await Promise.all([readAudio(ctx.provenance.sourceUrl), readAudio(rawUrl)]);
          const composed = await composeEdit(source.buffer, generated.buffer, ctx.provenance.region);
          ctx.provenance.outputDuration = readWave(composed).duration;
          ctx.audioUrl = await guarded(assertLease, () => uploadToR2('versions', `edits/${id}.wav`, composed));
        } else ctx.audioUrl = await guarded(assertLease, () => persistAudioToR2('versions', `edits/${id}.wav`, rawUrl));
        await save();
      }
      const audioUrl = ctx.audioUrl;
      const stemId = ctx.provenance?.targetStemId ?? ctx.params.stemId ?? null;
      if (!ctx.take) {
        const takes = await listTakesBySong(params.songId);
        ctx.take = takes.find((take) => take.id === `take-${id}`);
        if (!ctx.take) {
          ctx.nextTake ??= nextTake(takes); await save();
          ctx.take = await guarded(assertLease, () => createTake({ id: `take-${id}`, song_id: params.songId, stem_id: stemId, take_number: ctx.nextTake, model: ctx.model, task: ctx.params.task, prompt: ctx.params.prompt || null, lyrics: ctx.params.lyrics ?? null, repainting_start: ctx.params.repaintingStart ?? null, repainting_end: ctx.params.repaintingEnd ?? null, url: audioUrl, waveform_url: null, is_active: false, seed: ctx.params.seed ?? null, provenance: ctx.provenance ?? null }));
        }
        await save();
      }
      ctx.result = { status: 'ready', progress: 100, versionState: 'pending', take: ctx.take, audioUrl: ctx.audioUrl, audioUrls: [ctx.audioUrl] };
      await guarded(assertLease, () => setTaskContext(params.taskId, ctx, { terminal: true })); return ctx.result;
    });
  }

  private async finalizeSeparation(taskId: string, ctx: Context, id: string, assertLease: () => Promise<void>) {
    const extracted = ctx.extracted ??= [];
    const extractedTakes = ctx.extractedTakes ??= [];
    const save = async () => { await guarded(assertLease, () => setTaskContext(taskId, ctx)); };
    const entries = Object.entries(ctx.stems!);
    for (let index = 0; index < entries.length; index++) {
      const [name, rawUrl] = entries[index];
      if (!extracted[index]) {
        const url = await guarded(assertLease, () => persistAudioToR2('versions', `stems/${id}-${index}.wav`, rawUrl));
        extracted[index] = await guarded(assertLease, () => createStem({ id: `stem-${ctx.params.songId}-${name}`, song_id: ctx.params.songId, name: name.toLowerCase(), url, waveform_peaks_url: null, volume: 1, pan: 0, is_muted: true, is_solo: false })); await save();
      }
      if (!extractedTakes[index]) {
        const takes = await listTakesBySong(ctx.params.songId);
        const takeId = `take-extract-${id}-${index}`;
        if (!takes.some((take) => take.id === takeId)) await guarded(assertLease, () => createTake({ id: takeId, song_id: ctx.params.songId, stem_id: extracted[index].id, take_number: nextTake(takes), model: ctx.model, task: 'extract', prompt: null, lyrics: null, url: extracted[index].url, waveform_url: null, is_active: true, seed: null }));
        extractedTakes[index] = true; await save();
      }
    }
    if (!ctx.commit) {
      const commits = await listCommitsBySong(ctx.params.songId);
      ctx.commit = commits.find((commit) => commit.id === `commit-${id}`) ?? await guarded(assertLease, () => createCommit({ id: `commit-${id}`, song_id: ctx.params.songId, user_address: address(ctx.params.userAddress), parent_commit_id: commits[0]?.id ?? null, message: `Extracted real multi-track stems (${entries.map(([name]) => name).join(', ')})`, timeline_snapshot: { stems: ctx.extracted, stemsCount: extracted.length, timestamp: new Date().toISOString() } })); await save();
    }
    ctx.result = { status: 'ready', progress: 100, stems: ctx.extracted };
    await guarded(assertLease, () => setTaskContext(taskId, ctx, { terminal: true })); return ctx.result;
  }

  async switchActiveTake(songId: string, stemId: string | null, takeId: string, userAddress?: string, action: 'base' | 'merge' = 'base', merge?: Merge) {
    return withJobLock(`song:${songId}`, async assertLease => {
      if (action === 'merge' && merge) return this.mergeCandidates(songId, merge, userAddress, assertLease);
      const song = await getSongById(songId);
      if (!song) throw failure('Song not found', 404);
      let take = (await listTakesBySong(songId)).find(take => take.id === takeId);
      if (!take) throw failure('Take not found in this song', 404);
      if (stemId !== null && stemId !== take.stem_id) throw failure('Take does not belong to the selected stem', 409);
      if (take.is_active) return { success: true, activeTakeId: takeId, take, versionState: 'merged' };
      const stems = await listStemsBySong(songId);
      const takes = await listTakesBySong(songId);
      const commits = await listCommitsBySong(songId);
      const currentUrl = take.stem_id ? stems.find(stem => stem.id === take!.stem_id)?.url : song.url;
      if (action === 'merge' && !take.provenance?.region) throw failure('Select a segment to merge');
      if (action === 'merge' && take.provenance?.region && currentUrl) {
        const [current, version] = await Promise.all([readAudio(currentUrl), readAudio(take.url)]);
        const composed = await composeEdit(current.buffer, version.buffer, take.provenance.region, take.provenance.audioOffset ?? take.provenance.region.start);
        const url = await guarded(assertLease, () => uploadToR2('versions', `edits/${identity(songId, takeId)}/merge-${identity(currentUrl, takeId)}.wav`, composed, 'audio/wav'));
        take = { ...take, url, provenance: { ...take.provenance, outputDuration: readWave(composed).duration, audioOffset: take.provenance.region.start } };
      }
      const layer = take.provenance?.target === 'layer' && !take.stem_id ? {
        id: `stem-${identity(songId, takeId)}`, song_id: songId, name: take.provenance.layerName ?? 'instrument', url: take.url,
        waveform_peaks_url: null, volume: 1, pan: 0, is_muted: false, is_solo: false,
      } : undefined;
      const targetStemId = layer?.id ?? take.stem_id;
      const master = !layer && (take.provenance?.target === 'master' || !targetStemId || stems.some(stem => stem.id === targetStemId && stem.name.toLowerCase() === 'master'));
      const mergedTake = { ...take, is_active: true, stem_id: targetStemId };
      const mergedStems = layer ? [...stems, layer] : stems.map(stem => stem.id === targetStemId ? { ...stem, url: take.url } : stem);
      const commit = {
        id: `commit-${randomUUID()}`, song_id: songId, user_address: address(userAddress ?? song.creator), parent_commit_id: commits[0]?.id ?? null,
        message: `${action === 'merge' ? 'Merged segment' : 'Selected base'} (Take #${take.take_number})`,
        timeline_snapshot: { stems: mergedStems, takes: takes.map(item => item.id === takeId ? mergedTake : item.stem_id === targetStemId ? { ...item, is_active: false } : item), activeTakeId: takeId, action, provenance: take.provenance, timestamp: new Date().toISOString() },
      };
      await guarded(assertLease, () => activateTake(songId, targetStemId, takeId, { stem: layer, master, commit, url: take.url, provenance: take.provenance, duration: master ? take.provenance?.outputDuration ?? undefined : undefined }));
      return { success: true, activeTakeId: takeId, take: mergedTake, commit, versionState: action === 'merge' ? 'merged' : 'active' };
    });
  }

  private async mergeCandidates(songId: string, merge: Merge, userAddress: string | undefined, assertLease: () => Promise<void>) {
    const song = await getSongById(songId);
    if (!song?.url) throw failure('Song audio not found', 404);
    const takes = await listTakesBySong(songId), commits = await listCommitsBySong(songId), stems = await listStemsBySong(songId);
    const id = `take-merge-${identity(songId, JSON.stringify({ ...merge, takeIds: [...merge.takeIds].sort(), srcAudioUrl: undefined }))}`;
    const previous = takes.find(take => take.id === id);
    if (previous) return { success: true, take: previous, activeTakeId: id, versionState: 'merged' };
    if ((commits[0]?.id ?? null) !== merge.commitId) throw failure('The master changed. Reload its current version before merging.', 409);
    if (!merge.takeIds.length || new Set(merge.takeIds).size !== merge.takeIds.length) throw failure('Select distinct candidates to merge');
    const candidates = merge.takeIds.map(id => takes.find(take => take.id === id));
    if (candidates.some(take => !take || take.is_active || take.provenance?.mergedInto || take.provenance?.target === 'stem')) throw failure('Selected candidates are not pending master sections', 409);
    const { start, end } = merge.region;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start > (song.duration ?? Infinity)) throw failure('Invalid merge interval');
    const placements = merge.placements ?? merge.takeIds.map(takeId => ({takeId,shift:0}));
    if (placements.length !== candidates.length || new Set(placements.map(item => item.takeId)).size !== candidates.length || placements.some(item => !merge.takeIds.includes(item.takeId) || !Number.isFinite(item.shift))) throw failure('Invalid candidate placement');
    const remaining: { id: string; provenance: TakeProvenance }[] = [], consume: string[] = [];
    for (const candidate of candidates) {
      const shift = placements.find(item => item.takeId === candidate!.id)!.shift;
      const ranges = candidate!.provenance?.regions ?? [candidate!.provenance?.region ?? { start: 0, end: candidate!.provenance?.outputDuration ?? song.duration ?? 0 }];
      if (ranges.some(range => range.start + shift < 0)) throw failure('Invalid candidate placement before timeline zero');
      if (!ranges.some(range => range.start + shift < end && range.end + shift > start)) throw failure('Candidate does not overlap the selected section');
      const sourceStart = start - shift, sourceEnd = end - shift;
      const regions = ranges.flatMap(range => range.end <= sourceStart || range.start >= sourceEnd ? [range] : [
        ...(range.start < sourceStart ? [{ start: range.start, end: sourceStart }] : []),
        ...(range.end > sourceEnd ? [{ start: sourceEnd, end: range.end }] : []),
      ]);
      if (regions.length) remaining.push({ id: candidate!.id, provenance: { ...candidate!.provenance!, regions } });
      else consume.push(candidate!.id);
    }
    const [source, rendered] = await Promise.all([readAudio(song.url), readAudio(merge.srcAudioUrl)]);
    const audio = await composeEdit(source.buffer, rendered.buffer, merge.region, start, true);
    const url = await guarded(assertLease, () => uploadToR2('versions', `edits/${id}.wav`, audio, 'audio/wav'));
    const master = stems.find(stem => stem.name.toLowerCase() === 'master');
    const provenance: TakeProvenance = { taskId: id, sourceUrl: song.url, sourceTakeId: takes.find(take => take.is_active && take.provenance?.target === 'master')?.id ?? null, sourceDuration: readWave(await decodeWave(source.buffer)).duration, target: 'master', targetStemId: master?.id ?? null, region: merge.region, outputDuration: readWave(audio).duration, audioOffset: start, candidates: merge.takeIds, original: merge.original, parameters: { commitId: merge.commitId, placements } };
    const take = { id, song_id: songId, stem_id: master?.id ?? null, take_number: nextTake(takes), task: 'merge', model: candidates[0]!.model, prompt: null, lyrics: null, url, is_active: true, provenance };
    const commit = { id: `commit-${id}`, song_id: songId, user_address: address(userAddress ?? song.creator), parent_commit_id: merge.commitId, message: 'Merged section', timeline_snapshot: { action: 'merge', activeTakeId: id, takes: candidates, provenance, timestamp: new Date().toISOString() } };
    await guarded(assertLease, () => activateTake(songId, master?.id ?? null, id, { take, consume, remaining, master: true, url, duration: provenance.outputDuration!, commit }));
    return { success: true, activeTakeId: id, take, commit, versionState: 'merged' };
  }

  async deleteTake(takeId: string) {
    const initial = await getTakeById(takeId);
    if (!initial) return { success: false, deletedTakeId: takeId };
    return withJobLock(`song:${initial.song_id}`, async assertLease => {
      const take = await getTakeById(takeId);
      if (take?.is_active) throw failure('Merge another version before discarding the active take', 409);
      return { success: await guarded(assertLease, () => deleteTake(takeId, initial.song_id, true)), deletedTakeId: takeId };
    });
  }

  async updateTrackMixer(stemId: string, mixer: { volume?: number; pan?: number; is_muted?: boolean; is_solo?: boolean }) {
    return updateStemMixer(stemId, mixer);
  }

  async getTimelineHistory(songId: string) {
    return withJobLock(`song:${songId}`, async (assertLease) => {
      const stems = await listStemsBySong(songId);
      const takes = await listTakesBySong(songId);
      const commits = await listCommitsBySong(songId);
      const key = `history:${songId}`;
      const context = await getTaskContext<any>(key);
      if (context?.done || (stems.length && !context)) return { stems, takes, commits };
      const song = await getSongById(songId);
      if (!song?.url) return { stems, takes, commits };
      const ctx = context ?? {};
      const save = async () => { await guarded(assertLease, () => setTaskContext(key, ctx)); };
      await save();
      if (!ctx.stem) {
        ctx.stem = stems.find((stem) => stem.id === `stem-master-${songId}`) ?? await guarded(assertLease, () => createStem({ id: `stem-master-${songId}`, song_id: songId, name: 'Master', url: song.url, waveform_peaks_url: null, volume: 1, pan: 0, is_muted: false, is_solo: false })); await save();
      }
      if (!ctx.take) {
        ctx.take = takes.find((take) => take.id === `take-1-${songId}`) ?? await guarded(assertLease, () => createTake({ id: `take-1-${songId}`, song_id: songId, stem_id: ctx.stem.id, take_number: nextTake(takes), model: 'acestep-v15-xl-turbo', task: 'text2music', prompt: null, lyrics: null, url: song.url, waveform_url: null, is_active: true, seed: null })); await save();
      }
      if (!ctx.commit) {
        ctx.commit = commits.find((commit) => commit.id === `commit-init-${songId}`) ?? await guarded(assertLease, () => createCommit({ id: `commit-init-${songId}`, song_id: songId, user_address: song.creator, parent_commit_id: commits[0]?.id ?? null, message: `Initial Master Track (${song.title})`, timeline_snapshot: { stems: [ctx.stem], activeTakeId: ctx.take.id, takesCount: takes.length + 1, timestamp: new Date().toISOString() } })); await save();
      }
      ctx.done = true; await guarded(assertLease, () => setTaskContext(key, ctx, { terminal: true }));
      return { stems: stems.length ? stems : [ctx.stem], takes: takes.length ? takes : [ctx.take], commits: commits.length ? commits : [ctx.commit] };
    });
  }
}

export const service = new Service();
export const editingService = service;
export type ApplyEditParams = Edit;
export type EditingService = Service;
