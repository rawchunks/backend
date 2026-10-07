vi.mock('../../databases/users.js', async original => ({ ...await original<any>(), readUser: () => `0x${'ab'.repeat(20)}` }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const provider = vi.hoisted(() => ({ upload: vi.fn(), create: vi.fn() }));
vi.mock('../../storage/r2.js', () => ({ uploadToR2: provider.upload, persistAudioToR2: vi.fn() }));
vi.mock('../../databases/voices.js', () => ({ createVoiceDeduplicated: provider.create, getVoiceById: vi.fn(), findVoiceByHash: vi.fn(async()=>null), listAdaptersByGroup: vi.fn(async()=>[]), listVoicesByCreator: vi.fn(), updateVoice: vi.fn() }));
vi.mock('../../broker/valkey.js', () => ({ withJobLock: async (_:string,run:any)=>run(async()=>{}), publishVoice:async()=>{}, subscribeVoice: async()=>async()=>{} }));
vi.mock('../../databases/songs.js', () => ({ getSongById: vi.fn() }));
vi.mock('../../generation/client.js', () => ({ client: { releaseTask: vi.fn(), queryResult: vi.fn() } }));
vi.mock('../../editing/service.js',()=>({sourceSettings:vi.fn()}));
import voiceRoutes from '../../voice/index.js';

const directory = new URL('../fixtures/samples/', import.meta.url);
const samples = readdirSync(directory).filter(file => file.endsWith('.mp3')).sort().map(file => ({ file, bytes: readFileSync(new URL(file, directory)) }));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const creator = `0x${'aB'.repeat(20)}`;
let app: FastifyInstance;
beforeEach(async () => {
  provider.upload.mockReset().mockImplementation(async (_bucket, key) => `https://versions.invalid/${key}`);
  provider.create.mockReset().mockImplementation(async row => row);
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(voiceRoutes, { prefix: '/api/voices' });
  await app.ready();
});
afterEach(async () => { await app.close(); });
function upload(sample: typeof samples[number], fieldsAfterFile = false) {
  const boundary = `sample-${digest(sample.bytes).slice(0, 24)}`;
  const fields = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="creator"\r\n\r\n${creator}\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${sample.file}\r\n`);
  const file = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${sample.file}"\r\nContent-Type: audio/mpeg\r\n\r\n`), sample.bytes, Buffer.from('\r\n')]);
  return app.inject({ method: 'POST', url: '/api/voices/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([...(fieldsAfterFile ? [file, fields] : [fields, file]), Buffer.from(`--${boundary}--\r\n`)]) });
}
describe('MP3 uploads through Fastify and VoiceService', () => {
  it('contains eight distinct sample binaries under the production upload limit', () => {
    expect(samples.length).toBe(8);
    expect(new Set(samples.map(sample => digest(sample.bytes))).size).toBe(8);
    for (const sample of samples) expect(sample.bytes.length).toBeLessThan(50 * 1024 * 1024);
  });
  it.each(samples.map(sample => [sample.file, sample] as const))('preserves full bytes and registration for %s', async (_file, sample) => {
    const response = await upload(sample);
    expect(response.statusCode).toBe(202);
    const [bucket, key, binary, type] = provider.upload.mock.calls[0];
    expect(bucket).toBe('versions');
    expect(key).toMatch(/^uploads\/voi-.+\.mp3$/);
    expect(digest(binary)).toBe(digest(sample.bytes));
    expect(type).toBe('audio/mpeg');
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ creator: creator.toLowerCase(), name: sample.file, sample_url: expect.stringContaining(key), status: 'saved', hash: digest(sample.bytes) }));
  });
  it('keeps all eight complete payloads separate during concurrent multipart parsing and registration', async () => {
    const responses = await Promise.all(samples.map(sample => upload(sample, true)));
    expect(responses.every(response => response.statusCode === 202)).toBe(true);
    expect(provider.upload.mock.calls.map(call => digest(call[2])).sort()).toEqual(samples.map(sample => digest(sample.bytes)).sort());
    expect(provider.create.mock.calls.map(call => call[0].name).sort()).toEqual(samples.map(sample => sample.file).sort());
    expect(new Set(responses.map(response => response.json().voice.id)).size).toBe(8);
  });
  it('does not register cloned voice data when the full sample upload fails', async () => {
    provider.upload.mockRejectedValueOnce(new Error('test upload outage'));
    const response = await upload(samples[0]);
    expect(response.statusCode).toBe(500);
    expect(provider.create).not.toHaveBeenCalled();
  });
});
