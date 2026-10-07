import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const evidence = new URL('../results/sample-inventory.json', import.meta.url);
describe.skipIf(process.env.RAWCHUNKS_LIVE !== '1' || !existsSync(evidence))('all supplied MP3s decoded in the worker runtime', () => {
  it('has eight verified source hashes and finite prepared audio within the 60-second limit', () => {
    const inventory = JSON.parse(readFileSync(evidence, 'utf8'));
    expect(inventory.samples.length).toBe(8);
    for (const sample of inventory.samples) {
      const bytes = readFileSync(new URL(`../fixtures/samples/${sample.file}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sample.sha256);
      expect(sample.preparedDuration).toBeGreaterThan(0);
      expect(sample.preparedDuration).toBeLessThanOrEqual(60.01);
      expect(sample.finite).toBe(true);
      expect(sample.rms).toBeGreaterThan(0);
      expect(sample.sampleRate).toBe(48000);
      expect(sample.channels).toBeGreaterThanOrEqual(1);
      expect(sample.bytes).toBeLessThan(50 * 1024 * 1024);
    }
  });
});
