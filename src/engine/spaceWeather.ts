/**
 * Space-weather rules (M35). Pure: they read a bundle of NASA DONKI responses
 * (fetched by `src/data/donki.ts`) and the current time, and say whether the
 * EVA is clear, tightened or blocked.
 *
 * - **block** (critical): an SEP event in the last `blockSepWithinH`, or a CME
 *   predicted to reach Mars within ±`blockCmeArrivalWindowH` of now.
 * - **tighten** (warn): an M- or X-class flare in the last
 *   `tightenFlareWithinH`, or a CME predicted to reach Mars within the next
 *   `tightenCmeArrivalWithinH`. Raises the reserve and shrinks the oxygen
 *   budget the turn-back ring is drawn for.
 * - **clear**: no change.
 *
 * SEP and flare events are observed near Earth (GOES, SOHO, STEREO), not at
 * Mars, so they are only a stand-in for conditions at Mars. Mars CME arrivals
 * come from the WSA-ENLIL model runs DONKI publishes (`impactList` entries
 * whose `location` is "Mars").
 */
import type { Alert, Constraints } from '../contracts.ts';

/**
 * MARCIA ESTIMATE, NOT NASA GUIDANCE. Every space-weather threshold lives here.
 * They are judgement calls for a demo, not operational flight rules.
 */
export const SPACE_WEATHER = {
  /** Hours back an SEP event still blocks the EVA. */
  blockSepWithinH: 24,
  /** A Mars CME arrival this many hours either side of now blocks the EVA. */
  blockCmeArrivalWindowH: 12,
  /** Hours back an M/X flare still tightens the EVA. */
  tightenFlareWithinH: 24,
  /** Flare classes (first letter of `classType`) that tighten. */
  tightenFlareClasses: ['M', 'X'] as readonly string[],
  /** A Mars CME arrival within this many hours ahead tightens the EVA. */
  tightenCmeArrivalWithinH: 72,
  /** Percentage points added to `reservePct` when tightened. */
  tightenReservePctAdd: 10,
  /** Share of the usable oxygen the turn-back ring is drawn for when tightened. */
  tightenRingOxygenFactor: 0.75,
  /** Days of DONKI history to fetch, and days ahead (CME arrival forecasts). */
  lookbackDays: 3,
  lookaheadDays: 3,
  /** Minimum minutes between DONKI fetches. */
  refetchMin: 15,
} as const;

/** The DONKI fields Marcia reads. Real responses carry many more. */
export interface DonkiSep {
  sepID: string;
  eventTime: string;
  link?: string;
}
export interface DonkiFlare {
  flrID: string;
  beginTime: string;
  peakTime?: string | null;
  classType: string | null;
  link?: string;
}
export interface DonkiImpact {
  location: string;
  arrivalTime: string;
}
export interface DonkiCme {
  activityID: string;
  startTime: string;
  cmeAnalyses?: { enlilList?: { impactList?: DonkiImpact[] | null; cmeIDs?: string[] }[] | null }[] | null;
}
export interface DonkiEnlil {
  simulationID: string;
  impactList?: DonkiImpact[] | null;
  cmeInputs?: { CMEID?: string }[] | null;
}

/** One DONKI check. `null` means that endpoint failed or wasn't fetched. */
export interface DonkiBundle {
  /** When the responses were fetched (ISO). For a historical demo, the moment to judge them at. */
  fetchedAt: string;
  sep: DonkiSep[] | null;
  cme: DonkiCme[] | null;
  flr: DonkiFlare[] | null;
  enlil: DonkiEnlil[] | null;
}

export type SpaceWeatherStatus = 'clear' | 'tighten' | 'block';

export interface SpaceWeatherReason {
  status: Exclude<SpaceWeatherStatus, 'clear'>;
  text: string;
  /** DONKI event id behind it (SEP, FLR, CME or ENLIL id). */
  eventId: string;
}

export interface SpaceWeather {
  status: SpaceWeatherStatus;
  /** Block reasons first, then tighten. Empty when clear. */
  reasons: SpaceWeatherReason[];
  fetchedAt: string;
  /** Endpoints with no data in the bundle, e.g. ['FLR']. */
  missing: string[];
}

const H = 3_600_000;

