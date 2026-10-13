import { valkey } from '../broker/valkey.js';
import { listStemsBySong } from '../databases/stems.js';
import { listTakesBySong, updateTakeLyrics } from '../databases/takes.js';
import type {
  Take,
  TakeProvenance,
  AlignedWord,
  AlignedLine,
  LyricsAlignment,
} from '../databases/schema/takes.js';
import { readAudio } from '../storage/r2.js';

const ISO3_TO_VOCAL_LANG: Record<string, string> = {
  eng: 'en', en: 'en',
  spa: 'es', es: 'es',
  fra: 'fr', fre: 'fr', fr: 'fr',
  deu: 'de', ger: 'de', de: 'de',
  ita: 'it', it: 'it',
  por: 'pt', pt: 'pt',
  jpn: 'ja', ja: 'ja',
  kor: 'ko', ko: 'ko',
  zho: 'zh', chi: 'zh', cmn: 'zh', yue: 'yue', zh: 'zh',
  rus: 'ru', ru: 'ru',
  ara: 'ar', ar: 'ar',
  hin: 'hi', hi: 'hi',
  tur: 'tr', tr: 'tr',
  nld: 'nl', dut: 'nl', nl: 'nl',
  pol: 'pl', pl: 'pl',
  swe: 'sv', sv: 'sv',
  vie: 'vi', vi: 'vi',
  ind: 'id', id: 'id',
  tha: 'th', th: 'th',
  ukr: 'uk', uk: 'uk',
  ell: 'el', gre: 'el', el: 'el',
  ces: 'cs', cze: 'cs', cs: 'cs',
  ron: 'ro', rum: 'ro', ro: 'ro',
  hun: 'hu', hu: 'hu',
  fin: 'fi', fi: 'fi',
  dan: 'da', da: 'da',
  heb: 'he', he: 'he',
  ben: 'bn', bn: 'bn',
  tam: 'ta', ta: 'ta',
  tel: 'te', te: 'te',
  mar: 'mr', mr: 'mr',
  urd: 'ur', ur: 'ur',
  fas: 'fa', per: 'fa', fa: 'fa',
  msa: 'ms', may: 'ms', ms: 'ms',
  tgl: 'tl', fil: 'tl', tl: 'tl',
  swa: 'sw', sw: 'sw',
};

const inFlightSongs = new Set<string>();
const inFlightAlignSongs = new Set<string>();

function normalizeLanguageCode(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return 'en';
  const clean = raw.trim().toLowerCase().split(/[-_]/)[0];
  return ISO3_TO_VOCAL_LANG[clean] || (clean.length === 2 ? clean : 'en');
}

function isMeaningfulLyrics(lyrics?: string | null): boolean {
  if (!lyrics || typeof lyrics !== 'string') return false;
  const trimmed = lyrics.trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase() === '[instrumental]' || trimmed.toLowerCase() === 'instrumental') return false;
  return true;
}

function isValidAlignment(candidate: any): candidate is LyricsAlignment {
  return (
    Boolean(candidate) &&
    typeof candidate === 'object' &&
    Array.isArray(candidate.lines) &&
    candidate.lines.length > 0 &&
    Array.isArray(candidate.words)
  );
}

