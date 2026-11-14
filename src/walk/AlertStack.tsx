import type { Alert } from '../contracts.ts';
import { useAppStore } from '../store.ts';

/** Same Okabe-Ito pair as the gauges; each alert also carries a shape and a word. */
const STYLE: Record<Alert['severity'], { bg: string; fg: string; shape: string; word: string }> = {
  critical: { bg: '#D55E00', fg: '#ffffff', shape: '■', word: 'Critical' },
  warn: { bg: '#F0E442', fg: '#1b1210', shape: '▲', word: 'Caution' },
};

/**
 * Walk-mode alert banner: the current `checkAlerts` result (critical above
 * warn), the Replan button, and what the last replan dropped.
 */
export function AlertStack() {
  const alerts = useAppStore((s) => s.alerts);
  const replanned = useAppStore((s) => s.replanned);
  const replanning = useAppStore((s) => s.replanning);
  const replanWalk = useAppStore((s) => s.replanWalk);
  const stops = useAppStore((s) => s.stops);

  // The oxygen alert says "Replan." when the route no longer fits: make the button stand out.
  const urged = alerts.some((a) => a.severity === 'critical' && a.kind === 'oxygen');
  const dropped = replanned ? stops.flatMap((s, i) => (replanned.droppedIds.includes(s.id) ? [`${i + 1}. ${s.name}`] : [])) : [];

  return (
    <div className="pointer-events-auto mx-auto flex max-w-xl flex-col items-center gap-1.5">
      <ul aria-label="Alerts" aria-live="assertive" className="flex w-full flex-col gap-1.5 empty:hidden">
        {alerts.map((a) => {
          const st = STYLE[a.severity];
          return (
            <li
              key={a.kind}
              role={a.severity === 'critical' ? 'alert' : 'status'}
              data-severity={a.severity}
              className="flex items-start gap-2 rounded-lg px-3 py-1.5 text-sm leading-snug font-semibold shadow-lg"
              style={{ background: st.bg, color: st.fg }}
            >
              <span aria-hidden="true">{st.shape}</span>
              <span>
                <span className="sr-only">{st.word}: </span>
                {a.message}
              </span>
            </li>
          );
        })}
      </ul>
      {replanned && (
        <p role="status" aria-label="Replan result" className="w-full rounded-lg border border-white/15 bg-black/65 px-3 py-1.5 text-xs backdrop-blur-sm">
          <span className="font-semibold">Replanned.</span>{' '}
          {dropped.length > 0 ? (
            <>
              Dropped: <span className="font-semibold">{dropped.join(', ')}</span>
            </>
          ) : (
            'All remaining stops kept.'
          )}
        </p>
      )}
      <button
        type="button"
        onClick={() => void replanWalk()}
        disabled={replanning}
        className={`rounded-lg border px-3 py-1.5 text-sm font-semibold shadow-lg backdrop-blur-sm disabled:opacity-60 ${
          urged ? 'border-white bg-white text-regolith hover:bg-white/90' : 'border-white/15 bg-black/65 hover:bg-black/80'
        }`}
      >
        {replanning ? 'Replanning…' : 'Replan from here'}
      </button>
    </div>
  );
}
