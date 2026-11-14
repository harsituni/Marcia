import { describe, expect, it } from 'vitest';
import { SAND_UNITS, SMOOTH_UNITS, TI_NODATA, softGroundMask, unitWhere } from '../scripts/compute-sand.ts';
import { SOFT_GROUND_TI_MAX } from '../src/engine/model.ts';

describe('softGroundMask', () => {
  it('flags TI strictly below the threshold; a value equal to it is not soft', () => {
    const m = softGroundMask(new Float32Array([199.9, 200, 200.1, 150, 280]), 200);
    expect(Array.from(m)).toEqual([1, 0, 0, 1, 0]);
  });

  it('defaults to SOFT_GROUND_TI_MAX from model.ts', () => {
    const t = SOFT_GROUND_TI_MAX;
    const m = softGroundMask(new Float32Array([t - 1, t, t + 1]));
    expect(Array.from(m)).toEqual([1, 0, 0]);
  });

  it('treats nodata as not soft (TI_NODATA, NaN, ±Infinity, ≤ 0)', () => {
    const m = softGroundMask(new Float32Array([TI_NODATA, NaN, Infinity, -Infinity, 0, -5]), 200);
    expect(Array.from(m)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('returns one Uint8 per cell (width × height)', () => {
    const w = 37;
    const h = 23;
    const m = softGroundMask(new Float32Array(w * h).fill(180), 200);
    expect(m).toBeInstanceOf(Uint8Array);
    expect(m).toHaveLength(w * h);
    expect(m.every((v) => v === 1)).toBe(true);
  });
});

describe('geology unit selection', () => {
  it('selects the two aeolian bedform units (Ab-l, Ab-s) by their SurfUName text', () => {
    expect(SAND_UNITS).toEqual(['Aeolian bedforms, large', 'Aeolian bedforms, small']);
    expect(unitWhere(SAND_UNITS)).toBe("SurfUName IN ('Aeolian bedforms, large', 'Aeolian bedforms, small')");
  });

  it('keeps the smooth / Us units separate from sand', () => {
    expect(SMOOTH_UNITS.some((u) => (SAND_UNITS as readonly string[]).includes(u))).toBe(false);
  });

  it("escapes single quotes in unit names", () => {
    expect(unitWhere(["O'Brien unit"])).toBe("SurfUName IN ('O''Brien unit')");
  });
});
