// Illustrative histories, built to show each tell once. The testnet sample (real transactions) is loaded from JSON.
import { ZAT, type Flow, type History, type WalletTx } from '@tells/core';

const z = (v: number) => Math.round(v * ZAT);
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
let height = 3_092_000;
const tx = (id: string, iso: string, spent: Flow[], received: Flow[], sent: Flow[] = []): WalletTx =>
  ({ txid: id.padEnd(64, '0'), height: height += 37, time: at(iso), fee: 15_000, spent, received, sent });
const t = (v: number, address: string): Flow => ({ pool: 'transparent', value: z(v), address });
const o = (v: number, change = false): Flow => ({ pool: 'orchard', value: z(v), change });
const s = (v: number): Flow => ({ pool: 'sapling', value: z(v) });

const EXCH_OUT = 't1Rv4exchangeWithdrawals7pQ2';
const EXCH_IN = 't1KxDeposit5f8bQ3exchangeLp9';
const OWN = 't1My3wallet8qTransparent2aB';

export const exchangeUser: History = {
  network: 'main',
  label: 'Exchange regular (illustrative)',
  txs: [
    tx('a1sapling', '2026-09-14T08:20:00Z', [], [s(3.1)]),
    tx('b2receive', '2026-09-21T09:12:00Z', [], [t(2.48311, OWN)]),
    tx('c3shield', '2026-09-21T09:40:00Z', [t(2.48311, OWN)], [o(2.48296)]),
    tx('d4pay', '2026-09-21T10:25:00Z', [o(2.48296)], [o(2.13281, true)], [o(0.35)]),
    tx('e5exit', '2026-09-21T11:02:00Z', [o(2.13281)], [o(0.93266, true)], [t(1.2, EXCH_IN)]),
    tx('f6receive', '2026-09-24T14:10:00Z', [], [t(0.75, OWN), t(0.5, OWN)]),
    tx('g7shield', '2026-09-24T14:30:00Z', [t(0.75, OWN)], [o(0.74985)]),
    tx('h8shield', '2026-09-24T15:05:00Z', [t(0.5, OWN)], [o(0.49985)]),
    tx('i9exit', '2026-09-24T19:40:00Z', [o(0.74985), o(0.49985)], [o(0.00002, true)], [t(1.24953, EXCH_IN)]),
    tx('j0migrate', '2026-09-29T07:15:00Z', [s(3.1)], [o(3.09985)]),
    tx('k1receive', '2026-10-01T16:00:00Z', [], [t(0.123456, 't1Fresh6deposit4Wz9')]),
    tx('l2shield', '2026-10-01T16:20:00Z', [t(0.123456, 't1Fresh6deposit4Wz9')], [o(0.123306)]),
    tx('m3exit', '2026-10-01T16:45:00Z', [o(0.123306)], [], [t(0.123156, 't1Cafe8merchant2Lk5')]),
    tx('n4plain', '2026-10-02T12:00:00Z', [t(0.2, 't1Old9transparentBuy3')], [], [t(0.19985, 't1Friend2payment7Hs')]),
    tx('o5receive', '2026-10-02T17:40:00Z', [], [t(0.54321, 't1Ex3newWithdrawal5Ty')]),
    tx('p6shield', '2026-10-02T18:05:00Z', [t(0.54321, 't1Ex3newWithdrawal5Ty')], [o(0.54306)]),
  ],
};

export const carefulUser: History = {
  network: 'main',
  label: 'Careful saver (illustrative)',
  txs: [
    tx('p1receive', '2026-09-02T10:00:00Z', [], [t(5, 't1Ex7withdrawalOnce4Ra')]),
    tx('q2shield', '2026-09-02T10:30:00Z', [t(5, 't1Ex7withdrawalOnce4Ra')], [o(4.99985)]),
    tx('r3pay', '2026-09-06T18:10:00Z', [o(4.99985)], [o(4.24970, true)], [o(0.75)]),
    tx('s4pay', '2026-09-15T12:45:00Z', [o(4.24970)], [o(3.99955, true)], [o(0.25)]),
    tx('t5exit', '2026-09-27T09:20:00Z', [o(3.99955)], [o(2.49940, true)], [t(1.5, 't1Ex9deposit2fresh8Kd')]),
    tx('u6pay', '2026-10-01T20:05:00Z', [o(2.49940)], [o(1.49925, true)], [o(1)]),
  ],
};
