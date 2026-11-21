import {
  dequeueScribe,
  enqueueScribe,
  finishScribe,
  isScribePending,
  valkey,
  withJobLock,
} from '../broker/valkey.js';
import { cacheGet, cacheSet } from '../databases/cache.js';
import { getSongById, listSongsNeedingLyrics } from '../databases/songs.js';
import { listStemsBySong } from '../databases/stems.js';
import { listTakesBySong, updateTakeLyrics } from '../databases/takes.js';
import type { Stem } from '../databases/schema/stems.js';
import type {
  AlignedLine,
  AlignedWord,
  LyricsAlignment,
  Take,
  TakeProvenance,
} from '../databases/schema/takes.js';
import { readAudio } from '../storage/r2.js';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
const SCRIBE_MODEL = 'scribe_v3';
const MAX_KEYTERMS = 1000;
const MAX_KEYTERM_WORDS = 5;
const MAX_KEYTERM_CHARS = 50;
const FORBIDDEN_KEYTERM_CHARS = new Set(['<', '>', '{', '}', '[', ']', '\\']);
const TERMINAL_PUNCTUATION = new Set(['.', '!', '?', '…', '。', '！', '？']);
const PUBLIC_CACHE_TTL_SEC = 3600;
const WORKER_CONCURRENCY = 2;
const IDLE_POLL_MS = 1500;
const BACKFILL_PACE_MS = 400;
const SEED_INTERVAL_MS = 5 * 60_000;

export interface ParsedLine {
  raw: string;
  sung: string;
  tags: string[];
  isTagOnly: boolean;
}

export interface ParsedLyrics {
  entries: ParsedLine[];
  sungLines: string[];
  plainText: string;
  keyterms: string[];
}

export interface AlignmentChar {
  text?: string;
  start?: number;
  end?: number;
}

export interface AlignmentToken {
  text?: string;
  start?: number;
  end?: number;
  type?: string;
  loss?: number;
}

export interface ScribePayload {
  text?: string;
  language_code?: string;
  words?: AlignmentToken[];
  additional_formats?: Array<{
    requested_format?: string;
    content?: string;
    is_base64_encoded?: boolean;
  }>;
}

export type LyricsRecordStatus = 'ready' | 'instrumental' | 'empty';

interface CachedPublicLyrics {
  alignment: LyricsAlignment | null;
  status: 'cached' | 'none';
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function collapseSpaces(raw: string): string {
  let out = '';
  let prevSpace = true;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (isWhitespace(ch)) {
      if (!prevSpace) {
        out += ' ';
        prevSpace = true;
      }
    } else {
      out += ch;
      prevSpace = false;
    }
  }
  return out.endsWith(' ') ? out.slice(0, -1) : out;
}

function splitWords(raw: string): string[] {
  const words: string[] = [];
  let current = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (isWhitespace(ch)) {
      if (current.length > 0) {
        words.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

function sanitizeKeytermSource(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    out += FORBIDDEN_KEYTERM_CHARS.has(ch) ? ' ' : ch;
  }
  return collapseSpaces(out);
}

/**
 * Pure character-scanner parser for songwriter lyrics (zero regex):
 * separates `[bracketed]` musical/effect tags from sung text and builds
 * schema-compliant ElevenLabs `keyterms` (<= 5 words, <= 50 chars, <= 1,000 terms).
 */
export function parseLyrics(raw: string): ParsedLyrics {
  if (!raw || typeof raw !== 'string') {
    return { entries: [], sungLines: [], plainText: '', keyterms: [] };
  }

  const entries: ParsedLine[] = [];
  const rawLines = raw.split('\n');

  for (const rawLine of rawLines) {
    const trimmed = collapseSpaces(rawLine);
    if (!trimmed) continue;

    let depth = 0;
    let tagBuf = '';
    let sungBuf = '';
    const tags: string[] = [];

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '[') {
        if (depth === 0 && sungBuf.length > 0 && !sungBuf.endsWith(' ')) {
          sungBuf += ' ';
        }
        depth += 1;
        continue;
      }
      if (ch === ']') {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0) {
            const cleanTag = collapseSpaces(tagBuf);
            if (cleanTag) tags.push(cleanTag);
            tagBuf = '';
          }
        }
        continue;
      }
      if (depth > 0) {
        tagBuf += ch;
      } else {
        sungBuf += ch;
      }
    }

    const sung = collapseSpaces(sungBuf);
    const isTagOnly = sung.length === 0 && tags.length > 0;
    if (!sung && tags.length === 0) continue;

    entries.push({
      raw: trimmed,
      sung,
      tags,
      isTagOnly,
    });
  }

  const sungLines = entries.filter((e) => !e.isTagOnly && e.sung.length > 0).map((e) => e.sung);
  const plainText = sungLines.join('\n');
  const keyterms = extractKeyterms(sungLines);

  return { entries, sungLines, plainText, keyterms };
}

export function extractKeyterms(sungLines: readonly string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const line of sungLines) {
    if (terms.length >= MAX_KEYTERMS) break;
    const words = splitWords(sanitizeKeytermSource(line));
    let cursor = 0;
    while (cursor < words.length && terms.length < MAX_KEYTERMS) {
      let end = Math.min(words.length, cursor + MAX_KEYTERM_WORDS);
      while (end > cursor + 1 && words.slice(cursor, end).join(' ').length > MAX_KEYTERM_CHARS) {
        end -= 1;
      }
      const phrase = words.slice(cursor, end).join(' ');
      cursor = end;
      if (!phrase || phrase.length > MAX_KEYTERM_CHARS) continue;
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(phrase);
    }
  }

  return terms;
}

