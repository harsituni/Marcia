import { describe, expect, it } from 'vitest';
import { SAND_TI_MAX, TI_NODATA, sandMask } from '../scripts/compute-sand.ts';

describe('sandMask', () => {
  it('flags TI strictly below the threshold; a value equal to it is not sand', () => {
    const t = 200;
    const m = sandMask(new Float32Array([199.9, 200, 200.1, 150, 280]), t);
    expect(Array.from(m)).toEqual([1, 0, 0, 1, 0]);
  });

  it('defaults to SAND_TI_MAX', () => {
    const m = sandMask(new Float32Array([SAND_TI_MAX - 1, SAND_TI_MAX, SAND_TI_MAX + 1]));
    expect(Array.from(m)).toEqual([1, 0, 0]);
  });

  it('treats nodata as not sand (TI_NODATA, NaN, ±Infinity, ≤ 0)', () => {
    const m = sandMask(new Float32Array([TI_NODATA, NaN, Infinity, -Infinity, 0, -5]), 200);
    expect(Array.from(m)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('returns one Uint8 per cell (width × height)', () => {
    const w = 37;
    const h = 23;
    const m = sandMask(new Float32Array(w * h).fill(180), 200);
    expect(m).toBeInstanceOf(Uint8Array);
    expect(m).toHaveLength(w * h);
    expect(m.every((v) => v === 1)).toBe(true);
  });
});
