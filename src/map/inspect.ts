/**
 * #91: "Click the map to inspect a spot". What the popup shows for one cell,
 * built only from data already loaded or served: the DTM, the slope computed
 * from it, and the geology and CRISM overlay images. Pure functions here;
 * `MapView.tsx` supplies the pixel sampler in the browser.
 */
import type { Cell, GridMeta } from '../contracts.ts';
import type { GridData } from '../data/grid.ts';
import { siteHasLayer } from '../data/sites.ts';
import type { SiteInfo } from '../data/sites.ts';
import { slopeDegAt } from '../engine/terrain.ts';
import { CRISM_FILES, loadCrismLegend } from './crism.ts';
import { GEOLOGY_FILES, loadGeologyLegend } from './geology.ts';

/** Shown when a value is missing (never a made-up value). */
export const NO_DATA = 'no data';
/** Shown for a CRISM cell the map leaves transparent: no mineral is mapped there. That is data, not a gap. */
export const NO_MINERAL = 'no mineral mapped here';
export const SLOPE_SOURCE = "computed from the DTM (Horn's method)";
export const NO_DTM_SOURCE = 'No DTM credit listed for this site';
export const NO_GEOLOGY_SOURCE = 'No geologic map for this site';
export const NO_CRISM_SOURCE = 'No CRISM map for this site';
/** Per-channel slack for CRISM and geology colours (the PNGs are drawn with alpha and rounded). */
export const COLOUR_TOLERANCE = 2;

export type Rgba = readonly [number, number, number, number];
export type InspectLayer = 'geology' | 'crism';
/** Pixel of an overlay image at a grid cell, or null when there is none. */
export type SamplePixel = (layer: InspectLayer, x: number, y: number) => Rgba | null;

/** One reading: a value with its source, or no value with the reason and the source. */
export type Reading<T> = { value: T; source: string } | { value: null; reason: string; source: string };

export interface SpotDetails {
  cell: Cell;
  elevation: Reading<number>;
  slope: Reading<number>;
  geology: Reading<string>;
  crism: Reading<string>;
}

/** A legend colour and the name it stands for (geology units, CRISM categories). */
export interface ColourClass {
  name: string;
  color: string;
}

function parseHex(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The legend class whose colour is closest to `rgb`, with every channel within
 * `tolerance` of it. Null when none is that close.
 */
export function matchColour(rgb: readonly [number, number, number], classes: readonly ColourClass[], tolerance = COLOUR_TOLERANCE): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const c of classes) {
    const target = parseHex(c.color);
    if (!target) continue;
    const distance = Math.max(Math.abs(rgb[0] - target[0]), Math.abs(rgb[1] - target[1]), Math.abs(rgb[2] - target[2]));
    if (distance <= tolerance && distance < bestDistance) {
      best = c.name;
      bestDistance = distance;
    }
  }
  return best;
}

function missing(reason: string, source: string): Reading<never> {
  return { value: null, reason, source };
}

/** Reads the legend class under one cell of an overlay image. */
function classAt(
  layer: InspectLayer,
  classes: readonly ColourClass[],
  source: string,
  cell: Cell,
  samplePixel: SamplePixel,
): Reading<string> {
  const px = samplePixel(layer, cell.x, cell.y);
  if (!px) return missing(NO_DATA, source);
  // CRISM leaves unmapped cells transparent; geology has no such case, so transparent there is a gap.
  if (px[3] === 0) return missing(layer === 'crism' ? NO_MINERAL : NO_DATA, source);
  const name = matchColour([px[0], px[1], px[2]], classes);
  return name ? { value: name, source } : missing(NO_DATA, source);
}

/**
 * Everything the spot popup shows for `cell`. `geology` and `crism` are the
 * site's legends (null while loading or when the site has no such layer);
 * `samplePixel` reads the overlay image at a cell.
 */
