import { describe, expect, it } from 'vitest';
import { composeEdit, spliceWave, readWave, sliceWave, padWave } from '../../editing/audio.js';

function wave(samples: number[], rate = 8, channels = 1): Buffer {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22); data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * channels * 2, 28); data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => data.writeInt16LE(sample, 44 + index * 2));
  return data;
}

describe('deterministic sample composition for reviewable edits', () => {
  it('preserves summed float samples and unchanged PCM values in a committed composition', async () => {
    const source = wave([8192, 8192, 8192, 8192, 8192, 8192, 8192, 8192]);
    const generated = Buffer.alloc(44 + 8 * 4);
    source.copy(generated, 0, 0, 44);
    generated.writeUInt32LE(generated.length - 8, 4);
    generated.writeUInt16LE(3, 20); generated.writeUInt32LE(32, 28);
    generated.writeUInt16LE(4, 32); generated.writeUInt16LE(32, 34); generated.writeUInt32LE(32, 40);
    for (let index = 0; index < 8; index++) generated.writeFloatLE(1.5, 44 + index * 4);
    const result = readWave(await composeEdit(source, generated, {start:.25,end:.75}, .25, true));
    expect(result.format).toBe(3);
    expect(Array.from({length:8}, (_,index) => result.samples.readFloatLE(index * 4))).toEqual([.25,.25,1.5,1.5,1.5,1.5,.25,.25]);
  });
  it('extracts only the selected samples and merges compact audio at its timeline position', () => {
    const source = wave([1, 2, 3, 4, 5, 6, 7, 8]);
    const section = sliceWave(source, { start: .25, end: .75 });
    expect(readWave(section).duration).toBe(.5);
    const result = spliceWave(wave([9, 9, 9, 9, 9, 9, 9, 9]), section, { start: .25, end: .75 }, 0);
    expect(Array.from({ length: 8 }, (_, index) => readWave(result).samples.readInt16LE(index * 2))).toEqual([9, 9, 3, 4, 5, 6, 9, 9]);
  });
  it.each([{ start: -1, end: .5 }, { start: 0, end: 2 }, { start: .5, end: .5 }])('rejects invalid extraction interval %j', region => {
    expect(() => sliceWave(wave([1, 2, 3, 4, 5, 6, 7, 8]), region)).toThrow('interval');
  });
  it('preserves original samples outside the selected region even if the worker changes every sample', () => {
    const source = wave([1, 2, 3, 4, 5, 6, 7, 8]); const generated = wave([9, 9, 9, 9, 9, 9, 9, 9]);
    const result = spliceWave(source, generated, { start: .25, end: .75 });
    expect(Array.from({ length: 8 }, (_, index) => readWave(result).samples.readInt16LE(index * 2))).toEqual([1, 2, 9, 9, 9, 9, 7, 8]);
  });
  it('retains all original frames and appends only the explicit outpaint interval', () => {
    const result = spliceWave(wave([1, 2, 3, 4]), wave([9, 9, 9, 9, 5, 6, 7, 8]), { start: .5, end: 1 });
    expect(readWave(result).duration).toBe(1);
    expect(Array.from({ length: 8 }, (_, index) => readWave(result).samples.readInt16LE(index * 2))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('extends source audio with silence while preserving its original samples and format', () => {
    const source = wave([1, 2, 3, 4]);
    const padded = readWave(padWave(source, 1));
    expect(padded.duration).toBe(1);
    expect(padded.formatChunk).toEqual(readWave(source).formatChunk);
    expect(Array.from({ length: 8 }, (_, index) => padded.samples.readInt16LE(index * 2))).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
  });
  it('rounds extension to a complete audio frame', () => {
    expect(readWave(padWave(wave([1, 2, 3, 4]), .51)).frames).toBe(5);
  });
  it.each([NaN, Infinity, -.1, .25])('rejects invalid extension duration %s', duration => {
    expect(() => padWave(wave([1, 2, 3, 4]), duration)).toThrow('duration');
  });
  it('rejects a shortened worker output rather than truncating the original', () => {
    expect(() => spliceWave(wave([1, 2, 3, 4, 5, 6, 7, 8]), wave([9, 9]), { start: .25, end: .75 })).toThrow('cover');
  });
  it('rejects mismatched sample formats before composition', () => {
    expect(() => spliceWave(wave([1, 2, 3, 4]), wave([9, 9, 9, 9], 16), { start: 0, end: .25 })).toThrow('format');
  });
  it('rejects truncated RIFF input', () => {
    expect(() => readWave(wave([1, 2, 3]).subarray(0, 47))).toThrow();
  });
});
