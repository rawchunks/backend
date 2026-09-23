import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ readTake: vi.fn() }));
const mocks = vi.hoisted(() => ({
  getWalletPair: vi.fn(), putWalletPair: vi.fn(), getUserConsent: vi.fn(), putUserConsent: vi.fn(), checkUserConsent: vi.fn(),
  getSongById: vi.fn(), createSong: vi.fn(), copySong: vi.fn(), listSongsByCreator: vi.fn(), listAllSongs: vi.fn(), getFullSongProject: vi.fn(), updateSong: vi.fn(), deleteSong: vi.fn(),
  listStemsBySong: vi.fn(), listTakesBySong: vi.fn(), deleteTake: vi.fn(),
}));
vi.mock('../../databases/users.js', async importOriginal => ({ ...await importOriginal<any>(), ...mocks, readTake: scope.readTake }));
vi.mock('../../databases/songs.js', () => mocks);
vi.mock('../../databases/stems.js', () => mocks);
vi.mock('../../databases/takes.js', () => mocks);
import { databaseRouter } from '../../databases/router.js';
const evm = `0x${'a'.repeat(40)}`;
const svm = 'So11111111111111111111111111111111111111112';
let app: FastifyInstance;
beforeEach(async () => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  const { RequestError } = await import('../../databases/users.js');
  scope.readTake.mockReset().mockRejectedValue(new RequestError('userAddress header is required'));
  mocks.putWalletPair.mockResolvedValue({ evmAddress: evm, svmAddress: svm }); mocks.putUserConsent.mockResolvedValue({ evmAddress: evm });
  mocks.updateSong.mockResolvedValue({ id: 'victim-song', creator: 'victim' }); mocks.deleteSong.mockResolvedValue(true); mocks.deleteTake.mockResolvedValue(true);
  mocks.getUserConsent.mockResolvedValue(null);
  mocks.getSongById.mockImplementation(async id => ({ id, creator: evm, public: false }));
  mocks.listAllSongs.mockResolvedValue([]); mocks.listSongsByCreator.mockResolvedValue([]);
  app = Fastify({ logger: false }); await app.register(databaseRouter, { prefix: '/api' }); await app.ready();
});
afterEach(async () => app.close());
describe('userAddress header and resource scope', () => {
  it.each(['/api/songs/song/takes/take', '/api/takes/take'])('rejects deleting a take from a pinned song at %s', async url => {
    scope.readTake.mockResolvedValueOnce({ song: { id: 'song', metadata_cid: 'metadata' } });
    const response = await app.inject({ method: 'DELETE', url });
    expect(response.statusCode).toBe(409);
    expect(mocks.deleteTake).not.toHaveBeenCalled();
  });
  it('creates a private remix without mint linkage from a public source', async () => {
    const source = { id: 'source', public: true, creator: svm, title: 'Song', url: 'audio.wav', chain_song_id: '1', network: 'network', licenses: 10, license_price: 25, stream_price: 0.02, tags: [], duration: 60 };
    mocks.getSongById.mockResolvedValueOnce(source);
    mocks.createSong.mockImplementationOnce(async song => ({ ...song, public: false }));
    const response = await app.inject({ method: 'POST', url: '/api/songs/source/remix', headers: { 'x-session-user-address': evm } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ source: 'source', creator: evm, public: false, url: 'audio.wav', licenses: 0, license_price: 0 });
    expect(response.json().chain_song_id).toBeUndefined();
    expect(response.json().tx_hash).toBeUndefined();
  });
  it('rejects a minted public remix as a source before creating another song', async () => {
    mocks.getSongById.mockResolvedValueOnce({ id: 'remix', public: true, creator: svm, source: 'original', chain_song_id: '2', network: 'network', url: 'audio.wav' });
    const response = await app.inject({ method: 'POST', url: '/api/songs/remix/remix', headers: { 'x-session-user-address': evm } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Remixes cannot be remixed' });
    expect(mocks.createSong).not.toHaveBeenCalled();
  });
  it('rejects remix creation without a userAddress or minted source', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/songs/source/remix' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/songs/source/remix', headers: { 'x-session-user-address': evm } })).statusCode).toBe(409);
    expect(mocks.createSong).not.toHaveBeenCalled();
  });
  it('serves the public catalogue without wallet headers or creator lookups', async () => {
    const songs = [{ id: 'public-a', creator: evm, public: true }, { id: 'public-b', creator: svm, public: true }];
    mocks.listAllSongs.mockResolvedValueOnce(songs);
    const response = await app.inject('/api/songs');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(songs);
    expect(mocks.listAllSongs).toHaveBeenCalledWith();
    expect(mocks.listSongsByCreator).not.toHaveBeenCalled();
    expect(mocks.getWalletPair).not.toHaveBeenCalled();
  });
  it('rejects a wallet pair that does not match the userAddress header', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/user', headers: { 'x-session-user-address': evm }, payload: { evmAddress: `0x${'b'.repeat(40)}`, svmAddress: svm } })).statusCode).toBe(403);
    expect(mocks.putWalletPair).not.toHaveBeenCalled();
  });
  it('rejects creator catalog requests without matching userAddress header', async () => {
    expect((await app.inject(`/api/songs?creator=${evm}`)).statusCode).toBe(400); expect(mocks.listSongsByCreator).not.toHaveBeenCalled();
    expect((await app.inject({ url: `/api/songs?creator=${evm}`, headers: { 'x-session-user-address': `0x${'b'.repeat(40)}` } })).statusCode).toBe(403); expect(mocks.listSongsByCreator).not.toHaveBeenCalled();
  });
  it.each(['/api/songs/private', '/api/songs/private/stems', '/api/songs/private/takes'])('hides private project data at %s before querying children', async url => {
    mocks.getSongById.mockResolvedValueOnce({ id: 'private', creator: evm, public: false });
    expect((await app.inject(url)).statusCode).toBe(400); expect(mocks.getFullSongProject).not.toHaveBeenCalled(); expect(mocks.listStemsBySong).not.toHaveBeenCalled(); expect(mocks.listTakesBySong).not.toHaveBeenCalled();
  });
  it.each([
    ['PUT', '/api/user', { evmAddress: evm, svmAddress: svm }, 'putWalletPair'],
    ['POST', '/api/user/consent', { address: evm, signature: 'fixture', message: 'terms' }, 'putUserConsent'],
    ['PUT', '/api/user/consent', { address: evm, signature: 'fixture', message: 'terms' }, 'putUserConsent'],
    ['PATCH', '/api/songs/victim-song', { title: 'Attacker rename' }, 'updateSong'],
    ['DELETE', '/api/songs/victim-song', undefined, 'deleteSong'],
    ['DELETE', '/api/songs/victim-song/takes/victim-take', undefined, 'deleteTake'],
    ['DELETE', '/api/takes/victim-take', undefined, 'deleteTake'],
  ] as const)('rejects missing userAddress header %s %s before persistent mutation', async (method, url, payload, fn) => {
    const response = await app.inject({ method, url, payload });
    expect(response.statusCode).toBe(400); expect(mocks[fn]).not.toHaveBeenCalled();
  });
  it('nested take deletion passes the parent song as part of its ownership scope', async () => {
    scope.readTake.mockResolvedValueOnce({ song: { id: 'song-a' } });
    await app.inject({ method: 'DELETE', url: '/api/songs/song-a/takes/take-in-song-b' });
    expect(scope.readTake).toHaveBeenCalledWith(expect.anything(), 'take-in-song-b', 'song-a');
    expect(mocks.deleteTake).toHaveBeenCalledWith('take-in-song-b', 'song-a');
  });
});
describe('HTTP validation, query semantics and diagnostic hygiene', () => {
  it.each([
    { creator: 'attacker' }, { id: 'replacement-id' }, { created_at: '2000-01-01T00:00:00Z' },
    { license_price: -1 }, { stream_price: -1 }, { duration: -1 }, { licenses: -1 }, { version: 0 },
    { tags: 'invalid-array' }, { title: '' }, { unknownColumn: 'fixture' }, {}, ['invalid-array'],
  ])('rejects unsafe song patch %j before update', async (payload) => {
    const response = await app.inject({ method: 'PATCH', url: '/api/songs/victim-song', headers: { 'x-session-user-address': evm }, payload });
    expect(response.statusCode).toBe(400); expect(mocks.updateSong).not.toHaveBeenCalled();
  });
  it('applies requested consent version to the returned consent decision', async () => {
    const response = await app.inject(`/api/user/consent/${evm}?version=2.0.0`);
    expect(response.json().consented).toBe(false); expect(mocks.getUserConsent).toHaveBeenCalledWith(expect.objectContaining({ policyVersion: '2.0.0' }));
  });
  it('applies requested disclaimer type to the returned consent decision', async () => {
    const response = await app.inject(`/api/user/consent/${evm}?type=voice-cloning`);
    expect(response.json().consented).toBe(false); expect(mocks.getUserConsent).toHaveBeenCalledWith(expect.objectContaining({ disclaimerType: 'voice-cloning' }));
  });
  it('validates malformed creator addresses before database listing', async () => {
    const response = await app.inject('/api/songs?creator=not-a-wallet');
    expect(response.statusCode).toBe(400); expect(mocks.listSongsByCreator).not.toHaveBeenCalled();
  });
  it('honors requested pagination instead of silently returning the default page', async () => {
    await app.inject('/api/songs?limit=5&offset=10');
    expect(mocks.listAllSongs).toHaveBeenCalledWith(5, 10);
  });
  it('does not expose driver internals to song-list clients', async () => {
    mocks.listAllSongs.mockRejectedValueOnce(new Error('fixture database host=db.internal.invalid table=private_songs constraint=secret_fixture'));
    const response = await app.inject('/api/songs');
    expect(response.statusCode).toBe(500); expect(response.body).not.toMatch(/db\.internal|private_songs|secret_fixture/);
  });
  it('maps duplicate wallet pair constraint failures to conflict status', async () => {
    mocks.putWalletPair.mockRejectedValueOnce(Object.assign(new Error('fixture unique constraint'), { code: '23505' }));
    const response = await app.inject({ method: 'PUT', url: '/api/user', headers: { 'x-session-user-address': evm }, payload: { evmAddress: evm, svmAddress: svm } });
    expect(response.statusCode).toBe(409);
  });
});
