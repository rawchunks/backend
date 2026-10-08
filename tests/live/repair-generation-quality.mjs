// Bounded diagnostics. All remote audio is decoded/padded/merged/measured in cluster.
// prepare-extensions records six intents. Only submit modes admit GPU jobs.
import {existsSync,mkdirSync,openSync,closeSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const results=new URL('../results/',import.meta.url);
const sourceId='sng-b9eaf105-b3d1-42de-b289-bd19f0b54a58';
const marker='RAWCHUNKS_DIAGNOSTIC_JSON=';
const prompts={
 fading:'Continue the acoustic guitar ending for ten seconds, gently fading the final chord.',
 audible:'Continue the acoustic folk pop song for ten seconds with clear English sung vocals, acoustic guitar, restrained bass and drums at the same audible energy and 100 BPM in C major.',
};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(left,right)=>JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex');
const read=file=>JSON.parse(readFileSync(file,'utf8'));
function write(file,value){const temp=fileURLToPath(file)+`.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(value,null,2));renameSync(temp,file);}
function immutable(file,value){
 if(existsSync(file)){if(!equal(read(file),value))throw Error(`Immutable record changed: ${fileURLToPath(file)}`);}
 else writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx'});
}
let verified=false;
function verifyCluster(){
 if(!verified&&execFileSync('kubectl',['config','current-context'],{encoding:'utf8'}).trim()!=='gke_gen-lang-client-0035632562_us-central1-a_rawchunks')throw Error('Unexpected cluster');
 verified=true;
}
function nodeInApi(body,data={}){
 verifyCluster();
 const input=`const input=JSON.parse(${JSON.stringify(JSON.stringify(data))});\nconst canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;\nconst equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));\ntry {\n${body}\nconsole.log(${JSON.stringify(marker)}+JSON.stringify(output));process.exit(0);\n} catch(error){console.error(error.message);process.exit(1);}\n`;
 const output=execFileSync('kubectl',['--request-timeout=55s','exec','-i','-n','rawchunks','deployment/api','--','node','--input-type=module','-'],{input,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 const line=output.trim().split('\n').findLast(line=>line.startsWith(marker));if(!line)throw Error('API returned no diagnostic receipt');
 return JSON.parse(line.slice(marker.length));
}
function pythonInWorker(script,data={}){
 verifyCluster();const input=`import json\ninput=json.loads(${JSON.stringify(JSON.stringify(data))})\n${script}`;
 return JSON.parse(execFileSync('kubectl',['--request-timeout=55s','exec','-i','-n','rawchunks','deployment/acestep-xl-15-turbo','--','.venv/bin/python','-'],{input,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024}));
}
function call(path,payload,id){return pythonInWorker(`import os,time,urllib.request,urllib.error
headers={'Authorization':'Bearer '+os.environ.get('ACESTEP_API_KEY',''),'Content-Type':'application/json'}
if input.get('id'):headers['Idempotency-Key']=input['id']
request=urllib.request.Request('http://127.0.0.1:8001'+input['path'],data=None if input.get('payload') is None else json.dumps(input['payload']).encode(),headers=headers)
start=time.time()
try:
 with urllib.request.urlopen(request,timeout=45) as response:result={'httpStatus':response.status,'body':json.load(response),'milliseconds':round((time.time()-start)*1000)}
except urllib.error.HTTPError as error:
 body=error.read().decode()
 try:body=json.loads(body)
 except ValueError:body={'error':body}
 result={'httpStatus':error.code,'body':body,'milliseconds':round((time.time()-start)*1000)}
