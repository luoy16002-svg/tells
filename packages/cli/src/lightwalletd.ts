import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import type { Network } from '@tells/core';
import type { Outpoint } from './transaction';

export const SERVERS: Partial<Record<Network, string>> = { main: 'zec.rocks:443', test: 'testnet.zec.rocks:443' };
export interface CompactTransaction {
  txid: string;
  index: number;
  shielded: boolean;
  shieldedOutputs: boolean;
  vin: Outpoint[];
  vout: number[];
}
export interface CompactBlock { height: number; time: number; txs: CompactTransaction[] }
export interface LightdInfo { chainName: string; blockHeight: number; lightwalletProtocolVersion: string }
export interface Lightwalletd {
  info(): Promise<LightdInfo>;
  blocks(from: number, to: number): Promise<CompactBlock[]>;
  transaction(txid: string): Promise<Buffer>;
  close(): void;
}

function protoDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, 'proto'), join(here, '..', 'proto')]) if (existsSync(join(p, 'service.proto'))) return p;
  throw new Error('lightwalletd protocol files not found');
}

/** grpc-js uses lowercase variables and does not use Node fetch's NODE_USE_ENV_PROXY switch. */
export function normalizeProxyEnv(env: NodeJS.ProcessEnv): void {
  for (const name of ['grpc_proxy', 'https_proxy', 'http_proxy', 'no_grpc_proxy', 'no_proxy']) {
    if (env[name] === undefined && env[name.toUpperCase()] !== undefined) env[name] = env[name.toUpperCase()];
  }
  const proxy = env.grpc_proxy || env.https_proxy || env.http_proxy;
  if (proxy && new URL(proxy).protocol !== 'http:') throw new Error('grpc-js requires an http:// CONNECT proxy; HTTPS_PROXY was not bypassed');
}

export function validateLightdInfo(info: LightdInfo, network: Network): void {
  if (info.chainName !== network) throw new Error(`lightwalletd network ${info.chainName} does not match ${network}`);
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(info.lightwalletProtocolVersion);
  if (!m || (+m[1] === 0 && +m[2] < 4)) {
    throw new Error(`lightwalletd ${info.lightwalletProtocolVersion || '(unknown protocol)'} cannot guarantee transparent compact data (requires >=0.4.0)`);
  }
}

export function openLightwalletd(network: Network, server?: string, timeoutMs = 30_000): Lightwalletd {
  normalizeProxyEnv(process.env);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('RPC timeout must be positive');
  const address = server ?? SERVERS[network];
  if (!address) throw new Error(`Specify a lightwalletd server for ${network}`);
  const dir = protoDir();
  const def = loader.loadSync(join(dir, 'service.proto'), { includeDirs: [dir], keepCase: true, longs: Number, enums: String, defaults: true });
  const rpc = (grpc.loadPackageDefinition(def) as any).cash.z.wallet.sdk.rpc;
  const client = new rpc.CompactTxStreamer(address, grpc.credentials.createSsl(), {
    'grpc.enable_http_proxy': (process.env.no_grpc_proxy ?? process.env.no_proxy)?.split(',').some(s => s.trim() === '*') ? 0 : 1,
  });
  const unary = (method: string, request: object): Promise<any> => new Promise((resolve, reject) => {
    client[method](request, { deadline: Date.now() + timeoutMs }, (error: Error | null, response: unknown) => error ? reject(error) : resolve(response));
  });
  let info: Promise<LightdInfo> | undefined;
  const readInfo = () => info ??= unary('GetLightdInfo', {}).then(value => { validateLightdInfo(value, network); return value; });
  return {
    info: readInfo,
    async blocks(from, to) {
      const info = await readInfo();
      const version = info.lightwalletProtocolVersion.replace(/^v/, '').split('.').map(Number);
      const poolTypes = ['TRANSPARENT', 'SAPLING', 'ORCHARD'];
      if (version[0] > 0 || version[1] >= 5) poolTypes.push('IRONWOOD');
      return new Promise((resolve, reject) => {
        const blocks: CompactBlock[] = [];
        const stream = client.GetBlockRange({ start: { height: from }, end: { height: to }, poolTypes }, { deadline: Date.now() + timeoutMs });
        stream.on('data', (b: any) => {
          try {
            if (Number(b.height) !== from + blocks.length || Number(b.height) > to) throw new Error('Incomplete or unordered compact block range');
            const txs = b.vtx.map((t: any): CompactTransaction => {
              if (t.txid.length !== 32) throw new Error('Invalid compact transaction ID');
              const outputCount = t.outputs.length + t.actions.length + (t.ironwoodActions?.length ?? 0);
              return {
                txid: Buffer.from(t.txid).reverse().toString('hex'), index: Number(t.index),
                shielded: t.spends.length + outputCount > 0, shieldedOutputs: outputCount > 0,
                vin: t.vin.map((v: any) => ({ txid: Buffer.from(v.prevoutTxid).reverse().toString('hex'), index: Number(v.prevoutIndex) })),
                vout: t.vout.map((o: any) => Number(o.value)),
              };
            });
            blocks.push({ height: Number(b.height), time: Number(b.time), txs });
          } catch (error) { reject(error); stream.cancel(); }
        });
        stream.on('error', reject);
        stream.on('end', () => blocks.length === to - from + 1 ? resolve(blocks) : reject(new Error(`Incomplete compact range: expected ${to - from + 1} blocks, received ${blocks.length}`)));
      });
    },
    async transaction(txid) {
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('Invalid transaction ID');
      const raw = await unary('GetTransaction', { hash: Buffer.from(txid, 'hex').reverse() });
      if (!raw.data?.length) throw new Error(`GetTransaction returned no data for ${txid}`);
      return Buffer.from(raw.data);
    },
    close: () => client.close(),
  };
}