export function inspectSpot(
  grid: Pick<GridData, 'meta' | 'elevation'>,
  site: SiteInfo | undefined,
  geology: { source: string; units: readonly ColourClass[] } | null,
  crism: { source: string; categories: readonly ColourClass[] } | null,
  cell: Cell,
  samplePixel: SamplePixel,
): SpotDetails {
  const { width, height } = grid.meta;
  const inside = Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 0 && cell.y >= 0 && cell.x < width && cell.y < height;
  const dtmSource = site?.credits[0]?.label ?? NO_DTM_SOURCE;

  const raw = inside ? grid.elevation[cell.y * width + cell.x] : undefined;
  const elevation: Reading<number> =
    raw !== undefined && Number.isFinite(raw) ? { value: raw, source: dtmSource } : missing(NO_DATA, dtmSource);

  const slope = inside ? slopeDegAt(grid, cell.x, cell.y) : NaN;
  const slopeReading: Reading<number> = Number.isFinite(slope) ? { value: slope, source: SLOPE_SOURCE } : missing(NO_DATA, SLOPE_SOURCE);

  const geologyOn = siteHasLayer(site, 'geology') && geology !== null;
  const geologyReading = geologyOn
    ? classAt('geology', geology.units, geology.source, cell, samplePixel)
    : missing(NO_DATA, NO_GEOLOGY_SOURCE);

  const crismOn = siteHasLayer(site, 'crism') && crism !== null;
  const crismReading = crismOn ? classAt('crism', crism.categories, crism.source, cell, samplePixel) : missing(NO_DATA, NO_CRISM_SOURCE);

  return { cell, elevation, slope: slopeReading, geology: geologyReading, crism: crismReading };
}

/** A decoded overlay image: pixel lookup in grid cells. */
export type PixelSampler = (x: number, y: number) => Rgba | null;

const samplers = new Map<string, Promise<PixelSampler | null>>();

/**
 * Decodes an overlay PNG once (browser only: uses Image and canvas) and returns
 * a sampler in grid cells. The image is stretched over the grid when the sizes
 * differ, the same way the map draws it. Null if it can't be loaded.
 */
export function loadPixelSampler(url: string, gridWidth: number, gridHeight: number): Promise<PixelSampler | null> {
  const key = `${url}|${gridWidth}x${gridHeight}`;
  let pending = samplers.get(key);
  if (!pending) {
    pending = decodePixels(url, gridWidth, gridHeight);
    samplers.set(key, pending);
    void pending.then((s) => {
      if (!s) samplers.delete(key);
    });
  }
  return pending;
}

async function decodePixels(url: string, gridWidth: number, gridHeight: number): Promise<PixelSampler | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    return (x, y) => {
      if (!(x >= 0 && y >= 0 && x < gridWidth && y < gridHeight)) return null;
      const px = Math.min(w - 1, Math.floor(((x + 0.5) * w) / gridWidth));
      const py = Math.min(h - 1, Math.floor(((y + 0.5) * h) / gridHeight));
      const o = (py * w + px) * 4;
      return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!];
    };
  } catch {
    return null;
  }
}

/** #98: what a crew-added stop shows for its rock unit and minerals. */
export interface StopScience {
  geologyUnit: string;
  minerals: string[];
}

/** Rock unit for a cell no layer covers (same word the stop card treats as unknown). */
export const UNKNOWN_UNIT = 'Unknown';

/**
 * #98: rock unit and mineral at `cell`, read from the site's geology and CRISM
 * layers the same way Inspect reads them. A site without a layer, or a cell
 * the layer doesn't map, gives "Unknown" / no minerals: nothing is guessed.
 */
export async function scienceAt(
  siteUrl: string,
  site: SiteInfo | undefined,
  meta: Pick<GridMeta, 'width' | 'height'>,
  cell: Cell,
): Promise<StopScience> {
  const base = siteUrl.replace(/\/$/, '');
  const [geology, crism] = await Promise.all([
    siteHasLayer(site, 'geology') ? loadGeologyLegend(base) : null,
    siteHasLayer(site, 'crism') ? loadCrismLegend(base) : null,
  ]);
  const [geologySampler, crismSampler] = await Promise.all([
    geology ? loadPixelSampler(`${base}/${GEOLOGY_FILES.image}`, meta.width, meta.height) : null,
    crism ? loadPixelSampler(`${base}/${CRISM_FILES.image}`, meta.width, meta.height) : null,
  ]);
  const sample: SamplePixel = (layer, x, y) => (layer === 'geology' ? geologySampler : crismSampler)?.(x, y) ?? null;
  const unit = geology ? classAt('geology', geology.units, geology.source, cell, sample) : null;
  const mineral = crism ? classAt('crism', crism.categories, crism.source, cell, sample) : null;
  return {
    geologyUnit: unit && unit.value !== null ? unit.value : UNKNOWN_UNIT,
    minerals: mineral && mineral.value !== null ? [mineral.value] : [],
  };
}

/** Display text for a reading's value, or its reason when it has none. */
export function readingText<T>(reading: Reading<T>, format: (value: T) => string): string {
  return 'reason' in reading ? reading.reason : format(reading.value);
}