function extractStoredLyricsAndLang(
  takes: Take[],
  preferredLanguage?: string
): {
  lyrics: string;
  vocalLanguage: string;
  alignment: LyricsAlignment | null;
  alreadyTranscribed: boolean;
  alreadyAligned: boolean;
  fromScribe: boolean;
} {
  let authoritativeLang = preferredLanguage ? normalizeLanguageCode(preferredLanguage) : '';
  let scribeLang = '';
  let alreadyTranscribed = false;
  let alreadyAligned = false;
  let hasSubmittedLyrics = false;
  let alignment: LyricsAlignment | null = null;

  const priorityTakes = [
    ...takes.filter((t) => t.is_active),
    ...takes.filter((t) => t.task === 'text2music'),
    ...takes.filter((t) => t.task === 'extract'),
    ...takes,
  ];

  for (const take of priorityTakes) {
    const params = (take.provenance?.parameters ?? {}) as Record<string, any>;
    const submitted = (params.submitted ?? {}) as Record<string, any>;
    const resolved = (params.resolved ?? {}) as Record<string, any>;
    const explicitCandidate =
      params.vocalLanguage ||
      submitted.vocalLanguage ||
      resolved.vocalLanguage ||
      resolved.language;
    if (!authoritativeLang && explicitCandidate && typeof explicitCandidate === 'string' && explicitCandidate !== 'unknown') {
      authoritativeLang = normalizeLanguageCode(explicitCandidate);
    }
    if (!scribeLang && params.scribeLanguage && typeof params.scribeLanguage === 'string' && params.scribeLanguage !== 'unknown') {
      scribeLang = normalizeLanguageCode(params.scribeLanguage);
    }
    if (isMeaningfulLyrics(submitted.lyrics)) {
      hasSubmittedLyrics = true;
    }
    if (params.scribeTranscribed === true) {
      alreadyTranscribed = true;
    }
    if (params.lyricsAlignedAttempted === true) {
      alreadyAligned = true;
    }
    if (!alignment && isValidAlignment(params.lyricsAlignment)) {
      alignment = params.lyricsAlignment;
      alreadyAligned = true;
    }
  }

  const detectedLang = authoritativeLang || scribeLang || 'en';
  const fromScribe = alreadyTranscribed && !hasSubmittedLyrics;

  for (const take of priorityTakes) {
    if (isMeaningfulLyrics(take.lyrics)) {
      return {
        lyrics: take.lyrics!.trim(),
        vocalLanguage: detectedLang,
        alignment,
        alreadyTranscribed: true,
        alreadyAligned,
        fromScribe,
      };
    }
    const params = (take.provenance?.parameters ?? {}) as Record<string, any>;
    const storedLyrics = params.transcribedLyrics ?? params.submitted?.lyrics ?? params.lyrics;
    if (isMeaningfulLyrics(storedLyrics)) {
      return {
        lyrics: String(storedLyrics).trim(),
        vocalLanguage: detectedLang,
        alignment,
        alreadyTranscribed: true,
        alreadyAligned,
        fromScribe,
      };
    }
  }

  return {
    lyrics: '',
    vocalLanguage: detectedLang,
    alignment,
    alreadyTranscribed,
    alreadyAligned,
    fromScribe,
  };
}

export interface ScribeWord {
  text?: string;
  start?: number;
  end?: number;
  type?: string;
  loss?: number;
}

