import { useEffect, useId, useState } from 'react';
import { SPACE_WEATHER, eventIds, hasNoData, noDataText, spaceWeatherHeadline } from './engine/spaceWeather.ts';
import type { SpaceWeatherStatus } from './engine/spaceWeather.ts';
import { useAppStore } from './store.ts';

/** Okabe-Ito colours plus a shape and a word, like the alert banner. */
const STYLE: Record<SpaceWeatherStatus | 'nodata', { bg: string; fg: string; shape: string; word: string }> = {
  // A feed failed and nothing else was found: grey, never green "quiet" (#80).
  nodata: { bg: '#5f5f5f', fg: '#ffffff', shape: '?', word: 'No data' },
  block: { bg: '#D55E00', fg: '#ffffff', shape: '■', word: 'Blocked' },
  tighten: { bg: '#F0E442', fg: '#1b1210', shape: '▲', word: 'Tightened' },
  clear: { bg: '#009E73', fg: '#ffffff', shape: '●', word: 'Quiet' },
};

export const NEAR_EARTH_NOTE =
  'SEP and flare readings are taken near Earth, not at Mars, so Marcia treats them as a stand-in. Mars CME arrivals come from NASA WSA-ENLIL model runs. Thresholds are Marcia estimates, not NASA guidance.';

/** Space-weather chip for the header (both modes): status, reason, DONKI ids, fetch time, demo switch. */
export function SpaceWeatherChip() {
  const sw = useAppStore((s) => s.spaceWeather);
  const check = useAppStore((s) => s.checkSpaceWeather);
  const setDemo = useAppStore((s) => s.setSpaceWeatherDemo);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // Check on load, then every 15 min (the cache stops extra fetches).
  useEffect(() => {
    void check();
    const t = setInterval(() => void check(), SPACE_WEATHER.refetchMin * 60_000);
    return () => clearInterval(t);
  }, [check]);

  const a = sw.assessment;
  const noData = a ? hasNoData(a) : false;
  const st = a ? STYLE[noData ? 'nodata' : a.status] : null;
  const label = a
    ? a.status === 'block'
      ? 'EVA blocked'
      : a.status === 'tighten'
        ? 'Space weather: tightened'
        : noData
          ? 'Space weather: no data'
          : 'Space weather: quiet'
    : sw.loading
      ? 'Space weather: checking…'
      : 'Space weather: unknown';
  const fetched = a ? fmtTime(a.fetchedAt) : null;

  return (
    <div className="relative">
      <button
        type="button"
        data-tour="space-weather"
        aria-expanded={open}
        aria-controls={panelId}
        title={NEAR_EARTH_NOTE}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
        style={st ? { background: st.bg, color: st.fg } : { background: 'rgb(255 255 255 / 0.1)' }}
      >
        <span aria-hidden="true">{st?.shape ?? '○'}</span>
        {label}
        {sw.demo && <span className="rounded bg-black/30 px-1 text-[10px]">DEMO</span>}
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="Space weather"
          className="absolute top-full right-0 z-[1100] mt-1 w-80 space-y-2 rounded-lg bg-black/90 p-3 text-xs shadow-lg backdrop-blur-sm"
        >
          {a ? (
            <>
              <p className="font-semibold">{spaceWeatherHeadline(a)}</p>
              {a.missing.length > 0 && (
                <p className="rounded bg-white/10 px-2 py-1">
                  {noData ? "Can't confirm it's quiet: " : 'Partial data: '}
                  NASA DONKI gave {noDataText(a)} (request failed or unreadable).
                </p>
              )}
              {a.reasons.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4">
                  {a.reasons.map((r) => (
                    <li key={`${r.eventId}-${r.text}`}>{r.text}</li>
                  ))}
                </ul>
              )}
              {a.status !== 'clear' && (
                <p className="text-white/70">
                  Reserve +{SPACE_WEATHER.tightenReservePctAdd} points; turn-back ring drawn for {Math.round(SPACE_WEATHER.tightenRingOxygenFactor * 100)}% of usable oxygen.
                </p>
              )}
              <p>
                <span className="text-white/60">DONKI events: </span>
                <span className="font-mono break-all">{eventIds(a).join(', ') || 'none in effect'}</span>
              </p>
              <p className="text-white/60">
                {sw.demo ? `Historical storm, judged at ${fetched}` : sw.stale ? `Offline: last checked ${fetched}` : `Checked ${fetched}`}
                {a.missing.length > 0 && ` · no data from ${a.missing.join(', ')}`}
              </p>
            </>
          ) : (
            <p>{sw.error ? `Couldn't reach NASA DONKI: ${sw.error}` : 'Checking NASA DONKI…'}</p>
          )}
          <p className="text-white/50">{NEAR_EARTH_NOTE}</p>
          <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-2">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={sw.demo} onChange={(e) => setDemo(e.currentTarget.checked)} className="accent-mars" />
              Demo: replay a historical storm
            </label>
            <button type="button" onClick={() => void check(true)} disabled={sw.loading || sw.demo} className="rounded px-2 py-0.5 hover:bg-white/10 disabled:opacity-40">
              Check now
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/** "2026-11-15 00:05 UTC (4:05 PM local)". */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const utc = `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `${utc} (${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} local)`;
}
