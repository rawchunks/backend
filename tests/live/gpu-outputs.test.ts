import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const path = new URL('../results/gpu-audio.json', import.meta.url);
const enabled = process.env.RAWCHUNKS_LIVE === '1' && existsSync(path);
describe.skipIf(!enabled)('decoded live GPU outputs', () => {
  it('renders all requested Base, Turbo and SFT models with the correct provenance', () => {
    const outputs = JSON.parse(readFileSync(path, 'utf8'));
    expect(outputs.length).toBeGreaterThanOrEqual(3);
    for (const audio of outputs) {
      expect(audio.actualModel).toBe(audio.requestedModel);
      expect(audio.fileBytes).toBeGreaterThan(1000);
      expect(audio.sampleRate).toBeGreaterThanOrEqual(16000);
      expect(audio.channels).toBeGreaterThanOrEqual(1);
      expect(Math.abs(audio.duration - 60)).toBeLessThan(.1);
      expect(audio.finite).toBe(true);
      expect(audio.rms).toBeGreaterThan(0.00001);
      expect(audio.clippedFraction).toBeLessThan(.01);
    }
  });
});
