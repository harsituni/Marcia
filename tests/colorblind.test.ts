import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_DELTA_E, SAFE_COLORS, VISIONS, closestPair, colorFor, deltaE, feColorMatrix, hexToLinear, recolorPixels, simulate } from '../src/map/colorblind.ts';
import { COLORS } from '../src/map/overlays.ts';

const json = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'public', 'data', 'jezero', f), 'utf8'));

/** Plan-mode layers whose colours must stay apart for every vision type. */
const LAYERS: Record<string, { name: string; color: string }[]> = {
  'Walking difficulty': [
    { name: 'easy', color: COLORS.easy },
    { name: 'caution', color: COLORS.caution },
    { name: 'no-go', color: COLORS.noGo },
  ],
};

/**
 * Layers that keep their original colours on purpose (the team chose to keep
 * them for normal vision), and that FAIL the check: some unit pairs are under
 * ΔE 15 for some vision types. `it.fails` records that; if the palette is ever
 * made colour-blind-safe these start failing, and should move to LAYERS.
 */
const KNOWN_CLASHES: Record<string, { name: string; color: string }[]> = {
  Geology: (json('geology.json').units as { name: string; color: string }[]).map(({ name, color }) => ({ name, color })),
  'CRISM minerals': (json('crism.json').categories as { name: string; color: string }[]).map(({ name, color }) => ({ name, color })),
};

/** Which vision types each kept palette fails for (closest pair ΔE: geology 7.2 / 4.4 / 4.0 / 4.8, CRISM 12.2 protan / 6.2 deutan). */
const CLASHES: Record<string, readonly (typeof VISIONS)[number][]> = {
  Geology: ['normal', 'protanopia', 'deuteranopia', 'tritanopia'],
  'CRISM minerals': ['protanopia', 'deuteranopia'],
};

const check = (colors: { name: string; color: string }[], vision: (typeof VISIONS)[number]) => {
  expect(colors.length).toBeGreaterThan(1);
  const p = closestPair(colors, vision);
  expect(p.deltaE, `${p.a} vs ${p.b}: ΔE ${p.deltaE.toFixed(1)}`).toBeGreaterThanOrEqual(MIN_DELTA_E);
};

describe('M34: Plan-mode layer colours under a colour-blindness simulator', () => {
  for (const [layer, colors] of Object.entries(LAYERS))
    for (const vision of VISIONS) it(`${layer}: every pair stays apart for ${vision} (ΔE ≥ ${MIN_DELTA_E})`, () => check(colors, vision));
  for (const [layer, colors] of Object.entries(KNOWN_CLASHES))
    for (const vision of VISIONS)
      if (CLASHES[layer]!.includes(vision)) it.fails(`${layer}: known clash for ${vision} (original colours kept)`, () => check(colors, vision));
      else it(`${layer}: every pair stays apart for ${vision} (ΔE ≥ ${MIN_DELTA_E})`, () => check(colors, vision));
});

describe('M34: colour-blind-safe palettes used when a colour vision is chosen', () => {
  for (const [layer, colors] of Object.entries(KNOWN_CLASHES)) {
    it(`${layer}: every legend entry has a safe colour`, () => {
      for (const c of colors) expect(SAFE_COLORS[c.name], c.name).toMatch(/^#[0-9a-f]{6}$/i);
    });
    for (const vision of VISIONS.filter((v) => v !== 'normal'))
      it(`${layer}: safe colours stay apart for ${vision} (ΔE ≥ ${MIN_DELTA_E})`, () =>
        check(colors.map((c) => ({ name: c.name, color: colorFor(c.name, c.color, vision) })), vision));
  }

  it('normal vision keeps the original colours', () => {
    expect(colorFor('Carbonates', '#e9c46a', 'normal')).toBe('#e9c46a');
    expect(colorFor('Carbonates', '#e9c46a', 'deuteranopia')).toBe(SAFE_COLORS.Carbonates);
    expect(colorFor('Not a unit', '#123456', 'protanopia')).toBe('#123456');
  });

  it('recolorPixels swaps exact matches only and skips transparent pixels', () => {
    const px = new Uint8ClampedArray([0xe9, 0xc4, 0x6a, 255, 0xe9, 0xc4, 0x6a, 0, 1, 2, 3, 255]);
    recolorPixels(px, [{ from: '#e9c46a', to: '#DDCC77' }]);
    expect([...px]).toEqual([0xdd, 0xcc, 0x77, 255, 0xe9, 0xc4, 0x6a, 0, 1, 2, 3, 255]);
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
