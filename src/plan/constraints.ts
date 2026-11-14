import type { Constraints } from '../contracts.ts';

/** Slider ranges for the settings panel. Max slope's upper end is the grid's own limit. */
export const LIMITS = {
  oxygenMin: { min: 60, max: 600, step: 15 },
  reservePct: { min: 0, max: 50, step: 5 },
  maxSlopeDeg: { min: 5, step: 1 },
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Keeps constraints in range. `gridMaxSlopeDeg` is `GridMeta.maxSlopeDeg`:
 * `cost.bin` already blocks steeper cells, so the crew limit can only be
 * stricter than that.
 */
export function clampConstraints(c: Constraints, gridMaxSlopeDeg: number): Constraints {
  const num = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  return {
    oxygenMin: clamp(num(c.oxygenMin, LIMITS.oxygenMin.min), LIMITS.oxygenMin.min, LIMITS.oxygenMin.max),
    reservePct: clamp(num(c.reservePct, 0), LIMITS.reservePct.min, LIMITS.reservePct.max),
    maxSlopeDeg: clamp(num(c.maxSlopeDeg, gridMaxSlopeDeg), LIMITS.maxSlopeDeg.min, gridMaxSlopeDeg),
  };
}
