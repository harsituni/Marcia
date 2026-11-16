import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { parseHash } from '../brief/share.ts';
import { browserStorage } from '../data/donki.ts';
import { useAppStore } from '../store.ts';
import { WAIT_MS, makeTourApi, waitFor, waitForStore } from './api.ts';
import { CHAPTERS } from './steps.ts';
import type { TourChapter, TourStep } from './types.ts';

/** First-visit prompt answered (Start or No thanks). */
export const SEEN_KEY = 'marcia.tutorial.seen.v1';
/** JSON list of finished chapter ids. */
export const DONE_KEY = 'marcia.tutorial.done.v1';

/** Spotlight padding around the target, px. */
const PAD = 6;
/** Gap between the target and the card, px. */
const GAP = 12;
/** Narrower than this, the card docks to the top or bottom edge. */
const NARROW_PX = 640;

export function hasSeenPrompt(): boolean {
  try {
    return browserStorage()?.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markPromptSeen(): void {
  try {
    browserStorage()?.setItem(SEEN_KEY, '1');
  } catch {
    // blocked storage: the prompt may show again next visit
  }
}

export function doneChapters(): string[] {
  try {
    const v: unknown = JSON.parse(browserStorage()?.getItem(DONE_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function markChapterDone(id: string): void {
  const done = doneChapters();
  if (done.includes(id)) return;
  try {
    browserStorage()?.setItem(DONE_KEY, JSON.stringify([...done, id]));
  } catch {
    // blocked storage: the tick just isn't remembered
  }
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the card goes: beside the target per `placement`, flipped if it doesn't fit, kept on screen. */
export function placeCard(target: Box | null, placement: TourStep['placement'], card: { width: number; height: number }, view: { width: number; height: number }): Box {
  const { width: vw, height: vh } = view;
  const margin = 16;
  if (target && vw < NARROW_PX) {
    // Phone: dock to the edge away from the target.
    const width = vw - 2 * margin;
    const below = target.top + target.height / 2 < vh / 2;
    return { left: margin, top: below ? vh - card.height - margin : margin, width, height: card.height };
  }
  const width = Math.min(card.width, vw - 2 * margin);
  if (target && placement !== 'center' && target.width > vw * 0.6 && target.height > vh * 0.6) {
    // A target that fills the screen (the map): dock the card in a bottom corner (right for 'left').
    return { left: placement === 'left' ? vw - width - margin : margin, top: Math.max(margin, vh - card.height - margin), width, height: card.height };
  }
  const cw = width;
  const ch = card.height;
  let left = (vw - cw) / 2;
  let top = (vh - ch) / 2;
  if (target && placement !== 'center') {
    const right = target.left + target.width;
    const bottom = target.top + target.height;
    const midX = target.left + target.width / 2 - cw / 2;
    const midY = target.top + target.height / 2 - ch / 2;
    let p = placement ?? 'bottom';
    if (p === 'bottom' && bottom + GAP + ch > vh && target.top - GAP - ch >= 0) p = 'top';
    else if (p === 'top' && target.top - GAP - ch < 0) p = 'bottom';
    else if (p === 'left' && target.left - GAP - cw < 0) p = right + GAP + cw <= vw ? 'right' : 'bottom';
    else if (p === 'right' && right + GAP + cw > vw) p = target.left - GAP - cw >= 0 ? 'left' : 'bottom';
    if (p === 'bottom') [left, top] = [midX, bottom + GAP];
    else if (p === 'top') [left, top] = [midX, target.top - GAP - ch];
    else if (p === 'left') [left, top] = [target.left - GAP - cw, midY];
    else [left, top] = [right + GAP, midY];
  }
  left = Math.max(8, Math.min(left, vw - cw - 8));
  top = Math.max(8, Math.min(top, vh - ch - 8));
  return { left, top, width, height: ch };
}

/** True for a field the user types into. */
function isField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** Swallows a click (or press) that landed outside the spotlight. */
const block = (e: SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};
const BLOCK_HANDLERS = { onClick: block, onMouseDown: block, onPointerDown: block, onDoubleClick: block, onContextMenu: block, onWheel: (e: SyntheticEvent) => e.stopPropagation() };

function Blocker({ part, style, dim = false }: { part: string; style: CSSProperties; dim?: boolean }) {
  return <div data-tour-block={part} className={`pointer-events-auto fixed ${dim ? 'bg-black/60' : ''}`} style={style} {...BLOCK_HANDLERS} />;
}

const BUTTON = 'rounded-md px-3 py-1 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';

/**
 * The hands-on tutorial (#103): spotlight, blocking, the step card and the
 * chapter menu. Mounted once in App; renders only while `tour.active`.
 */
export function Tour({ chapters = CHAPTERS }: { chapters?: TourChapter[] }) {
  const tour = useAppStore((s) => s.tour);
  const [runAll, setRunAll] = useState(false);
  if (!tour.active) return null;
  const ci = chapters.findIndex((c) => c.id === tour.chapter);
  const chapter = chapters[ci];
  const step = chapter?.steps[tour.step];
  return createPortal(
    <div className="tour pointer-events-none fixed inset-0 z-[2100]">
      {chapter && step ? (
        <StepRunner key={`${chapter.id}:${tour.step}`} chapters={chapters} ci={ci} index={tour.step} runAll={runAll} setRunAll={setRunAll} />
      ) : (
        <ChapterMenu chapters={chapters} onRunAll={() => setRunAll(true)} onPick={() => setRunAll(false)} />
      )}
    </div>,
    document.body,
  );
}

interface View {
  rect: Box | null;
  rects: Box[];
  vw: number;
  vh: number;
}

function StepRunner({ chapters, ci, index, runAll, setRunAll }: { chapters: TourChapter[]; ci: number; index: number; runAll: boolean; setRunAll: (on: boolean) => void }) {
  const chapter = chapters[ci]!;
  const step = chapter.steps[index]!;
  const action = step.action;
  // Re-read on every store change, so a note appears or goes as live data drops out or comes back.
  const note = useAppStore((s) => step.note?.(s) ?? null);
  const setTourStep = useAppStore((s) => s.setTourStep);
  const startTour = useAppStore((s) => s.startTour);
  const endTour = useAppStore((s) => s.endTour);
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(!action);
  const [forced, setForced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>(() => ({ rect: null, rects: [], vw: window.innerWidth, vh: window.innerHeight }));
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const canNext = ready && (done || forced);
  const last = index === chapter.steps.length - 1;

  // Setup, then wait for the target (a missing one leaves the card centred).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await waitForStore((s) => s.data.status === 'ready');
      try {
        await step.setup?.(makeTourApi());
      } catch (err) {
        console.warn(`Tutorial step ${step.id} setup:`, err);
      }
      if (step.target) await waitFor(step.target, WAIT_MS);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Is it done yet? On every store change and a short DOM poll; once true it stays true.
  useEffect(() => {
    if (!ready || done || !action) return;
    const check = () => {
      try {
        if (action.done(useAppStore.getState(), document)) setDone(true);
      } catch {
        // a check that throws just isn't done yet
      }
    };
    check();
    const unsub = useAppStore.subscribe(check);
    const timer = setInterval(check, 250);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, [ready, done, action]);

  // Follow the target as the page moves, resizes or re-renders.
  useEffect(() => {
    const sels = [...(step.target ? [step.target] : []), ...(step.targets ?? [])];
    let frame = 0;
    let stopped = false;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 50) as unknown as number;
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id: number) => clearTimeout(id);
    const measure = () => {
      if (stopped) return;
      const rects: Box[] = [];
      for (const sel of sels) {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        if (r) rects.push({ left: r.left - PAD, top: r.top - PAD, width: r.width + 2 * PAD, height: r.height + 2 * PAD });
      }
      const same1 = (a: Box, b: Box) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
      // The card is placed beside the primary rect; with no placement set and several rects, around their union.
      let rect: Box | null = rects[0] ?? null;
      if (rects.length > 1 && step.placement === undefined) {
        const l = Math.min(...rects.map((b) => b.left));
        const t = Math.min(...rects.map((b) => b.top));
        rect = { left: l, top: t, width: Math.max(...rects.map((b) => b.left + b.width)) - l, height: Math.max(...rects.map((b) => b.top + b.height)) - t };
      }
      setView((v) => {
        const same =
          v.vw === window.innerWidth &&
          v.vh === window.innerHeight &&
          v.rects.length === rects.length &&
          v.rects.every((b, i) => same1(b, rects[i]!));
        return same ? v : { rect, rects, vw: window.innerWidth, vh: window.innerHeight };
      });
      frame = raf(measure);
    };
    measure();
    return () => {
      stopped = true;
      caf(frame);
    };
  }, [step.target, step.targets, step.placement]);

  const rect = ready ? view.rect : null;
  const rects = ready ? view.rects : [];
  const multi = rects.length > 1;
  // A centred step with no action just dims everything; one with an action keeps its target live.
  const spotlit = !!rect && (step.placement !== 'center' || !!action);
  const centred = !rect || step.placement === 'center' || (multi && step.placement === undefined);

  // Place the card once its size is known.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const box = placeCard(centred ? null : rect, step.placement, { width: card.offsetWidth || 352, height: card.offsetHeight || 200 }, { width: view.vw, height: view.vh });
    card.style.left = `${box.left}px`;
    card.style.top = `${box.top}px`;
    card.style.width = `${box.width}px`;
  });

  // Focus the main button on each step and when it's done, unless the user is typing in the spotlight.
  useEffect(() => {
    if (!ready) return;
    const active = document.activeElement;
    const target = step.target ? document.querySelector(step.target) : null;
    if (isField(active) && target?.contains(active)) return;
    (canNext ? nextRef.current : (showRef.current ?? nextRef.current))?.focus({ preventScroll: true });
  }, [ready, canNext, step.target]);

  const next = () => {
    if (!canNext) return;
    if (!last) {
      setTourStep(index + 1);
      return;
    }
    markChapterDone(chapter.id);
    const after = chapters[ci + 1];
    if (runAll && after) void startTour(after.id);
    else {
      setRunAll(false);
      setTourStep(0, null);
    }
  };
  const back = () => {
    if (index > 0) setTourStep(index - 1);
  };
  const showMe = async () => {
    if (!action || busy) return;
    setBusy(true);
    try {
      await action.doIt(makeTourApi());
    } catch (err) {
      console.warn(`Tutorial step ${step.id} Show me:`, err);
    }
    await new Promise((r) => setTimeout(r, 50));
    let ok = false;
    try {
      ok = action.done(useAppStore.getState(), document);
    } catch {
      ok = false;
    }
    if (ok) setDone(true);
    else setForced(true); // nobody gets stuck
    setBusy(false);
  };

  // Keys: Esc ends, Enter / → next, ← back. Capture phase, so the app underneath never sees them.
  const keys = useRef({ next, back, canNext });
  keys.current = { next, back, canNext };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const target = step.target ? document.querySelector(step.target) : null;
      const inTarget = !!active && !!target?.contains(active);
      if (inTarget && isField(active)) return; // typing in the spotlight: leave it alone
      const inCard = !!active && !!cardRef.current?.contains(active);
      const k = keys.current;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        void endTour();
      } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
        // Enter on another focused button (Back, Show me, the target) presses that button.
        if (e.key === 'Enter' && (inTarget || (inCard && active !== nextRef.current))) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (k.canNext) k.next();
      } else if (e.key === 'ArrowLeft') {
        e.stopImmediatePropagation();
        e.preventDefault();
        k.back();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [step.target, endTour]);

  const holeOpen = !!action && ready && spotlit;
  const xs = multi ? [...new Set([0, view.vw, ...rects.flatMap((b) => [b.left, b.left + b.width])].map((x) => Math.max(0, Math.min(view.vw, x))))].sort((a, b) => a - b) : [];
  const ys = multi ? [...new Set([0, view.vh, ...rects.flatMap((b) => [b.top, b.top + b.height])].map((y) => Math.max(0, Math.min(view.vh, y))))].sort((a, b) => a - b) : [];
  const dimCells: { key: string; left: number; top: number; width: number; height: number }[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i]! + xs[i + 1]!) / 2;
      const cy = (ys[j]! + ys[j + 1]!) / 2;
      if (rects.some((b) => cx > b.left && cx < b.left + b.width && cy > b.top && cy < b.top + b.height)) continue;
      dimCells.push({ key: `${i}-${j}`, left: xs[i]!, top: ys[j]!, width: xs[i + 1]! - xs[i]!, height: ys[j + 1]! - ys[j]! });
    }
  }

  return (
    <>
      {rect && spotlit && multi ? (
        <>
          {rects.map((b, i) => (
            <div key={i} data-tour-spotlight="" className="pointer-events-none fixed rounded-lg ring-2 ring-mars" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
          ))}
          {dimCells.map((c) => (
            <Blocker key={c.key} part={`dim-${c.key}`} dim style={{ left: c.left, top: c.top, width: c.width, height: c.height }} />
          ))}
          {!holeOpen && rects.map((b, i) => <Blocker key={`h${i}`} part="hole" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />)}
        </>
      ) : rect && spotlit ? (
        <>
          <div
            data-tour-spotlight=""
            className="pointer-events-none fixed rounded-lg ring-2 ring-mars transition-all duration-150"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, boxShadow: '0 0 0 9999px rgba(0,0,0,.6)' }}
          />
          <Blocker part="top" style={{ left: 0, top: 0, right: 0, height: Math.max(0, rect.top) }} />
          <Blocker part="bottom" style={{ left: 0, right: 0, bottom: 0, top: rect.top + rect.height }} />
          <Blocker part="left" style={{ left: 0, top: rect.top, width: Math.max(0, rect.left), height: rect.height }} />
          <Blocker part="right" style={{ right: 0, top: rect.top, left: rect.left + rect.width, height: rect.height }} />
          {!holeOpen && <Blocker part="hole" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />}
        </>
      ) : (
        <Blocker part="all" dim style={{ inset: 0 }} />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-label="Tutorial"
        data-placement={centred ? 'center' : (step.placement ?? 'bottom')}
        className="pointer-events-auto fixed w-[22rem] space-y-2 rounded-lg border border-white/15 bg-regolith p-4 text-sm shadow-2xl"
      >
        <p className="text-xs text-white/60">
          {chapter.title} · Step {index + 1} of {chapter.steps.length}
        </p>
        <h2 className="text-base font-semibold">{step.title}</h2>
        <p className="text-white/85">{step.body}</p>
        {note && (
          <p role="note" className="rounded bg-amber-900/40 px-2 py-1 text-xs text-amber-100">
            {note}
          </p>
        )}
        {action && <p className="font-semibold text-amber-200">{action.prompt}</p>}
        {action && (done || forced) && (
          <p role="status" className="font-semibold text-emerald-300">
            ✓ Done
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" onClick={back} disabled={index === 0} className={`${BUTTON} border border-white/30 enabled:hover:bg-white/10`}>
            Back
          </button>
          {action && !done && !forced && (
            <button ref={showRef} type="button" onClick={() => void showMe()} disabled={!ready || busy} className={`${BUTTON} border border-white/30 enabled:hover:bg-white/10`}>
              Show me
            </button>
          )}
          <button ref={nextRef} type="button" onClick={next} disabled={!canNext} className={`${BUTTON} ml-auto bg-mars text-white enabled:hover:bg-mars/80`}>
            {last ? 'Finish chapter' : 'Next'}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-2 text-xs">
          <button type="button" onClick={() => setTourStep(0, null)} className="rounded px-1.5 py-0.5 text-white/70 hover:bg-white/10 hover:text-white">
            Chapters
          </button>
          <button type="button" onClick={() => void endTour()} className="rounded px-1.5 py-0.5 text-white/70 hover:bg-white/10 hover:text-white">
            I got it, skip tutorial
          </button>
        </div>
      </div>
    </>
  );
}

function ChapterMenu({ chapters, onRunAll, onPick }: { chapters: TourChapter[]; onRunAll: () => void; onPick: () => void }) {
  const startTour = useAppStore((s) => s.startTour);
  const endTour = useAppStore((s) => s.endTour);
  const [done] = useState(doneChapters);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      void endTour();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [endTour]);

  return (
    <>
      <Blocker part="all" dim style={{ inset: 0 }} />
      <div className="pointer-events-none fixed inset-0 flex items-center justify-center p-4">
        <section role="dialog" aria-modal="false" aria-label="Tutorial chapters" className="pointer-events-auto w-full max-w-md space-y-3 rounded-lg border border-white/15 bg-regolith p-4 text-sm shadow-2xl">
          <h2 className="text-base font-semibold">Tutorial</h2>
          <p className="text-white/70">Short hands-on chapters. Your own setup comes back when you close the tutorial.</p>
          <ul className="space-y-1.5">
            {chapters.map((c, i) => (
              <li key={c.id}>
                <button
                  ref={i === 0 ? firstRef : undefined}
                  type="button"
                  data-chapter={c.id}
                  onClick={() => {
                    onPick();
                    void startTour(c.id);
                  }}
                  className="flex w-full items-start gap-2 rounded-md border border-white/15 px-3 py-2 text-left hover:bg-white/10"
                >
                  <span aria-hidden="true" className="w-4 shrink-0 text-emerald-300">
                    {done.includes(c.id) ? '✓' : ''}
                  </span>
                  <span>
                    <span className="block font-semibold">
                      {i + 1}. {c.title}
                      {done.includes(c.id) && <span className="sr-only"> (done)</span>}
                    </span>
                    <span className="block text-xs text-white/60">{c.summary}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => void endTour()} className={`${BUTTON} border border-white/30 hover:bg-white/10`}>
              Close
            </button>
            <button
              type="button"
              onClick={() => {
                const first = chapters[0];
                if (!first) return;
                onRunAll();
                void startTour(first.id);
              }}
              className={`${BUTTON} bg-mars text-white hover:bg-mars/80`}
            >
              Run all
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

/** Header button: opens the chapter menu. */
export function TutorialButton() {
  const startTour = useAppStore((s) => s.startTour);
  const active = useAppStore((s) => s.tour.active);
  return (
    <button
      type="button"
      data-tour="tutorial"
      disabled={active}
      onClick={() => {
        markPromptSeen();
        void startTour();
      }}
      className="rounded-md bg-white/5 px-2.5 py-1 text-sm hover:bg-white/10 disabled:opacity-40"
    >
      Tutorial
    </button>
  );
}

/** One-time "New here?" prompt. Not shown for share links or #brief, or once answered. */
export function FirstVisitPrompt() {
  const startTour = useAppStore((s) => s.startTour);
  const active = useAppStore((s) => s.tour.active);
  const [show, setShow] = useState(() => {
    const req = parseHash(location.hash);
    return req.kind !== 'shared' && req.kind !== 'brief' && !hasSeenPrompt();
  });
  useEffect(() => {
    if (active) setShow(false);
  }, [active]);
  if (!show || active) return null;
  return (
    <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60 p-4">
      <section role="dialog" aria-modal="true" aria-label="Tutorial prompt" className="w-full max-w-sm space-y-3 rounded-lg border border-white/15 bg-regolith p-5 text-sm shadow-2xl">
        <p className="text-base font-semibold">New here? Try the tutorial</p>
        <p className="text-white/70">A hands-on practice run, about a minute per chapter. Your setup comes back afterwards.</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              markPromptSeen();
              setShow(false);
            }}
            className={`${BUTTON} border border-white/30 hover:bg-white/10`}
          >
            No thanks
          </button>
          <button
            type="button"
            onClick={() => {
              markPromptSeen();
              setShow(false);
              void startTour(CHAPTERS[0]?.id ?? null);
            }}
            className={`${BUTTON} bg-mars text-white hover:bg-mars/80`}
          >
            Start
          </button>
        </div>
      </section>
    </div>
  );
}
