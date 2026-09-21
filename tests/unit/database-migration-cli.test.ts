import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ userSql: vi.fn(), songSql: vi.fn() }));
vi.mock('../../databases/client.js', () => mocks);
const originalEntry = process.argv[1];
beforeEach(() => {
  vi.resetModules(); mocks.userSql.mockReset().mockResolvedValue([]); mocks.songSql.mockReset().mockResolvedValue([]);
  process.argv[1] = fileURLToPath(new URL('../../databases/migrate.ts', import.meta.url));
});
afterEach(() => { process.argv[1] = originalEntry; vi.restoreAllMocks(); });
describe('migration CLI entrypoint with intercepted exit and isolated SQL transports', () => {
  it('exits zero after every migration completes', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    await import('../../databases/migrate.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(mocks.userSql).toHaveBeenCalledTimes(5); expect(mocks.songSql.mock.calls.length).toBeGreaterThan(6);
  });
  it('logs failure and exits one on migration error', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.userSql.mockRejectedValueOnce(new Error('fixture migration failure'));
    await import('../../databases/migrate.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(log).toHaveBeenCalledWith('Migration failed:', expect.objectContaining({ message: 'fixture migration failure' }));
    expect(mocks.songSql).not.toHaveBeenCalled();
  });
});
