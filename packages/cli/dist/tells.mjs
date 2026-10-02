#!/usr/bin/env node
import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/main.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// ../core/src/types.ts
var SHIELDED_POOLS = ["sapling", "orchard", "ironwood"];
var ZAT = 1e8;

// ../core/src/amount.ts
function zec(zats) {
  const sign = zats < 0 ? "-" : "";
  const abs = Math.abs(Math.round(zats));
  const whole = Math.floor(abs / ZAT);
  const frac = String(abs % ZAT).padStart(8, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? "." + frac : ""}`;
}
function decimals(zats) {
  const frac = String(Math.abs(Math.round(zats)) % ZAT).padStart(8, "0").replace(/0+$/, "");
  return frac.length;
}
function distinctiveness(zats) {
  const nearest = Math.round(zats / 1e6) * 1e6;
  if (nearest > 0 && Math.abs(zats - nearest) <= 5e4) return "common";
  const d = decimals(zats);
  if (d <= 2) return "common";
  if (d <= 3) return "notable";
  return "unique";
}
function sameCoins(a, b) {
  const tol = Math.max(1e5, Math.round(Math.max(a, b) * 1e-3));
  return Math.abs(a - b) <= tol;
}
var DENOMS = [1e6, 25e5, 5e6, 1e7, 25e6, 5e7, 1e8, 2e8, 5e8, 1e9, 25e8, 5e9, 1e10];
function roundDown(zats) {
  let best = 0;
  for (const d of DENOMS) {
    if (d > zats) break;
    const m = Math.floor(zats / d) * d;
    if (decimals(m) <= 2 && m > best && (m >= zats * 0.6 || best === 0)) best = m;
  }
  return best;
}
function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36e3 ? 1 : 0)} h`;
  return `${(s / 86400).toFixed(s < 864e3 ? 1 : 0)} days`;
}

// ../core/src/crossings.ts
var sum = (flows, pools) => flows.filter((f) => pools.includes(f.pool)).reduce((s, f) => s + f.value, 0);
var addrs = (flows) => [...new Set(flows.filter((f) => f.pool === "transparent" && f.address).map((f) => f.address))];
function crossings(txs) {
  const out = [];
  for (const tx of txs) {
    if (tx.height == null || tx.time == null) continue;
    const base = { txid: tx.txid, time: tx.time, height: tx.height };
    const outputs = [...tx.received, ...tx.sent];
    const tIn = sum(tx.spent, ["transparent"]);
    const tOut = sum(outputs, ["transparent"]);
    const zIn = sum(tx.spent, SHIELDED_POOLS);
    const zOut = sum(outputs, SHIELDED_POOLS);
    if (zIn === 0 && zOut === 0) {
      if (tIn > 0 || tOut > 0) {
        const value = sum(tx.sent, ["transparent"]) || tOut;
        const c2 = { ...base, kind: "transparent", amount: value, from: "transparent", to: "transparent", addresses: addrs([...tx.spent, ...outputs]) };
        if (tIn === 0) c2.incoming = true;
        out.push(c2);
      }
      continue;
    }
    const intoShielded = zOut - zIn;
    if (tIn > 0 && intoShielded > 0) {
      const to = dominant(outputs, SHIELDED_POOLS);
      out.push({ ...base, kind: "shield", amount: intoShielded, from: "transparent", to, addresses: addrs(tx.spent) });
    }
    const outOfShielded = tOut - tIn;
    if (zIn > 0 && outOfShielded > 0) {
      const from = dominant(tx.spent, SHIELDED_POOLS);
      out.push({ ...base, kind: "deshield", amount: outOfShielded, from, to: "transparent", addresses: addrs(outputs) });
    }
    const nets = SHIELDED_POOLS.map((p) => ({ p, net: sum(tx.spent, [p]) - sum(outputs, [p]) }));
    const losing = nets.filter((n) => n.net > 0).sort((a, b) => b.net - a.net)[0];
    const gaining = nets.filter((n) => n.net < 0).sort((a, b) => a.net - b.net)[0];
    if (losing && gaining) {
      out.push({ ...base, kind: "migrate", amount: Math.min(losing.net, -gaining.net), from: losing.p, to: gaining.p, addresses: [] });
    }
  }
  return out.sort((a, b) => a.time - b.time || a.height - b.height);
}
function dominant(flows, pools) {
  let best = pools[pools.length - 1];
  let bestValue = -1;
  for (const p of pools) {
    const v = sum(flows, [p]);
    if (v > bestValue) {
      best = p;
      bestValue = v;
    }
  }
  return best;
}

