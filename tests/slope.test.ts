import { describe, expect, it } from 'vitest';
import { hornSlopeDeg } from '../scripts/compute-slope.ts';

const CELL = 5;

/** Elevation grid from a function of the cell (x, y). */
function grid(w: number, h: number, z: (x: number, y: number) => number): Float32Array {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = z(x, y);
  return a;
}

describe('hornSlopeDeg', () => {
  it('is 0° everywhere on a flat plane', () => {
    const s = hornSlopeDeg(grid(7, 5, () => -2500), 7, 5, CELL);
    expect(Array.from(s).every((v) => v === 0)).toBe(true);
  });

  it('is 45° on a plane rising 5 m per 5 m cell (east, south and diagonal)', () => {
    for (const z of [(x: number) => 5 * x, (_x: number, y: number) => 5 * y]) {
      const s = hornSlopeDeg(grid(8, 6, z), 8, 6, CELL);
      // Edges are linearly extrapolated (as gdaldem -compute_edges), so every non-corner cell is 45°.
      for (let y = 0; y < 6; y++) {
        for (let x = 0; x < 8; x++) {
          const corner = (x === 0 || x === 7) && (y === 0 || y === 5);
          if (!corner) expect(s[y * 8 + x]!).toBeCloseTo(45, 1);
        }
      }
    }
    // gdaldem repeats the edge column at the ends of the first/last row, so an
    // east-rising plane's corners see half the x-gradient: atan(0.5) ≈ 26.57°.
    const east = hornSlopeDeg(grid(8, 6, (x) => 5 * x), 8, 6, CELL);
    expect(east[0]!).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 2);
    // 5 m per cell along both axes: gradient √2 → atan(√2) ≈ 54.74°.
    const d = hornSlopeDeg(grid(6, 6, (x, y) => 5 * x + 5 * y), 6, 6, CELL);
    expect(d[2 * 6 + 2]!).toBeCloseTo((Math.atan(Math.SQRT2) * 180) / Math.PI, 1);
  });

  it('returns width × height cells, and rejects a mismatched input', () => {
    const w = 13;
    const h = 9;
    expect(hornSlopeDeg(grid(w, h, (x) => x), w, h, CELL)).toHaveLength(w * h);
    expect(() => hornSlopeDeg(new Float32Array(10), w, h, CELL)).toThrow(/expected 117/);
  });

  it('marks cells next to a non-finite elevation as NaN', () => {
    const e = grid(5, 5, () => 0);
    e[2 * 5 + 2] = NaN;
    const s = hornSlopeDeg(e, 5, 5, CELL);
    expect(Number.isNaN(s[2 * 5 + 2]!)).toBe(true);
    expect(Number.isNaN(s[1 * 5 + 1]!)).toBe(true);
    expect(s[0]).toBe(0);
  });
});