export function stripBracketedText(raw: string): string {
  return parseLyrics(raw).sungLines.join(' ');
}

export function extractBracketTags(raw: string): string[] {
  return parseLyrics(raw).entries.flatMap((entry) => entry.tags);
}

function cleanLanguageCode(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'unknown' || trimmed === 'auto') return undefined;
  const sep = trimmed.indexOf('-') >= 0 ? trimmed.indexOf('-') : trimmed.indexOf('_');
  const code = sep > 0 ? trimmed.slice(0, sep) : trimmed;
  return code.length === 2 || code.length === 3 ? code : undefined;
}

function isInstrumentalText(raw?: string | null): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const lower = collapseSpaces(raw).toLowerCase();
  return lower === '[instrumental]' || lower === 'instrumental';
}

function isValidAlignment(candidate: unknown): candidate is LyricsAlignment {
  if (!candidate || typeof candidate !== 'object') return false;
  const obj = candidate as LyricsAlignment;
  return (
    Array.isArray(obj.lines) &&
    obj.lines.length > 0 &&
    Array.isArray(obj.words) &&
    obj.lines.some((l) => typeof l?.start === 'number' && Number.isFinite(l.start))
  );
}

function round3(n: number): number {
  return Number(n.toFixed(3));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * Pure structured filter for public song listeners: omits all `[bracketed]` tag lines
 * and guarantees only clean sung words with timestamps reach the public stage.
 */
export function toPublicAlignment(alignment: LyricsAlignment | null | undefined): LyricsAlignment | null {
  if (!isValidAlignment(alignment)) return null;
  const cleanLines: AlignedLine[] = [];

  for (const line of alignment.lines) {
    if (!line || line.isTag) continue;
    const rawWords = Array.isArray(line.words) ? line.words : [];
    const words: AlignedWord[] = [];
    for (const w of rawWords) {
      if (!w || typeof w.text !== 'string') continue;
      const cleaned = stripBracketedText(w.text);
      if (!cleaned) continue;
      words.push({ ...w, text: cleaned });
    }
    const text = words.length > 0 ? words.map((w) => w.text).join(' ') : stripBracketedText(line.text || '');
    if (!text) continue;
    cleanLines.push({
      index: cleanLines.length,
      text,
      isTag: false,
      start: words.length > 0 ? words[0].start : line.start,
      end: words.length > 0 ? words[words.length - 1].end : line.end,
      words,
    });
  }

  if (cleanLines.length === 0) return null;
  return {
    source: alignment.source,
    updatedAt: alignment.updatedAt,
    lines: cleanLines,
    words: cleanLines.flatMap((l) => l.words),
  };
}

function attachTagTimestamps(lines: AlignedLine[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].isTag) continue;
    let nextSung: AlignedLine | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].isTag && lines[j].start !== null) {
        nextSung = lines[j];
        break;
      }
    }
    let prevSung: AlignedLine | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (!lines[j].isTag && lines[j].end !== null) {
        prevSung = lines[j];
        break;
      }
    }
    if (nextSung && nextSung.start !== null) {
      lines[i].start = nextSung.start;
      lines[i].end = nextSung.end ?? nextSung.start;
    } else if (prevSung && prevSung.end !== null) {
      lines[i].start = prevSung.end;
      lines[i].end = prevSung.end;
    }
  }
}

/**
 * Deterministically maps ElevenLabs Forced Alignment (`POST /v1/forced-alignment`, Cue)
 * character/word timestamps directly back onto the songwriter's exact lines and `[Section]` tags.
 * Splits `characters[]` directly on `'\n'` — zero heuristics, zero regex.
 */
