import { ROOT_NOTES, normalizeBpm, normalizeKeyScale } from './parameters.js';

export interface AudioDspFeatures {
  durationSec: number;
  bpm: number;
  keyScale: string;
  scaleMode: 'major' | 'minor';
  meanPitchHz: number;
  pitchRangeSemitones: number;
  contour: string;
  groove: string;
  onsetRatePerSec: number;
  energyLevel: 'soft' | 'moderate' | 'high';
  energyTrend: 'steady' | 'building' | 'fading';
  vocalTone: string;
  mood: string;
}

export interface AudioSttResult {
  text: string;
  language: string;
  isLexical: boolean;
  flaggedAs?: 'lexical_speech_or_lyrics' | 'non_lexical_hum_or_indiscernible';
  provider: 'cartesia' | 'elevenlabs' | 'none';
}

export interface AudioVibeAnalysis {
  prompt: string;
  features: AudioDspFeatures;
  stt: AudioSttResult;
}

// Krumhansl-Kessler key profiles (C, C#, D, D#, E, F, F#, G, G#, A, A#, B)
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const NON_LEXICAL_VOCABLES = new Set([
  // Nasal / closed-mouth hums & vocal fillers
  'm', 'mm', 'mmm', 'mmmm', 'hm', 'hmm', 'hmmm', 'hmmmm', 'mhm', 'mhmm', 'mmhm', 'mmhmm',
  'uh', 'uhh', 'uhhh', 'um', 'umm', 'ummm', 'uhm', 'huh', 'uhhuh', 'nuh', 'nuhuh',
  'eh', 'ehh', 'ah', 'ahh', 'ahhh', 'oh', 'ohh', 'ohhh', 'ooh', 'oo', 'ooo', 'aww', 'aw', 'ew',
  'hmph', 'mph', 'mmph', 'hem', 'em',
  // Labial / alveolar / velar rhythmic hums & beatbox / scat syllables ("pum pum", "bam bam", "dum dum", etc.)
  'pum', 'pom', 'pam', 'pim', 'pem', 'pumm', 'pumpum',
  'bum', 'bom', 'bam', 'bim', 'bem', 'bumm', 'bambam', 'bumbum',
  'dum', 'dom', 'dam', 'dim', 'dem', 'dumm', 'dumdum', 'badum', 'badaboom',
  'tum', 'tom', 'tam', 'tim', 'tem', 'tumm', 'tumtum', 'tamtam',
  'num', 'nom', 'nam', 'nim', 'nem', 'rum', 'rom', 'ram', 'lum', 'lom', 'lam',
  'pap', 'pep', 'pip', 'pop', 'pup', 'bap', 'bep', 'bip', 'bop', 'bup', 'boop',
  'dap', 'dep', 'dip', 'dop', 'dup', 'tap', 'tep', 'tip', 'tup', 'kap', 'kep', 'kip', 'kop', 'kup',
  // Open vowel & reduplicated humming syllables
  'la', 'lala', 'lalala', 'lalalala', 'lo', 'lolo', 'lu', 'lulu', 'le', 'lele', 'li', 'lili',
  'da', 'dada', 'dadada', 'dodo', 'doo', 'doodoo', 'du', 'dudu', 'de', 'dede', 'di', 'didi',
  'ba', 'baba', 'bada', 'bah', 'bo', 'bobo', 'boo', 'booboo', 'bu', 'bubu', 'bebe', 'bi', 'bibi',
  'na', 'nana', 'nanana', 'nah', 'noo', 'nu', 'nunu', 'ne', 'nene', 'ni', 'nini',
  'pa', 'papa', 'papapa', 'pah', 'po', 'popo', 'poo', 'pu', 'pupu', 'pe', 'pepe', 'pi', 'pipi',
  'ma', 'mama', 'mah', 'mo', 'momo', 'moo', 'mu', 'mumu', 'mi', 'mimi',
  'ta', 'tata', 'tah', 'toto', 'tu', 'tutu', 'te', 'tete', 'ti', 'titi',
  'ka', 'kaka', 'kah', 'ko', 'koko', 'ku', 'kuku', 'ke', 'keke', 'ki', 'kiki',
  'ga', 'gaga', 'gah', 'gogo', 'gu', 'gugu', 'ge', 'gege', 'gi', 'gigi',
  'ha', 'haha', 'hahaha', 'hah', 'hehe', 'hee', 'hihi', 'ho', 'hoho', 'hu', 'huhu',
  'ya', 'yaya', 'yah', 'yo', 'yoyo', 'yu', 'ye', 'wa', 'wawa', 'wah', 'wo', 'wowo', 'woah', 'whoa', 'wu',
  // Percussive / breath / vocalized noise tokens
  'sha', 'sho', 'shu', 'shh', 'shhh', 'psh', 'tss', 'tsss', 'chk', 'chka', 'brr', 'brrr', 'grr', 'zzz',
  'boom', 'boomboom', 'kaboom', 'zoom', 'ding', 'dong', 'bing', 'bong', 'ping', 'pong', 'ting', 'tong',
]);

