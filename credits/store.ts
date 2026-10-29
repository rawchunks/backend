import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { cacheDel, cacheGet, cacheSet, singleFlight } from '../databases/cache.js';

const schema = `
CREATE TABLE IF NOT EXISTS credit_accounts (environment text NOT NULL,owner text NOT NULL,available bigint NOT NULL DEFAULT 0 CHECK(available>=0),spent bigint NOT NULL DEFAULT 0 CHECK(spent>=0),suspended bigint NOT NULL DEFAULT 0 CHECK(suspended>=0),PRIMARY KEY(environment,owner));
CREATE TABLE IF NOT EXISTS credit_holds (environment text NOT NULL,id text NOT NULL,session_id text NOT NULL DEFAULT 'pool',owner text,credit_source text NOT NULL DEFAULT 'card',maximum bigint NOT NULL CHECK(maximum>0),charged bigint NOT NULL DEFAULT 0 CHECK(charged>=0),closed boolean NOT NULL DEFAULT false,resource text NOT NULL,creator text,context jsonb,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id),CHECK(charged<=maximum));
CREATE TABLE IF NOT EXISTS credit_postings (environment text NOT NULL,id text NOT NULL,owner text NOT NULL,amount bigint NOT NULL,kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id));
CREATE TABLE IF NOT EXISTS credit_operations (environment text NOT NULL,id text NOT NULL,owner text NOT NULL,kind text NOT NULL,amount bigint NOT NULL,status text NOT NULL DEFAULT 'pending',order_id text,capture_id text,context jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,last_error text,PRIMARY KEY(environment,id),UNIQUE(environment,capture_id),UNIQUE(environment,order_id));
CREATE TABLE IF NOT EXISTS credit_lots (environment text NOT NULL,id text NOT NULL,owner text NOT NULL,capture_id text NOT NULL,amount bigint NOT NULL CHECK(amount>0),available bigint NOT NULL DEFAULT 0 CHECK(available>=0),allocated bigint NOT NULL DEFAULT 0 CHECK(allocated>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),spent bigint NOT NULL DEFAULT 0 CHECK(spent>=0),refund_pending bigint NOT NULL DEFAULT 0 CHECK(refund_pending>=0),refunded bigint NOT NULL DEFAULT 0 CHECK(refunded>=0),suspended bigint NOT NULL DEFAULT 0 CHECK(suspended>=0),reversed bigint NOT NULL DEFAULT 0 CHECK(reversed>=0),disputed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id),UNIQUE(environment,capture_id),CHECK(amount=available+allocated+reserved+spent+refund_pending+refunded+suspended+reversed));
CREATE TABLE IF NOT EXISTS credit_hold_lots (environment text NOT NULL,hold_id text NOT NULL,lot_id text NOT NULL,remaining bigint NOT NULL CHECK(remaining>=0),PRIMARY KEY(environment,hold_id,lot_id));
CREATE TABLE IF NOT EXISTS credit_creators (environment text NOT NULL,owner text NOT NULL,payable bigint NOT NULL DEFAULT 0 CHECK(payable>=0),paid bigint NOT NULL DEFAULT 0,PRIMARY KEY(environment,owner));
CREATE TABLE IF NOT EXISTS credit_events (environment text NOT NULL,id text NOT NULL,payload jsonb NOT NULL,processed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id));
CREATE TABLE IF NOT EXISTS credit_outbox (environment text NOT NULL,id text NOT NULL,kind text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id));
`;

const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const identifier = (value: string) => { if (!value || value.length > 128) throw fail('Invalid operation identifier', 400); };
const positive = (value: bigint) => { if (value <= 0n || value > 999999999999999999n) throw fail('Invalid atomic amount', 400); };

export interface CreditConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(): void;
}
export interface CreditPool { connect(): Promise<CreditConnection>; end?(): Promise<void> }
export type CreditLotSource = 'promo' | 'card';
export const PROMO_CAMPAIGN_ID = 'promo:welcome-100';
export const PROMO_MAX_CLAIMS = 1000;
export const PROMO_AMOUNT_ATOMICS = 1_000_000n;