export function buildAlignedLyrics(
  parsed: ParsedLyrics,
  characters?: readonly AlignmentChar[],
  words?: readonly AlignmentToken[]
): LyricsAlignment | null {
  if (parsed.sungLines.length === 0) return null;

  const cleanWordTokens: AlignedWord[] = [];
  if (Array.isArray(words)) {
    for (const tok of words) {
      if (!tok || typeof tok.text !== 'string') continue;
      const text = collapseSpaces(tok.text);
      if (!text) continue;
      if (typeof tok.start !== 'number' || !Number.isFinite(tok.start)) continue;
      const start = round3(tok.start);
      const end =
        typeof tok.end === 'number' && Number.isFinite(tok.end) && tok.end >= start
          ? round3(tok.end)
          : start;
      cleanWordTokens.push({
        text,
        start,
        end,
        ...(typeof tok.loss === 'number' && Number.isFinite(tok.loss) ? { loss: round4(tok.loss) } : {}),
      });
    }
  }

  let sungLineWordGroups: AlignedWord[][] = [];

  if (Array.isArray(characters) && characters.length > 0) {
    // Primary exact path: split Cue's character array directly on '\n' tokens
    const charLineBuckets: AlignmentChar[][] = [[]];
    for (const ch of characters) {
      if (!ch || typeof ch.text !== 'string') continue;
      if (ch.text === '\n') {
        charLineBuckets.push([]);
      } else {
        charLineBuckets[charLineBuckets.length - 1].push(ch);
      }
    }

    let wordCursor = 0;
    sungLineWordGroups = charLineBuckets.map((lineChars) => {
      const lineWords: AlignedWord[] = [];
      let bufText = '';
      let wordStart: number | null = null;
      let wordEnd: number | null = null;

      const flush = () => {
        if (!bufText) return;
        const matched = cleanWordTokens[wordCursor];
        wordCursor += 1;
        const start = wordStart ?? matched?.start ?? 0;
        const end = wordEnd !== null && wordEnd >= start ? wordEnd : matched?.end ?? start;
        lineWords.push({
          text: bufText,
          start: round3(start),
          end: round3(end),
          ...(matched?.loss !== undefined ? { loss: matched.loss } : {}),
        });
        bufText = '';
        wordStart = null;
        wordEnd = null;
      };

      for (const ch of lineChars) {
        const t = ch.text ?? '';
        if (t.length === 1 && isWhitespace(t)) {
          flush();
          continue;
        }
        bufText += t;
        if (typeof ch.start === 'number' && Number.isFinite(ch.start) && wordStart === null) {
          wordStart = ch.start;
        }
        if (typeof ch.end === 'number' && Number.isFinite(ch.end)) {
          wordEnd = ch.end;
        }
      }
      flush();
      return lineWords;
    });
  } else if (cleanWordTokens.length > 0) {
    // Secondary deterministic path when words[] is provided without characters[]
    let cursor = 0;
    for (let i = 0; i < parsed.sungLines.length; i++) {
      const expected = splitWords(parsed.sungLines[i]).length;
      const isLast = i === parsed.sungLines.length - 1;
      const slice = isLast
        ? cleanWordTokens.slice(cursor)
        : cleanWordTokens.slice(cursor, cursor + expected);
      cursor += slice.length;
      sungLineWordGroups.push(slice);
    }
  } else {
    return null;
  }

  const lines: AlignedLine[] = [];
  let sungIdx = 0;
  for (const entry of parsed.entries) {
    if (entry.isTagOnly) {
      lines.push({
        index: lines.length,
        text: entry.raw,
        isTag: true,
        start: null,
        end: null,
        words: [],
      });
      continue;
    }

    const lineWords = sungLineWordGroups[sungIdx] ?? [];
    sungIdx += 1;
    lines.push({
      index: lines.length,
      text: entry.sung,
      isTag: false,
      start: lineWords.length > 0 ? lineWords[0].start : null,
      end: lineWords.length > 0 ? lineWords[lineWords.length - 1].end : null,
      words: lineWords,
    });
  }

  attachTagTimestamps(lines);

  const allWords = lines.flatMap((l) => l.words);
  if (allWords.length === 0) return null;

  return {
    source: 'aligned',
    updatedAt: new Date().toISOString(),
    lines,
    words: allWords,
  };
}

interface SegmentedFormatSegment {
  text?: string;
  start?: number;
  end?: number;
  start_time?: number;
  end_time?: number;
  words?: AlignmentToken[];
}

function parseSegmentedJson(payload: ScribePayload): SegmentedFormatSegment[] | null {
  const formats = payload.additional_formats;
  if (!Array.isArray(formats)) return null;
  const entry = formats.find((f) => f?.requested_format === 'segmented_json' && typeof f.content === 'string');
  if (!entry?.content) return null;
  try {
    const raw = entry.is_base64_encoded
      ? Buffer.from(entry.content, 'base64').toString('utf8')
      : entry.content;
    const parsed = JSON.parse(raw) as { segments?: SegmentedFormatSegment[] } | SegmentedFormatSegment[];
    const segments = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.segments) ? parsed.segments : null;
    return segments && segments.length > 0 ? segments : null;
  } catch {
    return null;
  }
}

function normalizeScribeWords(tokens?: readonly AlignmentToken[]): AlignedWord[] {
  if (!Array.isArray(tokens)) return [];
  const words: AlignedWord[] = [];
  let lastEnd = 0;

  for (const tok of tokens) {
    if (!tok || typeof tok.text !== 'string') continue;
    if (tok.type === 'audio_event' || tok.type === 'spacing') continue;
    const text = collapseSpaces(tok.text);
    if (!text) continue;
    const start = typeof tok.start === 'number' && Number.isFinite(tok.start) ? round3(tok.start) : lastEnd;
    const end =
      typeof tok.end === 'number' && Number.isFinite(tok.end) && tok.end >= start
        ? round3(tok.end)
        : start;
    words.push({
      text,
      start,
      end,
      ...(typeof tok.loss === 'number' && Number.isFinite(tok.loss) ? { loss: round4(tok.loss) } : {}),
    });
    lastEnd = end;
  }

  return words;
}

/**
 * Builds structured timed lines directly from ElevenLabs Scribe (`POST /v1/speech-to-text`)
 * using `segmented_json` when returned by ElevenLabs, or explicit token boundaries otherwise.
 */
