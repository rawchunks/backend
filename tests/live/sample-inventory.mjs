import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../fixtures/samples/',import.meta.url));
const expected='gke_gen-lang-client-0035632562_us-central1-a_rawchunks';
if(execFileSync('kubectl',['config','current-context'],{encoding:'utf8'}).trim()!==expected)throw Error('Unexpected cluster');
const pod=execFileSync('kubectl',['--request-timeout=20s','get','pod','-n','rawchunks','-l','app=acestep-xl-15-turbo','-o','jsonpath={.items[0].metadata.name}'],{encoding:'utf8'});
const remote='/tmp/rawchunks-preprod-audit/sample-matrix';
execFileSync('kubectl',['--request-timeout=20s','exec','-n','rawchunks',pod,'--','mkdir','-p',remote],{timeout:30000});
const rows=[];
for(const file of readdirSync(root).filter(f=>f.endsWith('.mp3')).sort()){
 const bytes=readFileSync(root+file);const sha256=createHash('sha256').update(bytes).digest('hex');const key=sha256.slice(0,16);
 if(bytes.length>50*1024*1024)throw Error('Sample exceeds upload limit');
 const target=`${remote}/${key}.mp3`;
 execFileSync('kubectl',['--request-timeout=30s','cp',root+file,`rawchunks/${pod}:${target}`],{timeout:45000,stdio:['ignore','pipe','pipe']});
 const source=`import json,hashlib,subprocess\nfrom pathlib import Path\nimport soundfile as sf\nimport numpy as np\np=Path(${JSON.stringify(target)})\nassert hashlib.sha256(p.read_bytes()).hexdigest()==${JSON.stringify(sha256)}\nprobe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(p)]))\nout=p.with_suffix('.wav')\nsubprocess.run(['ffmpeg','-v','error','-y','-i',str(p),'-t','60','-ar','48000',str(out)],check=True)\naudio,sr=sf.read(str(out),always_2d=True)\nprint(json.dumps({'duration':float(probe['format']['duration']),'streams':[{'codec':x.get('codec_name'),'sampleRate':x.get('sample_rate'),'channels':x.get('channels')} for x in probe['streams']],'preparedPath':str(out),'preparedDuration':len(audio)/sr,'sampleRate':sr,'channels':audio.shape[1],'finite':bool(np.isfinite(audio).all()),'peak':float(np.abs(audio).max()),'rms':float(np.sqrt(np.mean(audio**2))),'clippedFraction':float(np.mean(np.abs(audio)>=1.0))}))\n`;
 const measured=JSON.parse(execFileSync('kubectl',['--request-timeout=30s','exec','-i','-n','rawchunks',pod,'--','uv','run','--no-sync','python','-'],{input:source,encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024}));
 const row={file,bytes:bytes.length,sha256,...measured};rows.push(row);console.log(JSON.stringify(row));
 writeFileSync(fileURLToPath(new URL('../results/sample-inventory.json',import.meta.url)),JSON.stringify({capturedAt:new Date().toISOString(),pod,samples:rows},null,2));
}
