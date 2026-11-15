/**
 * Surface weather (MEDA) and radiation (RAD) for the Walk HUD (M31).
 *
 * Pure: given a site, a clock and the current space-weather status, it samples
 * conditions the crew would see on a helmet gauge. Numbers are shaped on
 * published Perseverance MEDA / Curiosity RAD ranges, but the diurnal cycle
 * and thresholds are Marcia estimates for the demo — not telemetry and not
 * NASA guidance.
 *
 * - **MEDA** (Mars Environmental Dynamics Analyzer, Perseverance / Jezero):
 *   air temperature, pressure, wind, humidity.
 * - **RAD** (Radiation Assessment Detector, Curiosity / Gale): dose rate.
 *   Used at Jezero as a stand-in for surface dose the crew would watch.
 */
import type { SiteBounds } from '../data/sites.ts';
import type { SpaceWeatherStatus } from './spaceWeather.ts';

/** Same three-tone scale as the oxygen / return-margin gauges. */
export type ConditionStatus = 'ok' | 'caution' | 'critical';

/** Mars mean solar day length, seconds. */
export const MARS_SOL_S = 88_775.244;

/**
 * MARCIA ESTIMATE, NOT NASA GUIDANCE. Gauge thresholds and the diurnal model
 * live here so the HUD stays honest about what is measured vs modelled.
 */
export const CONDITIONS = {
  /** Wind (m/s) above which the weather gauge turns caution / critical. */
  windCautionMs: 12,
  windCriticalMs: 20,
  /** Air temperature (°C) bounds that raise caution / critical. */
  airColdCautionC: -80,
  airColdCriticalC: -95,
  airHotCautionC: 0,
  airHotCriticalC: 10,
  /** Dose rate (μGy/h). Quiet GCR ~8–10 μGy/h ≈ 0.2–0.25 mGy/day. */
  radCautionUGyH: 25,
  radCriticalUGyH: 100,
  /** Multipliers applied to the quiet RAD baseline when space weather is up. */
  radTightenFactor: 3,
  radBlockFactor: 12,
} as const;

/** One MEDA-style weather sample. */
export interface MedaSample {
  airTempC: number;
  groundTempC: number;
  pressurePa: number;
  windSpeedMs: number;
  /** Meteorological: 0 = from north, 90 = from east. */
  windFromDeg: number;
  humidityPct: number;
  /** Local mean solar hour on Mars, [0, 24). */
  localHour: number;
}

/** One RAD-style dose sample. */
export interface RadSample {
  /** Instantaneous dose rate, μGy/h. */
  doseRateUGyH: number;
  /** Same rate as mGy/day for the detail line. */
  doseRateMGyDay: number;
}

export interface MedaReading extends MedaSample {
  status: ConditionStatus;
  /** 0–1 fill for the temperature arc (cold → warm within the site's range). */
  fraction: number;
  statusWord: string;
}

export interface RadReading extends RadSample {
  status: ConditionStatus;
  /** 0–1 fill for the dose arc (quiet → critical threshold). */
  fraction: number;
  statusWord: string;
}

/** Site climate baselines used by the diurnal model. */
interface Climate {
  /** Mean air temp (°C) and half-amplitude of the diurnal swing. */
  airMeanC: number;
  airAmpC: number;
  /** Ground runs warmer by day / colder by night than air. */
  groundOffsetC: number;
  pressurePa: number;
  /** Mean wind and afternoon gust boost (m/s). */
  windMeanMs: number;
  windGustMs: number;
  /** Peak night-time humidity (%). */
  humidityPeakPct: number;
  /** Quiet GCR dose rate (μGy/h). */
  radQuietUGyH: number;
  /** Instrument credit shown on the gauge. */
  medaLabel: string;
  radLabel: string;
}

const CLIMATE: Record<string, Climate> = {
  jezero: {
    airMeanC: -55,
    airAmpC: 28,
    groundOffsetC: 8,
    pressurePa: 720,
    windMeanMs: 4.5,
    windGustMs: 6,
    humidityPeakPct: 28,
    radQuietUGyH: 9.2,
    medaLabel: 'MEDA · Perseverance',
    radLabel: 'RAD stand-in · Curiosity',
  },
  gale: {
    airMeanC: -50,
    airAmpC: 30,
    groundOffsetC: 10,
    pressurePa: 750,
    windMeanMs: 5,
    windGustMs: 7,
    humidityPeakPct: 22,
    radQuietUGyH: 8.8,
    medaLabel: 'MEDA-style · Gale',
    radLabel: 'RAD · Curiosity',
  },
};

const FALLBACK_CLIMATE = CLIMATE.jezero!;

function climateFor(siteId: string): Climate {
  return CLIMATE[siteId] ?? FALLBACK_CLIMATE;
}

/** Lon of the site centre; used for a simple local-solar-hour offset. */
export function siteLon(bounds: SiteBounds): number {
  return (bounds.minLon + bounds.maxLon) / 2;
}

/**
 * Approximate Mars local mean solar hour at `lonDeg`. Good enough for a
 * diurnal HUD cycle; not a SPICE ephemeris.
 */
export function marsLocalHour(lonDeg: number, at: Date): number {
  const sols = at.getTime() / 1000 / MARS_SOL_S;
  const hourUtc = ((sols % 1) + 1) % 1 * 24;
  return (((hourUtc + lonDeg / 15) % 24) + 24) % 24;
}

