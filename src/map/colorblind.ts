/**
 * M34: colour-vision-deficiency simulator, used to check the Plan-mode layer
 * colours (tests/colorblind.test.ts) and as an in-app preview (Layers panel).
 *
 * Matrices: Machado, Oliveira & Fernandes (2009), "A Physiologically-based
 * Model for Simulation of Color Vision Deficiency", IEEE TVCG 15(6),
 * 1291–1298, https://doi.org/10.1109/TVCG.2009.113 — severity 1.0
 * (dichromacy) for protanopia, deuteranopia and tritanopia. They act on
 * linear RGB, so colours are linearized from sRGB first.
 */
export type Vision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export const VISIONS: readonly Vision[] = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];

type M3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
export const CVD_MATRICES: Record<Exclude<Vision, 'normal'>, M3> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

/**
 * Smallest CIE76 ΔE allowed between two colours of one layer under every
 * vision type. ~2.3 is a just-noticeable difference; 15 keeps map categories
 * clearly apart when drawn semi-transparent over the basemap.
 */
export const MIN_DELTA_E = 15;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** `#rrggbb` → linear RGB in 0..1. */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}

/** Linear RGB as seen with `vision` (clamped to 0..1). */
export function simulate(rgb: readonly [number, number, number], vision: Vision): [number, number, number] {
  if (vision === 'normal') return [...rgb];
  const m = CVD_MATRICES[vision];
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [0, 1, 2].map((i) => c(m[i]![0] * rgb[0] + m[i]![1] * rgb[1] + m[i]![2] * rgb[2])) as [number, number, number];
}

/** Linear RGB (sRGB primaries, D65) → CIELAB. */
export function linearToLab([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference between two hex colours as seen with `vision`. */
export function deltaE(a: string, b: string, vision: Vision = 'normal'): number {
  const la = linearToLab(simulate(hexToLinear(a), vision));
  const lb = linearToLab(simulate(hexToLinear(b), vision));
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/** The closest pair of `colors` under `vision`, with its ΔE. */
export function closestPair(colors: readonly { name: string; color: string }[], vision: Vision): { a: string; b: string; deltaE: number } {
  let best = { a: '', b: '', deltaE: Infinity };
  for (let i = 0; i < colors.length; i++)
    for (let j = i + 1; j < colors.length; j++) {
      const d = deltaE(colors[i]!.color, colors[j]!.color, vision);
      if (d < best.deltaE) best = { a: colors[i]!.name, b: colors[j]!.name, deltaE: d };
    }
  return best;
}

/** `values` for an SVG `<feColorMatrix type="matrix">` (filters work in linear RGB by default). */
export function feColorMatrix(vision: Exclude<Vision, 'normal'>): string {
  return CVD_MATRICES[vision].map((row) => `${row.join(' ')} 0 0`).join(' ') + ' 0 0 0 1 0';
}

/**
 * Colour-blind-safe replacements, used when the crew picks a colour-vision type
 * other than normal. Paul Tol's "muted" qualitative scheme
 * (https://personal.sron.nl/~pault/), keyed by geology unit / CRISM category
 * name. tests/colorblind.test.ts checks every layer stays apart (ΔE ≥ 15)
 * under every vision type with these colours.
 */
export const SAFE_COLORS: Readonly<Record<string, string>> = {
  // Geology (Stack et al. 2020 units on the Jezero grid)
  'Crater floor fractured 1': '#332288',
  'Crater floor fractured 2': '#AA4499',
  'Delta blocky': '#117733',
  'Delta thinly layered': '#44AA99',
  'Delta truncated curvilinear layered': '#88CCEE',
  'Undifferentiated smooth': '#DDDDDD',
  'Moderate Cover Us': '#882255',
  Talus: '#999933',
  'Aeolian bedforms, large': '#DDCC77',
  'Aeolian bedforms, small': '#CC6677',
  // CRISM mineral categories
  'Olivine and olivine mixtures': '#117733',
  Carbonates: '#DDCC77',
  Smectites: '#88CCEE',
  Pyroxenes: '#CC6677',
  Kaolinite: '#AA4499',
};

/** The colour to draw a legend entry with for `vision`: the original for normal vision, else its safe replacement. */
export function colorFor(name: string, original: string, vision: Vision): string {
  return vision === 'normal' ? original : (SAFE_COLORS[name] ?? original);
}

const rgbKey = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/**
 * Swaps colours in RGBA pixel data in place: every opaque-ish pixel whose RGB
 * exactly matches an entry's `from` becomes its `to`; others are left alone.
 */
export function recolorPixels(data: Uint8ClampedArray, swaps: readonly { from: string; to: string }[]): void {
  const map = new Map<number, number>();
  for (const s of swaps) map.set(parseInt(s.from.replace('#', ''), 16), parseInt(s.to.replace('#', ''), 16));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const to = map.get(rgbKey(data[i]!, data[i + 1]!, data[i + 2]!));
    if (to === undefined) continue;
    data[i] = (to >> 16) & 255;
    data[i + 1] = (to >> 8) & 255;
    data[i + 2] = to & 255;
  }
}
