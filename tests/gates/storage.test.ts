import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { response } from '../support/voice-storage-broker.js';
import { deleteFromR2, getR2Url, hasR2Object, listR2Objects, persistAudioToR2, uploadToR2 } from '../../storage/r2.js';
let f: ReturnType<typeof vi.fn>;
beforeEach(() => { f = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => init?.method === 'PUT' || init?.method === 'DELETE' ? response({ success: true, result: { key: decodeURIComponent(new URL(url).pathname.split('/objects/')[1]) } }) : response(Uint8Array.from([1, 2]), { headers: { 'content-type': 'audio/wav' } })); vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { const res = await f(url, init); return res instanceof Response ? res.clone() : res; }); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('R2 transport and object integrity', () => {
  it('worker API credential must never be sent to another origin', async () => {
    await persistAudioToR2('songs', 'x.wav', 'https://untrusted.invalid/audio.wav');
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it.each(['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/admin', 'file:///etc/passwd'])('reject untrusted/private source %s before fetch', async source => {
    await expect(persistAudioToR2('songs', 'x.wav', source)).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
  });
  it('an unrelated https://pub- host must not count as durable owned storage', async () => {
    const url = await persistAudioToR2('songs', 'x.wav', 'https://pub-attacker.invalid/x.wav');
    expect(url).toBe(getR2Url('songs', 'x.wav')); expect(f).toHaveBeenCalled();
  });
  it('source in a different owned bucket must be copied to the requested destination', async () => {
    const result = await persistAudioToR2('versions', 'vocals/x.wav', getR2Url('songs', 'x.wav'));
    expect(result).toBe(getR2Url('versions', 'vocals/x.wav')); expect(f).toHaveBeenCalledTimes(2);
  });
  it('URL construction must encode query/fragment characters and Unicode object names', () => {
    expect(getR2Url('songs', 'nested/a #?ü.wav')).toBe(`${getR2Url('songs', 'nested/')}a%20%23%3F%C3%BC.wav`);
  });
  it('source path parsing must separate path query parameter from unrelated parameters', async () => {
    await persistAudioToR2('songs', 'x', '/api/audio?path=%2Ftmp%2Fx.wav&download=1');
    expect(f.mock.calls[0][0]).toBe('http://worker.invalid:8001/v1/audio?path=%2Ftmp%2Fx.wav');
  });
  it.each([{ success: false, errors: [{ message: 'denied' }] }, { success: true, result: {} }, {}])('invalid listing envelope %j must fail closed', async payload => {
    f.mockResolvedValue(response(payload)); await expect(listR2Objects('songs')).rejects.toThrow();
  });
  it('list must follow truncation cursor before declaring inventory complete', async () => {
    f.mockResolvedValueOnce(response({ success: true, result: [{ key: 'one.wav' }], result_info: { is_truncated: true, cursor: 'next-page' } }))
      .mockResolvedValueOnce(response({ success: true, result: [{ key: 'two.wav' }], result_info: { is_truncated: false } }));
    expect((await listR2Objects('songs')).map(o => o.key)).toEqual(['one.wav', 'two.wav']); expect(f).toHaveBeenCalledTimes(2);
  });
  it('existence checks must include later pages', async () => {
    f.mockResolvedValueOnce(response({ success: true, result: [{ key: 'one.wav' }], result_info: { is_truncated: true, cursor: 'next' } }))
      .mockResolvedValueOnce(response({ success: true, result: [{ key: 'two.wav' }] }));
    expect(await hasR2Object('songs', 'two.wav')).toBe(true);
  });
  it('malformed object entries must not be accepted as trustworthy inventory', async () => {
    f.mockResolvedValue(response({ success: true, result: [{ size: 'invalid' }, { key: 123, size: -1 }] }));
    await expect(listR2Objects('songs')).rejects.toThrow();
  });
  it.each(['upload', 'delete', 'list', 'persist'])('%s fetch must include a bounded cancellation signal', async operation => {
    if (operation === 'upload') await uploadToR2('songs', 'x', Buffer.alloc(1));
    if (operation === 'delete') await deleteFromR2('songs', 'x');
    if (operation === 'list') { f.mockResolvedValue(response({ success: true, result: [] })); await listR2Objects('songs'); }
    if (operation === 'persist') await persistAudioToR2('songs', 'x', '/audio/x');
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('persist must reject non-audio response body instead of storing an HTML error as audio', async () => {
    f.mockResolvedValue(response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
    await expect(persistAudioToR2('songs', 'x', '/audio/x')).rejects.toThrow(); expect(f).toHaveBeenCalledTimes(1);
  });
  it('advertised oversized audio must be rejected before buffering', async () => {
    f.mockResolvedValue(response(Uint8Array.from([1]), { headers: { 'content-type': 'audio/wav', 'content-length': '1099511627776' } }));
    await expect(persistAudioToR2('songs', 'x', '/audio/x')).rejects.toThrow(); expect(f).toHaveBeenCalledTimes(1);
  });
  it('empty object keys must be rejected before upload', async () => {
    await expect(uploadToR2('songs', '', Buffer.alloc(1))).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
  });
  it('runtime-unknown buckets must fail before issuing object upload', async () => {
    await expect(uploadToR2('unknown' as any, 'x', Buffer.alloc(1))).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
  });
  it('rejects repeated listing cursors instead of looping over an incomplete inventory', async () => {
    f.mockImplementation(async () => response({ success: true, result: [], result_info: { is_truncated: true, cursor: 'repeated' } }));
    await expect(listR2Objects('songs')).rejects.toThrow(/cursor/); expect(f).toHaveBeenCalledTimes(2);
  });
  it('strips worker credentials when an audio request redirects to a public origin', async () => {
    f.mockResolvedValueOnce(response('', { status: 302, headers: { location: 'https://cdn.invalid/x.wav' } }))
      .mockResolvedValueOnce(response('audio', { headers: { 'content-type': 'audio/wav' } }))
      .mockResolvedValueOnce(response({ success: true, result: { key: 'x' } }));
    await persistAudioToR2('songs', 'x', '/audio/x');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer test-worker-key');
    expect(f.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });
  it('rejects redirects into a private address before the destination fetch', async () => {
    f.mockResolvedValueOnce(response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(persistAudioToR2('songs', 'x', 'https://cdn.invalid/x')).rejects.toThrow(); expect(f).toHaveBeenCalledTimes(1);
  });
  it('times out even when the source transport ignores cancellation', async () => {
    vi.useFakeTimers(); vi.stubEnv('R2_REQUEST_TIMEOUT_MS', '20');
    f.mockImplementation(() => new Promise(() => {}));
    const failure = expect(persistAudioToR2('songs', 'x', '/audio/x')).rejects.toThrow('timed out');
    try { await vi.advanceTimersByTimeAsync(20); await failure; expect(f.mock.calls[0][1].signal.aborted).toBe(true); }
    finally { vi.useRealTimers(); }
  });
  it.each([0, -1, Infinity, NaN])('rejects invalid network timeout %s before fetch', async value => {
    vi.stubEnv('R2_REQUEST_TIMEOUT_MS', String(value));
    await expect(uploadToR2('songs', 'x', Buffer.alloc(1))).rejects.toThrow(/TIMEOUT/); expect(f).not.toHaveBeenCalled();
  });
  it('rejects HTTP-success upload errors without reporting a durable URL', async () => {
    f.mockResolvedValue(response({ success: false, errors: [{ message: 'denied' }] }));
    await expect(uploadToR2('songs', 'x', Buffer.alloc(1))).rejects.toThrow(/provider/);
  });
});
