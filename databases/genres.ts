import { eq, inArray, sql } from 'drizzle-orm';
import { songDb } from './client.js';
import { genreCovers } from './schema/genres.js';
import { generateCoverArt } from '../generation/router.js';
import { cacheDel } from './cache.js';
import { NON_GENRE_SLUGS } from '../options.js';

export interface GenreCoverInfo {
  slug: string;
  label: string;
  imageUrl: string | null;
  status: 'pending' | 'ready' | 'failed';
}

/**
 * Exact 1:1 static genre covers shipped in /public/genres/*.jpeg.
 * No related-genre aliases or keyword fallbacks—any other genre is generated
 * dynamically by the cover-art agent and persisted in `genre_covers`.
 */
export const STATIC_GENRE_COVERS: Record<string, string> = {
  'acid-techno': '/genres/acid-techno.jpeg',
  'airy-lead-vocals': '/genres/airy-lead-vocals.jpeg',
  'cinematic-strings': '/genres/cinematic-strings.jpeg',
  'crisp-acoustic-drums': '/genres/crisp-acoustic-drums.jpeg',
  'electronic': '/genres/electronic.jpeg',
  'funky-electric-guitar': '/genres/funky-electric-guitar.jpeg',
  'lo-fi-tape-saturation': '/genres/lo-fi-tape-saturation.jpeg',
  'lush-backing-harmonies': '/genres/lush-backing-harmonies.jpeg',
  'neural-glitch': '/genres/neural-glitch.jpeg',
  'punchy-808-bass': '/genres/punchy-808-bass.jpeg',
  'rock': '/genres/rock.jpeg',
  'warm-analog-synth': '/genres/warm-analog-synth.jpeg',
};

const FAILED_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const STALE_PENDING_TIMEOUT_MS = 3 * 60 * 1000;

const inFlightGenreGenerations = new Map<string, Promise<string | null>>();
const memoryGenreCovers = new Map<string, { slug: string; label: string; imageUrl: string | null; status: 'pending' | 'ready' | 'failed'; updatedAt: number }>();

