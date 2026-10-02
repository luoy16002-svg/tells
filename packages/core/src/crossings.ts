import { SHIELDED_POOLS as SHIELDED, type Crossing, type Flow, type Pool, type WalletTx } from './types';
const sum = (flows: Flow[], pools: Pool[]) => flows.filter(f => pools.includes(f.pool)).reduce((s, f) => s + f.value, 0);
const addrs = (flows: Flow[]) => [...new Set(flows.filter(f => f.pool === 'transparent' && f.address).map(f => f.address as string))];

/**
 * Turns the wallet's transactions into the crossings an outside observer can see.
 * Only mined transactions count: an unmined transaction has not revealed anything yet.
 */
export function crossings(txs: WalletTx[]): Crossing[] {
  const out: Crossing[] = [];
  for (const tx of txs) {
    if (tx.height == null || tx.time == null) continue;
    const base = { txid: tx.txid, time: tx.time, height: tx.height };
    const outputs = [...tx.received, ...tx.sent];

    const tIn = sum(tx.spent, ['transparent']);
    const tOut = sum(outputs, ['transparent']);
    const zIn = sum(tx.spent, SHIELDED);
    const zOut = sum(outputs, SHIELDED);

    if (zIn === 0 && zOut === 0) {
      // fully transparent: everything about it is public
      if (tIn > 0 || tOut > 0) {
        const value = sum(tx.sent, ['transparent']) || tOut;
        const c: Crossing = { ...base, kind: 'transparent', amount: value, from: 'transparent', to: 'transparent', addresses: addrs([...tx.spent, ...outputs]) };
        if (tIn === 0) c.incoming = true;
        out.push(c);
      }
      continue;
    }

    const intoShielded = zOut - zIn; // value balance seen from outside
    if (tIn > 0 && intoShielded > 0) {
      const to = dominant(outputs, SHIELDED);
      out.push({ ...base, kind: 'shield', amount: intoShielded, from: 'transparent', to, addresses: addrs(tx.spent) });
    }
    const outOfShielded = tOut - tIn;
    if (zIn > 0 && outOfShielded > 0) {
      const from = dominant(tx.spent, SHIELDED);
      out.push({ ...base, kind: 'deshield', amount: outOfShielded, from, to: 'transparent', addresses: addrs(outputs) });
    }

    // Between shielded pools each pool's value balance is public, so the moved amount is visible.
    const nets = SHIELDED.map(p => ({ p, net: sum(tx.spent, [p]) - sum(outputs, [p]) }));
    const losing = nets.filter(n => n.net > 0).sort((a, b) => b.net - a.net)[0];
    const gaining = nets.filter(n => n.net < 0).sort((a, b) => a.net - b.net)[0];
    if (losing && gaining) {
      out.push({ ...base, kind: 'migrate', amount: Math.min(losing.net, -gaining.net), from: losing.p, to: gaining.p, addresses: [] });
    }
  }
  return out.sort((a, b) => a.time - b.time || a.height - b.height);
}

function dominant(flows: Flow[], pools: Pool[]): Pool {
  let best: Pool = pools[pools.length - 1];
  let bestValue = -1;
  for (const p of pools) {
    const v = sum(flows, [p]);
    if (v > bestValue) { best = p; bestValue = v; }
  }
  return best;
}