function normalizeMatchChars(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Repairs CTC forced-alignment anomalies where the first 1-2 words of a line
 * get anchored onto a breath/bleed before an instrumental pause and stretched
 * across silence until the singer actually starts singing.
 */
export function sanitizeAlignedLineWords(rawWords: AlignedWord[]): AlignedWord[] {
  if (!Array.isArray(rawWords) || rawWords.length === 0) return [];
  const words: AlignedWord[] = rawWords.map((w) => ({ ...w }));

  if (words.length >= 2) {
    for (let k = Math.min(1, words.length - 2); k >= 0; k--) {
      const w = words[k];
      const next = words[k + 1];
      const prev = k > 0 ? words[k - 1] : null;
      const dur = w.end - w.start;
      const gapToNext = next.start - w.end;
      const gapFromPrev = prev ? w.start - prev.end : Infinity;
      const loss = w.loss ?? 0;

      // Only pull forward if there is an actual silence gap before the next word,
      // or if the very first word of the line (not attached to a preceding word) is stretched across silence.
      const isPrematureBlip = gapToNext > 1.2;
      const isIsolatedPreSilenceStretch = gapFromPrev > 0.6 && dur > 1.6 && loss > 1.8;

      if (isPrematureBlip || isIsolatedPreSilenceStretch) {
        const cleanLen = Math.max(1, normalizeMatchChars(w.text).length);
        const estDur = Math.min(0.45, Math.max(0.18, cleanLen * 0.065));
        const newEnd = Number(Math.max(0, next.start - 0.04).toFixed(3));
        const newStart = Number(Math.max(0, newEnd - estDur).toFixed(3));
        w.start = newStart;
        w.end = Math.max(newStart, newEnd);
      }
    }
  }

  return words;
}

export function splitWordsIntoAlignedPhrases(rawWords: AlignedWord[]): AlignedWord[][] {
  const words = sanitizeAlignedLineWords(rawWords);
  if (words.length === 0) return [];
  const chunks: AlignedWord[][] = [];
  let current: AlignedWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1] ?? null;
    const next2 = words[i + 2] ?? null;
    current.push(w);

    if (!next) {
      chunks.push(sanitizeAlignedLineWords(current));
      current = [];
      break;
    }

    const pauseAfter = next.start - w.end;
    const wordDur = w.end - w.start;
    const endsSentence = /[.!?…。！？]['"’)\]]*$/.test(w.text);
    const endsClause = /[,;:—–،、-]$/.test(w.text);

    // Look ahead 1-2 words so we never split right before a 1-2 word sentence/phrase ending
    const pauseAfterNext = next2 ? next2.start - next.end : Infinity;
    const nextEndsPhrase =
      /[.!?…。！？]['"’)\]]*$/.test(next.text) || pauseAfterNext >= 0.55;
    const pauseAfterNext2 = words[i + 3] ? words[i + 3].start - (next2?.end ?? 0) : Infinity;
    const next2EndsPhrase =
      next2 !== null &&
      !nextEndsPhrase &&
      (/[.!?…。！？]['"’)\]]*$/.test(next2.text) || pauseAfterNext2 >= 0.55);

    const shouldFlush =
      (endsSentence && (current.length >= 2 || pauseAfter >= 0.35)) ||
      pauseAfter >= 0.55 ||
      (wordDur >= 1.8 && current.length >= 2 && !nextEndsPhrase) ||
      (endsClause && current.length >= 4 && !nextEndsPhrase && !next2EndsPhrase) ||
      (current.length >= 8 && !nextEndsPhrase && !next2EndsPhrase && (pauseAfter >= 0.14 || current.length >= 10));

    if (shouldFlush) {
      chunks.push(sanitizeAlignedLineWords(current));
      current = [];
    }
  }

  if (current.length > 0) {
    chunks.push(sanitizeAlignedLineWords(current));
  }

  return chunks;
}

export function buildScribeLyricsAndAlignment(
  rawText?: string,
  words?: ScribeWord[]
): { lyrics: string; alignment: LyricsAlignment | null } {
  if (Array.isArray(words) && words.length > 0) {
    const mergedWords: AlignedWord[] = [];
    let lastEnd = 0;

    for (const token of words) {
      if (!token || typeof token.text !== 'string') continue;
      if (token.type === 'audio_event' || token.type === 'spacing') continue;
      const cleanToken = token.text.trim();
      if (!cleanToken) continue;

      const start = typeof token.start === 'number' && Number.isFinite(token.start) ? Number(token.start.toFixed(3)) : null;
      const end = typeof token.end === 'number' && Number.isFinite(token.end) ? Number(token.end.toFixed(3)) : null;

      if (/^[,.;!?'"’)\]-]+$/.test(cleanToken) && mergedWords.length > 0) {
        const prevWord = mergedWords[mergedWords.length - 1];
        prevWord.text += cleanToken;
        if (end !== null && end > prevWord.end) {
          prevWord.end = end;
        }
        if (end !== null) lastEnd = end;
        continue;
      }

      const wordStart = start ?? lastEnd;
      const wordEnd = end !== null && end >= wordStart ? end : wordStart;
      mergedWords.push({
        text: cleanToken,
        start: wordStart,
        end: wordEnd,
        ...(typeof token.loss === 'number' && Number.isFinite(token.loss) ? { loss: Number(token.loss.toFixed(4)) } : {}),
      });
      if (end !== null) lastEnd = end;
    }

    const phraseChunks = splitWordsIntoAlignedPhrases(mergedWords);
    const lines: AlignedLine[] = phraseChunks.map((chunk, idx) => {
      const text = chunk.map((w) => w.text).join(' ').trim();
      return {
        index: idx,
        text,
        isTag: /^\s*\[[^\]]+\]\s*$/.test(text),
        start: chunk.length > 0 ? chunk[0].start : null,
        end: chunk.length > 0 ? chunk[chunk.length - 1].end : null,
        words: chunk,
      };
    });

    const joined = lines.map((l) => l.text).join('\n').trim();
    if (joined && lines.length > 0) {
      return {
        lyrics: joined,
        alignment: {
          source: 'scribe_v2',
          updatedAt: new Date().toISOString(),
          lines,
          words: lines.flatMap((l) => l.words),
        },
      };
    }
  }

  if (typeof rawText === 'string' && rawText.trim()) {
    const formatted = rawText
      .trim()
      .replace(/\s*\n\s*/g, '\n')
      .replace(/([.!?])\s+(?=[A-Z])/g, '$1\n');
    return { lyrics: formatted, alignment: null };
  }

  return { lyrics: '', alignment: null };
}

/**
 * Strips [Section] tags for acoustic alignment and maps ElevenLabs /v1/forced-alignment
 * word timestamps back onto the original lyric lines (preserving [Intro], [Verse], [Chorus] tags).
 */
export function buildForcedAlignmentLines(
  rawLyrics: string,
  alignedTokens?: ScribeWord[]
): LyricsAlignment | null {
  if (!isMeaningfulLyrics(rawLyrics) || !Array.isArray(alignedTokens) || alignedTokens.length === 0) {
    return null;
  }

  const validTokens: AlignedWord[] = [];
  for (const t of alignedTokens) {
    if (!t || typeof t.text !== 'string') continue;
    const clean = t.text.trim();
    if (!clean) continue;
    const start = typeof t.start === 'number' && Number.isFinite(t.start) ? Number(t.start.toFixed(3)) : null;
    const end = typeof t.end === 'number' && Number.isFinite(t.end) ? Number(t.end.toFixed(3)) : null;
    if (start === null && end === null) continue;
    const s = start ?? end ?? 0;
    const e = end !== null && end >= s ? end : s;

    if (/^[,.;!?'"’)\]-]+$/.test(clean) && validTokens.length > 0) {
      const prev = validTokens[validTokens.length - 1];
      prev.text += clean;
      if (e > prev.end) prev.end = e;
      continue;
    }

    validTokens.push({
      text: clean,
      start: s,
      end: e,
      ...(typeof t.loss === 'number' && Number.isFinite(t.loss) ? { loss: Number(t.loss.toFixed(4)) } : {}),
    });
  }

  if (validTokens.length === 0) return null;

  const rawLines = rawLyrics
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length === 0) return null;

  const parsedLines = rawLines.map((lineText) => {
    const isTag = /^\s*\[[^\]]+\]\s*$/.test(lineText);
    const sungText = isTag ? '' : lineText.replace(/\[[^\]]+\]/g, ' ').trim();
    const expectedWords = sungText ? sungText.split(/\s+/).filter(Boolean) : [];
    const expectedCharLen = normalizeMatchChars(sungText).length;
    return {
      text: lineText,
      isTag,
      expectedWords,
      expectedCharLen,
    };
  });

  const totalExpectedWords = parsedLines.reduce((acc, l) => acc + l.expectedWords.length, 0);
  const lines: AlignedLine[] = [];
  let tokenCursor = 0;

  for (let i = 0; i < parsedLines.length; i++) {
    const item = parsedLines[i];
    if (item.isTag || item.expectedWords.length === 0) {
      lines.push({
        index: lines.length,
        text: item.text,
        isTag: item.isTag,
        start: null,
        end: null,
        words: [],
      });
      continue;
    }

    const lineWords: AlignedWord[] = [];
    if (validTokens.length === totalExpectedWords) {
      for (let k = 0; k < item.expectedWords.length && tokenCursor < validTokens.length; k++) {
        lineWords.push(validTokens[tokenCursor++]);
      }
    } else {
      const remainingSungLines = parsedLines.slice(i + 1).filter((l) => !l.isTag && l.expectedWords.length > 0).length;
      let consumedChars = 0;
      const targetChars = Math.max(1, item.expectedCharLen);
      while (
        tokenCursor < validTokens.length - remainingSungLines &&
        (lineWords.length === 0 || consumedChars < targetChars)
      ) {
        const nextTok = validTokens[tokenCursor];
        const nextLen = Math.max(1, normalizeMatchChars(nextTok.text).length);
        if (
          lineWords.length > 0 &&
          consumedChars + nextLen > targetChars &&
          Math.abs(targetChars - consumedChars) <= Math.abs(consumedChars + nextLen - targetChars)
        ) {
          break;
        }
        lineWords.push(nextTok);
        consumedChars += nextLen;
        tokenCursor++;
      }
    }

    const hasMoreSungLines = parsedLines.slice(i + 1).some((l) => !l.isTag && l.expectedWords.length > 0);
    if (!hasMoreSungLines && tokenCursor < validTokens.length) {
      while (tokenCursor < validTokens.length) {
        lineWords.push(validTokens[tokenCursor++]);
      }
    }

    const phraseChunks = splitWordsIntoAlignedPhrases(lineWords);
    if (phraseChunks.length === 1) {
      const chunk = phraseChunks[0];
      lines.push({
        index: lines.length,
        text: item.text,
        isTag: false,
        start: chunk.length > 0 ? chunk[0].start : null,
        end: chunk.length > 0 ? chunk[chunk.length - 1].end : null,
        words: chunk,
      });
    } else {
      for (const chunk of phraseChunks) {
        lines.push({
          index: lines.length,
          text: chunk.map((cw) => cw.text).join(' '),
          isTag: false,
          start: chunk.length > 0 ? chunk[0].start : null,
          end: chunk.length > 0 ? chunk[chunk.length - 1].end : null,
          words: chunk,
        });
      }
    }
  }

  // Attach timestamps to structural [Section] tags based on adjacent sung lines
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].isTag) continue;
    const prevSung = lines.slice(0, i).reverse().find((l) => !l.isTag && l.end !== null);
    const nextSung = lines.slice(i + 1).find((l) => !l.isTag && l.start !== null);
    if (!prevSung && nextSung && nextSung.start !== null && /^\[intro/i.test(lines[i].text)) {
      // Intro tag before the first sung word spans [0, nextSung.start]
      lines[i].start = 0;
      lines[i].end = nextSung.start;
    } else if (nextSung && nextSung.start !== null) {
      lines[i].start = nextSung.start;
      lines[i].end = nextSung.end ?? nextSung.start;
    } else if (prevSung && prevSung.end !== null) {
      lines[i].start = prevSung.end;
      lines[i].end = prevSung.end;
    }
  }

  return {
    source: 'forced_alignment',
    updatedAt: new Date().toISOString(),
    lines,
    words: lines.flatMap((l) => l.words),
  };
}

