import { describe, expect, it } from 'vitest';
import { analyze, crossings, preflight, ZAT, type Flow, type History, type WalletTx } from '../src';

const T0 = 1_790_000_000;
const MIN = 60, HOUR = 3600, DAY = 86_400;
const z = (zecAmount: number) => Math.round(zecAmount * ZAT);
let h = 3_000_000;

function tx(id: string, time: number, spent: Flow[], received: Flow[], sent: Flow[] = []): WalletTx {
  return { txid: id, height: h++, time, fee: 10_000, spent, received, sent };
}
const t = (v: number, address = 'tmExchangeHot1') => ({ pool: 'transparent' as const, value: z(v), address });
const o = (v: number, change = false) => ({ pool: 'orchard' as const, value: z(v), change });
const s = (v: number) => ({ pool: 'sapling' as const, value: z(v) });
const hist = (...txs: WalletTx[]): History => ({ network: 'test', txs });

describe('crossings', () => {
  it('reads shields, deshields, migrations and transparent-only transactions', () => {
    const cs = crossings([
      tx('shield', T0, [t(1)], [o(0.9999)]),
      tx('deshield', T0 + DAY, [o(0.9999)], [o(0.4998, true)], [t(0.5, 'tmShop')]),
      tx('migrate', T0 + 2 * DAY, [s(2)], [o(1.9999)]),
      tx('plain', T0 + 3 * DAY, [t(0.3, 'tmA')], [t(0.1999, 'tmA')], [t(0.1, 'tmB')]),
    ]);
    expect(cs.map(c => [c.kind, c.amount])).toEqual([
      ['shield', z(0.9999)],
      ['deshield', z(0.5)],
      ['migrate', z(1.9999)],
      ['transparent', z(0.1)],
    ]);
    expect(cs[1].addresses).toEqual(['tmShop']);
  });

  it('ignores transactions that are not mined', () => {
    expect(crossings([{ ...tx('pending', T0, [t(1)], [o(0.9999)]), height: null, time: null }])).toEqual([]);
  });
});

describe('rules', () => {
  it('flags a fast round trip with a distinctive amount as critical', () => {
    const r = analyze(hist(
      tx('in', T0, [t(0.12345678)], [o(0.12335678)]),
      tx('out', T0 + 30 * MIN, [o(0.12335678)], [], [t(0.12325678, 'tmOut')]),
    ));
    const trip = r.findings.find(f => f.rule === 'round-trip')!;
    expect(trip.severity).toBe('critical');
    expect(trip.links).toEqual([{ from: 'in', to: 'out' }]);
    expect(r.grade).not.toBe('A');
  });

  it('treats a slow round trip of a round amount as a weak hint', () => {
    const r = analyze(hist(
      tx('in', T0, [t(1.0001)], [o(1)]),
      tx('out', T0 + 3 * DAY, [o(1)], [], [t(0.9999, 'tmOut')]),
    ));
    expect(r.findings.find(f => f.rule === 'round-trip')!.severity).toBe('low');
  });

  it('finds an exit that equals two entries combined', () => {
    const r = analyze(hist(
      tx('a', T0, [t(0.3001)], [o(0.3)]),
      tx('b', T0 + HOUR, [t(0.45679, 'tmExchangeHot2')], [o(0.45678)]),
      tx('out', T0 + 5 * HOUR, [o(0.3), o(0.45678)], [], [t(0.75668, 'tmOut')]),
    ));
    const sum = r.findings.find(f => f.rule === 'sum-match')!;
    expect(sum.txids).toEqual(['a', 'b', 'out']);
  });

  it('flags a quick exit when the amounts do not match', () => {
    const r = analyze(hist(
      tx('in', T0, [t(1.0001)], [o(1)]),
      tx('out', T0 + 20 * MIN, [o(1)], [o(0.6299, true)], [t(0.37, 'tmOut')]),
    ));
    expect(r.findings.map(f => [f.rule, f.severity])).toContainEqual(['quick-exit', 'high']);
  });

  it('links crossings that share a transparent address', () => {
    const r = analyze(hist(
      tx('in', T0, [t(5.0001)], [o(5)]),
      tx('out1', T0 + 9 * DAY, [o(5)], [o(3.9999, true)], [t(1, 'tmSame')]),
      tx('out2', T0 + 20 * DAY, [o(3.9999)], [o(2.9998, true)], [t(1, 'tmSame')]),
    ));
    const reuse = r.findings.find(f => f.rule === 'address-reuse')!;
    expect(reuse.txids).toEqual(['out1', 'out2']);
    expect(reuse.severity).toBe('medium');
  });

  it('does not call receive-then-shield from one address reuse', () => {
    const r = analyze(hist(
      tx('recv', T0, [], [t(2, 'tmOnce')]),
      tx('in', T0 + HOUR, [t(2, 'tmOnce')], [o(1.9999)]),
    ));
    expect(r.findings.filter(f => f.rule === 'address-reuse')).toEqual([]);
  });

  it('gives a clean history an A', () => {
    const r = analyze(hist(
      tx('in', T0, [t(2.5001)], [o(2.5)]),
      tx('pay', T0 + 2 * DAY, [o(2.5)], [o(1.7499, true)], [o(0.75)]),
      tx('out', T0 + 12 * DAY, [o(1.7499)], [o(0.7498, true)], [t(1, 'tmFresh')]),
    ));
    expect(r.findings).toEqual([]);
    expect(r.grade).toBe('A');
  });
});

describe('preflight', () => {
  const history = hist(tx('in', T0, [t(0.54321)], [o(0.54311)]));

  it('marks an exit that mirrors a recent entry as risky and offers safer plans', () => {
    const p = preflight(history, { amount: z(0.5431), time: T0 + HOUR });
    expect(p.verdict).toBe('risky');
    expect(p.findings[0].rule).toBe('round-trip');
    expect(p.alternatives.length).toBeGreaterThanOrEqual(2);
    for (const alt of p.alternatives) {
      const total = alt.steps.reduce((sum, st) => sum + st.amount, 0);
      // either the full amount, or a round part with the remainder kept shielded
      if (alt.title.includes('keep')) expect(total).toBeLessThan(z(0.5431));
      else expect(total).toBe(z(0.5431));
    }
  });

  it('every proposed plan really is safer', () => {
    const p = preflight(history, { amount: z(0.5431), time: T0 + HOUR });
    for (const alt of p.alternatives) {
      const later = alt.steps.reduce((acc, st, i) => {
        const r = preflight(acc.h, { amount: st.amount, time: st.notBefore });
        acc.worst = acc.worst === 'risky' || r.verdict === 'risky' ? 'risky' : r.verdict;
        acc.h = hist(...acc.h.txs, tx(`step${i}`, st.notBefore, [o(st.amount)], [], [t(st.amount, `tmStep${i}`)]));
        return acc;
      }, { h: history, worst: 'safe' as string });
      expect(later.worst).not.toBe('risky');
    }
  });

  it('passes a withdrawal that links to nothing', () => {
    expect(preflight(history, { amount: z(0.2), time: T0 + 10 * DAY }).verdict).toBe('safe');
  });
});
