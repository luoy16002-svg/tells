import { join } from 'node:path';
import {
  boundedEntryWindow, countEntryCrowd, DEFAULT_ENTRY_MAX_BLOCKS, DEFAULT_ENTRY_MAX_TRANSACTIONS,
  type ChainContext, type ChainEntry, type EntryCrowd, type EntryCrowdCoverage, type EntryCrowdRequest, type Network,
} from '@tells/core';
import { openLightwalletd, validateLightdInfo, type Lightwalletd } from './lightwalletd';
import { resolveEntry } from './transaction';
import { TransactionCache, type CacheStats } from './transaction-cache';

export interface EntryCrowdOptions {
  server?: string;
  cacheDir?: string;
  maxBlocks?: number;
  /** Includes candidate transactions AND their previous transactions, even on cache hits. */
  maxTransactions?: number;
  timeoutMs?: number;
  excludeTxids?: string[];
  /** Reuse compact coverage just read by chainContext. */
  context?: ChainContext;
  source?: Lightwalletd;
}
export interface EntryCrowdResult { crowds: EntryCrowd[]; entries: ChainEntry[]; cache: CacheStats }
class TransactionCap extends Error {}

export async function resolveEntryCrowds(network: Network, requests: EntryCrowdRequest[], options: EntryCrowdOptions = {}): Promise<EntryCrowdResult> {
  const maxBlocks = options.maxBlocks ?? DEFAULT_ENTRY_MAX_BLOCKS;
  const maxTransactions = options.maxTransactions ?? DEFAULT_ENTRY_MAX_TRANSACTIONS;
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1) throw new Error('maxTransactions must be a positive integer');
  // Validate options even when there is no work.
  boundedEntryWindow({ txid: '', amount: 0, from: 0, to: 0 }, maxBlocks);
  const result: EntryCrowdResult = { crowds: [], entries: [], cache: { fetched: 0, diskHits: 0, memoryHits: 0, bytesWritten: 0 } };
  if (!requests.length) return result;
  const source = options.source ?? openLightwalletd(network, options.server, options.timeoutMs);
  const cache = new TransactionCache(network, options.cacheDir ?? join(process.cwd(), '.tells-cache', 'transactions'), id => source.transaction(id));
  const context: ChainContext = { ranges: [...(options.context?.ranges ?? [])], entries: [...(options.context?.entries ?? [])], exits: [] };
  const observed = new Map<string, ChainEntry>();
  try {
    let infoError: string | undefined;
    try { validateLightdInfo(await source.info(), network); }
    catch (error) { infoError = message(error); }
    for (const request of requests) {
      const [from, to] = boundedEntryWindow(request, maxBlocks);
      const coverage: EntryCrowdCoverage = { range: null, candidates: 0, resolved: 0, transactions: 0, limits: [], errors: [] };
      if (to < request.to) coverage.limits.push('window');
      const entries: ChainEntry[] = [];
      const touched = new Set<string>();
      const get = (txid: string) => {
        if (!touched.has(txid)) {
          if (touched.size >= maxTransactions) throw new TransactionCap();
          touched.add(txid);
        }
        return cache.get(txid);
      };
      try {
        if (infoError) throw new Error(infoError);
        if (!context.ranges.some(([a, b]) => a <= from && b >= to)) {
          const blocks = await source.blocks(from, to);
          if (blocks.length !== to - from + 1 || blocks.some((b, i) => b.height !== from + i)) throw new Error('Incomplete compact block range');
          for (const b of blocks) for (const t of b.txs) {
            if (t.index !== 0 && t.vin.length && t.shieldedOutputs) context.entries.push({ txid: t.txid, height: b.height });
          }
          context.ranges.push([from, to]);
        }
        coverage.range = [from, to];
        const candidates = [...new Map(context.entries.filter(e => e.height >= from && e.height <= to).map(e => [e.txid, e])).values()]
          .sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid));
        coverage.candidates = candidates.length;
        for (const candidate of candidates) {
          try {
            const tx = await get(candidate.txid);
            const value = await resolveEntry(tx, get);
            coverage.resolved++;
            if (tx.vin.length && value.amount > 0) {
              const entry = { ...candidate, amount: value.amount };
              entries.push(entry);
              observed.set(entry.txid, entry);
            }
          } catch (error) {
            if (error instanceof TransactionCap) { coverage.limits.push('transactions'); break; }
            if (!coverage.limits.includes('unresolved')) coverage.limits.push('unresolved');
            coverage.errors.push(`${candidate.txid}: ${message(error)}`);
            // Stop repeatedly hitting a failing service. This remains an explicit incomplete count.
            if (coverage.errors.length >= 3) break;
          }
        }
      } catch (error) {
        coverage.limits.push('coverage');
        coverage.errors.push(message(error));
      }
      coverage.transactions = touched.size;
      result.crowds.push(countEntryCrowd(request, entries, coverage, options.excludeTxids));
    }
  } finally { if (!options.source) source.close(); }
  result.entries = [...observed.values()].sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid));
  result.cache = { ...cache.stats };
  return result;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