print(json.dumps(result))
`,{path,payload,id});}
function sourceSnapshot(){
 const source=read(new URL('voices-extension-source.json',results));if(source.song?.id!==sourceId)throw Error('Unexpected extension source');
 const take=source.takes.find(t=>t.is_active&&t.model==='acestep-v15-xl-sft'&&t.url===source.song.url);
 const settings=take?.provenance?.parameters?.submitted;if(typeof settings?.prompt!=='string'||typeof settings?.lyrics!=='string')throw Error('Exact SFT source settings required');
 return {source,take,settings};
}
export function generationJobs(settings){return [3,1].map(shift=>({id:`quality-sft-7301-shift-${shift}-v1`,kind:'sft',payload:{model:'acestep-v15-xl-sft',task:'text2music',task_type:'text2music',prompt:settings.prompt,lyrics:settings.lyrics,bpm:100,key_scale:'C major',time_signature:'4',vocal_language:'en',seed:7301,use_random_seed:false,audio_duration:30,batch_size:1,inference_steps:50,guidance_scale:5.5,shift,audio_format:'wav',use_format:false,use_cot_caption:false,use_cot_language:false}}));}
export function extensionJobs(settings,paddedUrl){
 const jobs=[];
 for(const [promptKind,prompt] of Object.entries(prompts))for(const variant of ['missing','metadata','balanced']){
  const payload={model:'acestep-v15-xl-base',task:'repaint',task_type:'repaint',prompt,lyrics:variant==='missing'?'':settings.lyrics,seed:7301,use_random_seed:false,audio_duration:40,batch_size:1,inference_steps:50,guidance_scale:5,shift:1,audio_format:'wav',use_format:false,use_cot_caption:false,use_cot_language:false,src_audio_path:paddedUrl,chunk_mask_mode:'explicit',repainting_start:30,repainting_end:40};
  if(variant!=='missing')Object.assign(payload,{bpm:settings.bpm,key_scale:settings.keyScale,vocal_language:settings.vocalLanguage});
  if(variant==='balanced')Object.assign(payload,{repaint_mode:'balanced',repaint_strength:1});
  jobs.push({id:`quality-ext-b9eaf105-7301-${promptKind}-${variant}-v1`,kind:'extend',promptKind,variant,defaults:variant==='balanced'?{}:{repaint_mode:'balanced',repaint_strength:.5},payload});
 }
 return jobs;
}
function rememberJobs(state,jobs,save){
 for(const proposal of jobs){
  const prior=state.jobs.find(j=>j.id===proposal.id);if(prior&&!equal(prior.payload,proposal.payload))throw Error(`Stored request differs: ${proposal.id}`);
  const job=prior??{...proposal,intentAt:new Date().toISOString(),dispatchState:'prepared'};if(!prior)state.jobs.push(job);job.payloadDigest??=digest(job.payload);assertIntent(job);
 }
 save();
}
function assertIntent(job){
 if(job.payloadDigest!==digest(job.payload))throw Error(`Request mutation: ${job.id}`);
 immutable(new URL(`${job.id}.intent.json`,results),{id:job.id,kind:job.kind,payloadDigest:job.payloadDigest,payload:job.payload});
}
function entries(response){
 if(response.httpStatus!==200)throw Error(`Worker query failed: ${response.httpStatus}`);
 const data=response.body?.data??response.body?.results??response.body;
 return Array.isArray(data)?data:Object.entries(data??{}).map(([id,item])=>({task_id:id,...item}));
}
function known(item){return item&&!(item.status===0&&item.result==='[]'&&item.stage===undefined);}
export function audioUrl(raw){
 if(typeof raw!=='string'||!raw)return undefined;let path=raw;
 for(let depth=0;depth<16;depth++){
  const url=new URL(path,'http://worker.local');if(!['/v1/audio','/api/audio'].includes(url.pathname))break;
  const next=url.searchParams.get('path');if(!next||next===path)break;path=next;
 }
 if(path.startsWith('/app/ACE-Step-1.5/'))path=path.slice('/app/ACE-Step-1.5/'.length);
 return /^https?:\/\//i.test(path)?path:`/api/audio?path=${encodeURIComponent(path)}`;
}
export function resultOf(item){
 if(!known(item))return undefined;const files=typeof item.result==='string'?JSON.parse(item.result):item.result;
 const status=[1,'ready','succeeded'].includes(item.status)?'ready':[2,'error','failed'].includes(item.status)?'error':'pending';
 return {task_id:item.task_id,status,audio_urls:Array.isArray(files)?files.map(i=>audioUrl(i.file??i.audio_path)).filter(Boolean):[],metas:Array.isArray(files)?files.map(i=>({...i.metas,lyrics:i.lyrics??i.metas?.lyrics,prompt:i.prompt??i.metas?.prompt})):[],stage:item.stage,error:item.error};
}
function recordResponse(job,response,save){
 job.responses??=[];const record={at:new Date().toISOString(),...response};let index=job.responses.length+1;while(existsSync(new URL(`${job.id}.response-${index}.json`,results)))index++;
 immutable(new URL(`${job.id}.response-${index}.json`,results),record);job.responses.push(record);job.response=response;save();
}
function submitJobs(state,save){
 if(process.env.RAWCHUNKS_GPU_APPROVED!=='1')throw Error('Authorized GPU flag required');
 for(const job of state.jobs){
  assertIntent(job);if(job.dispatchState==='accepted'||job.response?.httpStatus===200&&job.response.body?.data?.task_id===job.id)continue;
  if(job.dispatchState==='rejected')throw Error(`Stored rejected admission: ${job.id}`);
  if(job.attempts?.length||job.submittedAt){
   const response=call('/query_result',{task_id_list:[job.id],task_ids:[job.id]});const found=entries(response).find(i=>i.task_id===job.id);recordResponse(job,{operation:'recovery-query',...response},save);
   if(known(found)){job.dispatchState='accepted';job.result=resultOf(found);save();continue;}
  }
  job.attempts??=[];job.attempts.push({at:new Date().toISOString(),payloadDigest:job.payloadDigest});job.dispatchState='submitted_unknown';save();
  let response;try{response=call('/release_task',job.payload,job.id);}catch(error){recordResponse(job,{operation:'release',transportError:error.message},save);throw error;}
  recordResponse(job,{operation:'release',...response},save);const returned=response.body?.data?.task_id??response.body?.task_id;
  if(response.httpStatus===200&&returned===job.id)job.dispatchState='accepted';else if(response.httpStatus>=400&&response.httpStatus<500)job.dispatchState='rejected';save();
  console.log(JSON.stringify({id:job.id,dispatchState:job.dispatchState,...response}));if(job.dispatchState!=='accepted')throw Error(`Admission ${job.dispatchState}: ${job.id}`);
 }
}
function queryJobs(state,save){
 if(!state.jobs.length)throw Error('No stored jobs');const response=call('/query_result',{task_id_list:state.jobs.map(j=>j.id),task_ids:state.jobs.map(j=>j.id)});
 state.queries??=[];const record={at:new Date().toISOString(),...response};immutable(new URL(`${state.kind}-query-${state.queries.length+1}.json`,results),record);state.queries.push(record);state.query=response;
 const found=entries(response);for(const job of state.jobs){job.result=resultOf(found.find(i=>i.task_id===job.id));if(job.result)job.dispatchState='accepted';}save();
 console.log(JSON.stringify(state.jobs.map(j=>({id:j.id,status:j.result?.status??'unknown',stage:j.result?.stage,error:j.result?.error}))));
}
function prepareSource(source,take,settings){return nodeInApi(`
const {readAudio,uploadToR2,getR2Url}=await import('./dist/storage/r2.js');
const {decodeWave,padWave,readWave}=await import('./dist/editing/audio.js');const {createHash}=await import('node:crypto');
const response=await fetch('http://127.0.0.1:3005/api/songs/'+input.songId,{headers:{'X-Session-User-Address':input.creator,Origin:'http://localhost:3001'},signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('Source API returned '+response.status);const project=await response.json();const take=project.takes.find(t=>t.id===input.takeId);
if(project.song?.url!==input.sourceUrl||take?.url!==input.sourceUrl||!equal(take.provenance.parameters.submitted,input.settings))throw Error('Source differs from frozen snapshot');
const original=await decodeWave((await readAudio(input.sourceUrl)).buffer);const wave=readWave(original);if(Math.abs(wave.duration-30)>1/wave.rate)throw Error('Source must be exactly thirty seconds');
const hash=createHash('sha256').update(original).digest('hex');const padded=padWave(original,40);const prefixEqual=readWave(padded).samples.subarray(0,wave.samples.length).equals(wave.samples);if(!prefixEqual)throw Error('Padding changed source samples');
const key='diagnostics/extensions/'+input.songId+'/'+hash+'/source-40.wav';const url=getR2Url('versions',key);const head=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(30000)});
if(head.ok){const stored=(await readAudio(url)).buffer;if(!stored.equals(padded))throw Error('Existing padded object differs from frozen bytes');}else if(head.status===404)await uploadToR2('versions',key,padded);else throw Error('Padded source HEAD returned '+head.status);
const output={songId:input.songId,takeId:input.takeId,sourceUrl:input.sourceUrl,sourceHash:hash,paddedHash:createHash('sha256').update(padded).digest('hex'),paddedUrl:url,sourceDuration:wave.duration,targetDuration:40,rate:wave.rate,channels:wave.channels,format:wave.format,bits:wave.bits,paddingPrefixEqual:prefixEqual};
`,{songId:source.song.id,takeId:take.id,creator:source.song.creator,sourceUrl:take.url,settings});}
export function saveGeneration(job,source){return nodeInApi(`
const {createSong,getSongById,finalizeSong,getFullSongProject}=await import('./dist/databases/songs.js');const {persistAudioToR2}=await import('./dist/storage/r2.js');const {createHash}=await import('node:crypto');
const id='sng-'+input.job.id,payload=input.job.payload;const same=s=>s.id===id&&s.creator===input.creator.toLowerCase()&&s.title==='SFT schedule '+payload.shift;
let song=await getSongById(id);if(song&&!same(song))throw Error('Existing diagnostic identity conflicts');const url=song?.url??await persistAudioToR2('songs','diagnostics/'+input.job.id+'.wav',input.job.result.audio_urls[0]);
if(!song){try{song=await createSong({id,title:'SFT schedule '+payload.shift,creator:input.creator,url,duration:30,licenses:0,stream_price:0,license_price:0,image:input.image});}catch(error){song=await getSongById(id);if(!song||!same(song))throw error;}}
const identity=createHash('sha256').update(id+':'+input.job.id).digest('hex');const master={id:'stm-master-'+identity,song_id:id,name:'master',url,waveform_peaks_url:null,volume:1,pan:0,is_muted:false,is_solo:false};
const take={id:'take-'+identity+'-1',song_id:id,stem_id:master.id,take_number:1,model:payload.model,task:'text2music',prompt:payload.prompt,lyrics:payload.lyrics,repainting_start:null,repainting_end:null,url,waveform_url:null,is_active:true,seed:payload.seed,provenance:{taskId:input.job.id,sourceUrl:url,sourceTakeId:null,sourceDuration:30,target:'master',targetStemId:master.id,region:null,outputDuration:30,parameters:{submitted:payload,resolved:input.job.result.metas?.[0]??{}}}};
const prior=(await getFullSongProject(id)).takes.find(t=>t.id===take.id);if(prior&&!equal(prior.provenance?.parameters?.submitted,payload))throw Error('Existing dispatch provenance differs');
await finalizeSong(id,[{id,title:song.title,creator:song.creator,url,licenses:0,stream_price:0,license_price:0,duration:30,tags:[],image:song.image}],master,[take]);
const checked=(await getFullSongProject(id)).takes.find(t=>t.id===take.id);if(!checked||!equal(checked.provenance?.parameters?.submitted,payload))throw Error('Exact dispatch provenance was not persisted');
const output={status:'ready',songId:id,takeId:take.id,primaryUrl:url,submitted:checked.provenance.parameters.submitted};
`,{job,creator:source.song.creator,image:source.song.image??'/hero.png'});}
function mergeExtension(job,state){return nodeInApi(`
const {readAudio,uploadToR2}=await import('./dist/storage/r2.js');const {composeEdit,readWave,decodeWave}=await import('./dist/editing/audio.js');const {createHash}=await import('node:crypto');
const source=await decodeWave((await readAudio(input.source.sourceUrl)).buffer);if(createHash('sha256').update(source).digest('hex')!==input.source.sourceHash)throw Error('Frozen source audio changed');
const generated=await readAudio(input.job.result.audio_urls[0]);const rawHash=createHash('sha256').update(generated.buffer).digest('hex');const rawUrl=await uploadToR2('versions','diagnostics/extensions/'+input.job.id+'/'+rawHash+'/raw.wav',generated.buffer,generated.contentType);
const merged=await composeEdit(source,generated.buffer,{start:30,end:40},30);const before=readWave(source),after=readWave(merged);if(!after.samples.subarray(0,before.samples.length).equals(before.samples))throw Error('Composition changed prefix samples');
const mergedHash=createHash('sha256').update(merged).digest('hex');const mergedUrl=await uploadToR2('versions','diagnostics/extensions/'+input.job.id+'/'+mergedHash+'/merged.wav',merged);
const output={rawUrl,mergedUrl,sourceUrl:input.source.sourceUrl,sourceHash:input.source.sourceHash,rawHash,mergedHash,mergedDuration:after.duration,prefixSampleBytesEqual:true,submitted:input.job.payload};
`,{job,source:state.source});}
export const metricsScript=String.raw`
import os,hashlib,urllib.request,subprocess,tempfile,pathlib,math
import numpy as np
def fetch(url,path):
 headers={'User-Agent':'Rawchunks/1'}
 if not url.startswith('https://'):headers['Authorization']='Bearer '+os.environ.get('ACESTEP_API_KEY','')
 with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=30) as response,path.open('wb') as target:
  while chunk:=response.read(1024*1024):target.write(chunk)
