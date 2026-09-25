import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('dotenv', () => ({ config: vi.fn() }));
import { Client, cleanAudioPath } from '../../generation/client.js';
let fetchMock: ReturnType<typeof vi.fn>;
let api: Client;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); api = new Client('http://worker.test', 'test-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe('generation worker response integrity', () => {
  it.each([{}, { data: {} }, { error: 'GPU rejected the task' }])('rejects successful HTTP release without a task identifier: %j', async (data) => {
    fetchMock.mockResolvedValue(reply(data));
    await expect(api.releaseTask({ model: 'acestep-v15-xl-turbo' })).rejects.toThrow();
  });
  it('normalizes numeric success status in task release', async () => {
    fetchMock.mockResolvedValue(reply({ task_id: 't', status: 1 }));
    expect((await api.releaseTask({ model: 'acestep-v15-xl-turbo' })).status).toBe('ready');
  });
  it('preserves processing state during query normalization', async () => {
    fetchMock.mockResolvedValue(reply({ data: [{ task_id: 't', status: 'processing', progress: 50 }] }));
    expect((await api.queryResult(['t'])).results.t.status).toBe('processing');
  });
  it('preserves a genuine zero progress report instead of fabricating 35 percent', async () => {
    fetchMock.mockResolvedValue(reply({ data: [{ task_id: 't', status: 'pending', progress: 0 }] }));
    expect((await api.queryResult(['t'])).results.t.progress).toBe(0);
  });
  it.each([-0.1, 1.5])('bounds nested fractional progress %s to the public 0..100 range', async (progress) => {
    fetchMock.mockResolvedValue(reply([{ task_id: 't', status: 'pending', result: [{ progress }] }]));
    const actual = (await api.queryResult(['t'])).results.t.progress!;
    expect(actual).toBeGreaterThanOrEqual(0);
    expect(actual).toBeLessThanOrEqual(100);
  });
  it.each(['null', '{"file":"song.wav"}', '42'])('handles valid non-array JSON result %s without crashing the complete batch', async (result) => {
    fetchMock.mockResolvedValue(reply([{ task_id: 'bad', status: 'ready', result }, { task_id: 'good', status: 'ready', result: [{ file: 'song.wav' }] }]));
    await expect(api.queryResult(['bad', 'good'])).resolves.toMatchObject({ results: { good: { status: 'ready' } } });
  });
  it('handles non-string file metadata without crashing valid siblings', async () => {
    fetchMock.mockResolvedValue(reply([{ task_id: 't', status: 'ready', result: [{ file: 23 }, { file: 'valid.wav' }] }]));
    await expect(api.queryResult(['t'])).resolves.toMatchObject({ results: { t: { audio_urls: ['/api/audio?path=valid.wav'] } } });
  });
  it('keeps task IDs as own dictionary keys, including __proto__', async () => {
    fetchMock.mockResolvedValue(reply([{ task_id: '__proto__', status: 'ready', result: [{ file: 'a.wav' }] }]));
    const result = await api.queryResult(['__proto__']);
    expect(Object.hasOwn(result.results, '__proto__')).toBe(true);
  });
  it('accepts the normalized audio_urls media envelope without losing all audio', async () => {
    fetchMock.mockResolvedValue(reply({ results: { t: { task_id: 't', status: 'ready', audio_urls: ['https://media.test/t.wav'], metas: [{ duration: 10 }] } } }));
    expect((await api.queryResult(['t'])).results.t.audio_urls).toEqual(['https://media.test/t.wav']);
  });
  it('retains the worker separation stems envelope', async () => {
    fetchMock.mockResolvedValue(reply({ data: [{ task_id: 't', status: 1, stems: { vocals: '/v1/audio?path=v.wav', drums: 'd.wav', invalid: 2 }, result: '[]' }] }));
    expect((await api.queryResult(['t'])).results.t).toMatchObject({ stems: { vocals: '/v1/audio?path=v.wav', drums: 'd.wav' } });
  });
  it('preserves ordinary external URLs that contain an unrelated path query parameter', () => {
    const url = 'https://media.test/file.wav?path=album%2Fsong&signature=abc';
    expect(cleanAudioPath(url)).toBe(url);
  });
  it('extracts only the audio path query value rather than appending other query parameters', () => {
    expect(cleanAudioPath('/v1/audio?path=output%2Ffile.wav&download=1')).toBe('output/file.wav');
  });
  it('distinguishes intentional empty formatted lyrics from absent fields', async () => {
    fetchMock.mockResolvedValue(reply({ formatted_caption: 'caption', formatted_lyrics: '' }));
    expect((await api.formatInput('caption', 'old lyrics')).formatted_lyrics).toBe('');
  });
  it('normalizes wrapped audio paths for separation as for editing release', async () => {
    fetchMock.mockResolvedValue(reply({ task_id: 's', status: 'ready', stems: {} }));
    await api.separate({ src_audio_path: '/v1/audio?path=%2Fapp%2FACE-Step-1.5%2Fsong.wav' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).src_audio_path).toBe('song.wav');
  });
});

describe('finite worker transport lifetime', () => {
  it('aborts a stalled worker and classifies the timeout', async () => {
    api = new Client('http://worker.test', 'test-key', { timeoutMs: 5 });
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    await expect(api.health()).rejects.toMatchObject({ statusCode: 504 });
  });
  it('releases separation through the bounded task admission deadline', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockImplementation(async () => reply({ task_id: 't', status: 'ready', stems: { vocals: 'v.wav' } }));
    await api.health(); await api.separate({ src_audio_path: 'song.wav' });
    expect(deadline.mock.calls[0][0]).toBe(30_000);
    expect(deadline.mock.calls[1][0]).toBe(30_000);
  });
  it.each([
    ['health', (c: Client) => c.health()], ['release', (c: Client) => c.releaseTask({ model: 'acestep-v15-xl-turbo' })],
    ['query', (c: Client) => c.queryResult(['t'])], ['separate', (c: Client) => c.separate({ src_audio_path: 'song.wav' })],
    ['format', (c: Client) => c.formatInput('caption')], ['random sample', (c: Client) => c.createRandomSample('query')],
    ['sample', (c: Client) => c.createSample('query')],
  ])('%s attaches an abort deadline so a stalled worker cannot hold the API forever', async (_name, call) => {
    fetchMock.mockResolvedValue(reply({ task_id: 't', data: [], stems: {} }));
    await call(api);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
