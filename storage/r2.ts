import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { isIP } from 'node:net';
import { extractWavBipolarPeaks, setInMemoryPeaks } from '../editing/audio.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

export type R2Bucket = 'songs' | 'versions' | 'loras';
const R2_PUBLIC_DOMAINS: Record<R2Bucket, string> = {
  songs: 'https://pub-62c17ba4ea004db3bee5152452c65d61.r2.dev',
  versions: 'https://pub-fe479ba223594154bafa46e42d2fc7c6.r2.dev',
  loras: 'https://pub-1b122472089542a8826ac7f695328c46.r2.dev',
};
// Cloudflare's REST object upload endpoint supports at most 300 MB.
const MAX_OBJECT_BYTES = 300_000_000;

function cfAccountId(): string { return process.env.CF_ACCOUNT_ID!; }
function cfToken(): string | undefined { return process.env.CF_GLOBAL_TOKEN || process.env.CF_API_TOKEN; }

function bucketDomain(bucket: R2Bucket): string {
  if (!Object.hasOwn(R2_PUBLIC_DOMAINS, bucket)) throw new Error('Unknown R2 bucket');
  return R2_PUBLIC_DOMAINS[bucket];
}
function objectKey(key: string): string {
  if (typeof key !== 'string') throw new Error('R2 key must be a string');
  const clean = key.startsWith('/') ? key.slice(1) : key;
  if (!clean.trim() || /[\u0000-\u001f\u007f\\]/.test(clean) || clean.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid R2 object key');
  return clean;
}
function encodedKey(key: string): string { return key.split('/').map(encodeURIComponent).join('/'); }
function apiUrl(bucket: R2Bucket, key?: string): string {
  bucketDomain(bucket);
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccountId())}/r2/buckets/${bucket}/objects${key === undefined ? '' : `/${encodedKey(key)}`}`;
}
function timeoutMs(): number {
  const value = Number(process.env.R2_REQUEST_TIMEOUT_MS || 120_000);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('R2_REQUEST_TIMEOUT_MS must be a positive finite integer');
  return value;
}
async function request<T>(url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
  const milliseconds = timeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('R2 request timed out')); }, milliseconds);
  });
  try { return await Promise.race([fetch(url, { redirect: 'error', ...init, signal: controller.signal }).then(consume), expired]); }
  finally { clearTimeout(timer); }
}
async function providerResult(response: Response, operation: string): Promise<any> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${operation}: ${response.statusText} (${detail})`);
  }
  const data = await response.json() as any;
  if (!data || data.success !== true || (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length))) throw new Error(`${operation}: invalid provider response`);
  return data;
}

/** Returns an encoded permanent edge URL without changing the raw object key. */
export function getR2Url(bucket: R2Bucket, key: string): string { return `${bucketDomain(bucket)}/${encodedKey(objectKey(key))}`; }

export async function uploadToR2(bucket: R2Bucket, key: string, data: Buffer | Uint8Array, contentType = 'audio/wav'): Promise<string> {
  const cleanKey = objectKey(key);
  const url = apiUrl(bucket, cleanKey);
  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_OBJECT_BYTES) throw new Error('Invalid or oversized R2 upload body');
  if (typeof contentType !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/.test(contentType)) throw new Error('Invalid upload content type');
  await request(url, { method: 'PUT', headers: { Authorization: `Bearer ${cfToken()}`, 'Content-Type': contentType }, body: data as any }, async res => {
    const result = await providerResult(res, `Failed to upload object to R2 bucket "${bucket}"`);
    if (!result.result || result.result.key !== cleanKey) throw new Error('R2 upload did not acknowledge the requested object');
  });
  const destination = `${bucketDomain(bucket)}/${encodedKey(cleanKey)}`;
  if (!process.env.VITEST && (bucket === 'versions' || bucket === 'songs') && /^audio\//i.test(contentType)) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    try {
      const peaks = extractWavBipolarPeaks(buf, 512);
      setInMemoryPeaks(destination, peaks);
      if (hasValkeyConfig()) {
        void import('../broker/valkey.js')
          .then(({ setCachedPeaks }) => setCachedPeaks(`${destination}|512`, peaks))
          .catch(() => {});
      }
    } catch {
      // Non-WAV or synthetic payloads skip in-memory peak precomputation
    }
    if (!inFlightStemBuffers.has(destination)) {
      while (inFlightStemBuffers.size >= 16) {
        const oldest = inFlightStemBuffers.keys().next().value;
        if (oldest !== undefined) inFlightStemBuffers.delete(oldest);
      }
      inFlightStemBuffers.set(destination, { buffer: buf, contentType, uploadPromise: Promise.resolve(destination) });
      setTimeout(() => inFlightStemBuffers.delete(destination), 60_000).unref?.();
    }
  }
  return destination;
}