// ../core/src/rules.ts
var HOUR = 3600;
var DAY = 86400;
var WINDOW = 30 * DAY;
var order = ["low", "medium", "high", "critical"];
var bump = (s, by) => order[Math.max(0, Math.min(3, order.indexOf(s) + by))];
function gapSeverity(gap) {
  if (gap < 2 * HOUR) return "critical";
  if (gap < DAY) return "high";
  if (gap < 7 * DAY) return "medium";
  return "low";
}
var amountNote = (z) => distinctiveness(z) === "unique" ? `${zec(z)} ZEC has enough decimals to be close to unique on the chain` : distinctiveness(z) === "notable" ? `${zec(z)} ZEC is an uncommon amount` : `${zec(z)} ZEC is a common amount, which helps a little`;
function roundTrips(cs) {
  const findings = [];
  const used = /* @__PURE__ */ new Set();
  for (const out of cs.filter((c2) => c2.kind === "deshield")) {
    const match = cs.filter((c2) => c2.kind === "shield" && c2.time <= out.time && out.time - c2.time <= WINDOW && sameCoins(c2.amount, out.amount) && !used.has(c2.txid)).sort((a, b) => b.time - a.time)[0];
    if (!match) continue;
    used.add(match.txid);
    const gap = out.time - match.time;
    let severity = gapSeverity(gap);
    const d = distinctiveness(out.amount);
    if (d === "unique") severity = bump(severity, 1);
    if (d === "common" && severity !== "critical") severity = bump(severity, -1);
    findings.push({
      rule: "round-trip",
      severity,
      title: `Round trip: ${zec(match.amount)} ZEC in, ${zec(out.amount)} ZEC out ${duration(gap)} later`,
      detail: `Anyone can pair these two public crossings by amount and time, which links the address that funded the shielded pool to the address that received the exit. ${amountNote(out.amount)}.`,
      txids: [match.txid, out.txid],
      links: [{ from: match.txid, to: out.txid }],
      fixes: [
        `Leave a different amount: a round sum such as ${zec(roundDown(out.amount) || out.amount)} ZEC, and keep the rest shielded.`,
        `Wait longer between entering and leaving the pool${gap < 7 * DAY ? " (days, not hours)" : ""}.`,
        "Pay shielded addresses directly where the recipient accepts them, so nothing leaves the pool."
      ]
    });
  }
  return findings;
}
function sumMatches(cs, alreadyLinked) {
  const findings = [];
  for (const out of cs.filter((c2) => c2.kind === "deshield" && !alreadyLinked.has(c2.txid))) {
    const ins = cs.filter((c2) => c2.kind === "shield" && c2.time <= out.time && out.time - c2.time <= WINDOW).slice(-12);
    let hit = null;
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
    const severity = distinctiveness(out.amount) === "common" ? bump(gapSeverity(gap), -1) : gapSeverity(gap);
    findings.push({
      rule: "sum-match",
      severity,
      title: `Exit of ${zec(out.amount)} ZEC equals ${hit.length} earlier entries combined`,
      detail: `${hit.map((h) => zec(h.amount)).join(" + ")} ZEC went in and the same total came out ${duration(out.time - hit[hit.length - 1].time)} after the last of them. Splitting the entry does not hide a matching exit.`,
      txids: [...hit.map((h) => h.txid), out.txid],
      links: hit.map((h) => ({ from: h.txid, to: out.txid })),
      fixes: ["Take out an amount that does not add up to recent entries.", "Spread exits over time instead of emptying what you just put in."]
    });
  }
  return findings;
}
function quickExits(cs, alreadyLinked) {
  const findings = [];
  for (const out of cs.filter((c2) => c2.kind === "deshield" && !alreadyLinked.has(c2.txid))) {
    const prev = cs.filter((c2) => c2.kind === "shield" && c2.time <= out.time && out.time - c2.time < DAY).pop();
    if (!prev) continue;
    const gap = out.time - prev.time;
    findings.push({
      rule: "quick-exit",
      severity: gap < HOUR ? "high" : "medium",
      title: `Left the pool ${duration(gap)} after entering`,
      detail: `Few people enter and leave the shielded pool within the same ${gap < HOUR ? "hour" : "day"}, so the timing alone narrows down who this exit belongs to, even though the amounts differ.`,
      txids: [prev.txid, out.txid],
      links: [{ from: prev.txid, to: out.txid }],
      fixes: ["Let shielded funds sit for days before moving them out.", "Avoid entering and leaving at the same time of day."]
    });
  }
  return findings;
}
function distinctiveAmounts(cs, alreadyLinked) {
  const hits = cs.filter((c2) => (c2.kind === "shield" || c2.kind === "deshield") && distinctiveness(c2.amount) === "unique" && !alreadyLinked.has(c2.txid));
  if (!hits.length) return [];
  return [{
    rule: "distinctive-amount",
    severity: hits.length > 2 ? "medium" : "low",
    title: `${hits.length} crossing${hits.length > 1 ? "s" : ""} with fingerprint amounts`,
    detail: `${hits.slice(0, 4).map((h) => `${zec(h.amount)} ZEC`).join(", ")}${hits.length > 4 ? " and more" : ""}. An amount with four or more decimals is easy to search for on the public side, and any later exit near it will stand out.`,
    txids: hits.map((h) => h.txid),
    links: [],
    fixes: ["Shield and deshield round amounts (0.5, 1, 2.5 ZEC) and leave the odd remainder shielded."]
  }];
}
function addressReuse(cs) {
  const byAddr = /* @__PURE__ */ new Map();
  for (const c2 of cs) {
    const arrives = c2.kind === "transparent" && c2.incoming || c2.kind === "deshield" || c2.kind === "transparent" && !c2.incoming;
    if (!arrives) continue;
    for (const a of c2.addresses) byAddr.set(a, [...byAddr.get(a) ?? [], c2]);
  }
  const findings = [];
  for (const [addr, list] of byAddr) {
    if (list.length < 2) continue;
    const exits = list.filter((c2) => c2.kind === "deshield").length;
    findings.push({
      rule: "address-reuse",
      severity: exits >= 2 || list.length >= 4 ? "medium" : "low",
      title: `Transparent address reused ${list.length} times`,
      detail: `${addr.slice(0, 10)}\u2026${addr.slice(-6)} received coins on ${list.length} public transactions, so they are linked to each other regardless of what happens inside the pool.`,
      txids: list.map((c2) => c2.txid),
      links: list.slice(1).map((c2, i) => ({ from: list[i].txid, to: c2.txid })),
      fixes: ["Use a fresh transparent address each time (most wallets rotate them automatically).", "For exchanges, use the TEX address they give you rather than reusing an old one."]
    });
  }
  return findings;
}
function transparentOnly(cs) {
  const hits = cs.filter((c2) => c2.kind === "transparent" && !c2.incoming);
  if (!hits.length) return [];
  return [{
    rule: "transparent-only",
    severity: hits.length >= 3 ? "medium" : "low",
    title: `${hits.length} fully transparent payment${hits.length > 1 ? "s" : ""}`,
    detail: "These never touched a shielded pool: amounts, senders and receivers are all public, just like Bitcoin.",
    txids: hits.map((h) => h.txid),
    links: [],
    fixes: ["Shield transparent funds once, then pay from the shielded balance."]
  }];
}
function migrations(cs) {
  const hits = cs.filter((c2) => c2.kind === "migrate");
  if (!hits.length) return [];
  return [{
    rule: "migration-reveal",
    severity: "low",
    title: `${hits.length} pool migration${hits.length > 1 ? "s" : ""} with a public amount`,
    detail: `Moves between shielded pools (${[...new Set(hits.map((h) => `${h.from} to ${h.to}`))].join(", ")}) show their amount: ${hits.slice(0, 3).map((h) => zec(h.amount) + " ZEC").join(", ")}. It does not link you to a transparent address, but a one-shot migration of a whole balance tells observers how much the wallet held.`,
    txids: hits.map((h) => h.txid),
    links: [],
    fixes: ["Migrate in a few smaller steps, or let your wallet move funds as you spend."]
  }];
}

