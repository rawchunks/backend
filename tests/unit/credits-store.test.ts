import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { CreditStore, type CreditPool } from '../../credits/store.js';

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
let db: PGlite, store: CreditStore;
beforeEach(async () => {
  db = new PGlite();
  await db.waitReady;
  let previous = Promise.resolve();
  const pool: CreditPool = { connect: async () => {
    const wait = previous;
    let release!: () => void;
    previous = new Promise<void>(done => { release = done; });
    await wait;
    return { query: (sql, values) => db.query(sql, values), release };
  } };
  store = new CreditStore(pool, 'sandbox');
  await store.migrate();
});
afterEach(async () => { await db.close(); });
async function buy(amount = 10000000n, id = 'purchase-a', capture = 'capture-a') {
  await db.query("INSERT INTO credit_accounts(environment,owner) VALUES('sandbox',$1) ON CONFLICT DO NOTHING", [owner]);
  await db.query("INSERT INTO credit_operations(environment,id,owner,kind,amount) VALUES('sandbox',$1,$2,'purchase',$3)", [id, owner, String(amount)]);
  await store.creditCapture(owner, id, capture, amount);
}

describe('Persistent purchased Credits', () => {
  it('credits a verified capture once under concurrent retries', async () => {
    await buy();
    await Promise.all([store.creditCapture(owner, 'purchase-a', 'capture-a', 10000000n), store.creditCapture(owner, 'purchase-a', 'capture-a', 10000000n)]);
    expect((await store.balance(owner)).availableAtomics).toBe('10000000');
    expect((await db.query('SELECT count(*)::integer count FROM credit_postings')).rows).toEqual([{ count: 1 }]);
  });
  it('does not let another account claim an operation', async () => {
    await buy();
    await expect(store.creditCapture(other, 'purchase-a', 'capture-a', 10000000n)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('allocates once and returns paid unused credits after ending a session', async () => {
    await buy();
    const session = await store.start(owner, 3000000n, 3600, 'session-request-a');
    const retry = await store.start(owner, 3000000n, 3600, 'session-request-a');
    expect(retry.id).toBe(session.id);
    expect((await store.balance(owner)).availableAtomics).toBe('7000000');
    await store.end(owner, session.id);
    await store.end(owner, session.id);
    expect(await store.balance(owner)).toMatchObject({ availableAtomics: '10000000', allocatedAtomics: '0' });
  });
  it('prevents concurrent sessions from overspending', async () => {
    await buy();
    const results = await Promise.allSettled([store.start(owner, 7000000n, 3600, 'a'), store.start(owner, 7000000n, 3600, 'b')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.balance(owner)).availableAtomics).toBe('3000000');
  });
  it('tops up the same session exactly once', async () => {
    await buy();
    const session = await store.start(owner, 3000000n, 3600, 'a');
    await store.topup(owner, session.id, 2000000n, 'topup-a');
    await store.topup(owner, session.id, 2000000n, 'topup-a');
    const topped = await store.session(owner, session.id);
    expect(String(topped.remaining)).toBe('5000000');
    expect(String(topped.budget)).toBe('5000000');
    expect((await store.balance(owner)).availableAtomics).toBe('5000000');
  });
  it('applies a durable card topup intent to the same session exactly once', async () => {
    await buy();
    const session = await store.start(owner, 3000000n, 3600, 'a');
    await db.query("INSERT INTO credit_operations(environment,id,owner,kind,amount,context) VALUES('sandbox','purchase-b',$1,'purchase',10000000,$2)", [owner, JSON.stringify({ checkout: { kind: 'topup', sessionId: session.id } })]);
    await store.creditCapture(owner, 'purchase-b', 'capture-b', 10000000n);
    await store.creditCapture(owner, 'purchase-b', 'capture-b', 10000000n);
    expect(String((await store.session(owner, session.id)).budget)).toBe('13000000');
    expect(await store.balance(owner)).toMatchObject({ availableAtomics: '7000000', allocatedAtomics: '13000000' });
    expect((await db.query('SELECT count(*)::integer count FROM credit_sessions')).rows).toEqual([{ count: 1 }]);
  });
  it('keeps a completed card payment available if its topup target was ended', async () => {
    await buy();
    const session = await store.start(owner, 3000000n, 3600, 'a');
    await store.end(owner, session.id);
    await db.query("INSERT INTO credit_operations(environment,id,owner,kind,amount,context) VALUES('sandbox','purchase-b',$1,'purchase',10000000,$2)", [owner, JSON.stringify({ checkout: { kind: 'topup', sessionId: session.id } })]);
    await store.creditCapture(owner, 'purchase-b', 'capture-b', 10000000n);
    expect((await store.balance(owner)).availableAtomics).toBe('20000000');
    expect((await db.query('SELECT count(*)::integer count FROM credit_sessions')).rows).toEqual([{ count: 1 }]);
  });
  it('keeps pending holds when ending a session, then returns only their unused amount', async () => {
    await buy();
    const session = await store.start(owner, 3000000n, 3600, 'a');
    await store.reserve(owner, session.id, 'generation-a', 50000n, 'generate');
    await store.end(owner, session.id);
    expect(await store.balance(owner)).toMatchObject({ availableAtomics: '9950000', reservedAtomics: '50000' });
    await store.commit(owner, 'generation-a', 30000n);
    await store.release(owner, 'generation-a');
    await store.release(owner, 'generation-a');
    expect(await store.balance(owner)).toMatchObject({ availableAtomics: '9970000', reservedAtomics: '0', spentAtomics: '30000' });
  });
  it('expires session allocations once while preserving operation holds', async () => {
    await buy();
    const session = await store.start(owner, 3000000n, 3600, 'a');
    await store.reserve(owner, session.id, 'generation-a', 50000n, 'generate');
    await db.query("UPDATE credit_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [session.id]);
    expect(await store.balance(owner)).toMatchObject({ availableAtomics: '9950000', reservedAtomics: '50000' });
    await expect(store.reserve(owner, session.id, 'generation-b', 50000n, 'generate')).rejects.toMatchObject({ statusCode: 409 });
    await store.release(owner, 'generation-a');
    expect((await store.balance(owner)).availableAtomics).toBe('10000000');
  });
  it('charges only new cumulative metered usage and carries creator precision', async () => {
    await buy();
    const session = await store.start(owner, 3000000n, 3600, 'a');
    await store.reserve(owner, session.id, 'stream-a', 1000n, 'stream:song-a', other);
    await store.commit(owner, 'stream-a', 1n);
    await store.commit(owner, 'stream-a', 1n);
    await store.commit(owner, 'stream-a', 6n);
    expect((await store.balance(owner)).spentAtomics).toBe('6');
    expect((await db.query('SELECT payable::text FROM credit_creators WHERE owner=$1', [other])).rows).toEqual([{ payable: '5' }]);
  });
  it('does not expose or top up another users session', async () => {
    await buy();
    const session = await store.start(owner, 3000000n, 3600, 'a');
    await expect(store.session(other, session.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.topup(other, session.id, 1n, 'x')).rejects.toMatchObject({ statusCode: 404 });
  });
  it('isolates sandbox balances from live', async () => {
    await buy();
    expect((await new CreditStore(store.pool, 'live').balance(owner)).availableAtomics).toBe('0');
  });
});
