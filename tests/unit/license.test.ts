import { describe, expect, it } from 'vitest';
import { licenseSales } from '../../../app/src/lib/versions';

describe('license sales', () => {
  it('reports purchased licenses rather than the initial allocation', () => {
    expect(licenseSales(20, 19n)).toBe(1);
    expect(licenseSales(20, 0n)).toBe(20);
    expect(licenseSales(20, 20n)).toBe(0);
  });
  it('rejects a remaining balance inconsistent with the minted allocation', () => {
    expect(() => licenseSales(20, 21n)).toThrow('allocation');
    expect(() => licenseSales(-1, 0n)).toThrow('allocation');
  });
});
