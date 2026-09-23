import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getWalletPair: vi.fn(), putWalletPair: vi.fn(), getUserConsent: vi.fn(), putUserConsent: vi.fn(), checkUserConsent: vi.fn(),
  getSongById: vi.fn(), listSongsByCreator: vi.fn(), listAllSongs: vi.fn(), getFullSongProject: vi.fn(), updateSong: vi.fn(), deleteSong: vi.fn(),
  listStemsBySong: vi.fn(), listTakesBySong: vi.fn(), deleteTake: vi.fn(),
}));
vi.mock('../../databases/users.js', async original => ({ ...await original<any>(), ...mocks, readTake: async () => ({ song: { id: 'song-1' } }) }));
vi.mock('../../databases/songs.js', () => mocks);
vi.mock('../../databases/stems.js', () => mocks);
vi.mock('../../databases/takes.js', () => mocks);
import { databaseRouter } from '../../databases/router.js';
const evm = `0x${'a'.repeat(40)}`;
const svm = 'So11111111111111111111111111111111111111112';
let app: FastifyInstance;
beforeEach(async () => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.putWalletPair.mockResolvedValue({ evmAddress: evm, svmAddress: svm });
  mocks.getWalletPair.mockResolvedValue({ evmAddress: evm, svmAddress: svm });
  mocks.getUserConsent.mockResolvedValue(null);
  mocks.putUserConsent.mockResolvedValue({ evmAddress: evm, signature: 'fixture' });
  mocks.listSongsByCreator.mockResolvedValue([]); mocks.listAllSongs.mockResolvedValue([]);
  mocks.getSongById.mockImplementation(async id => ({ id, creator: evm, public: true }));
  mocks.getFullSongProject.mockResolvedValue({ song: { id: 'song-1' }, stems: [], takes: [] });
  mocks.updateSong.mockResolvedValue({ id: 'song-1' }); mocks.deleteSong.mockResolvedValue(true);
  mocks.listStemsBySong.mockResolvedValue([]); mocks.listTakesBySong.mockResolvedValue([]); mocks.deleteTake.mockResolvedValue(true);
  app = Fastify({ logger: false }); app.addHook('onRequest', async request => { request.headers['x-session-user-address'] ??= evm; }); await app.register(databaseRouter, { prefix: '/api' }); await app.ready();
});
afterEach(async () => app.close());

