import { describe, expect, it } from 'vitest';
import {
  parseRoute,
  editorId,
  editorPath,
  marketCreator,
  marketSong,
  marketPath,
  toUrlSlug,
  normalizeSlugKey,
} from '../../../app/src/lib/routes';
import {
  buildShareUrl,
  buildShareDisplayUrl,
  buildShareCopy,
  songToShareData,
} from '../../../app/src/lib/share';

describe('song routes', () => {
  it('identifies a song from its editor path without changing the ID case', () => {
    expect(parseRoute('/editor/sng-AbC')).toBe('editor');
    expect(editorId('/editor/sng-AbC')).toBe('sng-AbC');
    expect(editorPath('sng-AbC')).toBe('/editor/sng-AbC');
  });
  it('round trips encoded song IDs and rejects malformed paths', () => {
    expect(editorId(editorPath('song /?#'))).toBe('song /?#');
    expect(editorId('/editor')).toBeNull();
    expect(editorId('/editor/%ZZ')).toBeNull();
    expect(editorId('/editor/song/extra')).toBeNull();
    expect(editorId('/market')).toBeNull();
  });
  it('keeps the existing main routes', () => {
    expect(parseRoute('/my-page')).toBe('mypage');
    expect(parseRoute('/market')).toBe('market');
    expect(parseRoute('/studio')).toBe('studio');
  });
  it('turns spaces into hyphens in creator and song share URLs and market paths', () => {
    expect(toUrlSlug('DJ Shadow')).toBe('DJ-Shadow');
    expect(toUrlSlug('DJ%20Shadow')).toBe('DJ-Shadow');
    expect(toUrlSlug('  @Acid   Queen  ')).toBe('Acid-Queen');
    expect(marketPath('DJ Shadow')).toBe('/DJ-Shadow');
    expect(marketPath('DJ Shadow', 'Midnight Sun')).toBe('/DJ-Shadow/Midnight-Sun');
    expect(buildShareUrl('DJ Shadow')).toBe('https://app.rawchunks.space/DJ-Shadow');
    expect(buildShareDisplayUrl('DJ Shadow')).toBe('app.rawchunks.space/DJ-Shadow');
    expect(buildShareUrl('DJ Shadow', 'Midnight Sun')).toBe(
      'https://app.rawchunks.space/DJ-Shadow/Midnight-Sun',
    );
    const sharePayload = songToShareData(
      {
        id: 'sng-1',
        title: 'Midnight Sun',
        creator: '0x123',
        audio_url: 'https://example.com/a.mp3',
        duration: 120,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      } as any,
      'DJ Shadow',
    );
    expect(sharePayload.creator).toBe('DJ-Shadow');
    expect(buildShareCopy(sharePayload)).toContain('https://app.rawchunks.space/DJ-Shadow');
  });
  it('normalizes and resolves both hyphenated and percent-encoded creator and song routes', () => {
    expect(normalizeSlugKey('DJ Shadow')).toBe('dj-shadow');
    expect(normalizeSlugKey('DJ-Shadow')).toBe('dj-shadow');
    expect(normalizeSlugKey('DJ%20Shadow')).toBe('dj-shadow');
    expect(parseRoute('/DJ-Shadow')).toBe('market');
    expect(parseRoute('/DJ%20Shadow')).toBe('market');
    expect(parseRoute('/DJ-Shadow/Midnight-Sun')).toBe('market');
    expect(marketCreator('/DJ-Shadow')).toBe('DJ-Shadow');
    expect(marketCreator('/DJ%20Shadow')).toBe('DJ Shadow');
    expect(marketCreator('/DJ-Shadow/Midnight-Sun')).toBe('DJ-Shadow');
    expect(marketSong('/DJ-Shadow/Midnight-Sun')).toBe('Midnight-Sun');
    expect(marketSong('/DJ%20Shadow/Midnight%20Sun')).toBe('Midnight Sun');
  });
});
