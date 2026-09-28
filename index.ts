import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { databaseRouter } from './databases/router.js';
import { generationRouter } from './generation/router.js';
import { editingRouter } from './editing/router.js';
import voiceRoutes from './voice/index.js';
import { voiceService } from './voice/service.js';
import { runMigrations } from './databases/migrate.js';
import { optionsRouter } from './options.js';
import { valkey, closeSubscriptions } from './broker/valkey.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const PORT = parseInt(process.env.PORT || '3005', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

let databaseReady = false;

async function main() {
  // Ensure database tables exist
  try {
    await runMigrations();
    databaseReady = true;
  } catch (err) {
    app.log.error(err, 'Failed to run database migrations at startup');
  }

  // Register CORS
  await app.register(cors, {
    origin: (process.env.CORS_ORIGINS || 'https://rawchunks.space,https://app.rawchunks.space,https://www.app.rawchunks.space,https://api.rawchunks.space,http://localhost:3001').split(',').map(origin => origin.trim()).filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Register Multipart for Audio & File Uploads (up to 50MB)
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
    },
  });

  // Register Swagger Documentation
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'RawChunks API',
        description: 'Production AI-Native Music Generation & DAW Editing Protocol (ACE-Step XL 1.5)',
        version: '1.0.0',
      },
      servers: [
        { url: 'https://api.rawchunks.space', description: 'Production API' },
        { url: 'http://localhost:3005', description: 'Local Development' },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Root & Health checks for GCP Load Balancer NEG and monitoring
  app.get('/', async () => ({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'rawchunks-api',
  }));

  app.get('/health', async (_request, reply) => {
    if (!databaseReady) reply.code(503);
    return {
      status: databaseReady ? 'healthy' : 'unavailable',
      timestamp: new Date().toISOString(),
      services: {
        databases: databaseReady ? 'connected' : 'unavailable',
        generation: 'ready',
        editing: 'ready',
        storage: 'r2-isolated',
      },
    };
  });

  // Register Namespaced Service Routes
  await app.register(optionsRouter, { prefix: '/api' });
  await app.register(databaseRouter, { prefix: '/api' });
  await app.register(generationRouter, { prefix: '/api/generation' });
  await app.register(editingRouter, { prefix: '/api/editing' });
  await app.register(voiceRoutes, { prefix: '/api/voices' });
  await app.register(voiceRoutes, { prefix: '/voices' });

  // Top-level clean one-word developer endpoints for external integrations & SDK
  const forward = (url: string) => async (req: any, reply: any) => {
    const res = await app.inject({
      method: req.method,
      url,
      query: req.query,
      payload: req.body,
      headers: req.headers,
    });
    return reply.code(res.statusCode).headers(res.headers).send(res.body);
  };

  app.post('/generate', forward('/api/generation/generate'));
  app.get('/status/:taskId', async (req: any, reply) => forward(`/api/generation/status/${encodeURIComponent(req.params.taskId)}`)(req, reply));
  app.get('/songs', forward('/api/songs'));
  app.post('/sample', forward('/api/generation/sample'));
  app.post('/format', forward('/api/generation/format'));
  app.post('/repaint', forward('/api/editing/repaint'));
  app.post('/layer', forward('/api/editing/layer'));
  app.post('/extend', forward('/api/editing/extend'));
  app.post('/remix', forward('/api/editing/remix'));
  app.post('/separate', forward('/api/editing/separate'));
  app.post('/voice', forward('/voices'));
  app.put('/user', forward('/api/user'));
  app.patch('/user/profile', forward('/api/user/profile'));
  app.put('/user/profile', forward('/api/user/profile'));
  app.post('/user/profile', forward('/api/user/profile'));
  app.get('/user/:address', async (req: any, reply: any) => {
    return forward(`/api/user/${encodeURIComponent(req.params.address)}`)(req, reply);
  });
  app.post('/user/consent', forward('/api/user/consent'));
  app.put('/user/consent', forward('/api/user/consent'));
  app.get('/user/consent/:address', async (req: any, reply: any) => {
    return forward(`/api/user/consent/${encodeURIComponent(req.params.address)}`)(req, reply);
  });

  app.addHook('onClose', async () => { await voiceService.stop(); await closeSubscriptions(); await valkey.quit(); });
  const shutdown = () => {
    void app.close().catch(error => {
      app.log.error(error, 'Failed to drain API connections');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  app.addHook('onClose', async () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    if (databaseReady) voiceService.start();
    app.log.info(`RawChunks Backend running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
