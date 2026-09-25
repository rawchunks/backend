import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ subscribeTask: vi.fn(), initiateGeneration: vi.fn(), checkStatusAndFinalize: vi.fn(), formatInput: vi.fn(), createSample: vi.fn(), uploadToR2: vi.fn() }));
vi.mock('../../broker/valkey.js', () => ({ subscribeTask: m.subscribeTask }));
vi.mock('../../generation/service.js', () => ({ generationService: { initiateGeneration: m.initiateGeneration, checkStatusAndFinalize: m.checkStatusAndFinalize } }));
vi.mock('../../generation/client.js', () => ({ acestepClient: { formatInput: m.formatInput, createSample: m.createSample } }));
vi.mock('../../storage/r2.js', () => ({ uploadToR2: m.uploadToR2 }));
import { generationRouter } from '../../generation/router.js';
let app: FastifyInstance;
const base = { creatorAddress: '0x1234567890', prompt: 'a soulful song' };
beforeEach(async () => {
  vi.resetAllMocks(); app = Fastify({ logger: false }); await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); await app.register(generationRouter, { prefix: '/api' });
  m.subscribeTask.mockResolvedValue(async () => {});
  m.initiateGeneration.mockResolvedValue({ taskId: 't', songId: 's', status: 'pending' });
  m.checkStatusAndFinalize.mockResolvedValue({ status: 'pending', progress: 0 });
  m.formatInput.mockResolvedValue({ formatted_caption: 'clean', formatted_lyrics: 'words' });
  m.createSample.mockResolvedValue({ caption: 'song', lyrics: 'words' });
  m.uploadToR2.mockResolvedValue('https://songs.test/covers/image');
});
afterEach(async () => { await app.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('cover storage', () => {
  const boundary = 'cover-upload';
  const cover = (bytes: Buffer, mime = 'image/png') => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\nContent-Type: ${mime}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  it('uploads a cover larger than the JSON limit and generates with its URL', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    const uploaded = await app.inject({ method: 'POST', url: '/api/cover', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: cover(bytes) });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toEqual({ imageUrl: 'https://songs.test/covers/image' });
    expect(m.uploadToR2).toHaveBeenCalledWith('songs', expect.stringMatching(/^covers\/[\da-f-]+$/), bytes, 'image/png');
    const result = await app.inject({ method: 'POST', url: '/api/generate', payload: { ...base, image: uploaded.json().imageUrl } });
    expect(result.statusCode).toBe(202);
    expect(m.initiateGeneration).toHaveBeenCalledWith(expect.objectContaining({ image: 'https://songs.test/covers/image' }));
  });
  it.each(['audio/wav', 'text/plain'])('rejects a non-image %s upload', async mime => {
    const result = await app.inject({ method: 'POST', url: '/api/cover', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: cover(Buffer.from('data'), mime) });
    expect(result.statusCode).toBe(400);
    expect(m.uploadToR2).not.toHaveBeenCalled();
  });
  it('rejects multiple images before uploading either one', async () => {
    const single = cover(Buffer.from('image'));
    const body = Buffer.concat([single.subarray(0, single.length - Buffer.byteLength(`--${boundary}--\r\n`)), single]);
    const result = await app.inject({ method: 'POST', url: '/api/cover', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(result.statusCode).toBe(400);
    expect(m.uploadToR2).not.toHaveBeenCalled();
  });
  it('returns 413 when the cover exceeds the configured upload limit', async () => {
    await app.close();
    app = Fastify();
    await app.register(multipart, { limits: { fileSize: 16 } });
    await app.register(generationRouter, { prefix: '/api' });
    const result = await app.inject({ method: 'POST', url: '/api/cover', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: cover(Buffer.alloc(17)) });
    expect(result.statusCode).toBe(413);
    expect(m.uploadToR2).not.toHaveBeenCalled();
  });
  it('stores generated images before returning their URL', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'cover-test-key');
    const bytes = Buffer.alloc(2 * 1024 * 1024, 9);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Cover' }, { inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }] }))));
    const result = await app.inject({ method: 'POST', url: '/api/cover', payload: { prompt: 'acoustic folk' } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ imageUrl: 'https://songs.test/covers/image' });
    expect(m.uploadToR2).toHaveBeenCalledWith('songs', expect.stringMatching(/^covers\/[\da-f-]+$/), bytes, 'image/png');
  });
});

describe('generation Fastify routing and schemas', () => {
  it('forwards selected prices with the generation request', async () => {
    const pricing = { licenses: 12, stream_price: 0.04, license_price: 11 };
    const result = await app.inject({ method: 'POST', url: '/api/generate', payload: { ...base, ...pricing } });
    expect(result.statusCode).toBe(202);
    expect(m.initiateGeneration).toHaveBeenCalledWith(expect.objectContaining(pricing));
  });
  it.each([{ licenses: -1 }, { licenses: 1.5 }, { stream_price: -1 }, { license_price: -1 }])('rejects invalid pricing %j', async pricing => {
    const result = await app.inject({ method: 'POST', url: '/api/generate', payload: { ...base, ...pricing } });
    expect(result.statusCode).toBe(400);
    expect(m.initiateGeneration).not.toHaveBeenCalled();
  });
  it('accepts a minimal generate request and supplies the default turbo option', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/generate', payload: base });
    expect(result.statusCode).toBe(202); expect(result.json()).toEqual({ taskId: 't', songId: 's', status: 'pending' });
    expect(m.initiateGeneration).toHaveBeenCalledWith({ ...base, modelVariant: 'turbo' });
  });
  it.each([
    [{ ...base, creatorAddress: 'short' }], [{ ...base, creatorAddress: 123 }], [{ ...base, prompt: 'ab' }],
    [{ ...base, prompt: null }], [{ ...base, lyrics: 23 }], [{ ...base, instrumental: 'false' }],
    [{ ...base, modelVariant: 'base' }], [{ ...base, bpm: 29 }], [{ ...base, bpm: 301 }],
    [{ ...base, bpm: '120' }], [{ ...base, audioDuration: 4 }], [{ ...base, audioDuration: 301 }],
    [{ ...base, voiceReferenceUrl: 'not-a-url' }], [{ ...base, voiceCoverStrength: -1 }],
    [{ ...base, voiceCoverStrength: 1.01 }], [{ ...base, tags: [1] }], [{}], [null],
  ])('rejects invalid generation body %j without invoking the service', async (payload) => {
    const result = await app.inject({ method: 'POST', url: '/api/generate', payload });
    expect(result.statusCode).toBe(400); expect(m.initiateGeneration).not.toHaveBeenCalled();
    expect(result.json()).toHaveProperty('error');
  });
  it.each([[30, 5, 0], [300, 300, 1]])('accepts bpm=%s duration=%s strength=%s boundary values', async (bpm, audioDuration, voiceCoverStrength) => {
    const result = await app.inject({ method: 'POST', url: '/api/generate', payload: { ...base, bpm, audioDuration, voiceCoverStrength, voiceReferenceUrl: 'https://voice.test/s.wav', modelVariant: 'sft', tags: [] } });
    expect(result.statusCode).toBe(202);
    expect(m.initiateGeneration).toHaveBeenCalledWith(expect.objectContaining({ bpm, audioDuration, voiceCoverStrength, modelVariant: 'sft' }));
  });
  it('returns the caught error message on failed generation', async () => {
    m.initiateGeneration.mockRejectedValue(new Error('worker rejected task'));
    const result = await app.inject({ method: 'POST', url: '/api/generate', payload: base });
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'worker rejected task' });
  });
  it.each([
    ['generate', 'initiateGeneration', base, 'Generation failed to initiate'],
    ['format', 'formatInput', { prompt: 'caption' }, 'Failed to format input'],
    ['sample', 'createSample', {}, 'Failed to create sample'],
  ])('%s uses a stable fallback when a dependency rejects without an Error message', async (route, method, payload, error) => {
    m[method as 'initiateGeneration'].mockRejectedValue({});
    const result = await app.inject({ method: 'POST', url: `/api/${route}`, payload });
    expect(result.json()).toEqual({ error });
  });
  it('status uses a stable fallback for message-less dependency failures', async () => {
    m.checkStatusAndFinalize.mockRejectedValue({});
    expect((await app.inject('/api/status/t?songId=s')).json()).toEqual({ error: 'Failed to check status' });
  });
  it('rejects generation status without songId', async () => {
    const result = await app.inject('/api/status/t');
    expect(result.statusCode).toBe(400); expect(m.checkStatusAndFinalize).not.toHaveBeenCalled();
  });
  it('forwards status task and song IDs', async () => {
    const result = await app.inject('/api/status/task-1?songId=song-1');
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ status: 'pending', progress: 0 });
    expect(m.checkStatusAndFinalize).toHaveBeenCalledWith('task-1', 'song-1');
  });
  it('returns 500 when status querying fails', async () => {
    m.checkStatusAndFinalize.mockRejectedValue(new Error('worker unavailable'));
    const result = await app.inject('/api/status/t?songId=s');
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'worker unavailable' });
  });
  it('formats a caption and lyrics using the worker', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/format', payload: { prompt: 'caption', lyrics: 'lyrics' } });
    expect(result.statusCode).toBe(200); expect(m.formatInput).toHaveBeenCalledWith('caption', 'lyrics');
    expect(result.json()).toEqual({ formatted_caption: 'clean', formatted_lyrics: 'words' });
  });
  it.each([{}, { prompt: '' }])('rejects missing formatting caption %j', async (payload) => {
    const result = await app.inject({ method: 'POST', url: '/api/format', payload });
    expect(result.statusCode).toBe(400); expect(m.formatInput).not.toHaveBeenCalled();
  });
  it('reports formatter worker failures as 500', async () => {
    m.formatInput.mockRejectedValue(new Error('LM unavailable'));
    const result = await app.inject({ method: 'POST', url: '/api/format', payload: { prompt: 'caption' } });
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'LM unavailable' });
  });
  it('forwards sample query, instrumental and language settings', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/sample', payload: { query: 'pop', instrumental: true, vocalLanguage: 'it' } });
    expect(result.statusCode).toBe(200); expect(m.createSample).toHaveBeenCalledWith('pop', true, 'it');
  });
  it('defaults empty sample request to electronic with vocals', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/sample', payload: {} });
    expect(result.statusCode).toBe(200); expect(m.createSample).toHaveBeenCalledWith('electronic', false, undefined);
  });
  it('reports sample worker failures as 500', async () => {
    m.createSample.mockRejectedValue(new Error('LM unavailable'));
    const result = await app.inject({ method: 'POST', url: '/api/sample', payload: { query: 'song' } });
    expect(result.statusCode).toBe(500); expect(result.json()).toEqual({ error: 'LM unavailable' });
  });
  it('has no route at the unprefixed path', async () => {
    expect((await app.inject({ method: 'POST', url: '/generate', payload: base })).statusCode).toBe(404);
  });
});


