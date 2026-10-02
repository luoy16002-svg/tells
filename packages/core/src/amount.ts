import { ZAT } from './types';

/** "1.2345" style ZEC string without trailing zeros. */
export function zec(zats: number): string {
  const sign = zats < 0 ? '-' : '';
  const abs = Math.abs(Math.round(zats));
  const whole = Math.floor(abs / ZAT);
  const frac = String(abs % ZAT).padStart(8, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? '.' + frac : ''}`;
}

/** Number of significant decimal places in the ZEC amount (0 to 8). */
export function decimals(zats: number): number {
  const frac = String(Math.abs(Math.round(zats)) % ZAT).padStart(8, '0').replace(/0+$/, '');
  return frac.length;
}

/**
 * How easy an amount is to pick out on the chain.
 * Round amounts (up to two decimals) are shared by many users; four or more decimals are close to unique.
 */
export function distinctiveness(zats: number): 'common' | 'notable' | 'unique' {
  // "1 ZEC minus a fee" (0.9999) is as common as 1 ZEC itself
  const nearest = Math.round(zats / 1_000_000) * 1_000_000;
  if (nearest > 0 && Math.abs(zats - nearest) <= 50_000) return 'common';
  const d = decimals(zats);
  if (d <= 2) return 'common';
  if (d <= 3) return 'notable';
  return 'unique';
}

/** Two crossing amounts that differ by no more than a typical fee (or 0.1 % for large amounts) look like the same coins. */
export function sameCoins(a: number, b: number): boolean {
  const tol = Math.max(100_000, Math.round(Math.max(a, b) * 0.001));
  return Math.abs(a - b) <= tol;
}

const DENOMS = [1_000_000, 2_500_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000, 200_000_000, 500_000_000, 1_000_000_000, 2_500_000_000, 5_000_000_000, 10_000_000_000];

/** The largest common denomination multiple at or below the amount (for example 2.731 ZEC -> 2.5 ZEC). */
export function roundDown(zats: number): number {
  let best = 0;
  for (const d of DENOMS) {
    if (d > zats) break;
    const m = Math.floor(zats / d) * d;
    // prefer multiples that keep the amount short: 2.5 over 2.7, 7 over 7.25
    if (decimals(m) <= 2 && m > best && (m >= zats * 0.6 || best === 0)) best = m;
  }
  return best;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${(s / 3600).toFixed(s < 36_000 ? 1 : 0)} h`;
  return `${(s / 86_400).toFixed(s < 864_000 ? 1 : 0)} days`;
}
