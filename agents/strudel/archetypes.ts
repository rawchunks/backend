import type { StrudelTheoryReference } from './harmony.js';

export type ArchetypeId =
  | 'techno_driving'
  | 'acid_303'
  | 'ukg_2step'
  | 'boombap_lofi'
  | 'house_deep'
  | 'dnb_jungle'
  | 'trap_halftime'
  | 'synthwave_arp'
  | 'ambient_cinematic'
  | 'funk_syncopated';

export interface StrudelArchetype {
  id: ArchetypeId;
  label: string;
  bpmRange: [number, number];
  keywords: readonly string[];
  description: string;
  drumCell: string;
  bassCell: (theory: StrudelTheoryReference) => string;
  harmonyCell: (theory: StrudelTheoryReference) => string;
  arpCell: (theory: StrudelTheoryReference) => string;
}

export const STRUDEL_ARCHETYPES_LIBRARY: readonly StrudelArchetype[] = [
  {
    id: 'techno_driving',
    label: 'Driving Melodic / Peak-Time Techno',
    bpmRange: [124, 142],
    keywords: ['techno', 'peak', 'industrial', '4/4', 'four on the floor', 'warehouse', 'rave', 'minimal'],
    description: 'Relentless 4-on-the-floor kick, offbeat open hat, Euclidean percussion, rolling 16th sawtooth bass.',
    drumCell: 's("bd*4, [~ cp]*2, [~ oh]*4, hh(5,8,1), <~ ~ ~ [rim perc sd cp]>").gain(0.85)',
    bassCell: (t) => {
      const [r0, , r2, , , r5, r6] = t.bassRoots;
      return `note("<[${r0} ${r0} ~ ${r0}] [${r5} ${r5} ~ ${r5}] [${r2} ${r2} ~ ${r2}] [${r6} ${r6} ~ ${r0}]>").s("sawtooth").lpf(800).gain(0.75)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("sawtooth").lpf(1400).room(0.4).gain(0.42)`,
    arpCell: (t) => `n("0 2 4 7 6 4 2 1").scale("${t.strudelScaleName}").s("triangle").fast(2).hpf(900).delay(0.3).pan(0.25).gain(0.5)`,
  },
  {
    id: 'acid_303',
    label: 'Acid 303 Squelch & Hypnotic Groove',
    bpmRange: [120, 145],
    keywords: ['acid', '303', 'tb-303', 'squelch', 'resonant', 'phrygian', 'hypnotic'],
    description: 'Syncopated octave-jumping sawtooth 303 line with resonant low-pass filter and tight 909 kit.',
    drumCell: 's("bd*4, [~ sd]*2, [~ oh]*4, ch*8, <~ ~ [rim cp] [ht mt lt sd]>").gain(0.85)',
    bassCell: (t) => {
      const [r0, r1, r2, , r4, r5] = t.bassRoots;
      const [u0, , u2, , u4] = t.scaleNotes;
      return `note("<[${r0} [${r0} ${u0}] ~ ${r4}] [${r5} [${r5} ${u2}] ${r1} ~] [${r2} ~ [${r2} ${u4}] ${r0}] [${r4} [${r4} ${u0}] ${r1} ${r0}]>").s("sawtooth").lpf(950).delay(0.18).gain(0.78)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("triangle").lpf(1300).room(0.35).gain(0.4)`,
    arpCell: (t) => `n("0 1 4 0 7 4 1 0").scale("${t.strudelScaleName}").s("sawtooth").fast(2).lpf(1800).delay(0.25).gain(0.5)`,
  },
  {
    id: 'ukg_2step',
    label: 'UK Garage / 2-Step Skippy Pocket',
    bpmRange: [126, 138],
    keywords: ['ukg', 'garage', '2-step', '2step', 'skippy', 'shuffle', 'ghost', 'burial', 'speed garage'],
    description: 'Skipped kick on beat 2/4, swung ghost snares and rims, warm sub-bass, and lush Rhodes seventh chords.',
    drumCell: 's("<[bd ~ [~ bd] ~] [bd [~ rim] ~ bd]>, [~ sd]*2, hh(5,8,1), [~ oh]*4, rim(3,16,2)").gain(0.85)',
    bassCell: (t) => {
      const [r0, , r2, r3, r4, r5, r6] = t.bassRoots;
      return `note("<[${r0} ~ [~ ${r0}] ${r4}] [${r5} ~ [~ ${r5}] ${r2}] [${r3} ~ [~ ${r3}] ${r5}] [${r6} ~ ${r4} ${r0}]>").s("triangle").lpf(650).gain(0.8)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("triangle").lpf(1800).room(0.4).delay(0.2).gain(0.48)`,
    arpCell: (t) => `n("0 2 4 6 4 2").scale("${t.strudelScaleName}").s("sine").hpf(700).delay(0.3).pan(-0.2).gain(0.48)`,
  },
  {
    id: 'boombap_lofi',
    label: 'Boom-Bap / Lo-Fi Jazz Hop',
    bpmRange: [76, 98],
    keywords: ['boom bap', 'boombap', 'lofi', 'lo-fi', 'hip hop', 'hip-hop', 'jazz', 'chill', 'dusty', 'dilla', 'rhodes'],
    description: 'Punchy swung kick-snare pocket, warm jazz 7th voicings, mellow walking sub-bass.',
    drumCell: 's("<[bd [~ bd] sd [~ bd]] [bd ~ sd [bd rim]]>, hh*8, <~ ~ ~ [~ oh]>").lpf(5500).room(0.2).gain(0.85)',
    bassCell: (t) => {
      const [r0, r1, r2, r3, r4, r5, r6] = t.bassRoots;
      return `note("<[${r0} ~ ${r4} ${r5}] [${r5} ~ ${r2} ${r3}] [${r2} ~ ${r6} ${r4}] [${r6} ~ ${r1} ${r0}]>").s("triangle").lpf(700).gain(0.75)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("triangle").lpf(1450).room(0.35).delay(0.15).gain(0.5)`,
    arpCell: (t) => `n("0 2 4 6 7 4 2 ~").scale("${t.strudelScaleName}").s("sine").lpf(2200).delay(0.25).pan(0.2).gain(0.45)`,
  },
  {
    id: 'house_deep',
    label: 'Deep / Classic Soulful House',
    bpmRange: [118, 128],
    keywords: ['house', 'deep house', 'club', 'disco', 'groove', 'soulful', 'organ', 'chords'],
    description: '4/4 house kick, crisp offbeat open hi-hat, syncopated shaker/clap, bouncy bass and warm chord stabs.',
    drumCell: 's("bd*4, [~ cp]*2, [~ oh]*4, shaker*8, <~ ~ [~ rim] [cp sd]>").gain(0.85)',
    bassCell: (t) => {
      const [r0, , r2, , r4, r5, r6] = t.bassRoots;
      return `note("<[~ ${r0} ${r4} ${r0}] [~ ${r5} ${r2} ${r5}] [~ ${r2} ${r6} ${r2}] [~ ${r6} ${r4} ${r0}]>").s("square").lpf(780).gain(0.75)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("triangle").lpf(1900).room(0.35).delay(0.2).gain(0.48)`,
    arpCell: (t) => `n("0 2 4 6 4 2 0 ~").scale("${t.strudelScaleName}").s("sine").fast(2).hpf(800).delay(0.25).pan(-0.25).gain(0.48)`,
  },
  {
    id: 'dnb_jungle',
    label: 'Drum & Bass / Liquid Breakbeat',
    bpmRange: [160, 180],
    keywords: ['dnb', 'drum and bass', 'jungle', 'amen', 'breakbeat', 'liquid', 'reece', 'neuro', 'break'],
    description: 'Two-step syncopated breakbeat kick-snare, fast rolling hats, deep Reese/sub bass, atmospheric pads.',
    drumCell: 's("<[bd ~ sd [~ bd] ~ sd ~ ~] [bd ~ sd ~ [~ bd] sd [rim sd] ~]>, hh*8, [~ oh]*4").gain(0.88)',
    bassCell: (t) => {
      const [r0, , r2, , r4, r5, r6] = t.bassRoots;
      return `note("<[${r0} ~ ~ ${r4}] [${r5} ~ ~ ${r2}] [${r2} ~ ~ ${r6}] [${r6} ~ ${r4} ${r0}]>").s("sawtooth").lpf(680).gain(0.78)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("triangle").lpf(1600).room(0.5).delay(0.3).gain(0.45)`,
    arpCell: (t) => `n("0 2 4 7 6 4 2 0").scale("${t.strudelScaleName}").s("sine").fast(2).hpf(950).delay(0.3).pan(0.3).gain(0.48)`,
  },
  {
    id: 'trap_halftime',
    label: 'Trap / 808 Halftime Bounce',
    bpmRange: [130, 160],
    keywords: ['trap', '808', 'drill', 'halftime', 'hi-hat rolls', 'rolls', 'bounce', 'sub'],
    description: 'Booming 808 kick/sub glides, halftime snare on beat 3, triplet/fast hi-hat rolls, dark minor bell melody.',
    drumCell: 's("<[bd ~ [~ bd] ~] [bd ~ ~ [bd ~]]>, [~ sd], <hh*8 [hh*4 hh*8 hh*4 hh*16]>, [~ ~ ~ oh]").gain(0.88)',
    bassCell: (t) => {
      const [r0, r1, , , r4, r5] = t.bassRoots;
      return `note("<[${r0} ~ [~ ${r0}] ${r4}] [${r5} ~ ~ ${r1}] [${r0} ~ [~ ${r4}] ${r5}] [${r1} ~ ${r4} ${r0}]>").s("sine").lpf(550).gain(0.85)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("triangle").lpf(1200).room(0.4).gain(0.42)`,
    arpCell: (t) => `n("0 1 4 5 4 1 0 ~").scale("${t.strudelScaleName}").s("triangle").hpf(850).delay(0.3).pan(0.2).gain(0.5)`,
  },
  {
    id: 'synthwave_arp',
    label: 'Synthwave / Outrun 80s Arpeggio',
    bpmRange: [100, 124],
    keywords: ['synthwave', 'retrowave', '80s', 'outrun', 'arpeggio', 'arp', 'analog', 'neon', 'cyberpunk'],
    description: 'Gated snare backbeat, pulsing 8th-note sawtooth bass, lush brassy chords, and shimmering 16th arpeggio.',
    drumCell: 's("bd*4, [~ sd]*2, hh*8, <~ ~ ~ [ht mt lt sd]>").room(0.28).gain(0.85)',
    bassCell: (t) => {
      const [r0, , r2, , , r5, r6] = t.bassRoots;
      return `note("<${r0}*8 ${r5}*8 ${r2}*8 ${r6}*8>").s("sawtooth").lpf(900).gain(0.75)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("sawtooth").lpf(1700).room(0.4).gain(0.45)`,
    arpCell: (t) => `n("0 2 4 7 4 2 0 2").scale("${t.strudelScaleName}").s("triangle").fast(2).hpf(750).delay(0.3).pan(0.25).gain(0.55)`,
  },
  {
    id: 'ambient_cinematic',
    label: 'Ambient / Cinematic Dreamscape',
    bpmRange: [60, 105],
    keywords: ['ambient', 'cinematic', 'pad', 'dreamy', 'ethereal', 'spacious', 'soundscape', 'atmospheric', 'float'],
    description: 'Spacious reverb-drenched 7th chord pads, slow evolving crystalline arpeggios, sparse soft pulse.',
    drumCell: 's("<[bd ~ ~ ~] [bd ~ [~ rim] ~]>, perc(3,8,1)").lpf(2800).room(0.5).gain(0.65)',
    bassCell: (t) => {
      const [r0, , r2, , , r5, r6] = t.bassRoots;
      return `note("<${r0} ${r5} ${r2} ${r6}>").s("sine").lpf(600).room(0.3).gain(0.68)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("triangle").lpf(1400).room(0.65).delay(0.35).gain(0.52)`,
    arpCell: (t) => `n("0 2 4 6 7 9 7 4").scale("${t.strudelScaleName}").s("sine").hpf(650).room(0.6).delay(0.4).pan(0.3).gain(0.48)`,
  },
  {
    id: 'funk_syncopated',
    label: 'Syncopated Funk / Nu-Disco / Indie Groove',
    bpmRange: [102, 122],
    keywords: ['funk', 'funky', 'disco', 'nu-disco', 'clav', 'slap', 'syncopated', 'indie', 'groovy', 'bouncy'],
    description: 'Tight 16th-note syncopated bassline, crisp snare/clap pocket with ghost rimshots, rhythmic chord stabs.',
    drumCell: 's("bd*4, [~ [sd cp]]*2, hh*8, [~ oh]*4, rim(5,16,3)").gain(0.85)',
    bassCell: (t) => {
      const [r0, , r2, r3, r4, r5, r6] = t.bassRoots;
      return `note("<[${r0} [~ ${r0}] ${r4} ${r5}] [${r5} [~ ${r5}] ${r2} ${r3}] [${r2} [~ ${r2}] ${r6} ${r4}] [${r6} ${r4} ${r2} ${r0}]>").s("sawtooth").lpf(1100).gain(0.78)`;
    },
    harmonyCell: (t) => `note("${t.defaultVoicings4Bar}").s("square").lpf(1750).room(0.25).delay(0.15).gain(0.45)`,
    arpCell: (t) => `n("0 ~ 2 4 ~ 6 4 2").scale("${t.strudelScaleName}").s("triangle").fast(2).hpf(850).pan(-0.2).gain(0.5)`,
  },
] as const;

/**
 * Matches the optimal Strudel genre/groove archetype in <0.1ms based on prompt, song style, tags, and BPM.
 */
export function matchStrudelArchetype(params: {
  prompt: string;
  stylePrompt?: string;
  tags?: string[];
  bpm?: number;
}): StrudelArchetype {
  const combined = [
    params.prompt || '',
    params.stylePrompt || '',
    ...(params.tags || []),
  ]
    .join(' ')
    .toLowerCase();
  const bpm = params.bpm ?? 120;

  let bestArchetype = STRUDEL_ARCHETYPES_LIBRARY[0];
  let bestScore = -Infinity;

  for (const arch of STRUDEL_ARCHETYPES_LIBRARY) {
    let score = 0;
    for (const kw of arch.keywords) {
      if (combined.includes(kw)) {
        // Explicit user prompt match carries higher weight than background song style
        if ((params.prompt || '').toLowerCase().includes(kw)) {
          score += 5;
        } else {
          score += 2.5;
        }
      }
    }
    const [minBpm, maxBpm] = arch.bpmRange;
    if (bpm >= minBpm && bpm <= maxBpm) {
      score += 1.5;
    } else {
      const dist = bpm < minBpm ? minBpm - bpm : bpm - maxBpm;
      score -= Math.min(2, dist / 25);
    }

    if (score > bestScore) {
      bestScore = score;
      bestArchetype = arch;
    }
  }

  return bestArchetype;
}

/**
 * Returns the compact archetype blueprint slice for the matched genre/groove and active target layers.
 */
export function getArchetypeContext(
  archetype: StrudelArchetype,
  theory: StrudelTheoryReference,
  targetLayers: ReadonlySet<'drums' | 'bass' | 'chords' | 'arp'>
): string {
  const cells: string[] = [];
  if (targetLayers.has('drums')) cells.push(`  Drums: ${archetype.drumCell}`);
  if (targetLayers.has('bass')) cells.push(`  Bass: ${archetype.bassCell(theory)}`);
  if (targetLayers.has('chords')) cells.push(`  Chords: ${archetype.harmonyCell(theory)}`);
  if (targetLayers.has('arp')) cells.push(`  Arp: ${archetype.arpCell(theory)}`);

  return [
    `[ARCHETYPE — ${archetype.label} (${archetype.id}): ${archetype.description}]`,
    ...cells,
  ].join('\n');
}
