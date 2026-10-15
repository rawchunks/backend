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
