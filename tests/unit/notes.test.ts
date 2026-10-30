import { describe, expect, it } from 'vitest';
import { sequence } from '../../../app/src/lib/daw/notes';
import {
  parseStrudelPattern,
  validateStrudelPattern,
  expandChordSymbol,
  getScaleAndChordReference,
} from '../../../app/src/lib/daw/strudel';
import {
  ALGORITHMIC_COMPOSER_MODEL,
  DRUMS_LIBRARY,
  HARMONY_LIBRARY,
  SYNTHS_LIBRARY,
  STRUDEL_ARCHETYPES_LIBRARY,
  computeStrudelTheoryReference,
  cleanGeneratedStrudelCode,
  validateGeneratedStrudelPattern,
  buildStrudelComposerMessages,
  resolveComposerGraph,
  matchStrudelArchetype,
} from '../../agents/strudel/service.js';

describe('instrument lanes', () => {
  const chord = [
    { id: 'c', pitch: 'C4', midi: 60, startTime: 4, duration: 4, velocity: 0.8 },
    { id: 'g', pitch: 'G4', midi: 67, startTime: 4, duration: 2, velocity: 0.6 },
  ];

  it.each([60, 120, 128, 240])('aligns notes with playback at %i BPM', bpm => {
    const pattern = sequence({ type: 'pianoroll', pianoRollNotes: chord }, bpm);
    expect(pattern.duration).toBeCloseTo(8 * 60 / bpm);
    expect(pattern.notes[0].start).toBeCloseTo(60 / bpm);
    expect(pattern.notes[0].duration).toBeCloseTo(60 / bpm);
    expect(pattern.notes[1].duration).toBeCloseTo(30 / bpm);
    expect(pattern.notes.map(note => note.row)).toEqual([7, 0]);
    expect(chord[0]).toMatchObject({ startTime: 4, duration: 4 });
  });

  it('retains the final drum step, muted voices and silent velocities', () => {
    const steps = Array.from({ length: 16 }, (_, index) => index === 15);
    const pattern = sequence({ type: 'sequencer', sequencerVoices: [
      { name: 'KICK', steps, velocity: Array(16).fill(0), muted: false },
      { name: 'SNARE', steps, velocity: Array(16).fill(0.7), muted: true },
    ] }, 120);
    expect(pattern.duration).toBe(2);
    expect(pattern.rows).toBe(2);
    expect(pattern.notes).toMatchObject([
      { label: 'KICK', start: 1.875, duration: 0.125, row: 0, velocity: 0, muted: false },
      { label: 'SNARE', start: 1.875, duration: 0.125, row: 1, velocity: 0.7, muted: true },
    ]);
  });

  it('keeps a sustained note crossing the pattern boundary', () => {
    const pattern = sequence({ type: 'pianoroll', pianoRollNotes: [{ ...chord[0], startTime: 31 }] }, 120);
    expect(pattern.notes[0].start).toBe(3.875);
    expect(pattern.notes[0].start + pattern.notes[0].duration).toBe(4.375);
    expect(pattern.duration).toBe(4);
  });

  it.each(['pianoroll', 'sequencer', 'strudel'] as const)('renders cleared %s data without invented notes', type => {
    expect(sequence({ type }, 120)).toMatchObject({ rows: 1, notes: [] });
  });

  it('sequences Strudel note().s() chaining, stack(), chords, and DSP modifiers onto the timeline', () => {
    const pattern = sequence({
      type: 'strudel',
      strudelCode: `stack(s("bd*2 sd"), note("c2 [c3,eb3,g3]").s("sawtooth").gain(0.6).lpf(1200))`,
    }, 120);
    expect(pattern.duration).toBe(2);
    expect(pattern.notes.map(n => n.label)).toEqual(['BD', 'BD', 'SD', 'C2', 'C3', 'EB3', 'G3']);
    expect(pattern.notes.find(n => n.label === 'C2')?.velocity).toBeCloseTo(0.6);
  });

  it('unrolls multi-cycle <...> progressions, chord symbols, .scale() degrees, and Euclidean (k,n,r)', () => {
    const multiCycle = parseStrudelPattern(`note("<Cm7 Fm7 Abmaj7 G7>").s("triangle")`);
    expect(multiCycle.cycleCount).toBe(4);
    expect(multiCycle.cycles).toHaveLength(4);
    expect(multiCycle.cycles?.[0].map(e => e.value)).toEqual(['C3', 'EB3', 'G3', 'BB3']);
    expect(multiCycle.cycles?.[1].map(e => e.value)).toEqual(['F3', 'AB3', 'C4', 'EB4']);

    const seqPattern = sequence({
      type: 'strudel',
      strudelCode: `note("<c2 f2 ab2 g2>").s("sawtooth")`,
    }, 120);
    // 4 cycles * 2s bar = 8s total duration
    expect(seqPattern.duration).toBe(8);
    expect(seqPattern.notes.map(n => n.label)).toEqual(['C2', 'F2', 'AB2', 'G2']);
    expect(seqPattern.notes.map(n => n.start)).toEqual([0, 2, 4, 6]);

    const scaleDeg = parseStrudelPattern(`n("0 2 4 6").scale("C:minor").s("sine")`);
    expect(scaleDeg.events.map(e => e.value)).toEqual(['C4', 'EB4', 'G4', 'BB4']);

    const euclidRot = parseStrudelPattern(`s("bd(3,8,1)")`);
    expect(euclidRot.events).toHaveLength(3);
    expect(expandChordSymbol('Cm7')).toEqual(['C3', 'Eb3', 'G3', 'Bb3'].map(s => s.toUpperCase()));
    expect(getScaleAndChordReference('F minor').scaleNotes).toContain('Ab');
    expect(validateStrudelPattern(`s("bd [sd")`).valid).toBe(false);
  });

  it('configures Algorithmic Composer for Nemotron-3-Ultra with music theory and validation guards', () => {
    expect(ALGORITHMIC_COMPOSER_MODEL).toBe('nvidia/Nemotron-3-Ultra-550b-a55b');
    const theory = computeStrudelTheoryReference('C minor');
    expect(theory.strudelScaleName).toBe('C:minor');
    expect(theory.bassRoots).toContain('c2');
    expect(theory.defaultVoicings4Bar).toContain('[c3,eb3,g3,bb3]');

    const cleaned = cleanGeneratedStrudelCode('<think>reasoning</think>\n```strudel\n$: stack(s("bd*4"), note("<c2 f2>").s("sawtooth"))\n```');
    expect(cleaned).toBe('stack(s("bd*4"), note("<c2 f2>").s("sawtooth"))');
    expect(validateGeneratedStrudelPattern(cleaned).valid).toBe(true);
    expect(validateGeneratedStrudelPattern('s("bd*4").every(4, rev)').valid).toBe(false);

    const msgs = buildStrudelComposerMessages(
      {
        prompt: 'Tight acid bassline and crisp hats',
        bpm: 126,
        keyScale: 'F minor',
        selectedTrack: 'Drums',
        musicalContext: '[SONG_CTX v2]\ntempo:126 meter:4/4 key:F:minor',
      },
      { activeSection: 'Chorus', activeLyrics: 'Dancing in the neon rain' }
    );
    expect(msgs[0].content).toContain('F minor');
    expect(msgs[1].content).toContain('REFERENCE TRACK: Drums');
    expect(msgs[1].content).toContain('Dancing in the neon rain');
  });

  it('routes prompts through the <1ms Directed Graph and slices internal libraries for ~60% token savings', () => {
    expect(DRUMS_LIBRARY.categories.length).toBeGreaterThanOrEqual(5);
    expect(HARMONY_LIBRARY.modes).toContain('dorian');
    expect(SYNTHS_LIBRARY.oscillators).toEqual(['sawtooth', 'square', 'triangle', 'sine']);
    expect(STRUDEL_ARCHETYPES_LIBRARY).toHaveLength(10);

    // 1. Drums-only request: mounts ONLY drums + archetypes (prunes harmony voicings & synth oscillator tables)
    const drumGraph = resolveComposerGraph(
      {
        prompt: 'Syncopated 2-step UK garage drums with ghost snares and Euclidean hats',
        bpm: 132,
        keyScale: 'C minor',
        selectedTrack: 'Bass',
      },
      { activeSection: 'Verse' }
    );
    expect(drumGraph.targetLayers).toEqual(['drums']);
    expect(drumGraph.mountedLibraries).toEqual(['drums', 'archetypes']);
    expect(drumGraph.archetypeId).toBe('ukg_2step');
    expect(drumGraph.refRole).toBe('bass');
    expect(drumGraph.sectionNode).toBe('verse');
    expect(drumGraph.estimatedTokens).toBeLessThan(460);
    expect(drumGraph.messages[0].content).not.toContain('7th Voicings');

    // 2. Bass-only request: mounts ONLY harmony (bass slice) + synths (bass slice) + archetypes (prunes drum tokens)
    const bassGraph = resolveComposerGraph(
      {
        prompt: 'Hypnotic 303 acid bassline in F minor',
        bpm: 130,
        keyScale: 'F minor',
        selectedTrack: 'Drums',
      },
      { activeSection: 'Drop' }
    );
    expect(bassGraph.targetLayers).toEqual(['bass']);
    expect(bassGraph.mountedLibraries).toEqual(['harmony', 'synths', 'archetypes']);
    expect(bassGraph.archetypeId).toBe('acid_303');
    expect(bassGraph.refRole).toBe('drums');
    expect(bassGraph.sectionNode).toBe('drop');
    expect(bassGraph.estimatedTokens).toBeLessThan(520);
    expect(bassGraph.messages[0].content).toContain('f2 g2 ab2 bb2 c2 c#2 eb2');
    expect(bassGraph.messages[0].content).not.toContain('[DRUMS LIBRARY');

    // 3. Pure DSP transform request on existing code: mounts ONLY synths (transform slice)
    const transformGraph = resolveComposerGraph({
      prompt: 'Open up the low-pass filter cutoff to 2200Hz and add wider reverb',
      currentCode: 'note("<c2 f2 ab2 g2>").s("sawtooth").lpf(800)',
      bpm: 124,
      keyScale: 'C minor',
    });
    expect(transformGraph.intent).toBe('transform');
    expect(transformGraph.mountedLibraries).toEqual(['synths']);
    expect(transformGraph.estimatedTokens).toBeLessThan(360);

    // 4. Genre archetype matcher & layer syntax guard
    expect(matchStrudelArchetype({ prompt: 'liquid jungle breakbeat', bpm: 174 }).id).toBe('dnb_jungle');
    expect(
      validateGeneratedStrudelPattern('stack(\nnote("f2 c3").s("sawtooth"),\nbd.groove16.L\n)').valid
    ).toBe(false);
  });

  it('maintains sub-millisecond Strudel bipolar peak synthesis and 16-slice event bucketing', async () => {
    const { synthesizeStrudelBipolarPeaks } = await import('../../../app/src/lib/daw/strudel');
    const code = 'stack(s("bd*4, ~ sd ~ sd, hh*8"), note("<[c3,eb3,g3,bb3] [f3,ab3,c4,eb4]>").s("sawtooth").lpf(1600).room(0.25))';
    const t0 = performance.now();
    const peaks = synthesizeStrudelBipolarPeaks(code, 256);
    const elapsedMs = performance.now() - t0;
    expect(peaks.maxs.length).toBe(256);
    expect(elapsedMs).toBeLessThan(20);
  });
});