function buildUpdatedProvenance(
  existing: TakeProvenance | null | undefined,
  songId: string,
  sourceUrl: string,
  lyrics: string,
  vocalLanguage: string,
  alignment: LyricsAlignment | null,
  alignedAttempted = false
): TakeProvenance {
  const base: TakeProvenance = existing ?? {
    taskId: `scribe-${songId}`,
    sourceUrl,
    sourceTakeId: null,
    sourceDuration: null,
    target: 'stem',
    targetStemId: null,
    region: null,
    outputDuration: null,
    parameters: {},
  };
  const existingParams = (base.parameters ?? {}) as Record<string, any>;
  return {
    ...base,
    parameters: {
      ...existingParams,
      scribeTranscribed: true,
      scribeModel: 'scribe_v2',
      scribeLanguage: vocalLanguage,
      vocalLanguage: vocalLanguage || existingParams.vocalLanguage,
      ...(lyrics ? { transcribedLyrics: lyrics } : {}),
      ...(alignment ? { lyricsAlignment: alignment, lyricsAlignedAttempted: true } : existingParams.lyricsAlignment ? { lyricsAlignment: existingParams.lyricsAlignment } : {}),
      ...(alignedAttempted ? { lyricsAlignedAttempted: true } : {}),
    },
  };
}