// Common Whisper hallucinations produced when given non-speech, humming, or breath
const WHISPER_NON_SPEECH_HALLUCINATIONS = new Set([
  'thank you',
  'thank you very much',
  'thanks for watching',
  'thanks for listening',
  'thank you for watching',
  'subtitles by',
  'you',
  'bye',
  'bye bye',
  'the end',
  'music',
  'humming',
  'singing',
]);

const SHORT_FUNCTION_WORDS = new Set([
  'i', 'a', 'an', 'to', 'in', 'on', 'at', 'of', 'or', 'so', 'by', 'is', 'it', 'be', 'do', 'go', 'no', 'we', 'us', 'my', 'me', 'he', 'up', 'if', 'as',
]);

/**
 * Decodes a data:audio/...;base64,... URL or raw base64 string into a Buffer and MIME type.
 */
export function decodeAudioDataUrl(audioInput: string): { buffer: Buffer; mimeType: string; ext: string } {
  const trimmed = audioInput.trim();
  const match = trimmed.match(/^data:(audio\/[a-zA-Z0-9.+_-]+)(?:;[^,]*)?;base64,(.+)$/s);
  if (match) {
    const mimeType = match[1].toLowerCase();
    const buffer = Buffer.from(match[2], 'base64');
    const ext = mimeType.includes('webm')
      ? 'webm'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('mp4') || mimeType.includes('m4a')
          ? 'm4a'
          : mimeType.includes('mp3') || mimeType.includes('mpeg')
            ? 'mp3'
            : 'wav';
    return { buffer, mimeType, ext };
  }
  const buffer = Buffer.from(trimmed, 'base64');
  return { buffer, mimeType: 'audio/wav', ext: 'wav' };
}

/**
 * Parses a standard RIFF WAVE buffer into normalized mono Float32Array samples [-1, 1] and sampleRate.
 */
function parseWavBuffer(buffer: Buffer): { samples: Float32Array; sampleRate: number } | null {
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataStart + 16 <= buffer.length) {
      audioFormat = buffer.readUInt16LE(chunkDataStart);
      numChannels = Math.max(1, buffer.readUInt16LE(chunkDataStart + 2));
      sampleRate = Math.max(8000, buffer.readUInt32LE(chunkDataStart + 4));
      bitsPerSample = buffer.readUInt16LE(chunkDataStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataSize = Math.min(chunkSize, buffer.length - chunkDataStart);
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) return null;

  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const blockAlign = bytesPerSample * numChannels;
  const totalFrames = Math.floor(dataSize / blockAlign);
  const samples = new Float32Array(totalFrames);

  for (let i = 0; i < totalFrames; i++) {
    let monoSum = 0;
    const frameBase = dataOffset + i * blockAlign;
    for (let ch = 0; ch < numChannels; ch++) {
      const samplePos = frameBase + ch * bytesPerSample;
      let val = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        val = buffer.readFloatLE(samplePos);
      } else if (bitsPerSample === 16) {
        val = buffer.readInt16LE(samplePos) / 32768;
      } else if (bitsPerSample === 8) {
        val = (buffer.readUInt8(samplePos) - 128) / 128;
      } else if (bitsPerSample === 24) {
        const b0 = buffer[samplePos];
        const b1 = buffer[samplePos + 1];
        const b2 = buffer[samplePos + 2];
        const int24 = ((b2 << 24) | (b1 << 16) | (b0 << 8)) >> 8;
        val = int24 / 8388608;
      } else if (bitsPerSample === 32) {
        val = buffer.readInt32LE(samplePos) / 2147483648;
      }
      monoSum += val;
    }
    samples[i] = Math.max(-1, Math.min(1, monoSum / numChannels));
  }

  return { samples, sampleRate };
}

