// Crowd size: a link only identifies you if few other people did the same thing in the same window.
// With chain context (other people's exits read from compact blocks) each timing or amount link is graded
// against what else happened between the entry and the exit.
import { sameCoins } from './amount';
import { entryCrowdComplete, entryCrowdRequests } from './entry-crowd';
import type { ChainContext, Crossing, Finding, Severity } from './types';

const order: Severity[] = ['low', 'medium', 'high', 'critical'];
const lower = (s: Severity, by: number): Severity => order[Math.max(0, order.indexOf(s) - by)];
const covered = (ctx: ChainContext, from: number, to: number) => ctx.ranges.some(([a, b]) => a <= from && b >= to);

export function withCrowd(findings: Finding[], cs: Crossing[], ctx?: ChainContext): Finding[] {
  const adjusted = withExitCrowd(findings, cs, ctx);
  if (!ctx?.entryCrowds?.length) return adjusted;
  return adjusted.map((f, i) => {
    const requests = entryCrowdRequests([findings[i]], cs);
    const evidence = requests.flatMap(r => {
      const c = ctx.entryCrowds!.find(c => c.txid === r.txid && c.amount === r.amount && c.from === r.from && c.to === r.to);
      return c ? [c] : [];
    });
    if (!evidence.length) return f;
    const complete = evidence.length === requests.length && evidence.every(entryCrowdComplete);
    // For a sum match require evidence for every component. Do not multiply candidate counts.
    const others = complete ? Math.min(...evidence.map(c => f.rule === 'quick-exit' ? c.timingOthers : c.others)) : 0;
    const by = f.rule === 'quick-exit' ? (others >= 20 ? 2 : others >= 5 ? 1 : 0) : (others >= 5 ? 2 : others >= 1 ? 1 : 0);
    const entrySeverity = lower(findings[i].severity, by);
    const severity = order[Math.min(order.indexOf(f.severity), order.indexOf(entrySeverity))];
    // The exit-side count and adjustment stay intact. Use the stronger side, never add reductions.
    let detail = f.detail;
    if (!complete || evidence.some(c => c.others > 0)) detail = detail.replace(', so the pairing is unambiguous.', '.');
    if (!complete || evidence.some(c => c.timingOthers > 0)) detail = detail.replace(', so the timing alone points at you.', '.');
    return { ...f, severity, detail, entryCrowd: evidence };
  });
}

function withExitCrowd(findings: Finding[], cs: Crossing[], ctx?: ChainContext): Finding[] {
  if (!ctx) return findings;
  const byTx = new Map(cs.map(c => [c.txid, c]));
  return findings.map(f => {
    if (f.rule !== 'round-trip' && f.rule !== 'sum-match' && f.rule !== 'quick-exit') return f;
    const exit = byTx.get(f.links[0]?.to ?? '');
    const entries = f.links.map(l => byTx.get(l.from)).filter((c): c is Crossing => !!c);
    if (!exit || !entries.length) return f;
    const from = Math.min(...entries.map(e => e.height));
    const to = exit.height;
    if (!covered(ctx, from, to)) return f;
    const inWindow = ctx.exits.filter(x => x.height >= from && x.height <= to && x.txid !== exit.txid);
    if (f.rule === 'quick-exit') {
      const others = inWindow.length;
      const by = others >= 20 ? 2 : others >= 5 ? 1 : 0;
      const note = others
        ? ` On chain, ${others} other exit${others > 1 ? 's' : ''} happened between your entry and your exit, which ${by ? 'blurs' : 'barely blurs'} the timing.`
        : ' No one else left the pool between your entry and your exit, so the timing alone points at you.';
      return { ...f, severity: lower(f.severity, by), detail: f.detail + note, crowd: { others, from, to } };
    }
    const others = inWindow.filter(x => x.values.some(v => sameCoins(v, exit.amount))).length;
    const by = others >= 5 ? 2 : others >= 1 ? 1 : 0;
    const note = others
      ? ` On chain, ${others} other exit${others > 1 ? 's' : ''} of about the same amount happened in that window, so an observer has ${others + 1} candidates to choose from.`
      : ' No other exit of about this amount happened in that window, so the pairing is unambiguous.';
    return { ...f, severity: lower(f.severity, by), detail: f.detail + note, crowd: { others, from, to } };
  });
}
