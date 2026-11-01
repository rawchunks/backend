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


