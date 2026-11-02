import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from './auth.js';
import { creditStore, type CreditLotSource } from './store.js';
import type { SessionPaymentConfig, SessionPaymentOptions, SessionPaymentResolver } from '../broker/payment.js';

interface Billing {
  owner: string;
  hold: string;
  network?: string;
  userAddress?: string;
  action?: string;
}
const context = new AsyncLocalStorage<Billing>();

async function buildBatchSettlementSignature(
  owner: string,
  userAddress: string,
  network: string,
  holdId: string,
): Promise<string> {
  const store = creditStore();
  const latestOp = await store.tx(async c =>
    (
      await c.query(
        "SELECT context FROM credit_operations WHERE environment=$1 AND owner=$2 AND kind='purchase' AND status IN ('credited','completed') ORDER BY updated_at DESC LIMIT 1",
        [store.environment, owner],
      )
    ).rows[0],
  ).catch(() => null);
  const coinflowPaymentId =
    typeof latestOp?.context?.coinflowPaymentId === 'string' ? latestOp.context.coinflowPaymentId : undefined;
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: 'batch-settlement',
      network,
      payload: {
        owner,
        userAddress,
        holdId,
        ...(coinflowPaymentId ? { coinflowPaymentId } : {}),
      },
    }),
  ).toString('base64');
}

export async function bindCreditTask(taskId: string, worker: any) {
  const billing = context.getStore();
  if (!billing) return;
  const store = creditStore();
  await store.tx(c =>
    c.query(
      'UPDATE credit_holds SET context=$3 WHERE environment=$1 AND id=$2 AND NOT closed',
      [
        store.environment,
        billing.hold,
        JSON.stringify({
          kind: worker.kind,
          taskId,
          worker,
          ...(billing.network ? { network: billing.network } : {}),
          ...(billing.userAddress ? { userAddress: billing.userAddress } : {}),
          ...(billing.action ? { action: billing.action } : {}),
        }),
      ],
    ),
  );
}

export async function admitCredits(
  req: FastifyRequest,
  reply: FastifyReply,
  resolver: SessionPaymentConfig | SessionPaymentResolver,
  options?: SessionPaymentOptions,
) {
  if (process.env.CREDITS_ENABLED !== 'true') {
    throw Object.assign(new Error('Prepaid Credits unavailable'), { statusCode: 503 });
  }
  const identity = await authenticate(req);
  const store = creditStore();
  const rawSource = req.headers['x-credit-source'];
  if (rawSource !== 'promo' && rawSource !== 'card') {
    throw Object.assign(new Error('Credit source (promo or card) required'), { statusCode: 400 });
  }
  const source: CreditLotSource = rawSource;

  const supplied = req.body as any;
  for (const name of ['userAddress', 'creatorAddress', 'creator']) {
    const value = supplied?.[name];
    if (typeof value === 'string' && !identity.addresses.includes(value.startsWith('0x') ? value.toLowerCase() : value)) {
      throw Object.assign(new Error('Operation owner is not authenticated'), { statusCode: 403 });
    }
  }

  let config: SessionPaymentConfig | null;
  if (options?.metered) {
    const { getSongById } = await import('../databases/songs.js');
    const song = await getSongById((req.params as any).id);
    if (!song) throw Object.assign(new Error('Song not found'), { statusCode: 404 });
    (req as any).song = song;
    if (identity.addresses.includes(song.creator.startsWith('0x') ? song.creator.toLowerCase() : song.creator)) {
      reply.header('x-creator-exempt', 'true');
      return;
    }
    if (source === 'promo') {
      throw Object.assign(
        new Error("Promo credits can't be used for Streaming and Licenses. Use your free credits to generate and edit your songs!"),
        { statusCode: 402 },
      );
    }
    const rate = Math.round(song.stream_price * 1000000);
    const durationMs = Math.ceil((song.duration || 0) * 1000);
    if (!Number.isSafeInteger(rate) || rate < 0 || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new Error('Streaming price or duration unavailable');
    }
    const maximum = (BigInt(rate) * BigInt(durationMs) + 59999n) / 60000n;
    if (!maximum) return;
    config = { amountWei: String(maximum), priceUsd: Number(maximum) / 1000000, action: 'stream-playback', creatorAddress: song.creator };
  } else {
    config = typeof resolver === 'function' ? await resolver(req) : resolver;
  }
  if (!config) return;

  const key = req.headers['x-idempotency-key'];
  const holdId = typeof key === 'string' && key.length <= 80 ? `crd:${identity.owner.slice(0, 18)}:${key}` : `crd:${randomUUID()}`;
  const hold = await store.reserve(identity.owner, source, holdId, BigInt(config.amountWei), req.url.split('?')[0], config.creatorAddress);
  if (hold.context && !options?.metered) {
    throw Object.assign(new Error('This operation has already been admitted'), { statusCode: 409 });
  }
  const requestedNetwork =
    typeof req.headers['x-network-id'] === 'string' && req.headers['x-network-id'].trim()
      ? req.headers['x-network-id'].trim()
      : undefined;
  const billing: Billing = {
    owner: identity.owner,
    hold: hold.id,
    network: requestedNetwork,
    userAddress: identity.userAddress,
    action: config.action,
  };
  (req as any).creditBilling = billing;
  (req as any).creditMetered = Boolean(options?.metered);
  (req as any).paymentIntentId = hold.id;
  if (options?.metered && !hold.context) {
    const song = (req as any).song;
    const streamNetwork = requestedNetwork || song.network;
    let composePaymentIntentId: string | undefined;
    if (process.env.COMPOSE_API_URL && streamNetwork) {
      const { prepareStreamPaymentIntent } = await import('../broker/payment.js');
      const paymentSignature = await buildBatchSettlementSignature(identity.owner, identity.userAddress, streamNetwork, hold.id);
      composePaymentIntentId = await prepareStreamPaymentIntent({
        token: `card:${hold.id}`,
        paymentSignature,
        holdOwner: identity.owner,
        holdId: hold.id,
        network: streamNetwork,
        userAddress: identity.userAddress,
        maxAmountWei: config.amountWei,
        songId: song.id,
        creatorAddress: song.creator,
        streamPriceUsd: song.stream_price,
        durationMs: Math.ceil(song.duration * 1000),
        idempotencyKey: hold.id,
      });
    }
    await store.tx(c =>
      c.query(
        'UPDATE credit_holds SET context=$3 WHERE environment=$1 AND id=$2 AND context IS NULL',
        [
          store.environment,
          hold.id,
          JSON.stringify({
            kind: 'stream',
            version: 1,
            songId: song.id,
            userAddress: identity.userAddress,
            ...(streamNetwork ? { network: streamNetwork } : {}),
            ...(composePaymentIntentId ? { paymentIntentId: composePaymentIntentId } : {}),
            rate: String(Math.round(song.stream_price * 1000000)),
            durationMs: Math.ceil(song.duration * 1000),
            startedAt: Date.now(),
          }),
        ],
      ),
    );
  }
  reply.header('x-credit-hold-id', hold.id);
}

