import type { LatLngBoundsLiteral, LatLngTuple } from 'leaflet';
import type { Cell, GridMeta } from '../contracts.ts';

/**
 * Grid ↔ Leaflet conversion for CRS.Simple, where one map unit is one cell.
 * Leaflet's lat grows upward and grid rows grow downward, so row y maps to
 * lat -y. Cell (x, y) covers lng [x, x+1] and lat [-(y+1), -y].
 */

/** Centre of a cell. Works for fractional walk-mode positions too. */
export function cellToLatLng(c: Cell): LatLngTuple {
  return [-(c.y + 0.5), c.x + 0.5];
}

/** Cell under a map point (rounded down to whole cells). */
export function latLngToCell(lat: number, lng: number): Cell {
  return { x: Math.floor(lng), y: Math.floor(-lat) };
}

/** Outer edges of the whole grid, i.e. where the basemap image goes. */
export function gridBounds(meta: Pick<GridMeta, 'width' | 'height'>): LatLngBoundsLiteral {
  return [
    [-meta.height, 0],
    [0, meta.width],
  ];
}