export function buildScribeLyrics(payload: ScribePayload): { lyrics: string; alignment: LyricsAlignment | null } {
  const allWords = normalizeScribeWords(payload.words);
  const segments = parseSegmentedJson(payload);

  if (segments) {
    const lines: AlignedLine[] = [];
    let wordCursor = 0;

    for (const seg of segments) {
      const segWords = Array.isArray(seg.words) ? normalizeScribeWords(seg.words) : [];
      let lineWords = segWords;

      if (lineWords.length === 0 && allWords.length > 0) {
        const segEnd =
          typeof seg.end === 'number'
            ? seg.end
            : typeof seg.end_time === 'number'
              ? seg.end_time
              : null;
        if (segEnd !== null) {
          const matched: AlignedWord[] = [];
          while (wordCursor < allWords.length && allWords[wordCursor].start <= segEnd + 0.05) {
            matched.push(allWords[wordCursor++]);
          }
          lineWords = matched;
        }
      }

      const text =
        lineWords.length > 0
          ? lineWords.map((w) => w.text).join(' ')
          : collapseSpaces(seg.text || '');
      if (!text) continue;

      const start =
        lineWords.length > 0
          ? lineWords[0].start
          : typeof seg.start === 'number'
            ? round3(seg.start)
            : typeof seg.start_time === 'number'
              ? round3(seg.start_time)
              : null;
      const end =
        lineWords.length > 0
          ? lineWords[lineWords.length - 1].end
          : typeof seg.end === 'number'
            ? round3(seg.end)
            : typeof seg.end_time === 'number'
              ? round3(seg.end_time)
              : start;

      lines.push({
        index: lines.length,
        text,
        isTag: false,
        start,
        end,
        words: lineWords,
      });
    }

    if (lines.length > 0) {
      const alignment: LyricsAlignment = {
        source: 'scribe',
        updatedAt: new Date().toISOString(),
        lines,
        words: lines.flatMap((l) => l.words),
      };
      return { lyrics: lines.map((l) => l.text).join('\n'), alignment };
    }
  }

  // Direct word-stream line grouping strictly from explicit newline spacing tokens or terminal punctuation
  if (Array.isArray(payload.words) && payload.words.length > 0) {
    const lines: AlignedLine[] = [];
    let currentWords: AlignedWord[] = [];
    let lastEnd = 0;

    const flushLine = () => {
      if (currentWords.length === 0) return;
      lines.push({
        index: lines.length,
        text: currentWords.map((w) => w.text).join(' '),
        isTag: false,
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end,
        words: currentWords,
      });
      currentWords = [];
    };

    for (const tok of payload.words) {
      if (!tok || typeof tok.text !== 'string') continue;
      if (tok.type === 'audio_event') continue;
      if (tok.type === 'spacing') {
        if (tok.text.includes('\n')) flushLine();
        continue;
      }
      const text = collapseSpaces(tok.text);
      if (!text) continue;
      const start = typeof tok.start === 'number' && Number.isFinite(tok.start) ? round3(tok.start) : lastEnd;
      const end =
        typeof tok.end === 'number' && Number.isFinite(tok.end) && tok.end >= start
          ? round3(tok.end)
          : start;
      currentWords.push({
        text,
        start,
        end,
        ...(typeof tok.loss === 'number' && Number.isFinite(tok.loss) ? { loss: round4(tok.loss) } : {}),
      });
      lastEnd = end;
      if (TERMINAL_PUNCTUATION.has(text[text.length - 1])) {
        flushLine();
      }
    }
    flushLine();

    if (lines.length > 0) {
      const alignment: LyricsAlignment = {
        source: 'scribe',
        updatedAt: new Date().toISOString(),
        lines,
        words: lines.flatMap((l) => l.words),
      };
      return { lyrics: lines.map((l) => l.text).join('\n'), alignment };
    }
  }

  const fallbackText = typeof payload.text === 'string' ? payload.text.trim() : '';
  return { lyrics: fallbackText, alignment: null };
}

