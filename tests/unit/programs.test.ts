import { describe, expect, it } from 'vitest';
import { getAddressEncoder } from '../../../app/node_modules/@solana/kit/dist/index.node.mjs';
import { decodeSongAccount, decodeLicenseRecordAccount, decodeRemixConfigAccount, buildSolanaBuyLicenseInstruction, buildSolanaRemixSongInstruction } from '../../../app/src/lib/programs';

const user = 'So11111111111111111111111111111111111111112';
const factory = 'EPKxVRtMaZbnoPgtpycYhXX7EGM3PzyCM36upmwJyenD';
const royalties = 'Gs7HCcMXgqfdQFyGdfggEsNTASiobu1T69kZJUXcRtWv';
const remix = '5miVCjgcGe85EKRjTNSc8rbcd8pF64GUDHPNtFqzEtHr';
const encoder = getAddressEncoder();

describe('program account layouts', () => {
  it('reads the 48-byte license record without an invented flag or timestamp', () => {
    const data = new Uint8Array(48);
    data[0] = 4;
    new DataView(data.buffer).setBigUint64(8, 7n, true);
    data.set(encoder.encode(user), 16);
    expect(decodeLicenseRecordAccount(data)).toEqual({ hasLicense: true, songId: 7n, user });
    expect(() => decodeLicenseRecordAccount(data.subarray(0, 47))).toThrow();
    data[0] = 2;
    expect(() => decodeLicenseRecordAccount(data)).toThrow();
  });

  it('accounts for total-remixes before the Remix configuration addresses', () => {
    const data = new Uint8Array(112);
    data[0] = 1;
    new DataView(data.buffer).setBigUint64(8, 25n, true);
    data.set(encoder.encode(user), 16);
    data.set(encoder.encode(factory), 48);
    data.set(encoder.encode(royalties), 80);
    expect(decodeRemixConfigAccount(data)).toEqual({ admin: user, factoryProgram: factory, royaltiesProgram: royalties });
    expect(() => decodeRemixConfigAccount(data.subarray(0, 104))).toThrow();
  });

  it('rejects truncated song data and out-of-bounds metadata', () => {
    const data = new Uint8Array(280);
    data[0] = 2;
    const view = new DataView(data.buffer);
    view.setUint16(4, 201, true);
    expect(() => decodeSongAccount(data)).toThrow();
    view.setUint16(4, 8, true);
    data.set(encoder.encode(user), 48);
    data.set(new TextEncoder().encode('ipfs://x'), 80);
    expect(decodeSongAccount(data).metadataUri).toBe('ipfs://x');
    expect(() => decodeSongAccount(data.subarray(0, 88))).toThrow();
  });

  it('builds the purchase discriminator and account order used by the program', () => {
    const instruction = buildSolanaBuyLicenseInstruction({ programId: remix, buyer: user, authority: remix, config: royalties, factoryProgram: factory, royaltiesProgram: royalties, factoryConfig: factory, song: user, license: user, consumer: remix, payerToken: user, creatorToken: user, treasuryToken: user, royaltiesConfig: royalties, songId: 9n });
    expect(instruction.data?.[0]).toBe(4);
    expect(new DataView(instruction.data!.buffer).getBigUint64(1, true)).toBe(9n);
    expect(instruction.accounts).toHaveLength(15);
    expect(instruction.accounts?.slice(0, 5).map(account => account.address)).toEqual([user, remix, royalties, factory, royalties]);
  });

  it('mints a licensed variation without payment accounts', () => {
    const instruction = buildSolanaRemixSongInstruction({ programId: remix, remixer: user, remixConfig: remix, remixAuthority: remix, factoryConfig: factory, originalSong: user, remixSong: factory, licenseRecord: user, remixConsumerAccount: remix, songRemixCountAccount: remix, remixRecordAccount: remix, factoryProgram: factory, originalSongId: 9n, licenseAmount: 2n, licensePrice: 3n, streamPrice: 4n, metadataUri: 'ipfs://variation' });
    expect(instruction.accounts).toHaveLength(12);
    expect(instruction.accounts?.map(account => account.address)).toEqual([user, remix, remix, factory, factory, user, factory, user, remix, remix, remix, '11111111111111111111111111111111']);
    expect(instruction.data?.[0]).toBe(1);
    const view = new DataView(instruction.data!.buffer);
    expect([1, 9, 17, 25].map(offset => view.getBigUint64(offset, true))).toEqual([9n, 2n, 3n, 4n]);
    expect(new TextDecoder().decode(instruction.data!.subarray(35))).toBe('ipfs://variation');
  });
});
