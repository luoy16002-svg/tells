import './style.css';
import { analyze, preflight, zec, ZAT, type Crossing, type Finding, type History, type Report } from '@tells/core';
import { carefulUser, exchangeUser } from './samples';
import { renderTimeline, type TimelineHandle } from './timeline';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

interface Sample { id: string; title: string; history: History }
const samples: Sample[] = [
  { id: 'exchange', title: 'Exchange regular', history: exchangeUser },
  { id: 'careful', title: 'Careful saver', history: carefulUser },
];

let current: History = exchangeUser;
let report: Report = analyze(current);
let planned: Crossing[] = [];
let plannedFindings: Finding[] = [];
let timeline: TimelineHandle = { focus() {} };

function renderTabs(activeId: string) {
  $('samples').innerHTML = samples.map(s => `<button role="tab" aria-selected="${s.id === activeId}" data-id="${s.id}">${esc(s.title)}</button>`).join('');
}

function renderGrade(r: Report) {
  const counts = (['critical', 'high', 'medium', 'low'] as const).map(s => [s, r.findings.filter(f => f.severity === s).length] as const).filter(([, n]) => n);
  $('grade').innerHTML = `
    <span class="letter" data-g="${r.grade}" aria-label="Grade ${r.grade}">${r.grade}</span>
    <div><div class="label">${esc(r.label ?? 'Your wallet')}</div><div style="color:var(--muted);font-size:14px">${r.network === 'main' ? 'Mainnet' : r.network === 'test' ? 'Testnet' : 'Regtest'} · score ${r.score}/100</div></div>
    <div class="sevbar">${counts.length ? counts.map(([s, n]) => `<span class="chip" data-s="${s}">${n} ${s}</span>`).join('') : '<span class="chip">no tells</span>'}</div>
    <dl>
      <dt>Transactions</dt><dd>${r.stats.txs}</dd>
      <dt>Into the pool</dt><dd>${r.stats.shields}</dd>
      <dt>Out of the pool</dt><dd>${r.stats.deshields}</dd>
      <dt>Pool migrations</dt><dd>${r.stats.migrations}</dd>
    </dl>`;
}

// testnet.zcashexplorer.app stopped indexing in September 2026; ZecBlock follows the current testnet
const EXPLORER: Record<string, string> = { main: 'https://mainnet.zcashexplorer.app/transactions/', test: 'https://testnet.zecblock.com/tx/' };
/** Real txids link to a block explorer so anyone can check the finding on chain. */
function txLink(t: string) {
  if (t.startsWith('planned')) return 'planned withdrawal';
  const short = esc(t.slice(0, 16)) + '…';
  const base = EXPLORER[current.network];
  return /^[0-9a-f]{64}$/.test(t) && base ? `<a href="${base}${t}" target="_blank" rel="noopener">${short}</a>` : short;
}

function findingHtml(f: Finding, i: number) {
  return `<article class="card finding" data-s="${f.severity}" data-i="${i}" tabindex="0">
    <span class="chip" data-s="${f.severity}">${f.severity}</span>
    <h3>${esc(f.title)}</h3>
    <p>${esc(f.detail)}</p>
    <div class="fix"><b>Fix</b> · ${esc(f.fixes[0])}</div>
    ${f.crowd ? `<div class="txs">On chain: ${f.crowd.others} look-alike exit${f.crowd.others === 1 ? '' : 's'} in blocks ${f.crowd.from}–${f.crowd.to}</div>` : ''}
    <div class="txs">${f.txids.map(txLink).join('  ·  ')}</div>
  </article>`;
}

/** Mined transactions that left nothing public: shielded-to-shielded activity. */
const hiddenTxs = () => current.txs.filter(t => t.time != null && t.height != null).map(t => ({ txid: t.txid, time: t.time as number }));

function renderAll() {
  renderGrade(report);
  const all = [...report.findings, ...plannedFindings];
  timeline = renderTimeline($('timeline'), report.crossings, all, planned, hiddenTxs());
  $('findings').innerHTML = report.findings.length
    ? report.findings.map(findingHtml).join('')
    : '<div class="card empty">No tells. Nothing on the public side links these crossings together.</div>';
}

function load(h: History, tabId?: string) {
  current = h;
  report = analyze(h);
  planned = [];
  plannedFindings = [];
  renderTabs(tabId ?? '');
  renderAll();
  presetPreflight();
  $('verdict').innerHTML = '<p class="hint">Try the amount that went into the pool most recently, then the same amount a week later.</p>';
}

