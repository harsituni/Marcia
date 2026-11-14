import type { Alert, Cell, Constraints, RouteResult } from '../contracts.ts';

/**
 * Pure alert check run on every walk-mode tick (main thread, not the worker).
 *
 * Contract only: the real logic for off-route, slope and oxygen margin lands
 * in M26. Until then this returns no alerts so the UI can wire it up.
 */
export function checkAlerts(
  _position: Cell,
  _route: RouteResult,
  _constraints: Constraints,
  _oxygenLeftMin: number,
): Alert[] {
  return [];
}