// ../core/src/analyze.ts
var WEIGHT = { critical: 30, high: 18, medium: 8, low: 3 };
var RANK = { critical: 0, high: 1, medium: 2, low: 3 };
function findingsFor(cs) {
  const trips = roundTrips(cs);
  const linked = new Set(trips.flatMap((f) => f.txids));
  const sums = sumMatches(cs, linked);
  sums.forEach((f) => f.txids.forEach((t) => linked.add(t)));
  const exitsLinked = /* @__PURE__ */ new Set([...linked]);
  return [
    ...trips,
    ...sums,
    ...quickExits(cs, exitsLinked),
    ...distinctiveAmounts(cs, linked),
    ...addressReuse(cs),
    ...transparentOnly(cs),
    ...migrations(cs)
  ].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
function score(findings) {
  const penalty = findings.reduce((s, f) => s + WEIGHT[f.severity], 0);
  const value = Math.max(0, 100 - penalty);
  const grade = value >= 90 ? "A" : value >= 75 ? "B" : value >= 55 ? "C" : value >= 35 ? "D" : "F";
  return { score: value, grade };
}
function analyze(history) {
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
      shields: cs.filter((c2) => c2.kind === "shield").length,
      deshields: cs.filter((c2) => c2.kind === "deshield").length,
      migrations: cs.filter((c2) => c2.kind === "migrate").length,
      transparentOnly: cs.filter((c2) => c2.kind === "transparent").length
    }
  };
}

