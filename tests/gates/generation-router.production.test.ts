import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ initiateGeneration: vi.fn(), checkStatusAndFinalize: vi.fn(), formatInput: vi.fn(), createSample: vi.fn() }));
vi.mock('../../generation/service.js', () => ({ generationService: { initiateGeneration: m.initiateGeneration, checkStatusAndFinalize: m.checkStatusAndFinalize } }));
vi.mock('../../generation/client.js', () => ({ acestepClient: { formatInput: m.formatInput, createSample: m.createSample } }));
import { generationRouter } from '../../generation/router.js';
let app: FastifyInstance;
const base = { creatorAddress: '0x1234567890', prompt: 'a soulful song' };
beforeEach(async () => { vi.resetAllMocks(); app = Fastify(); await app.register(generationRouter, { prefix: '/api' }); m.initiateGeneration.mockResolvedValue({ status: 'pending' }); m.formatInput.mockResolvedValue({}); m.createSample.mockResolvedValue({}); });
afterEach(async () => { await app.close(); vi.restoreAllMocks(); });
describe('generation API validation and dispatch fidelity', () => {
  it('preserves saved voiceId instead of stripping the clone selection from generation', async () => {
    await app.inject({ method: 'POST', url: '/api/generate', payload: { ...base, voiceId: 'voice-1', voiceMode: 'trained' } });
    expect(m.initiateGeneration).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'voice-1', voiceMode: 'trained' }));
  });
  it('rejects a whitespace-only generation prompt', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/generate', payload: { ...base, prompt: '   ' } })).statusCode).toBe(400);
    expect(m.initiateGeneration).not.toHaveBeenCalled();
  });
  it('reports an operational dispatch failure as a server error instead of blaming valid input', async () => {
    m.initiateGeneration.mockRejectedValue(new Error('worker connection refused'));
    expect((await app.inject({ method: 'POST', url: '/api/generate', payload: base })).statusCode).toBeGreaterThanOrEqual(500);
  });
  it.each([null, { prompt: 23 }, { prompt: ['caption'] }, { prompt: '   ' }, { prompt: 'caption', lyrics: false }])('rejects invalid formatting body %j before contacting the worker', async payload => {
    const result = await app.inject({ method: 'POST', url: '/api/format', payload });
    expect(result.statusCode).toBe(400); expect(m.formatInput).not.toHaveBeenCalled();
  });
  it.each([null, { query: 123 }, { instrumental: 'false' }, { vocalLanguage: 42 }])('rejects invalid sample body %j before contacting the worker', async payload => {
    const result = await app.inject({ method: 'POST', url: '/api/sample', payload });
    expect(result.statusCode).toBe(400); expect(m.createSample).not.toHaveBeenCalled();
  });
});