// ---- pre-flight ----
const toLocalInput = (t: number) => {
  const d = new Date(t * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function presetPreflight() {
  const last = report.crossings[report.crossings.length - 1];
  const lastShield = [...report.crossings].reverse().find(c => c.kind === 'shield');
  const lastTime = Math.max(...current.txs.map(t => t.time ?? 0));
  $<HTMLInputElement>('pamount').value = lastShield ? zec(lastShield.amount - 10_000) : '1';
  $<HTMLInputElement>('pwhen').value = toLocalInput((lastTime || last?.time || Date.now() / 1000) + 3600);
  $<HTMLInputElement>('pto').value = '';
}

$('preform').addEventListener('submit', e => {
  e.preventDefault();
  const amount = Math.round(Number($<HTMLInputElement>('pamount').value.replace(',', '.')) * ZAT);
  const time = Math.floor(new Date($<HTMLInputElement>('pwhen').value).getTime() / 1000);
  const address = $<HTMLInputElement>('pto').value.trim() || undefined;
  if (!amount || !time) return;
  const p = preflight(current, { amount, time, address });
  planned = [{ txid: 'planned', time, height: Number.MAX_SAFE_INTEGER, kind: 'deshield', amount, from: 'orchard', to: 'transparent', addresses: address ? [address] : [] }];
  plannedFindings = p.findings;
  renderAll();
  const label = { safe: 'SAFE TO SEND', caution: 'CAUTION', risky: 'RISKY' }[p.verdict];
  $('verdict').innerHTML = `
    <span class="pill" data-v="${p.verdict}">${label}</span>
    ${p.findings.length ? p.findings.map(f => `<div><span class="chip" data-s="${f.severity}">${f.severity}</span> <b>${esc(f.title)}</b><p class="hint" style="margin-top:6px">${esc(f.detail)}</p></div>`).join('') : '<p class="hint">Nothing in this wallet\'s history pairs with this withdrawal.</p>'}
    ${p.alternatives.length ? `<div class="alts"><b>Safer ways to do it</b>${p.alternatives.map(a => `<div class="alt"><b>${esc(a.title)}</b><span>${esc(a.why)}</span></div>`).join('')}</div>` : ''}
    <p class="hint">The dashed arrow on the timeline above is this withdrawal.</p>`;
});

// ---- tabs, hover ----
$('samples').addEventListener('click', e => {
  const id = (e.target as HTMLElement).closest('button')?.dataset.id;
  const s = samples.find(x => x.id === id);
  if (s) load(s.history, s.id);
});
const findingsEl = $('findings');
const focusFrom = (e: Event) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.finding');
  timeline.focus(card ? Number(card.dataset.i) : null);
};
findingsEl.addEventListener('mouseover', focusFrom);
findingsEl.addEventListener('focusin', focusFrom);
findingsEl.addEventListener('mouseleave', () => timeline.focus(null));
findingsEl.addEventListener('focusout', () => timeline.focus(null));

// ---- own wallet ----
function readFile(file: File) {
  const err = $('droperr');
  err.hidden = true;
  file.text().then(text => {
    const h = JSON.parse(text) as History;
    if (!h || !Array.isArray(h.txs)) throw new Error('This file is not a Tells history (expected a "txs" list). Create one with `tells scan ... --out history.json`.');
    load({ ...h, label: h.label ?? file.name }, 'yours');
    $('checkup').scrollIntoView();
  }).catch(e => { err.textContent = e instanceof Error ? e.message : String(e); err.hidden = false; });
}
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files[0]; if (f) readFile(f); });
$<HTMLInputElement>('file').addEventListener('change', e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) readFile(f); });
$('copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('cmd').textContent ?? '').then(() => { $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy command'), 1500); });
});

// a real testnet wallet, when the sample file is present
fetch('./samples/testnet.json').then(r => (r.ok ? r.json() : null)).then((h: History | null) => {
  if (!h) return;
  samples.unshift({ id: 'testnet', title: 'Testnet wallet (real)', history: h });
  renderTabs(current === exchangeUser ? 'exchange' : '');
}).catch(() => {});

load(exchangeUser, 'exchange');

// keep the timeline fitted to its card
let lastWidth = 0;
new ResizeObserver(entries => {
  const w = Math.round(entries[0].contentRect.width);
  if (Math.abs(w - lastWidth) > 24) { lastWidth = w; timeline = renderTimeline($('timeline'), report.crossings, [...report.findings, ...plannedFindings], planned, hiddenTxs()); }
}).observe($('timeline'));