/**
 * Estimates fundamental frequency (F0 in Hz) of a single frame using the YIN algorithm.
 */
function estimateFramePitchYin(frame: Float32Array, sampleRate: number): { f0: number; clarity: number } {
  const minTau = Math.max(2, Math.floor(sampleRate / 700)); // ~700 Hz max vocal hum fundamental
  const maxTau = Math.min(Math.floor(frame.length / 2), Math.floor(sampleRate / 75)); // ~75 Hz min
  if (maxTau <= minTau) return { f0: 0, clarity: 0 };

  const windowSize = maxTau;
  const diff = new Float32Array(maxTau + 1);
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;

  let runningSum = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < windowSize; i++) {
      const delta = frame[i] - frame[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
    runningSum += sum;
    cmnd[tau] = runningSum > 0 ? (sum * tau) / runningSum : 1;
  }

  const threshold = 0.22;
  let bestTau = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) {
        tau++;
      }
      bestTau = tau;
      break;
    }
  }

  if (bestTau < 0) {
    let minVal = Infinity;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (cmnd[tau] < minVal) {
        minVal = cmnd[tau];
        bestTau = tau;
      }
    }
    if (minVal > 0.42) return { f0: 0, clarity: 0 };
  }

  // Parabolic interpolation around bestTau
  let refinedTau = bestTau;
  if (bestTau > minTau && bestTau < maxTau) {
    const s0 = cmnd[bestTau - 1];
    const s1 = cmnd[bestTau];
    const s2 = cmnd[bestTau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-6) {
      refinedTau = bestTau + (s2 - s0) / denom;
    }
  }

  const clarity = Math.max(0, Math.min(1, 1 - cmnd[bestTau]));
  return { f0: sampleRate / refinedTau, clarity };
}

/**
 * Pearson correlation coefficient between two 12-element pitch-class arrays.
 */
function correlateChroma(chroma: number[], profile: number[], shift: number): number {
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < 12; i++) {
    meanX += chroma[i];
    meanY += profile[i];
  }
  meanX /= 12;
  meanY /= 12;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < 12; i++) {
    const x = chroma[(i + shift) % 12] - meanX;
    const y = profile[i] - meanY;
    num += x * y;
    denX += x * x;
    denY += y * y;
  }
  const denom = Math.sqrt(denX * denY);
  return denom > 1e-9 ? num / denom : 0;
}

/**
 * Extracts musical & paralinguistic features (BPM, Key/Scale, Melodic Contour, Groove, Energy, Vocal Timbre, Mood)
 * from a WAV buffer in <15ms with zero external binary dependencies.
 */
