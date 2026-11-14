import { useEffect } from 'react';
import { formatDuration } from '../plan/profile.ts';
import { useAppStore } from '../store.ts';
import { SPEEDS } from './replay.ts';

/** Drives the replay clock from animation frames while it's playing. */
function useReplayClock() {
  const playing = useAppStore((s) => s.replay.status === 'playing');
  const tickWalk = useAppStore((s) => s.tickWalk);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      // Cap the step so a background tab doesn't jump the walk forward.
      tickWalk(Math.min(0.25, (now - last) / 1000));
      last = now;
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, tickWalk]);
}

/** Play/pause, restart, speed and scrubber for the simulated walk. */
export function ReplayBar({ totalMin }: { totalMin: number }) {
  useReplayClock();
  const replay = useAppStore((s) => s.replay);
  const playWalk = useAppStore((s) => s.playWalk);
  const pauseWalk = useAppStore((s) => s.pauseWalk);
  const resetWalk = useAppStore((s) => s.resetWalk);
  const seekWalk = useAppStore((s) => s.seekWalk);
  const setWalkSpeed = useAppStore((s) => s.setWalkSpeed);

  const playing = replay.status === 'playing';
  const fraction = totalMin > 0 ? replay.elapsedMin / totalMin : 0;
  const button = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/10 hover:bg-white/20';

  return (
    <div
      role="group"
      aria-label="Walk replay"
      className="pointer-events-auto mx-auto flex w-full max-w-xl items-center gap-2 rounded-xl border border-white/15 bg-black/65 px-2 py-1.5 text-sm shadow-lg backdrop-blur-sm"
    >
      <button type="button" className={`${button} bg-mars hover:bg-mars/80`} onClick={playing ? pauseWalk : playWalk} aria-label={playing ? 'Pause walk' : replay.status === 'done' ? 'Replay walk' : 'Start walk'}>
        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-white" aria-hidden="true">
          {playing ? <path d="M3 2h4v12H3zM9 2h4v12H9z" /> : <path d="M4 2l10 6-10 6z" />}
        </svg>
      </button>
      <button type="button" className={button} onClick={resetWalk} aria-label="Restart walk" disabled={replay.status === 'idle'}>
        <svg viewBox="0 0 16 16" className={`h-4 w-4 fill-white ${replay.status === 'idle' ? 'opacity-40' : ''}`} aria-hidden="true">
          <path d="M2 2h2v12H2zM14 2v12L5 8z" />
        </svg>
      </button>
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(fraction * 1000)}
        onChange={(e) => seekWalk(e.currentTarget.valueAsNumber / 1000)}
        aria-label="Walk progress"
        className="min-w-0 flex-1 accent-mars"
      />
      <span className="shrink-0 font-mono text-xs whitespace-nowrap tabular-nums" aria-label={`Elapsed ${formatDuration(replay.elapsedMin)} of ${formatDuration(totalMin)}`}>
        {formatDuration(replay.elapsedMin)} <span className="hidden text-white/50 sm:inline">/ {formatDuration(totalMin)}</span>
      </span>
      <div role="group" aria-label="Replay speed" className="flex shrink-0 overflow-hidden rounded-md bg-white/10 font-mono text-[11px]">
        {SPEEDS.map((x) => (
          <button
            key={x}
            type="button"
            aria-pressed={replay.speed === x}
            onClick={() => setWalkSpeed(x)}
            className={`px-1.5 py-1 ${replay.speed === x ? 'bg-white/25 font-bold' : 'text-white/60 hover:text-white'}`}
          >
            {x}×
          </button>
        ))}
      </div>
    </div>
  );
}
