import type { FastifyPluginAsync } from 'fastify';
import { getNetworkMode } from '../broker/payment.js';
import { getR2Url, parseR2Url, readAudio, uploadToR2 } from '../storage/r2.js';
import { sliceWave } from '../editing/audio.js';
import { cacheGet, cacheSet, cached, singleFlight } from './cache.js';
import { getSongById, isPublicInMode, projectSongs, queryPublicSongs } from './songs.js';
import { listStemsBySong } from './stems.js';
import { getWalletPairsByAddresses } from './users.js';

const EXTRACT_SECONDS = 16;
const EXTRACT_OFFSET = 20;
const EXTRACT_STALE_TTL = 86_400;
const STEMS = ['master', 'vocals', 'drums', 'bass', 'other'] as const;
export type StemKind = (typeof STEMS)[number];
export type SeparatedStem = Exclude<StemKind, 'master'>;

const STEM_SET = new Set<string>(STEMS);
const SEPARATED_SET = new Set<string>(['vocals', 'drums', 'bass', 'other']);

export interface Track {
  id: string;
  title: string;
  creator: string;
  creatorHandle: string | null;
  cover: string | null;
  tags: string[];
  duration: number;
  plays: number;
  likes: number;
  licensePrice: number;
  licenses: number;
  stems: SeparatedStem[];
  extractSeconds: number;
}

export interface Catalog {
  totalPublished: number;
  tracks: Track[];
}

export interface WaveHeader {
  formatChunk: Buffer;
  channels: number;
  rate: number;
  byteRate: number;
  blockAlign: number;
  bits: number;
  dataOffset: number;
  dataSize: number;
}

export function parseWaveHeader(head: Buffer): WaveHeader | null {
  if (head.length < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let formatChunk: Buffer | undefined;
  let dataOffset = -1;
  let dataSize = 0;

  for (let offset = 12; offset + 8 <= head.length;) {
    const id = head.toString('ascii', offset, offset + 4);
    const len = head.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === 'data') {
      dataOffset = bodyStart;
      dataSize = len;
      break;
    }
    const bodyEnd = bodyStart + len;
    if (bodyEnd > head.length) return null;
    if (id === 'fmt ') formatChunk = Buffer.from(head.subarray(bodyStart, bodyEnd));
    offset = bodyEnd + (len & 1);
  }

  if (!formatChunk || formatChunk.length < 16 || dataOffset < 0 || dataSize <= 0) return null;
  let format = formatChunk.readUInt16LE(0);
  if (format === 0xfffe && formatChunk.length >= 40) format = formatChunk.readUInt16LE(24);
  const channels = formatChunk.readUInt16LE(2);
  const rate = formatChunk.readUInt32LE(4);
  const byteRate = formatChunk.readUInt32LE(8);
  const blockAlign = formatChunk.readUInt16LE(12);
  const bits = formatChunk.readUInt16LE(14);
  if (![1, 3].includes(format) || !channels || !rate || !byteRate || !blockAlign || blockAlign !== (channels * bits) / 8) {
    return null;
  }
  return { formatChunk, channels, rate, byteRate, blockAlign, bits, dataOffset, dataSize };
}

export function extractWindow(totalSeconds: number): { start: number; end: number } {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return { start: 0, end: EXTRACT_SECONDS };
  if (totalSeconds <= EXTRACT_SECONDS) return { start: 0, end: totalSeconds };
  if (totalSeconds >= EXTRACT_OFFSET + EXTRACT_SECONDS + 4) {
    return { start: EXTRACT_OFFSET, end: EXTRACT_OFFSET + EXTRACT_SECONDS };
  }
  const start = Math.max(0, Math.floor((totalSeconds - EXTRACT_SECONDS) / 2));
  return { start, end: Math.min(totalSeconds, start + EXTRACT_SECONDS) };
}

