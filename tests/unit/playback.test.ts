import {beforeEach,expect,it,vi} from 'vitest';
const wallets = vi.hoisted(() => ({ pair: vi.fn(), song: vi.fn(), authenticate: vi.fn(), creditStore: vi.fn() }));
vi.mock('../../databases/users.js', async original => ({ ...await original<any>(), getWalletPair: wallets.pair }));
vi.mock('../../credits/auth.js', async original => ({ ...await original<any>(), authenticate: wallets.authenticate }));
vi.mock('../../credits/store.js', async original => ({ ...await original<any>(), creditStore: wallets.creditStore }));
const memory=vi.hoisted(()=>({data:new Map<string,string>(),ids:new Set<string>(),locks:new Map<string,Promise<any>>()}));
vi.mock('../../broker/valkey.js',()=>({valkey:{get:async(k:string)=>memory.data.get(k)||null,set:async(k:string,v:string)=>{memory.data.set(k,v);return 'OK';},sadd:async(_:string,id:string)=>memory.ids.add(id),srem:async(_:string,id:string)=>memory.ids.delete(id),sscan:async()=>['0',[...memory.ids]]},getTaskContext:async(id:string)=>JSON.parse(memory.data.get(`rawchunks:context:${id}`)||'null'),withJobLock:async(id:string,run:any)=>{const p=(memory.locks.get(id)||Promise.resolve()).catch(()=>{}).then(()=>run(Object.assign(async()=>{},{save:async(k:string,v:any)=>memory.data.set(`rawchunks:context:${k}`,JSON.stringify(v))})));memory.locks.set(id,p);return p;}}));
vi.mock('../../databases/songs.js', async original => ({ ...await original<any>(), getSongById: wallets.song, incrementSongPlay: async () => null }));
vi.mock('../../storage/r2.js', async original => ({ ...await original<any>(), waitForInFlightAudio: async () => {} }));
import * as payment from '../../broker/payment.js';
import { parseAddress } from '../../databases/users.js';
const evmCreator = '0x2222222222222222222222222222222222222222';
const svmCreator = '7BBctXD2MmTAtJgo6zucZ8MNq11XRdv2hWdLKqy6SgES';
const evmTreasury = '0x3333333333333333333333333333333333333333';
const svmTreasury = '139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const admission={token:'key',network:'eip155:84532',userAddress:'listener',songId:'song',maxAmountWei:'90000',streamPriceUsd:.03,durationMs:180000,creatorAddress:evmCreator,payTo:evmTreasury,idempotencyKey:'playback'};
let requests:{path:string;body:any;network:string}[],settled:Map<string,string>,prepared:Map<string,string>,fail:number,lost:boolean,status:string;
beforeEach(()=>{memory.data.clear();memory.ids.clear();memory.locks.clear();requests=[];settled=new Map();prepared=new Map();fail=0;lost=false;status='confirmed';process.env.COMPOSE_API_URL='https://provider.invalid';process.env.RAWCHUNKS_TREASURY_ADDRESS=evmTreasury;process.env.RAWCHUNKS_SOLANA_TREASURY_ADDRESS=svmTreasury;wallets.pair.mockReset().mockResolvedValue({evmAddress:evmCreator,svmAddress:svmCreator});wallets.song.mockReset().mockImplementation(async(id:string)=>({id,title:'Song',url:'https://cdn.invalid/song.wav',creator:evmCreator,stream_price:.03,duration:180,public:true}));wallets.authenticate.mockReset();wallets.creditStore.mockReset();vi.stubGlobal('fetch',vi.fn(async(url:string,init:any)=>{const path=url.split('/').at(-1)!;if(path==='session')return Response.json({hasSession:false});const body=init?.body?JSON.parse(init.body):{};const network=new Headers(init?.headers).get('x-network-id')!;requests.push({path,body,network});if(fail)return Response.json({error:'Rejected'},{status:fail,headers:{'x-session-budget-remaining':'0'}});if(path==='prepare'){if(!prepared.has(body.idempotencyKey))prepared.set(body.idempotencyKey,`intent-${prepared.size}`);return Response.json({paymentIntentId:prepared.get(body.idempotencyKey)});}if(path==='abort')return Response.json({status:'aborted'});const family=network.startsWith('solana:')?'svm':'evm';for(const recipient of Object.values(body.royalties||{})){try{if(parseAddress(recipient).kind!==family)throw Error('Recipient family');}catch{return Response.json({error:'Recipient is invalid for the payment network'},{status:422});}}const fingerprint=JSON.stringify(body);if(settled.has(body.paymentIntentId)&&settled.get(body.paymentIntentId)!==fingerprint)return Response.json({error:'Checkpoint replay does not match the original settlement request'},{status:409});settled.set(body.paymentIntentId,fingerprint);if(lost){lost=false;throw Error('Lost accepted response');}return Response.json({status,txHash:'hash'});}));});
const admit=()=>payment.prepareStreamPaymentIntent(admission);
const report=(id:any,s:number,terminal=false)=>payment.settleStreamCheckpoint({paymentIntentId:id,token:'key',songId:'song',network:'eip155:84532',listenedSeconds:s,terminal} as any);
it('charges cumulative 20/40/60 seconds and fractional tail using separate immutable deltas',async()=>{const id=await admit();for(const[s,b]of[[20,'10000'],[40,'20000'],[60,'30000'],[60.125,'30062']] as const)expect(await report(id,s,s===60.125)).toMatchObject({billedWei:b,acceptedListenedSeconds:s});const bodies=requests.filter(r=>r.path==='settle').map(r=>r.body);expect(new Set(bodies.map(b=>b.paymentIntentId)).size).toBe(4);expect(bodies.map(b=>b.finalAmountWei)).toEqual(['10000','10000','10000','62']);expect(bodies.at(-1)).toMatchObject({providerAmountWei:'49',platformFeeWei:'13'});});
it('charges zero use and a two-second actual listen precisely',async()=>{const id=await admit();expect(await report(id,0)).toMatchObject({billedWei:'0',acceptedListenedSeconds:0});expect(await report(id,2.003,true)).toMatchObject({billedWei:'1001',acceptedListenedSeconds:2.003});});
it('deduplicates concurrent and older reports',async()=>{const id=await admit();await Promise.all([report(id,20),report(id,20),report(id,40),report(id,20)]);expect(requests.filter(r=>r.path==='settle').map(r=>r.body.finalAmountWei)).toEqual(['10000','10000']);expect(await report(id,20)).toMatchObject({billedWei:'20000',deltaWei:'0',acceptedListenedSeconds:40});});
it('retries the exact body after losing an accepted response',async()=>{const id=await admit();lost=true;await expect(report(id,20)).rejects.toMatchObject({statusCode:503});expect(await report(id,40,true)).toMatchObject({billedWei:'20000'});const bodies=requests.filter(r=>r.path==='settle').map(r=>r.body);expect(bodies[1]).toEqual(bodies[0]);expect(bodies[2].paymentIntentId).not.toBe(bodies[0].paymentIntentId);});
it('recovers received terminal usage after restart',async()=>{const id=await admit();fail=503;await expect(report(id,2.125,true)).rejects.toMatchObject({statusCode:503});memory.locks.clear();fail=0;await (payment as any).recoverPayments();expect(await report(id,2.125,true)).toMatchObject({billedWei:'1062',deltaWei:'0'});expect(memory.ids.size).toBe(0);});
it.each(['queued','submitted'])('preserves %s and reconciles without new charges',async value=>{const id=await admit();status=value;expect(await report(id,20,true)).toMatchObject({status:value,billedWei:'10000'});status='confirmed';await (payment as any).recoverPayments();expect(settled.size).toBe(1);expect(memory.ids.size).toBe(0);});
it('aborts unused admission',async()=>{await report(await admit(),0,true);expect(requests.map(r=>r.path)).toEqual(['prepare','abort']);});
it('binds song, credential and network before provider calls',async()=>{const id=await admit();for(const wrong of[{token:'other'},{songId:'other'},{network:'eip155:8453'}])await expect(payment.settleStreamCheckpoint({paymentIntentId:id,token:'key',songId:'song',network:'eip155:84532',listenedSeconds:20,...wrong} as any)).rejects.toMatchObject({statusCode:403});expect(requests).toHaveLength(1);});
it('preserves provider rejection and budget headers',async()=>{fail=402;await expect(admit()).rejects.toMatchObject({statusCode:402,headers:{'x-session-budget-remaining':'0'}});});

