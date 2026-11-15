/**
 * Shared contracts between the engine track and the UI track.
 *
 * Any change to this file needs a PR approved by the other person (see M01).
 *
 * Conventions
 * - Grid coordinates: `x` is the column (0 = west edge), `y` is the row
 *   (0 = north edge). Flat arrays are row-major: index = y * width + x.
 * - Units: metres, minutes, kilojoules, degrees. Percentages are 0–100.
 */

/** A grid cell (column/row). Walk-mode positions may be fractional. */
export interface Cell {
  x: number;
  y: number;
}

/** Contents of `meta.json`. */
export interface GridMeta {
  width: number;
  height: number;
  /** Ground size of one cell edge, in metres. */
  cellSizeM: number;
  /** Slope above which a cell is blocked in `cost.bin`. */
  maxSlopeDeg: number;
  /**
   * Habitat / EVA start cell. Not in the original M01 spec; added so the UI
   * knows where `RouteRequest.start` is without hard-coding it.
   */
  habitat: Cell;
}

export type ScienceValue = 1 | 2 | 3;

/** One entry in `stops.json`. */
export interface Stop {
  id: string;
  name: string;
  cell: Cell;
  /** What the crew should do there, one sentence. */
  goal: string;
  geologyUnit: string;
  minerals: string[];
  /** Path to the stop photo, relative to the data directory. */
  photo: string;
  scienceValue: ScienceValue;
}

export interface Constraints {
  /** Total oxygen supply at the start of the EVA, in minutes. */
  oxygenMin: number;
  /** Share of `oxygenMin` that must be left on return, 0–100. */
  reservePct: number;
  /** Crew slope limit; may be stricter than `GridMeta.maxSlopeDeg`. */
  maxSlopeDeg: number;
}

export interface RouteRequest {
  start: Cell;
  /** Visited in this order; the route returns to `start` at the end. */
  stops: Stop[];
  constraints: Constraints;
}

/** Id used for `start` in `RouteLeg.fromId` / `toId`. */
export const START_ID = 'start';

export interface RouteLeg {
  /** Stop id, or `START_ID`. */
  fromId: string;
  /** Stop id, or `START_ID`. */
  toId: string;
  /** Index into `RouteResult.path`, inclusive. */
  startIdx: number;
  /** Index into `RouteResult.path`, inclusive. */
  endIdx: number;
}

export interface RouteResult {
  /** Every cell from start, through each stop, back to start. */
  path: Cell[];
  legs: RouteLeg[];
  distanceM: number;
  timeMin: number;
  energyKJ: number;
  oxygenUsedMin: number;
  /** Stops that can't be reached and returned from within the oxygen budget. */
  outOfRangeIds: string[];
}

export interface RingResult {
  /** Closed outline (first cell not repeated) of the safe turn-back area. */
  polygon: Cell[];
}

/** `space-weather` (M35): DONKI says a solar storm blocks or tightens the EVA. */
export type AlertKind = 'off-route' | 'slope' | 'oxygen' | 'space-weather';
export type AlertSeverity = 'warn' | 'critical';

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
}

/** File names inside the data directory (`public/data/` or `fixtures/`). */
export const DATA_FILES = {
  meta: 'meta.json',
  /** Float32, row-major. `Infinity` means blocked. */
  cost: 'cost.bin',
  /** Float32, row-major, metres. */
  elevation: 'elevation.bin',
  /** Uint8, row-major. 1 = sand, 0 = not sand. */
  sand: 'sand.bin',
  /** Covers exactly the grid extent; any resolution. */
  basemap: 'basemap.png',
  stops: 'stops.json',
} as const;