export function buildWaveSlice(header: WaveHeader, pcm: Buffer): Buffer {
  const fmtLen = header.formatChunk.length;
  const fmtPad = fmtLen & 1;
  const out = Buffer.alloc(28 + fmtLen + fmtPad);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(out.length + pcm.length - 8, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(fmtLen, 16);
  header.formatChunk.copy(out, 20);
  out.write('data', 20 + fmtLen + fmtPad, 'ascii');
  out.writeUInt32LE(pcm.length, 24 + fmtLen + fmtPad);
  return Buffer.concat([out, pcm]);
}

async function fetchRange(url: string, start: number, end: number): Promise<Buffer | null> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206 && res.status !== 200) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status === 200 && buf.length > end - start + 1) {
    return buf.subarray(start, end + 1);
  }
  return buf;
}

async function sliceRemoteExtract(sourceUrl: string): Promise<Buffer> {
  const head = await fetchRange(sourceUrl, 0, 4095);
  const parsed = head ? parseWaveHeader(head) : null;
  if (parsed) {
    const totalFrames = Math.floor(parsed.dataSize / parsed.blockAlign);
    const totalSeconds = totalFrames / parsed.rate;
    const win = extractWindow(totalSeconds);
    const startFrame = Math.min(totalFrames, Math.floor(win.start * parsed.rate));
    const endFrame = Math.min(totalFrames, Math.floor(win.end * parsed.rate));
    const byteStart = parsed.dataOffset + startFrame * parsed.blockAlign;
    const byteLen = Math.max(parsed.blockAlign, (endFrame - startFrame) * parsed.blockAlign);
    const pcm = await fetchRange(sourceUrl, byteStart, byteStart + byteLen - 1);
    if (pcm && pcm.length >= parsed.blockAlign) {
      const alignedLen = pcm.length - (pcm.length % parsed.blockAlign);
      return buildWaveSlice(parsed, pcm.subarray(0, alignedLen));
    }
  }
  const { buffer } = await readAudio(sourceUrl, 'audio/wav');
  const fullHead = parseWaveHeader(buffer);
  const totalSec = fullHead ? (fullHead.dataSize / fullHead.blockAlign) / fullHead.rate : 180;
  const win = extractWindow(totalSec);
  return sliceWave(buffer, win);
}

function normalizeStemName(raw?: string | null): StemKind | null {
  const clean = (raw || '').trim().toLowerCase();
  if (clean === 'master') return 'master';
  if (SEPARATED_SET.has(clean)) return clean as SeparatedStem;
  return null;
}

function isValidCover(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

async function buildCatalog(): Promise<Catalog> {
  const query = await queryPublicSongs({ sort: 'popular', limit: 24, offset: 0 });
  const projected = await projectSongs(query.items);
  const withAudio = projected.filter((s) => Boolean(s.id && s.url && parseR2Url(s.url)));

  const creators = Array.from(new Set(withAudio.map((s) => s.creator).filter(Boolean)));
  const [stemLists, profiles] = await Promise.all([
    Promise.all(withAudio.map((s) => listStemsBySong(s.id).catch(() => []))),
    creators.length ? getWalletPairsByAddresses(creators).catch(() => []) : Promise.resolve([]),
  ]);

  const handleByAddr = new Map<string, string>();
  for (const profile of profiles) {
    const nick = profile.nickname?.trim();
    if (!nick) continue;
    if (profile.evmAddress) handleByAddr.set(profile.evmAddress.toLowerCase(), nick);
    if (profile.svmAddress) handleByAddr.set(profile.svmAddress.toLowerCase(), nick);
  }

  const tracks: Track[] = withAudio.map((song, i) => {
    const rows = stemLists[i] || [];
    const available = new Set<SeparatedStem>();
    for (const row of rows) {
      const kind = normalizeStemName(row.name);
      if (kind && kind !== 'master' && row.url && parseR2Url(row.url)) {
        available.add(kind);
      }
    }
    const orderedStems: SeparatedStem[] = (['vocals', 'drums', 'bass', 'other'] as const).filter((k) => available.has(k));
    const tags = Array.isArray(song.tags) ? song.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 4) : [];

    return {
      id: song.id,
      title: song.title,
      creator: song.creator,
      creatorHandle: handleByAddr.get(song.creator.toLowerCase()) ?? null,
      cover: isValidCover(song.image),
      tags,
      duration: typeof song.duration === 'number' && song.duration > 0 ? Math.round(song.duration) : 180,
      plays: song.plays ?? 0,
      likes: song.likes ?? 0,
      licensePrice: Number(song.license_price ?? 0),
      licenses: Number(song.licenses ?? 0),
      stems: orderedStems,
      extractSeconds: EXTRACT_SECONDS,
    };
  });

  // Prioritize tracks with all 4 real separated stems, cover art, and active remix licenses
  tracks.sort((a, b) => {
    const score = (t: Track) =>
      (t.stems.length === 4 ? 1000 : t.stems.length * 100) +
      (t.cover ? 50 : 0) +
      (t.licensePrice > 0 && t.licenses > 0 ? 40 : 0) +
      Math.min(39, Math.floor(t.plays / 5));
    return score(b) - score(a) || b.plays - a.plays;
  });

  return {
    totalPublished: query.total,
    tracks: tracks.slice(0, 10),
  };
}

