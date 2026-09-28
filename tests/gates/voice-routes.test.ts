import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ readSong: vi.fn() }));
vi.mock('../../databases/users.js', async original => ({ ...await original<any>(), ...scope }));
const service = vi.hoisted(() => ({ cloneVoiceFromSong: vi.fn(), cloneVoiceFromAudio: vi.fn(), listVoices: vi.fn(), getVoice: vi.fn() }));
vi.mock('../../broker/valkey.js', () => ({ subscribeVoice: vi.fn(async()=>async()=>{}) }));
vi.mock('../../voice/service.js', () => ({ voiceService: service }));
import voiceRoutes from '../../voice/index.js';
let app: FastifyInstance;
const boundary = 'rawchunks-voice-gate';
const evm = `0x${'a'.repeat(40)}`;
const file = (bytes: Buffer | string, filename: string, mime: string) => Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`), Buffer.from(bytes), Buffer.from('\r\n'),
]);
const creator = (value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="creator"\r\n\r\n${value}\r\n`);
const upload = (parts: Buffer[]) => app.inject({ method: 'POST', url: '/api/voices/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-session-user-address': evm }, payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]) });
beforeEach(async () => {
  for (const fn of Object.values(service)) fn.mockReset();
  const { RequestError } = await import('../../databases/users.js');
  for (const fn of Object.values(scope)) fn.mockReset().mockRejectedValue(new RequestError('userAddress header is required'));
  service.cloneVoiceFromSong.mockResolvedValue({ success: true, voice: { id: 'voice-1' } });
  service.cloneVoiceFromAudio.mockResolvedValue({ success: true, voice: { id: 'voice-1' } });
  service.listVoices.mockResolvedValue([]);
  app = Fastify({ logger: false }); await app.register(multipart, { limits: { fileSize: 64 } }); await app.register(voiceRoutes, { prefix: '/api/voices' }); await app.ready();
});
afterEach(async () => app.close());
describe('voice clone header scope and request validation', () => {
  it('rejects a creator different from the userAddress header', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/voices', headers: { 'x-session-user-address': evm }, payload: { songId: 'victim-song', creator: `0x${'b'.repeat(40)}` } });
    expect(response.statusCode).toBe(403); expect(service.cloneVoiceFromSong).not.toHaveBeenCalled(); expect(scope.readSong).not.toHaveBeenCalled();
  });
  it('rejects an uploaded creator different from the userAddress header before storage', async () => {
    expect((await upload([creator(`0x${'b'.repeat(40)}`), file('RIFF0000WAVEdata', 'voice.wav', 'audio/wav')])).statusCode).toBe(403);
    expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('rejects foreign voice lookup and catalog ownership', async () => {
    service.getVoice.mockResolvedValueOnce({ id: 'foreign', creator: `0x${'b'.repeat(40)}` });
    expect((await app.inject({ url: '/api/voices/foreign', headers: { 'x-session-user-address': evm } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/voices?creator=0x${'b'.repeat(40)}`, headers: { 'x-session-user-address': evm } })).statusCode).toBe(403); expect(service.listVoices).not.toHaveBeenCalled();
  });
  it('uses the stored song creator for vocal isolation', async () => {
    scope.readSong.mockResolvedValueOnce({ song: { id: 'song', creator: evm } });
    const response = await app.inject({ method: 'POST', url: '/api/voices', headers: { 'x-session-user-address': evm }, payload: { songId: 'song', creator: evm } });
    expect(response.statusCode).toBe(202); expect(service.cloneVoiceFromSong).toHaveBeenCalledWith({ songId: 'song', creator: evm, name: undefined });
  });
  it('requires the userAddress header before cloning a supplied song', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/voices', payload: { songId: 'victim-song', creator: evm } });
    expect(response.statusCode).toBe(400); expect(service.cloneVoiceFromSong).not.toHaveBeenCalled();
  });
  it('requires connected creator before persisting uploaded cloned-voice data', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/voices/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([creator(evm), file('RIFF0000WAVEdata', 'voice.wav', 'audio/wav'), Buffer.from(`--${boundary}--\r\n`)]) });
    expect(response.statusCode).toBe(400); expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it.each([{ songId: 7, creator: evm }, { songId: ['victim-song'], creator: evm }, { songId: 'song', creator: 7 }, { songId: ' ', creator: ' ' }, { songId: 'song', creator: 'not-a-wallet' }, { songId: 'song', creator: evm, name: { invalid: true } }])(
    'rejects malformed clone body %j before invoking expensive work', async (payload) => {
      const response = await app.inject({ method: 'POST', url: '/api/voices', payload });
      expect([400, 401, 403, 422]).toContain(response.statusCode); expect(service.cloneVoiceFromSong).not.toHaveBeenCalled();
    },
  );
  it('null cloning body produces a client error instead of a destructuring crash', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/voices', headers: { 'content-type': 'application/json' }, payload: 'null' });
    expect([400, 401, 422]).toContain(response.statusCode);
  });
  it('rejects repeated creator query keys before passing an array to the service', async () => {
    const response = await app.inject(`/api/voices?creator=${evm}&creator=other`);
    expect([400, 401, 422]).toContain(response.statusCode); expect(service.listVoices).not.toHaveBeenCalled();
  });
});
describe('audio payload integrity and multipart errors', () => {
  it.each([
    ['text upload', 'hello', 'voice.txt', 'text/plain'],
    ['empty audio', '', 'voice.wav', 'audio/wav'],
    ['MIME-spoofed nonaudio', 'not-a-wave-file', 'voice.wav', 'audio/wav'],
    ['HTML upload', '<script>fixture()</script>', 'voice.html', 'text/html'],
  ])('rejects %s before storage/model service work', async (_name, bytes, filename, mime) => {
    const response = await upload([creator(evm), file(bytes, filename, mime)]);
    expect([400, 401, 403, 415, 422]).toContain(response.statusCode); expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('rejects absent creator instead of registering an anonymous voice', async () => {
    const response = await upload([file('RIFF0000WAVEdata', 'voice.wav', 'audio/wav')]);
    expect([400, 401, 422]).toContain(response.statusCode); expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('rejects repeated creator fields instead of defaulting the array to anonymous', async () => {
    const response = await upload([creator(evm), creator('attacker'), file('RIFF0000WAVEdata', 'voice.wav', 'audio/wav')]);
    expect([400, 401, 422]).toContain(response.statusCode); expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('returns 413 for a file exceeding the configured byte limit', async () => {
    expect((await upload([creator(evm), file(Buffer.alloc(65), 'voice.wav', 'audio/wav')])).statusCode).toBe(413);
  });
  it('returns 400 for a multipart request missing its boundary', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/voices/upload', headers: { 'content-type': 'multipart/form-data' }, payload: 'invalid' });
    expect(response.statusCode).toBe(400);
  });
  it('does not expose storage/provider internals to clients', async () => {
    service.cloneVoiceFromAudio.mockRejectedValueOnce(new Error('fixture private bucket=voice-private.invalid provider-token-id=secret-fixture'));
    const response = await upload([creator(evm), file('RIFF0000WAVEdata', 'voice.wav', 'audio/wav')]);
    expect(response.statusCode).toBe(500); expect(response.body).not.toMatch(/voice-private|secret-fixture/);
  });
});