// ../core/src/preflight.ts
var PLANNED = "planned";
var HOUR2 = 3600;
var DAY2 = 86400;
var WAITS = [6 * HOUR2, DAY2, 2 * DAY2, 3 * DAY2, 7 * DAY2, 14 * DAY2, 30 * DAY2];
function evaluate(base, steps, plan) {
  const extra = steps.map((s, i) => ({
    txid: i === 0 ? PLANNED : `${PLANNED}-${i}`,
    time: s.notBefore,
    height: Number.MAX_SAFE_INTEGER - steps.length + i,
    kind: "deshield",
    amount: s.amount,
    from: plan.pool ?? "orchard",
    to: "transparent",
    addresses: plan.address ? [plan.address] : []
  }));
  const all = [...base, ...extra].sort((a, b) => a.time - b.time || a.height - b.height);
  return findingsFor(all).filter((f) => f.txids.some((t) => t.startsWith(PLANNED))).map((f) => f.rule !== "distinctive-amount" ? f : {
    ...f,
    title: "The withdrawal amount is a fingerprint",
    detail: `${extra.map((e) => zec(e.amount)).join(" and ")} ZEC has enough decimals to stand out on the public side.`,
    txids: f.txids.filter((t) => t.startsWith(PLANNED))
  });
}
function verdictOf(findings) {
  if (findings.some((f) => f.severity === "critical" || f.severity === "high")) return "risky";
  if (findings.some((f) => f.severity === "medium")) return "caution";
  return "safe";
}
function preflight(history, plan) {
  const base = crossings(history.txs);
  const findings = evaluate(base, [{ amount: plan.amount, notBefore: plan.time }], plan);
  const verdict = verdictOf(findings);
  const alternatives = [];
  if (verdict === "safe") return { verdict, findings, alternatives };
  for (const w of WAITS) {
    const steps = [{ amount: plan.amount, notBefore: plan.time + w }];
    const v = verdictOf(evaluate(base, steps, plan));
    if (v !== "risky") {
      alternatives.push({ title: `Send ${zec(plan.amount)} ZEC ${later(plan.time, plan.time + w)}`, why: v === "safe" ? "By then no entry pairs with this exit." : "Waiting removes the strong links; a weak timing hint remains.", steps });
      break;
    }
  }
  const part = roundDown(plan.amount);
  if (part > 0 && part < plan.amount) {
    const rest = plan.amount - part;
    if (rest <= plan.amount * 0.25 && verdictOf(evaluate(base, [{ amount: part, notBefore: plan.time }], plan)) !== "risky") {
      alternatives.push({
        title: `Send ${zec(part)} ZEC now and keep ${zec(rest)} ZEC shielded`,
        why: "A round amount is shared by many users and no longer mirrors what went in. The remainder can stay in the pool.",
        steps: [{ amount: part, notBefore: plan.time }]
      });
    } else {
      for (const w of WAITS) {
        const steps = [{ amount: part, notBefore: plan.time }, { amount: rest, notBefore: plan.time + w }];
        if (verdictOf(evaluate(base, steps, plan)) !== "risky") {
          alternatives.push({
            title: `Send ${zec(part)} ZEC now and ${zec(rest)} ZEC ${later(plan.time, plan.time + w)}`,
            why: "A round amount is shared by many users, and splitting breaks the match with what went in.",
            steps
          });
          break;
        }
      }
    }
  }
  if (findings.some((f) => f.rule === "address-reuse")) {
    alternatives.push({ title: "Use a fresh transparent address", why: "The destination already appears on your earlier crossings and links them to this one.", steps: [{ amount: plan.amount, notBefore: plan.time }] });
  }
  return { verdict, findings, alternatives };
}
function later(from, to) {
  const d = new Date(to * 1e3);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const wait = to - from;
  if (wait < 2 * DAY2) return `in ${Math.round(wait / HOUR2)} h (${date}, ${d.toISOString().slice(11, 16)} UTC)`;
  return `in ${Math.round(wait / DAY2)} days (${date})`;
}

