import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Stop } from '../contracts.ts';
import { dataFileUrl } from '../data/grid.ts';
import { MAX_STOP_GOAL, MAX_STOP_NAME, useAppStore } from '../store.ts';

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
            {editing ? <StopName stop={stop} /> : <h2 className="leading-tight font-semibold">{stop.name}</h2>}
            <p className="text-xs text-white/60">
              Science value{' '}
              {editing ? (
                <ScienceStars stop={stop} />
              ) : (
                <span aria-label={`${stop.scienceValue} of 3`} className="text-amber-300">
                  {'★'.repeat(stop.scienceValue)}
                  <span className="text-white/25">{'★'.repeat(3 - stop.scienceValue)}</span>
                </span>
              )}
            </p>
          </div>
        </header>

        {outOfRange && (
          <p className="rounded bg-red-900/60 px-2 py-1 text-xs">Out of range for the current oxygen budget.</p>
        )}

        <dl className="space-y-2">
          <Field label="Goal">{editing ? <StopGoal stop={stop} /> : stop.goal || <Empty>No goal set</Empty>}</Field>
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

/** #98: the title with a pencil that turns it into a text field. Enter or blur saves, Escape cancels. */
function StopName({ stop }: { stop: Stop }) {
  const renameStop = useAppStore((s) => s.renameStop);
  const [draft, setDraft] = useState<string | null>(null);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && draft !== null) renameStop(stop.id, draft);
    setDraft(null);
  };
  if (draft === null) {
    return (
      <div className="flex items-start gap-1">
        <h2 className="leading-tight font-semibold">{stop.name}</h2>
        <button
          type="button"
          aria-label="Rename stop"
          onClick={() => {
            done.current = false;
            setDraft(stop.name);
          }}
          className="shrink-0 rounded px-1 text-xs text-white/60 hover:bg-white/10 hover:text-white"
        >
          ✎
        </button>
      </div>
    );
  }
  return (
    <input
      autoFocus
      aria-label="Stop name"
      value={draft}
      maxLength={MAX_STOP_NAME}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          finish(false);
        }
      }}
      className="w-full rounded bg-white/10 px-1 py-0.5 font-semibold leading-tight outline-none focus:ring-1 focus:ring-mars"
    />
  );
}

/** #98: three stars; clicking one sets the science value (Replan drops low values first). */
function ScienceStars({ stop }: { stop: Stop }) {
  const editStop = useAppStore((s) => s.editStop);
  return (
    <span role="radiogroup" aria-label="Science value" className="inline-flex">
      {([1, 2, 3] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={stop.scienceValue === v}
          aria-label={`${v} of 3`}
          onClick={() => editStop(stop.id, { scienceValue: v })}
          className={`px-0.5 leading-none hover:scale-110 ${v <= stop.scienceValue ? 'text-amber-300' : 'text-white/25'}`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

/** #98: the goal with a pencil that turns it into a text box. Ctrl+Enter or blur saves, Escape cancels; empty clears it. */
function StopGoal({ stop }: { stop: Stop }) {
  const editStop = useAppStore((s) => s.editStop);
  const [draft, setDraft] = useState<string | null>(null);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && draft !== null) editStop(stop.id, { goal: draft });
    setDraft(null);
  };
  if (draft === null) {
    return (
      <div className="flex items-start gap-1">
        <span className="min-w-0">{stop.goal || <Empty>No goal set</Empty>}</span>
        <button
          type="button"
          aria-label="Edit goal"
          onClick={() => {
            done.current = false;
            setDraft(stop.goal);
          }}
          className="shrink-0 rounded px-1 text-xs text-white/60 hover:bg-white/10 hover:text-white"
        >
          ✎
        </button>
      </div>
    );
  }
  return (
    <textarea
      autoFocus
      aria-label="Stop goal"
      value={draft}
      rows={3}
      maxLength={MAX_STOP_GOAL}
      placeholder="What should the crew do here?"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true);
        else if (e.key === 'Escape') {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          finish(false);
        }
      }}
      className="w-full resize-none rounded bg-white/10 px-1 py-0.5 leading-snug outline-none focus:ring-1 focus:ring-mars"
    />
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
