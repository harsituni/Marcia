/**
 * Numbers for the mission brief (M37), computed from the planned route. Pure.
 */
import { START_ID } from '../contracts.ts';
import type { Alert, Cell, Constraints, RouteResult, Stop } from '../contracts.ts';
import { checkAlerts } from '../engine/alerts.ts';
import { usableOxygenMin } from '../engine/model.ts';
import type { Terrain } from '../engine/terrain.ts';

export interface LegRow {
  from: string;
  to: string;
  distanceM: number;
  timeMin: number;
}

/** Path length in cells up to each index (diagonals count √2). */
function cumulativeCells(path: Cell[]): Float64Array {
  const cum = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1]! + Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  return cum;
}

/** Name for a leg end: the stop's number and name, or "Habitat". */
export function placeName(id: string, stops: Stop[]): string {
  if (id === START_ID) return 'Habitat';
  const i = stops.findIndex((s) => s.id === id);
  return i >= 0 ? `${i + 1}. ${stops[i]!.name}` : id;
}

/**
 * Distance and time per leg. Each leg gets its share of the route's own
 * `distanceM` and `timeMin` by path length, so the rows add up to the totals.
 */
export function legRows(route: RouteResult, stops: Stop[]): LegRow[] {
  const cum = cumulativeCells(route.path);
  const total = cum[route.path.length - 1] ?? 0;
  return route.legs.map((l) => {
    const share = total > 0 ? (cum[l.endIdx]! - cum[l.startIdx]!) / total : 0;
    return { from: placeName(l.fromId, stops), to: placeName(l.toId, stops), distanceM: share * route.distanceM, timeMin: share * route.timeMin };
  });
}

export interface Totals {
  distanceM: number;
  timeMin: number;
  energyKJ: number;
  oxygenUsedMin: number;
  reserveMin: number;
  usableMin: number;
  /** Usable oxygen left after the route; negative means the plan eats into the reserve. */
  marginMin: number;
  outOfRange: string[];
}

export function totals(route: RouteResult, constraints: Constraints, stops: Stop[]): Totals {
  const usableMin = usableOxygenMin(constraints.oxygenMin, constraints.reservePct);
  return {
    distanceM: route.distanceM,
    timeMin: route.timeMin,
    energyKJ: route.energyKJ,
    oxygenUsedMin: route.oxygenUsedMin,
    reserveMin: constraints.oxygenMin - usableMin,
    usableMin,
    marginMin: usableMin - route.oxygenUsedMin,
    outOfRange: [...new Set(route.outOfRangeIds)].map((id) => placeName(id, stops)),
  };
}

export interface ExpectedAlert extends Alert {
  /** Where along the route it first fires. */
  cell: Cell;
  atM: number;
  /** Which leg it's on, e.g. "Habitat → 1. Berea". */
  leg: string;
}

/**
 * Walks the planned route at `samples` evenly spaced points, with the oxygen
 * the plan says would be left there, and lists each kind+severity of alert
 * `checkAlerts` raises, at the first place it fires.
 */
export function expectedAlerts(route: RouteResult, constraints: Constraints, stops: Stop[], terrain?: Terrain, samples = 200): ExpectedAlert[] {
  const { path } = route;
  if (path.length === 0) return [];
  const cum = cumulativeCells(path);
  const total = cum[path.length - 1]!;
  const rows = legRows(route, stops);
  const seen = new Map<string, ExpectedAlert>();
  const n = Math.max(1, Math.min(samples, path.length - 1));
  for (let k = 0; k <= n; k++) {
    const idx = Math.round((k / n) * (path.length - 1));
    const share = total > 0 ? cum[idx]! / total : 0;
    const oxygenLeft = constraints.oxygenMin - share * route.oxygenUsedMin;
    for (const a of checkAlerts(path[idx]!, route, constraints, oxygenLeft, terrain)) {
      const key = `${a.kind}:${a.severity}`;
      if (seen.has(key)) continue;
      const legIdx = route.legs.findIndex((l) => idx >= l.startIdx && idx <= l.endIdx);
      const leg = legIdx >= 0 ? `${rows[legIdx]!.from} → ${rows[legIdx]!.to}` : '';
      seen.set(key, { ...a, cell: path[idx]!, atM: share * route.distanceM, leg });
    }
  }
  return [...seen.values()].sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || a.atM - b.atM);
}

/** One line of "Datasets used" (#81). `url` is absent for modelled entries, which have no source dataset. */
export interface DatasetEntry {
  label: string;
  url?: string;
  /** True for numbers Marcia models rather than reads from a dataset. */
  modelled?: boolean;
}

export const DONKI_CREDIT: DatasetEntry = { label: 'NASA DONKI space weather (CCMC)', url: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/' };

/** Modelled, not measured: shown in the brief and the About panel so nobody mistakes them for data. */
export const MODELLED: DatasetEntry[] = [
  { label: 'MEDA weather gauge (temperature, pressure, wind, humidity): modelled estimate shaped on published Perseverance MEDA ranges, not telemetry', modelled: true },
  { label: 'RAD radiation gauge: modelled estimate shaped on published Curiosity RAD ranges, not telemetry', modelled: true },
  { label: 'Walking speed, oxygen use and energy: Marcia constants, modelled estimates (see "What\'s estimated")', modelled: true },
];

const DOI = /(?:https:\/\/doi\.org\/|doi:)(10\.\S+?)\.?(?=\s|$)/;

/** First DOI in a citation string, as an https://doi.org/ link; undefined if it has none. */
export function doiUrl(citation: string): string | undefined {
  const m = DOI.exec(citation);
  return m ? `https://doi.org/${m[1]}` : undefined;
}

/**
 * Every source behind what's on screen for a site: its credits (sites.json),
 * the geology and CRISM layers when the site has them (citations from their
 * legend files), NASA DONKI, then the modelled entries. Nothing is added that
 * isn't already cited in the repo.
 */
export function datasetsUsed(
  credits: readonly { label: string; url: string }[],
  layers: { geology?: { source: string } | null; crism?: { source: string } | null } = {},
): DatasetEntry[] {
  const out: DatasetEntry[] = credits.map((c) => ({ label: c.label, url: c.url }));
  if (layers.geology) out.push({ label: `Geology layer: ${layers.geology.source}`, url: doiUrl(layers.geology.source) });
  if (layers.crism) out.push({ label: `CRISM minerals layer: ${layers.crism.source}`, url: doiUrl(layers.crism.source) });
  out.push(DONKI_CREDIT, ...MODELLED);
  return out;
}
