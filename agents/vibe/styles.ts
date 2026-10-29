import { PROMPT_TAGS } from '../../options.js';

export const STYLE_TAGS_LIBRARY = PROMPT_TAGS.map((tag) => ({
  id: tag.toUpperCase(),
  label: tag,
}));

/**
 * Normalizes agent-selected style tags against our canonical PROMPT_TAGS library (max 5 tags, uppercase for Studio UI).
 */
export function normalizeStyleTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const canonicalMap = new Map<string, string>();
  for (const tag of PROMPT_TAGS) {
    canonicalMap.set(tag.toLowerCase(), tag.toUpperCase());
  }

  const resolved: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned) continue;
    const exact = canonicalMap.get(cleaned);
    if (exact && !resolved.includes(exact)) {
      resolved.push(exact);
    } else {
      for (const [key, upper] of canonicalMap.entries()) {
        if ((key.includes(cleaned) || cleaned.includes(key)) && !resolved.includes(upper)) {
          resolved.push(upper);
          break;
        }
      }
    }
    if (resolved.length >= 5) break;
  }
  return resolved;
}

/**
 * Compact, token-efficient summary of the Style Tags library for on-demand agent context.
 */
export function getStylesLibraryContext(): string {
  return `Studio Style Tags Library (select 1 to 5 tags that best match the sonic palette): ${PROMPT_TAGS.map((t) => `"${t.toUpperCase()}"`).join(', ')}`;
}
