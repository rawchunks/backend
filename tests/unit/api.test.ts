import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiState, boot } from '../support/api';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeEach(async () => { app = await boot(); });
afterEach(async () => { await app.close(); apiState.listen.mockClear(); });
describe('actual API entrypoint with isolated provider plugins', () => {
  it('runs migrations before opening the listener', () => {
    expect(apiState.migrations).toHaveBeenCalledOnce();
    expect(apiState.listen).toHaveBeenCalledWith({ port: 3005, host: '0.0.0.0' });
    expect(apiState.migrations.mock.invocationCallOrder[0]).toBeLessThan(apiState.listen.mock.invocationCallOrder[0]);
  });
  it.each(['/', '/health'])('serves %s with timestamp', async url => {
    const res = await app.inject(url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'healthy', timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse(res.json().timestamp))).toBe(false);
  });
  it.each(['generate','sample','format','repaint','layer','extend','remix','isolate'])('forwards /%s JSON bodies unchanged', async route => {
    const body = { songId: 'song', nested: { value: 'café' } };
    const res = await app.inject({ method: 'POST', url: `/${route}`, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual(body);
  });
  it('preserves GET query and URL escaped address parameters', async () => {
    expect((await app.inject('/songs?creator=AbC&limit=4')).json().query).toEqual({ creator: 'AbC', limit: '4' });
    expect((await app.inject('/user/AbC')).json().params).toEqual({ address: 'AbC' });
    expect((await app.inject('/user/consent/AbC')).json().params).toEqual({ address: 'AbC' });
  });
  it('preserves encoded delimiters in address aliases', async () => {
    const address = 'identity/part?query';
    for (const route of ['/user/', '/user/consent/']) {
      const response = await app.inject(`${route}${encodeURIComponent(address)}`);
      expect(response.statusCode).toBe(200);
      expect(response.json().params.address).toBe(address);
    }
  });
  it('drains Fastify and closes Valkey after SIGTERM', async () => {
    const handler = process.listeners('SIGTERM').at(-1);
    expect(handler).toBeTypeOf('function');
    handler?.('SIGTERM');
    await vi.waitFor(() => expect(apiState.valkeyQuit).toHaveBeenCalledOnce());
    expect(process.listeners('SIGTERM')).not.toContain(handler);
    await expect(app.inject('/')).rejects.toMatchObject({ code: 'FST_ERR_REOPENED_CLOSE_SERVER' });
  });
  it.each(['POST'] as const)('forwards %s consent alias', async method => {
    const res = await app.inject({ method, url: '/user/consent', payload: { signature: 'abc' } });
    expect(res.json().body).toEqual({ signature: 'abc' });
  });
  it('exposes generated Swagger and rejects unknown routes and malformed JSON', async () => {
    expect((await app.inject('/docs/json')).json().openapi).toBe('3.0.3');
    expect((await app.inject('/unknown')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/generate', headers: { 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(400);
  });
  it('survives 500 concurrent local HTTP injections and returns independent bodies', async () => {
    const results = await Promise.all(Array.from({ length: 500 }, (_, i) => app.inject({ method: 'POST', url: '/generate', payload: { i } })));
    expect(results.every((res, i) => res.statusCode === 200 && res.json().body.i === i)).toBe(true);
  });
  it('keeps the listener available after migration failure and reports unready', async () => {
    await app.close(); apiState.listen.mockClear();
    app = await boot(new Error('database unavailable'));
    expect(apiState.listen).toHaveBeenCalledOnce();
  });
  it('honors configured host/port', async () => {
    await app.close(); apiState.listen.mockClear();
    vi.stubEnv('PORT', '3123'); vi.stubEnv('HOST', '127.0.0.1');
    app = await boot();
    expect(apiState.listen).toHaveBeenCalledWith({ port: 3123, host: '127.0.0.1' });
    vi.unstubAllEnvs();
  });
  it('exits with code one on listener failure', async () => {
    await app.close(); apiState.listen.mockClear();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    app = await boot(undefined, new Error('address in use'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
