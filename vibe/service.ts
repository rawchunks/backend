import { generateCoverArt } from '../generation/router.js';
import { LYRICS_CANVAS_TAGS, LYRICS_SYSTEM_PROMPT, getLyricsLibraryContext } from './lyrics.js';
import { STYLE_TAGS_LIBRARY, getStylesLibraryContext, normalizeStyleTags } from './styles.js';
import {
  PARAMETERS_LIBRARY,
  getParametersLibraryContext,
  normalizeBpm,
  normalizeDuration,
  normalizeKeyScale,
  normalizeLanguage,
} from './parameters.js';

export const SONGWRITER_MODEL = 'nvidia/Nemotron-3-Ultra-550b-a55b';
export const VISION_PROMPT_MODEL = 'nvidia/Nemotron-3.5-Super-VL';
export const VISION_SYSTEM_PROMPT =
  "Turn this image into a prompt to write a song's lyrics. Grasp image's mood, theme, subtext, etc. (no need to describe every visual/geometric detail) - and turn it into a *NATURAL* user/human message for a prompt. Understand the abstract and poetic nuances. Be detailed and concise. No extra fluff.";
const NEBIUS_API_URL = 'https://api.studio.nebius.com/v1/chat/completions';

export type VibeStreamEvent =
  | { type: 'status'; step: string }
  | {
    type: 'field';
    field:
    | 'title'
    | 'prompt'
    | 'instrumental'
    | 'vocalLanguage'
    | 'tags'
    | 'bpm'
    | 'keyScale'
    | 'audioDuration';
    value: any;
  }
  | { type: 'lyrics_start' }
  | { type: 'lyrics_delta'; delta: string }
  | { type: 'cover_start' }
  | { type: 'cover'; imageUrl: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

function getNebiusApiKey(): string {
  const key = process.env.NEBIUS_API_KEY;
  if (!key) {
    throw Object.assign(new Error('NEBIUS_API_KEY is not configured'), { statusCode: 500 });
  }
  return key;
}

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_styles_library',
      description: 'Read the Studio style tags library to see valid sonic/production tags.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_parameters_library',
      description: 'Read the Studio global parameters library (valid BPM range, musical keys/scales, durations, and language codes).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_lyrics_library',
      description: 'Read the Lyrics Canvas bracketed tags library (Structure, Intensity, Solo, Vocal style tags).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_title',
      description: 'Populate the song title field.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Evocative, concise song title (2-5 words).' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_prompt',
      description: 'Populate the Studio musical prompt describing genre, rhythm, arrangement, instruments, and production vibe.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Rich sonic production prompt for AceStep (max 350 chars). Describe style, groove, instruments, and atmosphere.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_vocal_config',
      description: 'Configure whether the song is instrumental and its vocal language.',
      parameters: {
        type: 'object',
        properties: {
          instrumental: {
            type: 'boolean',
            description: 'true ONLY if the user explicitly asked for an instrumental/beat with no vocals; false otherwise.',
          },
          vocalLanguage: {
            type: 'string',
            description: '2-letter ISO language code. Default to "en" (or the language the user wrote the prompt in) unless the user explicitly asks for lyrics in another language.',
          },
        },
        required: ['instrumental', 'vocalLanguage'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_style_tags',
      description: 'Populate 1 to 5 Studio style tags from the styles library.',
      parameters: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '1 to 5 style tags from the Studio style library.',
          },
        },
        required: ['tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_global_parameters',
      description: 'Populate the global musical parameters (BPM, key & scale, and duration in seconds).',
      parameters: {
        type: 'object',
        properties: {
          bpm: { type: 'integer', description: 'Tempo in BPM (40-220).' },
          keyScale: { type: 'string', description: 'Musical key and scale, e.g. "A minor", "C major", "F# minor".' },
          audioDuration: { type: 'integer', description: 'Song duration in seconds (e.g. 90, 120, 180).' },
        },
        required: ['bpm', 'keyScale', 'audioDuration'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_cover',
      description: 'Invoke the Studio cover art generator function (no prompt needed; uses song context automatically).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Calls Nebius AI Studio with streaming enabled and yields completed tool calls incrementally as they finish streaming.
 */
async function streamNebiusToolTurn(
  messages: any[],
  toolChoice: 'auto' | 'required' = 'auto',
  onToolCallReady?: (call: StreamToolCall) => Promise<void> | void,
  signal?: AbortSignal
): Promise<StreamToolCall[]> {
  const apiKey = getNebiusApiKey();
  const response = await fetch(NEBIUS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: SONGWRITER_MODEL,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: toolChoice,
      temperature: 0.6,
      max_tokens: 1024,
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw Object.assign(new Error(`Nemotron request failed (${response.status}): ${errText}`), { statusCode: 502 });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallsByIndex = new Map<number, StreamToolCall>();
  const emittedIndices = new Set<number>();

  const flushCompletedUpTo = async (upToExclusiveIndex: number) => {
    for (const [idx, call] of toolCallsByIndex.entries()) {
      if (idx < upToExclusiveIndex && !emittedIndices.has(idx) && call.name) {
        emittedIndices.add(idx);
        if (onToolCallReady) await onToolCallReady(call);
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

      const deltaToolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
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
  return Array.from(toolCallsByIndex.values());
}

/**
 * Streams lyrics token-by-token from nvidia/Nemotron-3-Ultra-550b-a55b using the exact songwriter system prompt
 * and the independent Lyrics Canvas tag library.
 */
export async function streamSongLyrics(params: {
  userPrompt: string;
  sonicPrompt?: string;
  title?: string;
  vocalLanguage?: string;
  audioDuration?: number;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const apiKey = getNebiusApiKey();
  const lyricsLibContext = getLyricsLibraryContext();

  const userDirective = [
    `User Vibe Prompt: ${params.userPrompt.trim()}`,
    params.title ? `Song Title: ${params.title}` : '',
    params.sonicPrompt ? `Musical Style & Arrangement: ${params.sonicPrompt}` : '',
    params.vocalLanguage && params.vocalLanguage !== 'en'
      ? `Write the vocal lyrics in language code "${params.vocalLanguage}" (keep all [Bracketed] structural/vocal tags in English).`
      : '',
    params.audioDuration ? `Target Song Duration: ~${params.audioDuration}s` : '',
    '',
    lyricsLibContext,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await fetch(NEBIUS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: SONGWRITER_MODEL,
      messages: [
        { role: 'system', content: LYRICS_SYSTEM_PROMPT },
        { role: 'user', content: userDirective },
      ],
      temperature: 0.75,
      max_tokens: 1200,
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: params.signal,
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw Object.assign(new Error(`Nemotron lyrics stream failed (${response.status}): ${errText}`), {
      statusCode: 502,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullLyrics = '';

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

      const contentDelta = parsed?.choices?.[0]?.delta?.content;
      if (typeof contentDelta === 'string' && contentDelta.length > 0) {
        fullLyrics += contentDelta;
        params.onDelta(contentDelta);
      }
    }
  }

  return fullLyrics;
}

/**
 * Translates an attached image into a natural, concise human song prompt using nvidia/Nemotron-3.5-Super-VL
 * with thinking disabled for near-zero latency.
 * Invoked ONLY when the user attaches an image in the Vibe flow.
 */


/**
 * Orchestrates the full Songwriter Agent (/vibe) workflow in real-time:
 * 0. ONLY if an image is attached, translates the image into a natural song prompt via nvidia/Nemotron-3.5-Super-VL
 * 1. Nemotron-3-Ultra inspects the modular libraries on demand (read_styles_library, read_parameters_library, read_lyrics_library)
 * 2. Streams field updates (title, prompt, instrumental, vocalLanguage, tags, bpm, keyScale, audioDuration) live
 * 3. Invokes generateCoverArt directly in parallel (without generating an image prompt)
 * 4. Streams poetic, bracket-tagged lyrics token-by-token into the Lyrics Canvas
 */


export {
  LYRICS_CANVAS_TAGS,
  STYLE_TAGS_LIBRARY,
  PARAMETERS_LIBRARY,
};
