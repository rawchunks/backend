import { broker } from '../support/task-context.js';
vi.mock('../../broker/valkey.js', () => broker);
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../databases/songs.js', () => ({ createSong: vi.fn(), finalizeSong: vi.fn(), updateSong: vi.fn(), getSongById: vi.fn(), countUntitledSongsByCreator: vi.fn().mockResolvedValue(0) }));
vi.mock('../../databases/takes.js', () => ({ createTake: vi.fn(), activateTake: vi.fn(), listTakesBySong: vi.fn(), deleteTake: vi.fn() }));
vi.mock('../../databases/stems.js', () => ({ createStem: vi.fn(), updateStemMixer: vi.fn(), listStemsBySong: vi.fn() }));
vi.mock('../../databases/commits.js', () => ({ createCommit: vi.fn(), listCommitsBySong: vi.fn() }));
vi.mock('../../databases/voices.js', () => ({ getVoiceById: vi.fn() }));
vi.mock('../../storage/r2.js', () => ({ persistAudioToR2: vi.fn() }));
import * as generation from '../../generation/index.js';
import * as editing from '../../editing/index.js';

describe('generation and editing public module entrypoints', () => {
  it('generation barrel exposes its actual client class, helpers, router and service aliases', () => {
    expect(generation.Client).toBeTypeOf('function');
    expect(generation.cleanAudioPath('audio.wav')).toBe('audio.wav');
    expect(generation.client).toBeInstanceOf(generation.Client);
    expect(generation.acestepClient).toBe(generation.client);
    expect(generation.Service).toBeTypeOf('function');
    expect(generation.service).toBeInstanceOf(generation.Service);
    expect(generation.generationService).toBe(generation.service);
    expect(generation.generationRouter).toBeTypeOf('function');
  });
  it('editing barrel exposes its actual class, singleton aliases and router', () => {
    expect(editing.Service).toBeTypeOf('function');
    expect(editing.service).toBeInstanceOf(editing.Service);
    expect(editing.editingService).toBe(editing.service);
    expect(editing.editingRouter).toBeTypeOf('function');
    expect(editing.Service).not.toBe(generation.Service);
    expect(editing.service).not.toBe(generation.service);
  });
});
