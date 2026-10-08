import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { address } from '../../../app/node_modules/@solana/kit/dist/index.node.mjs';
import { createSolanaRpcFromNetwork, fetchSwigAccount } from '../../../app/src/lib/svm/swig';

const app = Fastify({ logger: false });
const config = address('So11111111111111111111111111111111111111112');
const network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
let response: { status: number; result?: unknown; error?: unknown };
app.post('/', async (request, reply) => {
  const { id } = request.body as { id: number };
  return reply.code(response.status).send({ jsonrpc: '2.0', id, ...(response.error ? { error: response.error } : { result: response.result }) });
});
const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
afterEach(() => { response = { status: 200 }; });
afterAll(() => app.close());

describe('Swig account lookup', () => {
  it('returns null only when the RPC confirms the account is absent', async () => {
    response = { status: 200, result: { context: { slot: 1 }, value: null } };
    expect(await fetchSwigAccount(createSolanaRpcFromNetwork(network, endpoint), config)).toBeNull();
  });

  it.each([
    { status: 429 },
    { status: 503 },
    { status: 200, error: { code: -32005, message: 'Node is behind' } },
  ])('preserves RPC failure %j instead of treating it as an absent account', async failure => {
    response = failure;
    await expect(fetchSwigAccount(createSolanaRpcFromNetwork(network, endpoint), config)).rejects.toThrow();
  });
});
