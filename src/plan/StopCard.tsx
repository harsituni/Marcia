import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Stop } from '../contracts.ts';
import { dataFileUrl } from '../data/grid.ts';
import { useAppStore } from '../store.ts';

/** Details for the selected stop: photo, goal, geology and minerals. */
export function StopCard() {
  const stop = useAppStore((s) => s.stops.find((st) => st.id === s.selectedStopId) ?? null);
  const n = useAppStore((s) => s.stops.findIndex((st) => st.id === s.selectedStopId) + 1);
  const selectStop = useAppStore((s) => s.selectStop);

  useEffect(() => {
    if (!stop) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && selectStop(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stop, selectStop]);

  if (!stop) return null;
  return <StopCardView stop={stop} n={n} onClose={() => selectStop(null)} />;
}

export function StopCardView({ stop, n, onClose }: { stop: Stop; n: number; onClose: () => void }) {
  const editing = useAppStore((s) => s.mode === 'plan');
  const removeStop = useAppStore((s) => s.removeStop);
  const outOfRange = useAppStore((s) => s.route.status === 'ready' && s.route.result.outOfRangeIds.includes(stop.id));
  const photoUrl = useAppStore((s) => (s.data.status === 'ready' && stop.photo ? dataFileUrl(s.data.grid, stop.photo) : null));
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => setPhotoFailed(false), [photoUrl]);

  return (
    <article
      aria-label={`Stop ${n}: ${stop.name}`}
      // #83: right of the Layers panel (left-3 + w-80 = 21.25rem), so neither covers the other on desktop.
      className="absolute top-3 left-14 z-[1001] flex max-h-[calc(100%-1.5rem)] w-72 flex-col sm:left-[21.75rem] overflow-hidden rounded-lg bg-black/85 text-sm shadow-xl backdrop-blur-sm"
    >
      <div className="relative aspect-video shrink-0 overflow-hidden bg-white/5">
        {photoUrl && !photoFailed ? (
          <img
            src={photoUrl}
            alt={`Photo of ${stop.name}`}
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setPhotoFailed(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-white/50">No photo yet</div>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close stop details"
          className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-base leading-none hover:bg-black"
        >
          ×
        </button>
      </div>

      <div className="space-y-3 overflow-y-auto p-3">
        <header className="flex items-start gap-2">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mars text-xs font-bold">{n}</span>
          <div className="min-w-0">
            <h2 className="leading-tight font-semibold">{stop.name}</h2>
            <p className="text-xs text-white/60">
              Science value{' '}
              <span aria-label={`${stop.scienceValue} of 3`} className="text-amber-300">
                {'★'.repeat(stop.scienceValue)}
                <span className="text-white/25">{'★'.repeat(3 - stop.scienceValue)}</span>
              </span>
            </p>
          </div>
        </header>

        {outOfRange && (
          <p className="rounded bg-red-900/60 px-2 py-1 text-xs">Out of range for the current oxygen budget.</p>
        )}

        <dl className="space-y-2">
          <Field label="Goal">{stop.goal || <Empty>No goal set</Empty>}</Field>
          <Field label="Geology">
            {stop.geologyUnit && stop.geologyUnit !== 'Unknown' ? stop.geologyUnit : <Empty>Unknown</Empty>}
          </Field>
          <Field label="Minerals">
            {stop.minerals.length ? (
              <ul className="mt-0.5 flex flex-wrap gap-1">
                {stop.minerals.map((m) => (
                  <li key={m} className="rounded-full bg-white/10 px-2 py-0.5 text-xs">
                    {m}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>None listed</Empty>
            )}
          </Field>
        </dl>

        {editing && (
          <button
            type="button"
            onClick={() => removeStop(stop.id)}
            className="w-full rounded bg-red-700 px-3 py-1.5 text-xs font-semibold hover:bg-red-600"
          >
            Remove stop
          </button>
        )}
      </div>
    </article>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-white/60">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <span className="text-white/40 italic">{children}</span>;
}