export function extractAudioFeaturesFromWav(buffer: Buffer): AudioDspFeatures {
  const parsed = parseWavBuffer(buffer);
  if (!parsed || parsed.samples.length < 400) {
    return {
      durationSec: 4,
      bpm: 115,
      keyScale: 'A minor',
      scaleMode: 'minor',
      meanPitchHz: 220,
      pitchRangeSemitones: 5,
      contour: 'flowing melodic motif',
      groove: 'steady rhythmic pulse',
      onsetRatePerSec: 1.8,
      energyLevel: 'moderate',
      energyTrend: 'steady',
      vocalTone: 'natural, expressive vocal delivery',
      mood: 'reflective, emotional and atmospheric',
    };
  }

  const { samples, sampleRate } = parsed;
  const durationSec = Math.max(0.5, Number((samples.length / sampleRate).toFixed(2)));

  // Normalize peak amplitude for consistent feature extraction across quiet/loud mics
  let peakAbs = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peakAbs) peakAbs = a;
  }
  const normGain = peakAbs > 0.01 ? 0.85 / peakAbs : 1;

  const frameSize = Math.floor(sampleRate * 0.032); // 32ms frame
  const hopSize = Math.floor(sampleRate * 0.016); // 16ms hop (62.5 fps)
  const numFrames = Math.max(1, Math.floor((samples.length - frameSize) / hopSize));

  const rmsEnv = new Float32Array(numFrames);
  const zcrEnv = new Float32Array(numFrames);
  const hfRatioEnv = new Float32Array(numFrames);
  const chroma = new Array(12).fill(0);
  const voicedMidiNotes: { frameIdx: number; midi: number; hz: number; weight: number }[] = [];

  const frameBuf = new Float32Array(frameSize);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    let sumSq = 0;
    let diffSq = 0;
    let zeroCrossings = 0;

    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i] * normGain;
      frameBuf[i] = s;
      sumSq += s * s;
      if (i > 0) {
        const prev = frameBuf[i - 1];
        const d = s - prev;
        diffSq += d * d;
        if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
          zeroCrossings++;
        }
      }
    }

    const rms = Math.sqrt(sumSq / frameSize);
    rmsEnv[f] = rms;
    zcrEnv[f] = zeroCrossings / frameSize;
    hfRatioEnv[f] = sumSq > 1e-7 ? Math.sqrt(diffSq / Math.max(1e-7, sumSq)) : 0;

    // Run pitch tracking on voiced frames (every 2nd hop = 32ms to stay <10ms total CPU)
    if (rms > 0.045 && f % 2 === 0) {
      const { f0, clarity } = estimateFramePitchYin(frameBuf, sampleRate);
      if (f0 >= 75 && f0 <= 700 && clarity >= 0.58) {
        const midi = 69 + 12 * Math.log2(f0 / 440);
        const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
        const weight = rms * clarity;
        chroma[pitchClass] += weight;
        voicedMidiNotes.push({ frameIdx: f, midi, hz: f0, weight });
      }
    }
  }

  // 1. Onset Strength Envelope & Tempo (BPM) + Groove Detection
  const onsetEnv = new Float32Array(numFrames);
  for (let f = 1; f < numFrames; f++) {
    const diff = rmsEnv[f] - rmsEnv[f - 1];
    onsetEnv[f] = diff > 0 ? diff : 0;
  }

  // Smooth onset envelope (3-frame moving average)
  const smoothOnset = new Float32Array(numFrames);
  let maxOnset = 0;
  for (let f = 1; f < numFrames - 1; f++) {
    const v = (onsetEnv[f - 1] + onsetEnv[f] * 2 + onsetEnv[f + 1]) / 4;
    smoothOnset[f] = v;
    if (v > maxOnset) maxOnset = v;
  }

  // Count distinct rhythmic onsets (peaks above adaptive threshold with 110ms refractory window)
  const minPeakGapFrames = Math.max(2, Math.floor(0.11 / 0.016));
  const onsetFrames: number[] = [];
  const peakThreshold = Math.max(0.015, maxOnset * 0.26);
  let lastPeakFrame = -minPeakGapFrames;

  for (let f = 1; f < numFrames - 1; f++) {
    if (
      smoothOnset[f] >= peakThreshold &&
      smoothOnset[f] >= smoothOnset[f - 1] &&
      smoothOnset[f] >= smoothOnset[f + 1] &&
      f - lastPeakFrame >= minPeakGapFrames
    ) {
      onsetFrames.push(f);
      lastPeakFrame = f;
    }
  }

  const onsetRatePerSec = Number((onsetFrames.length / durationSec).toFixed(2));

  // Autocorrelation over onset envelope for BPM (60 to 180 BPM)
  const fps = sampleRate / hopSize;
  const minLag = Math.max(2, Math.floor((fps * 60) / 180));
  const maxLag = Math.min(numFrames - 2, Math.ceil((fps * 60) / 60));
  let bestBpm = 110;
  let bestScore = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let f = 0; f + lag < numFrames; f++) {
      ac += smoothOnset[f] * smoothOnset[f + lag];
    }
    const candidateBpm = (fps * 60) / lag;
    // Perceptual tempo prior centered around 112 BPM so octave harmonics resolve naturally
    const logDist = Math.log2(candidateBpm / 112);
    const perceptualWeight = Math.exp(-0.5 * (logDist / 0.65) * (logDist / 0.65));
    const score = ac * perceptualWeight;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = Math.round(candidateBpm);
    }
  }

  // Adjust BPM range with onset density if very sparse/slow or very rapid
  if (onsetRatePerSec < 1.1 && bestBpm > 108) {
    bestBpm = Math.round(bestBpm * 0.75);
  } else if (onsetRatePerSec > 3.2 && bestBpm < 105) {
    bestBpm = Math.round(bestBpm * 1.35);
  }
  const bpm = normalizeBpm(bestBpm) || 115;

  // Analyze inter-onset intervals (IOI) for groove characterization
  let ioiCv = 0.25;
  if (onsetFrames.length >= 3) {
    const iois: number[] = [];
    for (let i = 1; i < onsetFrames.length; i++) {
      iois.push((onsetFrames[i] - onsetFrames[i - 1]) / fps);
    }
    const meanIoi = iois.reduce((a, b) => a + b, 0) / iois.length;
    const variance = iois.reduce((a, b) => a + (b - meanIoi) ** 2, 0) / iois.length;
    ioiCv = meanIoi > 0 ? Math.sqrt(variance) / meanIoi : 0.25;
  }

  const groove =
    onsetRatePerSec < 1.1
      ? 'slow, spacious legato phrasing with sustained notes'
      : ioiCv > 0.38
        ? 'syncopated, bouncy rhythmic cadence with expressive swing'
        : onsetRatePerSec > 2.8
          ? 'fast, driving, punchy rhythmic pulse'
          : 'steady, locked-in rhythmic groove';

  // 2. Key & Scale Detection (Krumhansl-Schmuckler) + Melodic Pitch Contour
  let bestKeyRoot = 'A';
  let bestScaleMode: 'major' | 'minor' = 'minor';
  const totalChromaWeight = chroma.reduce((a, b) => a + b, 0);

  if (totalChromaWeight > 1e-4) {
    let maxCorr = -Infinity;
    for (let rootIdx = 0; rootIdx < 12; rootIdx++) {
      const majCorr = correlateChroma(chroma, MAJOR_PROFILE, rootIdx);
      if (majCorr > maxCorr) {
        maxCorr = majCorr;
        bestKeyRoot = ROOT_NOTES[rootIdx];
        bestScaleMode = 'major';
      }
      const minCorr = correlateChroma(chroma, MINOR_PROFILE, rootIdx);
      if (minCorr > maxCorr) {
        maxCorr = minCorr;
        bestKeyRoot = ROOT_NOTES[rootIdx];
        bestScaleMode = 'minor';
      }
    }
  }
  const keyScale = normalizeKeyScale(`${bestKeyRoot} ${bestScaleMode}`) || 'A minor';

  // Pitch statistics & melodic contour
  let meanPitchHz = 220;
  let pitchRangeSemitones = 5;
  let contour = 'flowing melodic motif';

  if (voicedMidiNotes.length >= 3) {
    const sortedMidis = voicedMidiNotes.map((n) => n.midi).sort((a, b) => a - b);
    const p10 = sortedMidis[Math.floor(sortedMidis.length * 0.1)];
    const p90 = sortedMidis[Math.floor(sortedMidis.length * 0.9)];
    pitchRangeSemitones = Math.max(1, Math.round(p90 - p10));
    meanPitchHz = Math.round(
      voicedMidiNotes.reduce((acc, n) => acc + n.hz, 0) / voicedMidiNotes.length
    );

    const third = Math.max(1, Math.floor(voicedMidiNotes.length / 3));
    const startMidi =
      voicedMidiNotes.slice(0, third).reduce((a, b) => a + b.midi, 0) / third;
    const midMidi =
      voicedMidiNotes.slice(third, third * 2).reduce((a, b) => a + b.midi, 0) /
      Math.max(1, voicedMidiNotes.slice(third, third * 2).length);
    const endMidi =
      voicedMidiNotes.slice(-third).reduce((a, b) => a + b.midi, 0) / third;

    const deltaStartMid = midMidi - startMidi;
    const deltaMidEnd = endMidi - midMidi;
    const deltaTotal = endMidi - startMidi;

    if (deltaStartMid > 1.2 && deltaMidEnd < -1.2) {
      contour = 'arch-shaped melodic motif (rising to a peak then resolving downward)';
    } else if (deltaStartMid < -1.2 && deltaMidEnd > 1.2) {
      contour = 'dipping wave motif (falling then lifting upward at the end)';
    } else if (deltaTotal > 1.5) {
      contour = 'ascending, uplifting melodic line building in pitch';
    } else if (deltaTotal < -1.5) {
      contour = 'descending, sighing melodic line resolving lower';
    } else {
      contour =
        pitchRangeSemitones <= 3
          ? 'hypnotic, chant-like motif centered on a tight pitch anchor'
          : 'rolling, balanced melodic hook';
    }
  }

  // 3. Energy, Vocal Timbre & Emotion/Mood Mapping
  let rawRmsSum = 0;
  let voicedZcrSum = 0;
  let voicedHfSum = 0;
  let voicedCount = 0;

  for (let f = 0; f < numFrames; f++) {
    rawRmsSum += rmsEnv[f] / normGain;
    if (rmsEnv[f] > 0.05) {
      voicedZcrSum += zcrEnv[f];
      voicedHfSum += hfRatioEnv[f];
      voicedCount++;
    }
  }

  const avgRawRms = rawRmsSum / numFrames;
  const avgZcr = voicedCount > 0 ? voicedZcrSum / voicedCount : 0.06;
  const avgHf = voicedCount > 0 ? voicedHfSum / voicedCount : 0.35;

  const energyLevel: 'soft' | 'moderate' | 'high' =
    avgRawRms < 0.045 && onsetRatePerSec < 1.6
      ? 'soft'
      : avgRawRms > 0.14 || onsetRatePerSec > 2.6
        ? 'high'
        : 'moderate';

  const halfFrames = Math.max(1, Math.floor(numFrames / 2));
  let firstHalfRms = 0;
  let secondHalfRms = 0;
  for (let f = 0; f < halfFrames; f++) firstHalfRms += rmsEnv[f];
  for (let f = halfFrames; f < numFrames; f++) secondHalfRms += rmsEnv[f];
  firstHalfRms /= halfFrames;
  secondHalfRms /= Math.max(1, numFrames - halfFrames);

  const energyTrend: 'steady' | 'building' | 'fading' =
    secondHalfRms > firstHalfRms * 1.22
      ? 'building'
      : secondHalfRms < firstHalfRms * 0.78
        ? 'fading'
        : 'steady';

  const isBright = avgHf > 0.42 || meanPitchHz > 260;
  const isBreathy = avgZcr > 0.085 || energyLevel === 'soft';

  const vocalTone = [
    energyLevel === 'soft' ? 'soft, intimate' : energyLevel === 'high' ? 'energetic, projected' : 'warm, natural',
    isBreathy ? 'breathy' : 'focused',
    isBright ? 'bright-toned' : 'mellow, low-mid rich',
  ].join(', ');

  let mood = 'reflective, atmospheric and emotional';
  if (bestScaleMode === 'minor') {
    if (bpm < 100 || energyLevel === 'soft') {
      mood = 'melancholic, wistful, intimate and nocturnal';
    } else if (energyLevel === 'high' || bpm >= 122) {
      mood = 'dark, driving, urgent and hypnotic';
    } else {
      mood = 'moody, introspective, soulful and bittersweet';
    }
  } else {
    if (bpm >= 116 || energyLevel === 'high') {
      mood = 'upbeat, cheerful, energetic and carefree';
    } else if (energyLevel === 'soft') {
      mood = 'tender, dreamy, warm and serene';
    } else {
      mood = 'uplifting, hopeful, warm and melodic';
    }
  }

  return {
    durationSec,
    bpm,
    keyScale,
    scaleMode: bestScaleMode,
    meanPitchHz,
    pitchRangeSemitones,
    contour,
    groove,
    onsetRatePerSec,
    energyLevel,
    energyTrend,
    vocalTone,
    mood,
  };
}

