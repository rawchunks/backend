import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { service } from './service.js';
import { readSong, readTake, readUser, checkUser } from '../databases/users.js';
import { songSql } from '../databases/client.js';
import { uploadToR2 } from '../storage/r2.js';
import { readWave } from './audio.js';
import { randomUUID } from 'node:crypto';

const baseSchema = {
  songId: z.string().min(1),
  stemId: z.string().optional(),
  userAddress: z.string().min(10),
  srcAudioUrl: z.string().refine((value) => !/^[a-z][a-z\d+.-]*:/i.test(value) || /^https?:\/\//i.test(value)).optional(),
  modelQuality: z.enum(['turbo', 'sft', 'base']).optional(),
  modelVariant: z.enum(['turbo', 'sft', 'base']).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  bpm: z.number().finite().min(30).max(300).optional(),
  keyScale: z.string().optional(),
  vocalLanguage: z.string().optional(),
};

const repaintSchema = z.object({
  ...baseSchema,
  prompt: z.string().optional(),
  lyrics: z.string().optional(),
  start: z.number().finite().min(0),
  end: z.number().finite().min(0),
  repaintMode: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
  repaint_mode: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
  repaintStrength: z.number().finite().min(0).max(1).optional(),
  repaint_strength: z.number().finite().min(0).max(1).optional(),
  repaintLatentCrossfadeFrames: z.number().finite().int().min(0).optional(),
  repaintWavCrossfadeSec: z.number().finite().min(0).optional(),
}).refine((p) => p.end > p.start, { message: 'Repaint end must be greater than start' });

const layerSchema = z.object({
  ...baseSchema,
  prompt: z.string().min(1),
  globalCaption: z.string().optional(),
  trackName: z.string().optional(),
  trackClasses: z.array(z.string()).optional(),
  audioDuration: z.number().finite().min(5).optional(),
  legoContextTrackIds: z.array(z.string()).optional(),
});

const commitSchema = z.object({
  songId: z.string().min(1),
  message: z.string().min(1),
  userAddress: z.string().min(10),
  timelineSnapshot: z.record(z.string(), z.any()).optional(),
  snapshot: z.record(z.string(), z.any()).optional(),
});

const extendSchema = z.object({
  ...baseSchema,
  prompt: z.string().optional(),
  lyrics: z.string().optional(),
  audioDuration: z.number().finite().min(5),
  repaintWavCrossfadeSec: z.number().finite().min(0).optional(),
});

const remixSchema = z.object({
  ...baseSchema,
  prompt: z.string().min(1),
  coverStrength: z.number().finite().min(0).max(1).optional(),
  coverNoiseStrength: z.number().finite().min(0).max(1).optional(),
});

const separateSchema = z.object({
  ...baseSchema,
  stemType: z.string().optional(),
});

const applySchema = z.object({
  ...baseSchema,
  task: z.enum(['repaint', 'lego', 'complete', 'extend', 'cover', 'extract']),
  prompt: z.string().optional(),
  lyrics: z.string().optional(),
  repaintingStart: z.number().finite().min(0).optional(),
  repaintingEnd: z.number().finite().min(0).optional(),
  audioDuration: z.number().finite().min(5).optional(),
  coverStrength: z.number().finite().min(0).max(1).optional(),
  coverNoiseStrength: z.number().finite().min(0).max(1).optional(),
  repaintMode: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
  repaintStrength: z.number().finite().min(0).max(1).optional(),
  repaintLatentCrossfadeFrames: z.number().finite().int().min(0).optional(),
  repaintWavCrossfadeSec: z.number().finite().min(0).optional(),
  globalCaption: z.string().optional(),
  trackName: z.string().optional(),
  trackClasses: z.array(z.string()).optional(),
  legoContextTrackIds: z.array(z.string()).optional(),
  stemType: z.string().optional(),
  srcAudioUrl: z.string().refine((value) => !/^[a-z][a-z\d+.-]*:/i.test(value) || /^https?:\/\//i.test(value)).optional(),
});

import { requireSessionPayment } from '../broker/payment.js';

const PAID_EDIT_ACTIONS: Record<string, string> = {
  '/extract': 'edit-extract',
  '/repaint': 'edit-repaint',
  '/layer': 'edit-layer',
  '/extend': 'edit-extend',
  '/remix': 'edit-remix',
  '/separate': 'edit-separate',
  '/apply': 'edit-apply',
};

const resolveEditAction = (url: string, routeUrl?: string): string | null => {
  if (routeUrl && PAID_EDIT_ACTIONS[routeUrl]) return PAID_EDIT_ACTIONS[routeUrl];
  for (const [path, action] of Object.entries(PAID_EDIT_ACTIONS)) {
    if (url.endsWith(path)) return action;
  }
  return null;
};

export const editingRouter: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method === 'POST') {
      const action = resolveEditAction(request.url, request.routeOptions?.url);
      if (action) {
        const handler = requireSessionPayment({ amountWei: '20000', priceUsd: 0.02, action });
        await handler(request, reply);
        if (reply.sent) return;
        if (request.body && typeof request.body === 'object' && !(request.body as any).userAddress) {
          const authed = request.headers['x-session-user-address'];
          if (typeof authed === 'string') (request.body as any).userAddress = authed;
        }
      }
    }
  });

  fastify.addHook('preHandler', async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const body = request.body as Record<string, unknown> | null;
      const query = request.query as Record<string, unknown>;
      const songId = params.songId ?? body?.songId ?? query.songId;
      if (typeof songId === 'string' && songId) {
        const { userAddress, song } = await readSong(request, songId);
        if (request.method !== 'GET' && song?.metadata_cid) return reply.status(409).send({ error: 'Open an editable version before changing this song' });
        const supplied = body?.userAddress ?? query.userAddress;
        if (typeof supplied === 'string') checkUser(userAddress, supplied);
      } else if (params.id) {
        const { song } = await readTake(request, params.id);
        if (request.method !== 'GET' && song?.metadata_cid) return reply.status(409).send({ error: 'Open an editable version before changing this song' });
      }
      else if (params.stemId) {
        readUser(request);
        const rows = await songSql`SELECT song_id FROM stems WHERE id = ${params.stemId} LIMIT 1`;
        if (!rows[0]) return reply.status(404).send({ error: 'Stem not found' });
        const { song } = await readSong(request, rows[0].song_id);
        if (request.method !== 'GET' && song?.metadata_cid) return reply.status(409).send({ error: 'Open an editable version before changing this song' });
      }
    } catch (error: any) { return reply.status(error.statusCode ?? 500).send({ error: error.message }); }
  });
  fastify.post('/source', async (request, reply) => {
    try {
      const { songId } = z.object({ songId: z.string().min(1) }).parse(request.query);
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: 'Reference audio is required' });
      const audio = await file.toBuffer();
      readWave(audio);
      const url = await uploadToR2('versions', `sources/${songId}/${randomUUID()}.wav`, audio, 'audio/wav');
      return reply.code(201).send({ url });
    } catch (error: any) {
      request.log.error(error);
      return reply.code(error.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : error instanceof z.ZodError || /WAV/.test(error.message) ? 400 : error.statusCode ?? 500).send({ error: 'Could not save reference audio' });
    }
  });
  fastify.post('/extract', async (request, reply) => {
    try {
      const params = z.object({ songId: z.string().min(1), stemId: z.string().optional(), start: z.number().finite().min(0), end: z.number().finite().min(0) }).refine(params => params.end > params.start).parse(request.body);
      return reply.code(201).send(await service.extractSection({ ...params, userAddress: readUser(request) }));
    } catch (error: any) { return reply.code(error instanceof z.ZodError ? 400 : error.statusCode ?? 400).send({ error: error.message }); }
  });
  fastify.post('/repaint', async (request, reply) => {
    try {
      const p = repaintSchema.parse(request.body);
      const res = await service.dispatchEditTask({
        modelQuality: p.modelQuality,
        modelVariant: p.modelVariant,
        songId: p.songId,
        stemId: p.stemId,
        userAddress: p.userAddress,
        task: 'repaint',
        prompt: p.prompt,
        lyrics: p.lyrics,
        repaintingStart: p.start,
        repaintingEnd: p.end,
        repaintMode: p.repaintMode || p.repaint_mode,
        repaintStrength: p.repaintStrength ?? p.repaint_strength,
        repaintLatentCrossfadeFrames: p.repaintLatentCrossfadeFrames,
        repaintWavCrossfadeSec: p.repaintWavCrossfadeSec,
        srcAudioUrl: p.srcAudioUrl,
      });
      return reply.status(202).send(res);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Repaint failed to initiate' });
    }
  });

  fastify.post('/layer', async (request, reply) => {
    try {
      const p = layerSchema.parse(request.body);
      const res = await service.dispatchEditTask({
        modelQuality: p.modelQuality,
        modelVariant: p.modelVariant,
        songId: p.songId,
        stemId: p.stemId,
        userAddress: p.userAddress,
        task: 'lego',
        prompt: p.prompt,
        globalCaption: p.globalCaption,
        trackName: p.trackName,
        trackClasses: p.trackClasses,
        audioDuration: p.audioDuration,
        legoContextTrackIds: p.legoContextTrackIds,
        srcAudioUrl: p.srcAudioUrl,
      });
      return reply.status(202).send(res);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Layer failed to initiate' });
    }
  });

  const handleCommit = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { snapshot, ...p } = commitSchema.parse(request.body);
      const res = await service.createCommitSnapshot({ ...p, timelineSnapshot: p.timelineSnapshot ?? snapshot });
      return reply.status(201).send(res);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Failed to create commit' });
    }
  };
  fastify.post('/commits', handleCommit);
  fastify.post('/commit', handleCommit);

  fastify.post('/extend', async (request, reply) => {
    try {
      const p = extendSchema.parse(request.body);
      const res = await service.dispatchEditTask({
        modelQuality: p.modelQuality,
        modelVariant: p.modelVariant,
        songId: p.songId,
        stemId: p.stemId,
        userAddress: p.userAddress,
        task: 'extend',
        prompt: p.prompt,
        lyrics: p.lyrics,
        seed: p.seed,
        bpm: p.bpm,
        keyScale: p.keyScale,
        vocalLanguage: p.vocalLanguage,
        audioDuration: p.audioDuration,
        repaintWavCrossfadeSec: p.repaintWavCrossfadeSec,
        srcAudioUrl: p.srcAudioUrl,
      });
      return reply.status(202).send(res);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Extend failed to initiate' });
    }
  });

  fastify.post('/remix', async (request, reply) => {
    try {
      const p = remixSchema.parse(request.body);
      const res = await service.dispatchEditTask({
        modelQuality: p.modelQuality,
        modelVariant: p.modelVariant,
        songId: p.songId,
        stemId: p.stemId,
        userAddress: p.userAddress,
        task: 'cover',
        prompt: p.prompt,
        coverStrength: p.coverStrength,
        coverNoiseStrength: p.coverNoiseStrength,
        srcAudioUrl: p.srcAudioUrl,
      });
      return reply.status(202).send(res);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Remix failed to initiate' });
    }
  });

  fastify.post('/separate', async (request, reply) => {
    try {
      const p = separateSchema.parse(request.body);
      const res = await service.separateStems({
        songId: p.songId,
        stemType: p.stemType || 'all',
        srcAudioUrl: p.srcAudioUrl,
        userAddress: p.userAddress,
      });
      return reply.status(200).send(res);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Separate failed to initiate' });
    }
  });

  fastify.post('/apply', async (request, reply) => {
    try {
      const parsed = applySchema.parse(request.body);
      const result = await service.dispatchEditTask(parsed);
      return reply.status(202).send(result);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Failed to dispatch edit task' });
    }
  });

  fastify.get('/status/:taskId', async (request, reply) => {
    try {
      const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
      const bound = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite().min(0)).optional();
      const { songId, stemId, userAddress, task, prompt, repaintingStart, repaintingEnd } = z.object({
        songId: z.string().min(1), stemId: z.string().optional(), userAddress: z.string().min(10),
        task: z.enum(['repaint', 'lego', 'complete', 'extend', 'cover', 'extract']), prompt: z.string().optional(),
        repaintingStart: bound, repaintingEnd: bound,
      }).refine((p) => p.repaintingStart === undefined || p.repaintingEnd === undefined || p.repaintingEnd > p.repaintingStart).parse(request.query);

      const result = await service.finalizeEditResult({
        taskId,
        songId,
        stemId,
        userAddress,
        task,
        prompt,
        repaintingStart,
        repaintingEnd,
      });
      return reply.send(result);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Failed to check edit status' });
    }
  });

  const handleActivate = async (request: any, reply: any) => {
    try {
      const { songId, stemId, takeId, userAddress, action, composition } = z.object({ songId: z.string().min(1), stemId: z.string().optional(), takeId: z.string().min(1), userAddress: z.string().min(10).optional(), action: z.enum(['base', 'merge']).optional(), composition: z.object({ placements: z.array(z.object({ takeId: z.string().min(1), shift: z.number().finite() })).optional(), takeIds: z.array(z.string().min(1)).min(1), region: z.object({ start: z.number().finite().min(0), end: z.number().finite().positive() }), original: z.boolean(), commitId: z.string().nullable(), srcAudioUrl: z.url() }).optional() }).parse(request.body);
      const result = action ? await service.switchActiveTake(songId, stemId || null, takeId, userAddress, action, composition) : await service.switchActiveTake(songId, stemId || null, takeId, userAddress);
      return reply.send(result);
    } catch (err: any) {
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message });
    }
  };

  fastify.post('/activate', handleActivate);
  fastify.post('/takes/activate', handleActivate);

  fastify.delete('/takes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!id) {
      return reply.status(400).send({ error: 'take id is required' });
    }
    try {
      const result = await service.deleteTake(id);
      return reply.send(result);
    } catch (err: any) {
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message });
    }
  });

  fastify.patch('/mixer/:stemId', async (request, reply) => {
    const { stemId } = request.params as { stemId: string };
    try {
      const { volume, pan, is_muted, is_solo } = z.object({
        volume: z.number().finite().min(0).optional(), pan: z.number().finite().min(-1).max(1).optional(),
        is_muted: z.boolean().optional(), is_solo: z.boolean().optional(),
      }).parse(request.body);
      const updated = await service.updateTrackMixer(stemId, { volume, pan, is_muted, is_solo });
      return reply.send(updated);
    } catch (err: any) {
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message });
    }
  });

  fastify.get('/history/:songId', async (request, reply) => {
    const { songId } = request.params as { songId: string };
    try {
      const history = await service.getTimelineHistory(songId);
      return reply.send(history);
    } catch (err: any) {
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message });
    }
  });
};
