import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const service = vi.hoisted(() => ({ cloneVoiceFromSong: vi.fn(), cloneVoiceFromAudio: vi.fn(), listVoices: vi.fn(), getVoice: vi.fn() }));
vi.mock('../../broker/valkey.js', () => ({ subscribeVoice: vi.fn(async()=>async()=>{}) }));
vi.mock('../../voice/service.js', () => ({ voiceService: service }));
vi.mock('../../databases/users.js', async original => ({ ...await original<any>(), readSong: vi.fn(async () => ({ song: { id: 'song-1', creator: `0x${'a'.repeat(40)}` } })) }));
import voiceRoutes from '../../voice/index.js';
let app: FastifyInstance;
const boundary = 'rawchunks-voice-fixture';
const filePart = (bytes: Buffer | string = 'RIFF0000WAVEdata', filename = 'voice.wav', mime = 'audio/wav') => Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`), Buffer.from(bytes), Buffer.from('\r\n'),
]);
const fieldPart = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
const upload = (parts: Buffer[]) => app.inject({ method: 'POST', url: '/api/voices/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]) });
beforeEach(async () => {
  for (const fn of Object.values(service)) fn.mockReset();
  service.cloneVoiceFromSong.mockResolvedValue({ success: true, voice: { id: 'voice-1' } });
  service.cloneVoiceFromAudio.mockResolvedValue({ success: true, voice: { id: 'voice-1' } });
  service.listVoices.mockResolvedValue([{ id: 'voice-1' }]); service.getVoice.mockResolvedValue({ id: 'voice-1', creator: `0x${'a'.repeat(40)}` });
  app = Fastify({ logger: false }); app.addHook('onRequest', async request => { request.headers['x-session-user-address'] ??= new URL(request.url, 'http://localhost').searchParams.get('creator') ?? `0x${'a'.repeat(40)}`; }); await app.register(multipart, { limits: { fileSize: 64 } });
  await app.register(voiceRoutes, { prefix: '/api/voices' }); await app.register(voiceRoutes, { prefix: '/voices' }); await app.ready();
});
afterEach(async () => app.close());
describe('voice router JSON and retrieval endpoints', () => {
  it.each(['/api/voices', '/voices'])('clones a supplied song through %s', async (url) => {
    const payload = { songId: 'song-1', creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Fixture' };
    const response = await app.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(202); expect(response.json()).toEqual({ success: true, voice: { id: 'voice-1' } });
    expect(service.cloneVoiceFromSong).toHaveBeenCalledWith(payload);
  });
  it.each([{}, { songId: 'song-1' }, { creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { songId: '', creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { songId: 'song-1', creator: '' }])('rejects missing required cloning fields %j', async (payload) => {
    expect((await app.inject({ method: 'POST', url: '/api/voices', payload })).statusCode).toBe(400);
    expect(service.cloneVoiceFromSong).not.toHaveBeenCalled();
  });
  it('returns a generic error when the clone service fails', async () => {
    service.cloneVoiceFromSong.mockRejectedValueOnce(new Error('fixture model failure'));
    const response = await app.inject({ method: 'POST', url: '/api/voices', payload: { songId: 'song-1', creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    expect(response.statusCode).toBe(500); expect(response.json()).toEqual({ error: 'Failed to clone voice from song' });
  });
  it('uses the cloning fallback error text when the thrown object has no message', async () => {
    service.cloneVoiceFromSong.mockRejectedValueOnce({});
    const response = await app.inject({ method: 'POST', url: '/api/voices', payload: { songId: 'song-1', creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    expect(response.json()).toEqual({ error: 'Failed to clone voice from song' });
  });
  it('rejects malformed JSON before service execution', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/voices', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(response.statusCode).toBe(400); expect(service.cloneVoiceFromSong).not.toHaveBeenCalled();
  });
  it('lists voices for supplied creator', async () => {
    expect((await app.inject('/api/voices?creator=So11111111111111111111111111111111111111112')).json()).toEqual({ voices: [{ id: 'voice-1' }] });
    expect(service.listVoices).toHaveBeenCalledWith('So11111111111111111111111111111111111111112');
  });
  it.each(['/api/voices', '/api/voices?creator='])('requires a nonempty creator for listing %s', async (url) => {
    expect((await app.inject(url)).statusCode).toBe(400); expect(service.listVoices).not.toHaveBeenCalled();
  });
  it('returns a saved voice by decoded ID', async () => {
    expect((await app.inject('/api/voices/voice%3A1')).statusCode).toBe(200);
    expect(service.getVoice).toHaveBeenCalledWith('voice:1');
  });
  it('streams durable terminal voice state without percentages', async () => {
    service.getVoice.mockResolvedValue({ id: 'voice-1', creator: `0x${'a'.repeat(40)}`, status: 'ready', availability: { turbo: { status: 'ready' }, sft: { status: 'ready' } } });
    const response = await app.inject('/api/voices/voice-1/events');
    expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(JSON.parse(response.body.trim())).toMatchObject({ status: 'ready', voice: { id: 'voice-1' } });
    expect(response.body).not.toContain('progress');
  });
  it('enforces event ownership before subscribing to voice state', async () => {
    service.getVoice.mockResolvedValue({ id: 'foreign', creator: `0x${'b'.repeat(40)}`, status: 'training' });
    expect((await app.inject('/api/voices/foreign/events')).statusCode).toBe(403);
  });
  it('returns 404 when voice is missing', async () => {
    service.getVoice.mockResolvedValueOnce(null); expect((await app.inject('/api/voices/missing')).statusCode).toBe(404);
  });
  it.each([['/api/voices?creator=So11111111111111111111111111111111111111112', 'listVoices'], ['/api/voices/id', 'getVoice']] as const)('returns 500 when retrieval fails at %s', async (url, fn) => {
    service[fn].mockRejectedValueOnce(new Error('fixture unavailable')); expect((await app.inject(url)).statusCode).toBe(500);
  });
  it.each([['/api/voices?creator=So11111111111111111111111111111111111111112', 'listVoices'], ['/api/voices/id', 'getVoice']] as const)('uses retrieval fallback error text at %s', async (url, fn) => {
    service[fn].mockRejectedValueOnce({});
    expect((await app.inject(url)).json()).toEqual({ error: 'Failed to retrieve voice' + (fn === 'listVoices' ? 's' : '') });
  });
});
describe('voice multipart uploads through the actual parser', () => {
  it('passes uploaded bytes, filename, MIME, creator and name to the service', async () => {
    const response = await upload([fieldPart('creator', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), fieldPart('name', 'Fixture Name'), filePart()]);
    expect(response.statusCode).toBe(202);
    expect(service.cloneVoiceFromAudio).toHaveBeenCalledWith({ audioBuffer: Buffer.from('RIFF0000WAVEdata'), fileName: 'voice.wav', mimeType: 'audio/wav', creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Fixture Name' });
  });
  it('reads creator/name fields that appear after the file once the stream is consumed', async () => {
    const response = await upload([filePart(), fieldPart('creator', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), fieldPart('name', 'Later Name')]);
    expect(response.statusCode).toBe(202);
    expect(service.cloneVoiceFromAudio.mock.calls[0][0]).toMatchObject({ creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Later Name' });
  });
  it('waits for trailing metadata delivered in a separate network chunk', async () => {
    const payload = Readable.from((async function* () {
      yield filePart();
      yield Buffer.from(`--${boundary}\r\n`);
      await new Promise(resolve => setTimeout(resolve, 30));
      yield Buffer.from(`Content-Disposition: form-data; name="creator"\r\n\r\n0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n`);
      yield fieldPart('name', 'Streamed voice');
      yield Buffer.from(`--${boundary}--\r\n`);
    })());
    const response = await app.inject({ method: 'POST', url: '/api/voices/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(response.statusCode).toBe(202);
    expect(service.cloneVoiceFromAudio).toHaveBeenCalledWith(expect.objectContaining({ creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Streamed voice' }));
  });
  it('rejects missing upload creator', async () => {
    expect((await upload([filePart()])).statusCode).toBe(400);
    expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('rejects multiple files before registering a voice', async () => {
    const response = await upload([fieldPart('creator', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), filePart(), filePart()]);
    expect(response.statusCode).toBe(400);
    expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('rejects a multipart body containing fields but no file', async () => {
    expect((await upload([fieldPart('creator', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')])).statusCode).toBe(400); expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('returns 413 for the configured file-size violation', async () => {
    const response = await upload([filePart(Buffer.alloc(65))]);
    expect(response.statusCode).toBe(413); expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('does not call cloning service for an invalid multipart boundary', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/voices/upload', headers: { 'content-type': 'multipart/form-data' }, payload: 'invalid' });
    expect(response.statusCode).toBe(400); expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('does not call cloning service for a truncated multipart file', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/voices/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: filePart() });
    expect(response.statusCode).toBe(400); expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('reports service errors after consuming an upload', async () => {
    service.cloneVoiceFromAudio.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    const response = await upload([fieldPart('creator', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), filePart()]); expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Failed to process voice upload' });
  });
  it('uses the upload fallback error text when no message exists', async () => {
    service.cloneVoiceFromAudio.mockRejectedValueOnce({});
    expect((await upload([fieldPart('creator', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), filePart()])).json()).toEqual({ error: 'Failed to process voice upload' });
  });
  it('rejects browser default text MIME when the file omits Content-Type', async () => {
    const part = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="voice.wav"\r\n\r\nRIFF0000WAVEdata\r\n`);
    expect((await upload([fieldPart('creator', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), part])).statusCode).toBe(400);
    expect(service.cloneVoiceFromAudio).not.toHaveBeenCalled();
  });
  it('keeps bytes separate across simultaneous uploads', async () => {
    const payloads = Array.from({ length: 32 }, (_, i) => Buffer.from(`RIFF0000WAVEfixture-${i}`));
    const responses = await Promise.all(payloads.map((bytes) => upload([fieldPart('creator', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), filePart(bytes)])));
    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    expect(service.cloneVoiceFromAudio.mock.calls.map(([params]) => params.audioBuffer.toString()).sort()).toEqual(payloads.map((bytes) => bytes.toString()).sort());
  });
});
