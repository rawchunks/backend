import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Wave {
  format: number;
  channels: number;
  rate: number;
  bits: number;
  frameBytes: number;
  frames: number;
  duration: number;
  formatChunk: Buffer;
  samples: Buffer;
}

export function readWave(data: Buffer): Wave {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid RIFF WAV audio');
  let formatChunk: Buffer | undefined, samples: Buffer | undefined;
  for (let offset = 12; offset + 8 <= data.length;) {
    const name = data.toString('ascii', offset, offset + 4), length = data.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > data.length) throw new Error('Truncated WAV chunk');
    if (name === 'fmt ') formatChunk = data.subarray(offset + 8, end);
    if (name === 'data') samples = data.subarray(offset + 8, end);
    offset = end + length % 2;
  }
  if (!formatChunk || formatChunk.length < 16 || !samples?.length) throw new Error('WAV format and samples are required');
  let format = formatChunk.readUInt16LE(0);
  if (format === 0xfffe && formatChunk.length >= 40) format = formatChunk.readUInt16LE(24);
  const channels = formatChunk.readUInt16LE(2), rate = formatChunk.readUInt32LE(4), frameBytes = formatChunk.readUInt16LE(12), bits = formatChunk.readUInt16LE(14);
  if (![1, 3].includes(format) || !channels || !rate || !(format === 3 ? [32, 64] : [8, 16, 24, 32]).includes(bits) || frameBytes !== channels * bits / 8 || samples.length % frameBytes) throw new Error('Unsupported WAV sample format');
  const frames = samples.length / frameBytes;
  return { format, channels, rate, bits, frameBytes, frames, duration: frames / rate, formatChunk, samples };
}

