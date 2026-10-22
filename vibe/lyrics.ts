export type LyricTagCategory = 'structure' | 'intensity' | 'solo' | 'vocal';

export interface LyricTagDefinition {
  token: string;
  category: LyricTagCategory;
  description: string;
}

export const LYRICS_CANVAS_TAGS: Record<LyricTagCategory, LyricTagDefinition[]> = {
  structure: [
    { token: '[Intro]', category: 'structure', description: 'Opening atmosphere, light instrumentation or minimal vocals.' },
    { token: '[Verse]', category: 'structure', description: 'Storytelling section with narrative progression.' },
    { token: '[Verse 1]', category: 'structure', description: 'First storytelling verse.' },
    { token: '[Verse 2]', category: 'structure', description: 'Second storytelling verse.' },
    { token: '[Pre-Chorus]', category: 'structure', description: 'Builds tension and momentum toward the chorus hook.' },
    { token: '[Chorus]', category: 'structure', description: 'Main hook and emotional core; peak energy and dense arrangement.' },
    { token: '[Bridge]', category: 'structure', description: 'Contrasting melodic or harmonic shift.' },
    { token: '[Outro]', category: 'structure', description: 'Winding-down conclusion or fade.' },
    { token: '[End]', category: 'structure', description: 'Definitive final stop or resolution.' },
  ],
  intensity: [
    { token: '[Build]', category: 'intensity', description: 'Gradually elevates production energy.' },
    { token: '[Drop]', category: 'intensity', description: 'Intense electronic or rhythmic release.' },
    { token: '[Breakdown]', category: 'intensity', description: 'Strips back heavy instrumentation for open space.' },
    { token: '[Silence]', category: 'intensity', description: 'Brief dramatic dropout.' },
  ],
  solo: [
    { token: '[Instrumental]', category: 'solo', description: 'Purely instrumental section with no vocals.' },
    { token: '[inst]', category: 'solo', description: 'Shortcode instrumental section.' },
    { token: '[Guitar Solo]', category: 'solo', description: 'Lead guitar solo section.' },
    { token: '[Piano Interlude]', category: 'solo', description: 'Melodic piano interlude.' },
    { token: '[Drum Break]', category: 'solo', description: 'Isolated percussion/rhythm break.' },
  ],
  vocal: [
    { token: '[whispered]', category: 'vocal', description: 'Soft, breathy vocal delivery.' },
    { token: '[raspy vocal]', category: 'vocal', description: 'Gritty, gravelly vocal texture.' },
    { token: '[building energy]', category: 'vocal', description: 'Steadily intensifying vocal power.' },
  ],
};

export const LYRICS_SYSTEM_PROMPT = `You're a creative songwriter. Create songs' lyrics based on user prompt. Include proper tags (*ALL* instructions should be in brackets. Regular parentheses are not understood) for song structure (Intro, Verse, Chorus, ...), intensity (Build, Breakdown, ...), Solo, Vocal style etc. for each stanza. No additional text, your song's lyrics will be read and understood directly by AceStep to generate the song accordingly. Be poetic, rhythmic and concise. "Show, don't tell"`;

/**
 * Compact, token-efficient summary of the Lyrics Canvas tag library for on-demand agent context.
 */
export function getLyricsLibraryContext(): string {
  return [
    'Lyrics Canvas Tag Library — place tags in [Square Brackets] on their own header line above each stanza, e.g. `[Chorus] [building energy]`. NEVER use parentheses anywhere in the lyrics:',
    `- Structure: ${LYRICS_CANVAS_TAGS.structure.map((t) => t.token).join(', ')}`,
    `- Intensity: ${LYRICS_CANVAS_TAGS.intensity.map((t) => t.token).join(', ')}`,
    `- Solo / Instrumental: ${LYRICS_CANVAS_TAGS.solo.map((t) => t.token).join(', ')}`,
    `- Vocal Style: ${LYRICS_CANVAS_TAGS.vocal.map((t) => t.token).join(', ')}`,
  ].join('\n');
}
