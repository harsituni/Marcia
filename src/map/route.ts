import { START_ID } from '../contracts.ts';
import type { Cell, RouteResult } from '../contracts.ts';

/**
 * Splits a route into the way out (start → last stop) and the way home
 * (last stop → start). The two halves share the last stop's cell so the
 * drawn lines meet. With no stops both are empty. A replanned route that
 * goes straight home has no way out: `out` is then just the starting cell.
 */
export function splitOutAndHome(route: Pick<RouteResult, 'path' | 'legs'>): { out: Cell[]; home: Cell[] } {
  const last = route.legs.at(-1);
  if (!last || last.toId !== START_ID || route.path.length < 2) return { out: [], home: [] };
  return {
    out: route.path.slice(0, last.startIdx + 1),
    home: route.path.slice(last.startIdx, last.endIdx + 1),
  };
}
