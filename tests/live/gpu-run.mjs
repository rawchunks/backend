import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const directory=fileURLToPath(new URL('../results/',import.meta.url));
const script=readFileSync(new URL('./cluster-job.py',import.meta.url),'utf8');
const expected='gke_gen-lang-client-0035632562_us-central1-a_rawchunks';
if(execFileSync('kubectl',['config','current-context'],{encoding:'utf8'}).trim()!==expected)throw Error('Unexpected cluster');
function call(operation,args=[],payload){
 const input=operation==='release'?`${script}\n`:script;
 // Payload is passed as a python literal JSON through an environment-free stdin wrapper.
 const source=operation==='release'?script.replace("data=json.loads(sys.stdin.read())",`data=json.loads(${JSON.stringify(JSON.stringify(payload))})`):script;
 return JSON.parse(execFileSync('kubectl',['--request-timeout=45s','exec','-i','-n','rawchunks','deployment/acestep-xl-15-turbo','--','python3','-',operation,...args],{input:source,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024}));
}
const mode=process.argv[2];
const statePath=`${directory}gpu-state.json`;
if(mode==='submit'){
 if(process.env.RAWCHUNKS_GPU_APPROVED!=='1')throw Error('Set RAWCHUNKS_GPU_APPROVED=1 only after workload authorization');
 if(existsSync(statePath))throw Error('Existing run state present; refuse duplicate GPU submissions');
 const state={runId:randomUUID(),startedAt:new Date().toISOString(),maxJobs:10,maxDuration:60,maxConcurrency:10,jobs:[]};
 writeFileSync(statePath,JSON.stringify(state,null,2));
 for(const model of ['acestep-v15-xl-base','acestep-v15-xl-turbo','acestep-v15-xl-sft']){
  const payload={model,task_type:'text2music',prompt:'Minimal instrumental percussion, gentle bass, steady rhythm, 100 BPM, C minor',instrumental:true,audio_duration:60,batch_size:1,inference_steps:model.endsWith('turbo')?8:25,seed:42,use_random_seed:false,thinking:false,audio_format:'wav'};
  const res=call('release',[],payload);state.jobs.push({model,payload,response:res,submittedAt:new Date().toISOString()});writeFileSync(statePath,JSON.stringify(state,null,2));
  console.log(JSON.stringify(state.jobs.at(-1)));
 }
}else if(mode==='references'){
 if(process.env.RAWCHUNKS_GPU_APPROVED!=='1')throw Error('GPU approval required');
 const state=JSON.parse(readFileSync(statePath,'utf8'));
 if(state.jobs.some(j=>j.reference))throw Error('Reference tasks already submitted');
 if(state.jobs.length+2>state.maxJobs)throw Error('Job budget exceeded');
 for(const reference of ['vocal','mixed']){
  const payload={model:'acestep-v15-xl-base',task_type:'text2music',prompt:'Clear solo singing with light instrumental backing, keep reference vocal character',lyrics:'[Verse]\nWe follow the light\nAnd sing through the night',reference_audio_path:`/tmp/rawchunks-preprod-audit/${reference}.wav`,audio_duration:60,batch_size:1,inference_steps:25,seed:43,use_random_seed:false,thinking:false,audio_format:'wav'};
  const response=call('release',[],payload);state.jobs.push({model:payload.model,reference,payload,response,submittedAt:new Date().toISOString()});writeFileSync(statePath,JSON.stringify(state,null,2));console.log(JSON.stringify(state.jobs.at(-1)));
 }
}else if(mode==='query'){
 const state=JSON.parse(readFileSync(statePath,'utf8'));
 const ids=state.jobs.map(j=>j.response.body.data?.task_id).filter(Boolean);
 const result=call('query',ids);writeFileSync(`${directory}gpu-query.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}else if(mode==='stats'){console.log(JSON.stringify(call('stats')));}
else throw Error('Use submit, query or stats');
