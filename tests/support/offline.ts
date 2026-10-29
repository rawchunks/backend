import { vi } from 'vitest';

// Unit tests never load real .env secrets or contact providers by accident.
// Live tests explicitly opt in and load only what each probe needs.
vi.mock('dotenv', async (importOriginal) => {
  if (process.env.RAWCHUNKS_LIVE === '1') return await importOriginal<typeof import('dotenv')>();
  return { config: vi.fn(() => ({ parsed: {} })), default: { config: vi.fn(() => ({ parsed: {} })) } };
});

if (process.env.RAWCHUNKS_LIVE !== '1') {
  for (const key of ['SONG_DATABASE_URL', 'USER_DATABASE_URL', 'ACESTEP_API_URL', 'ACESTEP_API_KEY', 'CF_API_TOKEN', 'CF_GLOBAL_TOKEN', 'CF_ACCOUNT_ID', 'VALKEY_REQUESTS_SERVICE_URI', 'VALKEY_URI', 'VALKEY_REQUESTS_HOST', 'VALKEY_REQUESTS_PASSWORD', 'PINATA_GATEWAY_URL']) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    SONG_DATABASE_URL: 'postgresql://test:test@db.invalid/test',
    USER_DATABASE_URL: 'postgresql://test:test@users.invalid/test',
    ACESTEP_API_URL: 'http://worker.invalid:8001',
    ACESTEP_API_KEY: 'test-worker-key',
    CF_GLOBAL_TOKEN: 'test-cloudflare-key',
    CF_ACCOUNT_ID: 'test-account',
    VALKEY_REQUESTS_SERVICE_URI: 'redis://127.0.0.1:1',
    PINATA_GATEWAY_URL: 'gateway.invalid',
    LOG_LEVEL: 'silent',
  });
}
