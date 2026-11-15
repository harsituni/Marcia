import type { Cell, GridMeta } from '../contracts.ts';

/**
 * M32: avoid zones the crew draws in Plan mode. A zone is a polygon whose
 * vertices are grid cells (the cells clicked on the map); the router treats
 * every cell inside it as blocked, like an `Infinity` cell in `cost.bin`.
 */
export type AvoidZone = Cell[];

/** A zone needs at least three corners to enclose anything. */
export const MIN_ZONE_POINTS = 3;

/** True when cell centre (x, y) is inside `zone` (even-odd rule; vertices are cell centres too). */
export function insideZone(zone: AvoidZone, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = zone.length - 1; i < zone.length; j = i++) {
    const a = zone[i]!;
    const b = zone[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * 1 for every grid cell inside any zone (a zone's corner and edge cells count
 * as inside), else 0. Zones with fewer than MIN_ZONE_POINTS corners are ignored.
 */
export function avoidMask(meta: Pick<GridMeta, 'width' | 'height'>, zones: readonly AvoidZone[]): Uint8Array {
  const { width, height } = meta;
  const mask = new Uint8Array(width * height);
  for (const zone of zones) {
    if (zone.length < MIN_ZONE_POINTS) continue;
    const xs = zone.map((c) => c.x);
    const ys = zone.map((c) => c.y);
    const x0 = Math.max(0, Math.min(...xs));
    const x1 = Math.min(width - 1, Math.max(...xs));
    const y0 = Math.max(0, Math.min(...ys));
    const y1 = Math.min(height - 1, Math.max(...ys));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (insideZone(zone, x, y)) mask[y * width + x] = 1;
    // The boundary itself: the even-odd test leaves some edge cells out.
    for (let i = 0; i < zone.length; i++) {
      const a = zone[i]!;
      const b = zone[(i + 1) % zone.length]!;
      const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(a.x + ((b.x - a.x) * s) / steps);
        const y = Math.round(a.y + ((b.y - a.y) * s) / steps);
        if (x >= 0 && y >= 0 && x < width && y < height) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

/** True when `cell` is inside any of `zones` (same rule as avoidMask). */
export function cellInZones(meta: Pick<GridMeta, 'width' | 'height'>, zones: readonly AvoidZone[], cell: Cell): boolean {
  return avoidMask(meta, zones)[cell.y * meta.width + cell.x] === 1;
}
