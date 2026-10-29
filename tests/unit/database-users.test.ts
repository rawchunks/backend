import { beforeEach, describe, expect, it, vi } from 'vitest';
const sql = vi.hoisted(() => vi.fn());
vi.mock('../../databases/client.js', () => ({ userSql: sql, songSql: vi.fn() }));
import { checkUserConsent, getUserConsent, getWalletPair, parseAddress, putUserConsent, putWalletPair } from '../../databases/users.js';

const evm = `0x${'aB'.repeat(20)}`, normalized = evm.toLowerCase();
const svm = 'So11111111111111111111111111111111111111112';
const date = '2026-10-08T12:00:00.000Z', proof = `0x${'12'.repeat(65)}`;
const row = (overrides = {}) => ({ evm_address: normalized, svm_address: svm, consented_at: date, consent_version: '1.0.0', consent_signature: proof, consent_message: 'signed terms', consent_metadata: { disclaimerType: 'generation' }, ...overrides });
const consent = (overrides = {}) => ({ address: evm, svmAddress: svm, signature: proof, message: 'signed terms', policyVersion: '1.0.0', disclaimerType: 'generation', metadata: { signedAt: date }, ...overrides });
const query = (index = 0) => (sql.mock.calls[index][0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim();
beforeEach(() => sql.mockReset().mockResolvedValue([]));

describe('wallet address and pair persistence', () => {
  it.each([null, undefined, 1, '', ' ', 'bad', '0x123', '1'.repeat(44), 'svm_pending_aaaaaaaa'])('rejects invalid address %j', value => expect(() => parseAddress(value)).toThrow('Invalid wallet address'));
  it('normalizes EVM case and retains case-sensitive Solana addresses', () => {
    expect(parseAddress(` ${evm} `)).toEqual({ kind: 'evm', value: normalized });
    expect(parseAddress(` svm:${svm} `)).toEqual({ kind: 'svm', value: svm });
  });
  it.each([{ evmAddress: svm, svmAddress: svm }, { evmAddress: evm, svmAddress: evm }])('rejects swapped chain types %j', async input => {
    await expect(putWalletPair(input)).rejects.toThrow('must be EVM');
    expect(sql).not.toHaveBeenCalled();
  });
  it('binds pair addresses as SQL parameters and clears consent when the pair changes', async () => {
    sql.mockResolvedValueOnce([row()]);
    expect(await putWalletPair({ evmAddress: evm, svmAddress: svm })).toMatchObject({ evmAddress: normalized, svmAddress: svm });
    expect(sql.mock.calls[0].slice(1)).toEqual([normalized, svm, null, null]);
    expect(query()).toContain('wallet_pairs.svm_address IS DISTINCT FROM EXCLUDED.svm_address');
    expect(query()).toContain('consented_at = CASE');
    expect(query()).not.toContain(normalized);
  });
  it('propagates unique conflicts and missing insertion failures', async () => {
    sql.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: '23505' }));
    await expect(putWalletPair({ evmAddress: evm, svmAddress: svm })).rejects.toMatchObject({ code: '23505' });
    await expect(putWalletPair({ evmAddress: evm, svmAddress: svm })).rejects.toThrow('Failed to create');
  });
  it.each([[evm, 'evm_address', normalized], [`svm:${svm}`, 'svm_address', svm]])('looks up %s in its chain column', async (address, column, bound) => {
    sql.mockResolvedValueOnce([row()]);
    expect(await getWalletPair(address)).toMatchObject({ evmAddress: normalized, svmAddress: svm });
    expect(query()).toContain(`WHERE ${column} = ? LIMIT 1`);
    expect(sql.mock.calls[0].slice(1)).toEqual([bound]);
  });
  it('returns null for a missing pair', async () => expect(await getWalletPair(evm)).toBeNull());
  it('returns nullable consent fields for a pair without consent', async () => {
    sql.mockResolvedValueOnce([{ evm_address: normalized, svm_address: svm }]);
    expect(await getWalletPair(evm)).toMatchObject({ consentedAt: null, consentSignature: null, consentMetadata: null });
  });
  it('supports EVM-only and SVM-only wallet records symmetrically', async () => {
    sql.mockResolvedValueOnce([row({ svm_address: null })]);
    expect(await getWalletPair(evm)).toMatchObject({ evmAddress: normalized, svmAddress: '' });
    sql.mockResolvedValueOnce([row({ evm_address: null })]);
    expect(await getWalletPair(svm)).toMatchObject({ evmAddress: '', svmAddress: svm });
  });
});

