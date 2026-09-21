import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ neon: vi.fn(), drizzle: vi.fn(), config: vi.fn() }));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));
vi.mock('drizzle-orm/neon-http', () => ({ drizzle: mocks.drizzle }));
vi.mock('dotenv', () => ({ config: mocks.config }));
beforeEach(() => {
  vi.resetModules(); mocks.neon.mockReset().mockImplementation((url) => ({ url }));
  mocks.drizzle.mockReset().mockImplementation((sql, options) => ({ sql, ...options })); mocks.config.mockReset();
  vi.stubEnv('USER_DATABASE_URL', 'postgresql://fixture:fake@user.db.invalid/users');
  vi.stubEnv('SONG_DATABASE_URL', 'postgresql://fixture:fake@song.db.invalid/songs');
});
afterEach(() => vi.unstubAllEnvs());
describe('database client bootstrap without network or real credentials', () => {
  it('creates separate transports and databases', async () => {
    const client = await import('../../databases/client.js');
    expect(client.userDb).not.toBe(client.songDb); expect(client.userSql).not.toBe(client.songSql);
    expect(mocks.neon).toHaveBeenCalledTimes(2); expect(mocks.drizzle).toHaveBeenCalledTimes(2);
    expect(mocks.config).toHaveBeenCalledWith({ path: expect.stringMatching(/\/\.env$/) });
  });
  it.each(['USER_DATABASE_URL', 'SONG_DATABASE_URL'])('rejects missing %s before creating a network transport', async (name) => {
    vi.stubEnv(name, '');
    await expect(import('../../databases/client.js')).rejects.toThrow(`${name} environment variable is missing.`);
    expect(mocks.neon).not.toHaveBeenCalled();
  });
  it('trims surrounding whitespace and quotes from database URLs', async () => {
    vi.stubEnv('USER_DATABASE_URL', '  "postgresql://fixture:fake@user.db.invalid/users"  ');
    vi.stubEnv('SONG_DATABASE_URL', " 'postgresql://fixture:fake@song.db.invalid/songs' ");
    await import('../../databases/client.js');
    expect(mocks.neon.mock.calls.map(([url]) => url)).toEqual(['postgresql://fixture:fake@user.db.invalid/users', 'postgresql://fixture:fake@song.db.invalid/songs']);
  });
  it('registers the expected user and song relational schemas', async () => {
    await import('../../databases/client.js');
    expect(Object.keys(mocks.drizzle.mock.calls[0][1].schema)).toEqual(expect.arrayContaining(['walletPairs', 'users']));
    expect(Object.keys(mocks.drizzle.mock.calls[1][1].schema)).toEqual(expect.arrayContaining(['songs', 'stems', 'takes', 'commits']));
  });
  it('propagates malformed driver bootstrap errors', async () => {
    mocks.neon.mockImplementationOnce(() => { throw new Error('invalid fixture connection URL'); });
    await expect(import('../../databases/client.js')).rejects.toThrow('invalid fixture connection URL');
  });
});
