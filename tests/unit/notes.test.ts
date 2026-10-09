import { describe, expect, it } from 'vitest';
import { sequence } from '../../../app/src/lib/daw/notes';

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

  it.each(['pianoroll', 'sequencer'] as const)('renders cleared %s data without invented notes', type => {
    expect(sequence({ type }, 120)).toMatchObject({ rows: 1, notes: [] });
  });
});
