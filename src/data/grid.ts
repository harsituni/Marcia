import { DATA_FILES } from '../contracts.ts';
import type { GridMeta, Stop } from '../contracts.ts';

export interface GridData {
  meta: GridMeta;
  cost: Float32Array;
  elevation: Float32Array;
  sand: Uint8Array;
  stops: Stop[];
  /** URL of the basemap image, for an image overlay. */
  basemapUrl: string;
}

/** URL of a file in the grid's data directory, e.g. a stop's `photo`. */
export function dataFileUrl(grid: Pick<GridData, 'basemapUrl'>, path: string): string {
  return grid.basemapUrl.replace(/[^/]*$/, '') + path.replace(/^\//, '');
}

export interface RawGridFiles {
  meta: GridMeta;
  cost: ArrayBuffer;
  elevation: ArrayBuffer;
  sand: ArrayBuffer;
  stops: Stop[];
}

/** Turns the raw files into typed arrays and checks their sizes against `meta`. */
export function parseGrid(raw: RawGridFiles, basemapUrl: string): GridData {
  const { meta } = raw;
  const n = meta.width * meta.height;
  const cost = new Float32Array(raw.cost);
  const elevation = new Float32Array(raw.elevation);
  const sand = new Uint8Array(raw.sand);
  for (const [name, arr] of [['cost', cost], ['elevation', elevation], ['sand', sand]] as const) {
    if (arr.length !== n) throw new Error(`${name}.bin has ${arr.length} cells, meta says ${n}`);
  }
  for (const s of raw.stops) {
    if (s.cell.x < 0 || s.cell.y < 0 || s.cell.x >= meta.width || s.cell.y >= meta.height) {
      throw new Error(`stop ${s.id} is outside the grid`);
    }
  }
  return { meta, cost, elevation, sand, stops: raw.stops, basemapUrl };
}

/** Loads a data directory, e.g. `/data` (real) or the fixtures folder (mock). */
export async function loadGrid(baseUrl: string): Promise<GridData> {
  const url = (f: string) => `${baseUrl.replace(/\/$/, '')}/${f}`;
  const get = async (f: string) => {
    const res = await fetch(url(f));
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    return res;
  };
  const [meta, cost, elevation, sand, stops] = await Promise.all([
    get(DATA_FILES.meta).then((r) => r.json() as Promise<GridMeta>),
    get(DATA_FILES.cost).then((r) => r.arrayBuffer()),
    get(DATA_FILES.elevation).then((r) => r.arrayBuffer()),
    get(DATA_FILES.sand).then((r) => r.arrayBuffer()),
    get(DATA_FILES.stops).then((r) => r.json() as Promise<Stop[]>),
  ]);
  return parseGrid({ meta, cost, elevation, sand, stops }, url(DATA_FILES.basemap));
}

export function cellIndex(meta: GridMeta, x: number, y: number): number {
  return y * meta.width + x;
}