export async function checkpointCredits(req: FastifyRequest) {
  const identity = await authenticate(req);
  const store = creditStore();
  const input = req.body as { paymentIntentId?: string; listenedSeconds?: number; terminal?: boolean };
  if (!input?.paymentIntentId || !Number.isFinite(input.listenedSeconds) || input.listenedSeconds! < 0) {
    throw Object.assign(new Error('Invalid playback checkpoint'), { statusCode: 400 });
  }
  const row = await store.tx(async c =>
    (
      await c.query(
        "SELECT * FROM credit_holds WHERE environment=$1 AND (id=$2 OR context->>'paymentIntentId'=$2) AND owner=$3",
        [store.environment, input.paymentIntentId, identity.owner],
      )
    ).rows[0],
  );
  if (!row || row.context?.kind !== 'stream' || row.context.version !== 1 || row.context.songId !== (req.params as any).id || !identity.addresses.includes(row.context.userAddress)) {
    throw Object.assign(new Error('Unknown playback operation'), { statusCode: 404 });
  }
  const requestedNetwork =
    typeof req.headers['x-network-id'] === 'string' && req.headers['x-network-id'].trim()
      ? req.headers['x-network-id'].trim()
      : undefined;
  const streamNetwork: string | undefined = requestedNetwork || row.context.network;
  if (row.context.paymentIntentId && process.env.COMPOSE_API_URL && streamNetwork) {
    const { settleStreamCheckpoint } = await import('../broker/payment.js');
    const receipt = await settleStreamCheckpoint({
      paymentIntentId: row.context.paymentIntentId,
      network: streamNetwork,
      listenedSeconds: input.listenedSeconds!,
      token: `card:${row.id}`,
      songId: row.context.songId,
      terminal: Boolean(input.terminal),
    });
    return { success: true, result: receipt };
  }
  const millis = Math.min(row.context.durationMs, Math.round(input.listenedSeconds! * 1000));
  const cumulative = (BigInt(millis) * BigInt(row.context.rate)) / 60000n;
  const result = await store.commit(identity.owner, row.id, cumulative, millis);
  if (input.terminal) await store.release(identity.owner, row.id);
  const billedAtomics = BigInt(result.billedWei || '0');
  if (billedAtomics > 0n && row.context.songId) {
    Promise.all([
      import('../databases/songs.js'),
      import('../databases/earnings.js'),
    ])
      .then(async ([{ getSongById }, { recordSongEarning }]) => {
        const song = await getSongById(row.context.songId);
        const earningNetwork = streamNetwork || song?.network;
        if (!song || !earningNetwork) return;
        await recordSongEarning({
          id: `crd:${row.id}`,
          songId: song.id,
          creator: song.creator,
          network: earningNetwork,
          kind: 'stream',
          grossAtomics: billedAtomics,
          creatorAtomics: (billedAtomics * 80n) / 100n,
          payer: identity.userAddress,
        });
      })
      .catch(() => {});
  }
  return { success: true, result: { billedWei: result.billedWei, deltaWei: result.deltaWei, acceptedListenedSeconds: result.acceptedMs / 1000, status: 'credited' } };
}