describe('generation completion stream', () => {
  it('rechecks the durable result after subscribing and ends on completion', async () => {
    m.checkStatusAndFinalize.mockResolvedValue({ status: 'ready', progress: 100, primaryUrl: 'audio.wav' });
    const response = await app.inject('/api/events/task-1?songId=song-1');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ready', primaryUrl: 'audio.wav' });
    expect(m.subscribeTask.mock.invocationCallOrder[0]).toBeLessThan(m.checkStatusAndFinalize.mock.invocationCallOrder[0]);
  });
  it('returns validation errors before opening a stream', async () => {
    expect((await app.inject('/api/events/task-1')).statusCode).toBe(400);
    expect(m.subscribeTask).not.toHaveBeenCalled();
  });
});


it('delivers worker completion received during a status query', async () => {
  let notify!: () => void;
  let finish!: (value: unknown) => void;
  const stop = vi.fn().mockResolvedValue(undefined);
  m.subscribeTask.mockImplementation(async (_id, message) => { notify = message; return stop; });
  m.checkStatusAndFinalize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ status: 'ready', primaryUrl: 'audio.wav' });
  const pending = app.inject('/api/events/task-1?songId=song-1');
  const response = pending.then(value => value);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  notify();
  finish({ status: 'processing', progress: 40 });
  const result = await response;
  expect(result.body.trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { status: 'processing', progress: 40 }, { status: 'ready', primaryUrl: 'audio.wav' },
  ]);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
});