export interface CreditPromoStatus {
  eligible: boolean;
  claimed: boolean;
  remaining: number;
  maxClaims: number;
  amountAtomics: string;
  availableAtomics: string;
  reservedAtomics: string;
  spentAtomics: string;
  reason?: 'claimed' | 'identity_required' | 'exhausted';
}

export interface CreditBalanceSnapshot {
  availableAtomics: string;
  reservedAtomics: string;
  spentAtomics: string;
  suspendedAtomics: string;
  promo: CreditPromoStatus;
}

const SNAPSHOT_L2_TTL_SEC = 120;
const SNAPSHOT_L1_TTL_MS = 15_000;
const PROMO_COUNT_L2_TTL_SEC = 60;
const PROMO_COUNT_L1_TTL_MS = 15_000;

export class CreditStore {
  constructor(public readonly pool: CreditPool, public readonly environment: 'sandbox' | 'live') {}

  private promoCountKey(): string {
    return `rawchunks:cr:promo:${this.environment}`;
  }

  private ownerSnapKey(owner: string): string {
    return `rawchunks:cr:snap:${this.environment}:${owner.toLowerCase()}`;
  }

  async invalidateOwner(owner: string, invalidatePromoCount = false): Promise<void> {
    const keys = [this.ownerSnapKey(owner)];
    if (invalidatePromoCount) keys.push(this.promoCountKey());
    await cacheDel(...keys);
  }