export function cleanGenreLabel(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  const stripped = raw
    .trim()
    .replace(/^#+/, '')
    .replace(/^genre:\s*/i, '')
    .trim();
  return stripped;
}

export function normalizeGenreSlug(raw?: string | null): string {
  const cleaned = cleanGenreLabel(raw);
  if (!cleaned) return '';
  return cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function getStaticGenreCover(genre?: string | null): string | null {
  const slug = normalizeGenreSlug(genre);
  if (!slug) return null;
  return STATIC_GENRE_COVERS[slug] ?? null;
}

export function extractGenreLabels(rawInputs?: (string | null | undefined)[] | null): Array<{ slug: string; label: string }> {
  if (!Array.isArray(rawInputs)) return [];
  const seen = new Set<string>();
  const result: Array<{ slug: string; label: string }> = [];

  for (const raw of rawInputs) {
    if (typeof raw !== 'string') continue;
    for (const part of raw.split(/[,;|•]+/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Ignore non-genre structured tags like "bpm:120" or "key:Cm", but allow "genre:..."
      if (trimmed.includes(':') && !/^genre:/i.test(trimmed)) continue;
      const label = cleanGenreLabel(trimmed);
      const slug = normalizeGenreSlug(label);
      if (!slug || (NON_GENRE_SLUGS.has(slug) && !STATIC_GENRE_COVERS[slug])) continue;
      if (!seen.has(slug)) {
        seen.add(slug);
        result.push({ slug, label });
      }
    }
  }
  return result;
}

async function invalidateMarketFoldsCache(): Promise<void> {
  try {
    const keys = ['songs:all'];
    for (const limit of [12, 20, 50]) {
      keys.push(`songs:market:folds:${limit}`);
      for (const win of [15, 30, 60]) {
        keys.push(`songs:market:folds:${limit}:${win}`);
      }
    }
    await Promise.all(keys.map((k) => cacheDel(k)));
  } catch {
    // Ignore cache invalidation errors in background worker
  }
}

async function generateAndPersistGenreCover(
  slug: string,
  label: string,
  generateFn: typeof generateCoverArt = generateCoverArt,
): Promise<string | null> {
  const existingFlight = inFlightGenreGenerations.get(slug);
  if (existingFlight) return existingFlight;

  const task = (async () => {
    try {
      // Prompt the cover-art agent with "${new-genre}" as both prompt and title
      const imageUrl = await generateFn({
        prompt: label,
        title: label,
      });

      const now = new Date();
      memoryGenreCovers.set(slug, {
        slug,
        label,
        imageUrl,
        status: 'ready',
        updatedAt: now.getTime(),
      });

      try {
        await songDb
          .insert(genreCovers)
          .values({
            slug,
            label,
            image_url: imageUrl,
            status: 'ready',
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: genreCovers.slug,
            set: {
              label,
              image_url: imageUrl,
              status: 'ready',
              updated_at: now,
            },
          });
      } catch (dbErr) {
        console.warn(`[GenreCoverPipeline] Failed to persist ready genre cover for "${slug}":`, dbErr);
      }

      await invalidateMarketFoldsCache();
      return imageUrl;
    } catch (err) {
      const now = new Date();
      memoryGenreCovers.set(slug, {
        slug,
        label,
        imageUrl: null,
        status: 'failed',
        updatedAt: now.getTime(),
      });

      try {
        await songDb
          .update(genreCovers)
          .set({
            status: 'failed',
            updated_at: now,
          })
          .where(eq(genreCovers.slug, slug));
      } catch {
        // Ignore DB error on failure status update
      }
      console.warn(`[GenreCoverPipeline] Cover generation failed for genre "${label}" (${slug}):`, err);
      return null;
    } finally {
      inFlightGenreGenerations.delete(slug);
    }
  })();

  inFlightGenreGenerations.set(slug, task);
  return task;
}

/**
 * Verifies whether each genre already has an associated image (static or in `genre_covers`).
 * If a genre does not have an image yet, marks it `pending` and triggers the cover-art agent
 * in the background (parallel and non-blocking) with `prompt = genre` and `title = genre`.
 */
export async function ensureGenreCovers(
  rawGenres?: (string | null | undefined)[] | null,
  options?: { generateFn?: typeof generateCoverArt },
): Promise<Record<string, GenreCoverInfo>> {
  const entries = extractGenreLabels(rawGenres);
  const out: Record<string, GenreCoverInfo> = {};
  if (entries.length === 0) return out;

  const dynamicEntries: Array<{ slug: string; label: string }> = [];

  for (const entry of entries) {
    const staticUrl = STATIC_GENRE_COVERS[entry.slug];
    if (staticUrl) {
      out[entry.slug] = {
        slug: entry.slug,
        label: entry.label,
        imageUrl: staticUrl,
        status: 'ready',
      };
    } else {
      dynamicEntries.push(entry);
    }
  }

  if (dynamicEntries.length === 0) {
    return out;
  }

  const slugs = dynamicEntries.map((d) => d.slug);
  const dbRowsBySlug = new Map<string, { slug: string; label: string; image_url: string | null; status: string; updated_at: Date }>();

  try {
    const rows = await songDb
      .select()
      .from(genreCovers)
      .where(inArray(genreCovers.slug, slugs));
    for (const r of rows) {
      dbRowsBySlug.set(r.slug, r);
    }
  } catch {
    // Fallback to in-memory tracking if table is not migrated yet or DB is unavailable in unit tests
  }

  const nowMs = Date.now();
  const generateFn = options?.generateFn ?? generateCoverArt;

  for (const { slug, label } of dynamicEntries) {
    const dbRow = dbRowsBySlug.get(slug);
    const memRow = memoryGenreCovers.get(slug);

    // 1. Already ready in DB or memory
    if (dbRow?.status === 'ready' && dbRow.image_url) {
      out[slug] = {
        slug,
        label: dbRow.label || label,
        imageUrl: dbRow.image_url,
        status: 'ready',
      };
      continue;
    }
    if (memRow?.status === 'ready' && memRow.imageUrl) {
      out[slug] = {
        slug,
        label: memRow.label || label,
        imageUrl: memRow.imageUrl,
        status: 'ready',
      };
      continue;
    }

    // 2. Currently in-flight in this process
    if (inFlightGenreGenerations.has(slug)) {
      out[slug] = {
        slug,
        label: dbRow?.label || memRow?.label || label,
        imageUrl: null,
        status: 'pending',
      };
      continue;
    }

    // 3. Recently marked pending in DB (e.g. another worker instance)
    const dbUpdatedMs = dbRow?.updated_at ? new Date(dbRow.updated_at).getTime() : 0;
    if (dbRow?.status === 'pending' && nowMs - dbUpdatedMs < STALE_PENDING_TIMEOUT_MS) {
      out[slug] = {
        slug,
        label: dbRow.label || label,
        imageUrl: null,
        status: 'pending',
      };
      continue;
    }

    // 4. Recently failed — wait for cooldown before re-triggering
    const lastFailedMs = Math.max(
      dbRow?.status === 'failed' ? dbUpdatedMs : 0,
      memRow?.status === 'failed' ? memRow.updatedAt : 0,
    );
    if (lastFailedMs > 0 && nowMs - lastFailedMs < FAILED_RETRY_COOLDOWN_MS) {
      out[slug] = {
        slug,
        label: dbRow?.label || memRow?.label || label,
        imageUrl: null,
        status: 'failed',
      };
      continue;
    }

    // 5. New genre (or stale pending/failed ready for retry): mark pending & dispatch non-blocking agent job
    const now = new Date();
    memoryGenreCovers.set(slug, {
      slug,
      label,
      imageUrl: null,
      status: 'pending',
      updatedAt: now.getTime(),
    });

    try {
      await songDb
        .insert(genreCovers)
        .values({
          slug,
          label,
          image_url: null,
          status: 'pending',
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: genreCovers.slug,
          set: {
            label,
            status: 'pending',
            updated_at: now,
          },
          setWhere: sql`${genreCovers.status} <> 'ready'`,
        });
    } catch {
      // Ignore DB insert error if running without DB in unit tests
    }

    out[slug] = {
      slug,
      label,
      imageUrl: null,
      status: 'pending',
    };

    // Fire-and-forget so caller is never blocked
    void generateAndPersistGenreCover(slug, label, generateFn);
  }

  return out;
}

export function __resetGenreCoverMemoryForTests(): void {
  inFlightGenreGenerations.clear();
  memoryGenreCovers.clear();
}
