// Reads other people's pool-boundary activity from lightwalletd compact blocks (the same blocks a light wallet
// downloads), for the block windows of the links a checkup found. Only exit amounts are needed: compact blocks
// carry transparent output values, and a transaction with shielded data, transparent outputs and no
// transparent inputs can only have paid those outputs out of a shielded pool.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import type { ChainContext, Crossing, Finding, Network } from '@tells/core';

const SERVERS: Record<string, string> = { main: 'zec.rocks:443', test: 'testnet.zec.rocks:443' };
const MAX_BLOCKS = 20_000;

function protoDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, 'proto'), join(here, '..', 'proto')]) if (existsSync(join(p, 'service.proto'))) return p;
  throw new Error('lightwalletd protocol files not found');
}

/** Block windows worth reading: from the earliest entry of each timing or amount link to its exit. */
export function windowsFor(findings: Finding[], cs: Crossing[]): [number, number][] {
  const byTx = new Map(cs.map(c => [c.txid, c]));
  const raw: [number, number][] = [];
  for (const f of findings) {
    if (f.rule !== 'round-trip' && f.rule !== 'sum-match' && f.rule !== 'quick-exit') continue;
    const exit = byTx.get(f.links[0]?.to ?? '');
    const from = Math.min(...f.links.map(l => byTx.get(l.from)?.height ?? Infinity));
    if (exit && Number.isFinite(from)) raw.push([from, exit.height]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  let budget = MAX_BLOCKS;
  return merged.filter(([a, b]) => (budget -= b - a + 1) >= 0);
}

export async function chainContext(network: Network, windows: [number, number][], server?: string): Promise<ChainContext> {
  const ctx: ChainContext = { ranges: [], exits: [], entries: [] };
  if (!windows.length) return ctx;
  const dir = protoDir();
  const def = loader.loadSync(join(dir, 'service.proto'), { includeDirs: [dir], keepCase: true, longs: Number, enums: String, defaults: true });
  const rpc = (grpc.loadPackageDefinition(def) as any).cash.z.wallet.sdk.rpc;
  const client = new rpc.CompactTxStreamer(server ?? SERVERS[network] ?? SERVERS.main, grpc.credentials.createSsl());
  try {
    for (const [start, end] of windows) {
      await new Promise<void>((resolve, reject) => {
        const stream = client.GetBlockRange({ start: { height: start }, end: { height: end }, poolTypes: ['TRANSPARENT', 'SAPLING', 'ORCHARD', 'IRONWOOD'] });
        stream.on('data', (b: any) => {
          for (const t of b.vtx) {
            if (Number(t.index) === 0) continue; // coinbase
            const txid = Buffer.from(t.txid).reverse().toString('hex');
            const shielded = t.spends.length + t.outputs.length + t.actions.length + (t.ironwoodActions?.length ?? 0) > 0;
            if (!shielded) continue;
            if (t.vout.length && !t.vin.length) ctx.exits.push({ height: Number(b.height), txid, values: t.vout.map((o: any) => Number(o.value)) });
            else if (t.vin.length && (t.outputs.length || t.actions.length || t.ironwoodActions?.length)) ctx.entries.push({ height: Number(b.height), txid });
          }
        });
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
      ctx.ranges.push([start, end]);
    }
  } finally {
    client.close();
  }
  return ctx;
}
