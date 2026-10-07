import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const directory = new URL('../results/', import.meta.url);
const stateFile = new URL('gpu-state.json', directory);
describe.skipIf(process.env.RAWCHUNKS_LIVE !== '1' || !existsSync(stateFile))('additional real reference-conditioned sample outputs', () => {
  it.each([
    'catch22music-la-cucaracha-acapella-vocal-arrangement-366115.mp3',
    'looperman-a-8283227-0024907-dangerous.mp3',
    'looperman-a-5957902-0024908-fragments-of-a-bruised-love.mp3',
  ])('decodes the correct single-output 60-second Base render for %s', file => {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const inventory = JSON.parse(readFileSync(new URL('sample-inventory.json', directory), 'utf8'));
    const audio = JSON.parse(readFileSync(new URL('gpu-audio.json', directory), 'utf8'));
    const job = state.jobs.find(job => job.sampleMatrix === file);
    expect(job).toBeTruthy();
    expect(job.dispatchState).toBe('accepted');
    expect(job.sampleSha256).toBe(inventory.samples.find(sample => sample.file === file).sha256);
    const output = audio.find(item => item.taskId === job.response.body.data.task_id);
    expect(output).toMatchObject({ actualModel: 'acestep-v15-xl-base', requestedModel: 'acestep-v15-xl-base', duration: 60, sampleRate: 48000, channels: 2, finite: true });
    expect(output.rms).toBeGreaterThan(.00001);
    expect(output.clippedFraction).toBeLessThan(.01);
    expect(state.jobs.length + state.separationJobs.length).toBeLessThanOrEqual(10);
  });
});