  async tx<T>(run: (connection: CreditConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await run(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async migrate(): Promise<void> {
    await this.tx(async c => {
      for (const statement of schema.split(';').filter(part => part.trim())) {
        await c.query(statement);
      }
      await c.query('ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS owner text');
      await c.query("ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS credit_source text NOT NULL DEFAULT 'card'");
      await c.query("ALTER TABLE credit_holds ALTER COLUMN session_id SET DEFAULT 'pool'");

      const hasSessions = (await c.query("SELECT to_regclass('public.credit_sessions') AS reg")).rows[0]?.reg;
      if (hasSessions) {
        await c.query('UPDATE credit_holds h SET owner = s.owner FROM credit_sessions s WHERE h.owner IS NULL AND s.environment = h.environment AND s.id = h.session_id');
        await c.query('UPDATE credit_sessions SET remaining = 0, closed = true WHERE NOT closed');
      }
      const hasSessionLots = (await c.query("SELECT to_regclass('public.credit_session_lots') AS reg")).rows[0]?.reg;
      if (hasSessionLots) {
        await c.query('UPDATE credit_session_lots SET remaining = 0 WHERE remaining > 0');
      }
      await c.query('UPDATE credit_lots SET available = available + allocated, allocated = 0 WHERE allocated > 0');
      await c.query('UPDATE credit_accounts a SET available = COALESCE((SELECT SUM(l.available) FROM credit_lots l WHERE l.environment = a.environment AND l.owner = a.owner AND NOT l.disputed), 0)');
    });
  }

  private async account(c: CreditConnection, owner: string) {
    await c.query('INSERT INTO credit_accounts(environment,owner) VALUES($1,$2) ON CONFLICT DO NOTHING', [this.environment, owner]);
    return (await c.query('SELECT * FROM credit_accounts WHERE environment=$1 AND owner=$2 FOR UPDATE', [this.environment, owner])).rows[0];
  }

  private async posting(c: CreditConnection, owner: string, id: string, amount: bigint, kind: string) {
    const result = await c.query(
      'INSERT INTO credit_postings(environment,id,owner,amount,kind) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
      [this.environment, id, owner, String(amount), kind],
    );
    if (result.rows.length) return true;
    const previous = (await c.query('SELECT * FROM credit_postings WHERE environment=$1 AND id=$2', [this.environment, id])).rows[0];
    if (previous.owner !== owner || String(previous.amount) !== String(amount) || previous.kind !== kind) {
      throw fail('Operation replay mismatch');
    }
    return false;
  }

  private async getPromoRemaining(c: CreditConnection): Promise<number> {
    const key = this.promoCountKey();
    const hit = await cacheGet<number>(key, PROMO_COUNT_L1_TTL_MS);
    if (hit !== undefined) return hit;
    const countRow = (await c.query('SELECT count(*)::int AS count FROM credit_lots WHERE environment=$1 AND id LIKE $2', [this.environment, `${PROMO_CAMPAIGN_ID}:%`])).rows[0];
    const remaining = Math.max(0, PROMO_MAX_CLAIMS - Number(countRow?.count ?? 0));
    await cacheSet(key, remaining, PROMO_COUNT_L2_TTL_SEC, PROMO_COUNT_L1_TTL_MS);
    return remaining;
  }

  async publicPromoRemaining(): Promise<number> {
    const key = this.promoCountKey();
    const hit = await cacheGet<number>(key, PROMO_COUNT_L1_TTL_MS);
    if (hit !== undefined) return hit;
    return singleFlight(`sf:${key}`, async () => {
      const conn = await this.pool.connect();
      try {
        return await this.getPromoRemaining(conn);
      } finally {
        conn.release();
      }
    });
  }

  async publicPromoStatus(): Promise<CreditPromoStatus> {
    const remaining = await this.publicPromoRemaining();
    return {
      eligible: remaining > 0,
      claimed: false,
      remaining,
      maxClaims: PROMO_MAX_CLAIMS,
      amountAtomics: String(PROMO_AMOUNT_ATOMICS),
      availableAtomics: '0',
      reservedAtomics: '0',
      spentAtomics: '0',
      ...(remaining <= 0 ? { reason: 'exhausted' } : {}),
    };
  }

  private async promoStatus(c: CreditConnection, owner: string, identityHash?: string | null): Promise<CreditPromoStatus> {
    const remaining = await this.getPromoRemaining(c);
    const maxClaims = PROMO_MAX_CLAIMS;
    const lotId = `${PROMO_CAMPAIGN_ID}:${owner}`;
    const claimedRow = identityHash
      ? (await c.query('SELECT id FROM credit_lots WHERE environment=$1 AND (id=$2 OR capture_id=$3) LIMIT 1', [this.environment, lotId, `${PROMO_CAMPAIGN_ID}:${identityHash}`])).rows[0]
      : (await c.query('SELECT id FROM credit_lots WHERE environment=$1 AND id=$2 LIMIT 1', [this.environment, lotId])).rows[0];
    const claimed = Boolean(claimedRow);
    const amountAtomics = String(PROMO_AMOUNT_ATOMICS);
    const totals = (await c.query(
      "SELECT coalesce(sum(available+allocated),0)::text AS available,coalesce(sum(reserved),0)::text AS reserved,coalesce(sum(spent),0)::text AS spent FROM credit_lots WHERE environment=$1 AND owner=$2 AND id LIKE 'promo:%' AND NOT disputed",
      [this.environment, owner],
    )).rows[0];
    const balances = {
      availableAtomics: totals?.available ?? '0',
      reservedAtomics: totals?.reserved ?? '0',
      spentAtomics: totals?.spent ?? '0',
    };
    if (claimed) return { eligible: false, claimed: true, remaining, maxClaims, amountAtomics, ...balances, reason: 'claimed' };
    if (remaining <= 0) return { eligible: false, claimed: false, remaining: 0, maxClaims, amountAtomics, ...balances, reason: 'exhausted' };
    return { eligible: true, claimed: false, remaining, maxClaims, amountAtomics, ...balances };
  }

  private async balanceInConnection(c: CreditConnection, owner: string, identityHash?: string | null): Promise<CreditBalanceSnapshot> {
    const account = (await c.query('SELECT * FROM credit_accounts WHERE environment=$1 AND owner=$2', [this.environment, owner])).rows[0];
    const promo = await this.promoStatus(c, owner, identityHash);
    if (!account) {
      return {
        availableAtomics: '0',
        reservedAtomics: '0',
        spentAtomics: '0',
        suspendedAtomics: '0',
        promo,
      };
    }
    const cardTotals = (await c.query(
      "SELECT coalesce(sum(available+allocated),0)::text AS available,coalesce(sum(reserved),0)::text AS reserved,coalesce(sum(spent),0)::text AS spent,coalesce(sum(suspended),0)::text AS suspended FROM credit_lots WHERE environment=$1 AND owner=$2 AND id NOT LIKE 'promo:%' AND NOT disputed",
      [this.environment, owner],
    )).rows[0];
    return {
      availableAtomics: cardTotals.available,
      reservedAtomics: cardTotals.reserved,
      spentAtomics: cardTotals.spent,
      suspendedAtomics: cardTotals.suspended,
      promo,
    };
  }

  async balance(owner: string, identityHash?: string | null): Promise<CreditBalanceSnapshot> {
    const key = this.ownerSnapKey(owner);
    const hit = await cacheGet<CreditBalanceSnapshot>(key, SNAPSHOT_L1_TTL_MS);
    if (hit) {
      return hit;
    }
    return singleFlight(`sf:${key}`, async () => {
      const balance = await this.tx(c => this.balanceInConnection(c, owner, identityHash));
      await cacheSet(key, balance, SNAPSHOT_L2_TTL_SEC, SNAPSHOT_L1_TTL_MS);
      return balance;
    });
  }

  async claimPromo(owner: string, identityHash: string | null | undefined, key: string): Promise<CreditBalanceSnapshot> {
    identifier(key);
    if (!identityHash) throw fail('A verified email or social account is required to claim Campaign Credits', 403);
    const balance = await this.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [20261000]);
      await this.account(c, owner);
      const lotId = `${PROMO_CAMPAIGN_ID}:${owner}`;
      const captureId = `${PROMO_CAMPAIGN_ID}:${identityHash}`;
      const existing = (await c.query('SELECT * FROM credit_lots WHERE environment=$1 AND (id=$2 OR capture_id=$3) LIMIT 1', [this.environment, lotId, captureId])).rows[0];
      if (existing) throw fail('Campaign Credits already claimed', 409);
      const countRow = (await c.query('SELECT count(*)::int AS count FROM credit_lots WHERE environment=$1 AND id LIKE $2', [this.environment, `${PROMO_CAMPAIGN_ID}:%`])).rows[0];
      if (Number(countRow?.count ?? 0) >= PROMO_MAX_CLAIMS) throw fail('Campaign Credits exhausted (first 1,000 users reached)', 409);
      if (await this.posting(c, owner, `capture:${captureId}`, PROMO_AMOUNT_ATOMICS, 'promo')) {
        await c.query(
          'INSERT INTO credit_lots(environment,id,owner,capture_id,amount,available) VALUES($1,$2,$3,$4,$5,$5)',
          [this.environment, lotId, owner, captureId, String(PROMO_AMOUNT_ATOMICS)],
        );
        await c.query(
          'UPDATE credit_accounts SET available=available+$3 WHERE environment=$1 AND owner=$2',
          [this.environment, owner, String(PROMO_AMOUNT_ATOMICS)],
        );
      } else {
        throw fail('Campaign Credits already claimed', 409);
      }
      return this.balanceInConnection(c, owner, identityHash);
    });
    await this.invalidateOwner(owner, true);
    return balance;
  }

