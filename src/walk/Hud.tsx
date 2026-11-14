import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { RouteResult, Stop } from '../contracts.ts';
import { dataFileUrl } from '../data/grid.ts';
import type { GridData } from '../data/grid.ts';
import { splitOutAndHome } from '../map/route.ts';
import { formatDistance, formatDuration } from '../plan/profile.ts';
import { useAppStore } from '../store.ts';
import { compassTicks, deriveHud, formatHeading, relativeBearing } from './hud.ts';
import type { HudState, NextTarget, Status } from './hud.ts';

/** Okabe-Ito colours (as in the M17 overlays); always paired with a word and a shape. */
const TONE: Record<Status, { color: string; shape: string }> = {
  ok: { color: '#56B4E9', shape: '●' },
  caution: { color: '#F0E442', shape: '▲' },
  critical: { color: '#D55E00', shape: '■' },
};

const PANEL = 'rounded-xl border border-white/15 bg-black/65 shadow-lg backdrop-blur-sm';

/**
 * Walk-mode helmet HUD, drawn over the map: compass strip, oxygen and
 * return-margin gauges, overview mini-map and next-stop card.
 */
export function Hud() {
  const data = useAppStore((s) => s.data);
  const route = useAppStore((s) => s.route);
  const stops = useAppStore((s) => s.stops);
  const constraints = useAppStore((s) => s.constraints);
  const walk = useAppStore((s) => s.walk);

  const ready = data.status === 'ready' && route.status === 'ready' && route.result.path.length > 1;
  const hud = useMemo(
    () =>
      data.status === 'ready' && route.status === 'ready' && route.result.path.length > 1
        ? deriveHud({
            route: route.result,
            stops,
            constraints,
            meta: data.grid.meta,
            // Before the walk starts: standing at the habitat with a full supply.
            walk: walk ?? { pathIdx: 0, oxygenLeftMin: constraints.oxygenMin },
          })
        : null,
    [data, route, stops, constraints, walk],
  );

  if (!ready || !hud || data.status !== 'ready' || route.status !== 'ready') {
    return (
      <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center">
        <p className={`${PANEL} px-4 py-2 text-sm`}>No route to walk yet. Add a stop in Plan mode.</p>
      </div>
    );
  }

  return (
    <section aria-label="Helmet display" className="hud pointer-events-none absolute inset-0 z-[1000] flex flex-col justify-between p-2 sm:p-3">
      <div className="hud-vignette absolute inset-0" aria-hidden="true" />
      <div className="relative flex flex-wrap items-start justify-between gap-2">
        <OxygenGauge hud={hud} />
        <Compass hud={hud} />
        <MarginGauge hud={hud} />
      </div>
      <div className="relative flex items-end justify-between gap-2">
        <MiniMap grid={data.grid} route={route.result} stops={stops} hud={hud} />
        <NextStopCard next={hud.next} headingDeg={hud.headingDeg} grid={data.grid} />
      </div>
    </section>
  );
}

// --- compass ---------------------------------------------------------------

const SPAN = 120;

