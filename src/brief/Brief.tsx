import { useEffect, useMemo, useState } from 'react';
import type { RingResult, RouteResult, Stop } from '../contracts.ts';
import type { GridData } from '../data/grid.ts';
import { effectiveConstraints, eventIds, spaceWeatherHeadline } from '../engine/spaceWeather.ts';
import { formatDistance, formatDuration } from '../plan/profile.ts';
import { fmtTime } from '../SpaceWeatherChip.tsx';
import { sharePlanFrom, useAppStore } from '../store.ts';
import { datasetsUsed, expectedAlerts, legRows, totals } from './brief.ts';
import type { DatasetEntry } from './brief.ts';
import { useCrismLegend, useGeologyLegend } from '../map/OverlayLayers.tsx';
import { estimates } from './estimates.ts';
import { shareUrl } from './share.ts';
import type { SpaceWeatherSnapshot } from './share.ts';

/** App build for the share link: the commit CI builds from, or "dev". */
export const APP_VERSION = String(import.meta.env?.VITE_COMMIT || 'dev').slice(0, 7);

/** Lists every data source and modelled estimate (#81), shared by the brief and the About panel. */
function DatasetList({ entries }: { entries: DatasetEntry[] }) {
  const data = entries.filter((e) => !e.modelled);
  const modelled = entries.filter((e) => e.modelled);
  return (
    <>
      <ul className="list-disc pl-5">
        {data.map((c) => (
          <li key={c.label}>
            {c.label}
            {c.url && (
              <>
                {' '}
                <a href={c.url} target="_blank" rel="noreferrer" className="underline">
                  link
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1 font-semibold">Modelled estimates (not data)</p>
      <ul className="list-disc pl-5">
        {modelled.map((c) => (
          <li key={c.label}>{c.label}</li>
        ))}
      </ul>
    </>
  );
}

/** The current site's sources: credits, geology / CRISM when present, DONKI, modelled entries. */
function useDatasets(): DatasetEntry[] {
  const site = useAppStore((s) => s.sites.find((x) => x.id === s.siteId));
  const geology = useGeologyLegend().legend;
  const crism = useCrismLegend().legend;
  return useMemo(() => datasetsUsed(site?.credits ?? [], { geology, crism }), [site, geology, crism]);
}

/** Header button + panel: About Marcia and its data sources (#81). */
export function AboutButton() {
  const [open, setOpen] = useState(false);
  const datasets = useDatasets();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <button type="button" data-tour="about" onClick={() => setOpen(true)} className="rounded-md bg-white/5 px-2.5 py-1 text-sm hover:bg-white/10">
        About
      </button>
      {open && (
        <div className="fixed inset-0 z-[2000] flex items-start justify-center overflow-auto bg-black/70 p-2 sm:p-6" role="dialog" aria-modal="true" aria-label="About and data sources" onClick={() => setOpen(false)}>
          <section className="w-full max-w-2xl space-y-2 rounded-lg bg-regolith p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">About Marcia · Data sources</h2>
              <button type="button" onClick={() => setOpen(false)} className="rounded px-2 py-0.5 hover:bg-white/10" aria-label="Close">
                ✕
              </button>
            </div>
            <p className="text-white/70">Marcia plans Mars EVA walks on real orbital terrain. Below is every dataset behind this site, and what is modelled rather than measured.</p>
            <DatasetList entries={datasets} />
          </section>
        </div>
      )}
    </>
  );
}

/** Header button that opens the mission brief. */
export function BriefButton() {
  const ready = useAppStore((s) => s.route.status === 'ready');
  const open = useAppStore((s) => s.setBriefOpen);
  return (
    <button type="button" data-tour="brief" onClick={() => open(true)} disabled={!ready} className="rounded-md bg-white/5 px-2.5 py-1 text-sm hover:bg-white/10 disabled:opacity-40">
      Mission brief
    </button>
  );
}

/**
 * One-page EVA mission brief (M37): share link, print to PDF. Drawn on a
 * white page in black ink so it prints and photocopies cleanly.
 */
export function Brief() {
  const open = useAppStore((s) => s.briefOpen);
  const setOpen = useAppStore((s) => s.setBriefOpen);
  const route = useAppStore((s) => s.route);
  const data = useAppStore((s) => s.data);
  const stops = useAppStore((s) => s.stops);
  const userConstraints = useAppStore((s) => s.constraints);
  const live = useAppStore((s) => s.spaceWeather);
  const shared = useAppStore((s) => s.sharedSpaceWeather);
  const ring = useAppStore((s) => s.ring);
  const site = useAppStore((s) => s.sites.find((x) => x.id === s.siteId));
  const [copied, setCopied] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const datasets = useDatasets();

  // What the engine planned with: the crew's settings, tightened by space weather.
  const constraints = useMemo(() => effectiveConstraints(userConstraints, live.assessment), [userConstraints, live.assessment]);
  const result = route.status === 'ready' ? route.result : null;
  const grid = data.status === 'ready' ? data.grid : null;
  const alerts = useMemo(() => (open && result && grid ? expectedAlerts(result, constraints, stops, grid) : []), [open, result, grid, constraints, stops]);
  // #83: Esc closes the brief, like its Close button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      if (location.hash.startsWith('#brief')) history.replaceState(null, '', location.pathname + location.search);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  if (!open) return null;

  const snapshot: SpaceWeatherSnapshot | null =
    shared ??
    (live.assessment
      ? { status: live.assessment.status, reason: spaceWeatherHeadline(live.assessment), eventIds: eventIds(live.assessment), fetchedAt: live.assessment.fetchedAt, demo: live.demo }
      : null);

  const close = () => {
    setOpen(false);
    if (location.hash.startsWith('#brief')) history.replaceState(null, '', location.pathname + location.search);
  };
  const copy = async () => {
    const url = shareUrl(location.href, sharePlanFrom(useAppStore.getState(), APP_VERSION, new Date()));
    try {
      await navigator.clipboard.writeText(url);
      setCopied('Link copied');
    } catch {
      window.prompt('Copy this link:', url);
      setCopied(null);
    }
  };

  return (
    <div className="brief-overlay fixed inset-0 z-[2000] overflow-auto bg-black/70 p-2 sm:p-6" role="dialog" aria-modal="true" aria-label="Mission brief">
      <div className="brief-toolbar mx-auto mb-2 flex max-w-[210mm] flex-wrap items-center justify-end gap-2 text-sm">
        {copied && <span role="status">{copied}</span>}
        <button type="button" data-tour="copy-link" onClick={() => void copy()} className="rounded bg-white px-3 py-1 font-semibold text-black">
          Copy link
        </button>
        <button type="button" data-tour="download-pdf" onClick={() => window.print()} className="rounded bg-white px-3 py-1 font-semibold text-black">
          Download PDF
        </button>
        <button type="button" onClick={close} className="rounded border border-white/40 px-3 py-1">
          Close
        </button>
      </div>
      <article className="brief mx-auto max-w-[210mm] bg-white p-6 text-[12px] leading-snug text-black">
        {/* 1. Header */}
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-black pb-2">
          <h1 className="text-xl font-bold">Marcia · EVA mission brief</h1>
          <p className="text-right">
            {now.toISOString().slice(0, 16).replace('T', ' ')} UTC · {now.toLocaleString()} local
          </p>
        </header>
        <p className="mt-1">
          <b>{site?.name ?? 'Unknown site'}</b>
          {site?.slopeOnly && ' (slope-only cost: no sand data)'}
          {result && (
            <>
              {' '}
              · {stops.length} stop{stops.length === 1 ? '' : 's'} · {formatDistance(result.distanceM)} · {formatDuration(result.timeMin)} · oxygen{' '}
              {Math.round(result.oxygenUsedMin)} min of {Math.round(totals(result, constraints, stops).usableMin)} usable
            </>
          )}
        </p>

        {!result || !grid ? (
          <p className="mt-4">No route planned yet.</p>
        ) : (
          <>
            {/* 2. Map */}
            <section className="brief-section mt-3">
              <BriefMap grid={grid} route={result} stops={stops} ring={ring} />
              <p className="mt-1 text-[10px]">
                Solid line: route. Dashed outline: turn-back ring (where the crew can still get home with the reserve). ■ habitat, numbered circles: stops. North up; grid {grid.meta.width} ×{' '}
                {grid.meta.height} cells of {grid.meta.cellSizeM} m.
              </p>
            </section>

            <div className="mt-3 grid gap-4 sm:grid-cols-2 print:grid-cols-2">
              {/* 3. Legs */}
              <section className="brief-section">
                <h2 className="brief-h2">Legs</h2>
                <table className="brief-table">
                  <thead>
                    <tr>
                      <th>From → to</th>
                      <th>Distance</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {legRows(result, stops).map((l, i) => (
                      <tr key={i}>
                        <td>
                          {l.from} → {l.to}
                        </td>
                        <td>{formatDistance(l.distanceM)}</td>
                        <td>{formatDuration(l.timeMin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              {/* 4. Totals */}
              <section className="brief-section">
                <h2 className="brief-h2">Totals</h2>
                <Totals result={result} constraints={constraints} stops={stops} />
              </section>
            </div>

            {/* 5. Alerts */}
            <section className="brief-section mt-3">
              <h2 className="brief-h2">Alerts expected along the route</h2>
              {alerts.length === 0 ? (
                <p>None: the planned walk stays on route, under the slope limit and above the oxygen margin.</p>
              ) : (
                <ul className="list-disc pl-5">
                  {alerts.map((a) => (
                    <li key={`${a.kind}-${a.severity}`}>
                      <b>{a.severity === 'critical' ? 'CRITICAL' : 'Caution'}</b> ({a.kind}) {a.message} First at {formatDistance(a.atM)}, {a.leg}, cell ({a.cell.x}, {a.cell.y}).
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {/* 6. Space weather */}
        <section className="brief-section mt-3">
          <h2 className="brief-h2">Space weather at plan time</h2>
          {snapshot ? (
            <p>
              <b>{snapshot.status === 'block' ? 'BLOCKED' : snapshot.status === 'tighten' ? 'TIGHTENED' : snapshot.reason.startsWith('no data from ') ? 'NO DATA' : 'QUIET'}</b>: {snapshot.reason}. DONKI events:{' '}
              {snapshot.eventIds.join(', ') || 'none'}. Fetched {fmtTime(snapshot.fetchedAt)}
              {snapshot.demo && ' (historical-storm demo)'}. SEP and flare readings are near-Earth stand-ins for Mars.
            </p>
          ) : (
            <p>Not checked (NASA DONKI unreachable).</p>
          )}
        </section>

        {/* 7. Datasets */}
        <section className="brief-section mt-3">
          <h2 className="brief-h2">Datasets used</h2>
          <DatasetList entries={datasets} />
        </section>

        {/* 8. What's estimated */}
        <section className="brief-section mt-3">
          <h2 className="brief-h2">What's estimated</h2>
          <p>Energy, oxygen, walk time, slope cost and the space-weather rules are Marcia's estimates, not measurements or NASA guidance. The constants:</p>
          <table className="brief-table mt-1">
            <tbody>
              {estimates().map((e) => (
                <tr key={e.key}>
                  <td>{e.label}</td>
                  <td>
                    {e.value} {e.unit}
                  </td>
                  <td>{e.drives}</td>
                  <td className="font-mono text-[9px]">{e.key}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <p className="mt-3 text-[9px]">Marcia build {APP_VERSION}.</p>
      </article>
    </div>
  );
}

function Totals({ result, constraints, stops }: { result: RouteResult; constraints: Parameters<typeof totals>[1]; stops: Stop[] }) {
  const t = totals(result, constraints, stops);
  const rows: [string, string][] = [
    ['Distance', formatDistance(t.distanceM)],
    ['Walking time', formatDuration(t.timeMin)],
    ['Energy', `${Math.round(t.energyKJ).toLocaleString()} kJ`],
    ['Oxygen used', `${Math.round(t.oxygenUsedMin)} min`],
    ['Reserve kept', `${Math.round(t.reserveMin)} min (${constraints.reservePct}% of ${constraints.oxygenMin})`],
    ['Margin above reserve', `${Math.round(t.marginMin)} min${t.marginMin < 0 ? ' (INTO RESERVE)' : ''}`],
    ['Out of range', t.outOfRange.length > 0 ? t.outOfRange.join(', ') : 'none'],
  ];
  return (
    <table className="brief-table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th className="text-left">{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Route over the basemap as SVG in grid cells: prints sharper and more reliably than Leaflet tiles. */
export function BriefMap({ grid, route, stops, ring }: { grid: GridData; route: RouteResult; stops: Stop[]; ring: RingResult | null }) {
  const { width: W, height: H, habitat } = grid.meta;
  const pts = route.path.map((c) => `${c.x + 0.5},${c.y + 0.5}`).join(' ');
  const ringPts = ring?.polygon.map((c) => `${c.x + 0.5},${c.y + 0.5}`).join(' ');
  const u = W / 150; // stroke/label unit: 4 cells on a 600-cell grid
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="brief-map mx-auto block aspect-square w-full max-w-[120mm] border border-black" role="img" aria-label="Route map">
      <image href={grid.basemapUrl} x="0" y="0" width={W} height={H} preserveAspectRatio="none" opacity="0.75" />
      {ringPts && <polygon points={ringPts} fill="none" stroke="#000" strokeWidth={u * 0.6} strokeDasharray={`${u * 2} ${u * 1.5}`} />}
      <polyline points={pts} fill="none" stroke="#fff" strokeWidth={u * 1.6} strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={pts} fill="none" stroke="#000" strokeWidth={u * 0.7} strokeLinejoin="round" strokeLinecap="round" />
      <rect x={habitat.x + 0.5 - u * 2} y={habitat.y + 0.5 - u * 2} width={u * 4} height={u * 4} fill="#000" stroke="#fff" strokeWidth={u * 0.5} />
      {stops.map((s, i) => (
        <g key={s.id}>
          <circle cx={s.cell.x + 0.5} cy={s.cell.y + 0.5} r={u * 2.6} fill="#fff" stroke="#000" strokeWidth={u * 0.5} />
          <text x={s.cell.x + 0.5} y={s.cell.y + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={u * 3.4} fontWeight="700" fill="#000">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}