/**
 * Downsamples standard 16-bit PCM WAV buffers (e.g. 48kHz stereo) to 16kHz mono 16-bit PCM WAV
 * in memory before uploading to ElevenLabs, shrinking upload payloads ~6x while preserving exact duration.
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
    if (sampleRate <= targetRate && numChannels === 1) return buffer;

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

function prioritizeTakes(takes: Take[]): Take[] {
  const seen = new Set<string>();
  const ordered: Take[] = [];
  for (const group of [
    takes.filter((t) => t.is_active),
    takes.filter((t) => t.task === 'text2music'),
    takes.filter((t) => t.task === 'extract'),
    takes,
  ]) {
    for (const t of group) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        ordered.push(t);
      }
    }
  }
  return ordered;
}

export function readStoredAlignment(takes: readonly Take[]): LyricsAlignment | null {
  for (const take of prioritizeTakes([...takes])) {
    const candidate = (take.provenance?.parameters as Record<string, any> | undefined)?.lyricsAlignment;
    if (isValidAlignment(candidate)) return candidate;
  }
  return null;
}

interface StoredLyricsState {
  referenceLyrics: string;
  vocalLanguage?: string;
  alignment: LyricsAlignment | null;
  alignmentSource: 'vocals' | 'master' | null;
  alignmentAudioUrl: string | null;
  recordStatus: LyricsRecordStatus | null;
  isInstrumental: boolean;
}

function readStoredState(takes: Take[], preferredLanguage?: string): StoredLyricsState {
  const ordered = prioritizeTakes(takes);
  let vocalLanguage = cleanLanguageCode(preferredLanguage);
  let referenceLyrics = '';
  let alignment: LyricsAlignment | null = null;
  let alignmentSource: 'vocals' | 'master' | null = null;
  let alignmentAudioUrl: string | null = null;
  let recordStatus: LyricsRecordStatus | null = null;
  let isInstrumental = false;

  for (const take of ordered) {
    const params = (take.provenance?.parameters ?? {}) as Record<string, any>;
    const submitted = (params.submitted ?? {}) as Record<string, any>;
    const resolved = (params.resolved ?? {}) as Record<string, any>;

    if (!vocalLanguage) {
      vocalLanguage = cleanLanguageCode(
        params.vocalLanguage ?? submitted.vocalLanguage ?? resolved.vocalLanguage ?? resolved.language
      );
    }

    if (
      submitted.instrumental === true ||
      resolved.instrumental === true ||
      isInstrumentalText(take.lyrics)
    ) {
      isInstrumental = true;
    }

    if (!referenceLyrics) {
      const candidate = take.lyrics ?? submitted.lyrics ?? resolved.lyrics ?? params.lyrics;
      if (typeof candidate === 'string' && candidate.trim() && !isInstrumentalText(candidate)) {
        referenceLyrics = candidate.trim();
      }
    }

    if (!recordStatus) {
      const st = params.lyricsStatus;
      if (st === 'ready' || st === 'instrumental' || st === 'empty') {
        recordStatus = st;
      }
    }

    if (!alignment && isValidAlignment(params.lyricsAlignment) && typeof params.lyricsAlignmentAudioUrl === 'string') {
      alignment = params.lyricsAlignment;
      alignmentSource =
        params.lyricsAlignmentSource === 'vocals' || params.lyricsAlignmentSource === 'master'
          ? params.lyricsAlignmentSource
          : 'master';
      alignmentAudioUrl = params.lyricsAlignmentAudioUrl;
    }
  }

  if (referenceLyrics) isInstrumental = false;

  return {
    referenceLyrics,
    vocalLanguage,
    alignment,
    alignmentSource,
    alignmentAudioUrl,
    recordStatus,
    isInstrumental,
  };
}

async function resolveAudioTarget(
  songId: string,
  stems: Stem[],
  takes: Take[],
  explicitUrl?: string
): Promise<{ url: string; source: 'vocals' | 'master'; vocalsStem?: Stem } | null> {
  const vocalsStem = stems.find((s) => s.name.toLowerCase() === 'vocals' && Boolean(s.url));
  if (vocalsStem?.url) {
    return { url: vocalsStem.url, source: 'vocals', vocalsStem };
  }
  if (explicitUrl) {
    return { url: explicitUrl, source: 'master' };
  }
  const masterStem =
    stems.find((s) => s.name.toLowerCase() === 'master' && Boolean(s.url)) ??
    stems.find((s) => Boolean(s.url));
  if (masterStem?.url) {
    return { url: masterStem.url, source: 'master' };
  }
  const ordered = prioritizeTakes(takes);
  const takeWithAudio = ordered.find((t) => Boolean(t.url));
  if (takeWithAudio?.url) {
    return { url: takeWithAudio.url, source: 'master' };
  }
  const song = await getSongById(songId).catch(() => null);
  return song?.url ? { url: song.url, source: 'master' } : null;
}

async function callForcedAlignment(
  apiKey: string,
  wavBuffer: Buffer,
  contentType: string,
  plainText: string
): Promise<{ characters?: AlignmentChar[]; words?: AlignmentToken[]; loss?: number } | null> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wavBuffer)], { type: contentType }), 'vocals.wav');
  form.append('text', plainText);

  const response = await fetch(`${ELEVENLABS_BASE}/v1/forced-alignment`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.warn(`[Scribe] ElevenLabs forced-alignment returned ${response.status}: ${errBody}`);
    return null;
  }

  return (await response.json()) as {
    characters?: AlignmentChar[];
    words?: AlignmentToken[];
    loss?: number;
  };
}

async function callScribe(
  apiKey: string,
  wavBuffer: Buffer,
  contentType: string,
  options: { languageCode?: string; keyterms?: readonly string[] }
): Promise<ScribePayload | null> {
  const form = new FormData();
  form.append('model_id', SCRIBE_MODEL);
  form.append('timestamps_granularity', 'word');
  form.append('diarize', 'true');
  form.append('tag_audio_events', 'false');
  form.append(
    'additional_formats',
    JSON.stringify([
      {
        format: 'segmented_json',
        include_speakers: false,
        include_timestamps: true,
        segment_on_silence_longer_than_s: 0.7,
        max_segment_chars: 72,
      },
    ])
  );
  if (options.languageCode) {
    form.append('language_code', options.languageCode);
  }
  if (options.keyterms && options.keyterms.length > 0) {
    for (const term of options.keyterms.slice(0, MAX_KEYTERMS)) {
      form.append('keyterms', term);
    }
  }
  form.append('file', new Blob([new Uint8Array(wavBuffer)], { type: contentType }), 'vocals.wav');

  const response = await fetch(`${ELEVENLABS_BASE}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.warn(`[Scribe] ElevenLabs speech-to-text returned ${response.status}: ${errBody}`);
    return null;
  }

  return (await response.json()) as ScribePayload;
}

function buildCanonicalProvenance(
  existing: TakeProvenance | null | undefined,
  songId: string,
  audioUrl: string,
  source: 'vocals' | 'master',
  status: LyricsRecordStatus,
  alignment: LyricsAlignment | null,
  vocalLanguage?: string
): TakeProvenance {
  const base: TakeProvenance = existing ?? {
    taskId: `scribe-${songId}`,
    sourceUrl: audioUrl,
    sourceTakeId: null,
    sourceDuration: null,
    target: 'stem',
    targetStemId: null,
    region: null,
    outputDuration: null,
    parameters: {},
  };
  return {
    ...base,
    parameters: {
      ...(base.parameters ?? {}),
      ...(vocalLanguage ? { vocalLanguage } : {}),
      lyricsStatus: status,
      lyricsAlignmentSource: source,
      lyricsAlignmentAudioUrl: audioUrl,
      ...(alignment ? { lyricsAlignment: alignment } : {}),
    },
  };
}

export interface ProcessOptions {
  force?: boolean;
  mode?: 'auto' | 'align' | 'extract';
  lyrics?: string;
  languageCode?: string;
  audioUrl?: string;
}

export interface LyricsResult {
  lyrics: string;
  vocalLanguage: string;
  alignment: LyricsAlignment | null;
  status: 'cached' | 'none';
}

function publicCacheKey(songId: string): string {
  return `lyrics:public:${songId}`;
}

type LyricsUpdatedListener = (songId: string) => Promise<void> | void;
const lyricsUpdatedListeners = new Set<LyricsUpdatedListener>();

export function onLyricsUpdated(listener: LyricsUpdatedListener): () => void {
  lyricsUpdatedListeners.add(listener);
  return () => {
    lyricsUpdatedListeners.delete(listener);
  };
}

async function notifyLyricsUpdated(songId: string): Promise<void> {
  if (lyricsUpdatedListeners.size === 0) return;
  await Promise.allSettled(
    Array.from(lyricsUpdatedListeners, (listener) => Promise.resolve(listener(songId)))
  );
}

/**
 * Single authoritative reference-guided lyrics transcription & alignment pipeline.
 * Runs under a Valkey distributed lease (`lock:scribe:${songId}`):
 * 1. Automatic & extract modes -> ElevenLabs `scribe_v3` (`POST /v1/speech-to-text`)
 *    transcribing the actual sung vocals, steered by `keyterms` from clean reference lyrics
 *    (`[bracketed]` directives omitted) + `segmented_json` phrase timestamps.
 * 2. Explicit Editor `align` mode -> ElevenLabs Cue Forced Alignment (`POST /v1/forced-alignment`)
 *    mapping creator-edited lines and `[Section]` tags directly to audio timestamps.
 */