describe('consent persistence', () => {
  it.each(['', ' ', '0x'])('rejects an empty signature %j before querying the database', async signature => {
    await expect(putUserConsent(consent({ signature }))).rejects.toThrow('signature and signed message');
    expect(sql).not.toHaveBeenCalled();
  });
  it.each([undefined, '', ' '])('requires the signed message %j before querying the database', async message => {
    await expect(putUserConsent(consent({ message }))).rejects.toThrow('signature and signed message');
    expect(sql).not.toHaveBeenCalled();
  });
  it('registers a Solana-only account without requiring an EVM counterpart', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([row({ evm_address: null })]).mockResolvedValueOnce([row({ evm_address: null })]);
    expect(await putUserConsent(consent({ address: svm, svmAddress: undefined }))).toMatchObject({ evmAddress: '', svmAddress: svm });
  });
  it('registers the supplied pair before recording first consent', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]).mockResolvedValueOnce([row()]);
    expect(await putUserConsent(consent())).toMatchObject({ evmAddress: normalized, svmAddress: svm });
    expect(query(1)).toContain('INSERT INTO public.wallet_pairs');
    expect(query(2)).toContain('UPDATE public.wallet_pairs');
  });
  it('registers a Solana-selected account using its existing EVM counterpart', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]).mockResolvedValueOnce([row()]);
    expect(await putUserConsent(consent({ address: svm, metadata: { evmAddress: evm } }))).toMatchObject({ evmAddress: normalized, svmAddress: svm });
  });
  it('rejects a different paired Solana address before mutation', async () => {
    sql.mockResolvedValueOnce([row()]);
    await expect(putUserConsent(consent({ svmAddress: '11111111111111111111111111111111' }))).rejects.toThrow('Wallet pair not found');
    expect(sql).toHaveBeenCalledTimes(1);
  });
  it('stores the supplied signature, message, version and metadata against the exact pair', async () => {
    sql.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row()]);
    expect(await putUserConsent(consent())).toMatchObject({ evmAddress: normalized, svmAddress: svm, policyVersion: '1.0.0', signature: proof, message: 'signed terms' });
    expect(query(1)).toContain('WHERE evm_address = ? AND svm_address IS NOT DISTINCT FROM ?');
    expect(sql.mock.calls[1].slice(1)).toEqual(['1.0.0', proof, 'signed terms', JSON.stringify({ signedAt: date, disclaimerType: 'generation' }), normalized, svm]);
    expect(sql).toHaveBeenCalledTimes(2);
  });
  it('can locate the existing pair by its Solana address', async () => {
    sql.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row()]);
    await putUserConsent(consent({ address: `svm:${svm}` }));
    expect(sql.mock.calls[0].slice(1)).toEqual([svm]);
  });
  it('reports a pair change during the update', async () => {
    sql.mockResolvedValueOnce([row()]);
    await expect(putUserConsent(consent())).rejects.toMatchObject({ statusCode: 409 });
  });
  it('propagates database outages', async () => {
    sql.mockRejectedValueOnce(new Error('database outage'));
    await expect(putUserConsent(consent())).rejects.toThrow('database outage');
    sql.mockRejectedValueOnce(new Error('database outage'));
    await expect(checkUserConsent(evm)).rejects.toThrow('database outage');
  });
});

describe('consent lookup', () => {
  it('returns stored consent and applies explicit type and version', async () => {
    sql.mockResolvedValueOnce([row()]);
    expect(await getUserConsent(svm)).toMatchObject({ signedAt: date, message: 'signed terms' });
    sql.mockResolvedValueOnce([row()]);
    expect(await getUserConsent({ address: evm, policyVersion: 'obsolete' })).toBeNull();
    sql.mockResolvedValueOnce([row()]);
    expect(await getUserConsent({ address: evm, disclaimerType: 'voice-cloning' })).toBeNull();
  });
  it('retains consent recorded before disclaimer types were sent by the client', async () => {
    sql.mockResolvedValueOnce([row({ consent_metadata: null })]);
    expect(await getUserConsent({ address: evm, disclaimerType: 'generation', policyVersion: '1.0.0' })).toMatchObject({ signature: proof });
  });
  it.each([{ consent_signature: '' }, { consent_version: null }, { consented_at: null }])('returns null for incomplete consent %j', async patch => {
    sql.mockResolvedValueOnce([row(patch)]);
    expect(await getUserConsent(evm)).toBeNull();
  });
  it('retains signed consent from the original client that omitted the message', async () => {
    sql.mockResolvedValueOnce([row({ consent_message: null, consent_metadata: null, svm_address: null })]);
    expect(await getUserConsent({ address: evm, disclaimerType: 'generation', policyVersion: '1.0.0' })).toMatchObject({ signature: proof });
  });
  it('returns null without querying the legacy users table when a pair is missing', async () => {
    expect(await getUserConsent(evm)).toBeNull();
    expect(sql).toHaveBeenCalledTimes(1);
  });
  it('reports no consent for a missing pair or absent address', async () => {
    expect(await checkUserConsent(evm)).toEqual({ hasConsented: false, evmAddress: null, svmAddress: null, record: null });
    expect(await checkUserConsent('')).toEqual({ hasConsented: false, record: null });
  });
});