  async reserve(owner: string, source: CreditLotSource, id: string, maximum: bigint, resource: string, creator?: string) {
    positive(maximum);
    identifier(id);
    if (creator && source === 'promo') {
      throw fail("Promo credits can't be used for Streaming and Licenses. Use your free credits to generate and edit your songs!", 402);
    }
    const hold = await this.tx(async c => {
      await this.account(c, owner);
      const existing = (await c.query('SELECT * FROM credit_holds WHERE environment=$1 AND id=$2', [this.environment, id])).rows[0];
      if (existing) {
        if (
          existing.owner !== owner ||
          existing.credit_source !== source ||
          String(existing.maximum) !== String(maximum) ||
          existing.resource !== resource ||
          (existing.creator || undefined) !== creator ||
          existing.closed
        ) {
          throw fail('Operation reservation replay mismatch');
        }
        return existing;
      }

      const lots = (
        await c.query(
          source === 'promo'
            ? "SELECT * FROM credit_lots WHERE environment=$1 AND owner=$2 AND available>0 AND NOT disputed AND id LIKE 'promo:%' ORDER BY created_at,id FOR UPDATE"
            : "SELECT * FROM credit_lots WHERE environment=$1 AND owner=$2 AND available>0 AND NOT disputed AND id NOT LIKE 'promo:%' ORDER BY created_at,id FOR UPDATE",
          [this.environment, owner],
        )
      ).rows;

      const holdRow = (
        await c.query(
          'INSERT INTO credit_holds(environment,id,session_id,owner,credit_source,maximum,resource,creator) VALUES($1,$2,$3,$4,$3,$5,$6,$7) RETURNING *',
          [this.environment, id, source, owner, String(maximum), resource, creator || null],
        )
      ).rows[0];

      let remaining = maximum;
      for (const lot of lots) {
        const take = BigInt(lot.available) < remaining ? BigInt(lot.available) : remaining;
        if (!take) break;
        await c.query('UPDATE credit_lots SET available=available-$3,reserved=reserved+$3 WHERE environment=$1 AND id=$2', [this.environment, lot.id, String(take)]);
        await c.query('INSERT INTO credit_hold_lots(environment,hold_id,lot_id,remaining) VALUES($1,$2,$3,$4)', [this.environment, id, lot.id, String(take)]);
        remaining -= take;
      }

      if (remaining > 0n) {
        throw fail(source === 'promo' ? 'Insufficient available Campaign Credits' : 'Insufficient available Card Credits', 402);
      }

      await c.query('UPDATE credit_accounts SET available=available-$3 WHERE environment=$1 AND owner=$2', [this.environment, owner, String(maximum)]);
      return holdRow;
    });
    await this.invalidateOwner(owner);
    return hold;
  }

