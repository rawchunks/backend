import { describe, it, expect, vi, beforeEach } from 'vitest';
import fastify from 'fastify';
import {
  requireSessionPayment,
  parseComposeToken,
  buildPaymentRequiredHeader,
  extractSessionToken,
  settleSessionPaymentAsync,
} from '../../broker/payment.js';

function createMockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = 'mock_signature';
  return `compose-${header}.${body}.${sig}`;
}

describe('Session Gate (Zero Latency Payment Wrapper)', () => {
  beforeEach(() => {
    process.env.RAWCHUNKS_TREASURY_ADDRESS = '0x974A6e338a397e52E69A50dAEa131F7FDFED4332';
    process.env.RAWCHUNKS_SOLANA_TREASURY_ADDRESS = '139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq';
    process.env.COMPOSE_API_URL = 'https://api.compose.market';
  });
  it('extracts session token from Bearer authorization or x-key-token', () => {
    const token = createMockJwt({ sub: '0x123', keyId: 'k1' });

    const req1: any = { headers: { authorization: `Bearer ${token}` } };
    expect(extractSessionToken(req1)).toBe(token);

    const req2: any = { headers: { authorization: token } };
    expect(extractSessionToken(req2)).toBe(token);

    const req3: any = { headers: { 'x-key-token': token } };
    expect(extractSessionToken(req3)).toBe(token);

    const req4: any = { headers: {} };
    expect(extractSessionToken(req4)).toBeNull();
  });

  it('parses compose token in memory with zero network latency', () => {
    const payload = {
      sub: '0x1234567890abcdef1234567890abcdef12345678',
      keyId: 'key-test-uuid',
      network: 'eip155:8453',
      budgetLimit: 100000,
      budgetUsed: 10000,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = createMockJwt(payload);
    const parsed = parseComposeToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed?.sub).toBe(payload.sub);
    expect(parsed?.keyId).toBe(payload.keyId);
    expect(parsed?.budgetLimit).toBe(100000);
    expect(parsed?.budgetUsed).toBe(10000);
  });

  it('rejects a session from another network before allowing a Tempo endpoint request', async () => {
    const app = fastify();
    const run = vi.fn(async () => ({ ok: true }));
    app.post('/generate', { preHandler: [requireSessionPayment({ amountWei: '50000', priceUsd: 0.05, action: 'generate' })] }, run);
    const token = createMockJwt({ sub: '0x2222222222222222222222222222222222222222', keyId: 'wrong-network', network: 'eip155:8453', budgetLimit: 1000000, budgetUsed: 0 });
    const res = await app.inject({ method: 'POST', url: '/generate', headers: { authorization: `Bearer ${token}`, 'x-network-id': 'eip155:42431' } });
    expect(res.statusCode).toBe(401);
    expect(run).not.toHaveBeenCalled();
    await app.close();
  });

  it('carries the Moderato session and universal address through Rawchunks prepare and settle', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(body.paymentIntentId ? { status: 'confirmed', txHash: '0x01' } : { paymentIntentId: 'tempo-intent' }));
    });
    try {
      const address = '0x2222222222222222222222222222222222222222';
      const token = createMockJwt({ sub: address, keyId: 'tempo-session', network: 'eip155:42431', budgetLimit: 1000000, budgetUsed: 0 });
      await settleSessionPaymentAsync({ token, network: 'eip155:42431', userAddress: address, amountWei: '50000', action: 'generate', resource: '/api/generation/generate', method: 'POST' });
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const call of fetch.mock.calls) expect(call[1]?.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'x-network-id': 'eip155:42431', 'x-session-user-address': address });
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ service: 'rawchunks', maxAmountWei: '50000', payTo: process.env.RAWCHUNKS_TREASURY_ADDRESS });
      expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({ paymentIntentId: 'tempo-intent', finalAmountWei: '50000', executeImmediately: true });
    } finally { fetch.mockRestore(); }
  });

  it('returns 402 with PAYMENT-REQUIRED header when token is missing', async () => {
    const app = fastify();
    app.post('/api/generation/generate', {
      preHandler: [requireSessionPayment({ amountWei: '50000', priceUsd: 0.05, action: 'generation-fast' })],
    }, async () => ({ status: 'ok' }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/generation/generate',
      headers: { 'x-network-id': 'eip155:8453', 'x-test-require-session': 'true' },
    });

    expect(res.statusCode).toBe(402);
    expect(res.headers['payment-required']).toBeDefined();

    const decodedHeader = JSON.parse(Buffer.from(res.headers['payment-required'] as string, 'base64').toString());
    expect(decodedHeader.x402Version).toBe(2);
    expect(decodedHeader.accepts[0].amount).toBe('50000');
    expect(decodedHeader.accepts[0].network).toBe('eip155:8453');
  });

  it('charges $0.05 (50000 wei) for Fast (Turbo) generation and updates budget headers', async () => {
    const app = fastify();
    const generationPricing = (req: any) => req.body?.modelVariant === 'sft'
      ? { amountWei: '100000', priceUsd: 0.1, action: 'generation-master' }
      : { amountWei: '50000', priceUsd: 0.05, action: 'generation-fast' };

    app.post('/generate', {
      preHandler: [requireSessionPayment(generationPricing)],
    }, async (req) => ({
      status: 'accepted',
      user: req.headers['x-session-user-address'],
    }));

    const token = createMockJwt({
      sub: '0xUserTurboWalletAddress',
      keyId: 'turbo-key-1',
      network: 'eip155:8453',
      budgetLimit: 100000,
      budgetUsed: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const start = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        modelVariant: 'turbo',
        prompt: 'acid techno synthwave',
      },
    });
    const duration = performance.now() - start;

    expect(res.statusCode).toBe(200);
    // In-memory verification adds virtually zero latency
    expect(duration).toBeLessThan(100);
    expect(res.headers['x-session-budget-limit']).toBe('100000');
    expect(res.headers['x-session-budget-used']).toBe('50000');
    expect(res.headers['x-session-budget-remaining']).toBe('50000');

    const body = JSON.parse(res.body);
    expect(body.user).toBe('0xUserTurboWalletAddress');
  });

  it('charges $0.1 (100000 wei) for Master (SFT) generation', async () => {
    const app = fastify();
    const generationPricing = (req: any) => req.body?.modelVariant === 'sft'
      ? { amountWei: '100000', priceUsd: 0.1, action: 'generation-master' }
      : { amountWei: '50000', priceUsd: 0.05, action: 'generation-fast' };

    app.post('/generate', {
      preHandler: [requireSessionPayment(generationPricing)],
    }, async (req) => ({ status: 'accepted' }));

    const token = createMockJwt({
      sub: '0xUserSftWalletAddress',
      keyId: 'sft-key-1',
      network: 'eip155:8453',
      budgetLimit: 100000,
      budgetUsed: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        modelVariant: 'sft',
        prompt: 'master orchestral score',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-session-budget-limit']).toBe('100000');
    expect(res.headers['x-session-budget-used']).toBe('100000');
    expect(res.headers['x-session-budget-remaining']).toBe('0');
  });

  it('charges $0.05 (50000 wei) for voice clone / upload', async () => {
    const app = fastify();
    const voicePrice = { amountWei: '50000', priceUsd: 0.05, action: 'voice-train' };

    app.post('/api/voices', {
      preHandler: [requireSessionPayment(voicePrice)],
    }, async () => ({ status: 'cloned' }));

    const token = createMockJwt({
      sub: '0xVoiceUser',
      keyId: 'voice-key-1',
      network: 'eip155:8453',
      budgetLimit: 100000,
      budgetUsed: 10000,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/voices',
      headers: { authorization: `Bearer ${token}` },
      payload: { songId: 's1', creator: '0xVoiceUser' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-session-budget-used']).toBe('60000');
    expect(res.headers['x-session-budget-remaining']).toBe('40000');
  });

  it('charges $0.02 (20000 wei) for individual editing actions', async () => {
    const app = fastify();
    const editPrice = { amountWei: '20000', priceUsd: 0.02, action: 'edit-repaint' };

    app.post('/api/editing/repaint', {
      preHandler: [requireSessionPayment(editPrice)],
    }, async () => ({ status: 'repainted' }));

    const token = createMockJwt({
      sub: '0xEditUser',
      keyId: 'edit-key-1',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      budgetLimit: 50000,
      budgetUsed: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/editing/repaint',
      headers: { authorization: `Bearer ${token}` },
      payload: { songId: 's1', start: 0, end: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-session-budget-used']).toBe('20000');
    expect(res.headers['x-session-budget-remaining']).toBe('30000');
  });

  it('rejects when budget is exhausted', async () => {
    const app = fastify();
    app.post('/generate', {
      preHandler: [requireSessionPayment({ amountWei: '20000', priceUsd: 0.02, action: 'generation-master' })],
    }, async () => ({ status: 'ok' }));

    const token = createMockJwt({
      sub: '0xExhaustedUser',
      keyId: 'exhausted-key',
      network: 'eip155:8453',
      budgetLimit: 10000, // Only 10000 available
      budgetUsed: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Insufficient session budget');
  });

  it('rejects expired session tokens with 401', async () => {
    const app = fastify();
    app.post('/generate', {
      preHandler: [requireSessionPayment({ amountWei: '50000', priceUsd: 0.05, action: 'generation-fast' })],
    }, async () => ({ status: 'ok' }));

    const token = createMockJwt({
      sub: '0xExpiredUser',
      keyId: 'expired-key',
      network: 'eip155:8453',
      budgetLimit: 100000,
      budgetUsed: 0,
      exp: Math.floor(Date.now() / 1000) - 60, // expired 1 min ago
    });

    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Compose session has expired');
  });

  it('settleSessionPaymentAsync dispatches prepare with payTo and settle with executeImmediately', async () => {
    process.env.RAWCHUNKS_TREASURY_ADDRESS = '0x974A6e338a397e52E69A50dAEa131F7FDFED4332';
    const fetchCalls: Array<{ url: string; body: any }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const parsedBody = JSON.parse(init.body);
      fetchCalls.push({ url: String(url), body: parsedBody });
      if (String(url).endsWith('/api/payments/prepare')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ paymentIntentId: 'pi-12345' }),
        } as any;
      }
      if (String(url).endsWith('/api/payments/settle')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'confirmed', txHash: '0xabc123' }),
        } as any;
      }
      return { ok: false, status: 500 } as any;
    });

    try {
      process.env.COMPOSE_API_URL = 'https://api.compose.market';
      await settleSessionPaymentAsync({
        token: 'test-token',
        network: 'eip155:8453',
        userAddress: '0xUserAddress',
        amountWei: '10000',
        action: 'generate',
        resource: 'https://api.rawchunks.space/v1/generate',
        method: 'POST',
      });

      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[0].url).toContain('/api/payments/prepare');
      expect(fetchCalls[0].body.payTo).toBe('0x974A6e338a397e52E69A50dAEa131F7FDFED4332');
      expect(fetchCalls[0].body.maxAmountWei).toBe('10000');

      expect(fetchCalls[1].url).toContain('/api/payments/settle');
      expect(fetchCalls[1].body.paymentIntentId).toBe('pi-12345');
      expect(fetchCalls[1].body.finalAmountWei).toBe('10000');
      expect(fetchCalls[1].body.executeImmediately).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe('Streaming Playback (x402 with Creator Exemption)', () => {
    const mockSong = {
      id: 'sng-acid-test',
      title: 'Acid Odyssey',
      creator: '0xCreatorAddress1111111111111111111111111111',
      stream_price: 0.03, // $0.03 / min => 30000 wei
      url: 'https://r2.rawchunks.space/audio/acid.mp3',
      duration: 180,
    };

    const streamResolver = async (req: any) => {
      const token = extractSessionToken(req);
      const payload = token ? parseComposeToken(token) : null;
      const user = req.headers['x-session-user-address'] || payload?.sub;

      // Creator check
      if (user && user.toLowerCase() === mockSong.creator.toLowerCase()) {
        return null; // Exempt!
      }

      return {
        amountWei: Math.round(mockSong.stream_price * 1_000_000).toString(),
        priceUsd: mockSong.stream_price,
        action: 'stream-playback',
        creatorAddress: mockSong.creator,
      };
    };

    it('exempts creator from payment for streaming their own song', async () => {
      const app = fastify();
      app.get('/songs/:id/stream', {
        preHandler: [requireSessionPayment(streamResolver)],
      }, async (req, reply) => {
        const isExempt = reply.getHeader('x-creator-exempt') === 'true';
        return reply.send({ exempt: isExempt, url: mockSong.url });
      });

      // Creator calls with their session token
      const creatorToken = createMockJwt({
        sub: mockSong.creator,
        keyId: 'creator-key',
        network: 'eip155:8453',
        budgetLimit: 50000,
        budgetUsed: 0,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/songs/sng-acid-test/stream',
        headers: { authorization: `Bearer ${creatorToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-creator-exempt']).toBe('true');
      // No budget deducted for creator!
      expect(res.headers['x-session-budget-used']).toBeUndefined();
      const body = JSON.parse(res.body);
      expect(body.exempt).toBe(true);
      expect(body.url).toBe(mockSong.url);
    });

    it('requires payment and returns 402 with dynamic price for non-creator without session', async () => {
      process.env.RAWCHUNKS_TREASURY_ADDRESS = '0x974A6e338a397e52E69A50dAEa131F7FDFED4332';
      const app = fastify();
      app.get('/songs/:id/stream', {
        preHandler: [requireSessionPayment(streamResolver)],
      }, async (req, reply) => reply.send({ ok: true }));

      const res = await app.inject({
        method: 'GET',
        url: '/songs/sng-acid-test/stream',
        headers: {
          'x-network-id': 'eip155:8453',
          'x-test-require-session': 'true',
        },
      });

      expect(res.statusCode).toBe(402);
      expect(res.headers['payment-required']).toBeDefined();

      const decoded = JSON.parse(Buffer.from(res.headers['payment-required'] as string, 'base64').toString());
      expect(decoded.x402Version).toBe(2);
      // Dynamic price from song.stream_price ($0.03 = 30000 wei)
      expect(decoded.accepts[0].amount).toBe('30000');
      expect(decoded.accepts[0].network).toBe('eip155:8453');
      expect(decoded.accepts[0].payTo).toBe('0x974A6e338a397e52E69A50dAEa131F7FDFED4332');

      const body = JSON.parse(res.body);
      expect(body.pricing.creatorAddress).toBe(mockSong.creator);
      expect(body.pricing.amountWei).toBe('30000');
    });

    it('charges non-creator dynamic stream_price and updates budget headers', async () => {
      const app = fastify();
      app.get('/songs/:id/stream', {
        preHandler: [requireSessionPayment(streamResolver)],
      }, async (req, reply) => {
        return reply.send({ url: mockSong.url });
      });

      const listenerToken = createMockJwt({
        sub: '0xNonCreatorListenerAddress',
        keyId: 'listener-key-1',
        network: 'eip155:8453',
        budgetLimit: 100000,
        budgetUsed: 0,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/songs/sng-acid-test/stream',
        headers: { authorization: `Bearer ${listenerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-session-budget-limit']).toBe('100000');
      expect(res.headers['x-session-budget-used']).toBe('30000'); // 30000 wei charged
      expect(res.headers['x-session-budget-remaining']).toBe('70000');
    });

    it('rejects with 400 when network is missing and no fallback is used', async () => {
      const app = fastify();
      app.get('/songs/:id/stream', {
        preHandler: [requireSessionPayment(streamResolver)],
      }, async (req, reply) => reply.send({ ok: true }));

      const res = await app.inject({
        method: 'GET',
        url: '/songs/sng-acid-test/stream',
        headers: {
          'x-test-require-session': 'true',
          // intentionally omit x-network-id
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('x-network-id header is required');
    });

    it('enforces payment on /stream/:id alias identically to /songs/:id/stream', async () => {
      const app = fastify();
      app.get('/stream/:id', {
        preHandler: [requireSessionPayment(streamResolver)],
      }, async (req, reply) => reply.send({ ok: true, url: mockSong.url }));

      const unauthRes = await app.inject({
        method: 'GET',
        url: '/stream/sng-acid-test',
        headers: {
          'x-network-id': 'eip155:8453',
          'x-test-require-session': 'true',
        },
      });
      expect(unauthRes.statusCode).toBe(402);

      const listenerToken = createMockJwt({
        sub: '0xNonCreatorListenerAddress',
        keyId: 'listener-key-2',
        network: 'eip155:8453',
        budgetLimit: 100000,
        budgetUsed: 0,
      });

      const authRes = await app.inject({
        method: 'GET',
        url: '/stream/sng-acid-test',
        headers: { authorization: `Bearer ${listenerToken}` },
      });
      expect(authRes.statusCode).toBe(200);
      expect(authRes.headers['x-session-budget-used']).toBe('30000');
    });

    it('protects public song catalog from leaking naked storage URLs', async () => {
      const rawSongs = [mockSong];
      const protectedCatalog = rawSongs.map(song => ({
        ...song,
        url: `/api/songs/${song.id}/stream`,
      }));

      expect(protectedCatalog[0].url).toBe('/api/songs/sng-acid-test/stream');
      expect(protectedCatalog[0].url).not.toContain('r2.dev');
    });
  });
});
