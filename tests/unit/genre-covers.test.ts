import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  songDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../databases/client.js', () => ({
  songDb: mocks.songDb,
}));

vi.mock('../../databases/cache.js', () => ({
  cacheDel: mocks.cacheDel,
}));

import {
  ensureGenreCovers,
  extractGenreLabels,
  normalizeGenreSlug,
  STATIC_GENRE_COVERS,
  __resetGenreCoverMemoryForTests,
} from '../../databases/genres.js';
import { partitionSongTags } from '../../options.js';

describe('Genre Cover Art Pipeline', () => {
  beforeEach(() => {
    __resetGenreCoverMemoryForTests();
    mocks.cacheDel.mockClear();
    mocks.songDb.select.mockReset().mockReturnValue({
      from: () => ({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    mocks.songDb.insert.mockReset().mockReturnValue({
      values: () => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      }),
    });
    mocks.songDb.update.mockReset().mockReturnValue({
      set: () => ({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
  });

  it('normalizes genre labels into canonical slugs and pairs static covers directly', async () => {
    expect(normalizeGenreSlug('Acid Techno')).toBe('acid-techno');
    expect(normalizeGenreSlug('#genre:Rock')).toBe('rock');
    expect(STATIC_GENRE_COVERS['rock']).toBe('/genres/rock.jpeg');

    const generateFn = vi.fn();
    const covers = await ensureGenreCovers(['Acid Techno', 'Rock'], { generateFn });

    expect(covers['acid-techno']).toEqual({
      slug: 'acid-techno',
      label: 'Acid Techno',
      imageUrl: '/genres/acid-techno.jpeg',
      status: 'ready',
    });
    expect(covers['rock']).toEqual({
      slug: 'rock',
      label: 'Rock',
      imageUrl: '/genres/rock.jpeg',
      status: 'ready',
    });
    expect(generateFn).not.toHaveBeenCalled();
  });

  it('prompts the cover-art agent with prompt=genre and title=genre non-blockingly for unseen genres', async () => {
    let resolveGeneration!: (url: string) => void;
    const generateFn = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveGeneration = resolve;
        }),
    );

    // 1. Initial call returns pending immediately without blocking
    const initial = await ensureGenreCovers(['Dark Synthwave'], { generateFn });
    expect(initial['dark-synthwave']).toEqual({
      slug: 'dark-synthwave',
      label: 'Dark Synthwave',
      imageUrl: null,
      status: 'pending',
    });
    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(generateFn).toHaveBeenCalledWith({
      prompt: 'Dark Synthwave',
      title: 'Dark Synthwave',
    });

    // 2. Concurrent poll while still generating does not duplicate agent invocation
    const whileGenerating = await ensureGenreCovers(['Dark Synthwave'], { generateFn });
    expect(whileGenerating['dark-synthwave'].status).toBe('pending');
    expect(generateFn).toHaveBeenCalledTimes(1);

    // 3. Once the agent resolves, subsequent poll returns ready + persisted R2 URL
    resolveGeneration('https://pub-62c17ba4ea004db3bee5152452c65d61.r2.dev/covers/dark-synthwave.png');
    await new Promise((r) => setTimeout(r, 15));

    const afterReady = await ensureGenreCovers(['Dark Synthwave'], { generateFn });
    expect(afterReady['dark-synthwave']).toEqual({
      slug: 'dark-synthwave',
      label: 'Dark Synthwave',
      imageUrl: 'https://pub-62c17ba4ea004db3bee5152452c65d61.r2.dev/covers/dark-synthwave.png',
      status: 'ready',
    });
    expect(mocks.cacheDel).toHaveBeenCalled();
  });

  it('partitions mixed legacy tags into genres, production, mood, and vocal on the backend', () => {
    const partitioned = partitionSongTags({
      tags: ['Acid Techno', 'Raw', 'Live Room Recording', 'Wide Stereo', 'Retro 80s Synths', 'Wistful', 'Baritone', 'ALT MIX', 'Cyberpunk Industrial'],
    });

    expect(partitioned.genres).toEqual(['Acid Techno', 'Cyberpunk Industrial']);
    expect(partitioned.production).toEqual(['Raw', 'Live Room Recording', 'Wide Stereo', 'Retro 80s Synths']);
    expect(partitioned.mood).toEqual(['Wistful']);
    expect(partitioned.vocal).toEqual(['Baritone']);
    expect(extractGenreLabels(['Acid Techno', 'Raw', 'Live Room Recording', 'Wide Stereo', 'Retro 80s Synths', 'Wistful', 'Cyberpunk Industrial'])).toEqual([
      { slug: 'acid-techno', label: 'Acid Techno' },
      { slug: 'cyberpunk-industrial', label: 'Cyberpunk Industrial' },
    ]);
  });
});
