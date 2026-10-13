import { FastifyInstance } from 'fastify';
import { stateStreams } from '../broker/stream.js';
import { subscribeVoice } from '../broker/valkey.js';
import type { MultipartFile } from '@fastify/multipart';
import { voiceService } from './service.js';
import { validateVoiceFormat, validateVoiceCreator, VoiceInputError } from './format.js';
import { RequestError, checkUser, readUser, readSong } from '../databases/users.js';

const validText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function multipartText(field: unknown): string | undefined {
  if (field === undefined) return undefined;
  if (!field || typeof field !== 'object' || Array.isArray(field) || !('value' in field) || typeof field.value !== 'string') throw new VoiceInputError('Multipart text fields must be supplied once');
  return field.value;
}
function errorReply(reply: any, error: any, fallback: string) {
  if (error instanceof RequestError) return reply.status(error.statusCode).send({ error: error.message });
  const oversized = error?.code === 'FST_REQ_FILE_TOO_LARGE';
  if (error?.code === 'FST_FILES_LIMIT') return reply.status(400).send({ error: 'Upload one audio file' });
  const malformed = error instanceof VoiceInputError || error?.statusCode === 400 || /multipart|boundary|unexpected end|premature close/i.test(error?.message || '');
  return reply.status(oversized ? 413 : malformed ? 400 : 500).send({ error: oversized ? 'Audio file exceeds upload limit' : malformed ? (error instanceof VoiceInputError ? error.message : 'Invalid multipart request') : fallback });
}

import { requireSessionPayment } from '../broker/payment.js';

const voicePrice = { amountWei: '50000', priceUsd: 0.05, action: 'voice-train' };

export default async function voiceRoutes(app: FastifyInstance) {
  const streamState = stateStreams(app);
  // Flow (i): Save Voice from an existing generated song
  app.post<{
    Body: {
      songId: string;
      name?: string;
      creator: string;
    };
  }>('/', { preHandler: [requireSessionPayment(voicePrice)] }, async (req, reply) => {
    const { songId, name, creator } = req.body || {};
    if (!validText(songId) || !validText(creator) || (name !== undefined && typeof name !== 'string')) {
      return reply.status(400).send({ error: 'songId and creator are required' });
    }

    try {
      const userAddress = readUser(req);
      validateVoiceCreator(creator);
      await checkUser(userAddress, creator);
      const { song } = await readSong(req, songId);
      const result = await voiceService.cloneVoiceFromSong({ songId, name, creator: song.creator });
      return reply.status(202).send(result);
    } catch (err: any) {
      req.log.error(err);
      return errorReply(reply, err, 'Failed to clone voice from song');
    }
  });

  // Flow (ii): Pre-generation Voice Upload in Studio
  app.post('/upload', { preHandler: [requireSessionPayment(voicePrice)] }, async (req, reply) => {
    try {
      const userAddress = readUser(req);
      let data: MultipartFile | undefined;
      let buffer: Buffer | undefined;
      for await (const file of req.files({ limits: { files: 1 } })) {
        data = file;
        buffer = await file.toBuffer();
      }
      if (!data) {
        return reply.status(400).send({ error: 'No audio file uploaded' });
      }

      const creator = multipartText(data.fields.creator);
      const name = multipartText(data.fields.name);
      if (!validText(creator)) throw new VoiceInputError('creator is required');
      validateVoiceCreator(creator);
      await checkUser(userAddress, creator);
      validateVoiceFormat(buffer!, data.filename, data.mimetype);

      const result = await voiceService.cloneVoiceFromAudio({
        audioBuffer: buffer!,
        fileName: data.filename,
        mimeType: data.mimetype || 'audio/wav',
        name,
        creator,
      });

      return reply.status(202).send(result);
    } catch (err: any) {
      req.log.error(err);
      return errorReply(reply, err, 'Failed to process voice upload');
    }
  });

  // Query saved voices for a creator
  app.get<{
    Querystring: {
      creator?: string;
    };
  }>('/', async (req, reply) => {
    const { creator } = req.query;
    if (!validText(creator)) {
      return reply.status(400).send({ error: 'creator query parameter is required' });
    }

    try {
      const userAddress = readUser(req);
      validateVoiceCreator(creator);
      await checkUser(userAddress, creator);
      const voices = await voiceService.listVoices(creator);
      return reply.send({ voices });
    } catch (err: any) {
      req.log.error(err);
      return errorReply(reply, err, 'Failed to retrieve voices');
    }
  });

  app.get<{ Params: { id: string } }>('/:id/events', async (req, reply) => {
    try {
      const user = readUser(req);
      const voice = await voiceService.getVoice(req.params.id);
      if (!voice) return reply.status(404).send({ error: 'Voice not found' });
      await checkUser(user, voice.creator);
      return streamState(req, reply, {
        read: async () => {
          const current = await voiceService.getVoice(req.params.id);
          if (!current) throw new Error('Voice not found');
          await checkUser(user, current.creator);
          return { voice: current, status: current.status, ...(current.error ? { error: current.error } : {}) };
        },
        terminal: state => ['ready', 'error'].includes(state.status),
        subscribe: (message, error) => subscribeVoice(req.params.id, message, error),
        intervalMs: 5000,
      });
    } catch (error: any) { return errorReply(reply, error, 'Failed to retrieve voice events'); }
  });

  // Get specific voice by ID
  app.get<{
    Params: {
      id: string;
    };
  }>('/:id', async (req, reply) => {
    try {
      const userAddress = readUser(req);
      const voice = await voiceService.getVoice(req.params.id);
      if (!voice) {
        return reply.status(404).send({ error: 'Voice not found' });
      }
      await checkUser(userAddress, voice.creator);
      return reply.send({ voice });
    } catch (err: any) {
      req.log.error(err);
      return errorReply(reply, err, 'Failed to retrieve voice');
    }
  });
}
