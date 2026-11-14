/**
 * Simulated walk along the planned route. Pure: given the minutes elapsed,
 * say where the crew is and how much oxygen is left. The store keeps the clock
 * (`tickWalk`), so tests can drive it without a browser.
 */
import type { Constraints, GridMeta, RouteResult } from '../contracts.ts';
import { cumulativeM } from './hud.ts';
import type { WalkState } from './hud.ts';

export type ReplayStatus = 'idle' | 'playing' | 'paused' | 'done';

export interface Replay {
  status: ReplayStatus;
  /** Simulated seconds per real second. */
  speed: number;
  /** Simulated minutes since leaving the habitat. */
  elapsedMin: number;
}

/** Playback speeds: a 2-hour EVA takes 2 min, 30 s or 12 s. */
export const SPEEDS = [60, 240, 600] as const;
export const DEFAULT_SPEED = 240;
export const IDLE_REPLAY: Replay = { status: 'idle', speed: DEFAULT_SPEED, elapsedMin: 0 };

/** Re-request the ring once the oxygen has dropped this far since the last one. */
export const RING_STEP_MIN = 2;

/** Fractional path index at distance `d` metres along the route. */
export function indexAtDistance(cum: number[], d: number): number {
  const last = cum.length - 1;
  if (last < 1 || d <= 0) return 0;
  if (d >= cum[last]!) return last;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const span = cum[hi]! - cum[lo]!;
  return span > 0 ? lo + (d - cum[lo]!) / span : lo;
}

/**
 * Walk state after `elapsedMin`. Pace and oxygen use come from the route's
 * own stats, so the replay ends exactly on its `timeMin` and `oxygenUsedMin`.
 */
export function walkAt(
  route: Pick<RouteResult, 'path' | 'distanceM' | 'timeMin' | 'oxygenUsedMin'>,
  constraints: Pick<Constraints, 'oxygenMin'>,
  meta: Pick<GridMeta, 'cellSizeM'>,
  elapsedMin: number,
): WalkState {
  const t = Math.min(Math.max(elapsedMin, 0), route.timeMin);
  const fraction = route.timeMin > 0 ? t / route.timeMin : 1;
  const cum = cumulativeM(route.path, meta.cellSizeM);
  return {
    pathIdx: indexAtDistance(cum, fraction * (cum.at(-1) ?? 0)),
    oxygenLeftMin: Math.max(0, constraints.oxygenMin - fraction * route.oxygenUsedMin),
  };
}

/** Advances the clock by `dtRealSec` of real time. */
export function advance(replay: Replay, dtRealSec: number, totalMin: number): Replay {
  if (replay.status !== 'playing') return replay;
  const elapsedMin = Math.min(totalMin, replay.elapsedMin + (dtRealSec * replay.speed) / 60);
  return { ...replay, elapsedMin, status: elapsedMin >= totalMin ? 'done' : 'playing' };
}
