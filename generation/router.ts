import { stateStreams } from '../broker/stream.js';
import { subscribeTask } from '../broker/valkey.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { generateSchema } from './schema.js';
import { generationService } from './service.js';
import { acestepClient } from './client.js';
import { randomUUID } from 'node:crypto';
import { uploadToR2 } from '../storage/r2.js';

const coverSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().optional(),
  style: z.string().optional(),
});

function storeCover(bytes: Buffer, mimeType: string) {
  if (!bytes.length || !/^image\/[\w.+-]+$/.test(mimeType)) throw Object.assign(new Error('Upload an image file'), { statusCode: 400 });
  return uploadToR2('songs', `covers/${randomUUID()}`, bytes, mimeType);
}

import { requireSessionPayment } from '../broker/payment.js';

const generationPricing = (request: any) => {
  const isMaster = request.body?.modelVariant === 'sft';
  return isMaster
    ? { amountWei: '100000', priceUsd: 0.10, action: 'generation-master' }
    : { amountWei: '50000', priceUsd: 0.05, action: 'generation-fast' };
};

export const generationRouter: FastifyPluginAsync = async (fastify) => {
  const streamState = stateStreams(fastify);
  fastify.post('/generate', { preHandler: [requireSessionPayment(generationPricing)] }, async (request, reply) => {
    try {
      if (request.body && typeof request.body === 'object' && !(request.body as any).creatorAddress) {
        const authedUser = request.headers['x-session-user-address'];
        if (typeof authedUser === 'string') (request.body as any).creatorAddress = authedUser;
      }
      const parsed = generateSchema.parse(request.body);
      const result = await generationService.initiateGeneration(parsed);
      return reply.status(202).send(result);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Generation failed to initiate' });
    }
  });

  fastify.get('/status/:taskId', async (request, reply) => {
    try {
      const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
      const { songId } = z.object({ songId: z.string().min(1) }).parse(request.query);
      const result = await generationService.checkStatusAndFinalize(taskId, songId);
      return reply.send(result);
    } catch (err: any) {
      request.log.error(err);
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Failed to check status' });
    }
  });

  fastify.get('/events/:taskId', async (request, reply) => {
    let taskId: string, songId: string;
    try {
      ({ taskId } = z.object({ taskId: z.string().min(1).max(256) }).parse(request.params));
      ({ songId } = z.object({ songId: z.string().min(1) }).parse(request.query));
    } catch (error: any) { return reply.code(400).send({ error: error.message }); }
    return streamState(request, reply, {
      read: () => generationService.checkStatusAndFinalize(taskId, songId),
      terminal: result => ['ready', 'error'].includes(result.status),
      subscribe: (message, error) => subscribeTask(taskId, message, error),
      event: (value, send, update) => {
        const event = JSON.parse(value);
        if (['succeeded', 'failed'].includes(event.status)) void update();
        else send({ status: event.status === 'running' ? 'processing' : 'pending', progress: Math.round((event.progress ?? 0) * 100) });
      },
    });
  });

  fastify.post('/format', async (request, reply) => {
    try {
      const { prompt, lyrics } = z.object({ prompt: z.string().refine((value) => value.trim().length > 0), lyrics: z.string().optional() }).parse(request.body);
      return reply.send(await acestepClient.formatInput(prompt, lyrics));
    } catch (err: any) {
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Failed to format input' });
    }
  });

  fastify.post('/sample', async (request, reply) => {
    try {
      const { query, instrumental, vocalLanguage } = z.object({ query: z.string().optional(), instrumental: z.boolean().optional(), vocalLanguage: z.string().optional() }).parse(request.body);
      return reply.send(await acestepClient.createSample(query || 'electronic', instrumental ?? false, vocalLanguage));
    } catch (err: any) {
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({ error: err.message || 'Failed to create sample' });
    }
  });

  fastify.post('/cover', async (request, reply) => {
    try {
      if (request.isMultipart()) {
        let image: { bytes: Buffer; mimeType: string } | undefined;
        for await (const file of request.files({ limits: { files: 1 } })) {
          image = { bytes: await file.toBuffer(), mimeType: file.mimetype };
        }
        if (!image) return reply.status(400).send({ error: 'Upload an image file' });
        const imageUrl = await storeCover(image.bytes, image.mimeType);
        return reply.send({ imageUrl });
      }
      const { prompt, title, style } = coverSchema.parse(request.body);
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        return reply.status(500).send({ error: 'GOOGLE_GENERATIVE_AI_API_KEY is not configured' });
      }

      // Minimal $Brand - one-line summary of landing/src/lib/theme.ts
      const brand = 'underground acid cyberpunk aesthetic with neon green (#00ff41), hot punk magenta (#ff00a0), and cyber cyan (#00ccff) on deep black';
      const promptParts = [prompt.trim()];
      if (title?.trim()) promptParts.push(title.trim());
      if (style?.trim()) promptParts.push(style.trim());
      const basedOn = promptParts.join(', ');
      const textPrompt = `Minimal cover for a song, based on ${basedOn}. No text. Style: ${brand}`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: textPrompt }] }],
            generationConfig: {
              responseModalities: ['IMAGE'],
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        request.log.error({ status: response.status, errorText }, 'Gemini Nano Banana cover generation failed');
        return reply.status(502).send({ error: 'Failed to generate cover image' });
      }

      const data: any = await response.json();
      const candidatePart = data?.candidates?.[0]?.content?.parts?.find((part: any) => part.inlineData?.data);
      const inlineData = candidatePart?.inlineData;

      if (!inlineData?.data) {
        return reply.status(502).send({ error: 'No image data returned from cover model' });
      }

      const mimeType = inlineData.mimeType || 'image/jpeg';
      const imageUrl = await storeCover(Buffer.from(inlineData.data, 'base64'), mimeType);
      return reply.send({ imageUrl });
    } catch (err: any) {
      request.log.error(err);
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'Image file exceeds upload limit' });
      if (err.code === 'FST_FILES_LIMIT') return reply.status(400).send({ error: 'Upload one image file' });
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({
        error: err.message || 'Cover generation failed',
      });
    }
  });
};
