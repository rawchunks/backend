import { afterEach, describe, expect, it } from 'vitest';
import { apiState, boot } from '../support/api';

afterEach(async () => { await apiState.app?.close(); apiState.listen.mockClear(); });
describe('API routing and readiness', () => {
  it('routes the public PUT consent alias to a supported inner method', async () => {
    const app = await boot();
    const res = await app.inject({ method: 'PUT', url: '/user/consent', payload: { signature: 'abc' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ signature: 'abc' });
  });
  it('preserves the task id in the public status alias', async () => {
    const app = await boot();
    const res = await app.inject('/status/task-123?songId=song-1');
    expect(res.json().params.taskId).toBe('task-123');
  });
  it('does not report database connected after startup migration failure', async () => {
    const app = await boot(new Error('database unavailable'));
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(503);
    expect(res.json().services?.databases).not.toBe('connected');
  });
  it('allows API access from any frontend origin without enabling browser credentials', async () => {
    const app = await boot();
    for (const origin of ['https://app.rawchunks.space', 'https://rawchunks.vercel.app', 'https://another-host.invalid', 'http://localhost:3001']) {
      const res = await app.inject({ method: 'OPTIONS', url: '/api/user/consent', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-session-user-address' } });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['access-control-allow-headers']).toContain('x-session-user-address');
    }
  });
  it.each(['/sync', '/api/sync'])('has no reconciliation route at %s', async url => {
    const app = await boot();
    for (const method of ['GET', 'POST'] as const) expect((await app.inject({ method, url })).statusCode).toBe(404);
  });
});