export const showcaseRouter: FastifyPluginAsync = async (app) => {
  app.get('/showcase', async (_request, reply) => {
    const mode = getNetworkMode();
    const data = await cached<Catalog>(`showcase:catalog:${mode}`, 300, 60_000, buildCatalog);
    reply.header('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
    return reply.send(data);
  });

  app.get('/showcase/:id/audio', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rawStem = String((request.query as { stem?: string } | undefined)?.stem || 'master').trim().toLowerCase();
    if (!STEM_SET.has(rawStem)) {
      return reply.status(400).send({ error: 'Invalid stem name' });
    }
    const stem = rawStem as StemKind;

    const song = await getSongById(id);
    if (!song || !isPublicInMode(song)) {
      return reply.status(404).send({ error: 'Track not found' });
    }

    const extractKey = `extracts/${song.id}/${stem}.wav`;
    const extractUrl = getR2Url('versions', extractKey);
    const cacheKey = `showcase:ext:${song.id}:${stem}`;

    const knownUrl = await cacheGet<string>(cacheKey, 60_000);
    if (knownUrl) {
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.redirect(knownUrl, 302);
    }

    // Check if the isolated 16s extract already exists on R2
    try {
      const head = await fetch(extractUrl, { method: 'HEAD' });
      if (head.ok) {
        await cacheSet(cacheKey, extractUrl, EXTRACT_STALE_TTL, 60_000);
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.redirect(extractUrl, 302);
      }
    } catch {
      // Proceed to slice and store
    }

    // Resolve source URL server-side (never exposed to client)
    let sourceUrl: string | null = null;
    if (stem === 'master') {
      sourceUrl = song.url || null;
    } else {
      const rows = await listStemsBySong(song.id);
      const match = rows.find((r) => normalizeStemName(r.name) === stem && Boolean(r.url));
      sourceUrl = match?.url || null;
    }

    if (!sourceUrl || !parseR2Url(sourceUrl)) {
      return reply.status(404).send({ error: 'Stem extract not available' });
    }

    const sliced = await singleFlight(`showcase:slice:${song.id}:${stem}`, async () => {
      const wav = await sliceRemoteExtract(sourceUrl!);
      await uploadToR2('versions', extractKey, wav, 'audio/wav').catch((err) => {
        request.log.warn({ err, extractKey }, 'Failed to cache showcase extract in R2');
      });
      await cacheSet(cacheKey, extractUrl, EXTRACT_STALE_TTL, 60_000);
      return wav;
    });

    reply.header('Content-Type', 'audio/wav');
    reply.header('Content-Length', String(sliced.byteLength));
    reply.header('Cache-Control', 'public, max-age=86400, immutable');
    return reply.send(sliced);
  });
};
