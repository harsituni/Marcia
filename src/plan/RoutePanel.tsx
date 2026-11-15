import { useId, useMemo, useState } from 'react';
import type { PointerEvent } from 'react';
import type { RouteResult, Stop } from '../contracts.ts';
import type { GridData } from '../data/grid.ts';
import { usableOxygenMin } from '../engine/model.ts';
import { effectiveConstraints, spaceWeatherHeadline } from '../engine/spaceWeather.ts';
import { useAppStore } from '../store.ts';
import { elevationProfile, formatDistance, formatDuration, indexAtDistance } from './profile.ts';
import type { ElevationProfile } from './profile.ts';

/** Route stats and elevation profile for the current plan. */
export function RoutePanel() {
  const route = useAppStore((s) => s.route);
  const data = useAppStore((s) => s.data);
  const stops = useAppStore((s) => s.stops);
  const spaceWeather = useAppStore((s) => s.spaceWeather.assessment);
  // Space weather can raise the reserve; the stats show what the engine planned with.
  const constraints = effectiveConstraints(useAppStore((s) => s.constraints), spaceWeather);
  const [open, setOpen] = useState(true);
  const bodyId = useId();

  if (route.status !== 'ready' || data.status !== 'ready') return null;
  const usable = usableOxygenMin(constraints.oxygenMin, constraints.reservePct);

  return (
    <section
      aria-label="Route stats"
      className="shrink-0 border-t border-white/10 bg-black/40 text-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 font-semibold"
      >
        <span>
          Route <span className="ml-1 text-xs font-normal text-white/60">estimates</span>
        </span>
        <span aria-hidden="true" className="text-white/60">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {spaceWeather && spaceWeather.status !== 'clear' && (
        <p
          role={spaceWeather.status === 'block' ? 'alert' : 'status'}
          className="mx-3 mb-2 rounded px-2 py-1 text-xs font-semibold"
          style={spaceWeather.status === 'block' ? { background: '#D55E00', color: '#fff' } : { background: '#F0E442', color: '#1b1210' }}
        >
          <span aria-hidden="true">{spaceWeather.status === 'block' ? '■ ' : '▲ '}</span>
          {spaceWeatherHeadline(spaceWeather)}
        </p>
      )}
      {open && (
        <div id={bodyId} className="space-y-3 border-t border-white/10 px-3 pt-2 pb-3">
          <Stats result={route.result} usable={usable} stops={stops} />
          <Profile result={route.result} grid={data.grid} stops={stops} />
        </div>
      )}
    </section>
  );
}

function Stats({ result, usable, stops }: { result: RouteResult; usable: number; stops: Stop[] }) {
  const share = usable > 0 ? result.oxygenUsedMin / usable : Infinity;
  const tone = share > 1 ? 'bg-red-500' : share > 0.8 ? 'bg-amber-400' : 'bg-emerald-400';
  const outOfRange = result.outOfRangeIds
    .map((id) => {
      const i = stops.findIndex((s) => s.id === id);
      return i >= 0 ? `${i + 1}. ${stops[i]!.name}` : id;
    })
    .filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat label="Distance" value={formatDistance(result.distanceM)} />
        <Stat label="Walking time" value={formatDuration(result.timeMin)} />
        <Stat label="Energy" value={`${Math.round(result.energyKJ).toLocaleString()} kJ`} />
        <Stat label="Oxygen used" value={`${Math.round(result.oxygenUsedMin)} / ${Math.round(usable)} min`} />
      </dl>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
        role="meter"
        aria-label="Oxygen used of usable supply"
        aria-valuemin={0}
        aria-valuemax={Math.round(usable)}
        aria-valuenow={Math.round(result.oxygenUsedMin)}
      >
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      {outOfRange.length > 0 && (
        <p className="mt-2 rounded bg-red-900/60 px-2 py-1 text-xs">
          Out of range: {outOfRange.join(', ')}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-white/60">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

const W = 600;
const H = 100;

function Profile({ result, grid, stops }: { result: RouteResult; grid: GridData; stops: Stop[] }) {
  const profile = useMemo(
    () => elevationProfile(result, grid.elevation, grid.meta, stops.map((s) => s.id)),
    [result, grid, stops],
  );
  const [hover, setHover] = useState<number | null>(null);

  const total = profile.distM.at(-1) ?? 0;
  if (profile.distM.length < 2 || total === 0) {
    return <p className="text-xs text-white/60">Add a stop to see the elevation profile.</p>;
  }

  const { out, home } = profilePaths(profile, total);
  const pct = (d: number) => `${(d / total) * 100}%`;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(indexAtDistance(profile.distM, f * total));
  };

  return (
    <figure>
      <figcaption className="mb-1 flex flex-wrap justify-between gap-x-4 text-xs text-white/60">
        <span>Elevation profile</span>
        <span className="tabular-nums">
          ↑ {Math.round(profile.ascentM)} m · ↓ {Math.round(profile.descentM)} m · {fmtElev(profile.minM)} to{' '}
          {fmtElev(profile.maxM)}
        </span>
      </figcaption>
      <div
        className="relative h-24 cursor-crosshair touch-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
          <path d={out.area} fill="rgb(255 255 255 / 0.18)" />
          <path d={home.area} fill="rgb(255 255 255 / 0.08)" />
          <path d={out.line} fill="none" stroke="#fff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <path
            d={home.line}
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeDasharray="2 6"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {profile.stops.map((s) => (
          <div key={s.id} className="pointer-events-none absolute inset-y-0" style={{ left: pct(s.distM) }}>
            <div className="h-full border-l border-dashed border-mars/80" />
            <span className="absolute -top-1 -translate-x-1/2 rounded-full bg-mars px-1.5 text-[10px] leading-4 font-bold">
              {s.n}
            </span>
          </div>
        ))}
        {hover !== null && (
          <div className="pointer-events-none absolute inset-y-0" style={{ left: pct(profile.distM[hover]!) }}>
            <div className="h-full border-l border-white/80" />
            <span
              className={`absolute bottom-1 rounded bg-black/90 px-1.5 py-0.5 text-[11px] whitespace-nowrap tabular-nums ${
                profile.distM[hover]! > total / 2 ? 'right-0' : 'left-0'
              }`}
            >
              {formatDistance(profile.distM[hover]!)} · {fmtElev(profile.elevM[hover]!)}
            </span>
          </div>
        )}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-white/50 tabular-nums">
        <span>0</span>
        <span>{formatDistance(total)}</span>
      </div>
    </figure>
  );
}

function fmtElev(m: number): string {
  return `${Math.round(m).toLocaleString()} m`;
}

/** SVG line + area paths for the way out and the way home. */
function profilePaths(p: ElevationProfile, total: number) {
  const span = Math.max(1, p.maxM - p.minM);
  const pad = span * 0.1;
  const x = (d: number) => (d / total) * W;
  const y = (z: number) => H - ((z - p.minM + pad) / (span + 2 * pad)) * H;
  const split = p.homeStartM === null ? p.distM.length - 1 : indexAtDistance(p.distM, p.homeStartM);

  const build = (from: number, to: number) => {
    if (to <= from) return { line: '', area: '' };
    let line = '';
    for (let i = from; i <= to; i++) line += `${i === from ? 'M' : 'L'}${x(p.distM[i]!).toFixed(1)},${y(p.elevM[i]!).toFixed(1)}`;
    const area = `${line}L${x(p.distM[to]!).toFixed(1)},${H}L${x(p.distM[from]!).toFixed(1)},${H}Z`;
    return { line, area };
  };
  return { out: build(0, split), home: build(split, p.distM.length - 1) };
}
