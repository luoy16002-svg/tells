// Public transaction fields only. No key material or decryption is used.
// Layouts: protocol §7.1, https://zips.z.cash/zip-0225 and https://zips.z.cash/zip-0229.
export const MAX_TRANSACTION_BYTES = 2_000_000;
const MAX_MONEY = 21_000_000 * 100_000_000;

export interface Outpoint { txid: string; index: number }
export interface PublicTransaction {
  version: number;
  vin: Outpoint[];
  vout: number[];
  /** Sum of spends minus outputs in Sprout, Sapling, Orchard and Ironwood. */
  shieldedBalance: number;
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(n: number): Buffer {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.bytes.length - this.offset) throw new Error('Truncated transaction');
    const value = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  skip(n: number) { this.take(n); }
  u32() { return this.take(4).readUInt32LE(); }
  money(signed = false): number {
    const b = this.take(8);
    const n = signed ? b.readBigInt64LE() : b.readBigUInt64LE();
    if (n < BigInt(-MAX_MONEY) || n > BigInt(MAX_MONEY)) throw new Error('Transaction value out of range');
    return Number(n);
  }
  size(): number {
    const tag = this.take(1)[0];
    const value = tag < 253 ? BigInt(tag) : tag === 253 ? BigInt(this.take(2).readUInt16LE()) :
      tag === 254 ? BigInt(this.u32()) : this.take(8).readBigUInt64LE();
    if ((tag === 253 && value < 253n) || (tag === 254 && value <= 65535n) || (tag === 255 && value <= 0xffffffffn)) {
      throw new Error('Non-canonical CompactSize');
    }
    if (value > BigInt(MAX_TRANSACTION_BYTES)) throw new Error('CompactSize exceeds transaction limit');
    return Number(value);
  }
}

export function parseTransaction(bytes: Buffer): PublicTransaction {
  if (bytes.length > MAX_TRANSACTION_BYTES) throw new Error('Transaction exceeds size limit');
  const r = new Reader(bytes);
  const header = r.u32();
  const version = header & 0x7fffffff;
  const overwintered = (header >>> 31) === 1;
  const groups: Record<number, number> = { 3: 0x03c48270, 4: 0x892f2085, 5: 0x26a7270a, 6: 0xd884b698 };
  if (version < 1 || version > 6 || overwintered !== (version >= 3)) throw new Error(`Unsupported transaction header ${header.toString(16)}`);
  if (overwintered && r.u32() !== groups[version]) throw new Error(`Unsupported v${version} version group`);
  if (version >= 5) r.skip(12); // consensus branch, lock time, expiry height
  const vin: Outpoint[] = [];
  for (let n = r.size(); n > 0; n--) {
    const txid = Buffer.from(r.take(32)).reverse().toString('hex');
    const index = r.u32();
    r.skip(r.size()); // scriptSig
    r.skip(4); // sequence
    vin.push({ txid, index });
  }
  const vout: number[] = [];
  for (let n = r.size(); n > 0; n--) {
    vout.push(r.money());
    r.skip(r.size()); // scriptPubKey
  }
  let shieldedBalance = 0;
  if (version >= 5) {
    const spends = r.size();
    r.skip(spends * 96);
    const outputs = r.size();
    r.skip(outputs * 756);
    if (spends + outputs > 0) shieldedBalance += r.money(true);
    if (spends > 0) r.skip(32);
    r.skip(spends * (192 + 64) + outputs * 192);
    if (spends + outputs > 0) r.skip(64);
    const orchard = () => {
      const actions = r.size();
      if (actions === 0) return 0;
      r.skip(actions * 820);
      r.skip(1); // flags
      const balance = r.money(true);
      r.skip(32); // anchor
      r.skip(r.size()); // proofs
      r.skip(actions * 64 + 64);
      return balance;
    };
    shieldedBalance += orchard();
    if (version === 6) shieldedBalance += orchard();
  } else {
    r.skip(4); // lock time
    if (version >= 3) r.skip(4); // expiry height
    let sapling = false;
    if (version === 4) {
      shieldedBalance += r.money(true);
      const spends = r.size();
      r.skip(spends * 384);
      const outputs = r.size();
      r.skip(outputs * 948);
      sapling = spends + outputs > 0;
    }
    if (version >= 2) {
      const joins = r.size();
      for (let n = joins; n > 0; n--) {
        const old = r.money(), fresh = r.money();
        shieldedBalance += fresh - old;
        r.skip((version === 4 ? 1698 : 1802) - 16);
      }
      if (joins > 0) r.skip(32 + 64);
    }
    if (sapling) r.skip(64);
  }
  if (r.offset !== bytes.length) throw new Error('Trailing transaction data');
  if (!Number.isSafeInteger(shieldedBalance) || Math.abs(shieldedBalance) > MAX_MONEY) throw new Error('Shielded balance out of range');
  return { version, vin, vout, shieldedBalance };
}

/** Resolving prevouts distinguishes an actual net entry from change, mixed spends and fee funding. */
export async function resolveEntry(tx: PublicTransaction, previous: (txid: string) => Promise<PublicTransaction>): Promise<{ amount: number; input: number; output: number; fee: number }> {
  let input = 0;
  const seen = new Set<string>();
  for (const p of tx.vin) {
    const key = `${p.txid}:${p.index}`;
    if (p.txid === '0'.repeat(64) || seen.has(key)) throw new Error('Coinbase or duplicate transparent input');
    seen.add(key);
    const prev = await previous(p.txid);
    const value = prev.vout[p.index];
    if (value === undefined) throw new Error(`Previous output ${p.txid}:${p.index} is missing`);
    input += value;
  }
  const output = tx.vout.reduce((a, b) => a + b, 0);
  const fee = input - output + tx.shieldedBalance;
  if (![input, output, fee].every(n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_MONEY)) throw new Error('Invalid transparent balance or fee');
  return { amount: Math.max(0, -tx.shieldedBalance), input, output, fee };
}
