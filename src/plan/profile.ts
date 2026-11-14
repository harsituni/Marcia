import { START_ID } from '../contracts.ts';
import type { GridMeta, RouteResult } from '../contracts.ts';

export interface ElevationProfile {
  /** Distance along the route at each path cell, metres (starts at 0). */
  distM: number[];
  /** Elevation at each path cell, metres, from `elevation.bin`. */
  elevM: number[];
  minM: number;
  maxM: number;
  /** Total climb and total descent along the route, metres. */
  ascentM: number;
  descentM: number;
  /** Where each stop falls along the route, in visiting order. */
  stops: { id: string; n: number; distM: number }[];
  /** Distance where the way home starts (the last stop), or null with no stops. */
  homeStartM: number | null;
}

/**
 * Samples `elevation.bin` along the route path. `stopIds` is the planned stop
 * order, so profile markers carry the same numbers as the map pins even when
 * the engine skips an unreachable stop.
 */
export function elevationProfile(
  route: Pick<RouteResult, 'path' | 'legs'>,
  elevation: Float32Array,
  meta: Pick<GridMeta, 'width' | 'cellSizeM'>,
  stopIds?: string[],
): ElevationProfile {
  const distM: number[] = [];
  const elevM: number[] = [];
  let d = 0;
  let ascentM = 0;
  let descentM = 0;
  for (let i = 0; i < route.path.length; i++) {
    const c = route.path[i]!;
    if (i > 0) {
      const p = route.path[i - 1]!;
      d += Math.hypot(c.x - p.x, c.y - p.y) * meta.cellSizeM;
    }
    const z = elevation[Math.round(c.y) * meta.width + Math.round(c.x)]!;
    if (i > 0) {
      const dz = z - elevM[i - 1]!;
      if (dz > 0) ascentM += dz;
      else descentM -= dz;
    }
    distM.push(d);
    elevM.push(z);
  }

  const stops = route.legs
    .filter((l) => l.toId !== START_ID)
    .map((l, i) => ({ id: l.toId, n: stopIds ? stopIds.indexOf(l.toId) + 1 : i + 1, distM: distM[l.endIdx] ?? 0 }));
  const homeLeg = route.legs.at(-1);

  return {
    distM,
    elevM,
    minM: elevM.length ? Math.min(...elevM) : 0,
    maxM: elevM.length ? Math.max(...elevM) : 0,
    ascentM,
    descentM,
    stops,
    homeStartM: homeLeg && homeLeg.toId === START_ID && stops.length ? (distM[homeLeg.startIdx] ?? null) : null,
  };
}

/** Index of the path cell closest to distance `d` along the route. */
export function indexAtDistance(distM: number[], d: number): number {
  let lo = 0;
  let hi = distM.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (distM[mid]! < d) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && d - distM[lo - 1]! < distM[lo]! - d) return lo - 1;
  return lo;
}

export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export function formatDuration(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${m.toString().padStart(2, '0')} min` : `${m} min`;
}
