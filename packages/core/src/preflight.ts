// Pre-flight: check a withdrawal before it is broadcast, and propose safer ways to make it.
import { roundDown, zec } from './amount';
import { findingsFor } from './analyze';
import { crossings } from './crossings';
import type { Crossing, Finding, History, Pool } from './types';

export interface PlannedExit {
  /** Value that would arrive at the transparent address, in zats. */
  amount: number;
  /** When it would be mined (unix seconds). */
  time: number;
  address?: string;
  pool?: Pool;
}

export interface Step { amount: number; notBefore: number }
export interface Alternative { title: string; why: string; steps: Step[] }
export type Verdict = 'safe' | 'caution' | 'risky';

export interface Preflight {
  verdict: Verdict;
  findings: Finding[];
  alternatives: Alternative[];
}

const PLANNED = 'planned';
const HOUR = 3600, DAY = 86_400;
const WAITS = [6 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

function evaluate(base: Crossing[], steps: Step[], plan: PlannedExit): Finding[] {
  const extra: Crossing[] = steps.map((s, i) => ({
    txid: i === 0 ? PLANNED : `${PLANNED}-${i}`,
    time: s.notBefore,
    height: Number.MAX_SAFE_INTEGER - steps.length + i,
    kind: 'deshield',
    amount: s.amount,
    from: plan.pool ?? 'orchard',
    to: 'transparent',
    addresses: plan.address ? [plan.address] : [],
  }));
  const all = [...base, ...extra].sort((a, b) => a.time - b.time || a.height - b.height);
  return findingsFor(all)
    .filter(f => f.txids.some(t => t.startsWith(PLANNED)))
    .map(f => f.rule !== 'distinctive-amount' ? f : {
      ...f,
      title: 'The withdrawal amount is a fingerprint',
      detail: `${extra.map(e => zec(e.amount)).join(' and ')} ZEC has enough decimals to stand out on the public side.`,
      txids: f.txids.filter(t => t.startsWith(PLANNED)),
    });
}

function verdictOf(findings: Finding[]): Verdict {
  if (findings.some(f => f.severity === 'critical' || f.severity === 'high')) return 'risky';
  if (findings.some(f => f.severity === 'medium')) return 'caution';
  return 'safe';
}

export function preflight(history: History, plan: PlannedExit): Preflight {
  const base = crossings(history.txs);
  const findings = evaluate(base, [{ amount: plan.amount, notBefore: plan.time }], plan);
  const verdict = verdictOf(findings);
  const alternatives: Alternative[] = [];
  if (verdict === 'safe') return { verdict, findings, alternatives };

  // 1. same amount, later: the first wait that clears every high or critical tell
  for (const w of WAITS) {
    const steps = [{ amount: plan.amount, notBefore: plan.time + w }];
    const v = verdictOf(evaluate(base, steps, plan));
    if (v !== 'risky') {
      alternatives.push({ title: `Send ${zec(plan.amount)} ZEC ${later(plan.time, plan.time + w)}`, why: v === 'safe' ? 'By then no entry pairs with this exit.' : 'Waiting removes the strong links; a weak timing hint remains.', steps });
      break;
    }
  }

  // 2. a round amount now; a small remainder stays shielded, a large one goes later
  const part = roundDown(plan.amount);
  if (part > 0 && part < plan.amount) {
    const rest = plan.amount - part;
    if (rest <= plan.amount * 0.25 && verdictOf(evaluate(base, [{ amount: part, notBefore: plan.time }], plan)) !== 'risky') {
      alternatives.push({
        title: `Send ${zec(part)} ZEC now and keep ${zec(rest)} ZEC shielded`,
        why: 'A round amount is shared by many users and no longer mirrors what went in. The remainder can stay in the pool.',
        steps: [{ amount: part, notBefore: plan.time }],
      });
    } else {
      for (const w of WAITS) {
        const steps = [{ amount: part, notBefore: plan.time }, { amount: rest, notBefore: plan.time + w }];
        if (verdictOf(evaluate(base, steps, plan)) !== 'risky') {
          alternatives.push({
            title: `Send ${zec(part)} ZEC now and ${zec(rest)} ZEC ${later(plan.time, plan.time + w)}`,
            why: 'A round amount is shared by many users, and splitting breaks the match with what went in.',
            steps,
          });
          break;
        }
      }
    }
  }

  // 3. a fresh transparent address when the destination has been used before
  if (findings.some(f => f.rule === 'address-reuse')) {
    alternatives.push({ title: 'Use a fresh transparent address', why: 'The destination already appears on your earlier crossings and links them to this one.', steps: [{ amount: plan.amount, notBefore: plan.time }] });
  }
  return { verdict, findings, alternatives };
}

/** "in 6 h (Oct 3, 03:00 UTC)" or "in 7 days (Oct 9)". */
function later(from: number, to: number) {
  const d = new Date(to * 1000);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const wait = to - from;
  if (wait < 2 * DAY) return `in ${Math.round(wait / HOUR)} h (${date}, ${d.toISOString().slice(11, 16)} UTC)`;
  return `in ${Math.round(wait / DAY)} days (${date})`;
}
