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
