import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

const data = vi.hoisted(() => ({ songSql: vi.fn(), userSql: vi.fn(), getSongById: vi.fn() }));
vi.mock('../../databases/client.js', () => ({ songSql: data.songSql, userSql: data.userSql }));
vi.mock('../../databases/songs.js', () => ({ getSongById: data.getSongById }));
import { readUser, checkUser, readSong, readTake } from '../../databases/users.js';

const evm = `0x${'ab'.repeat(20)}`;
const svm = 'So11111111111111111111111111111111111111112';
const request = (headers = {}) => ({ headers }) as FastifyRequest;
const header = (value: unknown) => request({ 'x-session-user-address': value });
beforeEach(() => {
  vi.clearAllMocks();
  data.songSql.mockResolvedValue([]);
  data.userSql.mockReset().mockResolvedValue([]);
  data.getSongById.mockResolvedValue(null);
});

describe('SDK userAddress header', () => {
  it('normalizes EVM case without querying a database', () => {
    expect(readUser(header(evm.toUpperCase().replace('0X', '0x')))).toBe(evm);
    expect(data.songSql).not.toHaveBeenCalled();
  });
  it('accepts the SDK Solana prefix and preserves address case', () => {
    expect(readUser(header(`svm:${svm}`))).toBe(svm);
  });
  it.each([undefined, '', 'invalid', [evm], `${evm},${evm}`])('rejects missing or malformed address %j', value => {
    expect(() => readUser(header(value))).toThrow();
  });
  it('uses the selected userAddress when unrelated headers are present', () => {
    expect(readUser(request({ 'x-session-user-address': evm, 'x-network-id': 'eip155:8453', 'x-account-address': 'invalid' }))).toBe(evm);
  });
  it('requires the canonical SDK header', () => {
    expect(() => readUser(request({ 'x-account-address': evm }))).toThrow('userAddress header is required');
  });
  it('compares normalized resource addresses', () => {
    expect(() => checkUser(evm, evm.toUpperCase().replace('0X', '0x'))).not.toThrow();
    expect(() => checkUser(svm, `svm:${svm}`)).not.toThrow();
    expect(() => checkUser(evm, svm)).toThrow('does not match');
  });
  it('rejects an invalid resource address as a request error', () => {
    expect(() => checkUser(evm, 'invalid')).toThrow('Invalid userAddress');
  });
});

describe('song and take scope', () => {
  it('returns the song and one userAddress string', async () => {
    data.getSongById.mockResolvedValue({ id: 'song', creator: evm });
    expect(await readSong(header(evm), 'song')).toEqual({ userAddress: evm, song: { id: 'song', creator: evm } });
    expect(data.userSql).not.toHaveBeenCalled();
  });
  it.each([[evm, svm], [svm, evm]])('allows the stored paired wallet %s to edit a song created by %s', async (userAddress, creator) => {
    data.userSql.mockResolvedValueOnce([{ evm_address: evm, svm_address: svm }]);
    data.getSongById.mockResolvedValueOnce({ id: 'song', creator });
    expect(await readSong(header(userAddress), 'song')).toEqual({ userAddress, song: { id: 'song', creator } });
  });
  it('rejects a creator outside the stored wallet pair', async () => {
    data.userSql.mockResolvedValueOnce([{ evm_address: evm, svm_address: svm }]);
    data.getSongById.mockResolvedValueOnce({ id: 'song', creator: `0x${'cd'.repeat(20)}` });
    await expect(readSong(header(evm), 'song')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('propagates a pairing database outage', async () => {
    data.userSql.mockRejectedValueOnce(new Error('Pairing unavailable'));
    data.getSongById.mockResolvedValueOnce({ id: 'song', creator: svm });
    await expect(readSong(header(evm), 'song')).rejects.toThrow('Pairing unavailable');
  });
  it('rejects a different creator', async () => {
    data.getSongById.mockResolvedValue({ id: 'song', creator: evm });
    await expect(readSong(header(`0x${'cd'.repeat(20)}`), 'song')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('reports a missing song', async () => {
    await expect(readSong(header(evm), 'missing')).rejects.toMatchObject({ statusCode: 404 });
  });
  it('checks the header before querying a song', async () => {
    await expect(readSong(request(), 'song')).rejects.toMatchObject({ statusCode: 400 });
    expect(data.getSongById).not.toHaveBeenCalled();
  });
  it('rejects a take from another parent before querying its song', async () => {
    data.songSql.mockResolvedValue([{ song_id: 'other' }]);
    await expect(readTake(header(evm), 'take', 'song')).rejects.toMatchObject({ statusCode: 404 });
    expect(data.getSongById).not.toHaveBeenCalled();
  });
  it('reports a missing take', async () => {
    await expect(readTake(header(evm), 'missing')).rejects.toMatchObject({ statusCode: 404 });
  });
  it('checks the stored parent creator for an existing take', async () => {
    data.songSql.mockResolvedValue([{ song_id: 'song' }]);
    data.getSongById.mockResolvedValue({ id: 'song', creator: evm });
    expect(await readTake(header(evm), 'take', 'song')).toMatchObject({ userAddress: evm, song: { id: 'song' } });
    expect(data.songSql.mock.calls[0].slice(1)).toEqual(['take']);
  });
});
