import { describe, expect, it } from 'vitest';
import { MAX_TRANSACTION_BYTES, parseTransaction, resolveEntry } from '../src/transaction';
import { id, transaction } from './transactions';

describe('public transaction parser', () => {
  it.each([1, 2, 3, 4, 5, 6])('reads prevouts and outputs in v%i, including script lengths and txid byte order', version => {
    const vin = [{ txid: id(17), index: 1 }, { txid: id(258), index: 0 }];
    const vout = [123_456_789, 42];
    expect(parseTransaction(transaction({ version, vin, vout }))).toEqual({ version, vin, vout, shieldedBalance: 0 });
  });
  it('reads v4 Sapling and Sprout balances without mistaking a migration for shielding', () => {
    expect(parseTransaction(transaction({ version: 4, sapling: -2_000_000, sprout: 2_015_000, saplingSpends: 1 })).shieldedBalance).toBe(15_000);
  });
  it('reads Sapling with and without spends, Orchard and Ironwood, summing their signed balances', () => {
    for (const saplingSpends of [0, 1, 3]) {
      expect(parseTransaction(transaction({ version: 5, sapling: 10_000_000, orchard: -12_000_000, saplingSpends })).shieldedBalance).toBe(-2_000_000);
      expect(parseTransaction(transaction({ sapling: 10_000_000, orchard: 5_000_000, ironwood: -20_000_000, saplingSpends })).shieldedBalance).toBe(-5_000_000);
    }
  });
  it.each([2, 3])('reads old Sprout v%i previous transactions', version => {
    expect(parseTransaction(transaction({ version, sprout: -100_000 })).shieldedBalance).toBe(-100_000);
  });
  it('rejects truncated, oversized and trailing bytes', () => {
    const bytes = transaction({ ironwood: -100_000 });
    for (const n of [0, 3, 19, 30, bytes.length - 1]) expect(() => parseTransaction(bytes.subarray(0, n))).toThrow();
    expect(() => parseTransaction(Buffer.concat([bytes, Buffer.from([0])]))).toThrow('Trailing');
    expect(() => parseTransaction(Buffer.alloc(MAX_TRANSACTION_BYTES + 1))).toThrow('size limit');
  });
  it('rejects unknown groups, versions, impossible values and non-canonical lengths', () => {
    const group = transaction(); group.writeUInt32LE(1, 4);
    expect(() => parseTransaction(group)).toThrow('version group');
    const version = transaction(); version.writeUInt32LE(0x80000007, 0);
    expect(() => parseTransaction(version)).toThrow('Unsupported');
    expect(() => parseTransaction(transaction({ vout: [-1] }))).toThrow('out of range');
    const length = transaction();
    expect(() => parseTransaction(Buffer.concat([length.subarray(0, 20), Buffer.from([253, 1, 0]), length.subarray(21)]))).toThrow('Non-canonical');
  });
});

describe('resolved entry amount', () => {
  const parent = parseTransaction(transaction({ vout: [70_000_000, 30_000_000] }));
  const vin = [{ txid: id(1), index: 0 }, { txid: id(1), index: 1 }];
  it('resolves every previous output and subtracts transparent change and the actual fee', async () => {
    const tx = parseTransaction(transaction({ vin, vout: [20_000_000], ironwood: -79_850_000 }));
    expect(await resolveEntry(tx, async () => parent)).toEqual({ input: 100_000_000, output: 20_000_000, fee: 150_000, amount: 79_850_000 });
  });
  it('uses net pool value for mixed shielded/transparent spends', async () => {
    const tx = parseTransaction(transaction({ vin, orchard: 100_000_000, ironwood: -199_985_000 }));
    expect((await resolveEntry(tx, async () => parent)).amount).toBe(99_985_000);
  });
  it('does not count fee-only funding, dummy shielded outputs, or a net exit as an entry', async () => {
    const feeOnly = parseTransaction(transaction({ vin, vout: [99_985_000] }));
    expect((await resolveEntry(feeOnly, async () => parent)).amount).toBe(0);
    const mixedExit = parseTransaction(transaction({ vin, vout: [110_000_000], ironwood: 10_015_000 }));
    expect((await resolveEntry(mixedExit, async () => parent)).amount).toBe(0);
  });
  it('reports missing prevouts and failed requests instead of assigning a zero amount', async () => {
    const tx = parseTransaction(transaction({ vin: [{ txid: id(1), index: 2 }], ironwood: -1 }));
    await expect(resolveEntry(tx, async () => parent)).rejects.toThrow('Previous output');
    await expect(resolveEntry(tx, async () => { throw new Error('NOT_FOUND'); })).rejects.toThrow('NOT_FOUND');
  });
  it('rejects duplicate inputs, coinbase and negative inferred fees', async () => {
    await expect(resolveEntry(parseTransaction(transaction({ vin: [vin[0], vin[0]] })), async () => parent)).rejects.toThrow('duplicate');
    await expect(resolveEntry(parseTransaction(transaction({ vin: [{ txid: id(0), index: 0xffffffff }] })), async () => parent)).rejects.toThrow('Coinbase');
    await expect(resolveEntry(parseTransaction(transaction({ vin, ironwood: -100_000_001 })), async () => parent)).rejects.toThrow('fee');
  });
});
