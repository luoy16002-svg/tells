// The checkup timeline: the public chain on top, the shielded pool below, crossings as arrows between them and
// the links an observer can draw as arcs above. Idle stretches are compressed so bursts of activity stay readable.
import { duration, zec, type Crossing, type Finding } from '@tells/core';

const TOP = 132;       // public lane
const POOL = 246;      // top edge of the shielded band
const BAND = 38;
const H = POOL + BAND + 52;
const LEFT = 26;

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const day = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const when = (t: number) => new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const START = LEFT + 96, END_PAD = 90, MIN_STEP = 24;

function layout(events: Crossing[], available: number) {
  // raw step per gap grows with the log of the idle time, then everything is scaled to fit the card when it can
  const raw = events.map((e, i) => {
    if (i === 0) return 0;
    const gap = e.time - events[i - 1].time;
    return gap <= 0 ? MIN_STEP : Math.min(170, MIN_STEP + 26 * Math.log2(1 + gap / 900));
  });
  const rawTotal = raw.reduce((a, b) => a + b, 0);
  const room = available - START - END_PAD;
  const k = rawTotal > room && rawTotal > 0 ? Math.max(room / rawTotal, 0) : 1;
  const xs: number[] = [];
  const breaks: { x: number; label: string }[] = [];
  let x = START;
  events.forEach((e, i) => {
    if (i > 0) {
      const w = Math.max(MIN_STEP, raw[i] * k);
      const gap = e.time - events[i - 1].time;
      if (gap > 12 * 3600) breaks.push({ x: x + w / 2, label: duration(gap) });
      x += w;
    }
    xs.push(x);
  });
  return { xs, width: Math.max(available, x + END_PAD), breaks };
}

/** Amount written upwards along an arrow, so neighbouring crossings never overlap. */
const vlabel = (x: number, y: number, text: string) => `<text class="amt" transform="translate(${x} ${y}) rotate(-90)">${esc(text)}</text>`;

export interface TimelineHandle { focus(index: number | null): void }

