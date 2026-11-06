import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, resolveCreditOwner } from './auth.js';
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

const cardComposeSessionCache = new Map<string, { token: string; userAddress: string; expiresAt: number }>();

function composeSessionCacheKey(network: string, userAddress: string): string {
  return `${network}:${userAddress.startsWith('0x') ? userAddress.toLowerCase() : userAddress}`;
}

export function invalidateCardComposeSession(network: string, userAddress: string): void {
  if (!network || !userAddress) return;
  cardComposeSessionCache.delete(composeSessionCacheKey(network, userAddress));
}

async function resolveCardComposeSession(
  network: string,
  userAddress?: string,
  requiredAmountWei?: string,
  forceRefresh = false,
): Promise<{ token: string; userAddress: string } | null> {
  const composeUrl = (process.env.COMPOSE_API_URL || '').replace(/\/+$/, '');
  if (!composeUrl || !network || !userAddress) return null;

  const isSolana = network.startsWith('solana:');
  if (isSolana ? userAddress.startsWith('0x') : !userAddress.startsWith('0x')) {
    return null;
  }

  const minRequired =
    requiredAmountWei && /^\d+$/.test(requiredAmountWei) && BigInt(requiredAmountWei) > 0n
      ? BigInt(requiredAmountWei)
      : 100000n;
  const cacheKey = composeSessionCacheKey(network, userAddress);

  if (forceRefresh) {
    cardComposeSessionCache.delete(cacheKey);
  } else {
    const cached = cardComposeSessionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return { token: cached.token, userAddress: cached.userAddress };
    }
  }

  try {
    if (!forceRefresh) {
      const sesRes = await fetch(`${composeUrl}/api/session`, {
        headers: {
          'x-session-user-address': userAddress,
          'x-network-id': network,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (sesRes.ok) {
        const sesData = (await sesRes.json()) as any;
        const existingToken = sesData?.token || sesData?.session?.token;
        const remaining = BigInt(sesData?.budgetRemaining || sesData?.session?.budgetRemaining || '0');
        const expiresAt = Number(sesData?.expiresAt || sesData?.session?.expiresAt) || Date.now() + 600000;
        if (sesData?.hasSession && typeof existingToken === 'string' && existingToken && remaining >= minRequired) {
          const entry = {
            token: existingToken,
            userAddress,
            expiresAt: Math.min(expiresAt, Date.now() + 600000),
          };
          cardComposeSessionCache.set(cacheKey, entry);
          return { token: entry.token, userAddress: entry.userAddress };
        }
      }
    }

    const requestKey = (budgetLimit: string) =>
      fetch(`${composeUrl}/api/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-user-address': userAddress,
          'x-network-id': network,
        },
        body: JSON.stringify({
          budgetLimit,
          expiresAt: Date.now() + 24 * 3600 * 1000,
          network,
          purpose: 'session',
          name: 'rawchunks-card-credits',
        }),
        signal: AbortSignal.timeout(10000),
      });

    const initialBudget = minRequired > 10000000n ? String(minRequired) : '10000000';
    let keyRes = await requestKey(initialBudget);
    if (!keyRes.ok && keyRes.status === 402) {
      const errBody = (await keyRes.json().catch(() => null)) as any;
      const balStr = errBody?.details?.balanceWei;
      const allowStr = errBody?.details?.allowanceWei;
      const availWei =
        typeof balStr === 'string' && /^\d+$/.test(balStr) && typeof allowStr === 'string' && /^\d+$/.test(allowStr)
          ? (BigInt(balStr) < BigInt(allowStr) ? BigInt(balStr) : BigInt(allowStr))
          : typeof balStr === 'string' && /^\d+$/.test(balStr)
            ? BigInt(balStr)
            : typeof allowStr === 'string' && /^\d+$/.test(allowStr)
              ? BigInt(allowStr)
              : 0n;
      if (availWei >= minRequired) {
        keyRes = await requestKey(String(availWei));
      }
    }
    if (!keyRes.ok) return null;
    const keyData = (await keyRes.json()) as any;
    if (typeof keyData?.token === 'string' && keyData.token) {
      const entry = {
        token: keyData.token as string,
        userAddress,
        expiresAt: Date.now() + 600000,
      };
      cardComposeSessionCache.set(cacheKey, entry);
      return { token: entry.token, userAddress: entry.userAddress };
    }
  } catch {
    return null;
  }
  return null;
}

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
  const rawSource = req.headers['x-credit-source'];
  if (rawSource !== 'promo' && rawSource !== 'card') {
    throw Object.assign(new Error('Credit source (promo or card) required'), { statusCode: 400 });
  }
  const source: CreditLotSource = rawSource;
  const hasWalletToken =
    typeof req.headers['x-wallet-auth-token'] === 'string' && req.headers['x-wallet-auth-token'].trim().length > 0;
  const identity = source === 'promo' || hasWalletToken ? await authenticate(req) : await resolveCreditOwner(req);
  const store = creditStore();

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
    const durationSec = song.duration && song.duration > 0 ? song.duration : 180;
    const durationMs = Math.ceil(durationSec * 1000);
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
    try {
      const song = (req as any).song;
      const durationSec = song.duration && song.duration > 0 ? song.duration : 180;
      const durationMs = Math.ceil(durationSec * 1000);
      const streamNetwork: string | undefined = requestedNetwork || song.network;
      let composePaymentIntentId: string | undefined;
      let composeToken: string | undefined;
      let composeUserAddress: string | undefined;
      if (process.env.COMPOSE_API_URL && streamNetwork) {
        const { prepareStreamPaymentIntent, PaymentError } = await import('../broker/payment.js');
        let composeSession = await resolveCardComposeSession(streamNetwork, identity.userAddress, config.amountWei);
        if (composeSession?.token) {
          const payerAddr = composeSession.userAddress;
          const paymentSignature = await buildBatchSettlementSignature(identity.owner, payerAddr, streamNetwork, hold.id);
          try {
            composePaymentIntentId = await prepareStreamPaymentIntent({
              token: composeSession.token,
              paymentSignature,
              holdOwner: identity.owner,
              holdId: hold.id,
              network: streamNetwork,
              userAddress: payerAddr,
              maxAmountWei: config.amountWei,
              songId: song.id,
              creatorAddress: song.creator,
              streamPriceUsd: song.stream_price,
              durationMs,
              idempotencyKey: hold.id,
            });
            composeToken = composeSession.token;
            composeUserAddress = payerAddr;
          } catch (prepErr) {
            if (prepErr instanceof PaymentError && (prepErr.statusCode === 401 || prepErr.statusCode === 402)) {
              invalidateCardComposeSession(streamNetwork, identity.userAddress);
              composeSession = await resolveCardComposeSession(streamNetwork, identity.userAddress, config.amountWei, true);
              if (composeSession?.token) {
                composePaymentIntentId = await prepareStreamPaymentIntent({
                  token: composeSession.token,
                  paymentSignature,
                  holdOwner: identity.owner,
                  holdId: hold.id,
                  network: streamNetwork,
                  userAddress: composeSession.userAddress,
                  maxAmountWei: config.amountWei,
                  songId: song.id,
                  creatorAddress: song.creator,
                  streamPriceUsd: song.stream_price,
                  durationMs,
                  idempotencyKey: `${hold.id}:retry`,
                }).catch(() => undefined);
                if (composePaymentIntentId) {
                  composeToken = composeSession.token;
                  composeUserAddress = composeSession.userAddress;
                }
              }
            } else {
              throw prepErr;
            }
          }
        }
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
              ...(composeToken ? { composeToken } : {}),
              ...(composeUserAddress ? { composeUserAddress } : {}),
              rate: String(Math.round(song.stream_price * 1000000)),
              durationMs,
              startedAt: Date.now(),
            }),
          ],
        ),
      );
    } catch (err) {
      await store.release(identity.owner, hold.id).catch(() => {});
      throw err;
    }
  }
  reply.header('x-credit-hold-id', hold.id);
}

export async function checkpointCredits(req: FastifyRequest) {
  const hasWalletToken =
    typeof req.headers['x-wallet-auth-token'] === 'string' && req.headers['x-wallet-auth-token'].trim().length > 0;
  const identity = hasWalletToken ? await authenticate(req) : await resolveCreditOwner(req);
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
  const streamNetwork: string | undefined = row.context.network || requestedNetwork;
  if (row.context.paymentIntentId && row.context.composeToken && process.env.COMPOSE_API_URL && streamNetwork) {
    const { settleStreamCheckpoint, PaymentError } = await import('../broker/payment.js');
    try {
      const receipt = await settleStreamCheckpoint({
        paymentIntentId: row.context.paymentIntentId,
        network: streamNetwork,
        listenedSeconds: input.listenedSeconds!,
        token: row.context.composeToken,
        songId: row.context.songId,
        terminal: Boolean(input.terminal),
      });
      return { success: true, result: receipt };
    } catch (err) {
      if (err instanceof PaymentError && (err.statusCode === 401 || err.statusCode === 402)) {
        invalidateCardComposeSession(streamNetwork, row.context.composeUserAddress || identity.userAddress);
      } else {
        throw err;
      }
    }
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
          streamedMs: result.acceptedMs,
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
    if (!billing) return payload;
    if ((req as any).creditMetered) {
      if (reply.statusCode >= 400) {
        const store = creditStore();
        const row = await store.tx(async c => (await c.query('SELECT * FROM credit_holds WHERE environment=$1 AND id=$2', [store.environment, billing.hold])).rows[0]);
        if (row && !row.context) await store.release(billing.owner, billing.hold);
      }
      return payload;
    }
    const store = creditStore();
    const row = await store.tx(async c => (await c.query('SELECT * FROM credit_holds WHERE environment=$1 AND id=$2', [store.environment, billing.hold])).rows[0]);
    if (reply.statusCode >= 400 && !row.context) await store.release(billing.owner, billing.hold);
    else if (reply.statusCode < 400 && !row.context) {
      await store.commit(billing.owner, billing.hold, BigInt(row.maximum));
      await store.release(billing.owner, billing.hold);
      const network = billing.network;
      if (row.credit_source === 'card' && process.env.COMPOSE_API_URL && network) {
        const userAddress = billing.userAddress || billing.owner;
        const action = billing.action || 'vibe';
        setImmediate(async () => {
          try {
            const { settleSessionPaymentAsync } = await import('../broker/payment.js');
            const composeSession = await resolveCardComposeSession(network, userAddress, String(row.maximum));
            if (!composeSession?.token) return;
            const payerAddr = composeSession.userAddress;
            const paymentSignature = await buildBatchSettlementSignature(billing.owner, payerAddr, network, row.id);
            const creatorMatch =
              row.creator && row.creator.startsWith('0x') !== network.startsWith('solana:')
                ? row.creator
                : undefined;
            await settleSessionPaymentAsync({
              token: composeSession.token,
              paymentSignature,
              network,
              userAddress: payerAddr,
              amountWei: String(row.maximum),
              action,
              resource: row.resource,
              method: req.method,
              creatorAddress: creatorMatch,
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
      const userAddress = hold.context?.userAddress || task?.params?.userAddress || task?.params?.creatorAddress || hold.owner;
      const rawNetwork = hold.context?.network || task?.params?.network;
      const network = typeof rawNetwork === 'string' && rawNetwork ? rawNetwork : undefined;
      if (hold.credit_source === 'card' && process.env.COMPOSE_API_URL && network) {
        try {
          const { settleSessionPaymentAsync } = await import('../broker/payment.js');
          const composeSession = await resolveCardComposeSession(network, userAddress, String(hold.maximum));
          if (composeSession?.token) {
            const payerAddr = composeSession.userAddress;
            const paymentSignature = await buildBatchSettlementSignature(hold.owner, payerAddr, network, hold.id);
            const creatorMatch =
              hold.creator && hold.creator.startsWith('0x') !== network.startsWith('solana:')
                ? hold.creator
                : undefined;
            void settleSessionPaymentAsync({
              token: composeSession.token,
              paymentSignature,
              network,
              userAddress: payerAddr,
              amountWei: String(hold.maximum),
              action: hold.context?.action || hold.context?.kind || 'generate',
              resource: hold.resource,
              method: 'POST',
              creatorAddress: creatorMatch,
            });
          }
        } catch {
          // Non-blocking background settlement
        }
      }
    } else if (task?.result?.status === 'error') {
      await store.release(hold.owner, hold.id);
    }
  }
}
