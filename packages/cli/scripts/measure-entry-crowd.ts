import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyze, countEntryCrowd, crossings, entryCrowdComplete, entryCrowdRequests, findingsFor,
  type EntryCrowdRequest, type History, type Network,
} from '@tells/core';
import { chainContext, windowsFor } from '../src/chain';
import { resolveEntryCrowds } from '../src/entry-crowd';
import { openLightwalletd, SERVERS } from '../src/lightwalletd';
import { readHistory } from '../src/wallet';
import { recordingSource, replay, type Recording } from './recording';

const { values: args } = parseArgs({ options: {
  network: { type: 'string', default: 'test' }, sample: { type: 'string' }, wallet: { type: 'string' },
  from: { type: 'string' }, to: { type: 'string' }, server: { type: 'string' },
  cache: { type: 'string', default: '.tells-cache/measurement' },
  record: { type: 'string' }, offline: { type: 'string' }, out: { type: 'string' },
  'max-blocks': { type: 'string' }, 'max-transactions': { type: 'string' },
} });

const network = args.network as Network;
if (!['test', 'main', 'regtest'].includes(network)) throw new Error('Invalid network');
if (args.record && args.offline) throw new Error('--record and --offline are mutually exclusive');
const started = performance.now();
const recorded = args.offline ? JSON.parse(readFileSync(args.offline, 'utf8')) as Recording : undefined;
const source = recorded ? replay(recorded) : openLightwalletd(network, args.server);
try {
  const info = await source.info();
  const record: Recording = { recordedAt: new Date().toISOString(), server: args.server ?? SERVERS[network]!, info, blocks: [], transactions: {} };
  const rpc = args.record ? recordingSource(source, record) : source;
  const history: History | undefined = args.wallet ? readHistory(args.wallet) : args.sample ? JSON.parse(readFileSync(args.sample, 'utf8')) :
    network === 'test' ? JSON.parse(readFileSync('apps/web/public/samples/testnet.json', 'utf8')) : undefined;
  if (history && history.network !== network) throw new Error('History network mismatch');
  const cs = history ? crossings(history.txs) : [];
  const findings = findingsFor(cs);
  const windows: [number, number][] = history ? windowsFor(findings, cs) : [[Number(args.from), Number(args.to)]];
  if (windows.some(([from, to]) => !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from >= 20_000)) {
    throw new Error('Supply a bounded --from/--to window (at most 20000 blocks)');
  }
  const context = await chainContext(network, windows, args.server, rpc);
  // A census uses one bounded resolution pass, then compares every measured entry against that same window.
  // Its self ID is excluded individually; it does not pretend that all public entries belong to one wallet.
  const requests: EntryCrowdRequest[] = history ? entryCrowdRequests(findings, cs) : [{ txid: 'census', amount: 1, from: windows[0][0], to: windows[0][1] }];
  const options = {
    source: rpc, context, cacheDir: args.cache,
    maxBlocks: args['max-blocks'] === undefined ? undefined : Number(args['max-blocks']),
    maxTransactions: args['max-transactions'] === undefined ? undefined : Number(args['max-transactions']),
    excludeTxids: history?.txs.map(t => t.txid),
  };
  const result = await resolveEntryCrowds(network, requests, options);
  const coldMs = performance.now() - started;
  const warmStart = performance.now();
  // Refresh compact data as the actual CLI does; reuse only immutable transaction data from disk.
  const warmContext = await chainContext(network, windows, args.server, rpc);
  const warm = await resolveEntryCrowds(network, requests, { ...options, context: warmContext });
  const warmMs = performance.now() - warmStart;
  if (JSON.stringify(warm.crowds) !== JSON.stringify(result.crowds)) throw new Error('Cold/warm count mismatch');
  const crowds = history ? result.crowds : result.entries.map(e => countEntryCrowd({ txid: e.txid, amount: e.amount, from: windows[0][0], to: windows[0][1] }, result.entries, result.crowds[0].coverage));
  const sizes = crowds.map(c => c.others).sort((a, b) => a - b);
  const cacheFiles = (path: string): { files: number; bytes: number } => {
    let files = 0, bytes = 0;
    try {
      for (const item of readdirSync(path, { withFileTypes: true })) {
        const p = join(path, item.name);
        if (item.isDirectory()) { const child = cacheFiles(p); files += child.files; bytes += child.bytes; }
        else { files++; bytes += statSync(p).size; }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return { files, bytes };
  };
  const before = history ? analyze(history) : undefined;
  const after = history ? analyze({ ...history, chain: { ...context, entryCrowds: crowds } }) : undefined;
  const stripEntries = (report: typeof after) => report && { ...report, findings: report.findings.map(({ entryCrowd, ...f }) => f) };
  const summary = {
    network, server: args.server ?? recorded?.server ?? SERVERS[network], recordedAt: recorded?.recordedAt ?? record.recordedAt,
    mode: recorded ? 'offline' : 'live', windows, blocks: windows.reduce((n, [a, b]) => n + b - a + 1, 0),
    candidateTransactions: context.entries.length, resolvedEntries: result.entries.length,
    entriesWithCompleteCounts: new Set(crowds.filter(entryCrowdComplete).map(c => c.txid)).size,
    completeWindows: crowds.filter(entryCrowdComplete).length, measuredWindows: crowds.length,
    sizes: { min: sizes[0] ?? null, median: sizes.length ? (sizes[Math.floor((sizes.length - 1) / 2)] + sizes[Math.floor(sizes.length / 2)]) / 2 : null, max: sizes.at(-1) ?? null, histogram: sizes.reduce<Record<string, number>>((h, n) => { h[n] = (h[n] ?? 0) + 1; return h; }, {}) },
    coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), coldCache: result.cache, warmCache: warm.cache,
    cacheSize: cacheFiles(join(args.cache!, 'v1', network)),
    existingFindingsUnchanged: history ? JSON.stringify(before) === JSON.stringify(stripEntries(after)) : null,
    scoreBefore: before?.score, scoreAfter: after?.score,
    resolutionCoverage: result.crowds.map(c => c.coverage), crowds,
  };
  const write = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + '\n'); };
  if (args.record) write(args.record, record);
  if (args.out) {
    write(args.out, summary);
    if (history) { write(args.out.replace(/\.json$/, '.before.json'), before); write(args.out.replace(/\.json$/, '.after.json'), after); }
  }
  const { crowds: ignored, resolutionCoverage, ...compact } = summary;
  console.log(JSON.stringify({ ...compact, limits: [...new Set(resolutionCoverage.flatMap(c => c.limits))], errors: resolutionCoverage.flatMap(c => c.errors) }, null, 2));
} finally { source.close(); }
