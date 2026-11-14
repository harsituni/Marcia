import { useId, useState } from 'react';
import type { Constraints } from '../contracts.ts';
import { usableOxygenMin } from '../engine/model.ts';
import { DEFAULT_CONSTRAINTS, useAppStore } from '../store.ts';
import { LIMITS } from './constraints.ts';

/** EVA limits: oxygen supply, reserve and max slope. Every change reroutes. */
export function SettingsPanel() {
  const constraints = useAppStore((s) => s.constraints);
  const setConstraints = useAppStore((s) => s.setConstraints);
  const gridMaxSlope = useAppStore((s) => (s.data.status === 'ready' ? s.data.grid.meta.maxSlopeDeg : DEFAULT_CONSTRAINTS.maxSlopeDeg));
  const [open, setOpen] = useState(true);
  const bodyId = useId();

  const usable = Math.round(usableOxygenMin(constraints.oxygenMin, constraints.reservePct));

  return (
    <section
      aria-label="EVA settings"
      className="absolute top-3 right-3 z-[1000] w-64 rounded-lg bg-black/70 text-sm shadow-lg backdrop-blur-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 font-semibold"
      >
        Settings
        <span aria-hidden="true" className="text-white/60">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="space-y-3 border-t border-white/10 px-3 pt-2 pb-3">
          <Slider
            label="Oxygen supply"
            unit="min"
            value={constraints.oxygenMin}
            {...LIMITS.oxygenMin}
            onChange={(oxygenMin) => setConstraints({ oxygenMin })}
          />
          <Slider
            label="Reserve on return"
            unit="%"
            value={constraints.reservePct}
            {...LIMITS.reservePct}
            onChange={(reservePct) => setConstraints({ reservePct })}
          />
          <Slider
            label="Max slope"
            unit="°"
            value={constraints.maxSlopeDeg}
            min={LIMITS.maxSlopeDeg.min}
            max={gridMaxSlope}
            step={LIMITS.maxSlopeDeg.step}
            onChange={(maxSlopeDeg) => setConstraints({ maxSlopeDeg })}
          />
          <div className="flex items-center justify-between text-xs text-white/70">
            <span>
              Usable oxygen: <span className="font-semibold text-white">{usable} min</span>
            </span>
            <button
              type="button"
              onClick={() => setConstraints(DEFAULT_CONSTRAINTS)}
              disabled={sameConstraints(constraints, DEFAULT_CONSTRAINTS)}
              className="rounded px-2 py-0.5 hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Slider(props: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label htmlFor={id}>{props.label}</label>
        <output htmlFor={id} className="font-semibold tabular-nums">
          {props.value}
          {props.unit === '°' || props.unit === '%' ? '' : ' '}
          {props.unit}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.valueAsNumber)}
        className="w-full accent-mars"
      />
    </div>
  );
}

function sameConstraints(a: Constraints, b: Constraints): boolean {
  return a.oxygenMin === b.oxygenMin && a.reservePct === b.reservePct && a.maxSlopeDeg === b.maxSlopeDeg;
}
