/**
 * Walk-mode alerts (M26). Pure and cheap: run on every walk tick, on the main
 * thread (not in the worker).
 *
 * Three checks, at most one alert each, critical ones first:
 *
 * - **oxygen**: can the crew finish this route and keep the reserve?
 *   margin = oxygen left − reserve − oxygen for the walk still ahead
 *   (plus the walk back to the line when off route). Below
 *   `OXYGEN_MARGIN_WARN_MIN` warns; below zero, or already into the reserve,
 *   is critical.
 * - **off-route**: distance from the planned path. Over `OFF_ROUTE_WARN_M`
 *   warns, over `OFF_ROUTE_CRITICAL_M` is critical.
 * - **slope**: ground slope where the crew stands, against
 *   `Constraints.maxSlopeDeg`. Over the limit is critical; within
 *   `SLOPE_WARN_MARGIN_DEG` of it warns. Needs `terrain` (elevation); without
 *   it the slope check is skipped.
 *
 * Distances and the walk ahead come from the route's own stats (M14), so they
 * follow whatever those estimates are: metres per cell is `distanceM` over the
 * path's length in cells, and oxygen ahead is the same share of
 * `oxygenUsedMin`. It works the same on a planned route and a replanned one
 * (which starts at the crew and ends at the habitat).
 *
 * All thresholds live in `model.ts`.
 */
import { START_ID } from '../contracts.ts';
import type { Alert, Cell, Constraints, RouteResult } from '../contracts.ts';
import { OFF_ROUTE_CRITICAL_M, OFF_ROUTE_WARN_M, OXYGEN_MARGIN_WARN_MIN, SLOPE_WARN_MARGIN_DEG } from './model.ts';
import { slopeDegAt } from './terrain.ts';
import type { Terrain } from './terrain.ts';

/** True when the route still visits a science stop (something Replan can drop). */
export function routeHasStops(route: Pick<RouteResult, 'legs'>): boolean {
  return route.legs.some((l) => l.toId !== START_ID);
}

export function checkAlerts(
  position: Cell,
  route: RouteResult,
  constraints: Constraints,
  oxygenLeftMin: number,
  terrain?: Terrain,
): Alert[] {
  const alerts: Alert[] = [];
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return alerts;

  const where = locate(position, route);

  // --- oxygen ---
  const reserveMin = (constraints.oxygenMin * constraints.reservePct) / 100;
  const aheadMin = where ? where.oxygenAheadMin : 0;
  const marginMin = oxygenLeftMin - reserveMin - aheadMin;
  if (oxygenLeftMin <= reserveMin) {
    alerts.push({ kind: 'oxygen', severity: 'critical', message: `Into the oxygen reserve: ${fmt(oxygenLeftMin)} min left. Head home now.` });
  } else if (marginMin < 0) {
    // Only urge Replan when there are still stops to drop; a straight-home route
    // that's over budget can't get shorter by replanning again.
    alerts.push({
      kind: 'oxygen',
      severity: 'critical',
      message: routeHasStops(route)
        ? `Oxygen is ${fmt(-marginMin)} min short for this route. Replan.`
        : `Oxygen is ${fmt(-marginMin)} min short for the walk home. Head back now.`,
    });
  } else if (marginMin < OXYGEN_MARGIN_WARN_MIN) {
    alerts.push({ kind: 'oxygen', severity: 'warn', message: `Oxygen margin is down to ${fmt(marginMin)} min.` });
  }

  // --- off-route ---
  if (where && where.offM > OFF_ROUTE_WARN_M) {
    alerts.push({
      kind: 'off-route',
      severity: where.offM > OFF_ROUTE_CRITICAL_M ? 'critical' : 'warn',
      message: `Off route by ${fmt(where.offM)} m. Head back to the line.`,
    });
  }

  // --- slope ---
  if (terrain) {
    const slope = slopeDegAt(terrain, position.x, position.y);
    if (Number.isFinite(slope)) {
      if (slope > constraints.maxSlopeDeg) {
        alerts.push({ kind: 'slope', severity: 'critical', message: `Slope ${fmt(slope)}° is over your ${fmt(constraints.maxSlopeDeg)}° limit.` });
      } else if (slope >= constraints.maxSlopeDeg - SLOPE_WARN_MARGIN_DEG) {
        alerts.push({ kind: 'slope', severity: 'warn', message: `Slope ${fmt(slope)}° is near your ${fmt(constraints.maxSlopeDeg)}° limit.` });
      }
    }
  }

  // Critical first; otherwise oxygen, off-route, slope as pushed.
  return alerts.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
}

const fmt = (n: number) => String(Math.round(n));

/** Where the crew is relative to the route: how far off it, and the oxygen for the walk ahead. */
function locate(position: Cell, route: RouteResult): { offM: number; oxygenAheadMin: number } | null {
  const { path } = route;
  if (path.length === 0) return null;

  // Path length in cells before each index (diagonal steps count √2).
  const cum = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  }
  const totalCells = cum[path.length - 1]!;
  const metresPerCell = totalCells > 0 ? route.distanceM / totalCells : 0;

  let best = Infinity;
  for (const c of path) {
    const d = Math.hypot(c.x - position.x, c.y - position.y);
    if (d < best) best = d;
  }
  // Out and home legs can share ground. Take the earliest path cell that is
  // (nearly) as close as the nearest: more walk ahead, so the safer reading.
  let idx = 0;
  for (let i = 0; i < path.length; i++) {
    if (Math.hypot(path[i]!.x - position.x, path[i]!.y - position.y) <= best + 0.5) {
      idx = i;
      break;
    }
  }

  const offM = best * metresPerCell;
  const cellsAhead = totalCells - cum[idx]! + best; // includes getting back to the line
  const oxygenAheadMin = totalCells > 0 ? (cellsAhead / totalCells) * route.oxygenUsedMin : 0;
  return { offM, oxygenAheadMin };
}
