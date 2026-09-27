import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../broker/valkey.js',()=>({}));vi.mock('../../generation/client.js',()=>({client:{}}));
vi.mock('../../editing/service.js',()=>({sourceSettings:vi.fn()}));
import { VoiceService } from '../../voice/service.js';
import { audio, creator, sha, voiceFixture } from '../unit/voice-fixture.js';
let f:ReturnType<typeof voiceFixture>,service:VoiceService;
beforeEach(()=>{f=voiceFixture();service=new VoiceService(f.deps as any);});
describe('voice artifact and inventory gates',()=>{
 it('verified optimizer artifacts become model-specific readiness and provenance',async()=>{
  const voice=(await service.cloneVoiceFromAudio(audio)).voice;await service.reconcile();
  const files=new Map<string,Buffer>();
  f.deps.worker.queryTraining.mockImplementation(async(ids:string[])=>({results:Object.fromEntries(ids.map(id=>{
   const adapter=[...f.adapters.values()].find(a=>a.task_id===id)!;
   const config=Buffer.from('{"peft_type":"LORA"}'),weights=Buffer.from('real-optimizer-test-artifact');
   const entries=[{filename:'adapter_config.json',digest:sha(config),content_type:'application/json'},{filename:'adapter_model.safetensors',digest:sha(weights),content_type:'application/octet-stream'}];
   const metrics={optimizer_steps:2,final_loss:.2,effective_update_norm:.04};
   const manifest=Buffer.from(JSON.stringify({schema_version:1,task_id:adapter.task_id,training_config:adapter.settings.training_config,model:adapter.model,checkpoint_fingerprint:adapter.checkpoint_fingerprint,files:entries,metrics}));
   for(const [name,body] of [['manifest.json',manifest],['adapter_config.json',config],['adapter_model.safetensors',weights]] as const)files.set(`${id}/${name}`,body);
   return[id,{task_id:id,status:'ready',artifact:{manifest:'manifest.json',digest:sha(manifest),checkpoint_fingerprint:adapter.checkpoint_fingerprint,files:[...entries,{filename:'manifest.json',digest:sha(manifest),content_type:'application/json'}],metrics}}];
  }))}));
  f.deps.worker.trainingArtifact.mockImplementation(async(id:string,name:string)=>files.get(`${id}/${name}`));
  await service.reconcile();expect(f.rows.get(voice.id).status).toBe('ready');
  const resolved=await service.resolveVoice(voice.id,'acestep-v15-xl-sft','trained',.5,creator);
  expect(resolved.artifactUrl).toMatch(/manifest\.json$/);expect(resolved.sampleUrl).toBeUndefined();expect(resolved.artifactDigest).toMatch(/^[a-f0-9]{64}$/);expect(resolved.provenance).toHaveProperty('settings_digest');
  expect(f.deps.upload.mock.calls.filter(c=>c[0]==='loras')).toHaveLength(6);
 });
 it('explicit inventory repair consolidates identical bytes while preserving old IDs and owner boundaries',async()=>{
  const a=(await service.cloneVoiceFromAudio(audio)).voice;
  f.rows.set('old',{...f.rows.get(a.id),id:'old',hash:null,training_group:'old-group'});
  f.rows.set('other',{...f.rows.get(a.id),id:'other',hash:null,training_group:'other-group',creator:`0x${'b'.repeat(40)}`});
  const result=await service.reconcileInventory();expect(result.errors).toEqual([]);
  expect(f.rows.get('old').canonical_id).toBe(a.id);expect(f.rows.get('other').canonical_id).toBeUndefined();
  expect((await service.getVoice('old'))?.canonical_id).toBe(a.id);
 });
 it('worker ready without named vocals fails durably without persisting a source mix',async()=>{
  const r=await service.cloneVoiceFromSong({songId:'song',creator});
  f.deps.worker.queryResult.mockResolvedValue({results:{[r.voice.task_id!]:{task_id:r.voice.task_id!,status:'ready',audio_urls:['https://r2.test/mix.wav']}}} as any);
  await service.reconcile();expect(f.rows.get(r.voice.id).status).toBe('error');expect(f.deps.read).not.toHaveBeenCalled();expect(f.deps.upload).not.toHaveBeenCalled();
 });
});
