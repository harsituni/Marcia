/**
 * Pixel generation for the map overlays. Pure functions (no canvas) so they
 * can be tested; `OverlayLayers.tsx` paints the result onto a canvas.
 *
 * Colours are Okabe-Ito (colour-blind safe), and no-go also differs by
 * texture (hatching), so it never relies on colour alone.
 */

export const COLORS = {
  easy: '#0072B2', // blue
  caution: '#F0E442', // yellow
  noGo: '#D55E00', // vermillion (orange-red)
} as const;

export const Difficulty = { Easy: 0, Caution: 1, NoGo: 2 } as const;
export type Difficulty = (typeof Difficulty)[keyof typeof Difficulty];

/** A cell costing more than this × the cheapest walkable cell counts as caution. */
export const CAUTION_RATIO = 1.5;

/** Buckets every cell of `cost.bin` into easy / caution / no-go. */
export function classifyCost(cost: Float32Array): Uint8Array {
  let min = Infinity;
  for (const c of cost) if (c < min) min = c;
  const threshold = Number.isFinite(min) && min > 0 ? min * CAUTION_RATIO : Infinity;
  const out = new Uint8Array(cost.length);
  for (let i = 0; i < cost.length; i++) {
    const c = cost[i]!;
    out[i] = !Number.isFinite(c) ? Difficulty.NoGo : c > threshold ? Difficulty.Caution : Difficulty.Easy;
  }
  return out;
}

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row-major, like `ImageData.data`. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Canvas pixels per grid cell: enough for visible hatching, capped near 1200 px. */
export function overlayScale(gridWidth: number): number {
  return Math.max(2, Math.min(12, Math.floor(1200 / gridWidth)));
}

type Rgba = readonly [number, number, number, number];

function rgba(hex: string, alpha: number): Rgba {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(alpha * 255)];
}

const EASY = rgba(COLORS.easy, 0.6);
const CAUTION = rgba(COLORS.caution, 0.7);
const NOGO_STRIPE = rgba(COLORS.noGo, 0.95);
const NOGO_GAP = rgba(COLORS.noGo, 0.35);
const SAND_FILL = rgba(COLORS.caution, 0.2);
const SAND_DOT = rgba(COLORS.caution, 0.95);

/** Hatch period in canvas pixels (stripes run bottom-left to top-right). */
const HATCH = 6;
/** Stipple spacing in canvas pixels. */
const DOT = 4;

function paint(width: number, height: number, scale: number, pick: (cell: number, px: number, py: number) => Rgba | null): Pixels {
  const W = width * scale;
  const H = height * scale;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let py = 0; py < H; py++) {
    const row = Math.floor(py / scale) * width;
    for (let px = 0; px < W; px++) {
      const c = pick(row + Math.floor(px / scale), px, py);
      if (!c) continue;
      const o = (py * W + px) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = c[3];
    }
  }
  return { width: W, height: H, data };
}

/** Walking difficulty: blue easy, yellow caution, hatched orange-red no-go. */
export function difficultyPixels(classes: Uint8Array, width: number, height: number, scale: number): Pixels {
  return paint(width, height, scale, (i, px, py) => {
    const k = classes[i];
    if (k === Difficulty.Easy) return EASY;
    if (k === Difficulty.Caution) return CAUTION;
    return (px + py) % HATCH < HATCH / 2 ? NOGO_STRIPE : NOGO_GAP;
  });
}

/** Soft sand: faint yellow with a dense stipple. */
export function sandPixels(sand: Uint8Array, width: number, height: number, scale: number): Pixels {
  return paint(width, height, scale, (i, px, py) => {
    if (!sand[i]) return null;
    return px % DOT === 1 && py % DOT === 1 ? SAND_DOT : SAND_FILL;
  });
}