function encodeWave(format: Wave, samples: Buffer): Buffer {
  const fmtLength = format.formatChunk.length, fmtPadding = fmtLength % 2;
  const header = Buffer.alloc(28 + fmtLength + fmtPadding);
  header.write('RIFF'); header.writeUInt32LE(header.length + samples.length - 8, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(fmtLength, 16); format.formatChunk.copy(header, 20);
  header.write('data', 20 + fmtLength + fmtPadding); header.writeUInt32LE(samples.length, 24 + fmtLength + fmtPadding);
  return Buffer.concat([header, samples]);
}

function floatWave(data: Buffer): Buffer {
  const source = readWave(data);
  if (source.format === 3 && source.bits === 32) return data;
  const samples = Buffer.alloc(source.frames * source.channels * 4);
  for (let index = 0; index < source.frames * source.channels; index++) {
    const offset = index * source.bits / 8;
    const value = source.format === 3 ? source.samples.readDoubleLE(offset)
      : source.bits === 8 ? (source.samples[offset] - 128) / 128
      : source.samples.readIntLE(offset, source.bits / 8) / 2 ** (source.bits - 1);
    samples.writeFloatLE(value, index * 4);
  }
  const formatChunk = Buffer.alloc(16);
  formatChunk.writeUInt16LE(3, 0); formatChunk.writeUInt16LE(source.channels, 2);
  formatChunk.writeUInt32LE(source.rate, 4); formatChunk.writeUInt32LE(source.rate * source.channels * 4, 8);
  formatChunk.writeUInt16LE(source.channels * 4, 12); formatChunk.writeUInt16LE(32, 14);
  return encodeWave({ ...source, formatChunk }, samples);
}

export function sliceWave(data: Buffer, region: { start: number; end: number }): Buffer {
  const source = readWave(data);
  const latentStepToleranceSec = source.rate >= 1000 ? 0.05 : 0;
  if (!Number.isFinite(region.start) || !Number.isFinite(region.end) || region.start < 0 || region.end <= region.start || region.end > source.duration + latentStepToleranceSec) throw new Error('Invalid extract audio interval');
  const startFrame = Math.min(source.frames, Math.round(region.start * source.rate)), endFrame = Math.min(source.frames, Math.round(region.end * source.rate));
  if (endFrame <= startFrame) throw new Error('Invalid extract audio interval');
  return encodeWave(source, source.samples.subarray(startFrame * source.frameBytes, endFrame * source.frameBytes));
}

export function padWave(data: Buffer, duration: number): Buffer {
  const source = readWave(data);
  if (!Number.isFinite(duration) || duration < source.duration) throw new Error('Invalid extension duration');
  const samples = Buffer.alloc(Math.ceil(duration * source.rate) * source.frameBytes, source.format === 1 && source.bits === 8 ? 128 : 0);
  source.samples.copy(samples);
  return encodeWave(source, samples);
}

export function silentWave(data: Buffer): Buffer {
  const source = readWave(data);
  const samples = Buffer.alloc(source.samples.length, source.format === 1 && source.bits === 8 ? 128 : 0);
  return encodeWave(source, samples);
}

function readSampleValue(wave: Wave, buf: Buffer, frame: number, channel: number): number {
  const bytesPerSample = wave.bits / 8;
  const offset = (frame * wave.channels + channel) * bytesPerSample;
  if (wave.format === 3) return wave.bits === 64 ? buf.readDoubleLE(offset) : buf.readFloatLE(offset);
  if (wave.bits === 8) return (buf[offset] - 128) / 128;
  return buf.readIntLE(offset, bytesPerSample) / 2 ** (wave.bits - 1);
}

function writeSampleValue(wave: Wave, buf: Buffer, frame: number, channel: number, value: number): void {
  const bytesPerSample = wave.bits / 8;
  const offset = (frame * wave.channels + channel) * bytesPerSample;
  const clamped = Math.max(-1, Math.min(1, value));
  if (wave.format === 3) {
    if (wave.bits === 64) buf.writeDoubleLE(clamped, offset);
    else buf.writeFloatLE(clamped, offset);
    return;
  }
  if (wave.bits === 8) {
    buf[offset] = Math.max(0, Math.min(255, Math.round(clamped * 128 + 128)));
    return;
  }
  const scale = 2 ** (wave.bits - 1);
  const intVal = Math.max(-scale, Math.min(scale - 1, Math.round(clamped * scale)));
  buf.writeIntLE(intVal, offset, bytesPerSample);
}

export function spliceWave(sourceData: Buffer, generatedData: Buffer, region: { start: number; end: number }, offset = region.start, crossfadeSec = 0.025): Buffer {
  const source = readWave(sourceData), generated = readWave(generatedData);
  if ([source.format, source.channels, source.rate, source.bits].some((value, index) => value !== [generated.format, generated.channels, generated.rate, generated.bits][index])) throw new Error('Source and generated WAV format must match');
  if (!Number.isFinite(region.start) || !Number.isFinite(region.end) || region.start < 0 || region.end <= region.start || region.start > source.duration) throw new Error('Invalid edit audio interval');
  const startFrame = Math.round(region.start * source.rate);
  let endFrame = Math.round(region.end * source.rate);
  const generatedStart = Math.round(offset * source.rate);
  let generatedEnd = generatedStart + endFrame - startFrame;
  const latentStepTolerance = Math.floor(source.rate * 0.05);
  if (generated.frames < generatedEnd && generatedEnd - generated.frames <= latentStepTolerance && generated.frames > generatedStart) {
    generatedEnd = generated.frames;
    endFrame = startFrame + (generatedEnd - generatedStart);
  }
  if (!Number.isFinite(offset) || offset < 0 || generated.frames < generatedEnd) throw new Error('Generated audio does not cover the selected edit interval');
  const frames = Math.max(source.frames, endFrame), samples = Buffer.alloc(frames * source.frameBytes);
  source.samples.copy(samples);
  generated.samples.copy(samples, startFrame * source.frameBytes, generatedStart * source.frameBytes, generatedEnd * source.frameBytes);

  const regionFrames = endFrame - startFrame;
  const maxCf = source.rate >= 1000 && crossfadeSec > 0 ? Math.min(Math.round(crossfadeSec * source.rate), Math.floor(regionFrames / 4)) : 0;
  if (maxCf > 0) {
    const leftCf = startFrame > 0 ? Math.min(maxCf, startFrame, source.frames - startFrame) : 0;
    for (let i = 0; i < leftCf; i++) {
      const alpha = 0.5 * (1 - Math.cos((Math.PI * (i + 1)) / (leftCf + 1)));
      const sFrame = startFrame + i;
      const gFrame = generatedStart + i;
      for (let ch = 0; ch < source.channels; ch++) {
        const srcVal = readSampleValue(source, source.samples, sFrame, ch);
        const genVal = readSampleValue(generated, generated.samples, gFrame, ch);
        writeSampleValue(source, samples, sFrame, ch, (1 - alpha) * srcVal + alpha * genVal);
      }
    }
    const rightCf = endFrame < source.frames ? Math.min(maxCf, source.frames - endFrame, regionFrames) : 0;
    for (let i = 0; i < rightCf; i++) {
      const alpha = 0.5 * (1 + Math.cos((Math.PI * (i + 1)) / (rightCf + 1)));
      const sFrame = endFrame - rightCf + i;
      const gFrame = generatedEnd - rightCf + i;
      for (let ch = 0; ch < source.channels; ch++) {
        const srcVal = readSampleValue(source, source.samples, sFrame, ch);
        const genVal = readSampleValue(generated, generated.samples, gFrame, ch);
        writeSampleValue(source, samples, sFrame, ch, (1 - alpha) * srcVal + alpha * genVal);
      }
    }
  }
  return encodeWave(source, samples);
}

async function transcode(data: Buffer, target?: Wave): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'rawchunks-edit-'));
  try {
    const input = join(directory, 'input'), output = join(directory, 'decoded.wav');
    await writeFile(input, data);
    const codec = !target || target.format === 3 ? target?.bits === 64 ? 'pcm_f64le' : 'pcm_f32le' : `pcm_${target.bits === 8 ? 'u8' : `s${target.bits}le`}`;
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:a:0', '-vn', '-c:a', codec, ...(target ? ['-ar', String(target.rate), '-ac', String(target.channels)] : []), output];
    await new Promise<void>((resolve, reject) => {
      const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let diagnostic = '';
      const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('Audio decoding timed out')); }, 60_000);
      process.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-2048); });
      process.on('error', error => { clearTimeout(timer); reject(new Error(`Audio decoder unavailable: ${error.message}`)); });
      process.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Audio decoding failed: ${diagnostic}`)); });
    });
    return await readFile(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function decodeWave(data: Buffer): Promise<Buffer> {
  try { readWave(data); return data; } catch { return transcode(data); }
}

export async function composeEdit(sourceData: Buffer, generatedData: Buffer, region: { start: number; end: number }, offset = region.start, floating = false): Promise<Buffer> {
  let sourceDataWave = await decodeWave(sourceData), source = readWave(sourceDataWave);
  if (floating && (source.format !== 3 || source.bits !== 32)) {
    sourceDataWave = floatWave(sourceDataWave);
    source = readWave(sourceDataWave);
  }
  let generatedDataWave = await decodeWave(generatedData), generated = readWave(generatedDataWave);
  if (floating && source.rate === generated.rate && source.channels === generated.channels) {
    generatedDataWave = floatWave(generatedDataWave);
    generated = readWave(generatedDataWave);
  }
  if ([source.format, source.channels, source.rate, source.bits].some((value, index) => value !== [generated.format, generated.channels, generated.rate, generated.bits][index])) generatedDataWave = await transcode(generatedData, source);
  return spliceWave(sourceDataWave, generatedDataWave, region, offset);
}

export async function mixWaves(buffers: Buffer[]): Promise<Buffer> {
  if (!buffers.length) throw new Error('At least one audio buffer is required to mix');
  const firstDecoded = await decodeWave(buffers[0]);
  if (buffers.length === 1) return firstDecoded;
  const base = readWave(firstDecoded);
  const waves: Wave[] = [base];
  let maxFrames = base.frames;
  for (let i = 1; i < buffers.length; i++) {
    let decoded = await decodeWave(buffers[i]);
    let wave = readWave(decoded);
    if ([base.format, base.channels, base.rate, base.bits].some((value, idx) => value !== [wave.format, wave.channels, wave.rate, wave.bits][idx])) {
      decoded = await transcode(buffers[i], base);
      wave = readWave(decoded);
    }
    waves.push(wave);
    if (wave.frames > maxFrames) maxFrames = wave.frames;
  }
  const samples = Buffer.alloc(maxFrames * base.frameBytes, base.format === 1 && base.bits === 8 ? 128 : 0);
  for (let frame = 0; frame < maxFrames; frame++) {
    for (let ch = 0; ch < base.channels; ch++) {
      let sum = 0;
      for (const wave of waves) {
        if (frame < wave.frames) {
          sum += readSampleValue(wave, wave.samples, frame, ch);
        }
      }
      writeSampleValue(base, samples, frame, ch, sum);
    }
  }
  return encodeWave(base, samples);
}

export function extractWavBipolarPeaks(
  data: Buffer,
  numBins = 512
): { mins: number[]; maxs: number[]; duration: number } {
  const wav = readWave(data);
  const count = Math.max(1, Math.min(2048, Math.floor(numBins)));
  const mins = new Array<number>(count).fill(0);
  const maxs = new Array<number>(count).fill(0);
  const frames = wav.frames;
  const channels = wav.channels;

  if (frames > 0 && channels > 0) {
    for (let bin = 0; bin < count; bin++) {
      const start = Math.floor((bin * frames) / count);
      const end = Math.max(start + 1, Math.min(frames, Math.floor(((bin + 1) * frames) / count)));
      const span = end - start;
      const step = Math.max(1, Math.floor(span / 64));
      let minVal = 0;
      let maxVal = 0;
      for (let frame = start; frame < end; frame += step) {
        for (let ch = 0; ch < channels; ch++) {
          const sample = readSampleValue(wav, wav.samples, frame, ch);
          if (sample < minVal) minVal = sample;
          if (sample > maxVal) maxVal = sample;
        }
      }
      mins[bin] = Number(minVal.toFixed(4));
      maxs[bin] = Number(maxVal.toFixed(4));
    }
  }

  return {
    mins,
    maxs,
    duration: Number(wav.duration.toFixed(4)),
  };
}

