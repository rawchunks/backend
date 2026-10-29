export const NOTE_NAMES = ['c', 'c#', 'd', 'eb', 'e', 'f', 'f#', 'g', 'ab', 'a', 'bb', 'b'] as const;
export const DISPLAY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export const ROOT_SEMITONES: Record<string, number> = {
  c: 0, 'b#': 0,
  'c#': 1, db: 1,
  d: 2,
  'd#': 3, eb: 3,
  e: 4, fb: 4,
  f: 5, 'e#': 5,
  'f#': 6, gb: 6,
  g: 7,
  'g#': 8, ab: 8,
  a: 9,
  'a#': 10, bb: 10,
  b: 11, cb: 11,
};

export const SCALE_INTERVALS: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
};

export interface StrudelTheoryReference {
  keyScale: string;
  strudelScaleName: string;
  scaleNotes: string[];
  bassRoots: string[];
  chordSymbols: string[];
  chordVoicings: string[];
  chordMap: string[];
  defaultProgression4Bar: string;
  defaultVoicings4Bar: string;
  defaultBass4Bar: string;
}

export function computeStrudelTheoryReference(rawKeyScale?: string): StrudelTheoryReference {
  const clean = (rawKeyScale || 'C minor').trim();
  const match = clean.match(/^([A-Ga-g][#b]?)\s*(.*)$/);
  const rootToken = match ? match[1].toLowerCase() : 'c';
  const rawMode = match && match[2] ? match[2].trim().toLowerCase().replace(/[\s-]+/g, '_') : 'minor';
  const modeKey =
    rawMode.includes('dorian') ? 'dorian' :
      rawMode.includes('phrygian') ? 'phrygian' :
        rawMode.includes('lydian') ? 'lydian' :
          rawMode.includes('mixolydian') ? 'mixolydian' :
            rawMode.includes('harmonic') ? 'harmonic_minor' :
              rawMode.includes('melodic') ? 'melodic_minor' :
                rawMode.includes('maj') || rawMode === 'ionian' ? 'major' :
                  'minor';

  const rootSemi = ROOT_SEMITONES[rootToken] ?? 0;
  const intervals = SCALE_INTERVALS[modeKey] || SCALE_INTERVALS.minor;
  const isMinorFamily = modeKey !== 'major' && modeKey !== 'lydian' && modeKey !== 'mixolydian';

  const scaleNotes = intervals.map((iv) => `${NOTE_NAMES[(rootSemi + iv) % 12]}3`);
  const bassRoots = intervals.map((iv) => `${NOTE_NAMES[(rootSemi + iv) % 12]}2`);

  const romanMinor = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];
  const romanMajor = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
  const romans = isMinorFamily ? romanMinor : romanMajor;

  const chordVoicings: string[] = [];
  const chordSymbols: string[] = [];
  const chordMap: string[] = [];

  for (let deg = 0; deg < 7; deg++) {
    const r = (rootSemi + intervals[deg]) % 12;
    const third = (rootSemi + intervals[(deg + 2) % 7]) % 12;
    const fifth = (rootSemi + intervals[(deg + 4) % 7]) % 12;
    const seventh = (rootSemi + intervals[(deg + 6) % 7]) % 12;

    const thirdIv = (third - r + 12) % 12;
    const fifthIv = (fifth - r + 12) % 12;
    const seventhIv = (seventh - r + 12) % 12;

    let suffix = '';
    if (thirdIv === 3 && fifthIv === 6) suffix = 'dim7';
    else if (thirdIv === 3 && seventhIv === 10) suffix = 'm7';
    else if (thirdIv === 3) suffix = 'm';
    else if (thirdIv === 4 && seventhIv === 11) suffix = 'maj7';
    else if (thirdIv === 4 && seventhIv === 10) suffix = '7';

    const symbol = `${DISPLAY_NAMES[r]}${suffix}`;
    const n1 = `${NOTE_NAMES[r]}3`;
    const n2 = `${NOTE_NAMES[third]}${third < r ? 4 : 3}`;
    const n3 = `${NOTE_NAMES[fifth]}${fifth < r ? 4 : 3}`;
    const n4 = `${NOTE_NAMES[seventh]}${seventh < r ? 4 : 3}`;
    const voicing = `[${n1},${n2},${n3},${n4}]`;

    chordSymbols.push(symbol);
    chordVoicings.push(voicing);
    chordMap.push(`${romans[deg]}=${symbol}:${voicing}`);
  }

  // Idiomatic 4-bar progression (i - VI - III - VII in minor, I - V - vi - IV in major)
  const progIndices = isMinorFamily ? [0, 5, 2, 6] : [0, 4, 5, 3];
  const defaultProgression4Bar = progIndices.map((idx) => chordSymbols[idx]).join(' -> ');
  const defaultVoicings4Bar = `<${progIndices.map((idx) => chordVoicings[idx]).join(' ')}>`;
  const defaultBass4Bar = `<[${bassRoots[progIndices[0]]} ~ ${bassRoots[progIndices[0]]} ${bassRoots[(progIndices[0] + 4) % 7]}] [${bassRoots[progIndices[1]]} ~ ${bassRoots[progIndices[1]]} ${bassRoots[progIndices[2]]}] [${bassRoots[progIndices[2]]} ~ ${bassRoots[progIndices[2]]} ${bassRoots[(progIndices[2] + 4) % 7]}] [${bassRoots[progIndices[3]]} ~ ${bassRoots[progIndices[3]]} ${bassRoots[progIndices[0]]}]>`;

  return {
    keyScale: `${DISPLAY_NAMES[rootSemi]} ${modeKey.replace('_', ' ')}`,
    strudelScaleName: `${DISPLAY_NAMES[rootSemi]}:${modeKey}`,
    scaleNotes,
    bassRoots,
    chordSymbols,
    chordVoicings,
    chordMap,
    defaultProgression4Bar,
    defaultVoicings4Bar,
    defaultBass4Bar,
  };
}

export const HARMONY_LIBRARY = {
  roots: DISPLAY_NAMES,
  modes: Object.keys(SCALE_INTERVALS),
  generators: {
    note: 'note("...") — scientific pitches (c2, eb3), chord brackets ([c3,eb3,g3,bb3]), or chord symbols (Cm7, Abmaj7)',
    scaleDegree: 'n("0 2 4 6 7 6 4 2").scale("Root:mode") — top-level scale degree generator (never nest inside note("..."))',
  },
  multiBarRule:
    'Wrap 4-bar progressions in ONE outer angle-bracket group: note("<[bar1] [bar2] [bar3] [bar4]>") or note("<[c3,eb3,g3,bb3] [ab2,c3,eb3,g3] [eb3,g3,bb3,d4] [bb2,d3,f3,ab3]>"). Never write 4 separate <...> <...> <...> <...> groups in the same string.',
} as const;

export type HarmonyTargetMode = 'bass' | 'chords' | 'arp' | 'full';

/**
 * Token-optimized Harmony & Scale context tailored to the active Directed-Graph target layers.
 */
export function getHarmonyLibraryContext(
  theory: StrudelTheoryReference,
  targetMode: HarmonyTargetMode = 'full'
): string {
  const lines: string[] = [
    `[HARMONY LIBRARY — Key: ${theory.keyScale} (.scale("${theory.strudelScaleName}"))]`,
  ];

  if (targetMode === 'bass') {
    lines.push(
      `- Legal Bass Roots (Octave 2): ${theory.bassRoots.join(' ')} | Scale (Octave 3): ${theory.scaleNotes.join(' ')}`,
      `- 4-Bar Bass Progression (${theory.defaultProgression4Bar}): note("${theory.defaultBass4Bar}").s("sawtooth")`,
      '- Rule: Use ONE outer < [bar1] [bar2] [bar3] [bar4] > group to evolve across 4 bars; never write 4 separate <...> groups.'
    );
    return lines.join('\n');
  }

  if (targetMode === 'arp') {
    lines.push(
      `- Scale-Degree Arp Generator: n("0 2 4 6 7 6 4 2").scale("${theory.strudelScaleName}").s("sine") (top-level n("..."), never nested inside note("..."))`,
      `- Legal Pitches (Octave 3): ${theory.scaleNotes.join(' ')}`,
      `- 4-Bar Harmonic Anchor: ${theory.defaultProgression4Bar}`
    );
    return lines.join('\n');
  }

  if (targetMode === 'chords') {
    lines.push(
      `- Diatonic 7th Voicings: ${theory.chordMap.join(' | ')}`,
      `- 4-Bar Progression (${theory.defaultProgression4Bar}): note("${theory.defaultVoicings4Bar}").s("triangle")`,
      '- Rule: Play simultaneous chord notes with [n1,n2,n3,n4] or chord symbols (Cm7, Abmaj7) inside ONE outer <bar1 bar2 bar3 bar4>.'
    );
    return lines.join('\n');
  }

  // 'full' mode (compact combined summary)
  lines.push(
    `- Bass Roots: ${theory.bassRoots.join(' ')} | Scale: ${theory.scaleNotes.join(' ')}`,
    `- Diatonic 7th Voicings: ${theory.chordMap.join(' | ')}`,
    `- 4-Bar Progression (${theory.defaultProgression4Bar}): Voicings ${theory.defaultVoicings4Bar} | Bass ${theory.defaultBass4Bar}`,
    `- Scale Degrees: n("0 2 4 6 7 6 4 2").scale("${theory.strudelScaleName}").s("sine") (never nest n() inside note())`
  );
  return lines.join('\n');
}
