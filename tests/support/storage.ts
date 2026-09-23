import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function withStorage<T>(test: (run: (source: string) => Promise<any>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'rawchunks-storage-'));
  try {
    return await test(async source => {
      const { stdout } = await execute(process.execPath, [
        `--localstorage-file=${join(directory, 'storage')}`, '--input-type=module', '--eval', source,
      ]);
      return JSON.parse(stdout);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
