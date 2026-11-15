import { describe, expect, it, vi } from 'vitest';
import { parseSites } from '../src/data/sites.ts';
import type { SiteInfo } from '../src/data/sites.ts';
import { NO_CRISM_SOURCE, NO_DATA, NO_DTM_SOURCE, NO_MINERAL, SLOPE_SOURCE, inspectSpot, matchColour } from '../src/map/inspect.ts';
import type { Rgba, SamplePixel } from '../src/map/inspect.ts';
import type { GridMeta } from '../src/contracts.ts';

/** 5×5 plane: elevation rises 2 m per cell eastward, so the slope is atan(2 / cellSize) everywhere inside. */
const W = 5;
const H = 5;
const CELL = 5;
const meta = { width: W, height: H, cellSizeM: CELL, maxSlopeDeg: 25, habitat: { x: 0, y: 0 } } as GridMeta;
function planeGrid(): { meta: GridMeta; elevation: Float32Array } {
  const elevation = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) elevation[y * W + x] = 10 + 2 * x;
  return { meta, elevation };
}

const SITE = parseSites([
  {
    id: 'test',
    name: 'Test',
    bounds: { minLon: 0, maxLon: 1, minLat: 0, maxLat: 1 },
    credits: [{ label: 'HiRISE DTM test', url: 'https://example.invalid' }],
    layers: { sand: true, geology: true, crism: true },
  },
])[0] as SiteInfo;
const NO_LAYERS = parseSites([
  { id: 'bare', name: 'Bare', bounds: { minLon: 0, maxLon: 1, minLat: 0, maxLat: 1 }, credits: [] },
])[0] as SiteInfo;

const GEOLOGY = {
  source: 'Geology source test',
  units: [
    { name: 'Delta blocky', color: '#1b7837' },
    { name: 'Talus', color: '#878787' },
  ],
};
const CRISM = {
  source: 'CRISM source test',
  categories: [
    { name: 'Smectites', color: '#2a9d8f' },
    { name: 'Carbonates', color: '#e9c46a' },
  ],
};

/** Sampler that answers every layer with one fixed pixel. */
const always = (px: Rgba | null): SamplePixel => () => px;
const noPixels = always(null);

describe('inspectSpot: elevation and slope', () => {
  it('reads elevation from the grid and slope from the DTM', () => {
    const grid = planeGrid();
    const spot = inspectSpot(grid, SITE, GEOLOGY, CRISM, { x: 2, y: 3 }, noPixels);
    expect(spot.cell).toEqual({ x: 2, y: 3 });
    expect(spot.elevation).toEqual({ value: 14, source: 'HiRISE DTM test' });
    expect(spot.slope.value).toBeCloseTo((Math.atan(2 / CELL) * 180) / Math.PI, 6);
    expect(spot.slope.source).toBe(SLOPE_SOURCE);
  });

  it('names the DTM source as missing when the site lists no credit', () => {
    const spot = inspectSpot(planeGrid(), NO_LAYERS, null, null, { x: 1, y: 1 }, noPixels);
    expect(spot.elevation).toEqual({ value: 12, source: NO_DTM_SOURCE });
  });

  it('a NaN elevation is "no data" for elevation and for the slope through that cell', () => {
    const grid = planeGrid();
    grid.elevation[2 * W + 2] = NaN;
    const spot = inspectSpot(grid, SITE, null, null, { x: 2, y: 2 }, noPixels);
    expect(spot.elevation.value).toBeNull();
    expect('reason' in spot.elevation && spot.elevation.reason).toBe(NO_DATA);
    expect(spot.slope.value).toBeNull();
    expect('reason' in spot.slope && spot.slope.reason).toBe(NO_DATA);
  });

  it('a cell off the grid is "no data", not a value', () => {
    const spot = inspectSpot(planeGrid(), SITE, null, null, { x: W, y: 0 }, noPixels);
    expect(spot.elevation.value).toBeNull();
    expect(spot.slope.value).toBeNull();
  });
});

describe('inspectSpot: geology and CRISM', () => {
  it('maps a geology pixel to its unit name and names the legend source', () => {
    const spot = inspectSpot(planeGrid(), SITE, GEOLOGY, CRISM, { x: 0, y: 0 }, always([0x1b, 0x78, 0x37, 255]));
    expect(spot.geology).toEqual({ value: 'Delta blocky', source: 'Geology source test' });
  });

  it('matches CRISM colours within ±2 per channel, and not beyond', () => {
    const near: Rgba = [0x2a + 2, 0x9d - 2, 0x8f + 1, 180];
    const spot = inspectSpot(planeGrid(), SITE, GEOLOGY, CRISM, { x: 0, y: 0 }, always(near));
    expect(spot.crism).toEqual({ value: 'Smectites', source: 'CRISM source test' });

    const far = inspectSpot(planeGrid(), SITE, GEOLOGY, CRISM, { x: 0, y: 0 }, always([0x2a + 3, 0x9d, 0x8f, 255]));
    expect(far.crism.value).toBeNull();
    expect(far.crism.value === null && far.crism.reason).toBe(NO_DATA);
  });

  it('a transparent CRISM pixel means no mineral is mapped there (data, not a gap)', () => {
    const spot = inspectSpot(planeGrid(), SITE, GEOLOGY, CRISM, { x: 0, y: 0 }, always([0, 0, 0, 0]));
    expect(spot.crism.value).toBeNull();
    expect(spot.crism.value === null && spot.crism.reason).toBe(NO_MINERAL);
    expect(spot.crism.source).toBe('CRISM source test');
  });

  it('a site without the layer shows "no data" even when a sampler would answer', () => {
    const sample = vi.fn(always([0x1b, 0x78, 0x37, 255]));
    const spot = inspectSpot(planeGrid(), NO_LAYERS, GEOLOGY, CRISM, { x: 0, y: 0 }, sample);
    expect(spot.geology.value).toBeNull();
    expect(spot.geology.source).toBe('No geologic map for this site');
    expect(spot.crism.value).toBeNull();
    expect(spot.crism.source).toBe(NO_CRISM_SOURCE);
    expect(sample).not.toHaveBeenCalled();
  });

  it('a missing legend or pixel is "no data" with the legend source', () => {
    const noSample = inspectSpot(planeGrid(), SITE, GEOLOGY, CRISM, { x: 0, y: 0 }, noPixels);
    expect(noSample.geology.value).toBeNull();
    expect(noSample.geology.source).toBe('Geology source test');
    const noLegend = inspectSpot(planeGrid(), SITE, null, null, { x: 0, y: 0 }, always([0x1b, 0x78, 0x37, 255]));
    expect(noLegend.geology.value).toBeNull();
    expect(noLegend.crism.value).toBeNull();
  });
});

describe('matchColour', () => {
  const classes = [
    { name: 'A', color: '#102030' },
    { name: 'B', color: '#112031' },
  ];
  it('picks the nearest class when several are within tolerance', () => {
    expect(matchColour([0x11, 0x20, 0x31], classes)).toBe('B');
    expect(matchColour([0x10, 0x20, 0x30], classes)).toBe('A');
  });
  it('returns null outside the tolerance', () => {
    expect(matchColour([0x10 + 3, 0x20 + 3, 0x30], classes)).toBeNull();
  });
});
