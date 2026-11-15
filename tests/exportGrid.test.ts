import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_FILES } from '../src/contracts.ts';
import type { GridMeta, Stop } from '../src/contracts.ts';
import { parseGrid } from '../src/data/grid.ts';
import { MAX_SLOPE_DEG, SAND_COST_MULT, SOFT_COST_MULT } from '../src/engine/model.ts';
import { buildCost, lonLatToCell } from '../scripts/export-grid.ts';

const C = { maxSlopeDeg: 25, sandMult: 2, softMult: 1.3 };
const f32 = (...v: number[]) => new Float32Array(v);
const u8 = (...v: number[]) => new Uint8Array(v);

describe('buildCost', () => {
  it('blocks slopes over the max (Infinity); exactly at the max is still walkable', () => {
    const c = buildCost(f32(25.01, 40, 25), u8(0, 0, 0), u8(0, 0, 0), C);
    expect(c[0]).toBe(Infinity);
    expect(c[1]).toBe(Infinity);
    expect(c[2]).toBeCloseTo(4, 6); // 1 + 3·1²
  });

  it('flat rock costs 1', () => {
    expect(Array.from(buildCost(f32(0), u8(0), u8(0), C))).toEqual([1]);
  });

  it('sand doubles the cost; a non-finite slope is blocked', () => {
    const c = buildCost(f32(0, 12.5, NaN), u8(1, 1, 0), u8(0, 0, 0), C);
    expect(c[0]).toBe(2);
    expect(c[1]).toBeCloseTo((1 + 3 * 0.25) * 2, 6);
    expect(c[2]).toBe(Infinity);
  });

  it('soft ground applies only off sand (no double counting)', () => {
    const c = buildCost(f32(0, 0, 0), u8(0, 1, 1), u8(1, 1, 0), C);
    expect(c[0]).toBeCloseTo(1.3, 6); // soft only
    expect(c[1]).toBe(2); // sand + soft → sand only
    expect(c[2]).toBe(2); // sand only
  });

  it('preserves length and rejects mismatched inputs', () => {
    expect(buildCost(new Float32Array(1234), new Uint8Array(1234), new Uint8Array(1234), C)).toHaveLength(1234);
    expect(() => buildCost(f32(0, 0), u8(0), u8(0, 0), C)).toThrow(/length mismatch/);
  });

  it('defaults to the model.ts constants, which match the fixture grid', () => {
    expect([MAX_SLOPE_DEG, SAND_COST_MULT]).toEqual([25, 2]);
    expect(buildCost(f32(0, 0), u8(1, 0), u8(0, 1))).toEqual(f32(SAND_COST_MULT, SOFT_COST_MULT));
  });
});

describe('lonLatToCell', () => {
  it('maps the site.json habitat onto the M06 grid', () => {
    const gt = [4350447.209860891, 5, 0, 1096007.5323621645, 0, -5];
    expect(lonLatToCell(77.425, 18.452, 18.465, 3396190, gt)).toEqual({ x: 524, y: 454 });
    // NW corner of the site box is cell (0, 0).
    expect(lonLatToCell(77.37833, 18.4903, 18.465, 3396190, gt)).toEqual({ x: 0, y: 0 });
  });
});

describe('public/data matches the M01 formats', () => {
  const DIR = join(import.meta.dirname, '..', 'public', 'data', 'jezero');
  const read = (f: string) => readFileSync(join(DIR, f));
  const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  // The files are committed (M16), so this always runs; regenerate with `npm run export:grid`.
  it('loads through parseGrid (the same loader as the fixtures)', () => {
    const meta = JSON.parse(read(DATA_FILES.meta).toString('utf8')) as GridMeta;
    const grid = parseGrid(
      {
        meta,
        cost: ab(read(DATA_FILES.cost)),
        elevation: ab(read(DATA_FILES.elevation)),
        sand: ab(read(DATA_FILES.sand)),
        stops: JSON.parse(read(DATA_FILES.stops).toString('utf8')) as Stop[],
      },
      'basemap.png',
    );
    const { width: W, height: H } = grid.meta;

    // meta.json is exactly a GridMeta.
    expect(Object.keys(meta).sort()).toEqual(['cellSizeM', 'habitat', 'height', 'maxSlopeDeg', 'width']);
    expect(Object.keys(meta.habitat).sort()).toEqual(['x', 'y']);
    expect([W, H, meta.cellSizeM, meta.maxSlopeDeg]).toEqual([600, 600, 5, MAX_SLOPE_DEG]);

    // Byte sizes: Float32 = 4 bytes/cell, Uint8 = 1 byte/cell.
    expect(read(DATA_FILES.cost).byteLength).toBe(4 * W * H);
    expect(read(DATA_FILES.elevation).byteLength).toBe(4 * W * H);
    expect(read(DATA_FILES.sand).byteLength).toBe(W * H);

    // Little-endian, and the loader reads the same values.
    const costBuf = read(DATA_FILES.cost);
    for (const i of [0, 12345, W * H - 1]) expect(grid.cost[i]).toBe(costBuf.readFloatLE(i * 4));

    // Values: cost ≥ 1 or Infinity, sand 0/1, elevation finite, habitat walkable.
    expect(grid.cost.every((c) => c === Infinity || (Number.isFinite(c) && c >= 1))).toBe(true);
    expect(grid.sand.every((s) => s === 0 || s === 1)).toBe(true);
    expect(grid.elevation.every((e) => Number.isFinite(e))).toBe(true);
    expect(Number.isFinite(grid.cost[meta.habitat.y * W + meta.habitat.x]!)).toBe(true);
  });
});
