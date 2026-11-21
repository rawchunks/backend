import { describe, expect, it } from 'vitest';
import { readWave } from '../../editing/audio.js';
import { buildWaveSlice, extractWindow, parseWaveHeader } from '../../databases/showcase.js';

function makeTestWav(rate: number, seconds: number, withListChunk = false): Buffer {
  const channels = 2;
  const bits = 16;
  const blockAlign = channels * (bits / 8);
  const frames = Math.floor(rate * seconds);
  const dataSize = frames * blockAlign;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bits, 14);

  const chunks: Buffer[] = [];
  const fmtHeader = Buffer.alloc(8);
  fmtHeader.write('fmt ', 0, 'ascii');
  fmtHeader.writeUInt32LE(fmt.length, 4);
  chunks.push(fmtHeader, fmt);

  if (withListChunk) {
    const listBody = Buffer.from('INFOISFT\x08\x00\x00\x00Lavf60\x00\x00', 'binary');
    const listHeader = Buffer.alloc(8);
    listHeader.write('LIST', 0, 'ascii');
    listHeader.writeUInt32LE(listBody.length, 4);
    chunks.push(listHeader, listBody);
  }

  const pcm = Buffer.alloc(dataSize);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((i / rate) * 440 * Math.PI * 2) * 12000);
    pcm.writeInt16LE(v, i * blockAlign);
    pcm.writeInt16LE(v, i * blockAlign + 2);
  }
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(dataSize, 4);
  chunks.push(dataHeader, pcm);

  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, body]);
}

describe('showcase WAV extract helpers', () => {
  it('parses standard 44.1kHz and LIST-chunked 48kHz RIFF headers accurately', () => {
    const wav44 = makeTestWav(44100, 1);
    const h44 = parseWaveHeader(wav44.subarray(0, 4096));
    expect(h44).not.toBeNull();
    expect(h44!.rate).toBe(44100);
    expect(h44!.dataOffset).toBe(44);

    const wav48 = makeTestWav(48000, 1, true);
    const h48 = parseWaveHeader(wav48.subarray(0, 4096));
    expect(h48).not.toBeNull();
    expect(h48!.rate).toBe(48000);
    expect(h48!.dataOffset).toBeGreaterThan(44);
  });

  it('bounds extract windows strictly to 16 seconds', () => {
    expect(extractWindow(180)).toEqual({ start: 20, end: 36 });
    expect(extractWindow(30)).toEqual({ start: 7, end: 23 });
    expect(extractWindow(10)).toEqual({ start: 0, end: 10 });
  });

  it('builds valid playable WAV slices readable by readWave', () => {
    const wav = makeTestWav(48000, 2, true);
    const header = parseWaveHeader(wav.subarray(0, 4096))!;
    const slicePcm = wav.subarray(header.dataOffset, header.dataOffset + 48000 * header.blockAlign);
    const out = buildWaveSlice(header, slicePcm);
    const parsed = readWave(out);
    expect(parsed.rate).toBe(48000);
    expect(parsed.channels).toBe(2);
    expect(parsed.duration).toBeCloseTo(1, 3);
  });
});