it.each(['/songs/song/stream', '/stream/song'])('uses the same checkpoint contract at %s', async path => {
  const { default: Fastify } = await import('fastify');
  const { databaseRouter } = await import('../../databases/router.js');
  const app = Fastify(); await app.register(databaseRouter, { prefix: '/api' });
  const token = `compose-${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:'0x1111111111111111111111111111111111111111',keyId:'route-key',network:'eip155:84532',budgetLimit:1000000})).toString('base64url')}.signature`;
  const headers = { authorization: `Bearer ${token}`, 'x-network-id': 'eip155:84532', accept: 'application/json', 'x-idempotency-key': path };
  const admitted = await app.inject({ url: `/api${path}`, headers }); expect(admitted.statusCode).toBe(200);
  const paymentIntentId = admitted.json().paymentIntentId;
  status = 'queued';
  const result = await app.inject({ method: 'POST', url: `/api${path}/checkpoint`, headers, payload: { paymentIntentId, listenedSeconds: 2.003, terminal: true } });
  expect(result.statusCode).toBe(202); expect(result.json()).toMatchObject({ success: true, result: { acceptedListenedSeconds: 2.003, billedWei: '1001', deltaWei: '1001', status: 'queued' } });
  await app.close();
});
it('does not grant a creator exemption to a caller-supplied creator address', async () => {
  const { default: Fastify } = await import('fastify'); const { databaseRouter } = await import('../../databases/router.js');
  const app = Fastify(); await app.register(databaseRouter, { prefix: '/api' });
  const res = await app.inject({ url: '/api/songs/song/stream', headers: { accept: 'application/json', 'x-network-id': 'eip155:84532', 'x-session-user-address': '0x2222222222222222222222222222222222222222', 'x-test-require-session': 'true' } });
  expect(res.statusCode).toBe(402); expect(requests).toHaveLength(0); await app.close();
});

