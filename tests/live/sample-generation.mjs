import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../results/', import.meta.url));
const statePath = `${directory}gpu-state.json`;
const script = readFileSync(new URL('./cluster-job.py', import.meta.url), 'utf8');
const expected = 'gke_gen-lang-client-0035632562_us-central1-a_rawchunks';
if (execFileSync('kubectl', ['config', 'current-context'], { encoding: 'utf8' }).trim() !== expected) throw Error('Unexpected cluster');
if (process.env.RAWCHUNKS_GPU_APPROVED !== '1') throw Error('Existing workload authorization is required');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const inventory = JSON.parse(readFileSync(`${directory}sample-inventory.json`, 'utf8'));
if (inventory.samples.length !== 8) throw Error('Prepare and verify all eight samples first');
// This continuation shares the original ten-job ceiling, including the two
// previously executed separation tasks. Persist an intent before each release.
state.separationJobs ??= [
  { taskId: JSON.parse(readFileSync(`${directory}live-separate-vocal.json`, 'utf8')).body.data.task_id },
  { taskId: JSON.parse(readFileSync(`${directory}live-separate-mixed.json`, 'utf8')).body.data.task_id },
];
if (state.jobs.some(job => job.sampleMatrix)) throw Error('Sample matrix already submitted; refuse duplicate work');
if (state.jobs.length + state.separationJobs.length + 3 > state.maxJobs) throw Error('Original ten-job budget exhausted');
const selected = [
  'catch22music-la-cucaracha-acapella-vocal-arrangement-366115.mp3',
  'looperman-a-8283227-0024907-dangerous.mp3',
  'looperman-a-5957902-0024908-fragments-of-a-bruised-love.mp3',
];
for (const filename of selected) {
  const sample = inventory.samples.find(sample => sample.file === filename);
  if (!sample?.finite || sample.preparedDuration > 60.01) throw Error('Sample is missing or invalid');
  const payload = {
    model: 'acestep-v15-xl-base', task_type: 'text2music',
    prompt: 'Clear solo singing with light instrumental backing, keep reference vocal character',
    lyrics: '[Verse]\nWe follow the light\nAnd sing through the night',
    reference_audio_path: sample.preparedPath, audio_duration: 60, batch_size: 1,
    inference_steps: 25, seed: 43, use_random_seed: false, thinking: false, audio_format: 'wav',
  };
  const job = { model: payload.model, sampleMatrix: filename, sampleSha256: sample.sha256, payload, dispatchState: 'submitted_unknown', submittedAt: new Date().toISOString() };
  state.jobs.push(job);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const source = script.replace('data=json.loads(sys.stdin.read())', `data=json.loads(${JSON.stringify(JSON.stringify(payload))})`);
  job.response = JSON.parse(execFileSync('kubectl', ['--request-timeout=45s', 'exec', '-i', '-n', 'rawchunks', 'deployment/acestep-xl-15-turbo', '--', 'python3', '-', 'release'], { input: source, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 }));
  job.dispatchState = job.response.httpStatus === 200 && job.response.body.data?.task_id ? 'accepted' : 'rejected';
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(job));
}
