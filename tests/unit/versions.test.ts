import { describe, expect, it } from 'vitest';
import { groupSongs } from '../../../app/src/lib/versions';
import type { Song } from '../../../app/src/lib/schema';

const song: Song = { id: 'original', title: 'Song', creator: 'creator', public: true, url: 'audio.wav', tags: [], licenses: 10, license_price: 25, stream_price: .02 };

describe('song versions', () => {
  it('groups standalone versions with their original without changing catalogue order', () => {
    const second = { ...song, id: 'second', family: song.id, version: 2 }, remix = { ...song, id: 'remix', source: song.id }, third = { ...second, id: 'third', version: 3 };
    const input = [third, remix, song, second];
    expect(groupSongs(input)).toEqual([[song, second, third], [remix]]);
    expect(input).toEqual([third, remix, song, second]);
  });
  it('groups remix versions together without grouping them with the licensed source', () => {
    const remix = { ...song, id: 'remix', source: song.id }, version = { ...remix, id: 'remix-version', family: remix.id, version: 2 };
    expect(groupSongs([song, version, remix])).toEqual([[song], [remix, version]]);
  });
  it('retains only the supplied versions, including a public version whose original is private', () => {
    const version = { ...song, id: 'public-version', family: 'private-original', version: 4 };
    expect(groupSongs([version])).toEqual([[version]]);
    expect(groupSongs([])).toEqual([]);
  });
});
