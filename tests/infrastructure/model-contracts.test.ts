import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
const source = new URL('../results/model-configurations.json', import.meta.url);
describe.skipIf(!existsSync(source))('captured model checkpoint/config contracts', () => {
  const read = () => JSON.parse(readFileSync(source, 'utf8'));
  it('XL variants have present sharded weights and distinct model version configuration', () => {
    for (const variant of ['turbo', 'base', 'sft']) {
      const model = read()[`acestep-v15-xl-${variant}`];
      expect(model.weights.length).toBe(4);
      expect(model.weights.every((w: any[]) => w[1] > 1e9)).toBe(true);
      // SFT shares the Base architecture; directory identifies weight variant.
      expect(model.config.model_version).toBe(variant === 'sft' ? 'base' : variant);
      expect(model.config.is_turbo).toBe(variant === 'turbo');
      expect(model.config.dtype).toBe('bfloat16');
    }
  });
  it('language model weights exist and persistent checkpoint storage has spare capacity', () => {
    const model = read()['acestep-5Hz-lm-0.6B'];
    expect(model.weights.length).toBe(1);
    expect(model.config.model_type).toBe('qwen3');
    expect(read().storage.availableBytes).toBeGreaterThan(10 * 1024 ** 3);
  });
});
