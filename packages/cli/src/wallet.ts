// Reads a zcash_client_sqlite wallet (as written by zcash-devtool) and turns one account into a Tells history.
// Nothing here talks to the network; the wallet must already be synced.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Flow, History, Network, Pool, WalletTx } from '@tells/core';

const POOL: Record<number, Pool> = { 0: 'transparent', 2: 'sapling', 3: 'orchard', 4: 'ironwood' };

type Row = Record<string, unknown>;
const hex = (b: unknown) => Buffer.from(b as Uint8Array).toString('hex');
const txidHex = (b: unknown) => Buffer.from(b as Uint8Array).reverse().toString('hex');

export interface WalletAccount { uuid: string; name: string | null }

function open(walletDir: string) {
  const file = join(walletDir, 'data.sqlite');
  if (!existsSync(file)) throw new Error(`No wallet database at ${file}`);
  return new DatabaseSync(file, { readOnly: true });
}

export function walletNetwork(walletDir: string): Network {
  const keys = join(walletDir, 'keys.toml');
  const m = existsSync(keys) ? /network\s*=\s*"(\w+)"/.exec(readFileSync(keys, 'utf8')) : null;
  return (m?.[1] as Network) ?? 'main';
}

export function listAccounts(walletDir: string): WalletAccount[] {
  const db = open(walletDir);
  try {
    return (db.prepare('SELECT uuid, name FROM accounts ORDER BY id').all() as Row[]).map(r => ({ uuid: uuidOf(r.uuid), name: (r.name as string) ?? null }));
  } finally {
    db.close();
  }
}

function uuidOf(b: unknown) {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function readHistory(walletDir: string, opts: { account?: string; label?: string } = {}): History {
  const db = open(walletDir);
  try {
    const accounts = db.prepare('SELECT id, uuid, name FROM accounts ORDER BY id').all() as Row[];
    if (!accounts.length) throw new Error('The wallet has no accounts');
    const account = opts.account ? accounts.find(a => uuidOf(a.uuid) === opts.account) : accounts[0];
    if (!account) throw new Error(`No account ${opts.account} in this wallet`);
    const acc = account.id as number;

    const txRows = db.prepare(`
      SELECT t.id_tx, t.txid, t.mined_height, t.fee, b.time
      FROM transactions t LEFT JOIN blocks b ON b.height = t.mined_height
      WHERE t.id_tx IN (
        SELECT transaction_id FROM v_received_outputs WHERE account_id = :acc
        UNION SELECT transaction_id FROM v_received_output_spends WHERE account_id = :acc
        UNION SELECT transaction_id FROM sent_notes WHERE from_account_id = :acc)
      ORDER BY t.mined_height IS NULL, t.mined_height, t.tx_index`).all({ acc }) as Row[];

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

    const flow = (r: Row, change?: boolean): Flow => {
      const pool = POOL[r.pool as number] ?? 'orchard';
      const f: Flow = { pool, value: Number(r.value) };
      if (pool === 'transparent' && r.addr) f.address = String(r.addr);
      if (change) f.change = true;
      return f;
    };

    const txs: WalletTx[] = txRows.map(t => {
      const args = { tx: t.id_tx as number, acc };
      return {
        txid: txidHex(t.txid),
        height: (t.mined_height as number | null) ?? null,
        time: (t.time as number | null) ?? null,
        fee: t.fee == null ? null : Number(t.fee),
        spent: (spent.all(args) as Row[]).map(r => flow(r)),
        received: (received.all(args) as Row[]).map(r => flow(r, Boolean(r.is_change))),
        sent: (sent.all(args) as Row[]).map(r => flow(r)),
      };
    });
    fillTimes(db, txs);
    return { network: walletNetwork(walletDir), label: opts.label ?? ((account.name as string) || undefined), txs };
  } finally {
    db.close();
  }
}

/**
 * The wallet only keeps some block headers. For a mined transaction without a stored block time,
 * estimate it from the nearest stored block and the 75-second target spacing (good to a few minutes).
 */
function fillTimes(db: DatabaseSync, txs: WalletTx[]) {
  const known = db.prepare('SELECT height, time FROM blocks ORDER BY height').all() as Row[];
  if (!known.length) return;
  for (const tx of txs) {
    if (tx.height == null || tx.time != null) continue;
    let near = known[0];
    for (const k of known) if (Math.abs((k.height as number) - tx.height) < Math.abs((near.height as number) - tx.height)) near = k;
    tx.time = (near.time as number) + (tx.height - (near.height as number)) * 75;
  }
}