/** Cardinal / intercardinal from a "wind from" bearing. */
export function windFromLabel(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[i]!;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Sample MEDA-style weather for `siteId` at clock `at`. */
export function sampleMeda(siteId: string, lonDeg: number, at: Date): MedaSample {
  const c = climateFor(siteId);
  const hour = marsLocalHour(lonDeg, at);
  // Peak air temp ~15:00 local; coolest ~03:00.
  const phase = (2 * Math.PI * (hour - 15)) / 24;
  const airTempC = c.airMeanC + c.airAmpC * Math.cos(phase);
  const groundTempC = airTempC + c.groundOffsetC * Math.max(0, Math.cos(phase));
  // Tiny pressure tide; afternoon low.
  const pressurePa = c.pressurePa - 8 * Math.cos(phase);
  // Winds pick up in the afternoon.
  const afternoon = clamp01(Math.cos(phase));
  const windSpeedMs = c.windMeanMs + c.windGustMs * afternoon;
  // Steady regional breeze from the NW at Jezero / W at Gale — nudge with hour.
  const windFromDeg = (siteId === 'gale' ? 270 : 315) + 20 * Math.sin((2 * Math.PI * hour) / 24);
  // Humidity peaks just before dawn.
  const night = clamp01(Math.cos((2 * Math.PI * (hour - 3)) / 24));
  const humidityPct = c.humidityPeakPct * night;
  return {
    airTempC,
    groundTempC,
    pressurePa,
    windSpeedMs,
    windFromDeg: ((windFromDeg % 360) + 360) % 360,
    humidityPct,
    localHour: hour,
  };
}

/** Sample RAD-style dose; space weather can elevate it. */
export function sampleRad(siteId: string, spaceWeather: SpaceWeatherStatus | null): RadSample {
  const c = climateFor(siteId);
  let dose = c.radQuietUGyH;
  if (spaceWeather === 'tighten') dose *= CONDITIONS.radTightenFactor;
  if (spaceWeather === 'block') dose *= CONDITIONS.radBlockFactor;
  return {
    doseRateUGyH: dose,
    doseRateMGyDay: (dose * 24) / 1000,
  };
}

function worst(a: ConditionStatus, b: ConditionStatus): ConditionStatus {
  if (a === 'critical' || b === 'critical') return 'critical';
  if (a === 'caution' || b === 'caution') return 'caution';
  return 'ok';
}

/** Temperature arc fill: site cold extreme → hot extreme. */
function tempFraction(airTempC: number, c: Climate): number {
  const lo = c.airMeanC - c.airAmpC - 5;
  const hi = c.airMeanC + c.airAmpC + 5;
  return clamp01((airTempC - lo) / (hi - lo));
}

/** Dose arc fill: 0 → critical threshold. */
function radFraction(doseRateUGyH: number): number {
  return clamp01(doseRateUGyH / CONDITIONS.radCriticalUGyH);
}

/** Status words match the oxygen / return-margin gauges. */
function weatherWord(s: ConditionStatus): string {
  return { ok: 'OK', caution: 'ROUGH', critical: 'SEVERE' }[s];
}

function radWord(s: ConditionStatus): string {
  return { ok: 'OK', caution: 'ELEVATED', critical: 'HIGH' }[s];
}

export function assessMeda(sample: MedaSample, siteId: string): MedaReading {
  const c = climateFor(siteId);
  let status: ConditionStatus = 'ok';
  if (sample.windSpeedMs >= CONDITIONS.windCriticalMs) status = 'critical';
  else if (sample.windSpeedMs >= CONDITIONS.windCautionMs) status = 'caution';

  let temp: ConditionStatus = 'ok';
  if (sample.airTempC <= CONDITIONS.airColdCriticalC || sample.airTempC >= CONDITIONS.airHotCriticalC) temp = 'critical';
  else if (sample.airTempC <= CONDITIONS.airColdCautionC || sample.airTempC >= CONDITIONS.airHotCautionC) temp = 'caution';
  status = worst(status, temp);

  return {
    ...sample,
    status,
    fraction: tempFraction(sample.airTempC, c),
    statusWord: weatherWord(status),
  };
}

export function assessRad(sample: RadSample): RadReading {
  let status: ConditionStatus = 'ok';
  if (sample.doseRateUGyH >= CONDITIONS.radCriticalUGyH) status = 'critical';
  else if (sample.doseRateUGyH >= CONDITIONS.radCautionUGyH) status = 'caution';
  return {
    ...sample,
    status,
    fraction: radFraction(sample.doseRateUGyH),
    statusWord: radWord(status),
  };
}

/** Labels for the credit line under each gauge. */
export function conditionsCredit(siteId: string): { meda: string; rad: string } {
  const c = climateFor(siteId);
  return { meda: c.medaLabel, rad: c.radLabel };
}

/** Full HUD snapshot: weather + radiation for one moment. */
export function deriveConditions(args: {
  siteId: string;
  bounds: SiteBounds;
  at: Date;
  spaceWeather: SpaceWeatherStatus | null;
}): { meda: MedaReading; rad: RadReading; credit: { meda: string; rad: string } } {
  const lon = siteLon(args.bounds);
  const meda = assessMeda(sampleMeda(args.siteId, lon, args.at), args.siteId);
  const rad = assessRad(sampleRad(args.siteId, args.spaceWeather));
  return { meda, rad, credit: conditionsCredit(args.siteId) };
}