export interface TranscribeVocalOptions {
  force?: boolean;
  languageCode?: string;
}

/**
 * Downsamples standard 16-bit PCM WAV buffers (e.g. 48kHz stereo) to 16kHz mono 16-bit PCM WAV
 * in memory before uploading to ElevenLabs. Shrinks 37 MB vocal stems to ~6 MB (6x faster upload)
 * while preserving exact sample-accurate duration and timestamps.
 */
export function prepareVocalStemWavForElevenLabs(buffer: Buffer): Buffer {
  try {
    if (buffer.length < 44) return buffer;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      return buffer;
    }
    let offset = 12;
    let audioFormat = 0;
    let numChannels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let dataOffset = -1;
    let dataSize = 0;

    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const payloadOffset = offset + 8;
      if (chunkId === 'fmt ' && chunkSize >= 16 && payloadOffset + 16 <= buffer.length) {
        audioFormat = buffer.readUInt16LE(payloadOffset);
        numChannels = buffer.readUInt16LE(payloadOffset + 2);
        sampleRate = buffer.readUInt32LE(payloadOffset + 4);
        bitsPerSample = buffer.readUInt16LE(payloadOffset + 14);
      } else if (chunkId === 'data') {
        dataOffset = payloadOffset;
        dataSize = Math.min(chunkSize, buffer.length - payloadOffset);
        break;
      }
      offset = payloadOffset + chunkSize + (chunkSize % 2);
    }

    if (
      audioFormat !== 1 ||
      bitsPerSample !== 16 ||
      numChannels < 1 ||
      sampleRate <= 0 ||
      dataOffset < 0 ||
      dataSize <= 0
    ) {
      return buffer;
    }

    const targetRate = 16000;
    if (sampleRate <= targetRate && numChannels === 1) {
      return buffer;
    }

    const outRate = Math.min(sampleRate, targetRate);
    const bytesPerFrame = numChannels * 2;
    const totalFrames = Math.floor(dataSize / bytesPerFrame);
    if (totalFrames <= 0) return buffer;

    const outFrames = Math.floor((totalFrames * outRate) / sampleRate);
    const outDataSize = outFrames * 2;
    const outBuffer = Buffer.allocUnsafe(44 + outDataSize);

    outBuffer.write('RIFF', 0, 'ascii');
    outBuffer.writeUInt32LE(36 + outDataSize, 4);
    outBuffer.write('WAVE', 8, 'ascii');
    outBuffer.write('fmt ', 12, 'ascii');
    outBuffer.writeUInt32LE(16, 16);
    outBuffer.writeUInt16LE(1, 20);
    outBuffer.writeUInt16LE(1, 22);
    outBuffer.writeUInt32LE(outRate, 24);
    outBuffer.writeUInt32LE(outRate * 2, 28);
    outBuffer.writeUInt16LE(2, 32);
    outBuffer.writeUInt16LE(16, 34);
    outBuffer.write('data', 36, 'ascii');
    outBuffer.writeUInt32LE(outDataSize, 40);

    for (let i = 0; i < outFrames; i++) {
      const startFrame = Math.floor((i * sampleRate) / outRate);
      const endFrame = Math.min(totalFrames, Math.max(startFrame + 1, Math.floor(((i + 1) * sampleRate) / outRate)));
      let sum = 0;
      let count = 0;
      for (let f = startFrame; f < endFrame; f++) {
        const framePos = dataOffset + f * bytesPerFrame;
        for (let ch = 0; ch < numChannels; ch++) {
          sum += buffer.readInt16LE(framePos + ch * 2);
          count++;
        }
      }
      const sample = count > 0 ? Math.max(-32768, Math.min(32767, Math.round(sum / count))) : 0;
      outBuffer.writeInt16LE(sample, 44 + i * 2);
    }

    return outBuffer;
  } catch {
    return buffer;
  }
}

