import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
const base = new URL('../results/', import.meta.url);
const enabled = process.env.RAWCHUNKS_LIVE === '1';
const read = (name: string) => JSON.parse(readFileSync(new URL(name, base), 'utf8'));
describe.skipIf(!enabled)('live voice/separation worker checks', () => {
  it('decodes every stem output from both supplied 60-second samples', () => {
    const stems = read('voice-stem-audio.json');
    expect(stems.length).toBe(10);
    for (const stem of stems) {
      expect(stem.duration).toBe(60);
      expect(stem.finite).toBe(true);
      expect(stem.sampleRate).toBe(44100);
      expect(stem.channels).toBe(2);
    }
  });
  it('answers 20 simultaneous read-only polling requests within bounded deadlines', () => {
    const polls = read('live-poll-pressure.json');
    expect(polls.length).toBe(20);
    for (const poll of polls) {
      expect(poll.status).toBe(200);
      expect(poll.items).toBe(5);
      expect(poll.seconds).toBeLessThan(15);
    }
  });
  it.skipIf(!existsSync(new URL('live-lora.json', base)))('rejects raw audio as LoRA weights and preserves adapter state', () => {
    const result = read('live-lora.json');
    expect(result.before.status).toBe(200);
    expect(result.attempt.status).toBe(400);
    expect(result.after.status).toBe(200);
    expect(result.after.data.data).toEqual(result.before.data.data);
  });
  it.each([['live-separate-vocal.json','vocals'],['live-separate-mixed.json','instrumental']])('honors the requested stem mode in %s', (file, stem) => {
    const result = read(file);
    expect(result.httpStatus).toBe(200);
    expect(result.body.data.status).toBe('ready');
    expect(Object.keys(result.body.data.stems)).toEqual([stem]);
  });
});
