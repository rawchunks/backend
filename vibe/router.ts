import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import { requireSessionPayment, PRICING } from '../broker/payment.js';
import { generateCoverArt } from '../generation/router.js';
import { LYRICS_CANVAS_TAGS, LYRICS_SYSTEM_PROMPT } from './lyrics.js';
import { STYLE_TAGS_LIBRARY, normalizeStyleTags } from './styles.js';
import {
  PARAMETERS_LIBRARY,
  normalizeBpm,
  normalizeDuration,
  normalizeKeyScale,
  normalizeLanguage,
} from './parameters.js';
import {
  runVibeAgentStream,
  streamSongLyrics,
  translateImageToSongPrompt,
  type VibeStreamEvent,
} from './service.js';

export async function vibeRouter(fastify: FastifyInstance) {
  /**
   * POST /vibe (or /api/vibe)
   * General Songwriter Agent endpoint — gated by x402 ($0.02 USDC / 2 Credits).
   * Accepts a text prompt, an image (translated via nvidia/Nemotron-3.5-Super-VL), or both.
   * Streams NDJSON field updates in real-time to populate the /studio form.
   */
  fastify.post<{
    Body: {
      prompt?: string;
      image?: string;
      modelVariant?: 'turbo' | 'sft';
    };
  }>('/', { preHandler: [requireSessionPayment(PRICING.vibe)] }, async (request, reply) => {
    const prompt = request.body?.prompt?.trim() || '';
    const image = request.body?.image?.trim() || '';
    if (prompt.length < 2 && !image) {
      return reply.code(400).send({ error: 'Provide a text prompt (min 2 chars) or attach an image' });
    }

    const stream = new PassThrough();
    const emit = (event: VibeStreamEvent) => {
      if (!stream.destroyed) {
        stream.write(`${JSON.stringify(event)}\n`);
      }
    };

    void (async () => {
      try {
        await runVibeAgentStream({
          userPrompt: prompt,
          image: image || undefined,
          emit,
        });
      } catch (err: any) {
        request.log.error(err, '[VibeRouter] Agent stream failed');
        emit({ type: 'error', message: err?.message || 'Songwriter agent failed' });
      } finally {
        if (!stream.destroyed) {
          stream.end();
        }
      }
    })();

    return reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .header('X-Accel-Buffering', 'no')
      .send(stream);
  });

  /**
   * Nested free per-action endpoints (/vibe/*)
   * Allow inspecting modular libraries or executing individual songwriter actions.
   */
  fastify.post<{
    Body: {
      image: string;
      prompt?: string;
    };
  }>('/vision', async (request, reply) => {
    const image = request.body?.image?.trim();
    if (!image) {
      return reply.code(400).send({ error: 'image is required' });
    }
    try {
      const prompt = await translateImageToSongPrompt({
        image,
        userPrompt: request.body?.prompt,
      });
      return { prompt };
    } catch (err: any) {
      request.log.error(err, '[VibeRouter] Vision translation failed');
      return reply.code(502).send({ error: err?.message || 'Vision prompt translation failed' });
    }
  });
  fastify.get('/lyrics', async () => ({
    tags: LYRICS_CANVAS_TAGS,
    systemPrompt: LYRICS_SYSTEM_PROMPT,
  }));

  fastify.post<{
    Body: {
      prompt: string;
      title?: string;
      style?: string;
      vocalLanguage?: string;
      stream?: boolean;
    };
  }>('/lyrics', async (request, reply) => {
    const prompt = request.body?.prompt?.trim();
    if (!prompt) {
      return reply.code(400).send({ error: 'Prompt is required' });
    }
    if (request.body?.stream === false) {
      const lyrics = await streamSongLyrics({
        userPrompt: prompt,
        title: request.body?.title,
        sonicPrompt: request.body?.style,
        vocalLanguage: request.body?.vocalLanguage,
        onDelta: () => { },
      });
      return { lyrics };
    }

    const stream = new PassThrough();
    void (async () => {
      try {
        await streamSongLyrics({
          userPrompt: prompt,
          title: request.body?.title,
          sonicPrompt: request.body?.style,
          vocalLanguage: request.body?.vocalLanguage,
          onDelta: (delta) => {
            if (!stream.destroyed) {
              stream.write(`${JSON.stringify({ type: 'lyrics_delta', delta })}\n`);
            }
          },
        });
        if (!stream.destroyed) {
          stream.write(`${JSON.stringify({ type: 'done' })}\n`);
        }
      } catch (err: any) {
        if (!stream.destroyed) {
          stream.write(`${JSON.stringify({ type: 'error', message: err?.message || 'Lyrics stream failed' })}\n`);
        }
      } finally {
        if (!stream.destroyed) stream.end();
      }
    })();

    return reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .header('X-Accel-Buffering', 'no')
      .send(stream);
  });

  fastify.get('/styles', async () => ({
    styles: STYLE_TAGS_LIBRARY,
  }));

  fastify.post<{
    Body: { tags?: string[] };
  }>('/styles', async (request) => ({
    tags: normalizeStyleTags(request.body?.tags || []),
  }));

  fastify.get('/parameters', async () => ({
    parameters: PARAMETERS_LIBRARY,
  }));

  fastify.post<{
    Body: {
      bpm?: number;
      keyScale?: string;
      audioDuration?: number;
      vocalLanguage?: string;
    };
  }>('/parameters', async (request) => ({
    bpm: normalizeBpm(request.body?.bpm),
    keyScale: normalizeKeyScale(request.body?.keyScale),
    audioDuration: normalizeDuration(request.body?.audioDuration),
    vocalLanguage: normalizeLanguage(request.body?.vocalLanguage),
  }));

  fastify.post<{
    Body: {
      title?: string;
      prompt?: string;
      instrumental?: boolean;
      vocalLanguage?: string;
    };
  }>('/details', async (request) => ({
    title: String(request.body?.title || '').trim(),
    prompt: String(request.body?.prompt || '').trim(),
    instrumental: Boolean(request.body?.instrumental),
    vocalLanguage: normalizeLanguage(request.body?.vocalLanguage),
  }));

  fastify.post<{
    Body: {
      prompt?: string;
      title?: string;
      style?: string;
    };
  }>('/cover', async (request, reply) => {
    try {
      const url = await generateCoverArt({
        prompt: request.body?.prompt,
        title: request.body?.title,
        style: request.body?.style,
      });
      return { url, status: 'ready' };
    } catch (err: any) {
      request.log.error(err, '[VibeRouter] Cover art generation failed');
      return reply.code(502).send({ error: err?.message || 'Failed to generate cover art' });
    }
  });
}
