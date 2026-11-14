import { describe, expect, it } from 'vitest';
import { extentDiff, extentFromGeoTransform, percentile } from '../scripts/export-basemap.ts';

describe('extentFromGeoTransform', () => {
  it('gives the M06 grid extent (600 × 600 at 5 m, north-up)', () => {
    const gt = [4350447.209860891, 5, 0, 1096007.5323621645, 0, -5];
    expect(extentFromGeoTransform(gt, 600, 600)).toEqual({
      minX: 4350447.209860891,
      maxX: 4350447.209860891 + 3000,
      minY: 1096007.5323621645 - 3000,
      maxY: 1096007.5323621645,
    });
  });

  it('is the same area at a finer resolution (1500 × 1500 at 2 m)', () => {
    const a = extentFromGeoTransform([100, 5, 0, 500, 0, -5], 600, 600);
    const b = extentFromGeoTransform([100, 2, 0, 500, 0, -2], 1500, 1500);
    expect(extentDiff(a, b)).toBe(0);
  });

  it('handles a south-up raster and rejects rotation', () => {
    expect(extentFromGeoTransform([0, 1, 0, 0, 0, 1], 10, 20)).toEqual({ minX: 0, maxX: 10, minY: 0, maxY: 20 });
    expect(() => extentFromGeoTransform([0, 1, 0.1, 0, 0, -1], 10, 10)).toThrow(/rotated/);
  });
});

describe('percentile', () => {
  it('uses nearest rank and skips the nodata value', () => {
    const v = [0, 0, ...Array.from({ length: 100 }, (_, i) => i + 1)]; // 1..100 plus two nodata zeros
    expect(percentile(v, 2, 0)).toBe(2);
    expect(percentile(v, 98, 0)).toBe(98);
    expect(percentile(v, 100, 0)).toBe(100);
    expect(percentile(v, 0, 0)).toBe(1);
  });

  it('is NaN when everything is nodata', () => {
    expect(percentile([0, 0, 0], 50, 0)).toBeNaN();
  });
});
