import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '../src/engine/client.ts';
import { COLORS, Difficulty, classifyCost, difficultyPixels, overlayScale, sandPixels } from '../src/map/overlays.ts';
import { DEFAULT_CONSTRAINTS, REPLAN_DELAY_MS, resetEngine, useAppStore } from '../src/store.ts';
import { FakeWorker } from './fakeWorker.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const px = (p: { width: number; data: Uint8ClampedArray }, x: number, y: number) => [...p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];

describe('classifyCost', () => {
  it('blocked is no-go, cheap is easy, >1.5× cheapest is caution', () => {
    const c = classifyCost(new Float32Array([1, 1.5, 1.6, 4, Infinity]));
    expect([...c]).toEqual([Difficulty.Easy, Difficulty.Easy, Difficulty.Caution, Difficulty.Caution, Difficulty.NoGo]);
  });

  it('every fixture cell gets a class, and blocked cells are no-go', () => {
    const b = readFileSync(join(FIX, 'cost.bin'));
    const cost = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    const c = classifyCost(cost);
    const counts = [0, 0, 0];
    c.forEach((k, i) => {
      counts[k]!++;
      if (!Number.isFinite(cost[i]!)) expect(k).toBe(Difficulty.NoGo);
    });
    expect(counts.every((n) => n > 0)).toBe(true);
  });
});

describe('overlay pixels', () => {
  // 3×1 grid: easy, caution, no-go; 6 px per cell.
  const p = difficultyPixels(new Uint8Array([0, 1, 2]), 3, 1, 6);

  it('uses blue for easy and yellow for caution', () => {
    expect(p.width).toBe(18);
    expect(p.height).toBe(6);
    expect(px(p, 2, 2).slice(0, 3)).toEqual(hex(COLORS.easy));
    expect(px(p, 8, 2).slice(0, 3)).toEqual(hex(COLORS.caution));
  });

  it('hatches no-go in orange-red with alternating strong/faint stripes', () => {
    const cells = Array.from({ length: 6 }, (_, i) => px(p, 12 + i, 0));
    cells.forEach((c) => expect(c.slice(0, 3)).toEqual(hex(COLORS.noGo)));
    expect(new Set(cells.map((c) => c[3])).size).toBe(2);
  });

  it('leaves non-sand cells transparent and stipples sand', () => {
    const s = sandPixels(new Uint8Array([0, 1]), 2, 1, 4);
    expect(px(s, 1, 1)[3]).toBe(0);
    expect(px(s, 5, 1).slice(0, 3)).toEqual(hex(COLORS.caution));
    expect(px(s, 5, 1)[3]).toBeGreaterThan(px(s, 6, 2)[3]!);
  });

  it('scales to roughly 1200 px wide', () => {
    expect(overlayScale(100)).toBe(12);
    expect(overlayScale(600)).toBe(2);
  });
});

describe('layer toggles', () => {
  let worker: FakeWorker;
  const store = () => useAppStore.getState();
  const ringRequests = () => worker.sent.filter((m) => m.type === 'ring');
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(async () => {
    worker = new FakeWorker();
    resetEngine();
    useAppStore.setState({ makeEngine: () => new EngineClient(worker), constraints: DEFAULT_CONSTRAINTS, ring: null });
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
    await store().loadData('/fixtures');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({
      data: { status: 'idle' },
      route: { status: 'idle' },
      stops: [],
      ring: null,
      layers: { difficulty: false, sand: false, geology: false, crism: false, ring: false },
      constraints: DEFAULT_CONSTRAINTS,
    });
  });

  it('each layer switches on and off', () => {
    for (const id of ['difficulty', 'sand', 'geology', 'crism', 'ring'] as const) {
      expect(store().layers[id]).toBe(false);
      store().toggleLayer(id);
      expect(store().layers[id]).toBe(true);
      store().toggleLayer(id);
      expect(store().layers[id]).toBe(false);
    }
  });

  it('the ring is requested from the worker with the usable oxygen', async () => {
    expect(ringRequests()).toHaveLength(0);
    store().toggleLayer('ring');
    await settle();
    expect(ringRequests()).toHaveLength(1);
    const req = ringRequests()[0];
    expect(req?.type === 'ring' && req.oxygenLeftMin).toBe(480 * 0.8);
    expect(store().ring?.polygon.length).toBeGreaterThan(2);
  });

  it('the ring follows constraint changes while it is on', async () => {
    store().toggleLayer('ring');
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store().setConstraints({ oxygenMin: 120 });
    vi.advanceTimersByTime(REPLAN_DELAY_MS);
    vi.useRealTimers();
    await settle();
    await settle();
    const last = ringRequests().at(-1);
    expect(last?.type === 'ring' && last.oxygenLeftMin).toBe(120 * 0.8);
  });

  it('no ring requests while the layer is off', async () => {
    await store().planRoute();
    expect(ringRequests()).toHaveLength(0);
  });
});
