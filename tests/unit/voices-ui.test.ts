import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isVoice, readVoices, writeVoices } from '../../../app/src/lib/cache';
import type { Voice } from '../../../app/src/lib/schema';
import { voiceAvailability, voiceReady, voiceStatus, voiceUpdate } from '../../../app/src/hooks/use-voices';

vi.mock('../../../app/src/lib/sdk', () => ({ sdk: { fetch: vi.fn() }, watch: vi.fn() }));

const evm = `0x${'a'.repeat(40)}`;
const other = `0x${'b'.repeat(40)}`;
const solana = 'So11111111111111111111111111111111111111112';

function voice(creator = evm): Voice {
  return {
    id: 'voice-1', name: 'My voice', creator, created_at: '2026-10-10T10:00:00Z',
    sample_url: 'https://fixture.invalid/sample.wav', status: 'training',
    availability: {
      turbo: { model: 'acestep-v15-xl-turbo', status: 'ready', adapter: { id: 'adapter-fast', model: 'acestep-v15-xl-turbo', status: 'ready' } },
      sft: { model: 'acestep-v15-xl-sft', status: 'training', step: 3, total_steps: 20, adapter: { id: 'adapter-master', model: 'acestep-v15-xl-sft', status: 'training' } },
    },
  };
}

describe('account-scoped voices cache', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads the current account immediately without sharing entries with another account', () => {
    writeVoices([voice()], evm);
    expect(readVoices(evm)).toEqual([voice()]);
    expect(readVoices(other)).toBeNull();
  });

  it('matches EVM case while preserving case-sensitive Solana identities', () => {
    writeVoices([voice()], evm.toUpperCase());
    expect(readVoices(evm)).toEqual([voice()]);
    writeVoices([voice(solana)], solana);
    expect(readVoices(solana)).toEqual([voice(solana)]);
    expect(readVoices(solana.toLowerCase())).toBeNull();
    expect(isVoice(voice(solana), solana.toLowerCase())).toBe(false);
  });

  it('rejects a mixed-owner collection and prevents writing foreign voices', () => {
    storage.set(`voices:${evm}`, JSON.stringify([voice(), voice(other)]));
    expect(readVoices(evm)).toBeNull();
    writeVoices([voice(other)], evm);
    expect(storage.get(`voices:${evm}`)).toEqual(JSON.stringify([voice(), voice(other)]));
  });

  it.each([
    { ...voice(), status: 'complete' },
    { ...voice(), sample_url: 9 },
    { ...voice(), availability: undefined },
    { ...voice(), availability: { ...voice().availability, turbo: { model: 'acestep-v15-xl-sft', status: 'ready' } } },
    { ...voice(), availability: { ...voice().availability, sft: { model: 'acestep-v15-xl-sft', status: 'training', step: '3' } } },
  ])('rejects malformed voice metadata %j', invalid => {
    storage.set(`voices:${evm}`, JSON.stringify([invalid]));
    expect(readVoices(evm)).toBeNull();
  });

  it('preserves pending voices and confirmed empty lists as different cache results', () => {
    writeVoices([voice()], evm);
    expect(readVoices(evm)?.[0].availability.sft).toMatchObject({ status: 'training', step: 3, total_steps: 20 });
    writeVoices([], evm);
    expect(readVoices(evm)).toEqual([]);
    storage.set(`voices:${evm}`, 'not json');
    expect(readVoices(evm)).toBeNull();
  });

  it('retains distinct source conditioning and readiness for voices sharing one canonical sample', () => {
    const canonical = { ...voice(), metadata: { source: 'upload' } };
    const source: Voice = {
      ...voice(), id: 'source-variant', canonical_id: canonical.id, name: 'Source variant',
      metadata: { lyrics: '[Verse]\r\nExact words', bpm: 100, keyscale: 'C major' },
      availability: {
        turbo: { model: 'acestep-v15-xl-turbo', status: 'queued' },
        sft: { model: 'acestep-v15-xl-sft', status: 'queued' },
      },
    };
    writeVoices([canonical, source], evm);
    const cached = readVoices(evm)!;
    expect(cached.map(v => v.id)).toEqual([canonical.id, source.id]);
    expect(cached[1].metadata).toEqual(source.metadata);
    expect(cached[1].sample_url).toBe(cached[0].sample_url);
    expect(voiceReady(cached[0], 'turbo')).toBe(true);
    expect(voiceReady(cached[1], 'turbo')).toBe(false);
    expect(voiceUpdate({ voice: cached[1] }, evm, source.id)).toEqual(cached[1]);
    expect(() => voiceUpdate({ voice: cached[0] }, evm, source.id)).toThrow('Invalid voice update');
  });
});

describe('saved voice output availability', () => {
  it('ignores stream heartbeats while retaining real errors and validating updates', () => {
    expect(voiceUpdate({}, evm, 'voice-1')).toBeNull();
    expect(voiceUpdate({ voice: voice(), status: 'training' }, evm, 'voice-1')).toEqual(voice());
    expect(() => voiceUpdate({ status: 'error', error: 'Voice lookup failed' }, evm, 'voice-1')).toThrow('Voice lookup failed');
    expect(() => voiceUpdate({ voice: voice(other) }, evm, 'voice-1')).toThrow('Invalid voice update');
  });
  it('permits Fast independently while Master is preparing', () => {
    const saved = voice();
    expect(voiceReady(saved, 'turbo')).toBe(true);
    expect(voiceReady(saved, 'sft')).toBe(false);
    expect(voiceAvailability(saved, 'turbo')).toBe('Ready');
    expect(voiceAvailability(saved, 'sft')).toBe('Preparing');
    expect(voiceStatus(saved)).toBe('Preparing');
  });

  it('requires a ready adapter for the exact chosen output', () => {
    const saved = voice();
    saved.availability.turbo.adapter!.model = 'acestep-v15-xl-sft';
    expect(voiceReady(saved, 'turbo')).toBe(false);
    expect(voiceAvailability(saved, 'turbo')).not.toBe('Ready');
    saved.availability.turbo.adapter = undefined;
    expect(voiceReady(saved, 'turbo')).toBe(false);
  });

  it('retains actual errors and reports saved registration before preparation completes', () => {
    const saved = voice();
    saved.status = 'saved';
    expect(voiceStatus(saved)).toBe('Saved');
    saved.availability.sft.status = 'error';
    saved.availability.sft.error = 'Preparation interrupted';
    expect(voiceAvailability(saved, 'sft')).toBe('Error');
    expect(saved.availability.sft.error).toBe('Preparation interrupted');
    expect(voiceReady(saved, 'sft')).toBe(false);
  });
});
