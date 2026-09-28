import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const apiState = vi.hoisted(() => ({ app: null as FastifyInstance | null, listen: vi.fn(), migrations: vi.fn(), valkeyQuit: vi.fn() }));
export { apiState };

vi.mock('fastify', async (original) => {
  const actual = await original<typeof import('fastify')>();
  return { ...actual, default: (...args: any[]) => {
    const app = actual.default(...args);
    apiState.app = app;
    app.listen = apiState.listen as any;
    return app;
  } };
});
vi.mock('../../databases/migrate.js', () => ({ runMigrations: apiState.migrations }));
vi.mock('../../broker/valkey.js', () => ({ valkey: { quit: apiState.valkeyQuit }, closeSubscriptions: async () => {} }));
vi.mock('../../databases/router.js', () => ({ databaseRouter: async (app: FastifyInstance) => {
  app.get('/songs', async req => ({ query: req.query }));
  app.put('/user', async req => ({ body: req.body }));
  app.post('/user/consent', async req => ({ body: req.body }));
  app.put('/user/consent', async req => ({ body: req.body }));
  app.get('/user/:address', async req => ({ params: req.params }));
  app.get('/user/consent/:address', async req => ({ params: req.params }));
} }));
vi.mock('../../generation/router.js', () => ({ generationRouter: async (app: FastifyInstance) => {
  for (const route of ['generate', 'sample', 'format']) app.post(`/${route}`, async req => ({ body: req.body, query: req.query }));
  app.get('/status/:taskId', async req => ({ params: req.params, query: req.query }));
} }));
vi.mock('../../editing/router.js', () => ({ editingRouter: async (app: FastifyInstance) => {
  for (const route of ['repaint', 'layer', 'extend', 'remix', 'separate']) app.post(`/${route}`, async req => ({ body: req.body }));
} }));
vi.mock('../../voice/service.js', () => ({ voiceService: { start: vi.fn(), stop: vi.fn(async () => {}) } }));
vi.mock('../../voice/index.js', () => ({ default: async (app: FastifyInstance) => {
  app.post('/', async req => ({ body: req.body }));
} }));

export async function boot(migrationError?: Error, listenError?: Error) {
  vi.resetModules();
  if (listenError) apiState.listen.mockRejectedValue(listenError);
  else apiState.listen.mockResolvedValue('http://127.0.0.1:3005');
  apiState.migrations.mockReset();
  apiState.valkeyQuit.mockReset().mockResolvedValue('OK');
  if (migrationError) apiState.migrations.mockRejectedValue(migrationError);
  else apiState.migrations.mockResolvedValue(undefined);
  await import('../../index.js');
  await vi.waitFor(() => { if (!apiState.listen.mock.calls.length) throw Error('boot pending'); });
  await apiState.app!.ready();
  return apiState.app!;
}
