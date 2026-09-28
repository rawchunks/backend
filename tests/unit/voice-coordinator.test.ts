import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const h=vi.hoisted(()=>({deps:null as any}));
vi.mock('../../databases/voices.js', () => ({createVoice:(v:any)=>h.deps.store.createVoice(v),getVoiceById:(id:string)=>h.deps.store.getVoiceById(id),listVoicesByCreator:(c:string)=>h.deps.store.listVoicesByCreator(c)}));
vi.mock('../../databases/songs.js', () => ({ getSongById: (id:string)=>h.deps.getSong(id) }));
vi.mock('../../broker/valkey.js', () => ({}));
vi.mock('../../storage/r2.js', () => ({uploadToR2:(...a:any[])=>h.deps.upload(...a),persistAudioToR2:async()=> 'https://r2.test/sample.wav',deleteFromR2:vi.fn()}));
vi.mock('../../editing/service.js',()=>({sourceSettings:vi.fn()}));
vi.mock('../../generation/client.js', () => ({ client: {separate:(...a:any[])=>h.deps.worker.separate(...a)} }));
import { VoiceService } from '../../voice/service.js';
const creator = `0x${'a'.repeat(40)}`;
const audio = { audioBuffer: Buffer.from('RIFF0000WAVEdata'), fileName: 'voice.wav', mimeType: 'audio/wav', creator };
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let rows: Map<string, any>, adapters: Map<string, any>, deps: any, service: VoiceService;
beforeEach(() => {
 rows = new Map(); adapters = new Map();
 deps = {
  store: {
   getVoiceById: vi.fn(async (id: string) => rows.get(id) ?? null),
   getCanonicalVoice: vi.fn(async (id: string) => { const v = rows.get(id); return v?.canonical_id ? rows.get(v.canonical_id) : v ?? null; }),
   listVoicesByCreator: vi.fn(async () => [...rows.values()]),
   listPendingVoices: vi.fn(async () => [...rows.values()].filter(v => !v.canonical_id && !['ready','error'].includes(v.status))),
   findVoiceBySource:vi.fn(async(owner:string,songId:string,url:string)=>[...rows.values()].find(v=>v.creator===owner && v.source_song_id===songId && v.metadata.source_url===url)??null),
   listVoiceInventory: vi.fn(async () => [...rows.values()]),
   findVoiceByHash: vi.fn(async (owner: string, hash: string) => [...rows.values()].find(v => v.creator === owner && v.hash === hash && !v.canonical_id) ?? null),
   createVoice: vi.fn(async (v: any) => { rows.set(v.id, v); return v; }),
   createVoiceFromSource:vi.fn(async(v:any)=>{const old=[...rows.values()].find(r=>r.creator===v.creator&&r.source_song_id===v.source_song_id&&r.metadata.source_url===v.metadata.source_url);if(old)return old;rows.set(v.id,v);return v;}),
   createVoiceDeduplicated: vi.fn(async (v: any) => { const old = [...rows.values()].find(r => r.creator === v.creator && r.hash === v.hash && !r.canonical_id); if(old) return old; rows.set(v.id,v);return v; }),
   updateVoice: vi.fn(async (id: string, patch: any) => { const v={...rows.get(id),...patch};rows.set(id,v);return v; }),
   consolidateVoiceSample: vi.fn(async (id: string, patch: any) => { const v={...rows.get(id),...patch,status:'saved'};rows.set(id,v);return v; }),
   listAdaptersByGroup: vi.fn(async (group: string) => [...adapters.values()].filter(a => a.training_group===group)),
   createVoiceAdapter: vi.fn(async (a: any) => { if(!adapters.has(a.id))adapters.set(a.id,a);return adapters.get(a.id); }),
   updateVoiceAdapter: vi.fn(async (id: string, patch: any) => {const a={...adapters.get(id),...patch};adapters.set(id,a);return a;}),
  },
  worker: {
   trainingOptions: vi.fn(async () => ({models:['turbo','sft'].map(kind=>({model:`acestep-v15-xl-${kind}`,checkpoint_fingerprint:sha(kind),training_config:{epochs:1}}))})),
   separate: vi.fn(async (_:any,o:any)=>({task_id:o.idempotencyKey,status:'pending',stems:{}})),
   queryResult: vi.fn(async ()=>({results:{}})),
   train: vi.fn(async (_:any,o:any)=>({task_id:o.idempotencyKey,status:'pending'})),
   queryTraining: vi.fn(async ()=>({results:{}})),
   trainingArtifact: vi.fn(),
  },
  upload:vi.fn(async (_:any,key:string)=>`https://r2.test/${key}`), read:vi.fn(async ()=>({buffer:audio.audioBuffer,contentType:'audio/wav'})),remove:vi.fn(),
  getSong:vi.fn(async()=>({id:'song',title:'Song',url:'https://r2.test/song.wav',creator,lyrics:'Words'})),
  lock:vi.fn(async (_:string,run:any)=>run(Object.assign(async()=>{}, {save:async()=>{}}))), publish:vi.fn(async()=>{}),preparationEnabled:()=>true,songMetadata:async()=>({}),
 };
 h.deps=deps; service = new VoiceService(deps);
});
describe('durable voice coordinator',()=>{
 it('returns a saved reference immediately without waiting for GPU admission',async()=>{
  const result=await service.cloneVoiceFromAudio(audio);
  expect(result.voice.status).toBe('saved');expect(result.voice.hash).toBe(sha(audio.audioBuffer));
  expect(result.voice.availability.turbo.status).toBe('unavailable');
  expect(deps.worker.train).not.toHaveBeenCalled();
  expect((await service.resolveVoice(result.voice.id,'acestep-v15-xl-turbo','reference',.5,creator)).sampleUrl).toContain('https://r2.test/');
 });
 it('concurrent duplicate upload resolves one canonical sample for the same owner',async()=>{
  const result=await Promise.all(Array.from({length:30},()=>service.cloneVoiceFromAudio(audio)));
  expect(new Set(result.map(r=>r.voice.id)).size).toBe(1);expect(rows.size).toBe(1);
 });
 it('identical bytes from different owners preserve records and share training input groups',async()=>{
  const a=await service.cloneVoiceFromAudio(audio);const b=await service.cloneVoiceFromAudio({...audio,creator:`0x${'b'.repeat(40)}`});
  expect(a.voice.id).not.toBe(b.voice.id);expect(a.voice.creator).not.toBe(b.voice.creator);expect(a.voice.training_group).toBe(b.voice.training_group);
 });
 it('song save commits an extracting receipt before separation starts',async()=>{
  const r=await service.cloneVoiceFromSong({songId:'song',creator});
  expect(r.voice.status).toBe('extracting');expect(r.voice.sample_url).toBeNull();expect(r.voice.task_id).toBeTruthy();expect(deps.worker.separate).not.toHaveBeenCalled();
  await service.reconcile();expect(deps.worker.separate).toHaveBeenCalled();expect(rows.get(r.voice.id).status).toBe('extracting');
 });
 it('persists a named separated vocal and queues exact model adapters',async()=>{
  const r=await service.cloneVoiceFromSong({songId:'song',creator});
  deps.worker.queryResult.mockImplementation(async()=>({results:{[r.voice.task_id]:{task_id:r.voice.task_id,status:'ready',stems:{vocals:'/api/audio?path=vocals.wav'}}}}));
  await service.reconcile();await service.reconcile();
  expect(rows.get(r.voice.id).sample_url).toContain('https://r2.test/');expect(adapters.size).toBe(2);
  expect([...adapters.values()].every(a=>a.task_id && a.settings_digest && a.checkpoint_fingerprint)).toBe(true);
 });
 it('queued adapter never advertises trained readiness or falls back to a reference',async()=>{
  const r=await service.cloneVoiceFromAudio(audio);await service.reconcile();
  await expect(service.resolveVoice(r.voice.id,'acestep-v15-xl-turbo','trained',.7,creator)).rejects.toThrow(/not ready/i);
  expect((await service.getVoice(r.voice.id)).availability.turbo.status).not.toBe('ready');
 });
 it('retries lost dispatch responses with the persisted task identifier',async()=>{
  const r=await service.cloneVoiceFromAudio(audio);await service.reconcile();
  deps.worker.train.mockRejectedValueOnce(new Error('lost response'));
  await service.reconcile();
  await service.reconcile();
  const calls=deps.worker.train.mock.calls;expect(calls.length).toBeGreaterThan(1);
  expect(new Set(calls.filter((c:any)=>c[0].model==='acestep-v15-xl-turbo').map((c:any)=>c[1].idempotencyKey)).size).toBe(1);
  expect(rows.get(r.voice.id).status).not.toBe('error');
 });
 it('worker terminal failure becomes durable error with no fake readiness',async()=>{
  const r=await service.cloneVoiceFromAudio(audio);await service.reconcile();
  deps.worker.queryTraining.mockImplementation(async(ids:string[])=>({results:Object.fromEntries(ids.map(id=>[id,{task_id:id,status:'error',error:'optimizer failed'}]))}));
  await service.reconcile();expect(rows.get(r.voice.id).status).toBe('error');expect((await service.getVoice(r.voice.id)).availability.turbo.status).toBe('error');
 });
 it('only verified artifact bytes can publish ready',async()=>{
  const r=await service.cloneVoiceFromAudio(audio);await service.reconcile();
  deps.worker.queryTraining.mockImplementation(async(ids:string[])=>({results:Object.fromEntries(ids.map(id=>[id,{task_id:id,status:'ready',artifact:{manifest:'manifest.json',digest:sha('bad'),checkpoint_fingerprint:sha('turbo'),files:[{filename:'manifest.json',digest:sha('bad')}]}}]))}));
  deps.worker.trainingArtifact.mockResolvedValue(Buffer.from('corrupt'));
  await service.reconcile();expect([...adapters.values()].every(a=>a.status!=='ready')).toBe(true);
 });
 it('aliases resolve canonical data but cannot bridge owners',async()=>{
  const r=await service.cloneVoiceFromAudio(audio);rows.set('old',{...rows.get(r.voice.id),id:'old',canonical_id:r.voice.id});
  expect((await service.resolveVoice('old','acestep-v15-xl-turbo','reference',.5,creator)).canonicalId).toBe(r.voice.id);
  await expect(service.resolveVoice('old','acestep-v15-xl-turbo','reference',.5,`0x${'b'.repeat(40)}`)).rejects.toThrow(/own/i);
 });
 it('capacity gate preserves references and prevents preparation or new training admission',async()=>{
  deps.preparationEnabled=()=>false;service=new VoiceService(deps);
  const r=await service.cloneVoiceFromAudio(audio);await service.reconcile();
  expect(rows.get(r.voice.id).status).toBe('saved');expect(adapters.size).toBe(0);expect(deps.worker.train).not.toHaveBeenCalled();
  expect((await service.resolveVoice(r.voice.id,'acestep-v15-xl-turbo','reference',.5,creator)).sampleUrl).toBeTruthy();
 });

 it('repeated song Save and response retries preserve one oldest extraction receipt',async()=>{
  const result=await Promise.all(Array.from({length:10},()=>service.cloneVoiceFromSong({songId:'song',creator})));
  expect(new Set(result.map(r=>r.voice.id)).size).toBe(1);expect(rows.size).toBe(1);
 });

 it('saves exact committed lyrics and musical metadata before extraction',async()=>{
  deps.songMetadata=async()=>({lyrics:'[Verse 1]\nWords\n[Chorus]\nMore',raw_lyrics:'[Verse 1]\nWords\n[Chorus]\nMore',bpm:122,keyscale:'C major',language:'en',source_take_id:'take-exact'});service=new VoiceService(deps);
  const r=await service.cloneVoiceFromSong({songId:'song',creator});
  expect(r.voice.metadata).toMatchObject({lyrics:'[Verse 1]\nWords\n[Chorus]\nMore',source_take_id:'take-exact',bpm:122,keyscale:'C major',language:'en',source_url:'https://r2.test/song.wav'});
 });

 it('same-content owners train one checkpoint recipe despite lifecycle and filename differences',async()=>{
  await service.cloneVoiceFromAudio(audio);await service.cloneVoiceFromAudio({...audio,creator:`0x${'b'.repeat(40)}`,fileName:'renamed.wav'});
  await service.reconcile();expect(adapters.size).toBe(2);
 });

 it('shared adapter retry preserves the originally committed source URL for every owner',async()=>{
  const a=await service.cloneVoiceFromAudio(audio);await service.cloneVoiceFromAudio({...audio,creator:`0x${'b'.repeat(40)}`});
  await service.reconcile();deps.worker.train.mockRejectedValueOnce(new Error('lost admission'));
  await service.reconcile();await service.reconcile();
  const turbo=deps.worker.train.mock.calls.filter((call:any)=>call[0].model==='acestep-v15-xl-turbo');
  expect(new Set(turbo.map((call:any)=>call[0].source_audio_url))).toEqual(new Set([a.voice.sample_url]));
  expect(deps.lock.mock.calls.some((call:any)=>call[0].startsWith('voice-adapter:'))).toBe(true);
 });

});
