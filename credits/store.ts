import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { createHash } from 'node:crypto';

const schema = `
CREATE TABLE IF NOT EXISTS credit_accounts (environment text NOT NULL,owner text NOT NULL,available bigint NOT NULL DEFAULT 0 CHECK(available>=0),spent bigint NOT NULL DEFAULT 0 CHECK(spent>=0),suspended bigint NOT NULL DEFAULT 0 CHECK(suspended>=0),PRIMARY KEY(environment,owner));
CREATE TABLE IF NOT EXISTS credit_sessions (environment text NOT NULL,id text NOT NULL,owner text NOT NULL,budget bigint NOT NULL,remaining bigint NOT NULL CHECK(remaining>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),spent bigint NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL,closed boolean NOT NULL DEFAULT false,duration_seconds integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id));
CREATE TABLE IF NOT EXISTS credit_holds (environment text NOT NULL,id text NOT NULL,session_id text NOT NULL,maximum bigint NOT NULL CHECK(maximum>0),charged bigint NOT NULL DEFAULT 0 CHECK(charged>=0),closed boolean NOT NULL DEFAULT false,resource text NOT NULL,creator text,context jsonb,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id),CHECK(charged<=maximum));
CREATE TABLE IF NOT EXISTS credit_postings (environment text NOT NULL,id text NOT NULL,owner text NOT NULL,amount bigint NOT NULL,kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id));
CREATE TABLE IF NOT EXISTS credit_operations (environment text NOT NULL,id text NOT NULL,owner text NOT NULL,kind text NOT NULL,amount bigint NOT NULL,status text NOT NULL DEFAULT 'pending',order_id text,capture_id text,context jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,last_error text,PRIMARY KEY(environment,id),UNIQUE(environment,capture_id),UNIQUE(environment,order_id));
CREATE TABLE IF NOT EXISTS credit_lots (environment text NOT NULL,id text NOT NULL,owner text NOT NULL,capture_id text NOT NULL,amount bigint NOT NULL CHECK(amount>0),available bigint NOT NULL DEFAULT 0 CHECK(available>=0),allocated bigint NOT NULL DEFAULT 0 CHECK(allocated>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),spent bigint NOT NULL DEFAULT 0 CHECK(spent>=0),refund_pending bigint NOT NULL DEFAULT 0 CHECK(refund_pending>=0),refunded bigint NOT NULL DEFAULT 0 CHECK(refunded>=0),suspended bigint NOT NULL DEFAULT 0 CHECK(suspended>=0),reversed bigint NOT NULL DEFAULT 0 CHECK(reversed>=0),disputed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,id),UNIQUE(environment,capture_id),CHECK(amount=available+allocated+reserved+spent+refund_pending+refunded+suspended+reversed));
CREATE TABLE IF NOT EXISTS credit_session_lots (environment text NOT NULL,session_id text NOT NULL,lot_id text NOT NULL,remaining bigint NOT NULL CHECK(remaining>=0),reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),PRIMARY KEY(environment,session_id,lot_id));
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
export type CreditCheckoutIntent = { kind: 'balance' } | { kind: 'start'; durationSeconds: number } | { kind: 'topup'; sessionId: string };

export class CreditStore {
  constructor(public readonly pool: CreditPool, public readonly environment: 'sandbox' | 'live') {}
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
    } finally { connection.release(); }
  }
  async migrate(): Promise<void> {
    await this.tx(async c => { for (const statement of schema.split(';').filter(part => part.trim())) await c.query(statement); });
  }
  private async account(c: CreditConnection, owner: string) {
    await c.query('INSERT INTO credit_accounts(environment,owner) VALUES($1,$2) ON CONFLICT DO NOTHING', [this.environment, owner]);
    return (await c.query('SELECT * FROM credit_accounts WHERE environment=$1 AND owner=$2 FOR UPDATE', [this.environment, owner])).rows[0];
  }
  private async posting(c: CreditConnection, owner: string, id: string, amount: bigint, kind: string) {
    const result = await c.query('INSERT INTO credit_postings(environment,id,owner,amount,kind) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id', [this.environment, id, owner, String(amount), kind]);
    if (result.rows.length) return true;
    const previous = (await c.query('SELECT * FROM credit_postings WHERE environment=$1 AND id=$2', [this.environment, id])).rows[0];
    if (previous.owner !== owner || String(previous.amount) !== String(amount) || previous.kind !== kind) throw fail('Operation replay mismatch');
    return false;
  }
  private async readSession(c: CreditConnection, owner: string, id: string) {
    const row = (await c.query('SELECT * FROM credit_sessions WHERE environment=$1 AND id=$2 AND owner=$3 FOR UPDATE', [this.environment, id, owner])).rows[0];
    if (!row) throw fail('Unknown session', 404);
    return row;
  }
  private active(row: any) {
    if (row.closed || new Date(row.expires_at).getTime() <= Date.now()) throw fail('Session is closed or expired');
  }
  private async allocate(c: CreditConnection, owner: string, sid: string, amount: bigint) {
    const lots = (await c.query('SELECT * FROM credit_lots WHERE environment=$1 AND owner=$2 AND available>0 AND NOT disputed ORDER BY created_at,id FOR UPDATE', [this.environment, owner])).rows;
    let remaining = amount;
    for (const lot of lots) {
      const take = BigInt(lot.available) < remaining ? BigInt(lot.available) : remaining;
      if (!take) break;
      await c.query('UPDATE credit_lots SET available=available-$3,allocated=allocated+$3 WHERE environment=$1 AND id=$2', [this.environment, lot.id, String(take)]);
      await c.query('INSERT INTO credit_session_lots(environment,session_id,lot_id,remaining) VALUES($1,$2,$3,$4) ON CONFLICT(environment,session_id,lot_id) DO UPDATE SET remaining=credit_session_lots.remaining+excluded.remaining', [this.environment, sid, lot.id, String(take)]);
      remaining -= take;
    }
    if (remaining) throw fail('Insufficient available Credits', 402);
  }
  private async close(c: CreditConnection, owner: string, row: any) {
    if (row.closed) return row;
    const amount = BigInt(row.remaining);
    if (await this.posting(c, owner, `end:${row.id}`, amount, 'session-end')) {
      const lots = (await c.query('SELECT * FROM credit_session_lots WHERE environment=$1 AND session_id=$2 AND remaining>0 FOR UPDATE', [this.environment, row.id])).rows;
      for (const lot of lots) await c.query('UPDATE credit_lots SET allocated=allocated-$3,available=available+$3 WHERE environment=$1 AND id=$2', [this.environment, lot.lot_id, String(lot.remaining)]);
      await c.query('UPDATE credit_session_lots SET remaining=0 WHERE environment=$1 AND session_id=$2', [this.environment, row.id]);
      await c.query('UPDATE credit_accounts SET available=available+$3 WHERE environment=$1 AND owner=$2', [this.environment, owner, String(amount)]);
      await c.query('UPDATE credit_sessions SET remaining=0,closed=true WHERE environment=$1 AND id=$2', [this.environment, row.id]);
    }
    return { ...row, remaining: '0', closed: true };
  }
  async balance(owner: string) {
    return this.tx(async c => {
      const account = (await c.query('SELECT * FROM credit_accounts WHERE environment=$1 AND owner=$2 FOR UPDATE', [this.environment, owner])).rows[0];
      if (!account) return { availableAtomics: '0', allocatedAtomics: '0', reservedAtomics: '0', spentAtomics: '0', suspendedAtomics: '0' };
      const expired = (await c.query('SELECT * FROM credit_sessions WHERE environment=$1 AND owner=$2 AND NOT closed AND expires_at<=now() FOR UPDATE', [this.environment, owner])).rows;
      for (const row of expired) await this.close(c, owner, row);
      const fresh = (await c.query('SELECT * FROM credit_accounts WHERE environment=$1 AND owner=$2', [this.environment, owner])).rows[0];
      const totals = (await c.query('SELECT coalesce(sum(remaining),0)::text allocated,coalesce(sum(reserved),0)::text reserved FROM credit_sessions WHERE environment=$1 AND owner=$2', [this.environment, owner])).rows[0];
      return { availableAtomics: String(fresh.available), allocatedAtomics: totals.allocated, reservedAtomics: totals.reserved, spentAtomics: String(fresh.spent), suspendedAtomics: String(fresh.suspended) };
    });
  }
  async start(owner: string, amount: bigint, duration: number, key: string) {
    positive(amount); identifier(key);
    if (!Number.isInteger(duration) || duration < 60 || duration > 604800) throw fail('Invalid session duration', 400);
    return this.tx(c => this.startInTransaction(c, owner, amount, duration, key));
  }
  private async startInTransaction(c: CreditConnection, owner: string, amount: bigint, duration: number, key: string) {
    const id = createHash('sha256').update(`${this.environment}:${owner}:session:${key}`).digest('hex');
      const account = await this.account(c, owner);
      const previous = (await c.query('SELECT * FROM credit_sessions WHERE environment=$1 AND id=$2', [this.environment, id])).rows[0];
      if (previous) {
        const posting = (await c.query('SELECT amount FROM credit_postings WHERE environment=$1 AND id=$2', [this.environment, `start:${id}`])).rows[0];
        if (String(posting.amount) !== String(amount) || previous.duration_seconds !== duration) throw fail('Session request replay mismatch');
        return previous;
      }
      if (BigInt(account.available) < amount) throw fail('Insufficient available Credits', 402);
      const row = (await c.query('INSERT INTO credit_sessions(environment,id,owner,budget,remaining,duration_seconds,expires_at) VALUES($1,$2,$3,$4,$4,$5,now()+$5::integer*interval \'1 second\') RETURNING *', [this.environment, id, owner, String(amount), duration])).rows[0];
      await this.allocate(c, owner, id, amount);
      if (await this.posting(c, owner, `start:${id}`, amount, 'session-start')) await c.query('UPDATE credit_accounts SET available=available-$3 WHERE environment=$1 AND owner=$2', [this.environment, owner, String(amount)]);
      return row;
  }
  private async topupInTransaction(c: CreditConnection, owner: string, id: string, amount: bigint, key: string) {
      const account = await this.account(c, owner);
      const row = await this.readSession(c, owner, id);
      const post = `topup:${id}:${key}`;
      const existing = (await c.query('SELECT * FROM credit_postings WHERE environment=$1 AND id=$2', [this.environment, post])).rows[0];
      if (existing) { if (String(existing.amount) !== String(amount)) throw fail('Top up replay mismatch'); return row; }
      this.active(row);
      if (BigInt(account.available) < amount) throw fail('Insufficient available Credits', 402);
      await this.allocate(c, owner, id, amount);
      if (await this.posting(c, owner, post, amount, 'session-topup')) {
        await c.query('UPDATE credit_accounts SET available=available-$3 WHERE environment=$1 AND owner=$2', [this.environment, owner, String(amount)]);
        return (await c.query('UPDATE credit_sessions SET remaining=remaining+$3,budget=budget+$3 WHERE environment=$1 AND id=$2 RETURNING *', [this.environment, id, String(amount)])).rows[0];
      }
      return row;
  }
  async topup(owner: string, id: string, amount: bigint, key: string) {
    positive(amount); identifier(key);
    return this.tx(c => this.topupInTransaction(c, owner, id, amount, key));
  }
  async end(owner: string, id: string) {
    return this.tx(async c => { await this.account(c, owner); return this.close(c, owner, await this.readSession(c, owner, id)); });
  }
  async session(owner: string, id: string) { return this.tx(c => this.readSession(c, owner, id)); }
  async reserve(owner: string, sid: string, id: string, maximum: bigint, resource: string, creator?: string) {
    positive(maximum); identifier(id);
    return this.tx(async c => {
      await this.account(c, owner);
      const row = await this.readSession(c, owner, sid);
      const existing = (await c.query('SELECT * FROM credit_holds WHERE environment=$1 AND id=$2', [this.environment, id])).rows[0];
      if (existing) {
        if (existing.session_id !== sid || String(existing.maximum) !== String(maximum) || existing.resource !== resource || (existing.creator || undefined) !== creator || existing.closed) throw fail('Operation reservation replay mismatch');
        return existing;
      }
      this.active(row);
      if (BigInt(row.remaining) < maximum) throw fail('Session Credits exhausted', 402);
      const hold = (await c.query('INSERT INTO credit_holds(environment,id,session_id,maximum,resource,creator) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [this.environment, id, sid, String(maximum), resource, creator || null])).rows[0];
      const lots = (await c.query('SELECT * FROM credit_session_lots WHERE environment=$1 AND session_id=$2 AND remaining>0 ORDER BY lot_id FOR UPDATE', [this.environment, sid])).rows;
      let remaining = maximum;
      for (const lot of lots) {
        const take = BigInt(lot.remaining) < remaining ? BigInt(lot.remaining) : remaining;
        if (!take) break;
        await c.query('UPDATE credit_lots SET allocated=allocated-$3,reserved=reserved+$3 WHERE environment=$1 AND id=$2', [this.environment, lot.lot_id, String(take)]);
        await c.query('UPDATE credit_session_lots SET remaining=remaining-$4,reserved=reserved+$4 WHERE environment=$1 AND session_id=$2 AND lot_id=$3', [this.environment, sid, lot.lot_id, String(take)]);
        await c.query('INSERT INTO credit_hold_lots(environment,hold_id,lot_id,remaining) VALUES($1,$2,$3,$4)', [this.environment, id, lot.lot_id, String(take)]);
        remaining -= take;
      }
      if (remaining) throw fail('Session capture attribution missing');
      await c.query('UPDATE credit_sessions SET remaining=remaining-$3,reserved=reserved+$3 WHERE environment=$1 AND id=$2', [this.environment, sid, String(maximum)]);
      return hold;
    });
  }
  private async hold(c: CreditConnection, owner: string, id: string) {
    await this.account(c, owner);
    const initial = (await c.query('SELECT h.* FROM credit_holds h JOIN credit_sessions s ON s.environment=h.environment AND s.id=h.session_id WHERE h.environment=$1 AND h.id=$2 AND s.owner=$3', [this.environment, id, owner])).rows[0];
    if (!initial) throw fail('Unknown operation reservation', 404);
    const session = await this.readSession(c, owner, initial.session_id);
    const hold = (await c.query('SELECT * FROM credit_holds WHERE environment=$1 AND id=$2 FOR UPDATE', [this.environment, id])).rows[0];
    return { session, hold };
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
