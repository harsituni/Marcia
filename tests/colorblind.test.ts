import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_DELTA_E, SAFE_PALETTES, VISIONS, closestPair, colorFor, deltaE, hexToLinear, recolorPixels, simulate } from '../src/map/colorblind.ts';
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
 * Layers whose ORIGINAL colours (kept for "Normal" colour vision) fail the
 * check: some pairs are under ΔE 15. `it.fails` records that. When the crew
 * picks a colour vision, these layers switch to SAFE_COLORS, checked below.
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
  const TYPES = VISIONS.filter((v): v is Exclude<(typeof VISIONS)[number], 'normal'> => v !== 'normal');
  for (const [layer, colors] of Object.entries(KNOWN_CLASHES))
    for (const vision of TYPES) {
      it(`${layer}: the ${vision} palette has a colour for every entry`, () => {
        for (const c of colors) expect(SAFE_PALETTES[vision][c.name], c.name).toMatch(/^#[0-9a-f]{6}$/i);
      });
      it(`${layer}: the ${vision} palette stays apart under ${vision} (ΔE ≥ ${MIN_DELTA_E})`, () =>
        check(colors.map((c) => ({ name: c.name, color: colorFor(c.name, c.color, vision) })), vision));
    }

  it('each vision type gets a different palette', () => {
    for (const [layer, colors] of Object.entries(KNOWN_CLASHES))
      for (const [i, a] of TYPES.entries())
        for (const b of TYPES.slice(i + 1))
          expect(
            colors.some((c) => SAFE_PALETTES[a][c.name] !== SAFE_PALETTES[b][c.name]),
            `${layer}: ${a} vs ${b}`,
          ).toBe(true);
  });

  it('normal vision keeps the original colours', () => {
    for (const colors of Object.values(KNOWN_CLASHES)) for (const c of colors) expect(colorFor(c.name, c.color, 'normal')).toBe(c.color);
    expect(colorFor('Carbonates', '#e9c46a', 'deuteranopia')).toBe(SAFE_PALETTES.deuteranopia.Carbonates);
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
});
