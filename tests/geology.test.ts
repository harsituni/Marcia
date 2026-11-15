import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_UNITS, legendFor } from '../scripts/compute-geology.ts';
import { parseGeologyLegend } from '../src/map/geology.ts';

const dir = join(import.meta.dirname, '..', 'public', 'data', 'jezero');

describe('M30 geology layer', () => {
  it('geology.png is exactly the elevation grid (one pixel per cell)', () => {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { width: number; height: number };
    const png = readFileSync(join(dir, 'geology.png'));
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([meta.width, meta.height]);
    const elevCells = readFileSync(join(dir, 'elevation.bin')).byteLength / 4;
    expect(meta.width * meta.height).toBe(elevCells);
  });

  it('geology.json is a valid legend whose counts fit in the grid', () => {
    const legend = parseGeologyLegend(JSON.parse(readFileSync(join(dir, 'geology.json'), 'utf8')));
    expect(legend).not.toBeNull();
    const total = legend!.units.reduce((s, u) => s + u.cells, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(600 * 600);
    for (const u of legend!.units) expect(ALL_UNITS.some((a) => a.name === u.name && a.color === u.color)).toBe(true);
  });

  it('legendFor counts cells per unit and drops absent ones', () => {
    const l = legendFor(new Uint8Array([0, 1, 1, 3]));
    expect(l.map((u) => [u.value, u.cells])).toEqual([[1, 2], [3, 1]]);
  });

  it('parseGeologyLegend rejects malformed files', () => {
    expect(parseGeologyLegend(null)).toBeNull();
    expect(parseGeologyLegend({ source: 's', units: [{ name: 'x', kind: 'other', color: '#000000', cells: 1 }] })).toBeNull();
  });
});