/** Returns the raw bucket/key for one of this application's exact public origins. */
export function parseR2Url(source: string): { bucket: R2Bucket; key: string } | null {
  let url: URL;
  try { url = new URL(source); } catch { return null; }
  const bucket = (Object.keys(R2_PUBLIC_DOMAINS) as R2Bucket[]).find(bucket => url.origin === R2_PUBLIC_DOMAINS[bucket]);
  if (!bucket || url.username || url.password) return null;
  const key = decodeURIComponent(url.pathname.slice(1));
  objectKey(`/${key}`);
  return { bucket, key };
}
function isPrivateHost(host: string): boolean {
  const plain = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (plain === 'localhost' || plain.endsWith('.localhost') || plain.endsWith('.local') || plain.endsWith('.internal') || plain.endsWith('.svc') || plain.endsWith('.cluster.local')) return true;
  if (isIP(plain) === 4) {
    const [a, b] = plain.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(plain) === 6) return plain === '::' || plain === '::1' || /^(fc|fd|fe[89ab])/.test(plain) || plain.startsWith('::ffff:');
  return false;
}
function sourceLocation(sourceUrl: string): { url: URL; workerOrigin: string } {
  if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) throw new Error('Audio source URL is required');
  if (/%(?![\da-f]{2})/i.test(sourceUrl)) throw new URIError('Malformed URL encoding');
  const worker = new URL(process.env.ACESTEP_API_URL!);
  let url: URL;
  if (/^\/(?:api\/audio|v1\/audio|audio)(?:[/?]|$)/.test(sourceUrl)) {
    url = new URL(sourceUrl, worker);
    if (url.searchParams.has('path')) {
      const paths = url.searchParams.getAll('path');
      if (paths.length !== 1 || !paths[0]) throw new Error('Audio path must be supplied once');
      url = new URL('/v1/audio', worker); url.search = `?path=${encodeURIComponent(paths[0])}`;
    }
  } else { url = new URL(sourceUrl); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.origin !== worker.origin && isPrivateHost(url.hostname))) throw new Error('Unsupported audio source URL');
  return { url, workerOrigin: worker.origin };
}

const inFlightStemBuffers = new Map<string, { buffer: Buffer; contentType: string; uploadPromise: Promise<string> }>();
const inFlightAudioReads = new Map<string, Promise<{ buffer: Buffer; contentType: string }>>();

export async function readAudio(sourceUrl: string, fallbackContentType = 'audio/wav'): Promise<{ buffer: Buffer; contentType: string }> {
  let { url, workerOrigin } = sourceLocation(sourceUrl);
  let redirectCount = 0;
  const download = async (): Promise<{ buffer: Buffer; contentType: string }> => {
    const headers: Record<string, string> = {};
    if (process.env.ACESTEP_API_KEY && url.origin === workerOrigin) headers.Authorization = `Bearer ${process.env.ACESTEP_API_KEY}`;
    return request(url.toString(), { headers, redirect: 'manual' }, async res => {
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location || ++redirectCount > 10) throw new Error('Invalid or excessive audio redirect');
        const next = sourceLocation(new URL(location, url).toString());
        url = next.url;
        void res.body?.cancel().catch(() => { });
        return download();
      }
      if (!res.ok) throw new Error(`Failed to fetch source audio: ${res.statusText}`);
      const contentType = res.headers.get('content-type') || fallbackContentType;
      if (!/^audio\//i.test(contentType) && !/^application\/octet-stream(?:;|$)/i.test(contentType)) throw new Error('Source response is not audio');
      const length = res.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_OBJECT_BYTES)) throw new Error('Oversized or invalid source audio length');
      const chunks: Uint8Array[] = []; let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_OBJECT_BYTES) { await reader.cancel(); throw new Error('Source audio exceeds upload limit'); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      } else { const chunk = new Uint8Array(await res.arrayBuffer()); size = chunk.byteLength; chunks.push(chunk); }
      if (!size || size > MAX_OBJECT_BYTES) throw new Error('Empty or oversized source audio');
      return { buffer: Buffer.concat(chunks), contentType };
    });
  };
  return download();
}

export async function persistAudioToR2(bucket: R2Bucket, key: string, sourceUrl: string, fallbackContentType = 'audio/wav'): Promise<string> {
  const destination = getR2Url(bucket, key);
  const owned = parseR2Url(sourceUrl);
  if (owned?.bucket === bucket && owned.key === objectKey(key)) return destination;
  const { buffer, contentType } = await readAudio(sourceUrl, fallbackContentType);
  return uploadToR2(bucket, key, buffer, contentType);
}

export async function deleteFromR2(bucket: R2Bucket, key: string): Promise<boolean> {
  const cleanKey = objectKey(key);
  return request(apiUrl(bucket, cleanKey), { method: 'DELETE', headers: { Authorization: `Bearer ${cfToken()}` } }, async res => {
    if (!res.ok) return false;
    const data = await providerResult(res, 'Failed to delete R2 object');
    return data.result?.key === cleanKey;
  });
}
export interface R2ObjectInfo { key: string; size: number; lastModified: string; etag?: string; }
export async function listR2Objects(bucket: R2Bucket): Promise<R2ObjectInfo[]> {
  const results: R2ObjectInfo[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
  do {
    const url = new URL(apiUrl(bucket)); url.searchParams.set('per_page', '1000'); if (cursor) url.searchParams.set('cursor', cursor);
    const data = await request(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${cfToken()}` } }, res => providerResult(res, `Failed to list objects in R2 bucket "${bucket}"`));
    if (!Array.isArray(data.result)) throw new Error('Invalid R2 object listing');
    for (const item of data.result) {
      if (!item || typeof item.key !== 'string' || !item.key || (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0)) || (item.last_modified !== undefined && typeof item.last_modified !== 'string') || (item.etag !== undefined && typeof item.etag !== 'string')) throw new Error('Invalid R2 object metadata');
      results.push({ key: item.key, size: item.size ?? 0, lastModified: item.last_modified ?? '', etag: item.etag });
    }
    const info = data.result_info;
    if (info !== undefined && (!info || typeof info !== 'object' || (info.is_truncated !== undefined && typeof info.is_truncated !== 'boolean'))) throw new Error('Invalid R2 pagination metadata');
    cursor = info?.is_truncated ? info.cursor : undefined;
    if (info?.is_truncated && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw new Error('Invalid or repeated R2 cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return results;
}
export async function hasR2Object(bucket: R2Bucket, key: string): Promise<boolean> {
  const cleanKey = objectKey(key);
  return (await listR2Objects(bucket)).some(object => object.key === cleanKey);
}