/**
 * Asynchronously transcribes ONLY the isolated vocals stem for a song at most ONCE
 * (unless force=true) using ElevenLabs Scribe v2 (scribe_v2) with word-level timestamps
 * and caches both lyrics and LyricsAlignment on the song's takes in DB.
 */
export async function transcribeVocalStemOnce(
  songId: string,
  explicitVocalsStemUrl?: string,
  options?: TranscribeVocalOptions
): Promise<{ lyrics: string; vocalLanguage: string; alignment: LyricsAlignment | null } | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;

  const lockKey = `rawchunks:scribe:lock:${songId}`;
  if (!options?.force && inFlightSongs.has(songId)) return null;

  const takes = await listTakesBySong(songId);
  const existing = extractStoredLyricsAndLang(takes, options?.languageCode);
  const targetLang = normalizeLanguageCode(options?.languageCode || existing.vocalLanguage || 'en');

  if (!options?.force && (existing.alreadyTranscribed || existing.lyrics)) {
    if (existing.lyrics && !existing.alignment && !existing.alreadyAligned) {
      if (existing.fromScribe) {
        return transcribeVocalStemOnce(songId, explicitVocalsStemUrl, {
          ...options,
          force: true,
          languageCode: targetLang,
        });
      }
      return alignVocalStemLyrics(songId, existing.lyrics, explicitVocalsStemUrl, options);
    }
    return {
      lyrics: existing.lyrics,
      vocalLanguage: existing.vocalLanguage,
      alignment: existing.alignment,
    };
  }

  // Strictly require an isolated vocals stem — NEVER pass the full mixed song to Scribe.
  const stems = await listStemsBySong(songId);
  const vocalsStem = stems.find((s) => s.name.toLowerCase() === 'vocals');
  const vocalsUrl = explicitVocalsStemUrl || vocalsStem?.url;
  if (!vocalsUrl) {
    return null;
  }

  if (!options?.force) {
    const lockAcquired = await valkey.set(lockKey, '1', 'EX', 180, 'NX').catch(() => 'OK');
    if (lockAcquired !== 'OK') return null;
  }

  inFlightSongs.add(songId);
  try {
    const audio = await readAudio(vocalsUrl);
    const uploadBuffer = prepareVocalStemWavForElevenLabs(audio.buffer);
    const formData = new FormData();
    formData.append('model_id', 'scribe_v2');
    formData.append('timestamps_granularity', 'word');
    if (options?.languageCode) {
      formData.append('language_code', targetLang);
    }
    formData.append(
      'file',
      new Blob([new Uint8Array(uploadBuffer)], { type: audio.contentType || 'audio/wav' }),
      'vocals.wav'
    );
    formData.append('tag_audio_events', 'false');

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.warn(`[Scribe] ElevenLabs Scribe v2 returned ${response.status} for song ${songId}: ${errBody}`);
      return null;
    }

    const payload = (await response.json()) as {
      text?: string;
      language_code?: string;
      words?: ScribeWord[];
    };

    const vocalLanguage = normalizeLanguageCode(options?.languageCode || payload.language_code || targetLang);
    const { lyrics: formattedLyrics, alignment } = buildScribeLyricsAndAlignment(payload.text, payload.words);

    const currentTakes = await listTakesBySong(songId);
    const targets = currentTakes.filter(
      (t) =>
        t.task === 'text2music' ||
        t.is_active ||
        (vocalsStem && t.stem_id === vocalsStem.id)
    );
    const takesToUpdate = targets.length > 0 ? targets : currentTakes.slice(0, 1);

    await Promise.all(
      takesToUpdate.map((take) => {
        const nextLyrics = options?.force
          ? (formattedLyrics || take.lyrics || null)
          : isMeaningfulLyrics(take.lyrics)
            ? take.lyrics!
            : (formattedLyrics || take.lyrics || null);
        const nextProv = buildUpdatedProvenance(
          take.provenance,
          songId,
          vocalsUrl,
          formattedLyrics,
          vocalLanguage,
          alignment,
          true
        );
        return updateTakeLyrics(take.id, songId, nextLyrics, nextProv);
      })
    );

    return { lyrics: formattedLyrics, vocalLanguage, alignment };
  } catch (err: any) {
    console.warn(`[Scribe] Vocal stem transcription error for song ${songId}:`, err?.message || err);
    return null;
  } finally {
    inFlightSongs.delete(songId);
    await valkey.del(lockKey).catch(() => {});
  }
}

