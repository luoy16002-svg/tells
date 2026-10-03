import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyze, countEntryCrowd, crossings, entryCrowdComplete, entryCrowdRequests, findingsFor, type ChainContext, type EntryCrowdRequest, type History } from '@tells/core';
import { chainContext, windowsFor } from '../src/chain';
import { resolveEntryCrowds } from '../src/entry-crowd';
import { normalizeProxyEnv, validateLightdInfo, type CompactBlock, type Lightwalletd } from '../src/lightwalletd';
import { TransactionCache } from '../src/transaction-cache';
import { parseTransaction, resolveEntry } from '../src/transaction';
import { replay, type Recording } from '../scripts/recording';
import { id, transaction } from './transactions';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const testRoot = resolve(root, '.tells-cache', 'tests');
const directories: string[] = [];
const cacheDir = () => { mkdirSync(testRoot, { recursive: true }); const dir = mkdtempSync(join(testRoot, 'entry-')); directories.push(dir); return dir; };
afterEach(() => {
  for (const path of directories.splice(0)) {
    const child = relative(testRoot, resolve(path));
    if (!child || child.startsWith('..') || resolve(path) === testRoot) throw new Error('Invalid test cleanup path');
    rmSync(path, { recursive: true, force: true });
  }
});
const info = { chainName: 'test', lightwalletProtocolVersion: 'v0.5.0', blockHeight: 1000 };
const request: EntryCrowdRequest = { txid: id(1), amount: 1_000_000, from: 10, to: 12 };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}-entry-crowd.json`, import.meta.url), 'utf8')) as Recording;
function sourceFor(raws: Record<string, Buffer>, heights: Record<string, number>): Lightwalletd {
  const blocks: CompactBlock[] = [10, 11, 12].map(height => ({ height, time: height * 75, txs: Object.entries(heights).filter(([, h]) => h === height).map(([txid]) => {
    const tx = parseTransaction(raws[txid]);
    return { txid, index: 1, shielded: true, shieldedOutputs: true, vin: tx.vin, vout: tx.vout };
  }) }));
  return {
    info: async () => info,
    blocks: vi.fn(async (from, to) => blocks.filter(b => b.height >= from && b.height <= to)),
    transaction: vi.fn(async txid => { if (!raws[txid]) throw new Error('5 NOT_FOUND: missing transaction'); return raws[txid]; }),
    close: vi.fn(),
  };
}
function basicSource() {
  const raws = {
    [id(1)]: transaction({ vin: [{ txid: id(3), index: 0 }], ironwood: -1_000_000 }),
    [id(2)]: transaction({ vin: [{ txid: id(3), index: 1 }], ironwood: -1_010_000 }),
    [id(3)]: transaction({ vout: [1_015_000, 1_025_000] }),
  };
  return { raws, source: sourceFor(raws, { [id(1)]: 10, [id(2)]: 12 }) };
}

describe('recorded testnet scenario (offline)', () => {
  it('resolves v6/Ironwood entries and reproduces all sample findings and exit evidence', async () => {
    const history = JSON.parse(readFileSync(join(root, 'apps/web/public/samples/testnet.json'), 'utf8')) as History;
    const record = fixture('testnet');
    const source = replay(record);
    const cs = crossings(history.txs), findings = findingsFor(cs);
    const context = await chainContext('test', windowsFor(findings, cs), undefined, source);
    expect(context).toEqual(history.chain);
    const options = { source, context, cacheDir: cacheDir(), excludeTxids: history.txs.map(t => t.txid) };
    const requests = entryCrowdRequests(findings, cs);
    const result = await resolveEntryCrowds('test', requests, options);
    expect(result.crowds).toHaveLength(3);
    expect(new Set(result.crowds.map(c => c.txid)).size).toBe(2);
    expect(result.crowds.every(c => entryCrowdComplete(c) && c.others === 0 && c.timingOthers === 0)).toBe(true);
    expect(result.entries.map(e => e.amount).sort((x, y) => x - y)).toEqual([4_315_000, 12_485_000]);
    expect(result.cache).toMatchObject({ fetched: 4, diskHits: 0, bytesWritten: 37027 });
    for (const entry of result.entries) {
      const value = await resolveEntry(parseTransaction(Buffer.from(record.transactions[entry.txid], 'hex')), async id => parseTransaction(Buffer.from(record.transactions[id], 'hex')));
      expect(value.fee).toBe(15_000);
      expect(value.input - value.output - value.fee).toBe(entry.amount);
    }
    const after = analyze({ ...history, chain: { ...context, entryCrowds: result.crowds } });
    expect({ ...after, findings: after.findings.map(({ entryCrowd, ...f }) => f) }).toEqual(analyze(history));
    const warm = await resolveEntryCrowds('test', requests, { ...options, source: { ...source, transaction: async () => { throw new Error('Unexpected network read'); } } });
    expect(warm.crowds).toEqual(result.crowds);
    expect(warm.cache).toMatchObject({ fetched: 0, diskHits: 4, bytesWritten: 0 });
  });
  it('replays the mainnet census within the default transaction budget', async () => {
    const source = replay(fixture('mainnet'));
    const from = 3504400, to = 3504495;
    const context = await chainContext('main', [[from, to]], undefined, source);
    const result = await resolveEntryCrowds('main', [{ txid: 'census', amount: 1, from, to }], { source, context, cacheDir: cacheDir() });
    expect(result.entries).toHaveLength(50);
    expect(result.cache).toMatchObject({ fetched: 162, bytesWritten: 591905 });
    expect(result.crowds[0].coverage).toMatchObject({ transactions: 162, limits: [], resolved: 50, candidates: 50 });
    const crowds = result.entries.map(e => countEntryCrowd({ txid: e.txid, amount: e.amount, from, to }, result.entries, result.crowds[0].coverage));
    expect(crowds.every(entryCrowdComplete)).toBe(true);
    expect(crowds.reduce<Record<number, number>>((h, c) => { h[c.others] = (h[c.others] ?? 0) + 1; return h; }, {})).toEqual({ 0: 36, 1: 10, 3: 4 });
  });
});

describe('bounded entry resolution', () => {
  it('counts exact window edges and excludes every known wallet transaction', async () => {
    const { source } = basicSource();
    const result = await resolveEntryCrowds('test', [request], { source, cacheDir: cacheDir() });
    expect(result.crowds[0]).toMatchObject({ others: 1, timingOthers: 1, coverage: { transactions: 3, resolved: 2, candidates: 2, limits: [] } });
    const ownOnly = await resolveEntryCrowds('test', [request], { source, cacheDir: cacheDir(), excludeTxids: [id(2)] });
    expect(ownOnly.crowds[0].others).toBe(0);
    expect(source.close).not.toHaveBeenCalled(); // borrowed clients belong to their caller
  });
  it('reports a window cap, reads only that prefix and does not claim a complete zero', async () => {
    const { source } = basicSource();
    const result = await resolveEntryCrowds('test', [request], { source, cacheDir: cacheDir(), maxBlocks: 2 });
    expect(source.blocks).toHaveBeenCalledWith(10, 11);
    expect(result.crowds[0]).toMatchObject({ others: 0, coverage: { range: [10, 11], limits: ['window'] } });
    expect(entryCrowdComplete(result.crowds[0])).toBe(false);
  });
  it('caps all full transactions, including previous transactions, equally with a warm cache', async () => {
    const { source } = basicSource();
    const options = { source, cacheDir: cacheDir(), maxTransactions: 2 };
    const first = await resolveEntryCrowds('test', [request], options);
    const warm = await resolveEntryCrowds('test', [request], options);
    expect(first.crowds[0].coverage).toMatchObject({ transactions: 2, resolved: 1, candidates: 2, limits: ['transactions'] });
    expect(warm.crowds).toEqual(first.crowds);
    expect(first.cache.fetched).toBe(2);
    expect(warm.cache.fetched).toBe(0);
    const exact = await resolveEntryCrowds('test', [request], { ...options, maxTransactions: 3 });
    expect(entryCrowdComplete(exact.crowds[0])).toBe(true);
  });
  it('does not partially count a transaction when the cap falls between its inputs', async () => {
    const raws = {
      [id(1)]: transaction({ vin: [{ txid: id(3), index: 0 }, { txid: id(4), index: 0 }], ironwood: -1_000_000 }),
      [id(3)]: transaction({ vout: [500_000] }), [id(4)]: transaction({ vout: [515_000] }),
    };
    const result = await resolveEntryCrowds('test', [request], { source: sourceFor(raws, { [id(1)]: 10 }), cacheDir: cacheDir(), maxTransactions: 2 });
    expect(result.entries).toEqual([]);
    expect(result.crowds[0].coverage).toMatchObject({ resolved: 0, transactions: 2, limits: ['transactions'] });
  });
  it('reports missing parents and retries them on a later scan', async () => {
    const { source, raws } = basicSource();
    const parent = raws[id(3)];
    delete raws[id(3)];
    const options = { source, cacheDir: cacheDir() };
    const failed = await resolveEntryCrowds('test', [request], options);
    expect(failed.crowds[0].coverage.limits).toEqual(['unresolved']);
    expect(failed.crowds[0].coverage.errors[0]).toContain('NOT_FOUND');
    expect(failed.crowds[0].coverage.resolved).toBe(0);
    raws[id(3)] = parent;
    const retried = await resolveEntryCrowds('test', [request], options);
    expect(entryCrowdComplete(retried.crowds[0])).toBe(true);
    expect(retried.cache.fetched).toBe(1);
  });
  it('reports unsupported transaction formats instead of treating them as non-entries', async () => {
    const { source, raws } = basicSource();
    raws[id(2)].writeUInt32LE(0x80000007, 0);
    const result = await resolveEntryCrowds('test', [request], { source, cacheDir: cacheDir() });
    expect(result.crowds[0].coverage).toMatchObject({ resolved: 1, limits: ['unresolved'] });
    expect(result.crowds[0].coverage.errors[0]).toContain('Unsupported');
  });
  it('reports truncated or failed compact coverage', async () => {
    for (const blocks of [async () => [], async () => { throw new Error('4 DEADLINE_EXCEEDED'); }]) {
      const { source } = basicSource();
      const result = await resolveEntryCrowds('test', [request], { source: { ...source, blocks }, cacheDir: cacheDir() });
      expect(result.crowds[0].coverage).toMatchObject({ range: null, limits: ['coverage'], transactions: 0 });
      expect(result.crowds[0].coverage.errors.length).toBe(1);
      expect(source.transaction).not.toHaveBeenCalled();
    }
  });
  it('deduplicates candidates when compact coverage overlaps', async () => {
    const { source } = basicSource();
    const context: ChainContext = { ranges: [[10, 12]], exits: [], entries: [1, 1, 2].map(n => ({ txid: id(n), height: n === 1 ? 10 : 12 })) };
    const result = await resolveEntryCrowds('test', [request], { source, context, cacheDir: cacheDir() });
    expect(result.crowds[0].others).toBe(1);
    expect(result.crowds[0].coverage.candidates).toBe(2);
    expect(source.blocks).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid transaction budgets %s', maxTransactions => {
    return expect(resolveEntryCrowds('test', [], { maxTransactions })).rejects.toThrow('positive integer');
  });
});

describe('persistent transaction cache', () => {
  it('uses separate networks, repairs corrupt files, and leaves no temporary files', async () => {
    const path = cacheDir(), bytes = transaction({ vout: [10] });
    const fetch = vi.fn(async () => bytes);
    const a = new TransactionCache('test', path, fetch);
    await a.get(id(10));
    const b = new TransactionCache('main', path, fetch);
    await b.get(id(10));
    expect(fetch).toHaveBeenCalledTimes(2);
    const file = join(a.directory, `${id(10)}.bin`);
    writeFileSync(file, 'broken');
    const repair = new TransactionCache('test', path, fetch);
    await repair.get(id(10));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(readFileSync(file)).toEqual(bytes);
    expect(readdirSync(a.directory)).toEqual([`${id(10)}.bin`]);
    await expect(repair.get('../escape')).rejects.toThrow('Invalid transaction ID');
  });
});

describe('lightwalletd capability and proxy handling', () => {
  it('does not infer a zero crowd on old servers or the wrong network', () => {
    expect(() => validateLightdInfo({ ...info, lightwalletProtocolVersion: '' }, 'test')).toThrow('cannot guarantee');
    expect(() => validateLightdInfo({ ...info, lightwalletProtocolVersion: 'v0.3.0' }, 'test')).toThrow();
    expect(() => validateLightdInfo(info, 'main')).toThrow('does not match');
    expect(() => validateLightdInfo({ ...info, lightwalletProtocolVersion: 'v0.4.0' }, 'test')).not.toThrow();
  });
  it('normalizes uppercase HTTPS_PROXY and NO_PROXY while preserving explicit grpc settings', () => {
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://localhost:7892', NO_PROXY: 'localhost,127.0.0.1', NODE_USE_ENV_PROXY: '1' };
    normalizeProxyEnv(env);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    const explicit = { ...env, grpc_proxy: 'http://localhost:8080', https_proxy: 'http://localhost:8081' };
    normalizeProxyEnv(explicit);
    expect(explicit.grpc_proxy).toBe('http://localhost:8080');
    expect(explicit.https_proxy).toBe('http://localhost:8081');
    expect(() => normalizeProxyEnv({ HTTPS_PROXY: 'https://localhost:7892' })).toThrow('was not bypassed');
  });
});