def decode(path,rate=None,channels=None):
 info=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','a:0','-show_entries','stream=sample_rate,channels','-of','json',str(path)]))['streams'][0]
 rate=rate or int(info['sample_rate']);channels=channels or int(info['channels'])
 raw=subprocess.check_output(['ffmpeg','-nostdin','-v','error','-i',str(path),'-map','0:a:0','-vn','-ar',str(rate),'-ac',str(channels),'-f','f32le','-c:a','pcm_f32le','-'])
 return np.frombuffer(raw,dtype='<f4').reshape(-1,channels),rate,channels
def stats(samples):
 finite=bool(np.isfinite(samples).all())
 if not finite or not samples.size:return {'frames':len(samples),'finite':finite,'rms':None,'peak':None,'nonzeroFraction':None}
 rms=float(np.sqrt(np.mean(samples.astype(np.float64)**2)));peak=float(np.max(np.abs(samples)))
 return {'frames':len(samples),'finite':finite,'rms':rms,'peak':peak,'rmsDbFS':20*math.log10(rms) if rms else None,'nonzeroFraction':float(np.mean(np.abs(samples)>1e-5)),'clippedFraction':float(np.mean(np.abs(samples)>=1))}
def audio(samples,rate):
 return {'duration':len(samples)/rate,'whole':stats(samples),'tail30to40':stats(samples[30*rate:min(len(samples),40*rate)]),'tailPerSecond':[{'start':second,**stats(samples[second*rate:min((second+1)*rate,len(samples))])} for second in range(30,40)]}
