import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../databases/client.js',async()=>{const {drizzle}=await import('drizzle-orm/neon-http');const pg=await import('../support/database-postgres.js');return{songDb:drizzle(pg.neonTransport as any),userSql:pg.sqlTag('user'),songSql:pg.sqlTag('song')};});
import {initializePostgres,closePostgres,postgres,fixtures,databaseCause} from '../support/database-postgres.js';
import {runMigrations} from '../../databases/migrate.js';
import {createVoice,createVoiceDeduplicated,findVoiceByHash,getCanonicalVoice,listPendingVoices,getVoiceById,consolidateVoiceSample,createVoiceAdapter,listAdaptersByGroup,updateVoiceAdapter} from '../../databases/voices.js';
beforeAll(async()=>{await initializePostgres();await runMigrations();});
beforeEach(async()=>{await postgres.song.exec('TRUNCATE voices,voice_adapters CASCADE');});afterAll(closePostgres);
const sample={id:'v-1',name:'Recording',creator:fixtures.evm,hash:'a'.repeat(64),training_group:'g-1',sample_url:'https://fixture.invalid/sample.wav'};
const adapter={id:'a-1',training_group:'g-1',model:'acestep-v15-xl-turbo',checkpoint_fingerprint:'checkpoint-exact',settings:{epochs:1},settings_digest:'b'.repeat(64),task_id:'training-1'};
describe('voice identities on disposable PostgreSQL',()=>{
 it('concurrent same-owner binary registrations return one canonical ID',async()=>{
  const result=await Promise.all(Array.from({length:20},(_,i)=>createVoiceDeduplicated({...sample,id:`v-${i}`})));
  expect(new Set(result.map(v=>v.id)).size).toBe(1);expect((await postgres.song.query('SELECT id FROM voices')).rows).toHaveLength(1);
 });
 it('same bytes remain separate ownership and cannot alias across accounts',async()=>{
  await createVoice(sample);await createVoice({...sample,id:'other',creator:`0x${'b'.repeat(40)}`,training_group:'g-other'});
  await expect(createVoice({...sample,id:'alias',hash:null,creator:`0x${'b'.repeat(40)}`,canonical_id:sample.id}).catch(e=>{throw databaseCause(e);})).rejects.toMatchObject({code:'23503'});
  expect((await findVoiceByHash(`0x${'b'.repeat(40)}`,sample.hash))?.id).toBe('other');
 });
 it('inventory consolidation retains old IDs resolving to owner canonical sample',async()=>{
  await createVoice(sample);await createVoice({...sample,id:'old',hash:null,training_group:'old-group'});
  await consolidateVoiceSample('old',{hash:sample.hash,training_group:sample.training_group,sample_url:sample.sample_url,metadata:{}});
  expect((await getCanonicalVoice('old'))?.id).toBe(sample.id);expect((await postgres.song.query('SELECT canonical_id FROM voices WHERE id=$1',['old'])).rows[0].canonical_id).toBe(sample.id);
 });
 it('concurrent duplicate model/checkpoint/settings training admissions retain one task',async()=>{
  const result=await Promise.all(Array.from({length:20},(_,i)=>createVoiceAdapter({...adapter,id:`a-${i}`,task_id:`training-${i}`})));
  expect(new Set(result.map(a=>a.id)).size).toBe(1);expect(await listAdaptersByGroup('g-1')).toHaveLength(1);
  await createVoiceAdapter({...adapter,id:'sft',task_id:'training-sft',model:'acestep-v15-xl-sft'});expect(await listAdaptersByGroup('g-1')).toHaveLength(2);
 });
 it('database rejects ready adapter without verified digest and URL',async()=>{
  await createVoiceAdapter(adapter);
  await expect(updateVoiceAdapter(adapter.id,{status:'ready'}).catch(e=>{throw databaseCause(e);})).rejects.toMatchObject({code:'23514'});
  expect((await listAdaptersByGroup('g-1'))[0].status).toBe('queued');
 });
 it('legacy nonempty adapter URL fails migration before dropping its data',async()=>{
  await postgres.song.exec('ALTER TABLE voices ADD COLUMN url TEXT');await postgres.song.query('INSERT INTO voices (id,name,creator,training_group,url) VALUES ($1,$2,$3,$4,$5)',['legacy','Legacy',fixtures.evm,'legacy','https://fixture.invalid/weights']);
  try{await expect(runMigrations()).rejects.toThrow('explicit inventory');expect((await postgres.song.query('SELECT url FROM voices WHERE id=$1',['legacy'])).rows[0].url).toBe('https://fixture.invalid/weights');}
  finally{await postgres.song.exec('ALTER TABLE voices DROP COLUMN url');}
 });
 it('mixed inventory migration requeues only sample voices lacking required prepared adapters',async()=>{
  await createVoice({...sample,id:'sample-only',status:'ready'});
  await createVoice({...sample,id:'prepared',hash:null,training_group:'prepared-group',status:'ready'});
  for(const kind of ['turbo','sft']) await createVoiceAdapter({...adapter,id:`ready-${kind}`,task_id:`ready-task-${kind}`,training_group:'prepared-group',model:`acestep-v15-xl-${kind}`,status:'ready',artifact_url:'https://fixture.invalid/manifest.json',artifact_digest:'c'.repeat(64)});
  await runMigrations();const result=(await postgres.song.query('SELECT id,status FROM voices')).rows;
  expect(result.find((r:any)=>r.id==='sample-only')?.status).toBe('saved');expect(result.find((r:any)=>r.id==='prepared')?.status).toBe('ready');
 });

});

it('keeps source conditioning on a content alias and returns it to durable reconciliation', async () => {
 await createVoice(sample);
 await createVoice({ ...sample, id: 'source-variant', hash: null, training_group: 'source-pending', status: 'extracting', task_id: 'extract-source' });
 const metadata = { raw_lyrics: '[Verse]\nExact words', bpm: 100, keyscale: 'C major', is_instrumental: false };
 await consolidateVoiceSample('source-variant', { hash: sample.hash, training_group: sample.training_group, sample_url: sample.sample_url, metadata });
 expect(await getVoiceById('source-variant')).toMatchObject({ canonical_id: sample.id, metadata, status: 'saved', task_id: null });
 expect((await listPendingVoices()).map(v => v.id)).toContain('source-variant');
 expect((await getCanonicalVoice('source-variant'))?.id).toBe(sample.id);
});

it('concurrent deterministic recipe aliases retain one own ID rather than returning source conditioning', async () => {
 await createVoice({ ...sample, metadata: { lyrics: '[Verse]\nSource only' } });
 const upload = { ...sample, id: 'upload-variant', canonical_id: sample.id, metadata: { source: 'upload' } };
 const results = await Promise.all(Array.from({ length: 20 }, () => createVoiceDeduplicated(upload)));
 expect(new Set(results.map(v => v.id))).toEqual(new Set([upload.id]));
 expect((await getCanonicalVoice(upload.id))?.id).toBe(sample.id);
 expect((await getVoiceById(sample.id))?.metadata).toEqual({ lyrics: '[Verse]\nSource only' });
 expect((await postgres.song.query('SELECT id FROM voices')).rows).toHaveLength(2);
});
