import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { extractBipolarPeaksFromWav, contributions } from '../../../app/src/lib/daw/peaks.js';
import { withStorage } from '../support/storage.js';

function wave(samples: number[][], bits = 16, format = 1, oddChunk = false): ArrayBuffer {
  const bytes = bits / 8, frames = samples[0].length, channels = samples.length;
  const padding = oddChunk ? 10 : 0;
  const buffer = new ArrayBuffer(44 + padding + frames * channels * bytes);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, format, true); view.setUint16(22, channels, true);
  view.setUint32(24, 8, true); view.setUint32(28, 8 * channels * bytes, true); view.setUint16(32, channels * bytes, true); view.setUint16(34, bits, true);
  if (oddChunk) { text(36, 'JUNK'); view.setUint32(40, 1, true); }
  text(36 + padding, 'data'); view.setUint32(40 + padding, frames * channels * bytes, true);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const offset = 44 + padding + (frame * channels + channel) * bytes, value = samples[channel][frame];
    if (format === 3) bits === 32 ? view.setFloat32(offset, value, true) : view.setFloat64(offset, value, true);
    else if (bits === 8) view.setUint8(offset, 128 + value * 128);
    else if (bits === 16) view.setInt16(offset, value * 32768, true);
    else if (bits === 24) { const integer = value * 8388608; view.setUint8(offset, integer); view.setUint8(offset + 1, integer >> 8); view.setUint8(offset + 2, integer >> 16); }
    else view.setInt32(offset, value * 2147483648, true);
  }
  return buffer;
}

describe('audio waveform samples', () => {
  it.each([[8, 1], [16, 1], [24, 1], [32, 1], [32, 3], [64, 3]])('retains stereo extrema in %i-bit format %i', (bits, format) => {
    const result = extractBipolarPeaksFromWav(wave([[.5, -.25], [-.5, .25]], bits, format), 2)!;
    expect([...result.maxs]).toEqual([.5, .25]);
    expect([...result.mins]).toEqual([-.5, -.25]);
    expect([...result.rms]).toEqual([.5, .25]);
  });
  it('includes every frame when the frame count is not divisible by bins', () => {
    const result = extractBipolarPeaksFromWav(wave([[0, 0, 0, 0, .5]]), 2)!;
    expect([...result.maxs]).toEqual([0, .5]);
  });
  it('preserves amplitude and silence for comparison between versions', () => {
    expect([...extractBipolarPeaksFromWav(wave([[0, 0]]), 2)!.maxs]).toEqual([0, 0]);
    expect([...extractBipolarPeaksFromWav(wave([[.125, .125]]), 2)!.maxs]).toEqual([.125, .125]);
  });
  it('reads only the clip source offset and duration', () => {
    const result = extractBipolarPeaksFromWav(wave([[.125, .25, .5, -.5, .75, 0, 0, 0]]), 2, .25, .25)!;
    expect([...result.maxs]).toEqual([.5, 0]); expect([...result.mins]).toEqual([0, -.5]);
  });
  it('handles padded chunks before sample data', () => {
    expect([...extractBipolarPeaksFromWav(wave([[.25]], 16, 1, true), 1)!.maxs]).toEqual([.25]);
  });
  it('rejects truncated chunks and non-finite PCM', () => {
    expect(() => extractBipolarPeaksFromWav(wave([[.5]]).slice(0, 45))).toThrow('Truncated');
    expect(() => extractBipolarPeaksFromWav(wave([[NaN]], 32, 3))).toThrow('non-finite');
  });
  it('restores computed peaks from storage without requesting audio again', async () => {
    const server = createServer((_request, response) => response.end(Buffer.from(wave([[.25, -.5]]))));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/audio.wav`;
    const module = new URL('../../../app/src/lib/daw/peaks.ts', import.meta.url).href;
    try {
      await withStorage(async run => {
        await run(`import {extractBipolarPeaksFromUrl} from ${JSON.stringify(module)}; await extractBipolarPeaksFromUrl(${JSON.stringify(url)},2); console.log('null');`);
        await new Promise<void>(resolve => server.close(() => resolve()));
        const result = await run(`import {readPeaks} from ${JSON.stringify(module)}; const peaks=readPeaks(${JSON.stringify(url)},2); console.log(JSON.stringify({mins:[...peaks.mins],maxs:[...peaks.maxs],other:readPeaks(${JSON.stringify(url)},2,.125,.125)}));`);
        expect(result).toEqual({ mins: [0, -.5], maxs: [.25, 0], other: null });
      });
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});


describe('collective waveform colors', () => {
  it('preserves the master outline at every bin', () => {
    const master = [.25, .5, 1];
    const result = contributions(master, [[1, 2, 3], [3, 2, 1]]);
    expect(result[0].map(bin => bin.start)).toEqual([0, 0, 0]);
    expect(result[1].map(bin => bin.end)).toEqual(master);
    expect(result[0].map(bin => bin.end)).toEqual(result[1].map(bin => bin.start));
  });
  it('sizes colors from separated audio energy, including silent instruments', () => {
    expect(contributions([.8], [[1], [3], [0]])).toEqual([
      [{ start: 0, end: .2 }], [{ start: .2, end: .8 }], [{ start: .8, end: .8 }],
    ]);
  });
  it('keeps silent audio empty and handles clips outside their timeline interval', () => {
    expect(contributions([0, .5], [[0], [0]])).toEqual([
      [{ start: 0, end: 0 }, { start: 0, end: 0 }], [{ start: 0, end: 0 }, { start: 0, end: 0 }],
    ]);
  });
});
