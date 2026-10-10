import { describe, expect, it } from 'vitest';
import { cachedAddress } from '../../../app/src/lib/cache.js';
import type { Project } from '../../../app/src/lib/cache.js';
import { withStorage } from '../support/storage.js';

const account = { address: '0x123', svmAddress: 'swig123', network: 'ethereum', updatedAt: 1 };

describe('cached wallet display', () => {
  it.each(['unknown', 'connecting'])('retains the address while the wallet is %s', status => {
    expect(cachedAddress(account, 'ethereum', true, status)).toBe('0x123');
  });
  it('does not restore a disconnected wallet or an address from another network', () => {
    expect(cachedAddress(account, 'ethereum', true, 'disconnected')).toBeNull();
    expect(cachedAddress(account, 'polygon', true, 'connecting')).toBeNull();
  });
  it('keeps the Solana address separate from the EVM address', () => {
    expect(cachedAddress({ ...account, network: 'solana' }, 'solana', false, 'connecting')).toBe('swig123');
  });
});

describe('project cache', () => {
  const project = { song: { id: 'song', title: 'Session', creator: '0x123', url: 'master.wav' }, stems: [], takes: [], commits: [] } as unknown as Project;
  const module = new URL('../../../app/src/lib/cache.ts', import.meta.url).href;
  it('restores saved project data for the same address and song across reloads', async () => {
    await withStorage(async run => {
      await run(`import {writeProject} from ${JSON.stringify(module)}; writeProject(${JSON.stringify(project)}, '0x123'); console.log('null');`);
      const result = await run(`import {readProject} from ${JSON.stringify(module)}; console.log(JSON.stringify([readProject('song','0x123'),readProject('other','0x123'),readProject('song','0x456')]));`);
      expect(result).toEqual([project, null, null]);
    });
  });
  it('does not conflate case-sensitive Solana addresses', async () => {
    await withStorage(async run => {
      const result = await run(`import {writeProject,readProject} from ${JSON.stringify(module)}; writeProject(${JSON.stringify(project)}, 'SwigA'); console.log(JSON.stringify(readProject('song', 'swiga')));`);
      expect(result).toBeNull();
    });
  });
  it('restores the collection for the same wallet across reloads', async () => {
    await withStorage(async run => {
      await run(`import {writeSongs} from ${JSON.stringify(module)}; writeSongs([${JSON.stringify(project.song)}], '0x123'); console.log('null');`);
      const result = await run(`import {readSongs} from ${JSON.stringify(module)}; console.log(JSON.stringify([readSongs('0x123'),readSongs('0x456')]));`);
      expect(result).toEqual([[project.song], null]);
    });
  });
  it('restores the public catalogue independently of personal collections', async () => {
    await withStorage(async run => {
      const publicSong = { ...project.song, id: 'public', public: true };
      await run(`import {writeSongs} from ${JSON.stringify(module)}; writeSongs([${JSON.stringify(project.song)}], '0x123'); writeSongs([${JSON.stringify(publicSong)}]); console.log('null');`);
      const result = await run(`import {readSongs} from ${JSON.stringify(module)}; console.log(JSON.stringify([readSongs(),readSongs('0x123'),readSongs('0x456')]));`);
      expect(result).toEqual([[publicSong], [project.song], null]);
    });
  });
});
