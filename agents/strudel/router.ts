import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  DRUMS_LIBRARY,
  HARMONY_LIBRARY,
  STRUDEL_ARCHETYPES_LIBRARY,
  SYNTHS_LIBRARY,
  cleanGeneratedStrudelCode,
  computeStrudelTheoryReference,
  getDrumsLibraryContext,
  getHarmonyLibraryContext,
  getSynthsLibraryContext,
  resolveComposerGraph,
  resolveSongStrudelMetadata,
  runStrudelAgentStream,
  validateGeneratedStrudelPattern,
  type HarmonyTargetMode,
  type StrudelStreamEvent,
  type SynthTargetRole,
} from './service.js';

export const strudelComposeSchema = z.object({
  songId: z.string().optional(),
  prompt: z.string().refine((v) => v.trim().length > 0, { message: 'Prompt is required' }),
  currentCode: z.string().optional(),
  bpm: z.number().finite().min(30).max(300).optional(),
  keyScale: z.string().optional(),
  stylePrompt: z.string().optional(),
  timeSignature: z.string().optional(),
  selectedTrack: z.string().optional(),
  selection: z
    .object({
      start: z.number().finite().min(0),
      end: z.number().finite().min(0),
      trackId: z.string().optional(),
    })
    .optional(),
  playhead: z.number().finite().min(0).optional(),
  stems: z.array(z.string()).optional(),
  tracks: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        muted: z.boolean().optional(),
        solo: z.boolean().optional(),
      })
    )
    .optional(),
  songContext: z.string().max(4000).optional(),
  musicalContext: z.string().max(4000).optional(),
  musical_context: z.string().max(4000).optional(),
  stream: z.boolean().optional(),
});

export async function strudelRouter(fastify: FastifyInstance) {
  /**
   * POST /strudel (or /api/strudel)
   * Primary Algorithmic Composer Agent endpoint (Directed-Graph + ReAct on Nemotron-3-Ultra).
   * Supports both NDJSON streaming (`stream: true` or `Accept: application/x-ndjson`) and JSON response.
   */
  fastify.post('/', async (request, reply) => {
    try {
      const p = strudelComposeSchema.parse(request.body);
      const resolvedContext = (p.songContext || p.musicalContext || p.musical_context || '').trim();
      const composeParams = {
        songId: p.songId,
        prompt: p.prompt.trim(),
        currentCode: p.currentCode,
        bpm: p.bpm,
        keyScale: p.keyScale,
        stylePrompt: p.stylePrompt,
        timeSignature: p.timeSignature,
        selectedTrack: p.selectedTrack,
        selection: p.selection,
        playhead: p.playhead,
        stems: p.stems,
        tracks: p.tracks,
        musicalContext: resolvedContext || undefined,
      };

      const wantsStream =
        p.stream === true ||
        String(request.headers.accept || '')
          .toLowerCase()
          .includes('application/x-ndjson');

      if (wantsStream) {
        const stream = new PassThrough();
        const emit = (event: StrudelStreamEvent) => {
          if (!stream.destroyed) {
            stream.write(`${JSON.stringify(event)}\n`);
          }
        };

        void (async () => {
          try {
            await runStrudelAgentStream({
              request: composeParams,
              emit,
            });
          } catch (err: any) {
            request.log.error(err, '[StrudelRouter] Agent stream failed');
            emit({
              type: 'error',
              message: err?.message || 'Algorithmic Composer agent failed',
            });
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
      }

      const result = await runStrudelAgentStream({
        request: composeParams,
        emit: () => {},
      });

      return reply.send({
        code: result.code,
        reasoning: result.reasoning || undefined,
        graph: {
          intent: result.graph.intent,
          targetLayers: result.graph.targetLayers,
          mountedLibraries: result.graph.mountedLibraries,
          archetypeId: result.graph.archetypeId,
          archetypeLabel: result.graph.archetypeLabel,
          refRole: result.graph.refRole,
          sectionNode: result.graph.sectionNode,
          estimatedTokens: result.graph.estimatedTokens,
        },
      });
    } catch (err: any) {
      request.log.error(err, '[StrudelRouter] Generation error');
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 500).send({
        error: err.message || 'Failed to generate Strudel pattern',
      });
    }
  });

  /**
   * Nested free per-library & diagnostic endpoints (/strudel/*)
   * Allow inspecting modular internal libraries or testing the <1ms Directed-Graph router directly.
   */
  fastify.get('/drums', async () => ({
    drums: DRUMS_LIBRARY,
    context: getDrumsLibraryContext(),
  }));

  fastify.get<{
    Querystring: { keyScale?: string; mode?: HarmonyTargetMode };
  }>('/harmony', async (request) => {
    const keyScale = request.query?.keyScale || 'C minor';
    const mode: HarmonyTargetMode =
      request.query?.mode === 'bass' ||
      request.query?.mode === 'chords' ||
      request.query?.mode === 'arp'
        ? request.query.mode
        : 'full';
    const reference = computeStrudelTheoryReference(keyScale);
    return {
      harmony: HARMONY_LIBRARY,
      reference,
      context: getHarmonyLibraryContext(reference, mode),
    };
  });

  fastify.get<{
    Querystring: { role?: SynthTargetRole };
  }>('/synths', async (request) => {
    const role: SynthTargetRole =
      request.query?.role === 'bass' ||
      request.query?.role === 'chords' ||
      request.query?.role === 'arp' ||
      request.query?.role === 'transform'
        ? request.query.role
        : 'full';
    return {
      synths: SYNTHS_LIBRARY,
      context: getSynthsLibraryContext(role),
    };
  });

  fastify.get('/archetypes', async () => ({
    archetypes: STRUDEL_ARCHETYPES_LIBRARY,
  }));

  fastify.post('/graph', async (request, reply) => {
    try {
      const p = strudelComposeSchema.parse(request.body);
      const resolvedContext = (p.songContext || p.musicalContext || p.musical_context || '').trim();
      const windowStart = p.selection?.start ?? p.playhead ?? 0;
      const windowEnd =
        p.selection?.end && p.selection.end > windowStart ? p.selection.end : windowStart + 8;
      const songMeta = await resolveSongStrudelMetadata(p.songId, windowStart, windowEnd);
      const graph = resolveComposerGraph(
        {
          songId: p.songId,
          prompt: p.prompt.trim(),
          currentCode: p.currentCode,
          bpm: p.bpm,
          keyScale: p.keyScale,
          stylePrompt: p.stylePrompt,
          timeSignature: p.timeSignature,
          selectedTrack: p.selectedTrack,
          selection: p.selection,
          playhead: p.playhead,
          stems: p.stems,
          tracks: p.tracks,
          musicalContext: resolvedContext || undefined,
        },
        songMeta
      );
      return reply.send(graph);
    } catch (err: any) {
      return reply.status(err instanceof z.ZodError ? 400 : err.statusCode || 400).send({
        error: err.message || 'Failed to resolve Strudel composer graph',
      });
    }
  });

  fastify.post<{
    Body: { code?: string };
  }>('/validate', async (request) => {
    const raw = String(request.body?.code || '');
    const cleaned = cleanGeneratedStrudelCode(raw);
    const validation = validateGeneratedStrudelPattern(cleaned);
    return {
      cleaned,
      ...validation,
    };
  });
}
