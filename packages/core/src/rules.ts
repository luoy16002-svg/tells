// The tells. Each rule looks only at what an outside observer can see: crossing amounts, block times and
// transparent addresses. Round-trip and timing rules follow Quesnelle (2017) and Kappos et al. (USENIX Security 2018).
import { distinctiveness, duration, roundDown, sameCoins, zec } from './amount';
import type { Crossing, Finding, Severity } from './types';

const HOUR = 3600;
const DAY = 86_400;
/** How far back an exit is compared with earlier entries. */
export const WINDOW = 30 * DAY;

const order: Severity[] = ['low', 'medium', 'high', 'critical'];
const bump = (s: Severity, by: number): Severity => order[Math.max(0, Math.min(3, order.indexOf(s) + by))];

function gapSeverity(gap: number): Severity {
  if (gap < 2 * HOUR) return 'critical';
  if (gap < DAY) return 'high';
  if (gap < 7 * DAY) return 'medium';
  return 'low';
}

const amountNote = (z: number) =>
  distinctiveness(z) === 'unique' ? `${zec(z)} ZEC has enough decimals to be close to unique on the chain` :
  distinctiveness(z) === 'notable' ? `${zec(z)} ZEC is an uncommon amount` : `${zec(z)} ZEC is a common amount, which helps a little`;

/** An exit whose amount matches an earlier entry: the classic round trip. */
export function roundTrips(cs: Crossing[]): Finding[] {
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const out of cs.filter(c => c.kind === 'deshield')) {
    const match = cs
      .filter(c => c.kind === 'shield' && c.time <= out.time && out.time - c.time <= WINDOW && sameCoins(c.amount, out.amount) && !used.has(c.txid))
      .sort((a, b) => b.time - a.time)[0];
    if (!match) continue;
    used.add(match.txid);
    const gap = out.time - match.time;
    let severity = gapSeverity(gap);
    const d = distinctiveness(out.amount);
    if (d === 'unique') severity = bump(severity, 1);
    if (d === 'common' && severity !== 'critical') severity = bump(severity, -1);
    findings.push({
      rule: 'round-trip',
      severity,
      title: `Round trip: ${zec(match.amount)} ZEC in, ${zec(out.amount)} ZEC out ${duration(gap)} later`,
      detail: `Anyone can pair these two public crossings by amount and time, which links the address that funded the shielded pool to the address that received the exit. ${amountNote(out.amount)}.`,
      txids: [match.txid, out.txid],
      links: [{ from: match.txid, to: out.txid }],
      fixes: [
        `Leave a different amount: a round sum such as ${zec(roundDown(out.amount) || out.amount)} ZEC, and keep the rest shielded.`,
        `Wait longer between entering and leaving the pool${gap < 7 * DAY ? ' (days, not hours)' : ''}.`,
        'Pay shielded addresses directly where the recipient accepts them, so nothing leaves the pool.',
      ],
    });
  }
  return findings;
}

/** An exit that equals the sum of two or three recent entries (a split round trip). */
export function sumMatches(cs: Crossing[], alreadyLinked: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const out of cs.filter(c => c.kind === 'deshield' && !alreadyLinked.has(c.txid))) {
    const ins = cs.filter(c => c.kind === 'shield' && c.time <= out.time && out.time - c.time <= WINDOW).slice(-12);
    let hit: Crossing[] | null = null;
    for (let i = 0; i < ins.length && !hit; i++) {
      for (let j = i + 1; j < ins.length && !hit; j++) {
        if (sameCoins(ins[i].amount + ins[j].amount, out.amount)) hit = [ins[i], ins[j]];
        for (let k = j + 1; k < ins.length && !hit; k++) {
          if (sameCoins(ins[i].amount + ins[j].amount + ins[k].amount, out.amount)) hit = [ins[i], ins[j], ins[k]];
        }
      }
    }
    if (!hit) continue;
    const gap = out.time - hit[0].time;
    const severity = distinctiveness(out.amount) === 'common' ? bump(gapSeverity(gap), -1) : gapSeverity(gap);
    findings.push({
      rule: 'sum-match',
      severity,
      title: `Exit of ${zec(out.amount)} ZEC equals ${hit.length} earlier entries combined`,
      detail: `${hit.map(h => zec(h.amount)).join(' + ')} ZEC went in and the same total came out ${duration(out.time - hit[hit.length - 1].time)} after the last of them. Splitting the entry does not hide a matching exit.`,
      txids: [...hit.map(h => h.txid), out.txid],
      links: hit.map(h => ({ from: h.txid, to: out.txid })),
      fixes: ['Take out an amount that does not add up to recent entries.', 'Spread exits over time instead of emptying what you just put in.'],
    });
  }
  return findings;
}