/**
 * Aligns known/edited lyrics against the isolated vocals stem using ElevenLabs
 * Forced Alignment API (`POST /v1/forced-alignment`), preserving [Section] tags.
 */
export async function alignVocalStemLyrics(
  songId: string,
  lyricsText?: string,
  explicitVocalsStemUrl?: string,
  options?: TranscribeVocalOptions
): Promise<{ lyrics: string; vocalLanguage: string; alignment: LyricsAlignment | null } | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;

  const lockKey = `rawchunks:scribe:align:lock:${songId}`;
  if (!options?.force && inFlightAlignSongs.has(songId)) return null;

  const [takes, stems] = await Promise.all([listTakesBySong(songId), listStemsBySong(songId)]);
  const existing = extractStoredLyricsAndLang(takes, options?.languageCode);
  const targetLang = normalizeLanguageCode(options?.languageCode || existing.vocalLanguage || 'en');
  const rawLyrics = (isMeaningfulLyrics(lyricsText) ? lyricsText!.trim() : existing.lyrics).trim();

  if (!isMeaningfulLyrics(rawLyrics)) {
    return transcribeVocalStemOnce(songId, explicitVocalsStemUrl, options);
  }

  if (!options?.force && existing.alignment && existing.lyrics === rawLyrics) {
    return {
      lyrics: rawLyrics,
      vocalLanguage: targetLang,
      alignment: existing.alignment,
    };
  }

  // Strictly require an isolated vocals stem — NEVER pass the full mixed song.
  const vocalsStem = stems.find((s) => s.name.toLowerCase() === 'vocals');
  const vocalsUrl = explicitVocalsStemUrl || vocalsStem?.url;
  if (!vocalsUrl) {
    return null;
  }

  // Strip structural [Section] tags before sending text to /v1/forced-alignment
  const sungLines = rawLyrics
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\s*\[[^\]]+\]\s*$/.test(l))
    .map((l) => l.replace(/\[[^\]]+\]/g, ' ').trim())
    .filter(Boolean);

  const cleanSungText = sungLines.join('\n').trim();
  if (!cleanSungText) {
    return { lyrics: rawLyrics, vocalLanguage: targetLang, alignment: null };
  }

  if (!options?.force) {
    const lockAcquired = await valkey.set(lockKey, '1', 'EX', 180, 'NX').catch(() => 'OK');
    if (lockAcquired !== 'OK') return null;
  }

  inFlightAlignSongs.add(songId);
  try {
    const audio = await readAudio(vocalsUrl);
    const uploadBuffer = prepareVocalStemWavForElevenLabs(audio.buffer);
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([new Uint8Array(uploadBuffer)], { type: audio.contentType || 'audio/wav' }),
      'vocals.wav'
    );
    formData.append('text', cleanSungText);

    const response = await fetch('https://api.elevenlabs.io/v1/forced-alignment', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.warn(`[Scribe] ElevenLabs Forced Alignment returned ${response.status} for song ${songId}: ${errBody}`);
      return null;
    }

    const payload = (await response.json()) as {
      words?: ScribeWord[];
      loss?: number;
    };

    const alignment = buildForcedAlignmentLines(rawLyrics, payload.words);
    const alignedLyricsText =
      alignment && alignment.lines.length > 0
        ? alignment.lines.map((l) => l.text).join('\n').trim()
        : rawLyrics;

    const currentTakes = await listTakesBySong(songId);
    const targets = currentTakes.filter(
      (t) =>
        t.task === 'text2music' ||
        t.is_active ||
        (vocalsStem && t.stem_id === vocalsStem.id)
    );
    const takesToUpdate = targets.length > 0 ? targets : currentTakes.slice(0, 1);

    await Promise.all(
      takesToUpdate.map((take) => {
        const nextLyrics = alignedLyricsText || take.lyrics || null;
        const nextProv = buildUpdatedProvenance(
          take.provenance,
          songId,
          vocalsUrl,
          alignedLyricsText,
          targetLang,
          alignment,
          true
        );
        return updateTakeLyrics(take.id, songId, nextLyrics, nextProv);
      })
    );

    return { lyrics: alignedLyricsText, vocalLanguage: targetLang, alignment };
  } catch (err: any) {
    console.warn(`[Scribe] Vocal stem forced alignment error for song ${songId}:`, err?.message || err);
    return null;
  } finally {
    inFlightAlignSongs.delete(songId);
    await valkey.del(lockKey).catch(() => {});
  }
}

