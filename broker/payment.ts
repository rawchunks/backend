import type { FastifyRequest, FastifyReply } from 'fastify';

export interface KeyPayload {
  sub: string;
  keyId: string;
  network?: string;
  budgetLimit: number;
  budgetUsed: number;
  exp?: number;
  iat?: number;
}

export interface SessionPaymentConfig {
  amountWei: string;
  priceUsd: number;
  action: string;
  payTo?: string;
  creatorAddress?: string;
}

export const PRICING = {
  vibe: { amountWei: '30000', priceUsd: 0.03, action: 'vibe' },
} as const satisfies Record<string, SessionPaymentConfig>;

export type SessionPaymentResolver = (
  req: FastifyRequest
) => Promise<SessionPaymentConfig | null> | SessionPaymentConfig | null;

export interface SessionPaymentOptions {
  isExempt?: (req: FastifyRequest) => Promise<boolean> | boolean;
  metered?: boolean;
}

// In-memory cache to track local budget increments during burst/concurrent requests (zero latency)
const localBudgetCache = new Map<string, { used: number; expiresAt: number }>();

function getTrackedBudgetUsed(keyId: string, initialUsed: number): number {
  const now = Date.now();
  const cached = localBudgetCache.get(keyId);
  if (cached && cached.expiresAt > now) {
    return Math.max(cached.used, initialUsed);
  }
  return initialUsed;
}

function trackBudgetUsed(keyId: string, newUsed: number): void {
  localBudgetCache.set(keyId, { used: newUsed, expiresAt: Date.now() + 30 * 60 * 1000 });
}

export function extractSessionToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && typeof auth === 'string') {
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    if (auth.startsWith('compose-')) return auth.trim();
  }
  const keyToken = req.headers['x-key-token'];
  if (keyToken && typeof keyToken === 'string') {
    return keyToken.trim();
  }
  return null;
}

export function parseComposeToken(token: string): KeyPayload | null {
  if (!token || typeof token !== 'string') return null;
  const clean = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  if (!clean.startsWith('compose-')) return null;
  const jwt = clean.slice('compose-'.length);
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const jsonStr = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(jsonStr) as KeyPayload;
    if (!payload.sub || !payload.keyId) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getPlatformTreasury(network: string): string {
  if (!network || typeof network !== 'string') {
    throw new Error('Network ID is required to resolve platform treasury');
  }
  const isSolana = network.startsWith('solana:');
  const address = isSolana
    ? process.env.RAWCHUNKS_SOLANA_TREASURY_ADDRESS
    : (process.env.RAWCHUNKS_TREASURY_ADDRESS || process.env.PAY_TO_ADDRESS);
  if (!address) {
    throw new Error(`Platform treasury address not configured for network: ${network}`);
  }
  return address;
}

export function buildPaymentRequiredHeader(
  amountWei: string,
  network: string,
  resource: string,
  payTo?: string
): string {
  const destination = payTo || getPlatformTreasury(network);
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network,
        amount: amountWei,
        asset: 'USDC',
        payTo: destination,
      },
    ],
    resource: {
      url: resource,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function getComposeApiUrl(): string {
  const url = process.env.COMPOSE_API_URL;
  if (!url) {
    throw new Error('COMPOSE_API_URL is required and must be configured');
  }
  return url.replace(/\/+$/, '');
}

export async function settleSessionPaymentAsync(params: {
  token: string;
  network: string;
  userAddress: string;
  amountWei: string;
  action: string;
  resource: string;
  method: string;
  payTo?: string;
  creatorAddress?: string;
}): Promise<void> {
  try {
    const composeUrl = getComposeApiUrl();
    const payTo = params.payTo || getPlatformTreasury(params.network);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'x-network-id': params.network,
      'x-session-user-address': params.userAddress,
    };

    const totalWei = BigInt(params.amountWei);
    const creatorAddress = params.creatorAddress;
    const treasuryAddress = payTo;
    const creatorShareWei = creatorAddress ? ((totalWei * 8000n) / 10000n).toString() : '0';
    const treasuryFeeWei = creatorAddress ? (totalWei - BigInt(creatorShareWei)).toString() : totalWei.toString();

    const prepareBody: Record<string, unknown> = {
      maxAmountWei: params.amountWei,
      service: 'rawchunks',
      action: params.action,
      resource: params.resource,
      method: params.method,
      payTo,
      royalties: {
        creator: creatorAddress,
        treasury: treasuryAddress,
      },
    };

    if (creatorAddress) {
      prepareBody.creatorAddress = creatorAddress;
    }

    const prepareRes = await fetch(`${composeUrl}/api/payments/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify(prepareBody),
    });

    if (!prepareRes.ok) {
      const errText = await prepareRes.text().catch(() => '');
      console.warn(`[Payment] Async prepare failed (${prepareRes.status}):`, errText);
      return;
    }

    const prepareData = (await prepareRes.json()) as { paymentIntentId?: string };
    if (!prepareData.paymentIntentId) {
      console.warn('[Payment] Async prepare did not return paymentIntentId:', prepareData);
      return;
    }

    const settleBody: Record<string, unknown> = {
      paymentIntentId: prepareData.paymentIntentId,
      finalAmountWei: params.amountWei,
      executeImmediately: true,
      royalties: {
        creator: creatorAddress,
        treasury: treasuryAddress,
      },
    };

    if (creatorAddress) {
      settleBody.providerAmountWei = creatorShareWei;
      settleBody.platformFeeWei = treasuryFeeWei;
    }

    const settleRes = await fetch(`${composeUrl}/api/payments/settle`, {
      method: 'POST',
      headers,
      body: JSON.stringify(settleBody),
    });

    if (!settleRes.ok) {
      const errText = await settleRes.text().catch(() => '');
      console.warn(`[Payment] Async settle failed (${settleRes.status}):`, errText);
      return;
    }

    const settleData = (await settleRes.json()) as { status?: string; txHash?: string };
    console.log(`[Payment] Settled intent ${prepareData.paymentIntentId} on-chain: status=${settleData.status}, txHash=${settleData.txHash}`);
  } catch (err: any) {
    // Non-blocking background log
    console.warn('[Payment] Async settlement error:', err?.message || err);
  }
}

export async function prepareStreamPaymentIntent(params: {
  token: string;
  network: string;
  userAddress: string;
  maxAmountWei: string;
  songId: string;
  creatorAddress: string;
  payTo?: string;
}): Promise<string | null> {
  try {
    const composeUrl = getComposeApiUrl();
    const payTo = params.payTo || getPlatformTreasury(params.network);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'x-network-id': params.network,
      'x-session-user-address': params.userAddress,
    };

    const prepareBody: Record<string, unknown> = {
      maxAmountWei: params.maxAmountWei,
      service: 'rawchunks',
      action: 'stream-playback',
      resource: `/api/songs/${params.songId}/stream`,
      method: 'GET',
      payTo,
      royalties: {
        creator: params.creatorAddress,
        treasury: payTo,
      },
    };

    const prepareRes = await fetch(`${composeUrl}/api/payments/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify(prepareBody),
    });

    if (!prepareRes.ok) {
      const errText = await prepareRes.text().catch(() => '');
      console.warn(`[Stream Payment] Prepare failed (${prepareRes.status}):`, errText);
      return null;
    }

    const prepareData = (await prepareRes.json()) as { paymentIntentId?: string };
    return prepareData.paymentIntentId || null;
  } catch (err: any) {
    console.warn('[Stream Payment] Prepare error:', err?.message || err);
    return null;
  }
}

