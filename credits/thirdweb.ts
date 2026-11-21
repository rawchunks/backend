import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CreditStore } from './store.js';
import { packs } from './paypal.js';
import { getActiveNetworkSet, getFacilitatorChain } from '../broker/payment.js';

const BRIDGE_BASE_URL = 'https://bridge.thirdweb.com';
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WEBHOOK_TOLERANCE_SECONDS = 300;

const fail = (message: string, statusCode = 502) => Object.assign(new Error(message), { statusCode });

function formatUnits(atomics: bigint, decimals = 6): string {
  const base = 10n ** BigInt(decimals);
  const whole = atomics / base;
  const fraction = atomics % base;
  if (fraction === 0n) return String(whole);
  const padded = String(fraction).padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${padded}`;
}

function headerValue(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0].trim();
  return undefined;
}

function assertWalletMatchesNetwork(network: string, walletAddress?: string): string {
  const trimmed = walletAddress?.trim() ?? '';
  if (!trimmed) throw fail('Missing receiver wallet address', 400);
  if (network.startsWith('eip155:')) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      throw fail(`Invalid EVM wallet address for ${network}`, 400);
    }
    return trimmed;
  }
  if (network.startsWith('solana:')) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
      throw fail(`Invalid Solana wallet address for ${network}`, 400);
    }
    return trimmed;
  }
  throw fail(`Unsupported network namespace: ${network}`, 400);
}

export class Thirdweb {
  constructor(
    public readonly store: CreditStore,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private get clientId(): string {
    const id = process.env.THIRDWEB_CLIENT_ID?.trim();
    if (!id) throw fail('Thirdweb configuration unavailable', 503);
    return id;
  }

  async operation(id: string, owner?: string) {
    return this.store.tx(async c => {
      const row = (
        await c.query('SELECT * FROM credit_operations WHERE environment=$1 AND id=$2', [this.store.environment, id])
      ).rows[0];
      if (!row || (owner && row.owner !== owner)) throw fail('Unknown payment operation', 404);
      return row;
    });
  }

  private async bridgeGet(path: string, params: Record<string, string>): Promise<{ status: number; data: any }> {
    const url = new URL(`${BRIDGE_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const response = await this.transport(url.toString(), {
      method: 'GET',
      headers: {
        'x-client-id': this.clientId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    const body = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) {
      if (response.status === 404) return { status: 404, data: null };
      const message = typeof body?.message === 'string' ? body.message : response.statusText;
      throw Object.assign(fail(`Thirdweb Bridge request failed (${response.status}): ${message}`), {
        providerStatus: response.status,
      });
    }
    return { status: response.status, data: body?.data ?? body };
  }

  private async verifyErc20TransferOnChain(params: {
    network: string;
    txHash: string;
    tokenAddress: string;
    receiverAddress: string;
  }): Promise<bigint> {
    const chain = await getFacilitatorChain(params.network);
    if (!chain.rpcUrl) throw fail(`Missing RPC URL from Compose facilitator for ${params.network}`, 502);
    const rpcRes = await this.transport(chain.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [params.txHash],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!rpcRes.ok) throw fail(`RPC receipt verification failed (${rpcRes.status})`, 502);
    const rpcJson = (await rpcRes.json()) as { result?: any; error?: { message?: string } };
    const receipt = rpcJson?.result;
    if (!receipt) return 0n;
    if (receipt.status !== '0x1' && receipt.status !== 1) {
      throw fail('On-chain token transfer reverted', 402);
    }
    const expectedToken = params.tokenAddress.toLowerCase();
    const expectedReceiver = params.receiverAddress.toLowerCase();
    let total = 0n;
    for (const log of Array.isArray(receipt.logs) ? receipt.logs : []) {
      if (typeof log?.address !== 'string' || log.address.toLowerCase() !== expectedToken) continue;
      const topics = Array.isArray(log.topics) ? log.topics : [];
      if (typeof topics[0] !== 'string' || topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
      if (typeof topics[2] !== 'string' || topics[2].length < 42) continue;
      const toAddress = `0x${topics[2].slice(-40).toLowerCase()}`;
      if (toAddress !== expectedReceiver) continue;
      if (typeof log.data === 'string' && /^0x[0-9a-fA-F]+$/.test(log.data)) {
        total += BigInt(log.data);
      }
    }
    return total;
  }

  async create(
    owner: string,
    packId: string,
    key: string,
    options: { kind?: string; network?: string; walletAddress?: string },
  ) {
    const pack = packs.find(p => p.id === packId);
    if (!pack) throw fail('Unknown credit package', 400);
    const network = options.network?.trim();
    if (!network || !getActiveNetworkSet().has(network)) {
      throw fail(`Network is not active in current mode: ${network ?? 'missing'}`, 409);
    }
    const walletAddress = assertWalletMatchesNetwork(network, options.walletAddress);
    const chain = await getFacilitatorChain(network);
    const chainId = chain.namespace === 'eip155' ? Number(chain.network.slice(7)) : undefined;
    const tokenAddress = chain.assetAddress;
    const decimals = chain.decimals || 6;
    const cents = Math.round(Number(pack.usd) * 100);
    const id = createHash('sha256').update(`${this.store.environment}:${owner}:${key}`).digest('hex').slice(0, 36);
    const context = {
      provider: 'thirdweb',
      packId,
      cents,
      usd: pack.usd,
      network,
      ...(chainId !== undefined ? { chainId } : {}),
      tokenAddress,
      decimals,
      walletAddress,
      ...(options.kind ? { kind: options.kind } : {}),
    };
    await this.store.tx(async c => {
      await c.query('INSERT INTO credit_accounts(environment,owner) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        this.store.environment,
        owner,
      ]);
      await c.query(
        "INSERT INTO credit_operations(environment,id,owner,kind,amount,context) VALUES($1,$2,$3,'purchase',$4,$5) ON CONFLICT DO NOTHING",
        [this.store.environment, id, owner, pack.amountAtomics, JSON.stringify(context)],
      );
    });
    const existing = await this.operation(id, owner);
    if (
      existing.kind !== 'purchase' ||
      String(existing.amount) !== pack.amountAtomics ||
      existing.context?.network !== network ||
      String(existing.context?.walletAddress ?? '').toLowerCase() !== walletAddress.toLowerCase()
    ) {
      throw fail('Idempotency key reused for a different package', 409);
    }
    if (existing.status === 'credited' || existing.status === 'completed') {
      throw fail('Order has already been completed; start a new checkout', 409);
    }
    return {
      operationId: id,
      status: existing.status,
      amountUsd: pack.usd,
      amountToken: formatUnits(BigInt(pack.amountAtomics), decimals),
      amountAtomics: pack.amountAtomics,
      network,
      ...(chainId !== undefined ? { chainId } : {}),
      tokenAddress,
      receiverAddress: walletAddress,
    };
  }

  async createLicense(
    owner: string,
    input: { songId: string; chainSongId: string; network: string; walletAddress: string; amountAtomics: string },
    key: string,
  ) {
    const network = input.network.trim();
    if (!getActiveNetworkSet().has(network)) {
      throw fail(`Network is not active in current mode: ${network}`, 409);
    }
    const walletAddress = assertWalletMatchesNetwork(network, input.walletAddress);
    const atomics = BigInt(input.amountAtomics);
    if (atomics <= 0n) throw fail('Invalid license price', 400);
    const chain = await getFacilitatorChain(network);
    const chainId = chain.namespace === 'eip155' ? Number(chain.network.slice(7)) : undefined;
    const tokenAddress = chain.assetAddress;
    const decimals = chain.decimals || 6;
    const cents = Math.max(1, Math.round(Number(atomics) / 10000));
    const usd = (cents / 100).toFixed(2);
    const id = createHash('sha256')
      .update(`${this.store.environment}:${owner}:license:${key}`)
      .digest('hex')
      .slice(0, 36);
    const context = {
      provider: 'thirdweb',
      songId: input.songId,
      chainSongId: input.chainSongId,
      network,
      ...(chainId !== undefined ? { chainId } : {}),
      tokenAddress,
      decimals,
      walletAddress,
      cents,
      usd,
    };
    await this.store.tx(async c => {
      await c.query('INSERT INTO credit_accounts(environment,owner) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        this.store.environment,
        owner,
      ]);
      await c.query(
        "INSERT INTO credit_operations(environment,id,owner,kind,amount,context) VALUES($1,$2,$3,'license',$4,$5) ON CONFLICT DO NOTHING",
        [this.store.environment, id, owner, input.amountAtomics, JSON.stringify(context)],
      );
    });
    const existing = await this.operation(id, owner);
    if (
      existing.kind !== 'license' ||
      String(existing.amount) !== input.amountAtomics ||
      existing.context?.songId !== input.songId ||
      existing.context?.network !== network ||
      String(existing.context?.walletAddress ?? '').toLowerCase() !== walletAddress.toLowerCase()
    ) {
      throw fail('Idempotency key reused for a different license checkout', 409);
    }
    if (existing.status === 'credited' || existing.status === 'completed') {
      throw fail('Order has already been completed; start a new checkout', 409);
    }
    return {
      operationId: id,
      status: existing.status,
      amountUsd: usd,
      amountToken: formatUnits(atomics, decimals),
      amountAtomics: input.amountAtomics,
      network,
      ...(chainId !== undefined ? { chainId } : {}),
      tokenAddress,
      receiverAddress: walletAddress,
    };
  }

  async confirm(
    owner: string,
    input: { operationId: string; onrampId?: string; transactionHash?: string; chainId?: number },
  ) {
    const op = await this.operation(input.operationId, owner);
    if (op.status === 'credited' || op.status === 'completed') {
      return {
        operationId: op.id,
        status: op.status,
        ...(op.capture_id ? { captureId: op.capture_id } : {}),
        ...(op.context?.thirdwebPaymentId ? { thirdwebPaymentId: op.context.thirdwebPaymentId } : {}),
        ...(op.context?.creditedAtomics ? { creditedAtomics: op.context.creditedAtomics } : {}),
      };
    }
    if (!input.onrampId && !input.transactionHash && !op.context?.onrampId && !op.context?.transactionHash) {
      throw fail('Missing onrampId or transactionHash to confirm Thirdweb payment', 400);
    }
    if (
      input.onrampId &&
      typeof op.context?.onrampId === 'string' &&
      op.context.onrampId &&
      op.context.onrampId !== input.onrampId
    ) {
      throw fail('Onramp session mismatch for operation', 409);
    }
    const patch: Record<string, unknown> = {};
    if (input.onrampId) patch.onrampId = input.onrampId;
    if (input.transactionHash) patch.transactionHash = input.transactionHash;
    if (input.chainId !== undefined) patch.originChainId = input.chainId;
    const orderKey =
      op.order_id ||
      input.onrampId ||
      (input.transactionHash ? `tw:${input.chainId ?? op.context?.chainId ?? 0}:${input.transactionHash.toLowerCase()}` : null);
    await this.store.tx(c =>
      c.query(
        'UPDATE credit_operations SET order_id=coalesce(order_id,$3),context=context||$4::jsonb,updated_at=now() WHERE environment=$1 AND id=$2',
        [this.store.environment, op.id, orderKey, JSON.stringify(patch)],
      ),
    );
    return this.reconcile(op.id);
  }

  async reconcile(id: string): Promise<{
    operationId: string;
    status: string;
    captureId?: string;
    thirdwebPaymentId?: string;
    creditedAtomics?: string;
    deliveredAtomics?: string;
  }> {
    const op = await this.operation(id);
    if (op.status === 'credited' || op.status === 'completed') {
      return {
        operationId: op.id,
        status: op.status,
        ...(op.capture_id ? { captureId: op.capture_id } : {}),
        ...(op.context?.thirdwebPaymentId ? { thirdwebPaymentId: op.context.thirdwebPaymentId } : {}),
        ...(op.context?.creditedAtomics ? { creditedAtomics: op.context.creditedAtomics } : {}),
        ...(op.context?.deliveredAtomics ? { deliveredAtomics: op.context.deliveredAtomics } : {}),
      };
    }

    const expectedNetwork = typeof op.context?.network === 'string' ? op.context.network : '';
    if (!expectedNetwork || !getActiveNetworkSet().has(expectedNetwork)) {
      throw fail(`Operation network is not active in current mode: ${expectedNetwork || 'missing'}`, 409);
    }
    const expectedChainId = Number(op.context?.chainId);
    const expectedToken = typeof op.context?.tokenAddress === 'string' ? op.context.tokenAddress.toLowerCase() : '';
    const expectedReceiver = typeof op.context?.walletAddress === 'string' ? op.context.walletAddress.toLowerCase() : '';
    if (!expectedToken || !expectedReceiver) {
      throw fail('Incomplete Thirdweb operation context', 500);
    }

    const onrampId = typeof op.context?.onrampId === 'string' ? op.context.onrampId : undefined;
    const txHash = typeof op.context?.transactionHash === 'string' ? op.context.transactionHash : undefined;
    const originChainId = Number(op.context?.originChainId ?? op.context?.chainId);

    if (!onrampId && !txHash) {
      return { operationId: op.id, status: op.status };
    }

    let onrampData: any = null;
    if (onrampId) {
      const res = await this.bridgeGet('/v1/onramp/status', { id: onrampId });
      if (!res.data) return { operationId: op.id, status: 'pending' };
      onrampData = res.data;
      const opRef = onrampData.purchaseData?.operationId;
      if (opRef !== op.id) {
        throw fail('Thirdweb onramp purchaseData does not match payment operation', 409);
      }
      if (onrampData.status === 'FAILED') {
        throw fail('Thirdweb card onramp failed', 402);
      }
      if (onrampData.status !== 'COMPLETED') {
        return { operationId: op.id, status: 'pending' };
      }
    }

    let deliveredAtomics: bigint | undefined;
    let thirdwebPaymentId: string | undefined;
    let destinationTxHash: string | undefined;

    if (txHash && Number.isFinite(originChainId) && originChainId > 0) {
      const bridgeRes = await this.bridgeGet('/v1/status', {
        transactionHash: txHash,
        chainId: String(originChainId),
      });
      const bridgeData = bridgeRes.data;
      if (bridgeData && bridgeData.status && bridgeData.status !== 'NOT_FOUND') {
        if (bridgeData.status === 'FAILED') {
          throw fail('Thirdweb Universal Bridge swap failed', 402);
        }
        if (bridgeData.status !== 'COMPLETED') {
          return { operationId: op.id, status: 'pending' };
        }
        const bridgeOpRef = bridgeData.purchaseData?.operationId;
        if (!onrampId && bridgeOpRef !== op.id) {
          throw fail('Thirdweb bridge purchaseData does not match payment operation', 409);
        }
        if (bridgeOpRef !== undefined && bridgeOpRef !== op.id) {
          throw fail('Thirdweb bridge purchaseData mismatch', 409);
        }
        if (Number.isFinite(expectedChainId) && Number(bridgeData.destinationChainId) !== expectedChainId) {
          throw fail('Thirdweb destination chain mismatch', 409);
        }
        const destToken = String(bridgeData.destinationTokenAddress ?? bridgeData.destinationToken?.address ?? '').toLowerCase();
        if (destToken !== expectedToken) {
          throw fail('Thirdweb destination token mismatch', 409);
        }
        if (String(bridgeData.receiver ?? '').toLowerCase() !== expectedReceiver) {
          throw fail('Thirdweb receiver wallet mismatch', 409);
        }
        deliveredAtomics = BigInt(bridgeData.destinationAmount);
        thirdwebPaymentId = typeof bridgeData.paymentId === 'string' && bridgeData.paymentId ? bridgeData.paymentId : onrampId;
        const txs = Array.isArray(bridgeData.transactions) ? bridgeData.transactions : [];
        destinationTxHash =
          txs.find((t: any) => Number(t?.chainId) === expectedChainId)?.transactionHash ??
          txs[txs.length - 1]?.transactionHash ??
          txHash;
      }
    }

    if (deliveredAtomics === undefined) {
      if (!onrampData || onrampData.status !== 'COMPLETED') {
        return { operationId: op.id, status: 'pending' };
      }
      const onrampTxs = Array.isArray(onrampData.transactions) ? onrampData.transactions : [];
      const matchingDestTx =
        onrampTxs.find((t: any) => !Number.isFinite(expectedChainId) || Number(t?.chainId) === expectedChainId)
          ?.transactionHash ??
        (txHash && (!Number.isFinite(expectedChainId) || originChainId === expectedChainId) ? txHash : undefined);
      if (matchingDestTx && expectedNetwork.startsWith('eip155:')) {
        const verifiedOnChain = await this.verifyErc20TransferOnChain({
          network: expectedNetwork,
          txHash: matchingDestTx,
          tokenAddress: expectedToken,
          receiverAddress: expectedReceiver,
        });
        if (verifiedOnChain > 0n) {
          deliveredAtomics = verifiedOnChain;
          destinationTxHash = matchingDestTx;
          thirdwebPaymentId = onrampId;
        }
      }
      if (deliveredAtomics === undefined && typeof op.context?.webhookVerifiedAtomics === 'string') {
        const fromWebhook = BigInt(op.context.webhookVerifiedAtomics);
        if (fromWebhook > 0n) {
          deliveredAtomics = fromWebhook;
          destinationTxHash = matchingDestTx;
          thirdwebPaymentId = onrampId;
        }
      }
      if (deliveredAtomics === undefined) {
        return { operationId: op.id, status: 'pending' };
      }
    }

    if (deliveredAtomics <= 0n) {
      throw fail('Delivered USDC amount must be positive', 409);
    }

    const captureId = `tw:${thirdwebPaymentId || destinationTxHash || op.id}`;
    const metaPatch = {
      ...(thirdwebPaymentId ? { thirdwebPaymentId } : {}),
      ...(destinationTxHash ? { destinationTxHash } : {}),
      deliveredAtomics: String(deliveredAtomics),
    };

    if (op.kind === 'license') {
      if (deliveredAtomics < BigInt(op.amount)) {
        throw fail('Delivered USDC is below the required license price', 409);
      }
      await this.store.completeOperation(op.owner, op.id, captureId, metaPatch);
      return {
        operationId: op.id,
        status: 'completed',
        captureId,
        ...(thirdwebPaymentId ? { thirdwebPaymentId } : {}),
        deliveredAtomics: String(deliveredAtomics),
      };
    }

    await this.store.tx(c =>
      c.query('UPDATE credit_operations SET context=context||$3::jsonb,updated_at=now() WHERE environment=$1 AND id=$2', [
        this.store.environment,
        op.id,
        JSON.stringify(metaPatch),
      ]),
    );
    await this.store.creditCapture(op.owner, op.id, captureId, BigInt(op.amount), deliveredAtomics);
    return {
      operationId: op.id,
      status: 'credited',
      captureId,
      ...(thirdwebPaymentId ? { thirdwebPaymentId } : {}),
      creditedAtomics: String(deliveredAtomics),
    };
  }

  async webhook(headers: Record<string, unknown>, rawBody: string) {
    const secret = process.env.THIRDWEB_WEBHOOK_SECRET?.trim();
    if (!secret) throw fail('Thirdweb webhook verification unavailable', 503);
    const signature = headerValue(headers['x-payload-signature']) ?? headerValue(headers['x-pay-signature']);
    const timestampHeader = headerValue(headers['x-timestamp']) ?? headerValue(headers['x-pay-timestamp']);
    if (!signature || !timestampHeader) {
      throw fail('Missing Thirdweb webhook signature headers', 401);
    }
    const timestamp = Number.parseInt(timestampHeader, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(timestamp) || Math.abs(nowSec - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
      throw fail('Expired Thirdweb webhook timestamp', 401);
    }
    const computed = createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`).digest('hex');
    const sigBuf = Buffer.from(signature.toLowerCase(), 'utf8');
    const expBuf = Buffer.from(computed.toLowerCase(), 'utf8');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw fail('Invalid Thirdweb webhook signature', 401);
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw fail('Invalid Thirdweb webhook JSON payload', 400);
    }
    if (event?.version !== 2 || (event?.type !== 'pay.onramp-transaction' && event?.type !== 'pay.onchain-transaction')) {
      throw fail('Unsupported Thirdweb webhook version or type', 400);
    }

    const data = event.data ?? {};
    const rawEventId =
      event.type === 'pay.onramp-transaction'
        ? `tw:onramp:${String(data.id ?? '')}:${String(data.status ?? '')}`
        : `tw:onchain:${String(data.paymentId ?? '')}:${String(data.status ?? '')}`;
    if (!data.id && !data.paymentId) {
      throw fail('Missing Thirdweb webhook transaction identifier', 400);
    }

    await this.store.tx(c =>
      c.query('INSERT INTO credit_events(environment,id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
        this.store.environment,
        rawEventId,
        JSON.stringify(event),
      ]),
    );

    const operationId =
      typeof data.purchaseData?.operationId === 'string' && data.purchaseData.operationId.trim()
        ? data.purchaseData.operationId.trim()
        : undefined;
    if (!operationId || data.status !== 'COMPLETED') return;

    const op = await this.operation(operationId).catch(() => null);
    if (!op || op.status === 'credited' || op.status === 'completed') return;

    const expectedChainId = Number(op.context?.chainId);
    const expectedToken = typeof op.context?.tokenAddress === 'string' ? op.context.tokenAddress.toLowerCase() : '';
    const expectedReceiver = typeof op.context?.walletAddress === 'string' ? op.context.walletAddress.toLowerCase() : '';

    if (event.type === 'pay.onramp-transaction') {
      const onrampId = String(data.id);
      const tokenChainMatch = !Number.isFinite(expectedChainId) || Number(data.token?.chainId) === expectedChainId;
      const tokenAddrMatch = String(data.token?.address ?? '').toLowerCase() === expectedToken;
      const receiverMatch = String(data.receiver ?? '').toLowerCase() === expectedReceiver;
      const patch: Record<string, unknown> = { onrampId };
      if (tokenChainMatch && tokenAddrMatch && receiverMatch) {
        if (typeof data.transactionHash === 'string' && data.transactionHash) {
          patch.transactionHash = data.transactionHash;
          patch.originChainId = Number(data.token?.chainId);
        }
        if (data.amount !== undefined && data.amount !== null) {
          patch.webhookVerifiedAtomics = String(BigInt(data.amount));
        }
      }
      await this.store.tx(c =>
        c.query(
          'UPDATE credit_operations SET order_id=coalesce(order_id,$3),context=context||$4::jsonb,updated_at=now() WHERE environment=$1 AND id=$2',
          [this.store.environment, op.id, onrampId, JSON.stringify(patch)],
        ),
      );
      if (tokenChainMatch && tokenAddrMatch && receiverMatch) {
        await this.reconcile(op.id);
      }
      return;
    }

    if (event.type === 'pay.onchain-transaction') {
      const tokenChainMatch =
        !Number.isFinite(expectedChainId) || Number(data.destinationToken?.chainId) === expectedChainId;
      const tokenAddrMatch = String(data.destinationToken?.address ?? '').toLowerCase() === expectedToken;
      const receiverMatch = String(data.receiver ?? '').toLowerCase() === expectedReceiver;
      if (!tokenChainMatch || !tokenAddrMatch || !receiverMatch) return;
      const originTx = Array.isArray(data.transactions) ? data.transactions[0] : undefined;
      if (!originTx?.transactionHash || originTx?.chainId === undefined) return;
      const patch = {
        transactionHash: String(originTx.transactionHash),
        originChainId: Number(originTx.chainId),
      };
      const orderKey = `tw:${originTx.chainId}:${String(originTx.transactionHash).toLowerCase()}`;
      await this.store.tx(c =>
        c.query(
          'UPDATE credit_operations SET order_id=coalesce(order_id,$3),context=context||$4::jsonb,updated_at=now() WHERE environment=$1 AND id=$2',
          [this.store.environment, op.id, orderKey, JSON.stringify(patch)],
        ),
      );
      await this.reconcile(op.id);
    }
  }
}
