// Data model. All values are in zatoshis (1 ZEC = 100,000,000 zats); times are unix seconds.

export type Pool = 'transparent' | 'sapling' | 'orchard' | 'ironwood';
export const SHIELDED_POOLS: Pool[] = ['sapling', 'orchard', 'ironwood'];
export type Network = 'main' | 'test' | 'regtest';

export const ZAT = 100_000_000;

/** Value moving through one pool, as the wallet's viewing key sees it. */
export interface Flow {
  pool: Pool;
  value: number;
  /** Transparent address that held or received the coins. Shielded addresses are never needed. */
  address?: string;
  change?: boolean;
}

/** One transaction of the wallet. */
export interface WalletTx {
  txid: string;
  height: number | null;
  time: number | null;
  fee: number | null;
  /** Wallet coins consumed by the transaction. */
  spent: Flow[];
  /** Outputs paid back to this wallet, including change. */
  received: Flow[];
  /** Outputs paid to anyone else. */
  sent: Flow[];
}

/**
 * What everyone else did at the pool boundary, read from the compact blocks a light wallet downloads.
 * Used to size the crowd a link hides in; optional.
 */
export interface ChainContext {
  /** Block ranges (inclusive) that were read. A link is only graded against blocks inside these. */
  ranges: [number, number][];
  /** Transactions that sent shielded value to transparent outputs: height and output values (zats). */
  exits: { height: number; txid: string; values: number[] }[];
  /** Transactions that moved transparent inputs into a shielded pool (amounts are not in compact blocks). */
  entries: { height: number; txid: string }[];
  /** Optional, separately measured entry crowds. Old exports retain their original scoring. */
  entryCrowds?: EntryCrowd[];
}

/** Inclusive block window, the same comparison window used by the link rules. */
export interface EntryCrowdRequest {
  txid: string;
  amount: number;
  from: number;
  to: number;
}

/** Net value added to all shielded pools, after transparent change and the fee. */
export interface ChainEntry {
  txid: string;
  height: number;
  amount: number;
}

export type EntryCrowdLimit = 'window' | 'transactions' | 'coverage' | 'unresolved';

export interface EntryCrowdCoverage {
  /** Blocks actually inspected; null when no complete range was available. */
  range: [number, number] | null;
  /** Candidate transactions in the inspected range, including the wallet's own. */
  candidates: number;
  /** Candidates whose full transactions and all previous outputs were resolved. */
  resolved: number;
  /** Unique full transactions touched, including previous transactions and cache hits. */
  transactions: number;
  limits: EntryCrowdLimit[];
  errors: string[];
}

/** Counts are lower bounds if coverage is incomplete, and then cannot reduce severity. */
export interface EntryCrowd extends EntryCrowdRequest {
  others: number;
  timingOthers: number;
  coverage: EntryCrowdCoverage;
}

export interface History {
  network: Network;
  label?: string;
  txs: WalletTx[];
  chain?: ChainContext;
}

/**
 * A value crossing that anyone reading the chain can see:
 * - shield: transparent coins entering a shielded pool
 * - deshield: shielded coins leaving to a transparent address
 * - migrate: value moving between shielded pools, e.g. Sapling to Orchard (the amount is public)
 * - transparent: a transaction that never touched a shielded pool
 */
export type CrossingKind = 'shield' | 'deshield' | 'migrate' | 'transparent';

export interface Crossing {
  txid: string;
  time: number;
  height: number;
  kind: CrossingKind;
  amount: number;
  from: Pool;
  to: Pool;
  /** Transparent addresses on the public side of the crossing. */
  addresses: string[];
  /** A transparent payment into the wallet (it spent nothing). Public, but it is how coins arrive, not a spend. */
  incoming?: boolean;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type RuleId =
  | 'round-trip'
  | 'sum-match'
  | 'quick-exit'
  | 'distinctive-amount'
  | 'address-reuse'
  | 'transparent-only'
  | 'migration-reveal';

export interface Finding {
  rule: RuleId;
  severity: Severity;
  title: string;
  detail: string;
  txids: string[];
  /** Crossing pairs or groups that the finding links together, for drawing. */
  links: { from: string; to: string }[];
  fixes: string[];
  /** Other people's crossings that look the same in the window of the link; absent when unknown. */
  crowd?: { others: number; from: number; to: number };
  /** Entry-side evidence, one measurement for each component of the link. */
  entryCrowd?: EntryCrowd[];
}

export interface Report {
  network: Network;
  label?: string;
  crossings: Crossing[];
  findings: Finding[];
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  stats: { txs: number; shields: number; deshields: number; migrations: number; transparentOnly: number };
}
