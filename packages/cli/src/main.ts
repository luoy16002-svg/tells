#!/usr/bin/env node
// tells: a privacy checkup for Zcash wallets. Everything runs on this machine; the viewing key never leaves it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, preflight, zec, ZAT, type Finding, type History, type Report } from '@tells/core';
import { readHistory } from './wallet';

const c = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c(31), yellow = c(33), green = c(32), dim = c(2), bold = c(1), cyan = c(36);
const SEV: Record<Finding['severity'], (s: string) => string> = { critical: s => bold(red(s)), high: red, medium: yellow, low: dim };

function args(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function load(source: string, account?: string): History {
  if (existsSync(join(source, 'data.sqlite'))) return readHistory(source, { account });
  return JSON.parse(readFileSync(source, 'utf8')) as History;
}

function printReport(r: Report) {
  const g = r.grade;
  const gradeColor = g === 'A' || g === 'B' ? green : g === 'C' ? yellow : red;
  console.log(`\n${bold('Tells')} ${dim('·')} ${r.label ?? 'wallet'} ${dim(`(${r.network}net)`)}`);
  console.log(`${gradeColor(bold(`Grade ${g}`))}  score ${r.score}/100  ${dim('·')} ${r.stats.txs} transactions, ${r.stats.shields} into the pool, ${r.stats.deshields} out\n`);
  if (!r.findings.length) console.log(green('No tells found. Nothing on the public side links your crossings together.\n'));
  for (const f of r.findings) {
    console.log(`${SEV[f.severity](f.severity.toUpperCase().padEnd(9))} ${bold(f.title)}`);
    console.log(`          ${f.detail}`);
    console.log(dim(`          tx ${f.txids.map(t => t.slice(0, 10)).join(', ')}`));
    console.log(`          ${cyan('Fix:')} ${f.fixes[0]}\n`);
  }
}

function ufvkNetwork(ufvk: string) {
  if (ufvk.startsWith('uviewtest')) return 'test';
  if (ufvk.startsWith('uviewregtest')) return 'regtest';
  return 'main';
}

function run(devtool: string, argv: string[]) {
  const r = spawnSync(devtool, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`zcash-devtool ${argv.slice(2, 3).join(' ')} failed (exit ${r.status})`);
}

const HELP = `tells: find what gives your Zcash history away

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
  const out = typeof flags.out === 'string' ? flags.out : undefined;

  switch (cmd) {
    case 'export': {
      const h = readHistory(pos[0], { account: flags.account as string | undefined });
      const json = JSON.stringify(h, null, 2);
      if (out) writeFileSync(out, json); else console.log(json);
      break;
    }
    case 'report': {
      const r = analyze(load(pos[0], flags.account as string | undefined));
      if (flags.json) console.log(JSON.stringify(r, null, 2)); else printReport(r);
      break;
    }
    case 'preflight': {
      const h = load(pos[0], flags.account as string | undefined);
      const amount = Math.round(Number(flags.amount) * ZAT);
      if (!amount) throw new Error('--amount <ZEC> is required');
      const time = typeof flags.at === 'string' ? Math.floor(Date.parse(flags.at) / 1000) : Math.floor(Date.now() / 1000);
      const p = preflight(h, { amount, time, address: flags.to as string | undefined });
      const v = p.verdict === 'safe' ? green('SAFE') : p.verdict === 'caution' ? yellow('CAUTION') : red(bold('RISKY'));
      console.log(`\nWithdrawing ${zec(amount)} ZEC: ${v}\n`);
      for (const f of p.findings) console.log(`${SEV[f.severity](f.severity.toUpperCase().padEnd(9))} ${f.title}\n          ${f.detail}\n`);
      if (p.alternatives.length) console.log(bold('Safer ways to do it:'));
      for (const a of p.alternatives) console.log(`  ${green('•')} ${a.title}\n    ${dim(a.why)}`);
      console.log('');
      break;
    }
    case 'scan': {
      const ufvk = flags.ufvk as string;
      const birthday = flags.birthday as string;
      if (!ufvk || !birthday) throw new Error('scan needs --ufvk and --birthday');
      const devtool = (flags.devtool as string) ?? process.env.ZCASH_DEVTOOL ?? 'zcash-devtool';
      const server = (flags.server as string) ?? 'zecrocks';
      const dir = (flags.wallet as string) ?? join(tmpdir(), `tells-${Buffer.from(ufvk).subarray(-12).toString('hex')}`);
      if (!existsSync(join(dir, 'data.sqlite'))) {
        mkdirSync(dir, { recursive: true });
        run(devtool, ['wallet', '-w', dir, 'init-fvk', '--name', 'tells', '--fvk', ufvk, '--birthday', birthday, '-s', server]);
      }
      console.log(dim(`Syncing a view-only ${ufvkNetwork(ufvk)}net wallet in ${dir} ...`));
      run(devtool, ['wallet', '-w', dir, 'sync', '-s', server]);
      run(devtool, ['wallet', '-w', dir, 'enhance', '-s', server]);
      const h = readHistory(dir);
      if (out) writeFileSync(out, JSON.stringify(h, null, 2));
      printReport(analyze(h));
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch(e => { console.error(red(String(e instanceof Error ? e.message : e))); process.exit(1); });