function Compass({ hud }: { hud: HudState }) {
  const ticks = compassTicks(hud.headingDeg, SPAN);
  const left = (offsetDeg: number) => `${50 + (offsetDeg / SPAN) * 100}%`;

  const markers: { key: string; offset: number; node: ReactNode; label: string }[] = [];
  if (hud.next.kind === 'stop') {
    markers.push({
      key: 'stop',
      offset: relativeBearing(hud.next.bearingDeg, hud.headingDeg),
      label: `Stop ${hud.next.n}`,
      node: <span className="flex h-5 w-5 items-center justify-center rounded-full bg-mars text-[11px] font-bold">{hud.next.n}</span>,
    });
  }
  if (hud.habitatBearingDeg !== null) {
    markers.push({
      key: 'home',
      offset: relativeBearing(hud.habitatBearingDeg, hud.headingDeg),
      label: 'Habitat',
      node: (
        <span className="flex h-5 w-5 items-center justify-center rounded bg-[#f5ede8]">
          <DomeIcon className="h-3.5 w-3.5 fill-regolith" />
        </span>
      ),
    });
  }

  return (
    <div
      role="img"
      aria-label={`Compass: heading ${formatHeading(hud.headingDeg)}`}
      className={`${PANEL} order-first w-full px-2 pt-1 pb-1.5 sm:order-none sm:w-auto sm:max-w-xl sm:flex-1`}
    >
      <div className="text-center font-mono text-sm leading-tight font-semibold tabular-nums">{formatHeading(hud.headingDeg)}</div>
      <div className="relative h-9 overflow-hidden">
        {ticks.map((t) => (
          <div key={t.offsetDeg} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: left(t.offsetDeg) }}>
            <div className={t.label ? 'h-2.5 w-0.5 bg-white' : 'h-1.5 w-px bg-white/50'} />
            {t.label && <span className={`font-mono text-[11px] leading-tight ${t.label.length === 1 ? 'font-bold' : 'text-white/70'}`}>{t.label}</span>}
          </div>
        ))}
        {/* Heading pointer */}
        <div className="absolute top-0 left-1/2 h-full w-0.5 -translate-x-1/2 bg-[#56B4E9]" />
        {markers.map((m) => {
          const off = Math.abs(m.offset) > SPAN / 2;
          const clamped = Math.max(-SPAN / 2 + 5, Math.min(SPAN / 2 - 5, m.offset));
          return (
            <div
              key={m.key}
              title={m.label}
              className="absolute bottom-0 flex -translate-x-1/2 items-center gap-0.5"
              style={{ left: left(clamped) }}
            >
              {off && m.offset < 0 && <span className="text-[10px] leading-none">◀</span>}
              {m.node}
              {off && m.offset > 0 && <span className="text-[10px] leading-none">▶</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- gauges ----------------------------------------------------------------

const ARC = Math.PI * 44;

function Gauge(props: {
  label: string;
  ariaLabel: string;
  value: string;
  unit: string;
  detail: string;
  fraction: number;
  status: Status;
  statusWord: string;
  /** Fraction along the arc to mark (e.g. the reserve line). */
  mark?: number;
}) {
  const tone = TONE[props.status];
  const markAngle = props.mark === undefined ? 0 : Math.PI * (1 - props.mark);
  return (
    <div role="img" aria-label={props.ariaLabel} className={`${PANEL} w-[7.25rem] px-2 pt-1.5 pb-1 text-center sm:w-36`}>
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
        {props.mark !== undefined && (
          <line
            x1={50 + 38 * Math.cos(markAngle)}
            y1={52 - 38 * Math.sin(markAngle)}
            x2={50 + 50 * Math.cos(markAngle)}
            y2={52 - 50 * Math.sin(markAngle)}
            stroke="#fff"
            strokeWidth="2"
          />
        )}
      </svg>
      <div className="font-mono text-xl leading-none font-bold tabular-nums">
        {props.value}
        <span className="ml-0.5 text-[10px] font-normal text-white/70">{props.unit}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-white/60 tabular-nums">{props.detail}</div>
      <div className="text-[11px] font-bold tracking-wide" style={{ color: tone.color }}>
        <span aria-hidden="true">{tone.shape}</span> {props.statusWord}
      </div>
    </div>
  );
}

function OxygenGauge({ hud }: { hud: HudState }) {
  const o = hud.oxygen;
  const word = { ok: 'OK', caution: 'LOW', critical: 'IN RESERVE' }[o.status];
  return (
    <Gauge
      label="Oxygen"
      ariaLabel={`Oxygen: ${Math.round(o.leftMin)} of ${Math.round(o.supplyMin)} minutes left, ${word}`}
      value={String(Math.round(o.leftMin))}
      unit="min"
      detail={`of ${Math.round(o.supplyMin)} · reserve ${Math.round(o.reserveMin)}`}
      fraction={o.fraction}
      status={o.status}
      statusWord={word}
      mark={o.supplyMin > 0 ? o.reserveMin / o.supplyMin : undefined}
    />
  );
}

function MarginGauge({ hud }: { hud: HudState }) {
  const m = hud.returnMargin;
  const word = { ok: 'OK', caution: 'TIGHT', critical: 'TURN BACK' }[m.status];
  const rounded = Math.round(m.marginMin);
  return (
    <Gauge
      label="Return margin"
      ariaLabel={`Return margin: ${rounded} minutes spare, ${word}`}
      value={`${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}`}
      unit="min"
      detail={`home in ~${formatDuration(m.homeMin)}`}
      fraction={m.fraction}
      status={m.status}
      statusWord={word}
    />
  );
}

// --- mini-map --------------------------------------------------------------

function MiniMap({ grid, route, stops, hud }: { grid: GridData; route: RouteResult; stops: Stop[]; hud: HudState }) {
  const { width, height } = grid.meta;
  const u = Math.max(width, height) / 100; // 1% of the map, for sizing marks
  const { out, home } = useMemo(() => {
    const parts = splitOutAndHome(route);
    const pts = (cells: { x: number; y: number }[]) => cells.map((c) => `${c.x + 0.5},${c.y + 0.5}`).join(' ');
    return { out: pts(parts.out), home: pts(parts.home) };
  }, [route]);
  const nextId = hud.next.kind === 'stop' ? hud.next.stop.id : null;
  const hab = grid.meta.habitat;

  return (
    <div role="img" aria-label="Mini-map: whole site with the route and your position" className={`${PANEL} relative w-28 shrink-0 overflow-hidden sm:w-44`}>
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full">
        <image href={grid.basemapUrl} width={width} height={height} preserveAspectRatio="none" />
        <rect width={width} height={height} fill="rgb(0 0 0 / 0.3)" />
        <polyline points={home} fill="none" stroke="#fff" strokeWidth={1.2 * u} strokeDasharray={`${1.5 * u} ${3 * u}`} strokeLinecap="round" />
        <polyline points={out} fill="none" stroke="#fff" strokeWidth={1.2 * u} strokeLinejoin="round" />
        <rect x={hab.x + 0.5 - 2.5 * u} y={hab.y + 0.5 - 2.5 * u} width={5 * u} height={5 * u} rx={u} fill="#f5ede8" stroke="#1b1210" strokeWidth={0.6 * u} />
        {stops.map((s, i) => (
          <g key={s.id}>
            <circle
              cx={s.cell.x + 0.5}
              cy={s.cell.y + 0.5}
              r={(s.id === nextId ? 4.2 : 3.2) * u}
              fill="#c1440e"
              stroke="#fff"
              strokeWidth={(s.id === nextId ? 1.2 : 0.6) * u}
            />
            <text x={s.cell.x + 0.5} y={s.cell.y + 0.5} fontSize={4.4 * u} fontWeight="700" fill="#fff" textAnchor="middle" dominantBaseline="central">
              {i + 1}
            </text>
          </g>
        ))}
        <g transform={`translate(${hud.position.x + 0.5} ${hud.position.y + 0.5}) rotate(${hud.headingDeg}) scale(${u})`}>
          <path d="M0 -6 L4.5 5 L0 2.5 L-4.5 5 Z" fill="#56B4E9" stroke="#1b1210" strokeWidth="1" strokeLinejoin="round" />
        </g>
      </svg>
      <span className="absolute top-1 right-1.5 font-mono text-[10px] font-bold" aria-hidden="true">
        N↑
      </span>
    </div>
  );
}

// --- next stop -------------------------------------------------------------

function NextStopCard({ next, headingDeg, grid }: { next: NextTarget; headingDeg: number; grid: GridData }) {
  if (next.kind === 'arrived') {
    return (
      <div role="group" aria-label="Next stop" className={`${PANEL} px-3 py-2 text-sm`}>
        <div className="text-[10px] font-semibold tracking-widest text-white/70 uppercase">EVA complete</div>
        <div className="font-semibold">Back at the habitat</div>
      </div>
    );
  }

  const rel = relativeBearing(next.bearingDeg, headingDeg);
  const title = next.kind === 'stop' ? next.stop.name : 'Habitat';
  const photo = next.kind === 'stop' && next.stop.photo ? dataFileUrl(grid, next.stop.photo) : null;

  return (
    <div
      role="group"
      aria-label={`Next stop: ${title}, ${formatDistance(next.distanceM)} away`}
      className={`${PANEL} flex min-w-0 flex-1 items-stretch gap-2.5 overflow-hidden p-2 sm:max-w-sm`}
    >
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-white/10 sm:h-20 sm:w-20">
        {photo ? (
          <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            {next.kind === 'home' ? <DomeIcon className="h-8 w-8 fill-white/70" /> : <span className="text-xs text-white/50">No photo</span>}
          </div>
        )}
        {next.kind === 'stop' && (
          <span className="absolute top-1 left-1 flex h-5 w-5 items-center justify-center rounded-full bg-mars text-[11px] font-bold">{next.n}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div>
          <div className="text-[10px] font-semibold tracking-widest text-white/70 uppercase">{next.kind === 'stop' ? 'Next stop' : 'Return to'}</div>
          <div className="truncate leading-tight font-semibold">{title}</div>
          {next.kind === 'stop' && next.stop.goal && <p className="mt-0.5 hidden truncate text-xs text-white/60 sm:block">{next.stop.goal}</p>}
        </div>
        <div className="flex items-center gap-2 font-mono text-sm tabular-nums">
          <svg viewBox="-12 -12 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
            <circle r="11" fill="none" stroke="rgb(255 255 255 / 0.3)" />
            <path d="M0 -8 L5 5 L0 2 L-5 5 Z" fill="#56B4E9" transform={`rotate(${rel})`} />
          </svg>
          <span className="font-bold">{formatDistance(next.distanceM)}</span>
          <span className="text-white/60">·</span>
          <span>{formatDuration(Math.max(next.etaMin, next.distanceM > 0 ? 1 : 0))}</span>
        </div>
      </div>
    </div>
  );
}

function DomeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M3 18h18v2H3zM4 17a8 8 0 0 1 16 0z" />
    </svg>
  );
}
