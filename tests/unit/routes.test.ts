import { describe, expect, it } from 'vitest';
import { parseRoute, editorId, editorPath } from '../../../app/src/lib/routes';

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
});
