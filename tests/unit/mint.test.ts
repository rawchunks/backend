import { describe, expect, it } from 'vitest';
import { mintSong, type Mint, type Registry } from '../../../app/src/lib/mint';
import type { Song } from '../../../app/src/lib/schema';

function registry() {
  let song: Song = { id: 'song', title: 'Song', creator: 'creator', public: false, tags: [], licenses: 10, license_price: 25, stream_price: 0.02, url: 'audio.wav' };
  let progress: Mint | null = null;
  let chain: Mint | null = null;
  let sends = 0;
  let failSave = false;
  let failConfirm = false;
  const calls: string[] = [];
  const api: Registry = {
    load: async () => ({ ...song }),
    save: async updates => {
      calls.push('save');
      if (failSave && updates.chain_song_id) throw new Error('Database unavailable');
      song = { ...song, ...updates };
      return song;
    },
    read: () => progress,
    write: mint => { progress = mint; },
    prepare: async () => ({ network: 'network', cid: 'metadata', after: '0', submitted: false }),
    verify: async (_song, mint) => {
      calls.push('verify');
      if (!chain || mint.id !== chain.id || mint.cid !== chain.cid || mint.network !== chain.network) throw new Error('Mint mismatch');
    },
    find: async () => chain,
    preflight: async () => {},
    send: async (_song, mint) => {
      expect(progress?.submitted).toBe(true);
      sends++;
      chain = { ...mint, hash: 'transaction', id: '1' };
      return { ...mint, hash: 'transaction' };
    },
    confirm: async (_song, mint) => {
      if (failConfirm) throw new Error('Receipt unavailable');
      return { ...mint, id: '1' };
    },
  };
  return { api, calls, get song() { return song; }, get sends() { return sends; }, get progress() { return progress; }, set progress(mint: Mint | null) { progress = mint; }, set chain(mint: Mint | null) { chain = mint; }, set failSave(value: boolean) { failSave = value; }, set failConfirm(value: boolean) { failConfirm = value; } };
}

describe('mint reuse', () => {
  it('mints once across repeated release and download requests', async () => {
    const state = registry();
    for (let request = 0; request < 3; request++) {
      expect((await mintSong(state.api)).chain_song_id).toBe('1');
    }
    expect(state.sends).toBe(1);
    expect(state.progress).toBeNull();
    expect(state.song.public).toBe(false);
  });

  it('retains a confirmed mint when saving fails and retries only persistence', async () => {
    const state = registry();
    state.failSave = true;
    await expect(mintSong(state.api)).rejects.toThrow('Database unavailable');
    expect(state.progress?.id).toBe('1');
    state.failSave = false;
    expect((await mintSong(state.api)).chain_song_id).toBe('1');
    expect(state.sends).toBe(1);
  });

  it('retains the transaction hash when receipt retrieval fails', async () => {
    const state = registry();
    state.failConfirm = true;
    await expect(mintSong(state.api)).rejects.toThrow('Receipt unavailable');
    expect(state.progress?.hash).toBe('transaction');
    state.failConfirm = false;
    await mintSong(state.api);
    expect(state.sends).toBe(1);
  });

  it('recovers a successful mint when its transaction response was lost', async () => {
    const state = registry();
    state.progress = { network: 'network', cid: 'metadata', after: '0', submitted: true };
    state.chain = { ...state.progress, id: '1', hash: 'transaction' };
    expect((await mintSong(state.api)).chain_song_id).toBe('1');
    expect(state.sends).toBe(0);
  });

  it('blocks another submission while the previous outcome is unknown', async () => {
    const state = registry();
    state.progress = { network: 'network', cid: 'metadata', after: '0', submitted: true };
    await expect(mintSong(state.api)).rejects.toThrow('awaiting confirmation');
    expect(state.sends).toBe(0);
  });

  it('does not remint an invalid saved chain link', async () => {
    const state = registry();
    await mintSong(state.api);
    state.chain = { network: 'different-network', cid: 'metadata', after: '0', submitted: true, id: '1' };
    await expect(mintSong(state.api)).rejects.toThrow('Mint mismatch');
    expect(state.sends).toBe(1);
  });

  it('verifies the saved mint before attempting any further persistence', async () => {
    const state = registry();
    await mintSong(state.api);
    state.calls.length = 0;
    await mintSong(state.api);
    expect(state.calls).toEqual(['verify']);
  });
});
