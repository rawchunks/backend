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

describe('Direct spendable Credits (Card & Campaign)', () => {
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
  it('reserves directly from available balance and returns unused amount on release', async () => {
    await buy();
    await store.reserve(owner, 'card', 'generation-a', 50000n, 'generate');
    await store.reserve(owner, 'card', 'generation-a', 50000n, 'generate');
    expect(await store.balance(owner)).toMatchObject({ availableAtomics: '9950000', reservedAtomics: '50000' });
    await store.commit(owner, 'generation-a', 30000n);
    await store.release(owner, 'generation-a');
    await store.release(owner, 'generation-a');
    expect(await store.balance(owner)).toMatchObject({ availableAtomics: '9970000', reservedAtomics: '0', spentAtomics: '30000' });
  });
  it('prevents concurrent reservations from overspending available balance', async () => {
    await buy();
    const results = await Promise.allSettled([
      store.reserve(owner, 'card', 'op-a', 7000000n, 'generate'),
      store.reserve(owner, 'card', 'op-b', 7000000n, 'generate'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.balance(owner)).availableAtomics).toBe('3000000');
    expect((await store.balance(owner)).reservedAtomics).toBe('7000000');
  });
  it('charges only new cumulative metered usage and carries creator precision', async () => {
    await buy();
    await store.reserve(owner, 'card', 'stream-a', 1000n, 'stream:song-a', other);
    await store.commit(owner, 'stream-a', 1n);
    await store.commit(owner, 'stream-a', 1n);
    await store.commit(owner, 'stream-a', 6n);
    expect((await store.balance(owner)).spentAtomics).toBe('6');
    expect((await db.query('SELECT payable::text FROM credit_creators WHERE owner=$1', [other])).rows).toEqual([{ payable: '4' }]);
  });
  it('keeps millisecond acknowledgments, cumulative creator shares and releases unused authorization', async () => {
    await buy();
    await store.reserve(owner, 'card', 'stream-ms', 90000n, 'stream:song-ms', other);
    await db.query("UPDATE credit_holds SET context=$2::jsonb WHERE id=$1", ['stream-ms', JSON.stringify({ kind: 'stream', acceptedMs: 0 })]);
    for (const [millis, total] of [[20000, 10000n], [40000, 20000n], [60000, 30000n], [60125, 30062n]] as const) expect(await store.commit(owner, 'stream-ms', total, millis)).toMatchObject({ billedWei: String(total), acceptedMs: millis });
    expect(await store.commit(owner, 'stream-ms', 10000n, 20000)).toMatchObject({ billedWei: '30062', deltaWei: '0', acceptedMs: 60125 });
    await store.release(owner, 'stream-ms');
    expect(await store.balance(owner)).toMatchObject({ spentAtomics: '30062', reservedAtomics: '0', availableAtomics: '9969938' });
    expect((await db.query('SELECT payable::text FROM credit_creators WHERE owner=$1', [other])).rows).toEqual([{ payable: '24049' }]);
  });
  it('migrates the old session foreign key before reserving Direct Card Credits', async () => {
    await buy();
    await db.query('CREATE TABLE credit_sessions (environment text,id text,owner text,remaining bigint NOT NULL DEFAULT 0,closed boolean NOT NULL DEFAULT false,PRIMARY KEY(environment,id))');
    await db.query('ALTER TABLE credit_holds ADD CONSTRAINT credit_holds_environment_session_id_fkey FOREIGN KEY(environment,session_id) REFERENCES credit_sessions(environment,id)');
    await store.migrate();
    await store.reserve(owner, 'card', 'direct-card', 1000n, 'stream:song', other);
    await store.commit(owner, 'direct-card', 1000n);
    expect(await store.balance(owner)).toMatchObject({ spentAtomics: '1000' });
  });
  it('isolates sandbox balances from live', async () => {
    await buy();
    expect((await new CreditStore(store.pool, 'live').balance(owner)).availableAtomics).toBe('0');
  });
  it('strictly isolates Campaign (promo) credits from Card credits and rejects promo for streaming', async () => {
    const balAfterClaim = await store.claimPromo(owner, 'identity-hash-1', 'claim-1');
    expect(balAfterClaim.availableAtomics).toBe('0');
    expect(balAfterClaim.promo).toMatchObject({
      claimed: true,
      availableAtomics: '1000000',
      reservedAtomics: '0',
      spentAtomics: '0',
    });

    // Spend 25 CR (250,000 atomics) from Campaign pool directly
    await store.reserve(owner, 'promo', 'gen-promo-1', 250000n, 'generate');
    await store.commit(owner, 'gen-promo-1', 250000n);
    await store.release(owner, 'gen-promo-1');

    const balAfterSpend = await store.balance(owner, 'identity-hash-1');
    expect(balAfterSpend.availableAtomics).toBe('0');
    expect(balAfterSpend.promo).toMatchObject({
      claimed: true,
      availableAtomics: '750000',
      reservedAtomics: '0',
      spentAtomics: '250000',
    });

    // Attempting to spend from Card pool without Card credits fails even though Campaign credits exist
    await expect(store.reserve(owner, 'card', 'card-attempt', 50000n, 'generate')).rejects.toMatchObject({ statusCode: 402 });

    // Attempting to spend Campaign credits on a creator-paid resource (streaming/licenses) fails with 402
    await expect(store.reserve(owner, 'promo', 'stream-attempt', 30000n, 'stream:song-a', other)).rejects.toMatchObject({ statusCode: 402 });

    // Buying Card credits keeps Card and Campaign balances completely separate
    await buy(10000000n, 'purchase-card-1', 'capture-card-1');
    const balWithBoth = await store.balance(owner, 'identity-hash-1');
    expect(balWithBoth.availableAtomics).toBe('10000000');
    expect(balWithBoth.promo.availableAtomics).toBe('750000');
  });
  it('reclaims legacy allocated credit_lots back into available during migrate()', async () => {
    await buy(10000000n, 'purchase-legacy', 'capture-legacy');
    await db.query("UPDATE credit_lots SET available = 3000000, allocated = 7000000 WHERE owner = $1", [owner]);
    await store.migrate();
    const bal = await store.balance(owner);
    expect(bal.availableAtomics).toBe('10000000');
  });
});
