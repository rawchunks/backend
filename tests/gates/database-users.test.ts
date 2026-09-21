import { beforeEach, describe, expect, it, vi } from 'vitest';
const sql = vi.hoisted(() => vi.fn());
vi.mock('../../databases/client.js', () => ({ userSql: sql }));
import { checkUserConsent, getUserConsent, parseAddress, putUserConsent, putWalletPair } from '../../databases/users.js';
const evm = `0x${'a'.repeat(40)}`;
const svm = 'So11111111111111111111111111111111111111112';
const row = (overrides: Record<string, unknown> = {}) => ({ evm_address: evm, svm_address: svm, consented_at: '2026-10-08T12:00:00.000Z', consent_version: '1.0.0', consent_signature: 'invalid-fixture-signature', consent_message: 'terms', ...overrides });
beforeEach(() => sql.mockReset().mockResolvedValue([row()]));
describe('wallet pairs and consent persistence', () => {
  it('rejects an empty consent signature in the service layer', async () => {
    await expect(putUserConsent({ address: evm, signature: '' })).rejects.toThrow();
  });
  it('rejects frontend unsigned placeholder 0x before persistence', async () => {
    await expect(putUserConsent({ address: evm, signature: '0x' })).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });
  it('does not count a row with no signature as recorded consent', async () => {
    sql.mockResolvedValueOnce([row({ consent_signature: '' })]);
    expect(await getUserConsent(evm)).toBeNull();
  });
  it('requires the requested disclaimer type to match stored consent', async () => {
    sql.mockResolvedValueOnce([row({ consent_metadata: { disclaimerType: 'generation' } })]);
    expect(await getUserConsent({ address: evm, disclaimerType: 'voice-cloning' })).toBeNull();
  });
  it('surfaces a consent database outage instead of reporting non-consent', async () => {
    sql.mockRejectedValueOnce(new Error('fixture outage'));
    await expect(checkUserConsent(evm)).rejects.toThrow('fixture outage');
  });
  it('rejects a syntactically base58 address whose decoded public key is not 32 bytes', () => {
    // Every leading base58 "1" encodes a zero byte: 44 of them is a 44-byte key.
    expect(() => parseAddress('1'.repeat(44))).toThrow();
  });
  it('rejects unpaired single EVM consent without synthesizing Solana identity', async () => {
    await expect(putUserConsent({ address: evm, signature: 'invalid-fixture-signature' })).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });
  it('addresses sharing a prefix are independently rejected without placeholder writes', async () => {
    await expect(putUserConsent({ address: `0xaaaaaaaa${'1'.repeat(32)}`, signature: 'invalid-fixture-signature' })).rejects.toThrow();
    await expect(putUserConsent({ address: `0xaaaaaaaa${'2'.repeat(32)}`, signature: 'invalid-fixture-signature' })).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });
  it('changing the paired identity invalidates prior consent through conditional SQL', async () => {
    const replacement = 'so11111111111111111111111111111111111111112';
    sql.mockResolvedValueOnce([row({ svm_address: replacement, consented_at: null, consent_signature: null })]);
    const pair = await putWalletPair({ evmAddress: evm, svmAddress: replacement });
    expect(pair.consentedAt).toBeNull(); expect(pair.consentSignature).toBeNull();
    expect(sql.mock.calls[0][0].join('')).toContain('IS DISTINCT FROM EXCLUDED.svm_address');
  });
});
