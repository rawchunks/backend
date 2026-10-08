import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { toFunctionSelector } from '../../../app/node_modules/viem/_esm/index.js';
import { FACTORY_ABI, REMIX_ABI, ROYALTIES_ABI } from '../../../app/src/lib/contracts.js';

describe('contract bindings', () => {
  it.each([
    ['Factory', 'factory', FACTORY_ABI],
    ['Remix', 'remix', REMIX_ABI],
    ['Royalties', 'royalties', ROYALTIES_ABI],
  ] as const)('%s calls match the compiled contract', (name, file, bindings) => {
    const artifact = JSON.parse(readFileSync(new URL(`../../../blockchain/contracts/out/${file}.sol/${name}.json`, import.meta.url), 'utf8'));
    for (const binding of bindings) {
      const method = artifact.abi.find((entry: any) => entry.type === 'function' && entry.name === binding.name);
      expect(method, binding.name).toBeDefined();
      expect(toFunctionSelector(binding), binding.name).toBe(toFunctionSelector(method));
      expect(binding.stateMutability, binding.name).toBe(method.stateMutability);
      expect(binding.outputs.map(output => output.type), binding.name).toEqual(method.outputs.map((output: any) => output.type));
    }
  });
});