  private async hold(c: CreditConnection, owner: string, id: string) {
    await this.account(c, owner);
    const hold = (await c.query('SELECT * FROM credit_holds WHERE environment=$1 AND id=$2 AND owner=$3 FOR UPDATE', [this.environment, id, owner])).rows[0];
    if (!hold) throw fail('Unknown operation reservation', 404);
    return hold;
  }

  async commit(owner: string, id: string, amount: bigint) {
    if (amount < 0n) throw fail('Invalid charge', 400);
    await this.tx(async c => {
      const hold = await this.hold(c, owner, id);
      const previous = BigInt(hold.charged);
      if (amount <= previous) return;
      if (hold.closed || amount > BigInt(hold.maximum)) throw fail('Charge exceeds reservation');
      const delta = amount - previous;
      if (!(await this.posting(c, owner, `charge:${id}:${amount}`, delta, 'service-charge'))) return;
      const lots = (await c.query('SELECT * FROM credit_hold_lots WHERE environment=$1 AND hold_id=$2 AND remaining>0 ORDER BY lot_id FOR UPDATE', [this.environment, id])).rows;
      let remaining = delta;
      for (const lot of lots) {
        const take = BigInt(lot.remaining) < remaining ? BigInt(lot.remaining) : remaining;
        if (!take) break;
        await c.query('UPDATE credit_lots SET reserved=reserved-$3,spent=spent+$3 WHERE environment=$1 AND id=$2', [this.environment, lot.lot_id, String(take)]);
        await c.query('UPDATE credit_hold_lots SET remaining=remaining-$4 WHERE environment=$1 AND hold_id=$2 AND lot_id=$3', [this.environment, id, lot.lot_id, String(take)]);
        remaining -= take;
      }
      if (remaining > 0n) throw fail('Charge attribution missing');
      await c.query('UPDATE credit_accounts SET spent=spent+$3 WHERE environment=$1 AND owner=$2', [this.environment, owner, String(delta)]);
      await c.query('UPDATE credit_holds SET charged=$3 WHERE environment=$1 AND id=$2', [this.environment, id, String(amount)]);
      if (hold.creator) {
        const share = (amount - (amount * 20n) / 100n) - (previous - (previous * 20n) / 100n);
        await c.query(
          'INSERT INTO credit_creators(environment,owner,payable) VALUES($1,$2,$3) ON CONFLICT(environment,owner) DO UPDATE SET payable=credit_creators.payable+excluded.payable',
          [this.environment, hold.creator, String(share)],
        );
      }
    });
    await this.invalidateOwner(owner);
  }