/** An exit soon after an entry, with no amount match: timing alone shrinks the crowd. */
export function quickExits(cs: Crossing[], alreadyLinked: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const out of cs.filter(c => c.kind === 'deshield' && !alreadyLinked.has(c.txid))) {
    const prev = cs.filter(c => c.kind === 'shield' && c.time <= out.time && out.time - c.time < DAY).pop();
    if (!prev) continue;
    const gap = out.time - prev.time;
    findings.push({
      rule: 'quick-exit',
      severity: gap < HOUR ? 'high' : 'medium',
      title: `Left the pool ${duration(gap)} after entering`,
      detail: `Few people enter and leave the shielded pool within the same ${gap < HOUR ? 'hour' : 'day'}, so the timing alone narrows down who this exit belongs to, even though the amounts differ.`,
      txids: [prev.txid, out.txid],
      links: [{ from: prev.txid, to: out.txid }],
      fixes: ['Let shielded funds sit for days before moving them out.', 'Avoid entering and leaving at the same time of day.'],
    });
  }
  return findings;
}

/** Amounts with many decimals act as fingerprints when they cross the pool boundary. */
export function distinctiveAmounts(cs: Crossing[], alreadyLinked: Set<string>): Finding[] {
  const hits = cs.filter(c => (c.kind === 'shield' || c.kind === 'deshield') && distinctiveness(c.amount) === 'unique' && !alreadyLinked.has(c.txid));
  if (!hits.length) return [];
  return [{
    rule: 'distinctive-amount',
    severity: hits.length > 2 ? 'medium' : 'low',
    title: `${hits.length} crossing${hits.length > 1 ? 's' : ''} with fingerprint amounts`,
    detail: `${hits.slice(0, 4).map(h => `${zec(h.amount)} ZEC`).join(', ')}${hits.length > 4 ? ' and more' : ''}. An amount with four or more decimals is easy to search for on the public side, and any later exit near it will stand out.`,
    txids: hits.map(h => h.txid),
    links: [],
    fixes: ['Shield and deshield round amounts (0.5, 1, 2.5 ZEC) and leave the odd remainder shielded.'],
  }];
}

/**
 * The same transparent address receiving coins more than once (or being the exit destination more than once)
 * ties those transactions together publicly. Shielding coins from the address that just received them is the
 * normal path into the pool and does not count as reuse.
 */
export function addressReuse(cs: Crossing[]): Finding[] {
  const byAddr = new Map<string, Crossing[]>();
  for (const c of cs) {
    const arrives = (c.kind === 'transparent' && c.incoming) || c.kind === 'deshield' || (c.kind === 'transparent' && !c.incoming);
    if (!arrives) continue;
    for (const a of c.addresses) byAddr.set(a, [...(byAddr.get(a) ?? []), c]);
  }
  const findings: Finding[] = [];
  for (const [addr, list] of byAddr) {
    if (list.length < 2) continue;
    const exits = list.filter(c => c.kind === 'deshield').length;
    findings.push({
      rule: 'address-reuse',
      severity: exits >= 2 || list.length >= 4 ? 'medium' : 'low',
      title: `Transparent address reused ${list.length} times`,
      detail: `${addr.slice(0, 10)}…${addr.slice(-6)} received coins on ${list.length} public transactions, so they are linked to each other regardless of what happens inside the pool.`,
      txids: list.map(c => c.txid),
      links: list.slice(1).map((c, i) => ({ from: list[i].txid, to: c.txid })),
      fixes: ['Use a fresh transparent address each time (most wallets rotate them automatically).', 'For exchanges, use the TEX address they give you rather than reusing an old one.'],
    });
  }
  return findings;
}

/** Fully transparent transactions publish sender, receiver and amount. */
export function transparentOnly(cs: Crossing[]): Finding[] {
  const hits = cs.filter(c => c.kind === 'transparent' && !c.incoming);
  if (!hits.length) return [];
  return [{
    rule: 'transparent-only',
    severity: hits.length >= 3 ? 'medium' : 'low',
    title: `${hits.length} fully transparent payment${hits.length > 1 ? 's' : ''}`,
    detail: 'These never touched a shielded pool: amounts, senders and receivers are all public, just like Bitcoin.',
    txids: hits.map(h => h.txid),
    links: [],
    fixes: ['Shield transparent funds once, then pay from the shielded balance.'],
  }];
}

/** Moving value between shielded pools publishes the amount; moving everything at once publishes the balance. */
export function migrations(cs: Crossing[]): Finding[] {
  const hits = cs.filter(c => c.kind === 'migrate');
  if (!hits.length) return [];
  return [{
    rule: 'migration-reveal',
    severity: 'low',
    title: `${hits.length} pool migration${hits.length > 1 ? 's' : ''} with a public amount`,
    detail: `Moves between shielded pools (${[...new Set(hits.map(h => `${h.from} to ${h.to}`))].join(', ')}) show their amount: ${hits.slice(0, 3).map(h => zec(h.amount) + ' ZEC').join(', ')}. It does not link you to a transparent address, but a one-shot migration of a whole balance tells observers how much the wallet held.`,
    txids: hits.map(h => h.txid),
    links: [],
    fixes: ['Migrate in a few smaller steps, or let your wallet move funds as you spend.'],
  }];
}
