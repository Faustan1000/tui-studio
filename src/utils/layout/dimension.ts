// Width/height values: a number of cells, 'auto', 'fill' or a percentage like '20%'

export type Percent = `${number}%`;
export type Dimension = number | 'auto' | 'fill' | Percent;

const PERCENT = /^(\d{1,3}(?:\.\d+)?)%$/;

/** The number of a percentage between 0 (exclusive) and 100, or null for anything else. */
export function parsePercent(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = PERCENT.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= 100 ? n : null;
}

export function isPercent(value: unknown): value is Percent {
  return parsePercent(value) !== null;
}

/**
 * Cells for a percentage of `base`. Rounded down (so that 3 x 33% still fits), at least 1 cell;
 * the leftover cells stay empty.
 */
export function resolvePercent(percent: number, base: number): number {
  return Math.max(1, Math.floor((base * percent) / 100));
}

/** Resolves a percentage dimension against `base`; other values are returned unchanged. */
export function resolveDimension<T>(value: T, base: number): T | number {
  const p = parsePercent(value);
  return p === null ? value : resolvePercent(p, base);
}