export async function processSongLyrics(songId: string, options: ProcessOptions = {}): Promise<LyricsResult | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;

  return withJobLock(`scribe:${songId}`, async () => {
    const [takes, stems] = await Promise.all([listTakesBySong(songId), listStemsBySong(songId)]);
    const stored = readStoredState(takes, options.languageCode);
    const resolved = await resolveAudioTarget(songId, stems, takes, options.audioUrl);
    if (!resolved) return null;

    const explicitLyrics =
      typeof options.lyrics === 'string' && options.lyrics.trim() && !isInstrumentalText(options.lyrics)
        ? options.lyrics.trim()
        : '';
    const referenceLyrics = explicitLyrics || stored.referenceLyrics;
    const mode = options.mode ?? 'auto';
    const languageCode = cleanLanguageCode(options.languageCode) ?? stored.vocalLanguage;

    const needsVocalsUpgrade = resolved.source === 'vocals' && stored.alignmentSource !== 'vocals';
    const audioChanged = stored.alignmentAudioUrl !== resolved.url;
    const isUpToDate =
      !options.force &&
      !explicitLyrics &&
      mode === 'auto' &&
      !needsVocalsUpgrade &&
      !audioChanged &&
      (stored.recordStatus === 'ready' ||
        stored.recordStatus === 'instrumental' ||
        stored.recordStatus === 'empty');

    if (isUpToDate) {
      const publicAlignment = toPublicAlignment(stored.alignment);
      await cacheSet<CachedPublicLyrics>(
        publicCacheKey(songId),
        { alignment: publicAlignment, status: publicAlignment ? 'cached' : 'none' },
        PUBLIC_CACHE_TTL_SEC,
        60_000
      );
      return {
        lyrics: stored.referenceLyrics,
        vocalLanguage: languageCode ?? 'en',
        alignment: stored.alignment,
        status: stored.alignment ? 'cached' : 'none',
      };
    }

    const targets = takes.filter(
      (t) =>
        t.task === 'text2music' ||
        t.is_active ||
        (resolved.vocalsStem && t.stem_id === resolved.vocalsStem.id)
    );
    const takesToUpdate = targets.length > 0 ? targets : takes.slice(0, 1);

    if (stored.isInstrumental && !referenceLyrics && mode !== 'extract') {
      await Promise.all(
        takesToUpdate.map((take) =>
          updateTakeLyrics(
            take.id,
            songId,
            take.lyrics ?? '[Instrumental]',
            buildCanonicalProvenance(take.provenance, songId, resolved.url, resolved.source, 'instrumental', null, languageCode)
          )
        )
      );
      await cacheSet<CachedPublicLyrics>(
        publicCacheKey(songId),
        { alignment: null, status: 'none' },
        PUBLIC_CACHE_TTL_SEC,
        60_000
      );
      await notifyLyricsUpdated(songId);
      return { lyrics: '', vocalLanguage: languageCode ?? 'en', alignment: null, status: 'none' };
    }

    const parsed = parseLyrics(referenceLyrics);
    const loadedAudio = await readAudio(resolved.url);
    const wavBuffer = prepareVocalStemWavForElevenLabs(loadedAudio.buffer);
    const contentType = loadedAudio.contentType || 'audio/wav';

    let alignment: LyricsAlignment | null = null;
    let finalLyrics = referenceLyrics;
    let resolvedLang = languageCode;

    if (mode === 'align' && parsed.plainText.length > 0) {
      const aligned = await callForcedAlignment(apiKey, wavBuffer, contentType, parsed.plainText);
      if (aligned) {
        alignment = buildAlignedLyrics(parsed, aligned.characters, aligned.words);
      }
    } else {
      const transcribed = await callScribe(apiKey, wavBuffer, contentType, {
        languageCode,
        keyterms: parsed.keyterms,
      });
      if (transcribed) {
        resolvedLang = cleanLanguageCode(transcribed.language_code) ?? resolvedLang;
        const built = buildScribeLyrics(transcribed);
        alignment = built.alignment;
        if (!finalLyrics || mode === 'extract') {
          finalLyrics = built.lyrics || finalLyrics;
        }
      }
    }

    const recordStatus: LyricsRecordStatus = alignment ? 'ready' : 'empty';

    await Promise.all(
      takesToUpdate.map((take) => {
        const nextLyrics =
          explicitLyrics || mode === 'extract'
            ? finalLyrics || take.lyrics || null
            : take.lyrics?.trim() && !isInstrumentalText(take.lyrics)
              ? take.lyrics
              : finalLyrics || take.lyrics || null;
        const nextProv = buildCanonicalProvenance(
          take.provenance,
          songId,
          resolved.url,
          resolved.source,
          recordStatus,
          alignment,
          resolvedLang
        );
        return updateTakeLyrics(take.id, songId, nextLyrics, nextProv);
      })
    );

    const publicAlignment = toPublicAlignment(alignment);
    await cacheSet<CachedPublicLyrics>(
      publicCacheKey(songId),
      { alignment: publicAlignment, status: publicAlignment ? 'cached' : 'none' },
      PUBLIC_CACHE_TTL_SEC,
      60_000
    );
    await notifyLyricsUpdated(songId);

    return {
      lyrics: finalLyrics,
      vocalLanguage: resolvedLang ?? 'en',
      alignment,
      status: alignment ? 'cached' : 'none',
    };
  });
}

