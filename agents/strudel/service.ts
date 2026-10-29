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
