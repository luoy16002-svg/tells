// Reads other people's pool-boundary activity from lightwalletd compact blocks (the same blocks a light wallet
// downloads), for the block windows of the links a checkup found. Only exit amounts are needed: compact blocks
// carry transparent output values, and a transaction with shielded data, transparent outputs and no
// transparent inputs can only have paid those outputs out of a shielded pool.
import type { ChainContext, Crossing, Finding, Network } from '@tells/core';
import { openLightwalletd, type Lightwalletd } from './lightwalletd';

const MAX_BLOCKS = 20_000;

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

export async function chainContext(network: Network, windows: [number, number][], server?: string, source?: Lightwalletd): Promise<ChainContext> {
  const ctx: ChainContext = { ranges: [], exits: [], entries: [] };
  if (!windows.length) return ctx;
  const client = source ?? openLightwalletd(network, server);
  try {
    for (const [start, end] of windows) {
      for (const b of await client.blocks(start, end)) for (const t of b.txs) {
        if (t.index === 0 || !t.shielded) continue;
        if (t.vout.length && !t.vin.length) ctx.exits.push({ height: b.height, txid: t.txid, values: t.vout });
        else if (t.vin.length && t.shieldedOutputs) ctx.entries.push({ height: b.height, txid: t.txid });
      }
      ctx.ranges.push([start, end]);
    }
  } finally {
    if (!source) client.close();
  }
  return ctx;
}
