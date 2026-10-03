import { sameCoins } from './amount';
import type { ChainEntry, Crossing, EntryCrowd, EntryCrowdCoverage, EntryCrowdRequest, Finding } from './types';

export const DEFAULT_ENTRY_MAX_BLOCKS = 1_152; // about one day at the 75-second target spacing
export const DEFAULT_ENTRY_MAX_TRANSACTIONS = 200;

export function boundedEntryWindow(request: EntryCrowdRequest, maxBlocks = DEFAULT_ENTRY_MAX_BLOCKS): [number, number] {
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) throw new Error('maxBlocks must be a positive integer');
  if (!Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.from < 0 || request.to < request.from) {
    throw new Error('Invalid entry crowd block window');
  }
  return [request.from, Math.min(request.to, request.from + maxBlocks - 1)];
}

/** Preserve each link's exact window; overlapping windows must not share a count. */
export function entryCrowdRequests(findings: Finding[], cs: Crossing[]): EntryCrowdRequest[] {
  const shields = new Map(cs.filter(c => c.kind === 'shield').map(c => [c.txid, c]));
  const exits = new Map(cs.filter(c => c.kind === 'deshield').map(c => [c.txid, c]));
  const requests = new Map<string, EntryCrowdRequest>();
  for (const f of findings) {
    if (!['round-trip', 'sum-match', 'quick-exit'].includes(f.rule)) continue;
    const exit = exits.get(f.links[0]?.to);
    const entries = f.links.map(l => shields.get(l.from));
    if (!exit || !entries.length || entries.some(e => !e)) continue;
    const from = Math.min(...entries.map(e => e!.height));
    if (exit.height < from) continue;
    for (const e of entries) {
      const request = { txid: e!.txid, amount: e!.amount, from, to: exit.height };
      requests.set(`${request.txid}:${from}:${request.to}`, request);
    }
  }
  return [...requests.values()];
}

/** A transaction counts once, regardless of its number of inputs, outputs or shielded pools. */
export function countEntryCrowd(
  request: EntryCrowdRequest, entries: ChainEntry[], coverage: EntryCrowdCoverage, excludeTxids: string[] = [],
): EntryCrowd {
  const excluded = new Set([request.txid, ...excludeTxids]);
  const seen = new Set<string>();
  let others = 0, timingOthers = 0;
  for (const e of entries) {
    if (!coverage.range || e.height < Math.max(request.from, coverage.range[0]) || e.height > Math.min(request.to, coverage.range[1])) continue;
    if (excluded.has(e.txid) || seen.has(e.txid) || !Number.isSafeInteger(e.amount) || e.amount <= 0) continue;
    seen.add(e.txid);
    timingOthers++;
    if (sameCoins(request.amount, e.amount)) others++;
  }
  return { ...request, others, timingOthers, coverage };
}

export function entryCrowdComplete(c: EntryCrowd): boolean {
  const v = c.coverage;
  return v.limits.length === 0 && v.errors.length === 0 && v.range !== null &&
    v.range[0] <= c.from && v.range[1] >= c.to && v.resolved === v.candidates;
}
