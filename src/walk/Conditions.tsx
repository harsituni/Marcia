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

const PANEL = 'rounded-lg border border-white/15 bg-black/65 shadow-lg backdrop-blur-sm';

/** Shared MEDA + RAD snapshot for the Walk HUD corner chips (M31). */
function useConditions() {
  const siteId = useAppStore((s) => s.siteId);
  const sites = useAppStore((s) => s.sites);
  const spaceWeather = useAppStore((s) => s.spaceWeather.assessment?.status ?? null);
  const elapsedMin = useAppStore((s) => s.replay.elapsedMin);
  const now = useAppStore((s) => s.now);

  return useMemo(() => {
    const bounds = sites.find((s) => s.id === siteId)?.bounds ?? JEZERO_BOUNDS;
    // Advance with the simulated walk so the chips move during replay.
    const at = new Date(now().getTime() + elapsedMin * 60_000);
    return deriveConditions({ siteId, bounds, at, spaceWeather });
  }, [siteId, sites, spaceWeather, elapsedMin, now]);
}

/** Weather chip — stacks under the oxygen gauge in the top-left chrome. */
export function MedaChip() {
  const { meda, credit } = useConditions();
  return <MedaChipView meda={meda} credit={credit.meda} />;
}

/** Radiation chip — stacks under the return-margin gauge in the top-right chrome. */
export function RadChip() {
  const { rad, credit } = useConditions();
  return <RadChipView rad={rad} credit={credit.rad} />;
}

function Chip(props: {
  label: string;
  ariaLabel: string;
  value: string;
  unit: string;
  detail: string;
  credit: string;
  status: ConditionStatus;
  statusWord: string;
}) {
  const tone = TONE[props.status];
  return (
    <div
      role="img"
      aria-label={props.ariaLabel}
      title={`${props.credit} — Marcia estimate, not live telemetry`}
      className={`${PANEL} w-[7.25rem] px-2 py-1 text-center sm:w-36`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-semibold tracking-wide text-white/60 uppercase">{props.label}</span>
        <span className="text-[10px] font-bold tracking-wide" style={{ color: tone.color }}>
          <span aria-hidden="true">{tone.shape}</span> {props.statusWord}
        </span>
      </div>
      <div className="font-mono text-sm leading-tight font-bold tabular-nums">
        {props.value}
        <span className="ml-0.5 text-[10px] font-normal text-white/65">{props.unit}</span>
      </div>
      <div className="truncate text-[9px] text-white/50 tabular-nums">{props.detail}</div>
    </div>
  );
}

function MedaChipView({ meda, credit }: { meda: MedaReading; credit: string }) {
  const temp = Math.round(meda.airTempC);
  const wind = meda.windSpeedMs.toFixed(1);
  const from = windFromLabel(meda.windFromDeg);
  const pressure = Math.round(meda.pressurePa);
  const rh = Math.round(meda.humidityPct);
  return (
    <Chip
      label="MEDA"
      ariaLabel={`Weather MEDA: ${temp} degrees C, wind ${wind} metres per second from ${from}, ${pressure} pascals, humidity ${rh} percent, ${meda.statusWord}`}
      value={temp > 0 ? `+${temp}` : String(temp)}
      unit="°C"
      detail={`${pressure} Pa · ${wind} m/s ${from} · RH ${rh}%`}
      credit={credit}
      status={meda.status}
      statusWord={meda.statusWord}
    />
  );
}

function RadChipView({ rad, credit }: { rad: RadReading; credit: string }) {
  const rate = rad.doseRateUGyH >= 100 ? rad.doseRateUGyH.toFixed(0) : rad.doseRateUGyH.toFixed(1);
  const day = rad.doseRateMGyDay.toFixed(2);
  return (
    <Chip
      label="RAD"
      ariaLabel={`Radiation RAD: ${rate} microgray per hour, ${day} milligray per day, ${rad.statusWord}`}
      value={rate}
      unit="μGy/h"
      detail={`${day} mGy/day`}
      credit={credit}
      status={rad.status}
      statusWord={rad.statusWord}
    />
  );
}