describe('wallet and consent HTTP routes', () => {
  it('registers a wallet pair and strips undeclared fields', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/user', payload: { evmAddress: evm, svmAddress: svm, admin: true } });
    expect(response.statusCode).toBe(200); expect(mocks.putWalletPair).toHaveBeenCalledWith({ evmAddress: evm, svmAddress: svm });
  });
  it.each([{}, { evmAddress: evm }, { evmAddress: '', svmAddress: svm }, { evmAddress: 1, svmAddress: svm }, null, []])('rejects malformed wallet-pair body %j before DB writes', async (payload) => {
    const response = await app.inject({ method: 'PUT', url: '/api/user', payload: payload as any });
    expect(response.statusCode).toBe(400); expect(mocks.putWalletPair).not.toHaveBeenCalled();
  });
  it('returns a server error for wallet-pair transport failure', async () => {
    mocks.putWalletPair.mockRejectedValueOnce(new Error('fixture unique conflict'));
    const response = await app.inject({ method: 'PUT', url: '/api/user', payload: { evmAddress: evm, svmAddress: svm } });
    expect(response.statusCode).toBe(500); expect(response.json().error).toBe('Failed to register wallet pair');
  });
  it('uses a wallet-pair write fallback message for errors without message', async () => {
    mocks.putWalletPair.mockRejectedValueOnce({});
    const response = await app.inject({ method: 'PUT', url: '/api/user', payload: { evmAddress: evm, svmAddress: svm } });
    expect(response.json()).toEqual({ error: 'Failed to register wallet pair' });
  });
  it('looks up URL-decoded wallet addresses', async () => {
    const response = await app.inject(`/api/user/${encodeURIComponent(svm)}`);
    expect(response.statusCode).toBe(200); expect(mocks.getWalletPair).toHaveBeenCalledWith(svm);
  });
  it('returns 404 for missing pair', async () => {
    mocks.getWalletPair.mockResolvedValueOnce(null);
    expect((await app.inject(`/api/user/${evm}`)).statusCode).toBe(404);
  });
  it('returns 400 for lookup validation/transport failure', async () => {
    mocks.getWalletPair.mockRejectedValueOnce(new Error('fixture invalid address'));
    expect((await app.inject('/api/user/bad')).statusCode).toBe(400);
  });
  it('uses lookup fallback message for errors without message', async () => {
    mocks.getWalletPair.mockRejectedValueOnce({});
    expect((await app.inject(`/api/user/${evm}`)).json()).toEqual({ error: 'Failed to lookup wallet pair' });
  });
  it('returns consent status and nullable chain addresses', async () => {
    const response = await app.inject(`/api/user/consent/${evm}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ consented: false, evmAddress: null, svmAddress: null, record: null });
  });
  it('returns an existing consent record', async () => {
    mocks.getUserConsent.mockResolvedValueOnce({ evmAddress: evm, svmAddress: svm, signature: 'fixture' });
    const response = await app.inject(`/api/user/consent/${evm}?version=1.0.0&type=generation`);
    expect(response.json()).toMatchObject({ consented: true, evmAddress: evm, svmAddress: svm });
    expect(mocks.getUserConsent).toHaveBeenCalledWith({ address: evm, policyVersion: '1.0.0', disclaimerType: 'generation' });
  });
  it('returns 500 if consent checker itself throws', async () => {
    mocks.getUserConsent.mockRejectedValueOnce(new Error('fixture unavailable'));
    expect((await app.inject(`/api/user/consent/${evm}`)).statusCode).toBe(500);
  });
  it('uses consent-check fallback message for errors without message', async () => {
    mocks.getUserConsent.mockRejectedValueOnce({});
    expect((await app.inject(`/api/user/consent/${evm}`)).json()).toEqual({ error: 'Failed to check consent' });
  });
  it.each(['POST', 'PUT'] as const)('records consent through %s with defaults and recognized optional fields', async (method) => {
    const response = await app.inject({ method, url: '/api/user/consent', payload: { evmAddress: evm, svmAddress: svm, signature: 'fixture', message: 'terms', metadata: { nonce: 'fixture' }, disclaimerType: 'generation', ignored: true } });
    expect(response.statusCode).toBe(200);
    expect(mocks.putUserConsent).toHaveBeenCalledWith({ address: evm, svmAddress: svm, signature: 'fixture', message: 'terms', metadata: { nonce: 'fixture' }, disclaimerType: 'generation', policyVersion: '1.0.0', chainId: undefined });
  });
  it.each([{ address: evm }, { evmAddress: evm }, { svmAddress: svm }])('chooses the supported consent address alias %j', async (address) => {
    const response = await app.inject({ method: 'POST', url: '/api/user/consent', headers: { 'x-session-user-address': address.address ?? address.evmAddress ?? address.svmAddress! }, payload: { ...address, signature: 'fixture' } });
    expect(response.statusCode).toBe(200);
    expect(mocks.putUserConsent.mock.calls[0][0].address).toBe(address.address ?? address.evmAddress ?? address.svmAddress);
  });
  it('prefers explicit address when multiple aliases are supplied', async () => {
    await app.inject({ method: 'POST', url: '/api/user/consent', headers: { 'x-session-user-address': svm }, payload: { address: svm, evmAddress: evm, signature: 'fixture' } });
    expect(mocks.putUserConsent.mock.calls[0][0].address).toBe(svm);
  });
  it.each([{}, { signature: 'fixture' }, { address: evm, signature: '' }, { address: evm, signature: 1 }, { address: evm, signature: 'fixture', metadata: [] }, { address: '', signature: 'fixture' }])('rejects malformed consent body %j before write', async (payload) => {
    expect((await app.inject({ method: 'POST', url: '/api/user/consent', payload })).statusCode).toBe(400);
    expect(mocks.putUserConsent).not.toHaveBeenCalled();
  });
  it('returns 500 for consent transport errors', async () => {
    mocks.putUserConsent.mockRejectedValueOnce(new Error('fixture wallet not paired'));
    expect((await app.inject({ method: 'PUT', url: '/api/user/consent', payload: { address: evm, signature: 'fixture' } })).statusCode).toBe(500);
  });
  it('uses consent-write fallback message for errors without message', async () => {
    mocks.putUserConsent.mockRejectedValueOnce({});
    const response = await app.inject({ method: 'POST', url: '/api/user/consent', payload: { address: evm, signature: 'fixture' } });
    expect(response.json()).toEqual({ error: 'Failed to record consent' });
  });
  it('rejects malformed JSON in Fastify before route execution', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/user/consent', headers: { 'content-type': 'application/json' }, payload: '{"address":' });
    expect(response.statusCode).toBe(400); expect(mocks.putUserConsent).not.toHaveBeenCalled();
  });
});

describe('song/project/take HTTP route coverage', () => {
  it('lists default songs when creator is absent', async () => {
    expect((await app.inject('/api/songs')).json()).toEqual([]);
    expect(mocks.listAllSongs).toHaveBeenCalledWith(); expect(mocks.listSongsByCreator).not.toHaveBeenCalled();
  });
  it('passes creator filter without altering case', async () => {
    await app.inject({ url: `/api/songs?creator=${svm}`, headers: { 'x-session-user-address': svm } });
    expect(mocks.listSongsByCreator).toHaveBeenCalledWith(svm); expect(mocks.listAllSongs).not.toHaveBeenCalled();
  });
  it('treats empty creator query as the default listing', async () => {
    await app.inject('/api/songs?creator='); expect(mocks.listAllSongs).toHaveBeenCalledOnce();
  });
  it('honors pagination on creator catalogs without adding an implicit bound', async () => {
    await app.inject({ url: `/api/songs?creator=${svm}&limit=5&offset=10`, headers: { 'x-session-user-address': svm } });
    expect(mocks.listSongsByCreator).toHaveBeenCalledWith(svm, 5, 10);
  });
  it.each(['limit=-1', 'limit=0', 'limit=1.5', 'limit=Infinity', 'offset=-1', 'limit=5&limit=6', 'offset=1.5'])('rejects malformed pagination %s before listing', async query => {
    expect((await app.inject(`/api/songs?${query}`)).statusCode).toBe(400);
    expect(mocks.listAllSongs).not.toHaveBeenCalled();
  });
  it.each(['/api/songs/song-1', '/api/songs/song-1/takes/take-2', '/api/takes/take-2'])('reports an absent deleted row at %s', async url => {
    mocks.deleteSong.mockResolvedValue(false); mocks.deleteTake.mockResolvedValue(false);
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(404);
  });
  it('gets a project including child stems and takes', async () => {
    expect((await app.inject('/api/songs/song-1')).json()).toEqual({ song: { id: 'song-1' }, stems: [], takes: [] });
    expect(mocks.getFullSongProject).toHaveBeenCalledWith('song-1');
  });
  it('returns 404 for a missing song project', async () => {
    mocks.getFullSongProject.mockResolvedValueOnce({ song: null, stems: [], takes: [] });
    expect((await app.inject('/api/songs/missing')).statusCode).toBe(404);
  });
  it.each([['/api/songs/song-1/stems', 'listStemsBySong'], ['/api/songs/song-1/takes', 'listTakesBySong']] as const)('lists children at %s', async (url, fn) => {
    expect((await app.inject(url)).json()).toEqual([]); expect(mocks[fn]).toHaveBeenCalledWith('song-1');
  });
  it('patches the requested song with the current raw body', async () => {
    const changes = { title: 'Updated', tags: ['fixture'] };
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/song-1', payload: changes })).statusCode).toBe(200);
    expect(mocks.updateSong).toHaveBeenCalledWith('song-1', changes);
  });
  it('returns 404 when patch returns no matching song', async () => {
    mocks.updateSong.mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/missing', payload: { title: 'x' } })).statusCode).toBe(404);
  });
  it.each([
    ['/api/songs/song-1', 'deleteSong', 'song-1'],
    ['/api/songs/song-1/takes/take-2', 'deleteTake', 'take-2'],
    ['/api/takes/take-2', 'deleteTake', 'take-2'],
  ] as const)('deletes through %s and returns its ID', async (url, fn, id) => {
    const response = await app.inject({ method: 'DELETE', url });
    expect(response.json()).toEqual({ success: true, id }); expect(mocks[fn]).toHaveBeenCalledWith(...(fn === 'deleteTake' ? [id, 'song-1'] : [id]));
  });
  it.each([
    ['GET', '/api/songs', 'listAllSongs', undefined],
    ['GET', `/api/songs?creator=${evm}`, 'listSongsByCreator', undefined],
    ['GET', '/api/songs/song-1', 'getFullSongProject', undefined],
    ['GET', '/api/songs/song-1/stems', 'listStemsBySong', undefined],
    ['GET', '/api/songs/song-1/takes', 'listTakesBySong', undefined],
    ['PATCH', '/api/songs/song-1', 'updateSong', { title: 'fixture' }],
    ['DELETE', '/api/songs/song-1', 'deleteSong', undefined],
    ['DELETE', '/api/songs/song-1/takes/take-2', 'deleteTake', undefined],
    ['DELETE', '/api/takes/take-2', 'deleteTake', undefined],
  ] as const)('maps service error for %s %s to 500', async (method, url, fn, payload) => {
    mocks[fn].mockRejectedValueOnce(new Error('fixture internal transport'));
    const response = await app.inject({ method, url, payload });
    expect(response.statusCode).toBe(500); expect(response.json().error).toMatch(/^Failed to /); expect(response.body).not.toContain('fixture internal transport');
  });
  it('handles simultaneous distinct child/list requests without sharing route parameters', async () => {
    const ids = Array.from({ length: 64 }, (_, i) => `song-${i}`);
    const responses = await Promise.all(ids.map((id) => app.inject(`/api/songs/${id}/takes`)));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(mocks.listTakesBySong.mock.calls.map(([id]) => id).sort()).toEqual(ids.sort());
  });
});
