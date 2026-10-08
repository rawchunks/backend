// Authorized diagnostics use the existing worker HTTP interfaces, never direct GPU execution.
import {execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
const root=new URL('../results/',import.meta.url);
const namespace='rawchunks';
const expected='gke_gen-lang-client-0035632562_us-central1-a_rawchunks';
if(execFileSync('kubectl',['config','current-context'],{encoding:'utf8'}).trim()!==expected)throw Error('Unexpected cluster');
export function call(deployment,path,payload,taskId){
 const script=`import json,os,urllib.request,urllib.error,time\npayload=json.loads(${JSON.stringify(JSON.stringify(payload??null))})\nheaders={'Authorization':'Bearer '+os.environ.get('ACESTEP_API_KEY',''),'Content-Type':'application/json'}\nidentifier=${JSON.stringify(taskId??'')}\nif identifier:headers['Idempotency-Key']=identifier\nr=urllib.request.Request('http://127.0.0.1:8001'+${JSON.stringify(path)},data=None if payload is None else json.dumps(payload).encode(),headers=headers)\nt=time.time()\ntry:\n with urllib.request.urlopen(r,timeout=45) as response:\n  b=response.read();print(json.dumps({'httpStatus':response.status,'body':json.loads(b),'seconds':time.time()-t}))\nexcept urllib.error.HTTPError as e:\n b=e.read().decode();\n try:body=json.loads(b)\n except:body={'error':b}\n print(json.dumps({'httpStatus':e.code,'body':body,'seconds':time.time()-t}))`;
 return JSON.parse(execFileSync('kubectl',['exec','-i','-n',namespace,`deployment/${deployment}`,'--','.venv/bin/python','-'],{input:script,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024}));
}
const mode=process.argv[2];
if(mode==='probe'){
 const probes=[];for(const deployment of ['acestep-training','acestep-xl-15-turbo'])for(const path of ['/health','/v1/training/options','/v1/dataset/samples','/v1/lora/status']){
  try{probes.push({deployment,path,...call(deployment,path)});}catch(e){probes.push({deployment,path,error:e.message});}
 }
 writeFileSync(new URL('voices-worker-probes.json',root),JSON.stringify(probes,null,2));console.log(JSON.stringify(probes));
}else if(mode==='capacity'){
 if(process.env.RAWCHUNKS_GPU_APPROVED!=='1')throw Error('Authorized GPU test flag required');
 const records=JSON.parse(readFileSync(new URL('voices-audit-current.json',root),'utf8'));
 const selected=[records.reduce((a,b)=>a.duration<b.duration?a:b),records.reduce((a,b)=>a.duration>b.duration?a:b)];
 const options=call('acestep-training','/v1/training/options');if(options.httpStatus!==200)throw Error('Training startup is not ready');
 const file=new URL('voices-capacity-state.json',root);const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{startedAt:new Date().toISOString(),jobs:[]};
 for(const sample of selected){
  const model=options.body.data.models.find(m=>m.model==='acestep-v15-xl-turbo');
  const taskId=`capacity-${sample.hash.slice(0,24)}-xl-turbo-v1`;
  if(state.jobs.some(j=>j.taskId===taskId))continue;
  const payload={model:model.model,checkpoint_fingerprint:model.checkpoint_fingerprint,training_config:model.training_config,source_audio_url:sample.sample_url,sample_metadata:{is_instrumental:false}};
  const job={taskId,voiceId:sample.id,duration:sample.duration,hash:sample.hash,payload,submittedAt:new Date().toISOString()};state.jobs.push(job);writeFileSync(file,JSON.stringify(state,null,2));
  job.response=call('acestep-training','/v1/training/start',payload,taskId);writeFileSync(file,JSON.stringify(state,null,2));console.log(JSON.stringify(job));
 }
}else if(mode==='query'){
 const state=JSON.parse(readFileSync(new URL('voices-capacity-state.json',root),'utf8'));
 const result=call('acestep-training','/v1/training/query_result',{task_id_list:state.jobs.map(j=>j.taskId)});writeFileSync(new URL('voices-capacity-query.json',root),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}else if(mode!==undefined)throw Error('Expected probe,capacity,query');