/**
 * Non-blocking public lyrics accessor backed by `valkeyCache` + canonical take provenance.
 * Never leaks `[bracketed]` directives to listeners; enqueues into `queue:scribe:urgent` only if missing.
 */
export async function getPublicLyrics(
  songId: string,
  preferredLanguage?: string
): Promise<{ alignment: LyricsAlignment | null; status: 'cached' | 'transcribing' | 'none' }> {
  const hit = await cacheGet<CachedPublicLyrics>(publicCacheKey(songId), 60_000);
  if (hit) return hit;

  const [takes, stems] = await Promise.all([listTakesBySong(songId), listStemsBySong(songId)]);
  const stored = readStoredState(takes, preferredLanguage);
  const publicAlignment = toPublicAlignment(stored.alignment);

  const hasVocalsStem = stems.some((s) => s.name.toLowerCase() === 'vocals' && Boolean(s.url));
  const needsVocalsUpgrade = hasVocalsStem && stored.alignmentSource !== 'vocals';

  if (stored.recordStatus === 'ready' && publicAlignment && !needsVocalsUpgrade) {
    await cacheSet<CachedPublicLyrics>(
      publicCacheKey(songId),
      { alignment: publicAlignment, status: 'cached' },
      PUBLIC_CACHE_TTL_SEC,
      60_000
    );
    return { alignment: publicAlignment, status: 'cached' };
  }

  if (stored.recordStatus === 'instrumental' || stored.recordStatus === 'empty') {
    await cacheSet<CachedPublicLyrics>(
      publicCacheKey(songId),
      { alignment: null, status: 'none' },
      PUBLIC_CACHE_TTL_SEC,
      60_000
    );
    return { alignment: null, status: 'none' };
  }

  if (stored.isInstrumental && !stored.referenceLyrics) {
    await cacheSet<CachedPublicLyrics>(
      publicCacheKey(songId),
      { alignment: null, status: 'none' },
      PUBLIC_CACHE_TTL_SEC,
      60_000
    );
    return { alignment: null, status: 'none' };
  }

  const pending = await isScribePending(songId).catch(() => false);
  if (pending) {
    return { alignment: publicAlignment, status: 'transcribing' };
  }

  if (process.env.ELEVENLABS_API_KEY?.trim()) {
    const audio = await resolveAudioTarget(songId, stems, takes);
    if (audio?.url) {
      await scribeQueue.enqueue(songId, { priority: 'urgent', force: needsVocalsUpgrade });
      return { alignment: publicAlignment, status: 'transcribing' };
    }
  }

  return publicAlignment
    ? { alignment: publicAlignment, status: 'cached' }
    : { alignment: null, status: 'none' };
}

/**
 * Synchronous-await public lyrics accessor for server-side callers that need aligned lyrics immediately.
 */
export async function ensurePublicLyrics(
  songId: string,
  preferredLanguage?: string
): Promise<LyricsAlignment | null> {
  const hit = await cacheGet<CachedPublicLyrics>(publicCacheKey(songId), 60_000);
  if (hit) return hit.alignment;

  const result = await processSongLyrics(songId, { languageCode: preferredLanguage }).catch(() => null);
  return toPublicAlignment(result?.alignment);
}

/**
 * Non-blocking DAW Editor lyrics accessor preserving `[Section]` tags alongside timed lines.
 */
