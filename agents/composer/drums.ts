export interface DrumTokenCategory {
  id: 'kick' | 'snare' | 'hat' | 'tom_perc' | 'cymbal';
  label: string;
  tokens: readonly string[];
  description: string;
}

export const DRUM_TOKEN_CATEGORIES: readonly DrumTokenCategory[] = [
  {
    id: 'kick',
    label: 'Kicks',
    tokens: ['bd', 'kick'],
    description: 'Punchy low-end bass drum transient (anchors groove16:L downbeats).',
  },
  {
    id: 'snare',
    label: 'Snares, Claps & Rims',
    tokens: ['sd', 'snare', 'cp', 'clap', 'rim'],
    description: 'Backbeat snare, layered handclap, and tight sidestick rimshot.',
  },
  {
    id: 'hat',
    label: 'Hi-Hats',
    tokens: ['hh', 'hihat', 'ch', 'oh', 'openhat'],
    description: 'Closed crisp hats (hh/ch) and metallic open offbeat hats (oh/openhat).',
  },
  {
    id: 'tom_perc',
    label: 'Toms & Percussion',
    tokens: ['lt', 'mt', 'ht', 'tom', 'perc', 'cb', 'shaker'],
    description: 'Pitched low/mid/high toms, cowbell, wood perc, and 16th-note shaker.',
  },
  {
    id: 'cymbal',
    label: 'Cymbals',
    tokens: ['ride', 'crash', 'cr'],
    description: 'Sustained ride bell and section-opening crash accent.',
  },
] as const;

export const EUCLIDEAN_DRUM_CELLS = [
  { pattern: 'bd(3,8)', style: 'Tresillo / Dancehall / Reggaeton / UKG kick pulse' },
  { pattern: 'hh(5,8,1)', style: 'Rotated Cinquillo offbeat hi-hat pocket' },
  { pattern: 'cp(3,8,2)', style: 'Syncopated backbeat clap accent' },
  { pattern: 'perc(5,16,3)', style: 'Rolling 16th-note ghost percussion' },
  { pattern: 'rim(7,16,1)', style: '2-Step / Jungle syncopated rimshot counter-rhythm' },
] as const;

export const DRUMS_LIBRARY = {
  generator: 's("...")',
  categories: DRUM_TOKEN_CATEGORIES,
  euclideanCells: EUCLIDEAN_DRUM_CELLS,
  rules: [
    'Use s("...") for drum kits; NEVER chain .s("sawtooth") or .scale() onto a drum s("...") pattern.',
    'Separate simultaneous drum sub-layers with commas inside one s("...") string: s("bd*4, [~ cp]*2, hh(5,8,1)").',
    'Always attach Euclidean (k,n,r) to a concrete drum token like hh(5,8,1) or bd(3,8) — NEVER write literal "x(5,8)".',
    'Use ONE outer <bar1 bar2 bar3 bar4> group for 4-bar turnaround fills, e.g. <~ ~ ~ [ht mt lt sd]>.',
  ],
} as const;

/**
 * Compact, token-efficient summary of the Drum & Percussion library for Directed-Graph or ReAct injection.
 */
export function getDrumsLibraryContext(): string {
  return [
    '[DRUMS LIBRARY — s("...")]',
    '- Tokens: bd, kick | sd, snare, cp, clap, rim | hh, ch, oh | lt, mt, ht, perc, cb, shaker | ride, crash',
    '- Sub-layers: s("bd*4, [~ sd]*2, hh(5,8,1), <~ ~ ~ [ht mt lt sd]>").gain(0.85)',
    '- Rules: Never chain .s() or .scale() onto s("..."). Attach Euclidean (k,n,r) to drum tokens (hh(5,8,1), bd(3,8)) — never "x(k,n)".',
  ].join('\n');
}
