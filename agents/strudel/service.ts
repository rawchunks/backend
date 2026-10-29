import type { LyricsAlignment } from '../../databases/schema/takes.js';
import {
  DRUMS_LIBRARY,
  DRUM_TOKEN_CATEGORIES,
  EUCLIDEAN_DRUM_CELLS,
  getDrumsLibraryContext,
} from './drums.js';
import {
  HARMONY_LIBRARY,
  computeStrudelTheoryReference,
  getHarmonyLibraryContext,
  type HarmonyTargetMode,
  type StrudelTheoryReference,
} from './harmony.js';
import {
  SYNTHS_LIBRARY,
  SUPPORTED_METHODS,
  SUPPORTED_OSCILLATORS,
  UNSUPPORTED_METHODS,
  cleanGeneratedStrudelCode,
  getSynthsLibraryContext,
  validateGeneratedStrudelPattern,
  type SynthTargetRole,
} from './synths.js';
import {
  STRUDEL_ARCHETYPES_LIBRARY,
  getArchetypeContext,
  matchStrudelArchetype,
  type ArchetypeId,
  type StrudelArchetype,
} from './archetypes.js';
import {
  buildStrudelComposerMessages,
  classifyReferenceRoleEdge,
  classifySectionEnergyNode,
  resolveComposerGraph,
  type ComposeStrudelParams,
  type ComposerGraphResolution,
  type ReferenceRoleEdge,
  type SectionEnergyNode,
  type SongStrudelMetadata,
  type StrudelLayerType,
} from './graph.js';

export const ALGORITHMIC_COMPOSER_MODEL = 'nvidia/Nemotron-3-Ultra-550b-a55b';
export const NEBIUS_API_URL = 'https://api.studio.nebius.com/v1/chat/completions';

export type StrudelStreamEvent =
  | { type: 'status'; step: string }
  | {
      type: 'graph';
      intent: 'compose' | 'transform';
      targetLayers: StrudelLayerType[];
      mountedLibraries: Array<'drums' | 'harmony' | 'synths' | 'archetypes'>;
      archetypeId: ArchetypeId;
      archetypeLabel: string;
      refRole: ReferenceRoleEdge;
      sectionNode: SectionEnergyNode;
      estimatedTokens: number;
    }
  | { type: 'reasoning'; text: string }
  | { type: 'code'; code: string }
  | { type: 'done'; code: string; reasoning?: string }
  | { type: 'error'; message: string };

function getNebiusApiKey(): string {
  const key = process.env.NEBIUS_API_KEY;
  if (!key) {
    throw Object.assign(new Error('NEBIUS_API_KEY is not configured'), { statusCode: 500 });
  }
  return key;
}

export const STRUDEL_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_drums_library',
      description:
        'Read the Rawchunks Strudel drum token & Euclidean rhythm library on-demand (kicks, snares, hats, perc, cymbals, and Euclidean cells).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_harmony_library',
      description:
        'Read the diatonic scale, bass root, and 7th chord voicing library for a specific musical key/scale and target mode.',
      parameters: {
        type: 'object',
        properties: {
          keyScale: {
            type: 'string',
            description: 'Musical key and scale (e.g., "F minor", "C dorian", "G major").',
          },
          mode: {
            type: 'string',
            enum: ['bass', 'chords', 'arp', 'full'],
            description: 'Target harmonic slice to inspect.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_synths_library',
      description:
        'Read the Rawchunks Strudel synth oscillator, filter, and DSP modifier library for a target role.',
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['bass', 'chords', 'arp', 'transform', 'full'],
            description: 'Target synth role to inspect.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_archetypes_library',
      description:
        'Read an idiomatic genre/groove Strudel archetype blueprint on-demand (e.g., techno, acid, ukg, boombap, house, dnb, trap, synthwave, ambient, funk).',
      parameters: {
        type: 'object',
        properties: {
          genre: {
            type: 'string',
            description: 'Genre or groove style keyword to look up.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_strudel_pattern',
      description:
        'Commit and validate the final executable Rawchunks Strudel pattern code for the DAW REPL.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: {
            type: 'string',
            description:
              'Concise 1-sentence musical arrangement rationale (how the pattern locks to key, groove16/syncSlots, and section energy).',
          },
          code: {
            type: 'string',
            description:
              'Executable Rawchunks Strudel code (e.g. stack(...), s("..."), note("...").s("..."), n("...").scale("...")). No markdown fences or comments.',
          },
        },
        required: ['reasoning', 'code'],
        additionalProperties: false,
      },
    },
  },
];

interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Resolves song-level metadata (BPM, Key/Scale, Time Signature, Style, Active Section, Active Lyrics)
 * from the database for the current timeline window.
 */
export async function resolveSongStrudelMetadata(
  songId?: string,
  windowStartSec = 0,
  windowEndSec = 8
): Promise<SongStrudelMetadata> {
  if (!songId) return {};
  try {
    const [
      { getSongById },
      { listTakesBySong },
      { listCommitsBySong },
      { listStemsBySong },
      { sourceSettings },
    ] = await Promise.all([
      import('../../databases/songs.js'),
      import('../../databases/takes.js'),
      import('../../databases/commits.js'),
      import('../../databases/stems.js'),
      import('../../editing/service.js'),
    ]);

    const [song, takes, commits, stems] = await Promise.all([
      getSongById(songId).catch(() => null),
      listTakesBySong(songId).catch(() => []),
      listCommitsBySong(songId).catch(() => []),
      listStemsBySong(songId).catch(() => []),
    ]);

    if (!song && takes.length === 0) return {};

    const baseTake =
      takes.find((t) => t.is_active && t.stem_id === null) ||
      takes.find((t) => t.task === 'text2music') ||
      takes.find((t) => t.is_active) ||
      takes[0];

    const inherited = baseTake ? sourceSettings(baseTake, takes, commits) : {};

    let alignment: LyricsAlignment | null = null;
    for (const take of takes) {
      const candidate = (take.provenance as any)?.lyricsAlignment;
      if (candidate && Array.isArray(candidate.lines) && candidate.lines.length > 0) {
        alignment = candidate as LyricsAlignment;
        break;
      }
    }

    let activeSection: string | undefined;
    let activeLyrics: string | undefined;
    const rawLyrics: string = inherited.lyrics || baseTake?.lyrics || '';

    if (alignment && Array.isArray(alignment.lines) && alignment.lines.length > 0) {
      let currentSection = 'Intro';
      const matchingLines: string[] = [];
      for (const line of alignment.lines) {
        const text = (line.text || '').trim();
        if (!text) continue;
        if (line.isTag || /^\s*\[[^\]]+\]\s*$/.test(text)) {
          if (line.start === null || line.start <= windowEndSec) {
            currentSection = text.replace(/^\[|\]$/g, '').trim();
          }
          continue;
        }
        if (line.start !== null && line.end !== null) {
          if (line.end >= windowStartSec - 1.5 && line.start <= windowEndSec + 1.5) {
            matchingLines.push(text);
          }
        }
      }
      activeSection = currentSection;
      if (matchingLines.length > 0) {
        activeLyrics = matchingLines.slice(0, 2).join(' / ').slice(0, 160);
      }
    } else if (rawLyrics.trim()) {
      const tagMatches = Array.from(rawLyrics.matchAll(/\[([A-Za-z0-9\s#-]+)\]/g)).map((m) => m[1].trim());
      if (tagMatches.length > 0) {
        activeSection = tagMatches[0];
      }
    }

    const stemNames = stems
      .map((s) => s.name)
      .filter((name) => name && name.toLowerCase() !== 'master');

    return {
      stylePrompt: inherited.prompt || baseTake?.prompt || undefined,
      tags: Array.isArray(song?.tags) ? (song!.tags as string[]) : undefined,
      bpm: typeof inherited.bpm === 'number' && Number.isFinite(inherited.bpm) ? inherited.bpm : undefined,
      keyScale: typeof inherited.keyScale === 'string' && inherited.keyScale.trim() ? inherited.keyScale.trim() : undefined,
      timeSignature:
        typeof inherited.timeSignature === 'string' && inherited.timeSignature.trim()
          ? inherited.timeSignature.trim()
          : undefined,
      stems: stemNames.length > 0 ? stemNames : undefined,
      activeSection,
      activeLyrics,
    };
  } catch {
    return {};
  }
}

function getActiveToolsForGraph(
  mountedLibraries: ReadonlyArray<'drums' | 'harmony' | 'synths' | 'archetypes'>
) {
  const mounted = new Set(mountedLibraries);
  return STRUDEL_AGENT_TOOLS.filter((tool) => {
    const name = tool.function.name;
    if (name === 'read_drums_library' && mounted.has('drums')) return false;
    if (name === 'read_harmony_library' && mounted.has('harmony')) return false;
    if (name === 'read_synths_library' && mounted.has('synths')) return false;
    if (name === 'read_archetypes_library' && mounted.has('archetypes')) return false;
    return true;
  });
}

/**
 * Streams a single ReAct tool-calling turn from nvidia/Nemotron-3-Ultra-550b-a55b
 * with thinking disabled for near-zero latency.
 */
async function streamNebiusStrudelTurn(
  messages: any[],
  tools: typeof STRUDEL_AGENT_TOOLS,
  toolChoice: 'auto' | 'required',
  onToolCallReady: (call: StreamToolCall) => Promise<void> | void,
  signal?: AbortSignal
): Promise<{ calls: StreamToolCall[]; textContent: string }> {
  const apiKey = getNebiusApiKey();
  const response = await fetch(NEBIUS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: ALGORITHMIC_COMPOSER_MODEL,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature: 0.4,
      max_tokens: 900,
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw Object.assign(
      new Error(`Nemotron Strudel composer turn failed (${response.status}): ${errText}`),
      { statusCode: 502 }
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textContent = '';

  const toolCallsByIndex = new Map<number, StreamToolCall>();
  const emittedIndices = new Set<number>();

  const flushCompletedUpTo = async (maxExclusiveIndex: number) => {
    for (const [idx, call] of toolCallsByIndex.entries()) {
      if (idx < maxExclusiveIndex && !emittedIndices.has(idx) && call.name) {
        emittedIndices.add(idx);
        await onToolCallReady(call);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = parsed?.choices?.[0]?.delta;
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        textContent += delta.content;
      }

      const deltaToolCalls = delta?.tool_calls;
      if (Array.isArray(deltaToolCalls)) {
        for (const tc of deltaToolCalls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (idx > 0) {
            await flushCompletedUpTo(idx);
          }
          const existing = toolCallsByIndex.get(idx) || {
            id: tc.id || `call_${idx}`,
            name: '',
            arguments: '',
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCallsByIndex.set(idx, existing);
        }
      }
    }
  }

  await flushCompletedUpTo(Number.MAX_SAFE_INTEGER);
  return {
    calls: Array.from(toolCallsByIndex.values()),
    textContent: textContent.trim(),
  };
}

/**
 * Orchestrates the Algorithmic Composer (/strudel) workflow using a Directed-Graph + ReAct architecture:
 * 1. Resolves song & timeline metadata (key, tempo, active section, aligned lyrics).
 * 2. Traverses the Composer Directed Graph in <1ms to pre-mount ONLY the required library slices (~60% token savings).
 * 3. Runs a streaming ReAct loop on nvidia/Nemotron-3-Ultra-550b-a55b with on-demand library tools and AST validation inside `set_strudel_pattern`.
 */
export async function runStrudelAgentStream(params: {
  request: ComposeStrudelParams;
  emit: (event: StrudelStreamEvent) => void;
  signal?: AbortSignal;
}): Promise<{ code: string; reasoning: string; graph: ComposerGraphResolution }> {
  const { request, emit, signal } = params;

  const windowStart = request.selection?.start ?? request.playhead ?? 0;
  const windowEnd =
    request.selection?.end && request.selection.end > windowStart
      ? request.selection.end
      : windowStart + 8;

  const songMeta = await resolveSongStrudelMetadata(request.songId, windowStart, windowEnd);
  const graph = resolveComposerGraph(request, songMeta);

  emit({
    type: 'graph',
    intent: graph.intent,
    targetLayers: graph.targetLayers,
    mountedLibraries: graph.mountedLibraries,
    archetypeId: graph.archetypeId,
    archetypeLabel: graph.archetypeLabel,
    refRole: graph.refRole,
    sectionNode: graph.sectionNode,
    estimatedTokens: graph.estimatedTokens,
  });

  emit({
    type: 'status',
    step: `Graph routed [${graph.targetLayers.join('+').toUpperCase()}] • ${graph.archetypeLabel} (${graph.estimatedTokens} tok)`,
  });

  let committedCode = '';
  let committedReasoning = '';
  let lastValidationError = '';

  const handleReActTool = (call: StreamToolCall): string => {
    let args: Record<string, any> = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      args = {};
    }

    switch (call.name) {
      case 'read_drums_library': {
        emit({ type: 'status', step: 'Reading Drums & Euclidean Library...' });
        return getDrumsLibraryContext();
      }
      case 'read_harmony_library': {
        emit({ type: 'status', step: 'Reading Harmony & Voicings Library...' });
        const customTheory = args.keyScale
          ? computeStrudelTheoryReference(String(args.keyScale))
          : graph.theory;
        const mode: HarmonyTargetMode =
          args.mode === 'bass' || args.mode === 'chords' || args.mode === 'arp'
            ? args.mode
            : 'full';
        return getHarmonyLibraryContext(customTheory, mode);
      }
      case 'read_synths_library': {
        emit({ type: 'status', step: 'Reading Synth & Filter Library...' });
        const role: SynthTargetRole =
          args.role === 'bass' ||
          args.role === 'chords' ||
          args.role === 'arp' ||
          args.role === 'transform'
            ? args.role
            : 'full';
        return getSynthsLibraryContext(role);
      }
      case 'read_archetypes_library': {
        emit({ type: 'status', step: 'Reading Genre Archetypes Library...' });
        const matched = matchStrudelArchetype({
          prompt: typeof args.genre === 'string' ? args.genre : request.prompt,
          bpm: request.bpm ?? songMeta.bpm,
        });
        return getArchetypeContext(matched, graph.theory, new Set(graph.targetLayers));
      }
      case 'set_strudel_pattern': {
        const reasoning = typeof args.reasoning === 'string' ? args.reasoning.trim() : '';
        const rawCode = typeof args.code === 'string' ? args.code : '';
        if (reasoning) {
          committedReasoning = reasoning;
          emit({ type: 'reasoning', text: reasoning });
        }

        const cleaned = cleanGeneratedStrudelCode(rawCode);
        const validation = validateGeneratedStrudelPattern(cleaned);
        if (!validation.valid) {
          lastValidationError = validation.error || 'Invalid Strudel syntax';
          emit({ type: 'status', step: `Repairing pattern syntax: ${lastValidationError}` });
          return `validation_error: ${lastValidationError}. Fix the syntax immediately and call set_strudel_pattern with valid Rawchunks Strudel code using only supported methods (.s(), .scale(), .fast(), .slow(), .rev(), .gain(), .lpf(), .hpf(), .pan(), .room(), .delay()).`;
        }

        committedCode = cleaned;
        lastValidationError = '';
        emit({ type: 'code', code: cleaned });
        return 'ok';
      }
      default:
        return 'unknown_tool';
    }
  };

  const messages: any[] = [...graph.messages];
  const activeMountedLibraries = new Set<'drums' | 'harmony' | 'synths' | 'archetypes'>(
    graph.mountedLibraries
  );

  // Up to 3 ReAct turns:
  // Turn 1 typically calls set_strudel_pattern directly (since the Directed Graph pre-mounted the required slices).
  // If Turn 1 calls an unmounted read_*_library tool or hits an AST validation error inside set_strudel_pattern, Turn 2/3 completes it.
  for (let turn = 0; turn < 3; turn++) {
    const toolOutputs: { call: StreamToolCall; output: string }[] = [];
    const activeTools = getActiveToolsForGraph(Array.from(activeMountedLibraries));
    const { calls, textContent } = await streamNebiusStrudelTurn(
      messages,
      activeTools,
      'required',
      async (call) => {
        if (call.name === 'read_drums_library') activeMountedLibraries.add('drums');
        if (call.name === 'read_harmony_library') activeMountedLibraries.add('harmony');
        if (call.name === 'read_synths_library') activeMountedLibraries.add('synths');
        if (call.name === 'read_archetypes_library') activeMountedLibraries.add('archetypes');
        const output = handleReActTool(call);
        toolOutputs.push({ call, output });
      },
      signal
    );

    if (committedCode) {
      break;
    }

    if (!calls.length && textContent) {
      const cleaned = cleanGeneratedStrudelCode(textContent);
      const validation = validateGeneratedStrudelPattern(cleaned);
      if (validation.valid) {
        committedCode = cleaned;
        emit({ type: 'code', code: cleaned });
        break;
      }
      lastValidationError = validation.error || 'Invalid Strudel syntax';
      messages.push({ role: 'assistant', content: cleaned || textContent });
      messages.push({
        role: 'user',
        content: `Your Strudel pattern failed validation: ${lastValidationError}. Call set_strudel_pattern with the corrected, valid Strudel code.`,
      });
      continue;
    }

    if (!calls.length) break;

    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' },
      })),
    });

    for (const { call, output } of toolOutputs) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: output,
      });
    }
  }

  if (!committedCode) {
    throw Object.assign(
      new Error(
        `Invalid Strudel pattern returned from model${lastValidationError ? `: ${lastValidationError}` : ''}`
      ),
      { statusCode: 502 }
    );
  }

  emit({
    type: 'done',
    code: committedCode,
    reasoning: committedReasoning || undefined,
  });

  return {
    code: committedCode,
    reasoning: committedReasoning,
    graph,
  };
}

