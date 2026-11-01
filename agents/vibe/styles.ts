import {
  GENRE_CATEGORIES,
  PRODUCTION_CATEGORIES,
  MOOD_CATEGORIES,
  VOCAL_CATEGORIES,
  STYLE_CATEGORIES,
  GENRE_TAGS,
  PRODUCTION_TAGS,
  STYLE_TAGS,
  MOOD_TAGS,
  VOCAL_TAGS,
  PROMPT_TAGS,
  MAX_GENRE_TAGS,
  MAX_PRODUCTION_TAGS,
  MAX_MOOD_TAGS,
  MAX_VOCAL_TAGS,
  type TagCategory,
} from '../../options.js';

export const GENRE_TAGS_LIBRARY = GENRE_CATEGORIES;
export const PRODUCTION_TAGS_LIBRARY = PRODUCTION_CATEGORIES;
export const MOOD_TAGS_LIBRARY = MOOD_CATEGORIES;
export const VOCAL_TAGS_LIBRARY = VOCAL_CATEGORIES;
export const STYLE_TAGS_LIBRARY = STYLE_CATEGORIES;

function matchFromList(raw: unknown, allowed: readonly string[], maxCount: number): string[] {
  if (!Array.isArray(raw)) return [];
  const canonicalMap = new Map<string, string>();
  for (const tag of allowed) {
    canonicalMap.set(tag.toLowerCase(), tag);
  }

  const resolved: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().toLowerCase();
    if (!cleaned) continue;
    const exact = canonicalMap.get(cleaned);
    if (exact && !resolved.includes(exact)) {
      resolved.push(exact);
    } else {
      for (const [key, canonical] of canonicalMap.entries()) {
        if ((key.includes(cleaned) || cleaned.includes(key)) && !resolved.includes(canonical)) {
          resolved.push(canonical);
          break;
        }
      }
    }
    if (resolved.length >= maxCount) break;
  }
  return resolved;
}

/**
 * Matches tags while enforcing at most `cat.max` (default 1) tag per segmented category.
 */
function matchSegmentedCategories(
  raw: unknown,
  categories: readonly TagCategory[],
  maxTotal: number
): string[] {
  if (!Array.isArray(raw)) return [];
  const tagToCategory = new Map<string, { canonical: string; categoryId: string; maxPerCat: number }>();
  for (const cat of categories) {
    const maxPerCat = cat.max ?? 1;
    for (const tag of cat.tags) {
      tagToCategory.set(tag.id.toLowerCase(), {
        canonical: tag.id,
        categoryId: cat.id,
        maxPerCat,
      });
    }
  }

  const resolved: string[] = [];
  const countByCat = new Map<string, number>();

  const tryAdd = (entry: { canonical: string; categoryId: string; maxPerCat: number }) => {
    if (resolved.includes(entry.canonical)) return false;
    const currentCatCount = countByCat.get(entry.categoryId) ?? 0;
    if (currentCatCount >= entry.maxPerCat) return false;
    resolved.push(entry.canonical);
    countByCat.set(entry.categoryId, currentCatCount + 1);
    return true;
  };

  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().toLowerCase();
    if (!cleaned) continue;
    const exact = tagToCategory.get(cleaned);
    if (exact) {
      tryAdd(exact);
    } else {
      for (const [key, entry] of tagToCategory.entries()) {
        if (key.includes(cleaned) || cleaned.includes(key)) {
          if (tryAdd(entry)) break;
        }
      }
    }
    if (resolved.length >= maxTotal) break;
  }
  return resolved;
}

/**
 * Normalizes agent-selected Genre & Sub-Genre tags (max 3 total across all 7 genre pillars).
 */
export function normalizeGenres(tags: unknown): string[] {
  return matchFromList(tags, GENRE_TAGS, MAX_GENRE_TAGS);
}

/**
 * Normalizes agent-selected Production & Sound tags (at most 1 per category across Timbre, Production, Mix & Space, Era).
 */
export function normalizeProduction(tags: unknown): string[] {
  return matchSegmentedCategories(tags, PRODUCTION_CATEGORIES, MAX_PRODUCTION_TAGS);
}

/**
 * Normalizes agent-selected Mood & Atmosphere tags (max 3 total across all 6 mood pillars).
 */
export function normalizeMood(tags: unknown): string[] {
  return matchFromList(tags, MOOD_TAGS, MAX_MOOD_TAGS);
}

/**
 * Normalizes agent-selected Vocal Characteristics tags (at most 1 per category across Voice Type, Register & Range, Vocal Timbre, Vocal Delivery).
 */
export function normalizeVocal(tags: unknown): string[] {
  return matchSegmentedCategories(tags, VOCAL_CATEGORIES, MAX_VOCAL_TAGS);
}

/**
 * Normalizes a combined style tags list against canonical PROMPT_TAGS.
 */
export function normalizeStyleTags(tags: unknown): string[] {
  return matchFromList(tags, PROMPT_TAGS, MAX_GENRE_TAGS + MAX_PRODUCTION_TAGS);
}

function formatCategoryBlock(categories: readonly TagCategory[], ruleLabel: string): string {
  const lines: string[] = [ruleLabel];
  for (const cat of categories) {
    const tagList = cat.tags.map((t) => `"${t.id}" (${t.desc})`).join(', ');
    lines.push(`  • ${cat.label} [${cat.id}] — ${cat.desc}: ${tagList}`);
  }
  return lines.join('\n');
}

/**
 * Structured, segmented ACE-Step XL 1.5 Tag Library context for the Songwriter Agent.
 * Includes descriptions for each section and tag so the agent selects each dimension independently.
 */
export function getStylesLibraryContext(): string {
  return [
    '=== STUDIO ACE-STEP XL 1.5 CONDITIONING TAG LIBRARIES ===',
    formatCategoryBlock(
      GENRE_CATEGORIES,
      `1. GENRES & SUB-GENRES (select 1 to ${MAX_GENRE_TAGS} tags total across all genre pillars):`
    ),
    '',
    formatCategoryBlock(
      PRODUCTION_CATEGORIES,
      '2. PRODUCTION & SOUND (segmented into 4 independent sections — select up to 1 tag per section: Timbre, Production, Mix & Space, Era):'
    ),
    '',
    formatCategoryBlock(
      MOOD_CATEGORIES,
      `3. MOOD & ATMOSPHERE (select 1 to ${MAX_MOOD_TAGS} tags total across all mood pillars):`
    ),
    '',
    formatCategoryBlock(
      VOCAL_CATEGORIES,
      '4. VOCAL CHARACTERISTICS (segmented into 4 independent sections — when instrumental=false, select up to 1 tag per section: Voice Type, Register & Range, Vocal Timbre, Vocal Delivery):'
    ),
  ].join('\n');
}

export { STYLE_TAGS };
