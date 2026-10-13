import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { response } from '../support/voice-storage-broker.js';
import { deleteFromR2, getR2Url, hasR2Object, listR2Objects, persistAudioToR2, uploadToR2 } from '../../storage/r2.js';
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { vi.stubEnv('CF_ACCOUNT_ID', 'test-account'); vi.stubEnv('CF_GLOBAL_TOKEN', 'test-cloudflare-key'); vi.stubEnv('CF_API_TOKEN', 'test-cloudflare-key'); vi.stubEnv('ACESTEP_API_URL', 'http://worker.invalid:8001'); vi.stubEnv('ACESTEP_API_KEY', 'test-worker-key'); fetchMock = vi.fn(); vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { const res = await fetchMock(url, init); return res instanceof Response ? res.clone() : res; }); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const cloudApi = 'https://api.cloudflare.com/client/v4/accounts/test-account/r2/buckets';
const domain = 'https://pub-62c17ba4ea004db3bee5152452c65d61.r2.dev';
describe('R2 transport and persistence behavior (mock fetch)', () => {
  it.each(['songs', 'versions', 'loras'] as const)('returns a distinct HTTPS CDN domain for %s', bucket => {
    expect(getR2Url(bucket, '/nested/audio.wav')).toMatch(/^https:\/\/pub-[a-f0-9]+\.r2\.dev\/nested\/audio\.wav$/);
  });
  it('removes exactly one leading slash and preserves nested paths', () => {
    expect(getR2Url('songs', '//nested/audio.wav')).toBe(`${domain}//nested/audio.wav`);
  });
  it.each(['plain.wav', '/nested/audio.wav', 'spaces &ü?.wav', 'double%20encoded.wav'])('encodes upload API object key %j exactly once', async key => {
    fetchMock.mockResolvedValue(response({ success: true, result: { key: key.startsWith('/') ? key.slice(1) : key } })); const bytes = Buffer.from([0, 128, 255]);
    expect(await uploadToR2('songs', key, bytes, 'audio/flac')).toBe(getR2Url('songs', key));
    expect(fetchMock).toHaveBeenCalledWith(`${cloudApi}/songs/objects/${(key.startsWith('/') ? key.slice(1) : key).split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT', headers: { Authorization: 'Bearer test-cloudflare-key', 'Content-Type': 'audio/flac' }, body: bytes, signal: expect.any(AbortSignal), redirect: 'error',
    });
  });
  it('accepts Uint8Array and defaults content type to WAV', async () => {
    fetchMock.mockResolvedValue(response({ success: true, result: { key: 'v.wav' } })); const bytes = Uint8Array.from([0, 1, 255]);
    await uploadToR2('versions', 'v.wav', bytes); expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: bytes, headers: { 'Content-Type': 'audio/wav' } });
  });
  it.each([403, 429, 500])('reports upload HTTP %s and body', async status => {
    fetchMock.mockResolvedValue(response('provider failure', { status, statusText: 'ProviderError' }));
    await expect(uploadToR2('loras', 'v.safetensors', Buffer.alloc(1))).rejects.toThrow('ProviderError (provider failure)');
  });
  it('reports upload failure even if error body cannot be read', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Disconnected', text: vi.fn().mockRejectedValue(new Error('body failed')) });
    await expect(uploadToR2('songs', 'x', Buffer.alloc(1))).rejects.toThrow('Disconnected ()');
  });
  it('propagates network upload failure', async () => {
    fetchMock.mockRejectedValue(new Error('socket reset')); await expect(uploadToR2('songs', 'x', Buffer.alloc(1))).rejects.toThrow('socket reset');
  });
  it.each(['/api/audio?path=%2Ftmp%2Fvocal%20a.wav', '/audio?path=%2Ftmp%2Fvocal%20a.wav', '/v1/audio?path=%2Ftmp%2Fvocal%20a.wav'])('maps local source %s to connected worker audio route', async source => {
    fetchMock.mockResolvedValueOnce(response(Uint8Array.from([0, 255]), { headers: { 'content-type': 'audio/flac' } })).mockResolvedValueOnce(response({ success: true, result: { key: 'v.wav' } }));
    expect(await persistAudioToR2('versions', 'v.wav', source)).toBe(getR2Url('versions', 'v.wav'));
    expect(fetchMock.mock.calls[0]).toEqual(['http://worker.invalid:8001/v1/audio?path=%2Ftmp%2Fvocal%20a.wav', { headers: { Authorization: 'Bearer test-worker-key' }, signal: expect.any(AbortSignal), redirect: 'manual' }]);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ body: Buffer.from([0, 255]), headers: { 'Content-Type': 'audio/flac' } });
  });
  it.each(['/api/audio/v.wav', '/audio/v.wav', '/v1/audio/v.wav'])('joins local non-query source %s', async source => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? response({ success: true, result: { key: 'x' } }) : response('audio', { headers: { 'content-type': 'audio/wav' } }));
    await persistAudioToR2('songs', 'x', source); expect(fetchMock.mock.calls[0][0]).toBe(`http://worker.invalid:8001${source}`);
  });
  it('uses fallback MIME when source has no content-type', async () => {
    fetchMock.mockResolvedValueOnce(new Response(Uint8Array.from([1]))).mockResolvedValueOnce(response({ success: true, result: { key: 'x' } }));
    await persistAudioToR2('songs', 'x', '/audio/x', 'audio/ogg');
    expect(fetchMock.mock.calls[1][1].headers['Content-Type']).toBe('audio/ogg');
  });
  it('omits source auth when no worker API key is configured', async () => {
    vi.stubEnv('ACESTEP_API_KEY', ''); fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? response({ success: true, result: { key: 'x' } }) : response('audio', { headers: { 'content-type': 'audio/wav' } }));
    await persistAudioToR2('songs', 'x', '/audio/x'); expect(fetchMock.mock.calls[0][1].headers).toEqual({});
  });
  it('rejects relative audio source when no ACESTEP URL is configured', async () => {
    vi.stubEnv('ACESTEP_API_URL', '');
    await expect(persistAudioToR2('songs', 'x', '/audio/x')).rejects.toThrow();
  });
  it('copies unrelated pub-prefixed sources without worker credentials', async () => {
    fetchMock.mockResolvedValueOnce(response('audio', { headers: { 'content-type': 'audio/wav' } })).mockResolvedValueOnce(response({ success: true, result: { key: 'x' } }));
    expect(await persistAudioToR2('songs', 'x', 'https://pub-anything.attacker.invalid/audio.wav')).toBe(getR2Url('songs', 'x'));
    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
  });
  it('copies owned R2 sources into a different requested bucket/key', async () => {
    fetchMock.mockResolvedValueOnce(response('audio', { headers: { 'content-type': 'audio/wav' } })).mockResolvedValueOnce(response({ success: true, result: { key: 'destination.wav' } }));
    expect(await persistAudioToR2('versions', 'destination.wav', getR2Url('songs', 'source.wav'))).toBe(getR2Url('versions', 'destination.wav'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('returns an exact owned destination without recopying it', async () => {
    const source = getR2Url('songs', 'x');
    expect(await persistAudioToR2('songs', 'x', source)).toBe(source);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('omits worker auth on public HTTP audio sources', async () => {
    fetchMock.mockResolvedValueOnce(response('audio', { headers: { 'content-type': 'audio/wav' } })).mockResolvedValueOnce(response({ success: true, result: { key: 'x' } }));
    await persistAudioToR2('songs', 'x', 'http://external.invalid/audio.wav');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it('does not upload when source returns HTTP failure', async () => {
    fetchMock.mockResolvedValue(response('', { status: 404, statusText: 'Not Found' }));
    await expect(persistAudioToR2('songs', 'x', '/audio/missing')).rejects.toThrow('Failed to fetch source audio'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('propagates source network failure before destination request', async () => {
    fetchMock.mockRejectedValue(new Error('source offline'));
    await expect(persistAudioToR2('songs', 'x', '/audio/x')).rejects.toThrow('source offline'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('propagates source body read failure without upload', async () => {
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: vi.fn().mockRejectedValue(new Error('truncated body')) });
    await expect(persistAudioToR2('songs', 'x', '/audio/x')).rejects.toThrow('truncated body'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed local percent encoding before fetch', async () => {
    await expect(persistAudioToR2('songs', 'x', '/audio?path=%XX')).rejects.toThrow(URIError); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('propagates destination error after fetching source', async () => {
    fetchMock.mockResolvedValueOnce(response('audio', { headers: { 'content-type': 'audio/wav' } })).mockResolvedValueOnce(response('bad', { status: 500 }));
    await expect(persistAudioToR2('songs', 'x', '/audio/x')).rejects.toThrow('Failed to upload object'); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([[200, true], [404, false], [500, false]])('deletion HTTP %s returns %s', async (status, expected) => {
    fetchMock.mockResolvedValue(response({ success: true, result: { key: 'nested/v.safetensors' } }, { status: Number(status) })); expect(await deleteFromR2('loras', '/nested/v.safetensors')).toBe(expected);
    expect(fetchMock.mock.calls[0]).toEqual([`${cloudApi}/loras/objects/nested/v.safetensors`, { method: 'DELETE', headers: { Authorization: 'Bearer test-cloudflare-key' }, signal: expect.any(AbortSignal), redirect: 'error' }]);
  });
  it('propagates deletion network failure', async () => {
    fetchMock.mockRejectedValue(new Error('offline')); await expect(deleteFromR2('songs', 'x')).rejects.toThrow('offline');
  });
  it('maps provider list fields and preserves metadata', async () => {
    fetchMock.mockResolvedValue(response({ success: true, result: [{ key: 'nested/x.wav', size: 4, last_modified: 'date', etag: 'etag' }, { key: 'empty.wav', size: 0 }] }));
    expect(await listR2Objects('songs')).toEqual([{ key: 'nested/x.wav', size: 4, lastModified: 'date', etag: 'etag' }, { key: 'empty.wav', size: 0, lastModified: '', etag: undefined }]);
    expect(fetchMock.mock.calls[0]).toEqual([`${cloudApi}/songs/objects?per_page=1000`, { method: 'GET', headers: { Authorization: 'Bearer test-cloudflare-key' }, signal: expect.any(AbortSignal), redirect: 'error' }]);
  });
  it.each([{ success: false, errors: [{ message: 'denied' }] }, { success: true, result: {} }, {}])('rejects invalid provider envelope %j', async payload => {
    fetchMock.mockResolvedValue(response(payload)); await expect(listR2Objects('songs')).rejects.toThrow();
  });
  it('rejects invalid JSON listing', async () => {
    fetchMock.mockResolvedValue(response('{broken')); await expect(listR2Objects('songs')).rejects.toThrow();
  });
  it('propagates listing network failure', async () => {
    fetchMock.mockRejectedValue(new Error('network failed')); await expect(listR2Objects('songs')).rejects.toThrow('network failed');
  });
  it('returns valid genuinely empty inventory', async () => {
    fetchMock.mockResolvedValue(response({ success: true, result: [] })); expect(await listR2Objects('songs')).toEqual([]);
  });
  it('rejects HTTP list failures with provider body', async () => {
    fetchMock.mockResolvedValue(response('denied', { status: 403, statusText: 'Forbidden' }));
    await expect(listR2Objects('songs')).rejects.toThrow('Forbidden (denied)');
  });
  it('handles inaccessible list error body', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Broken', text: vi.fn().mockRejectedValue(new Error('body')) });
    await expect(listR2Objects('songs')).rejects.toThrow('Broken ()');
  });
  it.each([['/nested/x.wav', true], ['x.wav', false], ['missing.wav', false]])('hasR2Object exact key match %j -> %s', async (key, expected) => {
    fetchMock.mockResolvedValue(response({ success: true, result: [{ key: 'nested/x.wav' }] }));
    expect(await hasR2Object('songs', String(key))).toBe(expected);
  });
  it('propagates listing failure through hasR2Object', async () => {
    fetchMock.mockRejectedValue(new Error('unavailable')); await expect(hasR2Object('songs', 'x')).rejects.toThrow('unavailable');
  });
  it.each([
    ['global token precedence', { CF_GLOBAL_TOKEN: 'global-test', CF_API_TOKEN: 'api-test', CF_ACCOUNT_ID: 'account-test' }, 'global-test', 'account-test'],
    ['API token fallback', { CF_GLOBAL_TOKEN: '', CF_API_TOKEN: 'api-test', CF_ACCOUNT_ID: 'account-test' }, 'api-test', 'account-test'],
    ['empty token and empty account', { CF_GLOBAL_TOKEN: '', CF_API_TOKEN: '', CF_ACCOUNT_ID: '' }, '', ''],
  ])('captures credentials at import with %s', async (_label, env, token, account) => {
    Object.entries(env).forEach(([key, value]) => vi.stubEnv(key, value)); vi.resetModules();
    const isolated = await import('../../storage/r2.js'); fetchMock.mockResolvedValue(response({ success: true, result: { key: 'x' } }));
    await isolated.uploadToR2('songs', 'x', Buffer.alloc(1));
    expect(fetchMock.mock.calls[0][0]).toContain(`/accounts/${account}/`); expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
  });
  it('bounded mock inventory: maps and searches 10,000 keys', async () => {
    fetchMock.mockImplementation(async () => response({ success: true, result: Array.from({ length: 10_000 }, (_, i) => ({ key: `sng-${i}.wav`, size: i })) }));
    expect((await listR2Objects('songs')).length).toBe(10_000); expect(await hasR2Object('songs', 'sng-9999.wav')).toBe(true);
  });
});
