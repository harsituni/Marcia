/**
 * M34: colour-vision-deficiency simulator, used to check the Plan-mode layer
 * colours (tests/colorblind.test.ts).
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

/**
 * Colour-blind-safe replacements, used when the crew picks a colour-vision type
 * other than normal, keyed by geology unit / CRISM category name. Each vision
 * type has its own palette, so the map, legends and swatches differ per type.
 *
 * Colours come from Paul Tol's muted, bright and vibrant schemes
 * (https://personal.sron.nl/~pault/) and from Okabe & Ito (2008), chosen by
 * search against the Machado simulator above. tests/colorblind.test.ts checks
 * every layer stays apart (ΔE ≥ 15) under the vision type its palette is for.
 */
export const SAFE_PALETTES: Record<Exclude<Vision, 'normal'>, Readonly<Record<string, string>>> = {
  protanopia: {
    // Geology (Stack et al. 2020 units on the Jezero grid)
    'Crater floor fractured 1': '#0072B2',
    'Crater floor fractured 2': '#33BBEE',
    'Delta blocky': '#009E73',
    'Delta thinly layered': '#DDDDDD',
    'Delta truncated curvilinear layered': '#332288',
    'Undifferentiated smooth': '#F0E442',
    'Moderate Cover Us': '#882255',
    Talus: '#E69F00',
    'Aeolian bedforms, large': '#DDCC77',
    'Aeolian bedforms, small': '#CC3311',
    // CRISM mineral categories
    'Olivine and olivine mixtures': '#117733',
    Carbonates: '#F0E442',
    Smectites: '#332288',
    Pyroxenes: '#EE3377',
    Kaolinite: '#DDDDDD',
  },
  deuteranopia: {
    // Geology
    'Crater floor fractured 1': '#4477AA',
    'Crater floor fractured 2': '#66CCEE',
    'Delta blocky': '#228833',
    'Delta thinly layered': '#DDDDDD',
    'Delta truncated curvilinear layered': '#44AA99',
    'Undifferentiated smooth': '#DDCC77',
    'Moderate Cover Us': '#882255',
    Talus: '#332288',
    'Aeolian bedforms, large': '#D55E00',
    'Aeolian bedforms, small': '#F0E442',
    // CRISM
    'Olivine and olivine mixtures': '#D55E00',
    Carbonates: '#DDDDDD',
    Smectites: '#33BBEE',
    Pyroxenes: '#882255',
    Kaolinite: '#332288',
  },
  tritanopia: {
    // Geology
    'Crater floor fractured 1': '#332288',
    'Crater floor fractured 2': '#66CCEE',
    'Delta blocky': '#228833',
    'Delta thinly layered': '#DDDDDD',
    'Delta truncated curvilinear layered': '#999933',
    'Undifferentiated smooth': '#F0E442',
    'Moderate Cover Us': '#882255',
    Talus: '#CC79A7',
    'Aeolian bedforms, large': '#CC3311',
    'Aeolian bedforms, small': '#EE6677',
    // CRISM
    'Olivine and olivine mixtures': '#CC3311',
    Carbonates: '#F0E442',
    Smectites: '#56B4E9',
    Pyroxenes: '#332288',
    Kaolinite: '#AA4499',
  },
};

/** The colour to draw a legend entry with for `vision`: the original for normal vision, else its safe replacement from that vision's palette. */
export function colorFor(name: string, original: string, vision: Vision): string {
  return vision === 'normal' ? original : (SAFE_PALETTES[vision][name] ?? original);
}

const rgbKey = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/**
 * Per-channel tolerance for matching a swap's `from` colour. CRISM is drawn at
 * alpha 220, which shifts channels by 1 when the pixels are read back, so an
 * exact match misses them.
 */
export const SWAP_TOLERANCE = 2;

/** `#rrggbb` → [r, g, b] as 0..255 integers. */
const rgbOf = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Swaps colours in RGBA pixel data in place: every pixel that is not fully
 * transparent and whose RGB is within SWAP_TOLERANCE of an entry's `from` on
 * each channel becomes that entry's `to` (the first matching entry wins). Other
 * pixels are left alone.
 */
export function recolorPixels(data: Uint8ClampedArray, swaps: readonly { from: string; to: string }[]): void {
  const pairs = swaps.map((s) => ({ from: rgbOf(s.from), to: rgbOf(s.to) }));
  const cache = new Map<number, [number, number, number] | null>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = rgbKey(data[i]!, data[i + 1]!, data[i + 2]!);
    let to = cache.get(key);
    if (to === undefined) {
      const hit = pairs.find((p) => [0, 1, 2].every((c) => Math.abs(p.from[c]! - data[i + c]!) <= SWAP_TOLERANCE));
      to = hit ? hit.to : null;
      cache.set(key, to);
    }
    if (to === null) continue;
    data[i] = to[0];
    data[i + 1] = to[1];
    data[i + 2] = to[2];
  }
}