it('routes one-atomic split tails to the correct single recipient without zero fields', async () => {
  const id = await admit(); await report(id, .002); await report(id, .004, true);
  const bodies = requests.filter(r => r.path === 'settle').map(r => r.body);
  expect(bodies[0]).toMatchObject({ finalAmountWei: '1', royalties: { treasury: evmTreasury } });
  expect(bodies[1]).toMatchObject({ finalAmountWei: '1', royalties: { creator: evmCreator, treasury: evmCreator } });
  expect(bodies.every(body => !('providerAmountWei' in body) && !('platformFeeWei' in body))).toBe(true);
});

it.each([
  ['eip155:84532', solana, svmCreator, evmCreator, evmTreasury],
  ['eip155:42431', solana, svmCreator, evmCreator, evmTreasury],
  [solana, 'eip155:84532', evmCreator, svmCreator, svmTreasury],
  [solana, 'eip155:42431', evmCreator, svmCreator, svmTreasury],
  ['eip155:84532', 'eip155:42431', evmCreator, evmCreator, evmTreasury],
  [solana, solana, svmCreator, svmCreator, svmTreasury],
])('settles a %s session for a song minted on %s', async (network, mintedOn, creator, payout, treasury) => {
  const { default: Fastify } = await import('fastify');
  const { databaseRouter } = await import('../../databases/router.js');
  wallets.song.mockImplementation(async (id: string) => ({ id, title: 'Song', url: 'https://cdn.invalid/song.wav', creator, network: mintedOn, stream_price: .03, duration: 180, public: true }));
  const app = Fastify(); await app.register(databaseRouter, { prefix: '/api' });
  try {
    const token = `compose-${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: network === solana ? svmTreasury : evmTreasury, keyId: 'cross-network', network, budgetLimit: 1000000 })).toString('base64url')}.signature`;
    const headers = { authorization: `Bearer ${token}`, 'x-network-id': network, accept: 'application/json', 'x-idempotency-key': 'cross-network' };
    const admitted = await app.inject({ url: '/api/songs/song/stream', headers });
    expect(admitted.statusCode).toBe(200);
    const paymentIntentId = admitted.json().paymentIntentId;
    expect(paymentIntentId).toBeTruthy();
    for (const [listenedSeconds, billedWei] of [[20, '10000'], [40, '20000'], [60, '30000'], [60.125, '30062']] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/songs/song/stream/checkpoint', headers, payload: { paymentIntentId, listenedSeconds, terminal: listenedSeconds === 60.125 } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true, result: { status: 'confirmed', acceptedListenedSeconds: listenedSeconds, billedWei } });
    }
    const settlements = requests.filter(r => r.path === 'settle');
    expect(settlements.map(r => r.network)).toEqual([network, network, network, network]);
    expect(settlements.map(r => r.body.royalties)).toEqual(Array(4).fill({ creator: payout, treasury }));
    expect(settlements.map(r => [r.body.providerAmountWei, r.body.platformFeeWei])).toEqual([['8000', '2000'], ['8000', '2000'], ['8000', '2000'], ['49', '13']]);
    expect(new Set(settlements.map(r => r.body.paymentIntentId)).size).toBe(4);
    if (creator === payout) expect(wallets.pair).not.toHaveBeenCalled();
    else expect(wallets.pair).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it.each([
  ['eip155:84532', svmCreator, null],
  ['eip155:42431', svmCreator, { evmAddress: '', svmAddress: svmCreator }],
  [solana, evmCreator, { evmAddress: evmCreator, svmAddress: '' }],
  [solana, evmCreator, { evmAddress: evmCreator, svmAddress: evmCreator }],
])('rejects an unavailable creator payout on %s before admission', async (network, creatorAddress, pair) => {
  wallets.pair.mockResolvedValue(pair);
  await expect(payment.prepareStreamPaymentIntent({ ...admission, network, creatorAddress, payTo: network === solana ? svmTreasury : evmTreasury })).rejects.toMatchObject({ statusCode: 409 });
  expect(requests).toHaveLength(0);
  expect(memory.ids.size).toBe(0);
});

it('keeps the admitted payout when the wallet pair changes before retry', async () => {
  const id = await payment.prepareStreamPaymentIntent({ ...admission, creatorAddress: svmCreator });
  const checkpoint = { paymentIntentId: id, token: admission.token, songId: admission.songId, network: admission.network, listenedSeconds: 20 };
  lost = true;
  await expect(payment.settleStreamCheckpoint(checkpoint)).rejects.toMatchObject({ statusCode: 503 });
  wallets.pair.mockResolvedValue({ evmAddress: evmTreasury, svmAddress: svmCreator });
  await payment.settleStreamCheckpoint({ ...checkpoint, listenedSeconds: 40, terminal: true });
  expect(requests.filter(r => r.path === 'settle').map(r => r.body.royalties.creator)).toEqual([evmCreator, evmCreator, evmCreator]);
  expect(wallets.pair).toHaveBeenCalledTimes(1);
});

it.each([['eip155:84532', svmCreator], [solana, evmCreator]])('requires restarting a legacy playback with an incompatible payout on %s', async (network, wrongCreator) => {
  const creatorAddress = network === solana ? svmCreator : evmCreator;
  const args = { ...admission, network, creatorAddress, payTo: network === solana ? svmTreasury : evmTreasury };
  const intent = await payment.prepareStreamPaymentIntent(args);
  const key = [...memory.data.keys()].find(k => k.startsWith('rawchunks:context:'))!;
  const state = JSON.parse(memory.data.get(key)!);
  state.creator = wrongCreator;
  state.admission.royalties.creator = wrongCreator;
  memory.data.set(key, JSON.stringify(state));
  await expect(payment.prepareStreamPaymentIntent(args)).rejects.toMatchObject({ statusCode: 409 });
  await expect(payment.settleStreamCheckpoint({ paymentIntentId: intent, token: args.token, songId: args.songId, network, listenedSeconds: 20 })).rejects.toMatchObject({ statusCode: 409 });
  expect(requests).toHaveLength(1);
});

it.each([['eip155:84532', svmCreator], [solana, evmCreator]])('exempts the authenticated creator on %s across paired identities', async (network, creator) => {
  const { default: Fastify } = await import('fastify');
  const { databaseRouter } = await import('../../databases/router.js');
  wallets.song.mockImplementation(async (id: string) => ({ id, creator, url: 'https://cdn.invalid/song.wav', stream_price: .03, duration: 180, public: true }));
  wallets.authenticate.mockResolvedValue({ owner: evmCreator, userAddress: network === solana ? svmCreator : evmCreator, addresses: [evmCreator, svmCreator] });
  const app = Fastify(); await app.register(databaseRouter, { prefix: '/api' });
  try {
    const response = await app.inject({ url: '/api/songs/song/stream', headers: { accept: 'application/json', 'x-network-id': network, 'x-wallet-auth-token': 'authenticated-wallet', 'x-test-require-session': 'true' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ isCreator: true, streamPriceWei: '0' });
    expect(requests).toHaveLength(0);
  } finally { await app.close(); }
});

it('releases the reserved Card Credit hold when prepareStreamPaymentIntent fails during metered admission and allows retry or 401 session refresh for the same user', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { CreditStore } = await import('../../credits/store.js');
  const { default: Fastify } = await import('fastify');
  const { databaseRouter } = await import('../../databases/router.js');
  process.env.CREDITS_ENABLED = 'true';
  const db = new PGlite();
  await db.waitReady;
  let previous = Promise.resolve();
  const store = new CreditStore({
    connect: async () => {
      const wait = previous;
      let release!: () => void;
      previous = new Promise<void>(done => { release = done; });
      await wait;
      return { query: (sql, values) => db.query(sql, values), release };
    },
  }, 'sandbox');
  await store.migrate();
  const listenerOwner = '0x1111111111111111111111111111111111111111';
  await db.query("INSERT INTO credit_accounts(environment,owner) VALUES('sandbox',$1) ON CONFLICT DO NOTHING", [listenerOwner]);
  await db.query("INSERT INTO credit_operations(environment,id,owner,kind,amount) VALUES('sandbox','buy-1',$1,'purchase','1000000')", [listenerOwner]);
  await store.creditCapture(listenerOwner, 'buy-1', 'cap-1', 1000000n);
  wallets.creditStore.mockReturnValue(store);
  wallets.authenticate.mockResolvedValue({ owner: listenerOwner, userAddress: listenerOwner, addresses: [listenerOwner] });
  wallets.song.mockImplementation(async (id: string) => ({ id, title: 'Song', url: 'https://cdn.invalid/song.wav', creator: evmCreator, network: 'eip155:84532', stream_price: .03, duration: 180, public: true }));

  let keyCounter = 0;
  let rejectPrepareOnce401 = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const path = url.split('/').at(-1)!;
    if (path === 'session') return Response.json({ hasSession: false });
    if (path === 'keys') {
      const userHeader = new Headers(init?.headers).get('x-session-user-address');
      expect(userHeader).toBe(listenerOwner);
      return Response.json({ token: `compose-card-token-${++keyCounter}` });
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    const network = new Headers(init?.headers).get('x-network-id')!;
    const payerHeader = new Headers(init?.headers).get('x-session-user-address');
    expect(payerHeader).toBe(listenerOwner);
    requests.push({ path, body, network });
    if (fail) return Response.json({ error: 'Provider down' }, { status: fail });
    if (path === 'prepare') {
      if (rejectPrepareOnce401) {
        rejectPrepareOnce401 = false;
        return Response.json({ error: 'Revoked session key' }, { status: 401 });
      }
      if (!prepared.has(body.idempotencyKey)) prepared.set(body.idempotencyKey, `intent-${prepared.size}`);
      return Response.json({ paymentIntentId: prepared.get(body.idempotencyKey) });
    }
    return Response.json({ status: 'confirmed', txHash: 'hash' });
  }));

  const app = Fastify();
  await app.register(databaseRouter, { prefix: '/api' });
  try {
    fail = 503;
    const failedRes = await app.inject({
      url: '/api/songs/song/stream',
      headers: {
        accept: 'application/json',
        'x-network-id': 'eip155:84532',
        'x-wallet-auth-token': 'wallet-token',
        'x-credit-source': 'card',
        'x-idempotency-key': 'card-fail-1',
      },
    });
    expect(failedRes.statusCode).toBe(503);
    expect(await store.balance(listenerOwner)).toMatchObject({ availableAtomics: '1000000', reservedAtomics: '0' });

    // Retrying with the same idempotency key after an un-admitted failure succeeds without 409 Conflict,
    // and if the cached Compose token returns 401 (ended session), it evicts cache and mints a fresh key for listenerOwner
    fail = 0;
    rejectPrepareOnce401 = true;
    const retryRes = await app.inject({
      url: '/api/songs/song/stream',
      headers: {
        accept: 'application/json',
        'x-network-id': 'eip155:84532',
        'x-wallet-auth-token': 'wallet-token',
        'x-credit-source': 'card',
        'x-idempotency-key': 'card-fail-1',
      },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().paymentIntentId).toBe('crd:0x1111111111111111:card-fail-1');
    expect(keyCounter).toBe(2);
    expect(await store.balance(listenerOwner)).toMatchObject({ availableAtomics: '910000', reservedAtomics: '90000' });
  } finally {
    await app.close();
    await db.close();
  }
});
