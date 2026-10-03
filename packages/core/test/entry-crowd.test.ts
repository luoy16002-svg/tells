import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analyze, boundedEntryWindow, countEntryCrowd, entryCrowdComplete, entryCrowdRequests, findingsFor, withCrowd,
  type ChainContext, type ChainEntry, type Crossing, type EntryCrowd, type EntryCrowdCoverage, type EntryCrowdRequest, type History,
} from '../src';
import { carefulUser, exchangeUser } from '../../../apps/web/src/samples';

const request: EntryCrowdRequest = { txid: 'own', amount: 12_345_678, from: 100, to: 110 };
const coverage = (extra: Partial<EntryCrowdCoverage> = {}): EntryCrowdCoverage => ({ range: [100, 110], candidates: 1, resolved: 1, transactions: 2, limits: [], errors: [], ...extra });
const crowd = (others = 0, extra: Partial<EntryCrowd> = {}): EntryCrowd => ({ ...request, others, timingOthers: others, coverage: coverage(), ...extra });
const entry = (txid: string, height: number, amount = request.amount): ChainEntry => ({ txid, height, amount });
const cs: Crossing[] = [
  { txid: 'own', height: 100, time: 1000, kind: 'shield', amount: request.amount, from: 'transparent', to: 'orchard', addresses: [] },
  { txid: 'exit', height: 110, time: 1500, kind: 'deshield', amount: request.amount - 10_000, from: 'orchard', to: 'transparent', addresses: [] },
];
const trip = findingsFor(cs).filter(f => f.rule === 'round-trip');
const ctx = (entryCrowds: EntryCrowd[], exits: ChainContext['exits'] = []): ChainContext => ({ ranges: [[100, 110]], entries: [], exits, entryCrowds });

describe('entry windows and matching', () => {
  it('uses inclusive edges and counts each other transaction once', () => {
    const entries = [entry('left', 100), entry('right', 110), entry('left', 100), entry('before', 99), entry('after', 111), entry('own', 105), entry('wallet', 106)];
    expect(countEntryCrowd(request, entries, coverage(), ['wallet'])).toMatchObject({ others: 2, timingOthers: 2 });
  });
  it('uses the exact fee-floor tolerance, including equality on both sides', () => {
    const entries = [-100_001, -100_000, 100_000, 100_001].map((delta, i) => entry(String(i), 105, request.amount + delta));
    expect(countEntryCrowd(request, entries, coverage())).toMatchObject({ others: 2, timingOthers: 4 });
  });
  it('uses the symmetric, rounded 0.1% tolerance for large amounts', () => {
    const large = { ...request, amount: 1_000_000_000 };
    const entries = [entry('edge', 105, 1_001_001_001), entry('outside', 105, 1_001_001_002)];
    expect(countEntryCrowd(large, entries, coverage()).others).toBe(1);
    expect(countEntryCrowd({ ...large, amount: 1_001_001_001 }, [entry('reverse', 105, large.amount)], coverage()).others).toBe(1);
  });
  it('excludes non-entries and observations outside the actually inspected range', () => {
    const entries = [entry('zero', 100, 0), entry('negative', 100, -1), entry('invalid', 100, NaN), entry('early', 100), entry('late', 110)];
    expect(countEntryCrowd(request, entries, coverage({ range: [100, 101] })).others).toBe(1);
    expect(countEntryCrowd(request, entries, coverage({ range: null })).others).toBe(0);
  });
  it('caps at exactly maxBlocks, including a one-block window', () => {
    expect(boundedEntryWindow(request, 11)).toEqual([100, 110]);
    expect(boundedEntryWindow(request, 10)).toEqual([100, 109]);
    expect(boundedEntryWindow(request, 1)).toEqual([100, 100]);
    expect(boundedEntryWindow({ ...request, to: 100 }, 1)).toEqual([100, 100]);
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects an invalid window cap %s', max => {
    expect(() => boundedEntryWindow(request, max)).toThrow();
  });
  it('rejects reversed or nonintegral windows', () => {
    expect(() => boundedEntryWindow({ ...request, to: 99 })).toThrow();
    expect(() => boundedEntryWindow({ ...request, from: 1.5 })).toThrow();
  });
  it('keeps counts for different link windows separate', () => {
    const later = { ...cs[1], txid: 'later', time: 1600, height: 115, amount: 9_000_000 };
    const requests = entryCrowdRequests(findingsFor([...cs, later]), [...cs, later]);
    expect(requests.map(r => [r.from, r.to])).toEqual([[100, 110], [100, 115]]);
  });
});