export async function getEditorLyrics(
  songId: string,
  preferredLanguage?: string
): Promise<{
  lyrics: string;
  vocalLanguage: string;
  alignment: LyricsAlignment | null;
  status: 'cached' | 'transcribing' | 'aligning' | 'none';
}> {
  const [takes, stems] = await Promise.all([listTakesBySong(songId), listStemsBySong(songId)]);
  const stored = readStoredState(takes, preferredLanguage);
  const vocalLanguage = stored.vocalLanguage ?? cleanLanguageCode(preferredLanguage) ?? 'en';

  const hasVocalsStem = stems.some((s) => s.name.toLowerCase() === 'vocals' && Boolean(s.url));
  const needsVocalsUpgrade = hasVocalsStem && stored.alignmentSource !== 'vocals';

  if (stored.recordStatus === 'ready' && stored.alignment && !needsVocalsUpgrade) {
    return {
      lyrics: stored.referenceLyrics,
      vocalLanguage,
      alignment: stored.alignment,
      status: 'cached',
    };
  }

  if (stored.recordStatus === 'instrumental' || (stored.isInstrumental && !stored.referenceLyrics)) {
    return { lyrics: '', vocalLanguage, alignment: null, status: 'none' };
  }

  if (stored.recordStatus === 'empty' && !needsVocalsUpgrade) {
    return {
      lyrics: stored.referenceLyrics,
      vocalLanguage,
      alignment: null,
      status: stored.referenceLyrics ? 'cached' : 'none',
    };
  }

  const pendingStatus = stored.referenceLyrics ? 'aligning' : 'transcribing';
  const pending = await isScribePending(songId).catch(() => false);
  if (pending) {
    return {
      lyrics: stored.referenceLyrics,
      vocalLanguage,
      alignment: stored.alignment,
      status: pendingStatus,
    };
  }

  if (process.env.ELEVENLABS_API_KEY?.trim()) {
    const audio = await resolveAudioTarget(songId, stems, takes);
    if (audio?.url) {
      await scribeQueue.enqueue(songId, { priority: 'urgent', force: needsVocalsUpgrade });
      return {
        lyrics: stored.referenceLyrics,
        vocalLanguage,
        alignment: stored.alignment,
        status: pendingStatus,
      };
    }
  }

  return {
    lyrics: stored.referenceLyrics,
    vocalLanguage,
    alignment: stored.alignment,
    status: stored.alignment || stored.referenceLyrics ? 'cached' : 'none',
  };
}

/**
 * Durable Valkey-backed asynchronous transcription queue coordinator.
 * Drains `queue:scribe:urgent` immediately (generated, published, vocal-stem, edited songs)
 * and progressively backfills existing published & drafted songs via `queue:scribe:backfill`.
 */
class ScribeQueue {
  private stopped = true;
  private seedTimer?: ReturnType<typeof setTimeout>;
  private workerLoops: Promise<void>[] = [];
  private wakeResolvers: Array<() => void> = [];

  async enqueue(songId: string, options?: { priority?: 'urgent' | 'backfill'; force?: boolean }): Promise<boolean> {
    const added = await enqueueScribe(songId, options).catch(() => false);
    this.wake();
    return added;
  }

  wake(): void {
    const pending = this.wakeResolvers;
    this.wakeResolvers = [];
    for (const resolve of pending) resolve();
  }

  private waitOrWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        const idx = this.wakeResolvers.indexOf(onWake);
        if (idx >= 0) this.wakeResolvers.splice(idx, 1);
        resolve();
      }, ms);
      timer.unref();
      const onWake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wakeResolvers.push(onWake);
    });
  }

  async seedBackfill(limit = 50): Promise<number> {
    if (!process.env.ELEVENLABS_API_KEY?.trim()) return 0;
    const acquired = await valkey.set('lock:scribe:seeder', '1', 'EX', 240, 'NX').catch(() => null);
    if (acquired !== 'OK') return 0;

    const songIds = await listSongsNeedingLyrics(limit).catch((err) => {
      console.warn('[ScribeQueue] Backfill query failed:', err?.message || err);
      return [] as string[];
    });

    let count = 0;
    for (const songId of songIds) {
      if (this.stopped) break;
      const added = await enqueueScribe(songId, { priority: 'backfill' }).catch(() => false);
      if (added) count += 1;
    }
    if (count > 0) this.wake();
    return count;
  }

  private async runWorker(): Promise<void> {
    while (!this.stopped) {
      if (!process.env.ELEVENLABS_API_KEY?.trim()) {
        await this.waitOrWake(30_000);
        continue;
      }

      const item = await dequeueScribe().catch(() => null);
      if (!item) {
        await this.waitOrWake(IDLE_POLL_MS);
        continue;
      }

      try {
        await processSongLyrics(item.songId, { force: item.force });
      } catch (err: any) {
        console.warn(`[ScribeQueue] Failed processing ${item.songId}:`, err?.message || err);
      } finally {
        await finishScribe(item.songId);
      }

      if (item.tier === 'backfill' && !this.stopped) {
        await this.waitOrWake(BACKFILL_PACE_MS);
      }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    for (let i = 0; i < WORKER_CONCURRENCY; i++) {
      this.workerLoops.push(this.runWorker());
    }

    const scheduleSeed = (delayMs: number) => {
      if (this.stopped) return;
      this.seedTimer = setTimeout(() => {
        if (this.stopped) return;
        void this.seedBackfill()
          .catch(() => {})
          .finally(() => scheduleSeed(SEED_INTERVAL_MS));
      }, delayMs);
      this.seedTimer.unref();
    };
    scheduleSeed(3_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.seedTimer) {
      clearTimeout(this.seedTimer);
      this.seedTimer = undefined;
    }
    this.wake();
    await Promise.allSettled(this.workerLoops);
    this.workerLoops = [];
  }
}

export const scribeQueue = new ScribeQueue();
