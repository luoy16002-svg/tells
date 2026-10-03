import type { CompactBlock, LightdInfo, Lightwalletd } from '../src/lightwalletd';

/** Public RPC payloads, projected to the compact fields the scanner uses. */
export interface Recording {
  recordedAt: string;
  server: string;
  info: LightdInfo;
  blocks: CompactBlock[];
  transactions: Record<string, string>;
}

export function replay(record: Recording): Lightwalletd {
  return {
    info: async () => record.info,
    async blocks(from, to) {
      const blocks = record.blocks.filter(b => b.height >= from && b.height <= to);
      if (blocks.length !== to - from + 1) throw new Error(`Fixture missing blocks ${from}–${to}`);
      return blocks;
    },
    async transaction(txid) {
      if (!record.transactions[txid]) throw new Error(`Fixture missing transaction ${txid}`);
      return Buffer.from(record.transactions[txid], 'hex');
    },
    close() {},
  };
}

export function recordingSource(source: Lightwalletd, record: Recording): Lightwalletd {
  return {
    info: () => source.info(),
    async blocks(from, to) {
      const blocks = await source.blocks(from, to);
      record.blocks = [...new Map([...record.blocks, ...blocks].map(b => [b.height, b])).values()].sort((a, b) => a.height - b.height);
      return blocks;
    },
    async transaction(txid) {
      const bytes = await source.transaction(txid);
      record.transactions[txid] = bytes.toString('hex');
      return bytes;
    },
    close: () => source.close(),
  };
}