// src/wallet.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var POOL = { 0: "transparent", 2: "sapling", 3: "orchard", 4: "ironwood" };
var hex = (b) => Buffer.from(b).toString("hex");
var txidHex = (b) => Buffer.from(b).reverse().toString("hex");
function open(walletDir) {
  const file = join(walletDir, "data.sqlite");
  if (!existsSync(file)) throw new Error(`No wallet database at ${file}`);
  return new DatabaseSync(file, { readOnly: true });
}
function walletNetwork(walletDir) {
  const keys = join(walletDir, "keys.toml");
  const m = existsSync(keys) ? /network\s*=\s*"(\w+)"/.exec(readFileSync(keys, "utf8")) : null;
  return m?.[1] ?? "main";
}
function uuidOf(b) {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function readHistory(walletDir, opts = {}) {
  const db = open(walletDir);
  try {
    const accounts = db.prepare("SELECT id, uuid, name FROM accounts ORDER BY id").all();
    if (!accounts.length) throw new Error("The wallet has no accounts");
    const account = opts.account ? accounts.find((a) => uuidOf(a.uuid) === opts.account) : accounts[0];
    if (!account) throw new Error(`No account ${opts.account} in this wallet`);
    const acc = account.id;
    const txRows = db.prepare(`
      SELECT t.id_tx, t.txid, t.mined_height, t.fee, b.time
      FROM transactions t LEFT JOIN blocks b ON b.height = t.mined_height
      WHERE t.id_tx IN (
        SELECT transaction_id FROM v_received_outputs WHERE account_id = :acc
        UNION SELECT transaction_id FROM v_received_output_spends WHERE account_id = :acc
        UNION SELECT transaction_id FROM sent_notes WHERE from_account_id = :acc)
      ORDER BY t.mined_height IS NULL, t.mined_height, t.tx_index`).all({ acc });
    const received = db.prepare(`
      SELECT ro.pool, ro.value, ro.is_change, a.cached_transparent_receiver_address AS addr
      FROM v_received_outputs ro LEFT JOIN addresses a ON a.id = ro.address_id
      WHERE ro.transaction_id = :tx AND ro.account_id = :acc`);
    const spent = db.prepare(`
      SELECT ro.pool, ro.value, a.cached_transparent_receiver_address AS addr
      FROM v_received_output_spends ros
      JOIN v_received_outputs ro ON ro.pool = ros.pool AND ro.id_within_pool_table = ros.received_output_id
      LEFT JOIN addresses a ON a.id = ro.address_id
      WHERE ros.transaction_id = :tx AND ros.account_id = :acc`);
    const sent = db.prepare(`
      SELECT sn.output_pool AS pool, sn.value, sn.to_address AS addr
      FROM sent_notes sn
      WHERE sn.transaction_id = :tx AND sn.from_account_id = :acc
        AND NOT EXISTS (SELECT 1 FROM v_received_outputs ro WHERE ro.sent_note_id = sn.id)`);
    const flow = (r, change) => {
      const pool = POOL[r.pool] ?? "orchard";
      const f = { pool, value: Number(r.value) };
      if (pool === "transparent" && r.addr) f.address = String(r.addr);
      if (change) f.change = true;
      return f;
    };
    const txs = txRows.map((t) => {
      const args2 = { tx: t.id_tx, acc };
      return {
        txid: txidHex(t.txid),
        height: t.mined_height ?? null,
        time: t.time ?? null,
        fee: t.fee == null ? null : Number(t.fee),
        spent: spent.all(args2).map((r) => flow(r)),
        received: received.all(args2).map((r) => flow(r, Boolean(r.is_change))),
        sent: sent.all(args2).map((r) => flow(r))
      };
    });
    fillTimes(db, txs);
    return { network: walletNetwork(walletDir), label: opts.label ?? (account.name || void 0), txs };
  } finally {
    db.close();
  }
}
function fillTimes(db, txs) {
  const known = db.prepare("SELECT height, time FROM blocks ORDER BY height").all();
  if (!known.length) return;
  for (const tx of txs) {
    if (tx.height == null || tx.time != null) continue;
    let near = known[0];
    for (const k of known) if (Math.abs(k.height - tx.height) < Math.abs(near.height - tx.height)) near = k;
    tx.time = near.time + (tx.height - near.height) * 75;
  }
}

// src/main.ts
var c = (code) => (s) => process.stdout.isTTY ? `\x1B[${code}m${s}\x1B[0m` : s;
var red = c(31);
var yellow = c(33);
var green = c(32);
var dim = c(2);
var bold = c(1);
var cyan = c(36);
var SEV = { critical: (s) => bold(red(s)), high: red, medium: yellow, low: dim };
function args(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
function load(source, account) {
  if (existsSync2(join2(source, "data.sqlite"))) return readHistory(source, { account });
  return JSON.parse(readFileSync2(source, "utf8"));
}
function printReport(r) {
  const g = r.grade;
  const gradeColor = g === "A" || g === "B" ? green : g === "C" ? yellow : red;
  console.log(`
${bold("Tells")} ${dim("\xB7")} ${r.label ?? "wallet"} ${dim(`(${r.network}net)`)}`);
  console.log(`${gradeColor(bold(`Grade ${g}`))}  score ${r.score}/100  ${dim("\xB7")} ${r.stats.txs} transactions, ${r.stats.shields} into the pool, ${r.stats.deshields} out
`);
  if (!r.findings.length) console.log(green("No tells found. Nothing on the public side links your crossings together.\n"));
  for (const f of r.findings) {
    console.log(`${SEV[f.severity](f.severity.toUpperCase().padEnd(9))} ${bold(f.title)}`);
    console.log(`          ${f.detail}`);
    console.log(dim(`          tx ${f.txids.map((t) => t.slice(0, 10)).join(", ")}`));
    console.log(`          ${cyan("Fix:")} ${f.fixes[0]}
`);
  }
}
function ufvkNetwork(ufvk) {
  if (ufvk.startsWith("uviewtest")) return "test";
  if (ufvk.startsWith("uviewregtest")) return "regtest";
  return "main";
}
function run(devtool, argv) {
  const r = spawnSync(devtool, argv, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`zcash-devtool ${argv.slice(2, 3).join(" ")} failed (exit ${r.status})`);
}
var HELP = `tells: find what gives your Zcash history away

  tells scan --ufvk <UFVK> --birthday <height> [--devtool <path>] [--wallet <dir>] [--out history.json]
      Import a viewing key into a local view-only wallet, sync it, and print the checkup.
  tells report <wallet-dir | history.json> [--json]
  tells preflight <wallet-dir | history.json> --amount <ZEC> [--at <ISO date>] [--to <t-address>]
      Check a withdrawal before you make it, and get safer ways to make it.
  tells export <wallet-dir> [--account <uuid>] [--out history.json]

Viewing keys and wallet data stay on this machine. Needs zcash-devtool for scan (github.com/zcash/zcash-devtool).`;
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  const out = typeof flags.out === "string" ? flags.out : void 0;
  switch (cmd) {
    case "export": {
      const h = readHistory(pos[0], { account: flags.account });
      const json = JSON.stringify(h, null, 2);
      if (out) writeFileSync(out, json);
      else console.log(json);
      break;
    }
    case "report": {
      const r = analyze(load(pos[0], flags.account));
      if (flags.json) console.log(JSON.stringify(r, null, 2));
      else printReport(r);
      break;
    }
    case "preflight": {
      const h = load(pos[0], flags.account);
      const amount = Math.round(Number(flags.amount) * ZAT);
      if (!amount) throw new Error("--amount <ZEC> is required");
      const time = typeof flags.at === "string" ? Math.floor(Date.parse(flags.at) / 1e3) : Math.floor(Date.now() / 1e3);
      const p = preflight(h, { amount, time, address: flags.to });
      const v = p.verdict === "safe" ? green("SAFE") : p.verdict === "caution" ? yellow("CAUTION") : red(bold("RISKY"));
      console.log(`
Withdrawing ${zec(amount)} ZEC: ${v}
`);
      for (const f of p.findings) console.log(`${SEV[f.severity](f.severity.toUpperCase().padEnd(9))} ${f.title}
          ${f.detail}
`);
      if (p.alternatives.length) console.log(bold("Safer ways to do it:"));
      for (const a of p.alternatives) console.log(`  ${green("\u2022")} ${a.title}
    ${dim(a.why)}`);
      console.log("");
      break;
    }
    case "scan": {
      const ufvk = flags.ufvk;
      const birthday = flags.birthday;
      if (!ufvk || !birthday) throw new Error("scan needs --ufvk and --birthday");
      const devtool = flags.devtool ?? process.env.ZCASH_DEVTOOL ?? "zcash-devtool";
      const server = flags.server ?? "zecrocks";
      const dir = flags.wallet ?? join2(tmpdir(), `tells-${Buffer.from(ufvk).subarray(-12).toString("hex")}`);
      if (!existsSync2(join2(dir, "data.sqlite"))) {
        mkdirSync(dir, { recursive: true });
        run(devtool, ["wallet", "-w", dir, "init-fvk", "--name", "tells", "--fvk", ufvk, "--birthday", birthday, "-s", server]);
      }
      console.log(dim(`Syncing a view-only ${ufvkNetwork(ufvk)}net wallet in ${dir} ...`));
      run(devtool, ["wallet", "-w", dir, "sync", "-s", server]);
      run(devtool, ["wallet", "-w", dir, "enhance", "-s", server]);
      const h = readHistory(dir);
      if (out) writeFileSync(out, JSON.stringify(h, null, 2));
      printReport(analyze(h));
      break;
    }
    default:
      console.log(HELP);
  }
}
main().catch((e) => {
  console.error(red(String(e instanceof Error ? e.message : e)));
  process.exit(1);
});
