import { crossings } from './crossings';
import { addressReuse, distinctiveAmounts, migrations, quickExits, roundTrips, sumMatches, transparentOnly } from './rules';
import type { Crossing, Finding, History, Report, Severity } from './types';

const WEIGHT: Record<Severity, number> = { critical: 30, high: 18, medium: 8, low: 3 };
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function findingsFor(cs: Crossing[]): Finding[] {
  const trips = roundTrips(cs);
  const linked = new Set(trips.flatMap(f => f.txids));
  const sums = sumMatches(cs, linked);
  sums.forEach(f => f.txids.forEach(t => linked.add(t)));
  const exitsLinked = new Set([...linked]);
  return [
    ...trips,
    ...sums,
    ...quickExits(cs, exitsLinked),
    ...distinctiveAmounts(cs, linked),
    ...addressReuse(cs),
    ...transparentOnly(cs),
    ...migrations(cs),
  ].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export function score(findings: Finding[]): { score: number; grade: Report['grade'] } {
  const penalty = findings.reduce((s, f) => s + WEIGHT[f.severity], 0);
  const value = Math.max(0, 100 - penalty);
  const grade = value >= 90 ? 'A' : value >= 75 ? 'B' : value >= 55 ? 'C' : value >= 35 ? 'D' : 'F';
  return { score: value, grade };
}

/** Full checkup of a wallet history. Runs anywhere: browser, Node, a wallet's own process. */
export function analyze(history: History): Report {
  const cs = crossings(history.txs);
  const findings = findingsFor(cs);
  return {
    network: history.network,
    label: history.label,
    crossings: cs,
    findings,
    ...score(findings),
    stats: {
      txs: history.txs.length,
      shields: cs.filter(c => c.kind === 'shield').length,
      deshields: cs.filter(c => c.kind === 'deshield').length,
      migrations: cs.filter(c => c.kind === 'migrate').length,
      transparentOnly: cs.filter(c => c.kind === 'transparent').length,
    },
  };
}
