import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getSongById, getSongByTitleSlug, isPublicInMode } from '../databases/songs.js';
import { checkUserOrPair, readSong, readUser, RequestError } from '../databases/users.js';
import { getEditorLyrics, getPublicLyrics, processSongLyrics } from './service.js';

const syncBody = z.object({
  vocalLanguage: z.string().max(16).optional(),
  lyrics: z.string().max(40_000).optional(),
  mode: z.enum(['extract', 'align']).optional(),
});

export const scribeRouter: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /lyrics/:id (or /api/lyrics/:id)
   * Independent lyrics endpoint decoupled from DAW editing and downstream consumers:
   * - Default (`public` scope): returns clean sung `alignment` (strictly zero `[bracketed]` tags)
   *   and `status: 'cached' | 'transcribing' | 'none'`.
   * - `?scope=editor`: creator-authenticated view returning raw `lyrics` (including `[Section]`
   *   tags), `vocalLanguage`, `alignment`, and `status: 'cached' | 'transcribing' | 'aligning' | 'none'`.
   */
  fastify.get<{
    Params: { id: string };
    Querystring: { creator?: string; language?: string; scope?: string };
  }>('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const creator = typeof request.query?.creator === 'string' ? request.query.creator.trim() : undefined;
      const language = typeof request.query?.language === 'string' ? request.query.language.trim() : undefined;
      const scope = request.query?.scope === 'editor' ? 'editor' : 'public';

      const song = (await getSongById(id)) ?? (await getSongByTitleSlug(id, creator));
      if (!song) {
        return reply.code(404).send({ error: 'Song not found' });
      }

      if (scope === 'editor') {
        await readSong(request, song.id);
        const result = await getEditorLyrics(song.id, language);
        return reply.send({ songId: song.id, ...result });
      }

      if (!isPublicInMode(song)) {
        let isOwner = false;
        try {
          const userAddress = readUser(request);
          await checkUserOrPair(userAddress, song.creator);
          isOwner = true;
        } catch {
          isOwner = false;
        }
        if (!isOwner) {
          await readSong(request, song.id);
        }
      }

      const result = await getPublicLyrics(song.id, language);
      return reply.send({ songId: song.id, ...result });
    } catch (err: any) {
      if (err instanceof RequestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      request.log.error(err, '[ScribeRouter] Failed to load song lyrics');
      return reply.code(err?.statusCode || 500).send({ error: err?.message || 'Failed to load lyrics' });
    }
  });

  /**
   * POST /lyrics/:id (or /api/lyrics/:id)
   * Creator-authenticated on-demand alignment (`mode: 'align'`) or transcription (`mode: 'extract'`).
   * Serialized under the same Valkey `lock:scribe:${songId}` as the background async queue so
   * Editor actions and background transcription never race or duplicate work.
   */
  fastify.post<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { song } = await readSong(request, id);
      if (song?.metadata_cid) {
        return reply.code(409).send({ error: 'Open an editable version before changing this song' });
      }

      const body = syncBody.parse(request.body ?? {});
      const mode = body.mode ?? (body.lyrics?.trim() ? 'align' : 'extract');
      const result = await processSongLyrics(song.id, {
        force: true,
        mode,
        lyrics: body.lyrics,
        languageCode: body.vocalLanguage,
      });

      if (!result) {
        return reply.code(409).send({ error: 'No audio available for lyrics processing' });
      }

      return reply.send({ songId: song.id, ...result });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: err.message });
      }
      if (err instanceof RequestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      request.log.error(err, '[ScribeRouter] Failed to process song lyrics');
      return reply.code(err?.statusCode || 500).send({ error: err?.message || 'Failed to process lyrics' });
    }
  });
};
