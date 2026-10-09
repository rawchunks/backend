import { describe, it, expect } from 'vitest';
import {
  parseLyricsToBlocks,
  serializeBlocksToLyrics,
  ensureTagBrackets,
  getTagCategory,
  getTagDescription,
  STRUCTURED_TAGS,
} from '../../../app/src/lib/lyrics.js';

describe('lyrics parser and serialization', () => {
  it('enforces squared brackets on all tags', () => {
    expect(ensureTagBrackets('Intro')).toBe('[Intro]');
    expect(ensureTagBrackets('[Intro]')).toBe('[Intro]');
    expect(ensureTagBrackets('  whispered  ')).toBe('[whispered]');
    expect(ensureTagBrackets('')).toBe('');
  });

  it('correctly categorizes all required tags', () => {
    expect(getTagCategory('[Intro]')).toBe('structure');
    expect(getTagCategory('[Verse 1]')).toBe('structure');
    expect(getTagCategory('[Drop]')).toBe('intensity');
    expect(getTagCategory('[Guitar Solo]')).toBe('solo');
    expect(getTagCategory('[whispered]')).toBe('vocal');
    expect(getTagCategory('[raspy vocal]')).toBe('vocal');
    expect(getTagCategory('[unknown]')).toBe('custom');
  });

  it('returns valid descriptions for tags', () => {
    expect(getTagDescription('[Intro]')).toContain('Establishes the opening atmosphere');
    expect(getTagDescription('[Drop]')).toContain('release of built-up energy');
    expect(getTagDescription('[whispered]')).toContain('soft, breathy');
  });

  it('parses multi-section bracketed lyrics into structured blocks', () => {
    const raw = `[Intro]
Low drone oscillating

[Verse 1]
[whispered]
Walking through the neon rain
Digital shadows call my name

[Drop]
[building energy]
System overload!

[Outro]
Fading into static`;

    const blocks = parseLyricsToBlocks(raw);
    expect(blocks.length).toBe(4);

    expect(blocks[0].tags).toEqual(['[Intro]']);
    expect(blocks[0].text).toBe('Low drone oscillating');

    expect(blocks[1].tags).toEqual(['[Verse 1]', '[whispered]']);
    expect(blocks[1].text).toBe('Walking through the neon rain\nDigital shadows call my name');

    expect(blocks[2].tags).toEqual(['[Drop]', '[building energy]']);
    expect(blocks[2].text).toBe('System overload!');

    expect(blocks[3].tags).toEqual(['[Outro]']);
    expect(blocks[3].text).toBe('Fading into static');
  });

  it('serializes blocks back to canonical AceStep bracketed format', () => {
    const blocks = [
      { id: '1', tags: ['[Intro]'], text: 'Atmosphere humming' },
      { id: '2', tags: ['[Verse 1]', '[whispered]'], text: 'Line 1\nLine 2' },
      { id: '3', tags: ['[Guitar Solo]'], text: '' },
      { id: '4', tags: ['[Chorus]'], text: 'Hook melody' },
    ];

    const serialized = serializeBlocksToLyrics(blocks);
    expect(serialized).toBe(`[Intro]
Atmosphere humming

[Verse 1]
[whispered]
Line 1
Line 2

[Guitar Solo]

[Chorus]
Hook melody`);
  });

  it('preserves repeated, mixed-case and custom directives in their supplied order', () => {
    const lyrics = '[Verse 1]\n[whispered]\n[whispered]\n[custom direction]\nLine one\nLine two\n\n[Chorus]\n[building energy]\nThe hook';
    expect(serializeBlocksToLyrics(parseLyricsToBlocks(lyrics))).toBe(lyrics);
  });

  it('preserves untouched raw formatting when opening and applying the canvas', () => {
    const raw = '  [Verse 1] [whispered]\r\nA line  \r\n\r\n\r\n[Chorus]\r\nThe hook\r\n';
    const blocks = parseLyricsToBlocks(raw);
    expect(serializeBlocksToLyrics(blocks, raw)).toBe(raw);
    blocks[0].text = 'An edited line';
    expect(serializeBlocksToLyrics(blocks, raw)).toBe('[Verse 1]\n[whispered]\nAn edited line\n\n[Chorus]\nThe hook');
  });

  it.each(STRUCTURED_TAGS)('round trips $token without changing its directive', ({ token }) => {
    const lyrics = `${token}\nSing this line`;
    expect(serializeBlocksToLyrics(parseLyricsToBlocks(lyrics))).toBe(lyrics);
  });

  it('parses JSON format from future external lyrics generation model', () => {
    const json = JSON.stringify([
      { tags: ['[Intro]'], text: 'Synth intro' },
      { tags: ['[Verse 1]', '[raspy vocal]'], text: 'Gritty delivery' },
    ]);

    const blocks = parseLyricsToBlocks(json);
    expect(blocks.length).toBe(2);
    expect(blocks[0].tags).toEqual(['[Intro]']);
    expect(blocks[1].tags).toEqual(['[Verse 1]', '[raspy vocal]']);
    expect(blocks[1].text).toBe('Gritty delivery');
  });

  it('covers the available directive categories', () => {
    const tokens = STRUCTURED_TAGS.map((t) => t.token);

    // 1. Structure
    expect(tokens).toContain('[Intro]');
    expect(tokens).toContain('[Verse]');
    expect(tokens).toContain('[Verse 1]');
    expect(tokens).toContain('[Verse 2]');
    expect(tokens).toContain('[Pre-Chorus]');
    expect(tokens).toContain('[Chorus]');
    expect(tokens).toContain('[Bridge]');
    expect(tokens).toContain('[Outro]');
    expect(tokens).toContain('[End]');

    // 2. Intensity
    expect(tokens).toContain('[Build]');
    expect(tokens).toContain('[Drop]');
    expect(tokens).toContain('[Breakdown]');
    expect(tokens).toContain('[Silence]');

    // 3. Solo (Instrumental)
    expect(tokens).toContain('[Instrumental]');
    expect(tokens).toContain('[inst]');
    expect(tokens).toContain('[Guitar Solo]');
    expect(tokens).toContain('[Piano Interlude]');
    expect(tokens).toContain('[Drum Break]');

    // 4. Vocal Style
    expect(tokens).toContain('[whispered]');
    expect(tokens).toContain('[raspy vocal]');
    expect(tokens).toContain('[building energy]');
  });
});
