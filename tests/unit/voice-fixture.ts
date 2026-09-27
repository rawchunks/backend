import { vi } from 'vitest';
import { createHash } from 'node:crypto';
export const creator = `0x${'a'.repeat(40)}`;
export const audio = { audioBuffer: Buffer.from('RIFF0000WAVEdata'), fileName: 'voice.wav', mimeType: 'audio/wav', creator };
export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function voiceFixture() {
 const rows=new Map<string,any>(), adapters=new Map<string,any>();
 const deps={
  store:{
   getVoiceById:vi.fn(async(id:string)=>rows.get(id)??null),
   getCanonicalVoice:vi.fn(async(id:string)=>{const v=rows.get(id);return v?.canonical_id?rows.get(v.canonical_id):v??null;}),
   listVoicesByCreator:vi.fn(async()=>[...rows.values()]),listPendingVoices:vi.fn(async()=>[...rows.values()].filter(v=>!v.canonical_id&&!['ready','error'].includes(v.status))),listVoiceInventory:vi.fn(async()=>[...rows.values()]),
   findVoiceBySource:vi.fn(async(owner:string,songId:string,url:string)=>[...rows.values()].find(v=>v.creator===owner&&v.source_song_id===songId&&v.metadata.source_url===url)??null),
   createVoiceFromSource:vi.fn(async(v:any)=>{const old=[...rows.values()].find(r=>r.creator===v.creator&&r.source_song_id===v.source_song_id&&r.metadata.source_url===v.metadata.source_url);if(old)return old;rows.set(v.id,v);return v;}),
   findVoiceByHash:vi.fn(async(owner:string,hash:string)=>[...rows.values()].find(v=>v.creator===owner&&v.hash===hash&&!v.canonical_id)??null),
   createVoice:vi.fn(async(v:any)=>{rows.set(v.id,v);return v;}),
   createVoiceDeduplicated:vi.fn(async(v:any)=>{const old=v.canonical_id?rows.get(v.id):[...rows.values()].find(r=>r.creator===v.creator&&r.hash===v.hash&&!r.canonical_id);if(old)return old;rows.set(v.id,v);return v;}),
   updateVoice:vi.fn(async(id:string,patch:any)=>{const v={...rows.get(id),...patch};rows.set(id,v);return v;}),
   consolidateVoiceSample:vi.fn(async(id:string,patch:any)=>{const current=rows.get(id);const existing=[...rows.values()].find(r=>r.id!==id&&r.creator===current.creator&&r.hash===patch.hash&&!r.canonical_id);const v={...current,...patch,status:'saved',...(existing?{canonical_id:existing.id,training_group:existing.training_group}:{})};rows.set(id,v);return existing??v;}),
   listAdaptersByGroup:vi.fn(async(group:string)=>[...adapters.values()].filter(a=>a.training_group===group)),
   createVoiceAdapter:vi.fn(async(a:any)=>{if(!adapters.has(a.id))adapters.set(a.id,a);return adapters.get(a.id);}),
   updateVoiceAdapter:vi.fn(async(id:string,patch:any)=>{const a={...adapters.get(id),...patch};adapters.set(id,a);return a;}),
  },
  worker:{
   trainingOptions:vi.fn(async()=>({models:['turbo','sft'].map(kind=>({model:`acestep-v15-xl-${kind}`,checkpoint_fingerprint:sha(kind),training_config:{epochs:1}}))})),
   separate:vi.fn(async(_:any,o:any)=>({task_id:o.idempotencyKey,status:'pending',stems:{}})),queryResult:vi.fn(async()=>({results:{}})),
   train:vi.fn(async(_:any,o:any)=>({task_id:o.idempotencyKey,status:'pending'})),queryTraining:vi.fn(async()=>({results:{}})),trainingArtifact:vi.fn(),
  },
  upload:vi.fn(async(_:any,key:string)=>`https://r2.test/${key}`),read:vi.fn(async()=>({buffer:audio.audioBuffer,contentType:'audio/wav'})),remove:vi.fn(),getSong:vi.fn(async()=>({id:'song',title:'Song',url:'https://r2.test/song.wav',creator})),lock:vi.fn(async(_:string,run:any)=>run(Object.assign(async()=>{},{save:async()=>{}}))),publish:vi.fn(async()=>{}),preparationEnabled:()=>true,songMetadata:async()=>({}),
 };
 return {rows,adapters,deps};
}
