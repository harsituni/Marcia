import { useMemo } from 'react';
import { JEZERO_BOUNDS } from '../data/sites.ts';
import { deriveConditions, windFromLabel } from '../engine/conditions.ts';
import type { ConditionStatus, MedaReading, RadReading } from '../engine/conditions.ts';
import { useAppStore } from '../store.ts';

/** Okabe-Ito tones — same pair as the oxygen / return-margin gauges. */
const TONE: Record<ConditionStatus, { color: string; shape: string }> = {
  ok: { color: '#56B4E9', shape: '●' },
  caution: { color: '#F0E442', shape: '▲' },
  critical: { color: '#D55E00', shape: '■' },
};

const PANEL = 'rounded-xl border border-white/15 bg-black/65 shadow-lg backdrop-blur-sm';
const ARC = Math.PI * 44;

/**
 * MEDA weather + RAD radiation gauges for the Walk HUD (M31). Readings come
 * from the pure diurnal / space-weather model in `engine/conditions.ts`.
 */
export function ConditionsGauges() {
  const siteId = useAppStore((s) => s.siteId);
  const sites = useAppStore((s) => s.sites);
  const spaceWeather = useAppStore((s) => s.spaceWeather.assessment?.status ?? null);
  const elapsedMin = useAppStore((s) => s.replay.elapsedMin);
  const now = useAppStore((s) => s.now);

  const { meda, rad, credit } = useMemo(() => {
    const bounds = sites.find((s) => s.id === siteId)?.bounds ?? JEZERO_BOUNDS;
    // Advance with the simulated walk so the gauges move during replay.
    const at = new Date(now().getTime() + elapsedMin * 60_000);
    return deriveConditions({ siteId, bounds, at, spaceWeather });
  }, [siteId, sites, spaceWeather, elapsedMin, now]);

  return (
    <div className="pointer-events-none flex flex-wrap items-stretch justify-center gap-2">
      <MedaGauge meda={meda} credit={credit.meda} />
      <RadGauge rad={rad} credit={credit.rad} />
    </div>
  );
}

function ArcGauge(props: {
  label: string;
  ariaLabel: string;
  value: string;
  unit: string;
  detail: string;
  credit: string;
  fraction: number;
  status: ConditionStatus;
  statusWord: string;
}) {
  const tone = TONE[props.status];
  return (
    <div role="img" aria-label={props.ariaLabel} className={`${PANEL} w-[9.5rem] px-2 pt-1.5 pb-1.5 text-center sm:w-44`}>
      <div className="text-[10px] font-semibold tracking-wide whitespace-nowrap text-white/70 uppercase sm:tracking-widest">{props.label}</div>
      <svg viewBox="0 0 100 56" className="mx-auto -mb-5 w-full" aria-hidden="true">
        <path d="M6 52 A44 44 0 0 1 94 52" fill="none" stroke="rgb(255 255 255 / 0.15)" strokeWidth="7" strokeLinecap="round" />
        <path
          d="M6 52 A44 44 0 0 1 94 52"
          fill="none"
          stroke={tone.color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(0.01, props.fraction) * ARC} ${ARC}`}
        />
      </svg>
      <div className="font-mono text-xl leading-none font-bold tabular-nums">
        {props.value}
        <span className="ml-0.5 text-[10px] font-normal text-white/70">{props.unit}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-white/60 tabular-nums">{props.detail}</div>
      <div className="text-[11px] font-bold tracking-wide" style={{ color: tone.color }}>
        <span aria-hidden="true">{tone.shape}</span> {props.statusWord}
      </div>
      <div className="mt-0.5 truncate text-[9px] tracking-wide text-white/40">{props.credit}</div>
    </div>
  );
}

function MedaGauge({ meda, credit }: { meda: MedaReading; credit: string }) {
  const temp = Math.round(meda.airTempC);
  const wind = meda.windSpeedMs.toFixed(1);
  const from = windFromLabel(meda.windFromDeg);
  const pressure = Math.round(meda.pressurePa);
  const rh = Math.round(meda.humidityPct);
  return (
    <ArcGauge
      label="Weather · MEDA"
      ariaLabel={`Weather MEDA: ${temp} degrees C, wind ${wind} metres per second from ${from}, ${pressure} pascals, humidity ${rh} percent, ${meda.statusWord}`}
      value={temp > 0 ? `+${temp}` : String(temp)}
      unit="°C"
      detail={`${pressure} Pa · ${wind} m/s ${from} · RH ${rh}%`}
      credit={credit}
      fraction={meda.fraction}
      status={meda.status}
      statusWord={meda.statusWord}
    />
  );
}

function RadGauge({ rad, credit }: { rad: RadReading; credit: string }) {
  const rate = rad.doseRateUGyH >= 100 ? rad.doseRateUGyH.toFixed(0) : rad.doseRateUGyH.toFixed(1);
  const day = rad.doseRateMGyDay.toFixed(2);
  return (
    <ArcGauge
      label="Radiation · RAD"
      ariaLabel={`Radiation RAD: ${rate} microgray per hour, ${day} milligray per day, ${rad.statusWord}`}
      value={rate}
      unit="μGy/h"
      detail={`${day} mGy/day`}
      credit={credit}
      fraction={rad.fraction}
      status={rad.status}
      statusWord={rad.statusWord}
    />
  );
}
