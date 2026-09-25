import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv', () => ({ config: vi.fn() }));
import { Client, client, acestepClient, cleanAudioPath } from '../../generation/client.js';

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let fetchMock: ReturnType<typeof vi.fn>;
let api: Client;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new Client('http://worker.test:8001/', 'test-key');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('generation Client: audio path decoding', () => {
  it.each([
    [undefined, undefined], ['', undefined],
    ['output/song.wav', 'output/song.wav'],
    ['/app/ACE-Step-1.5/output/song.wav', 'output/song.wav'],
    ['https://media.test/song.wav', 'https://media.test/song.wav'],
    ['/v1/audio?path=%2Fapp%2FACE-Step-1.5%2Foutput%2Fsong.wav', 'output/song.wav'],
    ['/v1/audio?path=%2Fv1%2Faudio%3Fpath%3Doutput%252Fsong.wav', 'output/song.wav'],
    ['/v1/audio?path=%ZZ', '/v1/audio?path=%ZZ'],
  ])('decodes %j into %j without contacting the worker', (input, expected) => {
    expect(cleanAudioPath(input)).toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('exports the compatibility client alias as the same singleton', () => expect(acestepClient).toBe(client));
});

describe('generation Client: connected transport and release contracts', () => {
  it('normalizes the trailing slash and authenticates health checks', async () => {
    fetchMock.mockResolvedValue(reply({ status: 'healthy', gpu_memory: '20GB' }));
    expect(await api.health()).toEqual({ status: 'healthy', gpu_memory: '20GB' });
    expect(fetchMock).toHaveBeenCalledWith('http://worker.test:8001/health', {
      signal: expect.any(AbortSignal),
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    });
  });
  it.each([undefined, ''])('rejects missing model %j before dispatch', async (model) => {
    await expect(api.releaseTask({ model })).rejects.toThrow('Model specification is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [{ model: 'acestep-v15-xl-base' }, 'text2music'],
    [{ model: 'acestep-v15-xl-base', task: 'cover' }, 'cover'],
    [{ model: 'acestep-v15-xl-base', task: 'cover', task_type: 'repaint' }, 'repaint'],
  ])('keeps task and task_type consistent with precedence', async (payload, task) => {
    fetchMock.mockResolvedValue(reply({ data: { task_id: 'task-1' } }));
    await api.releaseTask(payload as any);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('http://worker.test:8001/release_task');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toMatchObject({ task, task_type: task, model: payload.model });
  });
  it('forwards optional numerical, LoRA, editing and reference parameters without mutating its input', async () => {
    fetchMock.mockResolvedValue(reply({ task_id: 'task-1' }));
    const payload = Object.freeze({
      model: 'acestep-v15-xl-turbo', prompt: 'drums', lyrics: '[Instrumental]', instrumental: true,
      src_audio_path: '/v1/audio?path=%2Fapp%2FACE-Step-1.5%2Fs.wav',
      reference_audio_path: '/v1/audio?path=r.wav', lora_path: 'https://voice.test/a.safetensors',
      lora_alpha: 0, seed: 0, guidance_scale: 1, inference_steps: 8, batch_size: 1,
      audio_duration: 5, repainting_start: 0, repainting_end: 5, repaint_strength: 0,
      track_classes: ['drums'], vocal_language: 'it',
    });
    await api.releaseTask(payload);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      ...payload, src_audio_path: 's.wav', reference_audio_path: 'r.wav', task: 'text2music', task_type: 'text2music',
    });
    expect(payload.src_audio_path).toContain('/v1/audio?path=');
  });
  it('sends a stable worker admission key', async () => {
    fetchMock.mockResolvedValue(reply({ task_id: 'request-1' }));
    await api.releaseTask({ model: 'acestep-v15-xl-turbo' }, { idempotencyKey: 'request-1' });
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('request-1');
  });
  it.each(['other-task', undefined])('rejects a release receipt with task ID %j when an admission key is supplied', async (task_id) => {
    fetchMock.mockResolvedValue(reply({ task_id, status: 'pending' }));
    await expect(api.releaseTask({ model: 'acestep-v15-xl-turbo' }, { idempotencyKey: 'request-1' })).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each([
    [{ data: { task_id: 'task-a', status: 'processing', message: 'queued' } }, { task_id: 'task-a', status: 'processing', message: 'queued' }],
    [{ id: 'task-b' }, { task_id: 'task-b', status: 'pending', message: undefined }],
    [{ data: { id: 'task-c' }, error: 'worker warning' }, { task_id: 'task-c', status: 'pending', message: 'worker warning' }],
  ])('accepts wrapped and bare release envelopes', async (response, expected) => {
    fetchMock.mockResolvedValue(reply(response));
    expect(await api.releaseTask({ model: 'acestep-v15-xl-turbo' })).toEqual(expected);
  });
});

describe('generation Client: query envelopes, states and media metadata', () => {
  const item = { task_id: 'task-1', status: 'ready', result: [{ file: 'output/song.wav', metas: { duration: 10, bpm: 120 } }] };
  it.each([
    ['wrapped array', { data: [item] }], ['results dictionary', { results: { 'task-1': item } }],
    ['bare array', [item]], ['bare dictionary', { 'task-1': item }], ['wrapped dictionary', { data: { 'task-1': item } }],
  ])('reads %s query response', async (_label, envelope) => {
    fetchMock.mockResolvedValue(reply(envelope));
    const result = await api.queryResult(['task-1', 'task-2']);
    expect(result.results['task-1']).toMatchObject({ task_id: 'task-1', status: 'ready', progress: 100,
      audio_urls: ['/api/audio?path=output%2Fsong.wav'], metas: [{ duration: 10, bpm: 120 }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ task_id_list: ['task-1', 'task-2'], task_ids: ['task-1', 'task-2'] });
  });
  it.each([[1, 'ready'], ['succeeded', 'ready'], ['ready', 'ready'], [2, 'error'], ['failed', 'error'], ['error', 'error'], [0, 'pending'], ['pending', 'pending']])(
    'normalizes worker state %j to %s', async (status, expected) => {
      fetchMock.mockResolvedValue(reply({ data: [{ id: 'task-1', status, error: 'failure' }] }));
      expect((await api.queryResult(['task-1'])).results['task-1']).toMatchObject({ status: expected, error: 'failure' });
    });
  it('reads serialized JSON result lists and uses the last fractional progress entry', async () => {
    fetchMock.mockResolvedValue(reply({ data: [{ task_id: 'task-1', status: 0, result: JSON.stringify([
      { file: '/v1/audio?path=%2Fv1%2Faudio%3Fpath%3Doutput%252Fa.wav', progress: .124 },
      { file: 'https://media.test/b.wav', metas: { duration: 10 }, progress: .567, error: 'partial warning' },
      null,
    ]) }] }));
    expect((await api.queryResult(['task-1'])).results['task-1']).toEqual({
      task_id: 'task-1', status: 'pending', progress: 57,
      audio_urls: ['/api/audio?path=output%2Fa.wav', 'https://media.test/b.wav'], metas: [{ duration: 10 }], error: 'partial warning',
    });
  });
  it('keeps explicit outer errors ahead of nested errors and explicit nonzero progress', async () => {
    fetchMock.mockResolvedValue(reply([{ task_id: 'task-1', status: 'error', progress: 22, error: 'outer', result: [{ error: 'inner' }] }]));
    expect((await api.queryResult(['task-1'])).results['task-1']).toMatchObject({ error: 'outer', progress: 22 });
  });
  it.each(['not-json', undefined, []])('handles absent or undecodable result %j without throwing', async (result) => {
    fetchMock.mockResolvedValue(reply([{ task_id: 'task-1', status: 'pending', result }]));
    expect((await api.queryResult(['task-1'])).results['task-1']).toMatchObject({ status: 'pending', audio_urls: undefined });
  });
  it('keeps an undecodable wrapped media path without dropping its sibling', async () => {
    fetchMock.mockResolvedValue(reply([{ task_id: 'task-1', status: 'ready', result: [{ file: '/v1/audio?path=%ZZ' }, { file: 'valid.wav' }] }]));
    expect((await api.queryResult(['task-1'])).results['task-1'].audio_urls).toEqual(['/api/audio?path=%2Fv1%2Faudio%3Fpath%3D%25ZZ', '/api/audio?path=valid.wav']);
  });
  it.each([null, false, 42, 'invalid', []])('handles non-collection query data %j as no results', async (data) => {
    fetchMock.mockResolvedValue(reply({ data }));
    expect(await api.queryResult([])).toEqual({ results: {} });
  });
  it('skips null records and records lacking identifiers', async () => {
    fetchMock.mockResolvedValue(reply({ data: [null, {}, { status: 'ready' }, { id: 'valid', status: 'pending' }] }));
    expect(Object.keys((await api.queryResult(['valid'])).results)).toEqual(['valid']);
  });
});

describe('generation Client: separation, format and sample endpoints', () => {
  it.each([true, false])('reads %s wrapped separation response', async (wrapped) => {
    const data = { task_id: 'sep-1', status: 'ready', stems: { vocals: 'v.wav', drums: 'd.wav' }, audio_paths: ['v.wav', 'd.wav'] };
    fetchMock.mockResolvedValue(reply(wrapped ? { data } : data));
    expect(await api.separate({ src_audio_path: 's.wav', stem_type: 'vocals', wait: false })).toEqual(data);
    expect(fetchMock.mock.calls[0][0]).toBe('http://worker.test:8001/separate');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ src_audio_path: 's.wav', stem_type: 'vocals', wait: false });
  });
  it('sends a stable separation admission key', async () => {
    fetchMock.mockResolvedValue(reply({ task_id: 'request-1', status: 'ready', stems: { vocals: 'v.wav' } }));
    await api.separate({ src_audio_path: 'src.wav' }, { idempotencyKey: 'request-1' });
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('request-1');
  });
  it.each(['other-task', undefined])('rejects a separation receipt with task ID %j when an admission key is supplied', async (task_id) => {
    fetchMock.mockResolvedValue(reply({ task_id, status: 'ready', stems: { vocals: 'v.wav' } }));
    await expect(api.separate({ src_audio_path: 'src.wav' }, { idempotencyKey: 'request-1' })).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each([
    [{ data: { formatted_caption: 'clean', formatted_lyrics: 'words' } }, 'clean', 'words'],
    [{ caption: 'alias', lyrics: 'alias lyrics' }, 'alias', 'alias lyrics'],
    [{}, 'original', 'original lyrics'],
  ])('formats caption and lyrics with envelope and alias fallbacks', async (body, caption, lyrics) => {
    fetchMock.mockResolvedValue(reply(body));
    expect(await api.formatInput('original', 'original lyrics')).toEqual({ formatted_caption: caption, formatted_lyrics: lyrics });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ prompt: 'original', lyrics: 'original lyrics' });
  });
  it('defaults formatting lyrics to an empty string', async () => {
    fetchMock.mockResolvedValue(reply({}));
    expect((await api.formatInput('caption')).formatted_lyrics).toBe('');
  });
  it.each([true, false])('reads %s wrapped random sample metadata', async (wrapped) => {
    const data = { caption: 'dance', lyrics: 'song', bpm: 140, key_scale: 'D minor', audio_duration: 45 };
    fetchMock.mockResolvedValue(reply(wrapped ? { data } : data));
    expect(await api.createRandomSample('dance')).toEqual(data);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ query: 'dance' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://worker.test:8001/create_random_sample');
  });
  it.each(['keyscale', 'key_scale'])('normalizes sample %s metadata and forwards language', async (key) => {
    fetchMock.mockResolvedValue(reply({ data: { caption: 'pop', lyrics: 'ciao', bpm: 120, [key]: 'C major', duration: 60 } }));
    expect(await api.createSample('pop', true, 'it')).toEqual({ caption: 'pop', lyrics: 'ciao', bpm: 120, key_scale: 'C major', duration: 60 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://worker.test:8001/v1/create_sample');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ query: 'pop', instrumental: true, vocal_language: 'it' });
  });
  it('omits absent vocal language and defaults instrumental false', async () => {
    fetchMock.mockResolvedValue(reply({}));
    expect(await api.createSample('query')).toMatchObject({ caption: '', lyrics: '' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ query: 'query', instrumental: false });
  });
});

describe('generation Client: failure propagation', () => {
  const calls: Array<[string, (client: Client) => Promise<unknown>]> = [
    ['health', c => c.health()], ['release', c => c.releaseTask({ model: 'acestep-v15-xl-turbo' })],
    ['query', c => c.queryResult(['t'])], ['separate', c => c.separate({ src_audio_path: 's.wav' })],
    ['format', c => c.formatInput('caption')], ['random sample', c => c.createRandomSample('query')],
    ['sample', c => c.createSample('query')],
  ];
  it.each(calls)('%s rejects non-success HTTP responses', async (_name, call) => {
    fetchMock.mockResolvedValue(new Response('worker unavailable', { status: 503 }));
    await expect(call(api)).rejects.toThrow('503');
  });
  it.each(calls)('%s propagates transport failure', async (_name, call) => {
    fetchMock.mockRejectedValue(new Error('connection reset'));
    await expect(call(api)).rejects.toThrow('connection reset');
  });
  it.each(calls)('%s rejects malformed successful JSON', async (_name, call) => {
    fetchMock.mockResolvedValue(new Response('{ malformed', { status: 200 }));
    await expect(call(api)).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('generation Client: durable training contract', () => {
  it('reads exact XL checkpoint fingerprints and model-derived training settings', async () => {
    const model = { model: 'acestep-v15-xl-sft', checkpoint_fingerprint: 'a'.repeat(64), training_config: { train_epochs: 10 } };
    fetchMock.mockResolvedValue(reply({ data: { role: 'training', models: [model] } }));
    expect((await api.trainingOptions()).models).toEqual([model]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://worker.test:8001/v1/training/options');
  });
  it('preserves bracket lyrics and selected checkpoint when admitting training once', async () => {
    fetchMock.mockResolvedValue(reply({ data: { task_id: 'voice-train-1' } }));
    const payload = { model: 'acestep-v15-xl-sft', source_audio_url: 'https://sample.test/v.wav', sample_metadata: { lyrics: '[Verse]\n[whispered]\nHello' }, training_config: {}, checkpoint_fingerprint: 'a'.repeat(64) };
    await api.train(payload, { idempotencyKey: 'voice-train-1' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(payload);
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('voice-train-1');
  });
  it('distinguishes unknown IDs from queued work and retains actual training measurements/artifacts', async () => {
    fetchMock.mockResolvedValue(reply({ data: [{ task_id: 'missing', result: '[]', status: 0 }, { task_id: 'queued', result: '[]', status: 0, stage: 'queued' }, { task_id: 'ready', status: 1, artifact: { digest: 'b'.repeat(64) }, step: 10, total_steps: 10 }] }));
    const { results } = await api.queryTraining(['missing', 'queued', 'ready']);
    expect(results.missing).toBeUndefined();
    expect(results.queued).toMatchObject({ status: 'pending', stage: 'queued' });
    expect(results.ready).toMatchObject({ status: 'ready', step: 10, artifact: { digest: 'b'.repeat(64) } });
  });
  it('fetches artifact bytes with authentication and rejects path traversal', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    expect(await api.trainingArtifact('task-1', 'adapter_model.safetensors')).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    await expect(api.trainingArtifact('task-1', '../private')).rejects.toThrow('Invalid');
  });
  it('recognizes the numeric running status using its real worker stage', async () => {
    fetchMock.mockResolvedValue(reply({ data: [{ task_id: 'training', status: 0, stage: 'training', step: 4, total_steps: 10, loss: .4 }] }));
    expect((await api.queryTraining(['training'])).results.training).toMatchObject({ status: 'processing', stage: 'training', step: 4, total_steps: 10, loss: .4 });
  });
});