export function renderTimeline(el: HTMLElement, cs: Crossing[], findings: Finding[], planned: Crossing[] = [], hidden: { txid: string; time: number }[] = []): TimelineHandle {
  const priv: Crossing[] = hidden.filter(h => !cs.some(c => c.txid === h.txid)).map(h => ({ txid: h.txid, time: h.time, height: 0, kind: 'transparent', amount: 0, from: 'orchard', to: 'orchard', addresses: [], incoming: false, private: true } as Crossing & { private: boolean }));
  const events = [...cs, ...planned, ...priv].sort((a, b) => a.time - b.time || a.height - b.height);
  if (!events.length) {
    el.innerHTML = '<p class="empty">No crossings yet. A wallet that never touched the pool boundary has nothing to link.</p>';
    return { focus() {} };
  }
  const { xs, width, breaks } = layout(events, Math.max(320, Math.floor(el.clientWidth) - 2));
  const xOf = new Map(events.map((e, i) => [e.txid, xs[i]]));
  const parts: string[] = [];

  // lanes
  parts.push(`<rect class="pool-band" x="0" y="${POOL}" width="${width}" height="${BAND}" rx="6"/>`);
  parts.push(`<line class="lane" x1="0" x2="${width}" y1="${TOP}" y2="${TOP}"/>`);
  parts.push(`<text class="lane-label" x="${LEFT - 14}" y="${TOP - 10}">Public chain</text>`);
  parts.push(`<text class="lane-label" x="${LEFT - 14}" y="${POOL + BAND / 2 + 4}">Shielded pool</text>`);
  for (const b of breaks) {
    parts.push(`<line class="gapline" x1="${b.x}" x2="${b.x}" y1="${TOP + 8}" y2="${POOL - 6}"/>`);
    parts.push(`<text class="gapmark" x="${b.x}" y="${POOL + BAND + 42}" text-anchor="middle">${b.label}</text>`);
  }

  // dates under the band
  let lastDay = '';
  events.forEach((e, i) => {
    const d = day(e.time);
    if (d !== lastDay) { parts.push(`<text class="date" x="${xs[i]}" y="${POOL + BAND + 20}" text-anchor="middle">${d}</text>`); lastDay = d; }
  });

  // crossings
  events.forEach((e, i) => {
    const x = xs[i];
    const title = `<title>${esc(`${e.kind} ${zec(e.amount)} ZEC · ${when(e.time)} · ${e.txid.startsWith('planned') ? 'planned' : e.txid.slice(0, 16) + '…'}`)}</title>`;
    const isPlanned = e.txid.startsWith('planned');
    const cls = `ev ${e.kind}${isPlanned ? ' planned' : ''}${e.incoming ? ' incoming' : ''}`;
    if ((e as Crossing & { private?: boolean }).private) {
      parts.push(`<g class="ev private"><title>${esc(`shielded only · ${when(e.time)} · nothing public`)}</title><circle cx="${x}" cy="${POOL + BAND / 2}" r="4"/></g>`);
    } else if (e.kind === 'shield') {
      parts.push(`<g class="${cls}" tabindex="0">${title}<line class="shaft" x1="${x}" y1="${TOP + 4}" x2="${x}" y2="${POOL - 12}"/><path class="tip" d="M${x - 6} ${POOL - 13} L${x + 6} ${POOL - 13} L${x} ${POOL - 2} Z"/>${vlabel(x + 13, POOL - 16, zec(e.amount))}</g>`);
    } else if (e.kind === 'deshield') {
      parts.push(`<g class="${cls}" tabindex="0">${title}<line class="shaft" x1="${x}" y1="${POOL - 2}" x2="${x}" y2="${TOP + 14}"/><path class="tip" d="M${x - 6} ${TOP + 15} L${x + 6} ${TOP + 15} L${x} ${TOP + 3} Z"/>${vlabel(x + 13, POOL - 16, `${isPlanned ? 'planned ' : ''}${zec(e.amount)}`)}</g>`);
    } else if (e.kind === 'migrate') {
      const y = POOL + BAND / 2;
      parts.push(`<g class="${cls}" tabindex="0">${title}<line class="shaft" x1="${x - 12}" y1="${y}" x2="${x + 8}" y2="${y}"/><path class="tip" d="M${x + 7} ${y - 5} L${x + 15} ${y} L${x + 7} ${y + 5} Z"/><text class="amt" x="${x + 20}" y="${y + 4}">${e.from} → ${e.to} ${zec(e.amount)}</text></g>`);
    } else {
      parts.push(`<g class="${cls}" tabindex="0">${title}<circle cx="${x}" cy="${TOP}" r="5.5"/>${vlabel(x + 4, POOL - 16, `${e.incoming ? '+' : '→ '}${zec(e.amount)}`)}</g>`);
    }
  });

  // links
  const placed: { x: number; y: number }[] = [];
  findings.forEach((f, fi) => {
    f.links.forEach((l, li) => {
      const x1 = xOf.get(l.from), x2 = xOf.get(l.to);
      if (x1 == null || x2 == null || x1 === x2) return;
      const reuse = f.rule === 'address-reuse';
      const h = reuse ? 18 : Math.min(96, 24 + Math.abs(x2 - x1) * 0.3);
      const y = TOP - 6;
      parts.push(`<path class="arc${reuse ? ' reuse' : ''}" data-f="${fi}" data-s="${f.severity}" d="M${x1} ${y} C${x1} ${y - h} ${x2} ${y - h} ${x2} ${y}"/>`);
      if (li > 0) return; // one label per finding
      const a = events.find(e => e.txid === l.from)!, b = events.find(e => e.txid === l.to)!;
      const label = reuse ? 'same address' : f.rule === 'sum-match' ? 'sum' : duration(Math.abs(b.time - a.time));
      const lx = (x1 + x2) / 2;
      let ly = y - h * 0.75 - 4;
      while (placed.some(p => Math.abs(p.x - lx) < 80 && Math.abs(p.y - ly) < 14)) ly -= 14;
      placed.push({ x: lx, y: ly });
      parts.push(`<text class="arc-label" data-f="${fi}" x="${lx}" y="${ly}" text-anchor="middle" style="fill:var(--${f.severity})">${label}</text>`);
    });
  });

  el.innerHTML = `<svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img" aria-label="Timeline of ${events.length} public crossings">${parts.join('')}</svg>`;
  const svg = el.querySelector('svg')!;
  // start scrolled to the most recent activity
  el.scrollLeft = el.scrollWidth;
  return {
    focus(index) {
      svg.classList.toggle('focusing', index != null);
      svg.querySelectorAll<SVGElement>('[data-f]').forEach(n => n.classList.toggle('on', index != null && n.dataset.f === String(index)));
    },
  };
}