export function installCreditBilling(app: FastifyInstance) {
  app.addHook('onRoute', route => {
    const original = route.handler;
    route.handler = function (req, reply) {
      const billing = (req as any).creditBilling as Billing | undefined;
      return billing ? context.run(billing, () => original.call(this, req, reply)) : original.call(this, req, reply);
    };
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const billing = (req as any).creditBilling as Billing | undefined;
    if (!billing || (req as any).creditMetered) return payload;
    const store = creditStore();
    const row = await store.tx(async c => (await c.query('SELECT * FROM credit_holds WHERE environment=$1 AND id=$2', [store.environment, billing.hold])).rows[0]);
    if (reply.statusCode >= 400 && !row.context) await store.release(billing.owner, billing.hold);
    else if (reply.statusCode < 400 && !row.context) {
      await store.commit(billing.owner, billing.hold, BigInt(row.maximum));
      await store.release(billing.owner, billing.hold);
      if (row.credit_source === 'card' && process.env.COMPOSE_API_URL && billing.network && billing.userAddress) {
        const network = billing.network;
        const userAddress = billing.userAddress;
        const action = billing.action || 'vibe';
        setImmediate(async () => {
          try {
            const { settleSessionPaymentAsync } = await import('../broker/payment.js');
            const paymentSignature = await buildBatchSettlementSignature(billing.owner, userAddress, network, row.id);
            await settleSessionPaymentAsync({
              token: `card:${row.id}`,
              paymentSignature,
              network,
              userAddress,
              amountWei: String(row.maximum),
              action,
              resource: row.resource,
              method: req.method,
              creatorAddress: row.creator || undefined,
            });
          } catch {
            // Non-blocking background settlement
          }
        });
      }
    }
    return payload;
  });
}

export async function recoverCreditServices() {
  const store = creditStore();
  const rows = await store.tx(c =>
    c.query('SELECT * FROM credit_holds WHERE environment=$1 AND NOT closed AND owner IS NOT NULL ORDER BY created_at LIMIT 30', [store.environment]),
  );
  for (const hold of rows.rows) {
    if (!hold.context) {
      if (Date.now() - new Date(hold.created_at).getTime() > 15 * 60000) await store.release(hold.owner, hold.id);
      continue;
    }
    if (hold.context.kind === 'stream') {
      if (Date.now() - hold.context.startedAt > hold.context.durationMs + 10 * 60000) await store.release(hold.owner, hold.id);
      continue;
    }
    const { getTaskContext } = await import('../broker/valkey.js');
    let task = await getTaskContext<any>(hold.context.taskId);
    if (!task?.result && task) {
      if (task.kind === 'generate') {
        const { generationService } = await import('../generation/service.js');
        await generationService.checkStatusAndFinalize(hold.context.taskId, task.songId);
      } else if (task.kind === 'edit') {
        const { editingService } = await import('../editing/service.js');
        await editingService.finalizeEditResult({ ...task.params, taskId: hold.context.taskId });
      }
      task = await getTaskContext<any>(task.workerTaskId || hold.context.taskId);
    }
    if (task?.result?.status === 'ready') {
      await store.commit(hold.owner, hold.id, BigInt(hold.maximum));
      await store.release(hold.owner, hold.id);
      const network = hold.context?.network || task?.params?.network;
      const userAddress = hold.context?.userAddress || task?.params?.userAddress || task?.params?.creatorAddress || hold.owner;
      if (hold.credit_source === 'card' && process.env.COMPOSE_API_URL && typeof network === 'string' && network) {
        try {
          const { settleSessionPaymentAsync } = await import('../broker/payment.js');
          const paymentSignature = await buildBatchSettlementSignature(hold.owner, userAddress, network, hold.id);
          void settleSessionPaymentAsync({
            token: `card:${hold.id}`,
            paymentSignature,
            network,
            userAddress,
            amountWei: String(hold.maximum),
            action: hold.context?.action || hold.context?.kind || 'generate',
            resource: hold.resource,
            method: 'POST',
            creatorAddress: hold.creator || undefined,
          });
        } catch {
          // Non-blocking background settlement
        }
      }
    } else if (task?.result?.status === 'error') {
      await store.release(hold.owner, hold.id);
    }
  }
}