describe('entry severity adjustment', () => {
  it.each([[0, 'critical'], [1, 'high'], [4, 'high'], [5, 'medium'], [20, 'medium']] as const)('uses the exit amount scale for %i look-alikes', (n, severity) => {
    expect(withCrowd(trip, cs, ctx([crowd(n)]))[0].severity).toBe(severity);
  });
  it.each([[0, 'high'], [4, 'high'], [5, 'medium'], [19, 'medium'], [20, 'low']] as const)('uses the timing scale for %i entries of any amount', (n, severity) => {
    const quickCs = [cs[0], { ...cs[1], amount: 9_000_000 }];
    const quick = findingsFor(quickCs).filter(f => f.rule === 'quick-exit');
    expect(withCrowd(quick, quickCs, ctx([crowd(0, { timingOthers: n })]))[0].severity).toBe(severity);
  });
  it('uses the stronger side without adding reductions, and preserves the exit count', () => {
    const exits = [{ txid: 'other-exit', height: 105, values: [cs[1].amount] }];
    const result = withCrowd(trip, cs, ctx([crowd(1)], exits))[0];
    expect(result.severity).toBe('high');
    expect(result.crowd).toEqual({ others: 1, from: 100, to: 110 });
    expect(withCrowd(trip, cs, ctx([crowd(5)], exits))[0].severity).toBe('medium');
  });
  it('does not claim an unambiguous pairing when similar entries exist', () => {
    expect(withCrowd(trip, cs, ctx([crowd(1)]))[0].detail).not.toContain('unambiguous');
  });
  it.each(['window', 'transactions', 'coverage', 'unresolved'] as const)('does not reduce severity for a %s-limited count', limit => {
    const evidence = crowd(50, { coverage: coverage({ limits: [limit] }) });
    expect(entryCrowdComplete(evidence)).toBe(false);
    const result = withCrowd(trip, cs, ctx([evidence]))[0];
    expect(result.severity).toBe('critical');
    expect(result.entryCrowd).toEqual([evidence]);
  });
  it('requires full coverage and resolution even if no limit flag was supplied', () => {
    for (const v of [coverage({ range: null }), coverage({ range: [100, 109] }), coverage({ resolved: 0 }), coverage({ errors: ['missing prevout'] })]) {
      expect(entryCrowdComplete(crowd(5, { coverage: v }))).toBe(false);
    }
  });
  it('does not reuse a count with a different amount or window', () => {
    expect(withCrowd(trip, cs, ctx([crowd(5, { to: 111 })]))[0].entryCrowd).toBeUndefined();
    expect(withCrowd(trip, cs, ctx([crowd(5, { amount: request.amount + 1 })]))[0].entryCrowd).toBeUndefined();
  });
  it('requires all sum-match components and uses the least crowded component', () => {
    const sumCs = [cs[0], { ...cs[0], txid: 'own2', amount: 20_000_000, time: 1100, height: 101 }, { ...cs[1], amount: request.amount + 20_000_000 }];
    const sum = findingsFor(sumCs).filter(f => f.rule === 'sum-match');
    expect(sum).toHaveLength(1);
    const evidence = [crowd(5), crowd(1, { txid: 'own2', amount: 20_000_000 })];
    expect(withCrowd(sum, sumCs, ctx(evidence))[0].severity).toBe('high');
    expect(withCrowd(sum, sumCs, ctx(evidence.slice(0, 1)))[0].severity).toBe('critical');
  });
  it('does not need exit coverage for complete entry evidence', () => {
    expect(withCrowd(trip, cs, { ...ctx([crowd(5)]), ranges: [] })[0].severity).toBe('medium');
  });
});

describe('existing samples', () => {
  it('matches every pre-change report, including all exit evidence and finding text', () => {
    const before = JSON.parse(readFileSync(new URL('./fixtures/sample-reports.before.json', import.meta.url), 'utf8'));
    for (const file of ['demo/illustrative-careful.json', 'demo/illustrative-exchange.json', 'apps/web/public/samples/testnet.json']) {
      const history = JSON.parse(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')) as History;
      expect(analyze(history)).toEqual(before[file]);
    }
    expect(analyze(carefulUser)).toEqual(before['web/carefulUser']);
    expect(analyze(exchangeUser)).toEqual(before['web/exchangeUser']);
  });
});
