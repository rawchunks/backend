export const ROOT_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const SCALE_MODES = ['major', 'minor', 'dorian', 'phrygian', 'mixolydian'] as const;
export const DURATION_PRESETS = [30, 60, 90, 120, 180, 240, 300] as const;
export const SUPPORTED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'ar', 'hi', 'nl', 'pl', 'sv', 'tr',
] as const;

export const PARAMETERS_LIBRARY = {
  bpm: { min: 40, max: 220, default: 120, description: 'Tempo in beats per minute (integer 40-220)' },
  keyScale: {
    roots: ROOT_NOTES,
    scales: SCALE_MODES,
    format: '<Root> <scale> (e.g., "A minor", "C major", "F# minor", "D dorian")',
  },
  audioDuration: {
    min: 30,
    max: 300,
    step: 5,
    presets: DURATION_PRESETS,
    default: 120,
    description: 'Song duration in seconds (30-300, step 5)',
  },
  vocalLanguage: {
    codes: SUPPORTED_LANGUAGES,
    description: '2-letter ISO language code for vocals (default "en")',
  },
  instrumental: {
    type: 'boolean',
    description: 'true ONLY if user explicitly requests instrumental/no vocals, otherwise false',
  },
};

export function normalizeKeyScale(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parts = raw.trim().split(/\s+/);
  const rawRoot = parts[0]?.toUpperCase() || '';
  const flatToSharp: Record<string, string> = {
    DB: 'C#',
    EB: 'D#',
    GB: 'F#',
    AB: 'G#',
    BB: 'A#',
  };
  const root = (ROOT_NOTES as readonly string[]).includes(rawRoot)
    ? rawRoot
    : flatToSharp[rawRoot];
  if (!root) return undefined;
  const rawScale = (parts[1] || 'minor').toLowerCase();
  const scale = (SCALE_MODES as readonly string[]).includes(rawScale) ? rawScale : 'minor';
  return `${root} ${scale}`;
}

export function normalizeBpm(raw: unknown): number | undefined {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(40, Math.min(220, Math.round(num)));
}

export function normalizeDuration(raw: unknown): number | undefined {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return undefined;
  const clamped = Math.max(15, Math.min(300, Math.round(num / 5) * 5));
  return clamped;
}

export function normalizeLanguage(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'en';
  const code = raw.trim().toLowerCase().slice(0, 2);
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(code) ? code : 'en';
}

/**
 * Compact, token-efficient summary of the Global Parameters library for on-demand agent context.
 */
export function getParametersLibraryContext(): string {
  return [
    'Studio Global Parameters Library:',
    `- bpm: integer ${PARAMETERS_LIBRARY.bpm.min}-${PARAMETERS_LIBRARY.bpm.max}`,
    `- keyScale: "${'<Root> <scale>'}" where Root in [${ROOT_NOTES.join(', ')}] and scale in [${SCALE_MODES.join(', ')}]`,
    `- audioDuration: integer seconds in [${DURATION_PRESETS.join(', ')}] (or 15-300 step 5)`,
    `- vocalLanguage: 2-letter ISO code in [${SUPPORTED_LANGUAGES.join(', ')}]`,
    `- instrumental: boolean (true only if user asks for instrumental/beat without vocals)`,
  ].join('\n');
}