export async function getSongLyricsStatus(
  songId: string,
  preferredLanguage?: string
): Promise<{
  lyrics: string;
  vocalLanguage: string;
  alignment: LyricsAlignment | null;
  status: 'cached' | 'transcribing' | 'aligning' | 'none';
}> {
  const takes = await listTakesBySong(songId);
  const existing = extractStoredLyricsAndLang(takes, preferredLanguage);
  const targetLang = normalizeLanguageCode(preferredLanguage || existing.vocalLanguage || 'en');

  const lockKey = `rawchunks:scribe:lock:${songId}`;
  const isLocked = inFlightSongs.has(songId) || (await valkey.get(lockKey).catch(() => null)) === '1';
  if (isLocked) {
    return {
      lyrics: existing.lyrics || '',
      vocalLanguage: existing.vocalLanguage || targetLang,
      alignment: existing.alignment,
      status: existing.lyrics ? 'aligning' : 'transcribing',
    };
  }

  const alignLockKey = `rawchunks:scribe:align:lock:${songId}`;
  const isAlignLocked =
    inFlightAlignSongs.has(songId) || (await valkey.get(alignLockKey).catch(() => null)) === '1';
  if (isAlignLocked) {
    return {
      lyrics: existing.lyrics || '',
      vocalLanguage: existing.vocalLanguage || targetLang,
      alignment: existing.alignment,
      status: 'aligning',
    };
  }

  if (existing.lyrics || existing.alreadyTranscribed) {
    return {
      lyrics: existing.lyrics,
      vocalLanguage: existing.vocalLanguage || targetLang,
      alignment: existing.alignment,
      status: 'cached',
    };
  }

  return {
    lyrics: '',
    vocalLanguage: targetLang,
    alignment: null,
    status: 'none',
  };
}

