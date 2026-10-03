import type { Outpoint } from '../src/transaction';

const zero = (n: number) => Buffer.alloc(n);
const u32 = (n: number) => { const b = zero(4); b.writeUInt32LE(n); return b; };
const i64 = (n: number) => { const b = zero(8); b.writeBigInt64LE(BigInt(n)); return b; };
const size = (n: number) => n < 253 ? Buffer.from([n]) : Buffer.concat([Buffer.from([254]), u32(n)]);
export const id = (n: number) => n.toString(16).padStart(64, '0');

export function transaction({ version = 6, vin = [], vout = [], sapling = 0, orchard = 0, ironwood = 0, sprout = 0, saplingSpends = 0 }: {
  version?: number; vin?: Outpoint[]; vout?: number[]; sapling?: number; orchard?: number; ironwood?: number; sprout?: number; saplingSpends?: number;
} = {}): Buffer {
  const parts = [u32(version >= 3 ? version + 0x80000000 : version)];
  if (version >= 3) parts.push(u32(({ 3: 0x03c48270, 4: 0x892f2085, 5: 0x26a7270a, 6: 0xd884b698 } as Record<number, number>)[version]));
  if (version >= 5) parts.push(u32(0x37a5165b), zero(8));
  parts.push(size(vin.length));
  for (const p of vin) parts.push(Buffer.from(p.txid, 'hex').reverse(), u32(p.index), Buffer.from([2, 0, 0]), u32(0xffffffff));
  parts.push(size(vout.length));
  for (const v of vout) parts.push(i64(v), Buffer.from([3, 0x76, 0xa9, 0x88]));
  const bundle = (balance: number) => balance === 0 ? Buffer.from([0]) : Buffer.concat([
    Buffer.from([1]), zero(820), Buffer.from([3]), i64(balance), zero(32), Buffer.from([0]), zero(64 + 64),
  ]);
  if (version >= 5) {
    const outputs = sapling !== 0 ? 1 : 0;
    parts.push(size(saplingSpends), zero(saplingSpends * 96), size(outputs), zero(outputs * 756));
    if (saplingSpends + outputs) parts.push(i64(sapling));
    if (saplingSpends) parts.push(zero(32));
    parts.push(zero(saplingSpends * 256 + outputs * 192));
    if (saplingSpends + outputs) parts.push(zero(64));
    parts.push(bundle(orchard));
    if (version === 6) parts.push(bundle(ironwood));
  } else {
    parts.push(zero(4));
    if (version >= 3) parts.push(zero(4));
    if (version === 4) parts.push(i64(sapling), size(saplingSpends), zero(saplingSpends * 384), size(sapling ? 1 : 0), zero(sapling ? 948 : 0));
    if (version >= 2) {
      parts.push(size(sprout ? 1 : 0));
      if (sprout) parts.push(i64(sprout < 0 ? -sprout : 0), i64(sprout > 0 ? sprout : 0), zero((version === 4 ? 1698 : 1802) - 16), zero(96));
    }
    if (version === 4 && (sapling || saplingSpends)) parts.push(zero(64));
  }
  return Buffer.concat(parts);
}