export async function settleStreamCheckpoint(params: {
  paymentIntentId: string;
  network: string;
  listenedSeconds: number;
  streamPriceUsd: number;
  creatorAddress: string;
  payTo?: string;
}): Promise<{ status: string; txHash?: string; billedWei: string } | null> {
  try {
    const composeUrl = getComposeApiUrl();
    const payTo = params.payTo || getPlatformTreasury(params.network);

    const durationMinutes = Math.max(0, params.listenedSeconds) / 60;
    const finalAmountWei = Math.round(durationMinutes * params.streamPriceUsd * 1_000_000);
    if (finalAmountWei <= 0) {
      return { status: 'skipped', billedWei: '0' };
    }

    const totalWei = BigInt(finalAmountWei);
    const creatorShareWei = ((totalWei * 8000n) / 10000n).toString();
    const treasuryFeeWei = (totalWei - BigInt(creatorShareWei)).toString();

    const settleBody: Record<string, unknown> = {
      paymentIntentId: params.paymentIntentId,
      finalAmountWei: totalWei.toString(),
      executeImmediately: true,
      providerAmountWei: creatorShareWei,
      platformFeeWei: treasuryFeeWei,
      royalties: {
        creator: params.creatorAddress,
        treasury: payTo,
      },
    };

    const settleRes = await fetch(`${composeUrl}/api/payments/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-network-id': params.network,
      },
      body: JSON.stringify(settleBody),
    });

    if (!settleRes.ok) {
      const errText = await settleRes.text().catch(() => '');
      console.warn(`[Stream Payment] Checkpoint settle failed (${settleRes.status}):`, errText);
      return null;
    }

    const settleData = (await settleRes.json()) as { status?: string; txHash?: string };
    console.log(`[Stream Payment] Checkpoint settled intent ${params.paymentIntentId}: status=${settleData.status}, txHash=${settleData.txHash}, creator=${creatorShareWei}, treasury=${treasuryFeeWei}`);
    return {
      status: settleData.status || 'confirmed',
      txHash: settleData.txHash,
      billedWei: totalWei.toString(),
    };
  } catch (err: any) {
    console.warn('[Stream Payment] Checkpoint settle error:', err?.message || err);
    return null;
  }
}

export function requireSessionPayment(
  configOrResolver: SessionPaymentConfig | SessionPaymentResolver,
  options?: SessionPaymentOptions
) {
  return async function sessionPaymentPreHandler(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers['x-credit-source']) {
      const { admitCredits } = await import('../credits/billing.js');
      return admitCredits(request, reply, configOrResolver, options);
    }
    if (options?.isExempt) {
      const isExempt = await options.isExempt(request);
      if (isExempt) {
        reply.header('x-creator-exempt', 'true');
        return;
      }
    }

    const config = typeof configOrResolver === 'function' ? await configOrResolver(request) : configOrResolver;
    if (!config) {
      reply.header('x-creator-exempt', 'true');
      return;
    }

    const requiredAmount = Number(config.amountWei);
    const token = extractSessionToken(request);

    if (!token) {
      const isTestMode = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
      if (isTestMode && !request.headers['x-test-require-session']) {
        return;
      }
      const network = request.headers['x-network-id'] as string;
      if (!network) {
        return reply.status(400).send({ error: 'x-network-id header is required for payment challenge' });
      }
      const payHeader = buildPaymentRequiredHeader(config.amountWei, network, request.url, config.payTo);
      return reply.status(402)
        .header('PAYMENT-REQUIRED', payHeader)
        .header('access-control-expose-headers', 'PAYMENT-REQUIRED, x-session-budget-limit, x-session-budget-used, x-session-budget-remaining')
        .send({
          error: 'Payment required',
          pricing: {
            amountWei: config.amountWei,
            priceUsd: config.priceUsd,
            action: config.action,
            network,
            ...(config.creatorAddress ? { creatorAddress: config.creatorAddress } : {}),
          },
        });
    }

    const payload = parseComposeToken(token);
    if (!payload) {
      return reply.status(401).send({ error: 'Invalid Compose session token' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return reply.status(401).header('x-session-invalid', 'true').send({ error: 'Compose session has expired' });
    }

    const requestedNetwork = request.headers['x-network-id'];
    if (typeof requestedNetwork === 'string' && payload.network && requestedNetwork !== payload.network) {
      return reply.status(401).header('x-session-invalid', 'true').send({ error: 'The Compose session belongs to another network' });
    }

    const currentUsed = getTrackedBudgetUsed(payload.keyId, payload.budgetUsed || 0);
    const remaining = (payload.budgetLimit || 0) - currentUsed;

    if (remaining < requiredAmount) {
      return reply.status(402)
        .header('x-session-budget-limit', String(payload.budgetLimit))
        .header('x-session-budget-used', String(currentUsed))
        .header('x-session-budget-remaining', String(Math.max(0, remaining)))
        .header('access-control-expose-headers', 'PAYMENT-REQUIRED, x-session-budget-limit, x-session-budget-used, x-session-budget-remaining')
        .send({
          error: 'Insufficient session budget',
          budgetLimit: payload.budgetLimit,
          budgetUsed: currentUsed,
          budgetRemaining: Math.max(0, remaining),
          required: requiredAmount,
        });
    }

    const resolvedNetwork = payload.network || (request.headers['x-network-id'] as string);
    if (!resolvedNetwork) {
      return reply.status(400).send({ error: 'Session token or request is missing network specification' });
    }

    if (options?.metered) {
      reply.header('x-session-budget-limit', String(payload.budgetLimit));
      reply.header('x-session-budget-used', String(currentUsed));
      reply.header('x-session-budget-remaining', String(remaining));
      reply.header('access-control-expose-headers', 'PAYMENT-REQUIRED, x-session-budget-limit, x-session-budget-used, x-session-budget-remaining');

      request.headers['x-session-user-address'] = payload.sub;
      request.headers['x-network-id'] = resolvedNetwork;

      const songId = (request.params as any)?.id || '';
      const paymentIntentId = await prepareStreamPaymentIntent({
        token,
        network: resolvedNetwork,
        userAddress: payload.sub,
        maxAmountWei: config.amountWei,
        songId,
        creatorAddress: config.creatorAddress || '',
        payTo: config.payTo,
      });
      (request as any).paymentIntentId = paymentIntentId;
      return;
    }

    // Update in-memory tracked budget
    const newUsed = currentUsed + requiredAmount;
    const newRemaining = Math.max(0, (payload.budgetLimit || 0) - newUsed);
    trackBudgetUsed(payload.keyId, newUsed);

    // Stamp response headers for frontend HUD
    reply.header('x-session-budget-limit', String(payload.budgetLimit));
    reply.header('x-session-budget-used', String(newUsed));
    reply.header('x-session-budget-remaining', String(newRemaining));
    reply.header('access-control-expose-headers', 'PAYMENT-REQUIRED, x-session-budget-limit, x-session-budget-used, x-session-budget-remaining');

    // In-memory identity injection: satisfies readUser(request) with ZERO db latency
    request.headers['x-session-user-address'] = payload.sub;
    request.headers['x-network-id'] = resolvedNetwork;

    // Schedule asynchronous settlement without adding request latency
    setImmediate(() => {
      void settleSessionPaymentAsync({
        token,
        network: resolvedNetwork,
        userAddress: payload.sub,
        amountWei: config.amountWei,
        action: config.action,
        resource: request.url,
        method: request.method,
        payTo: config.payTo,
        creatorAddress: config.creatorAddress,
      });
    });
  };
}
