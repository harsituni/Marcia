import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRISM_CATEGORIES, classifyRgb, classifyRgbRaster, legendFor } from '../scripts/compute-crism.ts';
import { parseCrismLegend } from '../src/map/crism.ts';

const dir = join(import.meta.dirname, '..', 'public', 'data', 'jezero');

describe('M30 CRISM layer', () => {
  it('crism.png matches the 600 x 600 Jezero grid', () => {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { width: number; height: number };
    const png = readFileSync(join(dir, 'crism.png'));
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([meta.width, meta.height]);
  });

  it('crism.json includes valid categories and a full source citation', () => {
    const raw = JSON.parse(readFileSync(join(dir, 'crism.json'), 'utf8')) as unknown;
    const legend = parseCrismLegend(raw);
    expect(legend).not.toBeNull();
    expect(legend!.source).toContain('Parente');
    expect(legend!.source).toContain('10.5281/zenodo.5575824');
    expect(legend!.source).toContain('CC BY 4.0');
    expect(legend!.categories.length).toBeGreaterThan(0);
    expect(legend!.categories.reduce((sum, category) => sum + category.cells, 0)).toBeLessThanOrEqual(600 * 600);
    for (const category of legend!.categories)
      expect(CRISM_CATEGORIES.some((expected) => expected.name === category.name && expected.color === category.color)).toBe(true);
  });

  it('maps published prototype colours into mineral families and preserves unmapped pixels', () => {
    expect(classifyRgb(255, 0, 0)).toBe(1);
    expect(classifyRgb(0, 153, 0)).toBe(2);
    expect(classifyRgb(0, 255, 255)).toBe(3);
    expect(classifyRgb(255, 128, 0)).toBe(4);
    expect(classifyRgb(139, 69, 19)).toBe(5);
    expect(classifyRgb(0, 0, 0)).toBe(0);
    expect(classifyRgb(255, 255, 255)).toBe(0);
    expect([...classifyRgbRaster(new Uint8Array([255, 255]), new Uint8Array([0, 255]), new Uint8Array([0, 255]))]).toEqual([1, 0]);
    expect(legendFor(new Uint8Array([0, 1, 1, 3])).map((category) => [category.name, category.cells])).toEqual([
      ['Olivine and olivine mixtures', 2],
      ['Smectites', 1],
    ]);
  });

  it('rejects malformed legends', () => {
    expect(parseCrismLegend(null)).toBeNull();
    expect(parseCrismLegend({ source: 's', note: 'n', categories: [{ name: 'x', color: 'bad', classes: [], cells: 1 }] })).toBeNull();
  });
});