/** Applies the rules at `now`. */
export function assessSpaceWeather(bundle: DonkiBundle, now: Date): SpaceWeather {
  const t = now.getTime();
  const reasons: SpaceWeatherReason[] = [];
  const cfg = SPACE_WEATHER;

  for (const e of bundle.sep ?? []) {
    const at = parseTime(e.eventTime);
    if (at !== null && at <= t && t - at <= cfg.blockSepWithinH * H) {
      reasons.push({ status: 'block', eventId: e.sepID, text: `Solar energetic particle event ${ago(t - at)} (near-Earth reading)` });
    }
  }

  for (const a of marsArrivals(bundle)) {
    const dt = a.at - t;
    if (Math.abs(dt) <= cfg.blockCmeArrivalWindowH * H) {
      reasons.push({ status: 'block', eventId: a.cmeId, text: `CME predicted at Mars ${dt >= 0 ? `in ${hours(dt)}` : `${hours(-dt)} ago`}` });
    } else if (dt > 0 && dt <= cfg.tightenCmeArrivalWithinH * H) {
      reasons.push({ status: 'tighten', eventId: a.cmeId, text: `CME predicted at Mars in ${hours(dt)}` });
    }
  }

  for (const f of bundle.flr ?? []) {
    const at = parseTime(f.peakTime ?? f.beginTime);
    const cls = (f.classType ?? '').trim().toUpperCase();
    if (at !== null && at <= t && t - at <= cfg.tightenFlareWithinH * H && cfg.tightenFlareClasses.includes(cls.charAt(0))) {
      reasons.push({ status: 'tighten', eventId: f.flrID, text: `${cls} flare ${ago(t - at)} (near-Earth reading)` });
    }
  }

  reasons.sort((a, b) => Number(b.status === 'block') - Number(a.status === 'block'));
  const status: SpaceWeatherStatus = reasons.some((r) => r.status === 'block') ? 'block' : reasons.length > 0 ? 'tighten' : 'clear';
  const missing = (['sep', 'cme', 'flr', 'enlil'] as const).filter((k) => bundle[k] === null).map((k) => ENDPOINTS[k]);
  return { status, reasons, fetchedAt: bundle.fetchedAt, missing };
}

/** DONKI endpoint name for each bundle field. */
export const ENDPOINTS = { sep: 'SEP', cme: 'CME', flr: 'FLR', enlil: 'WSAEnlilSimulations' } as const;

/**
 * Predicted Mars arrivals, one per CME (the earliest when model runs
 * disagree), from both the ENLIL runs and the ENLIL results inside CME analyses.
 */
export function marsArrivals(bundle: DonkiBundle): { cmeId: string; at: number }[] {
  const best = new Map<string, number>();
  const add = (cmeId: string | undefined, impacts: DonkiImpact[] | null | undefined) => {
    for (const i of impacts ?? []) {
      if (i.location.trim().toLowerCase() !== 'mars') continue;
      const at = parseTime(i.arrivalTime);
      if (at === null || !cmeId) continue;
      const prev = best.get(cmeId);
      if (prev === undefined || at < prev) best.set(cmeId, at);
    }
  };
  for (const run of bundle.enlil ?? []) add(run.cmeInputs?.[0]?.CMEID ?? run.simulationID, run.impactList);
  for (const cme of bundle.cme ?? []) {
    for (const an of cme.cmeAnalyses ?? []) for (const run of an.enlilList ?? []) add(cme.activityID, run.impactList);
  }
  return [...best].map(([cmeId, at]) => ({ cmeId, at })).sort((a, b) => a.at - b.at);
}

/** Constraints the engine should plan with: tightened adds to the reserve. */
export function effectiveConstraints(c: Constraints, sw: SpaceWeather | null): Constraints {
  if (!sw || sw.status === 'clear') return c;
  return { ...c, reservePct: Math.min(100, c.reservePct + SPACE_WEATHER.tightenReservePctAdd) };
}

/** Oxygen budget for the turn-back ring: shortened when tightened or blocked. */
export function ringOxygenFor(usableMin: number, sw: SpaceWeather | null): number {
  if (!sw || sw.status === 'clear') return usableMin;
  return usableMin * SPACE_WEATHER.tightenRingOxygenFactor;
}

/** Walk-mode alert for the space weather, if any. */
export function spaceWeatherAlert(sw: SpaceWeather | null): Alert | null {
  if (!sw || sw.status === 'clear') return null;
  const why = sw.reasons[0]!.text;
  if (sw.status === 'block') {
    return { kind: 'space-weather', severity: 'critical', message: `Space weather: ${why}. Return to the habitat now.` };
  }
  return { kind: 'space-weather', severity: 'warn', message: `Space weather: ${why}. Reserve raised.` };
}

/**
 * True when nothing in the data calls for action but some DONKI feed gave no
 * data (failed or unreadable). That is "no data", never "quiet" (#80).
 */
export function hasNoData(sw: SpaceWeather): boolean {
  return sw.status === 'clear' && sw.missing.length > 0;
}

/** "no data from FLR" / "no data from FLR, CME". */
export function noDataText(sw: SpaceWeather): string {
  return `no data from ${sw.missing.join(', ')}`;
}

/** One-line summary for the chip and the Plan panel. */
export function spaceWeatherHeadline(sw: SpaceWeather): string {
  if (sw.status === 'block') return `EVA blocked: ${sw.reasons[0]!.text}`;
  if (sw.status === 'tighten') return `Space weather: tightened (${sw.reasons[0]!.text})`;
  if (hasNoData(sw)) return `Space weather: ${noDataText(sw)}`;
  return 'Space weather: quiet';
}

/** Unique DONKI event ids behind the status, in reason order. */
export function eventIds(sw: SpaceWeather): string[] {
  return [...new Set(sw.reasons.map((r) => r.eventId))];
}

/** DONKI times look like "2026-11-11T23:24Z"; null if unparseable. */
function parseTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const hours = (ms: number) => `${Math.max(1, Math.round(ms / H))} h`;
const ago = (ms: number) => `${hours(ms)} ago`;