/**
 * Checks whether a single lowercased alphanumeric token is a non-lexical hum, scat, or vocal filler syllable.
 */
function isVocableWord(rawWord: string): boolean {
  const w = rawWord.toLowerCase().replace(/[^a-z0-9']/g, '');
  if (!w) return true;
  if (w === 'a' || w === 'i') return false;
  if (NON_LEXICAL_VOCABLES.has(w)) return true;
  // Any other single-character token (e.g., Cartesia spelling out "M H M" -> "m", "h", "m")
  if (w.length === 1) return true;
  // Pure nasal/hum consonant strings ("mhm", "mhmm", "hmn", "nhm")
  if (/^[mhn]+$/.test(w)) return true;
  // Stretched vocalizations with 3+ identical consecutive letters ("mmmm", "laaa", "oooh", "pummm")
  if (/(.)\1\1/.test(w)) return true;
  // Reduplicated hum/scat syllables ("pumpum", "bambam", "dumdum", "lalala", "dadada", "hmhm")
  if (
    /^(?:la|lo|lu|da|do|du|ba|bo|bu|na|no|nu|pa|po|pu|ta|to|tu|ka|ko|ku|ha|ho|hu|hm|mm|uh|um|pum|pom|pam|bum|bom|bam|dum|dom|dam|tum|tom|tam|bap|bop|bip|pap|pop|pup){2,}$/.test(
      w
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Determines whether an STT transcript contains real lexical words (spoken instructions or sung lyrics)
 * versus non-lexical humming/scatting vocables ("pum pum mhm", "mm", "hmm", "la la") or indiscernible speech.
 */
export function isLexicalTranscript(text: string): boolean {
  const strippedTags = text
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*|[♪♫]+/g, ' ')
    // Collapse spelled-out hums like "m h m" or "h m m" into "mhm"
    .replace(/\b(?:m\s+h\s+m|m\s+m\s+h\s+m|h\s+m\s+m|m\s+m+)\b/g, ' mhm ')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!strippedTags) return false;
  if (WHISPER_NON_SPEECH_HALLUCINATIONS.has(strippedTags)) return false;

  const words = strippedTags.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  let vocableCount = 0;
  const meaningfulWords: string[] = [];

  for (const w of words) {
    if (isVocableWord(w)) {
      vocableCount++;
      continue;
    }
    if (SHORT_FUNCTION_WORDS.has(w) || w.length <= 2) {
      continue;
    }
    meaningfulWords.push(w);
  }

  const uniqueMeaningful = new Set(meaningfulWords);

  // If at least half the tokens are hum/scat vocables and there are fewer than 3 distinct real words, flag as non-lexical hum
  if (vocableCount / words.length >= 0.5 && uniqueMeaningful.size < 3) {
    return false;
  }

  return (
    (meaningfulWords.length >= 2 && uniqueMeaningful.size >= 2) ||
    (words.length === 1 && vocableCount === 0 && meaningfulWords.length === 1 && meaningfulWords[0].length >= 5)
  );
}

/**
 * Removes stray non-lexical hum vocables ("pum", "mhm", "hmm", "uh", "um") and audio event tags
 * from an otherwise lexical transcript so hum syllables never leak into Nemotron 3 Ultra.
 */
export function sanitizeLexicalTranscript(text: string): string {
  const withoutTags = text
    .replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*|[♪♫]+/g, ' ')
    .replace(/\b(?:[Mm]\s+[Hh]\s+[Mm]|[Mm]\s+[Mm]\s+[Hh]\s+[Mm]|[Hh]\s+[Mm]\s+[Mm])\b/g, ' ');

  const tokens = withoutTags.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((tok) => {
    const clean = tok.toLowerCase().replace(/[^a-z0-9']/g, '');
    if (!clean) return false;
    return !isVocableWord(clean);
  });

  return kept
    .join(' ')
    .replace(/^[,.;:!?\-\s]+|[,.;:!?\-\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Ultra-fast STT transcription using Cartesia ink-whisper (~400ms) as primary
 * and ElevenLabs Scribe v2 as automatic fallback.
 * Flags non-lexical hums / indiscernible speech and suppresses their text so vocables never pollute Nemotron 3 Ultra.
 */
export async function transcribeAudioFast(
  buffer: Buffer,
  mimeType: string,
  ext: string,
  signal?: AbortSignal
): Promise<AudioSttResult> {
  const cartesiaKey = process.env.CARTESIA_API_KEY?.trim();
  const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();

  // 1. Primary: Cartesia ink-whisper (~400ms latency)
  if (cartesiaKey) {
    try {
      const form = new FormData();
      form.append('model', 'ink-whisper');
      form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), `vibe.${ext}`);

      const res = await fetch('https://api.cartesia.ai/stt', {
        method: 'POST',
        headers: {
          'X-API-Key': cartesiaKey,
          'Cartesia-Version': '2025-04-16',
        },
        body: form,
        signal,
      });

      if (res.ok) {
        const data: any = await res.json();
        const rawText = String(data?.text || '').trim();
        const rawLang = String(data?.language || 'en').slice(0, 2).toLowerCase();
        const lexical = isLexicalTranscript(rawText);
        const sanitized = lexical ? sanitizeLexicalTranscript(rawText) : '';
        const finalLexical = lexical && Boolean(sanitized);
        return {
          text: finalLexical ? sanitized : '',
          language: finalLexical ? rawLang : 'en',
          isLexical: finalLexical,
          flaggedAs: finalLexical ? 'lexical_speech_or_lyrics' : 'non_lexical_hum_or_indiscernible',
          provider: 'cartesia',
        };
      }
    } catch (err) {
      console.warn('[VibeAudio] Cartesia STT warning, falling back to ElevenLabs:', err);
    }
  }

  // 2. Fallback: ElevenLabs Scribe v2
  if (elevenKey) {
    try {
      const form = new FormData();
      form.append('model_id', 'scribe_v2');
      form.append('tag_audio_events', 'true');
      form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), `vibe.${ext}`);

      const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: {
          'xi-api-key': elevenKey,
        },
        body: form,
        signal,
      });

      if (res.ok) {
        const data: any = await res.json();
        const rawText = String(data?.text || '').trim();
        const rawLang = String(data?.language_code || 'en').toLowerCase();
        const language = rawLang.startsWith('eng') ? 'en' : rawLang.slice(0, 2);
        const lexical = isLexicalTranscript(rawText);
        const sanitized = lexical ? sanitizeLexicalTranscript(rawText) : '';
        const finalLexical = lexical && Boolean(sanitized);
        return {
          text: finalLexical ? sanitized : '',
          language: finalLexical ? language : 'en',
          isLexical: finalLexical,
          flaggedAs: finalLexical ? 'lexical_speech_or_lyrics' : 'non_lexical_hum_or_indiscernible',
          provider: 'elevenlabs',
        };
      }
    } catch (err) {
      console.warn('[VibeAudio] ElevenLabs STT warning:', err);
    }
  }

  return {
    text: '',
    language: 'en',
    isLexical: false,
    flaggedAs: 'non_lexical_hum_or_indiscernible',
    provider: 'none',
  };
}

/**
 * Runs DSP feature extraction (<15ms) and Instant STT (~400ms) in parallel,
 * synthesizing a natural, rhythm- and emotion-aware prompt for Nemotron 3 Ultra.
 */
export async function analyzeAudioVibe(params: {
  audio: string;
  userPrompt?: string;
  signal?: AbortSignal;
}): Promise<AudioVibeAnalysis> {
  const { buffer, mimeType, ext } = decodeAudioDataUrl(params.audio);

  const [features, stt] = await Promise.all([
    Promise.resolve().then(() => extractAudioFeaturesFromWav(buffer)),
    transcribeAudioFast(buffer, mimeType, ext, params.signal),
  ]);

  const extraText = params.userPrompt?.trim() || '';
  const cleanTranscript = stt.isLexical ? stt.text.trim() : '';

  let synthesizedPrompt: string;

  if (stt.isLexical && cleanTranscript) {
    // User either spoke instructions or sang lyrics with real words
    synthesizedPrompt = [
      extraText ? `${extraText} —` : '',
      `Voice / sung input: "${cleanTranscript}".`,
      `Detected vocal vibe & musical telemetry: ${features.mood} mood, ${features.vocalTone} vocal delivery,`,
      `${features.groove} around ${features.bpm} BPM in ${features.keyScale},`,
      `with a ${features.contour} (${features.energyTrend} dynamics).`,
    ]
      .filter(Boolean)
      .join(' ');
  } else {
    // User hummed a melody or indiscernible vocalization without lexical words.
    // Never include raw STT vocables ("pum pum mhm", "la la") in the prompt so Nemotron writes real poetic lyrics.
    synthesizedPrompt = [
      extraText ? `${extraText} —` : '',
      `Hummed musical motive: a ${features.mood} song in ${features.keyScale} at ${features.bpm} BPM.`,
      `Features a ${features.groove}, ${features.contour},`,
      `and a ${features.vocalTone} vocal feel with ${features.energyTrend} energy.`,
    ]
      .filter(Boolean)
      .join(' ');
  }

  return {
    prompt: synthesizedPrompt.trim(),
    features,
    stt,
  };
}
