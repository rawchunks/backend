export const SUPPORTED_OSCILLATORS = ['sawtooth', 'square', 'triangle', 'sine'] as const;

export const SUPPORTED_METHODS = [
  '.s("sawtooth" | "square" | "triangle" | "sine")',
  '.scale("Root:mode")',
  '.fast(n)',
  '.slow(n)',
  '.rev()',
  '.gain(0.0 .. 1.5)',
  '.lpf(100 .. 12000)',
  '.hpf(20 .. 4000)',
  '.pan(-1.0 .. 1.0)',
  '.room(0.0 .. 1.0)',
  '.delay(0.0 .. 0.9)',
] as const;

export const UNSUPPORTED_METHODS = [
  'crush', 'shape', 'distort', 'vowel', 'jux', 'every', 'sometimes', 'often', 'rarely',
  'off', 'arp', 'voicing', 'struct', 'mask', 'euclid', 'degrade', 'degradeBy', 'ply',
  'striate', 'chop', 'slice', 'splice', 'loopAt', 'hurry', 'iter', 'palindrome',
  'superimpose', 'layer', 'cat', 'seq', 'slowcat', 'fastcat', 'timeCat', 'polyrhythm',
] as const;

export const SYNTHS_LIBRARY = {
  oscillators: SUPPORTED_OSCILLATORS,
  methods: SUPPORTED_METHODS,
  unsupportedMethods: UNSUPPORTED_METHODS,
  mixRecipes: {
    bass: '.s("sawtooth").lpf(750).gain(0.75)',
    chords: '.s("triangle").lpf(1600).room(0.35).gain(0.45)',
    arp: '.s("sine").fast(2).hpf(800).delay(0.25).pan(0.25).gain(0.5)',
    drums: '.gain(0.85).room(0.15)',
  },
} as const;

export type SynthTargetRole = 'bass' | 'chords' | 'arp' | 'transform' | 'full';

/**
 * Compact, token-efficient summary of the Synth & DSP Modifiers library for Directed-Graph or ReAct injection.
 */
export function getSynthsLibraryContext(role: SynthTargetRole = 'full'): string {
  const lines = [
    '[SYNTHS & DSP LIBRARY]',
    '- Valid Modifiers: .s("sawtooth"|"square"|"triangle"|"sine"), .scale("Root:mode"), .fast(n), .slow(n), .rev(), .gain(0..1.5), .lpf(100..12000), .hpf(20..4000), .pan(-1..1), .room(0..1), .delay(0..0.9)',
  ];
  if (role === 'bass') {
    lines.push('- Bass Chain: .s("sawtooth"|"square").lpf(600..1100).gain(0.75)');
  } else if (role === 'chords') {
    lines.push('- Chords Chain: .s("triangle"|"sawtooth").lpf(1200..2200).room(0.35).gain(0.45)');
  } else if (role === 'arp') {
    lines.push('- Arp Chain: .s("sine"|"triangle").fast(2).hpf(700..1200).delay(0.25).pan(-0.3..0.3).gain(0.5)');
  } else if (role === 'transform') {
    lines.push('- Transform: Adjust filter/FX/timing on existing pattern while preserving valid note/drum tokens.');
  } else {
    lines.push('- Mix: drums .gain(0.85) | bass .s("sawtooth").lpf(850).gain(0.75) | chords .s("triangle").lpf(1600).room(0.35).gain(0.45) | arp .s("sine").hpf(800).delay(0.25).pan(0.3).gain(0.5)');
  }
  lines.push('- Forbidden: .every(), .jux(), .off(), .crush(), .shape(), .arp(), .voicing(), .struct(), .euclid(), cat().');
  return lines.join('\n');
}


