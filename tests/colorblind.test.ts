import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_DELTA_E, VISIONS, closestPair, deltaE, feColorMatrix, hexToLinear, simulate } from '../src/map/colorblind.ts';
import { COLORS } from '../src/map/overlays.ts';

const json = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'public', 'data', 'jezero', f), 'utf8'));

/** Every Plan-mode layer whose colours carry meaning on their own. */
const LAYERS: Record<string, { name: string; color: string }[]> = {
  'Walking difficulty': [
    { name: 'easy', color: COLORS.easy },
    { name: 'caution', color: COLORS.caution },
    { name: 'no-go', color: COLORS.noGo },
  ],
  Geology: (json('geology.json').units as { name: string; color: string }[]).map(({ name, color }) => ({ name, color })),
  'CRISM minerals': (json('crism.json').categories as { name: string; color: string }[]).map(({ name, color }) => ({ name, color })),
};

describe('M34: Plan-mode layer colours under a colour-blindness simulator', () => {
  for (const [layer, colors] of Object.entries(LAYERS))
    for (const vision of VISIONS)
      it(`${layer}: every pair stays apart for ${vision} (ΔE ≥ ${MIN_DELTA_E})`, () => {
        expect(colors.length).toBeGreaterThan(1);
        const p = closestPair(colors, vision);
        expect(p.deltaE, `${p.a} vs ${p.b}: ΔE ${p.deltaE.toFixed(1)}`).toBeGreaterThanOrEqual(MIN_DELTA_E);
      });
});

describe('simulator', () => {
  it('keeps greys grey (matrix rows sum to 1)', () => {
    for (const v of VISIONS) for (const c of simulate(hexToLinear('#808080'), v)) expect(c).toBeCloseTo(hexToLinear('#808080')[0], 2);
  });
  it('collapses red and green for protan/deutan but not for normal vision', () => {
    expect(deltaE('#cc3333', '#668800')).toBeGreaterThan(40);
    expect(deltaE('#cc3333', '#668800', 'deuteranopia')).toBeLessThan(deltaE('#cc3333', '#668800') / 2);
  });
  it('builds a 4x5 SVG colour matrix', () => {
    expect(feColorMatrix('tritanopia').split(' ')).toHaveLength(20);
  });
});
