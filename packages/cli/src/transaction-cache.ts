import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Network } from '@tells/core';
import { parseTransaction, type PublicTransaction } from './transaction';

export interface CacheStats { fetched: number; diskHits: number; memoryHits: number; bytesWritten: number }

/** Immutable raw bytes, keyed by network and display-order txid; no keys or persistent negative entries. */
export class TransactionCache {
  readonly stats: CacheStats = { fetched: 0, diskHits: 0, memoryHits: 0, bytesWritten: 0 };
  private memory = new Map<string, Promise<PublicTransaction>>();
  readonly directory: string;
  constructor(network: Network, cacheDir: string, private fetch: (txid: string) => Promise<Buffer>) {
    this.directory = join(cacheDir, 'v1', network);
  }
  get(txid: string): Promise<PublicTransaction> {
    if (!/^[0-9a-f]{64}$/.test(txid)) return Promise.reject(new Error('Invalid transaction ID'));
    const hit = this.memory.get(txid);
    if (hit) { this.stats.memoryHits++; return hit; }
    const pending = this.load(txid);
    this.memory.set(txid, pending);
    return pending;
  }
  private async load(txid: string): Promise<PublicTransaction> {
    const path = join(this.directory, `${txid}.bin`);
    let bytes: Buffer | undefined;
    try { bytes = await readFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (bytes) {
      try {
        const parsed = parseTransaction(bytes);
        this.stats.diskHits++;
        return parsed;
      } catch { /* A corrupt/obsolete cache record is replaced from the server. */ }
    }
    this.stats.fetched++;
    bytes = await this.fetch(txid);
    const parsed = parseTransaction(bytes);
    await mkdir(this.directory, { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes, { flag: 'wx' });
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    this.stats.bytesWritten += bytes.length;
    return parsed;
  }
}