/**
 * Generates a validated Strudel pattern using the Directed-Graph + ReAct Algorithmic Composer.
 */
export async function generateStrudelPattern(params: ComposeStrudelParams): Promise<string> {
  const result = await runStrudelAgentStream({
    request: params,
    emit: () => {},
  });
  return result.code;
}

export {
  DRUMS_LIBRARY,
  DRUM_TOKEN_CATEGORIES,
  EUCLIDEAN_DRUM_CELLS,
   getDrumsLibraryContext,
  HARMONY_LIBRARY,
  computeStrudelTheoryReference,
  getHarmonyLibraryContext,
  SYNTHS_LIBRARY,
  SUPPORTED_METHODS,
  SUPPORTED_OSCILLATORS,
  UNSUPPORTED_METHODS,
  cleanGeneratedStrudelCode,
  getSynthsLibraryContext,
  validateGeneratedStrudelPattern,
  STRUDEL_ARCHETYPES_LIBRARY,
  getArchetypeContext,
  matchStrudelArchetype,
  buildStrudelComposerMessages,
  classifyReferenceRoleEdge,
  classifySectionEnergyNode,
  resolveComposerGraph,
  type ComposeStrudelParams,
  type ComposerGraphResolution,
  type HarmonyTargetMode,
  type ReferenceRoleEdge,
  type SectionEnergyNode,
  type SongStrudelMetadata,
  type StrudelArchetype,
  type StrudelLayerType,
  type StrudelTheoryReference,
  type SynthTargetRole,
  type ArchetypeId,
};