with tempfile.TemporaryDirectory(prefix='rawchunks-extension-metrics-') as directory:
 directory=pathlib.Path(directory);sourcePath=directory/'source.wav';fetch(input['sourceUrl'],sourcePath)
 source,rate,channels=decode(sourcePath)
 if len(source)!=30*rate:raise ValueError('Source is not exactly thirty seconds')
 measured=[]
 for job in input['jobs']:
  rawPath=directory/(job['id']+'-raw.wav');mergedPath=directory/(job['id']+'-merged.wav')
  fetch(job['rawUrl'],rawPath);fetch(job['mergedUrl'],mergedPath)
  raw,_,_=decode(rawPath,rate,channels);merged,_,_=decode(mergedPath,rate,channels)
  if not np.isfinite(source).all() or not np.isfinite(raw).all() or not np.isfinite(merged).all():raise ValueError('Audio contains nonfinite samples')
  count=min(len(source),len(merged));difference=source[:count].astype(np.float64)-merged[:count].astype(np.float64)
  prefix=merged[:len(source)];equal=len(prefix)==len(source) and bool(np.array_equal(source,prefix))
  measured.append({'id':job['id'],'raw':audio(raw,rate),'merged':audio(merged,rate),'prefix':{'start':0,'end':30,'sampleEqual':equal,'maximumAbsoluteDifference':float(np.max(np.abs(difference))) if difference.size else None,'rmsDifference':float(np.sqrt(np.mean(difference**2))) if difference.size else None,'sourcePcmSha256':hashlib.sha256(source.tobytes()).hexdigest(),'mergedPrefixPcmSha256':hashlib.sha256(prefix.tobytes()).hexdigest()},'rawFileSha256':hashlib.sha256(rawPath.read_bytes()).hexdigest(),'mergedFileSha256':hashlib.sha256(mergedPath.read_bytes()).hexdigest()})
 print(json.dumps({'measuredAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'execution':'resident worker Python and ffmpeg; no local media','rate':rate,'channels':channels,'source':audio(source,rate),'jobs':measured},allow_nan=False))
`;
function summary(state){return {kind:state.kind,jobs:state.jobs.map(j=>({id:j.id,dispatchState:j.dispatchState??'legacy',status:j.result?.status,savedUrl:j.saved?.primaryUrl,mergedUrl:j.merged?.mergedUrl})),source:state.source,metrics:state.metrics};}
async function main(mode){
 const modes=['submit','query','save','prepare-extensions','submit-extensions','query-extensions','merge-extensions','metrics-extensions','status','status-extensions'];if(!modes.includes(mode))throw Error(`Expected ${modes.join(', ')}`);
 mkdirSync(results,{recursive:true});const extension=mode.includes('extensions');const stateFile=new URL(extension?'voices-extension-quality-state.json':'voices-quality-state.json',results);
 if(mode.startsWith('status')){console.log(JSON.stringify(existsSync(stateFile)?summary(read(stateFile)):{stateFile:fileURLToPath(stateFile),exists:false}));return;}
 const lock=fileURLToPath(stateFile)+'.lock';const descriptor=openSync(lock,'wx');writeFileSync(descriptor,String(process.pid));closeSync(descriptor);
 try{
  const {source,take,settings}=sourceSnapshot();const state=existsSync(stateFile)?read(stateFile):{kind:extension?'extension':'generation',startedAt:new Date().toISOString(),jobs:[]};state.kind??=extension?'extension':'generation';const save=()=>write(stateFile,state);
  if(mode==='prepare-extensions'){
   state.source??=prepareSource(source,take,settings);state.sourceSettings??=structuredClone(settings);if(!equal(state.sourceSettings,settings))throw Error('Source settings changed');save();rememberJobs(state,extensionJobs(settings,state.source.paddedUrl),save);console.log(JSON.stringify(summary(state)));return;
  }
  if(extension&&(!state.source||state.jobs.length!==6))throw Error('Run prepare-extensions first');if(!extension&&mode==='submit')rememberJobs(state,generationJobs(settings),save);
  for(const job of state.jobs){job.payloadDigest??=digest(job.payload);assertIntent(job);}
  if(mode==='submit'||mode==='submit-extensions')submitJobs(state,save);
  else if(mode==='query'||mode==='query-extensions')queryJobs(state,save);
  else if(mode==='save'||mode==='merge-extensions'){
   queryJobs(state,save);
   for(const job of state.jobs){
    if(job.result?.status!=='ready')continue;if(job.result.audio_urls.length!==1)throw Error(`Expected one output: ${job.id}`);
    if(mode==='save'&&!job.saved){job.saved=saveGeneration(job,source);immutable(new URL(`${job.id}.saved.json`,results),job.saved);}
    if(mode==='merge-extensions'&&!job.merged){job.merged=mergeExtension(job,state);immutable(new URL(`${job.id}.merged.json`,results),job.merged);}save();
   }
   console.log(JSON.stringify(summary(state)));
  }else if(mode==='metrics-extensions'){
   if(state.jobs.some(j=>!j.merged))throw Error('Merge all six completed jobs first');
   // One job per worker call bounds memory and leaves each metric independently recoverable.
   const measured=[];
   for(const job of state.jobs){
  const file=new URL(`${job.id}.metrics.json`,results);
    const result=existsSync(file)?read(file):pythonInWorker(metricsScript,{sourceUrl:state.source.sourceUrl,jobs:[{id:job.id,...job.merged}]});
    if(result.jobs?.[0]?.id!==job.id||result.jobs[0].rawFileSha256!==job.merged.rawHash||result.jobs[0].mergedFileSha256!==job.merged.mergedHash)throw Error('Metric artifacts differ from immutable merge receipt');
    immutable(file,result);measured.push(result);
   }
   const result={measuredAt:new Date().toISOString(),execution:'resident worker Python and ffmpeg; no local media',rate:measured[0].rate,channels:measured[0].channels,source:measured[0].source,jobs:measured.flatMap(m=>m.jobs)};
   const file=new URL('voices-extension-quality-metrics.json',results);write(file,result);state.metrics=fileURLToPath(file);save();console.log(JSON.stringify(result));
  }
 }finally{unlinkSync(lock);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