  async release(owner: string, id: string) {
    await this.tx(async c => {
      const hold = await this.hold(c, owner, id);
      if (hold.closed) return;
      const amount = BigInt(hold.maximum) - BigInt(hold.charged);
      if (!(await this.posting(c, owner, `release:${id}`, amount, 'service-release'))) return;
      const lots = (await c.query('SELECT * FROM credit_hold_lots WHERE environment=$1 AND hold_id=$2 AND remaining>0 FOR UPDATE', [this.environment, id])).rows;
      for (const lot of lots) {
        await c.query('UPDATE credit_lots SET reserved=reserved-$3,available=available+$3 WHERE environment=$1 AND id=$2', [this.environment, lot.lot_id, String(lot.remaining)]);
      }
      await c.query('UPDATE credit_hold_lots SET remaining=0 WHERE environment=$1 AND hold_id=$2', [this.environment, id]);
      if (amount > 0n) {
        await c.query('UPDATE credit_accounts SET available=available+$3 WHERE environment=$1 AND owner=$2', [this.environment, owner, String(amount)]);
      }
      await c.query('UPDATE credit_holds SET closed=true WHERE environment=$1 AND id=$2', [this.environment, id]);
    });
    await this.invalidateOwner(owner);
  }

  async creditCapture(owner: string, id: string, captureId: string, amount: bigint) {
    positive(amount);
    await this.tx(async c => {
      await this.account(c, owner);
      const op = (await c.query('SELECT * FROM credit_operations WHERE environment=$1 AND id=$2 AND owner=$3 FOR UPDATE', [this.environment, id, owner])).rows[0];
      if (!op) throw fail('Unknown payment operation', 404);
      if (String(op.amount) !== String(amount) || op.kind !== 'purchase') throw fail('Capture amount mismatch');
      if (op.status === 'credited') {
        if (op.capture_id !== captureId) throw fail('Capture replay mismatch');
        return;
      }
      if (await this.posting(c, owner, `capture:${captureId}`, amount, 'purchase')) {
        await c.query('INSERT INTO credit_lots(environment,id,owner,capture_id,amount,available) VALUES($1,$2,$3,$4,$5,$5)', [this.environment, id, owner, captureId, String(amount)]);
        await c.query('UPDATE credit_accounts SET available=available+$3 WHERE environment=$1 AND owner=$2', [this.environment, owner, String(amount)]);
      } else {
        throw fail('Capture is already attributed to another operation');
      }
      await c.query("UPDATE credit_operations SET status='credited',capture_id=$3,updated_at=now() WHERE environment=$1 AND id=$2", [this.environment, id, captureId]);
    });
    await this.invalidateOwner(owner);
  }
}

let store: CreditStore | undefined;
export function creditStore(): CreditStore {
  if (store) return store;
  const environment = process.env.PAYPAL_ENV;
  if (environment !== 'sandbox' && environment !== 'live') throw new Error('PayPal environment must be explicit');
  const url = process.env.CREDITS_DATABASE_URL || process.env.USER_DATABASE_URL;
  if (!url) throw new Error('Credits database unavailable');
  neonConfig.webSocketConstructor = ws;
  store = new CreditStore(new Pool({ connectionString: url, max: 8 }) as CreditPool, environment);
  return store;
}
