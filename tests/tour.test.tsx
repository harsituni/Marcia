// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeShare } from '../src/brief/share.ts';
import { EngineClient } from '../src/engine/client.ts';
import { resetEngine, sharePlanFrom, useAppStore } from '../src/store.ts';
import { DONE_KEY, FirstVisitPrompt, SEEN_KEY, Tour } from '../src/tour/Tour.tsx';
import type { TourChapter } from '../src/tour/types.ts';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIX = join(import.meta.dirname, '..', 'fixtures');
const store = () => useAppStore.getState();
const flush = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Test chapters over a plain button, so no map, Leaflet or App is mounted. */
const CHAPTERS: TourChapter[] = [
  {
    id: 'one',
    title: 'Chapter One',
    summary: 'First chapter.',
    steps: [
      { id: 'read', title: 'Read step', body: 'Just read.', target: '#t', placement: 'bottom' },
      {
        id: 'act',
        title: 'Act step',
        body: 'Do it.',
        target: '#t',
        action: {
          prompt: 'Press the button.',
          done: (_s, doc) => doc.body.dataset.pressed === '1',
          doIt: async () => {
            document.body.dataset.pressed = '1';
          },
        },
      },
      { id: 'lost', title: 'Lost step', body: 'No such control.', target: '[data-tour="nope"]' },
    ],
  },
  { id: 'two', title: 'Chapter Two', summary: 'Second chapter.', steps: [{ id: 'only', title: 'Only', body: 'Only step.', target: null }] },
];

let host: HTMLDivElement;
let root: Root;
const card = () => document.querySelector('[aria-label="Tutorial"]') as HTMLElement | null;
const text = () => document.body.textContent ?? '';
const btn = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const click = (label: string) => act(async () => btn(label).click());
const key = (k: string) => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

async function mount(ui = createElement(Tour, { chapters: CHAPTERS })) {
  await act(async () => root.render(ui));
}

async function open(chapter: string | null = 'one', step = 0) {
  await act(async () => {
    await store().startTour(chapter);
    if (step) store().setTourStep(step);
  });
  await flush(120);
}

beforeEach(async () => {
  resetEngine();
  localStorage.clear();
  delete document.body.dataset.pressed;
  const worker = new FakeWorker();
  useAppStore.setState({
    makeEngine: () => new EngineClient(worker),
    fetchDonki: async () => {
      throw new Error('offline');
    },
    mode: 'plan',
    siteId: 'jezero',
  });
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  await store().loadData('/fixtures');
  host = document.createElement('div');
  host.innerHTML = '<button id="t">Target</button>';
  document.body.append(host);
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  if (store().tour.active) await act(async () => store().endTour());
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  location.hash = '';
  resetEngine();
  useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], avoidZones: [], drawingZone: null, mode: 'plan', briefOpen: false });
});

describe('Tour spotlight holes', () => {
  const actionStep = (extra: Partial<TourChapter['steps'][number]>): TourChapter[] => [
    { id: 'h', title: 'H', summary: 's', steps: [{ id: 'a', title: 'A', body: 'b', target: '#t', action: { prompt: 'Do', done: () => false, doIt: async () => {} }, ...extra }] },
  ];

  it('an action step on a centred-placement target still leaves the target live (no full-screen blocker)', async () => {
    await mount(createElement(Tour, { chapters: actionStep({ placement: 'center' }) }));
    await open('h');
    expect(document.querySelector('[data-tour-block="all"]')).toBeNull();
    expect(document.querySelector('[data-tour-block="hole"]')).toBeNull();
  });

  it('several targets render one spotlight per rect, with a hole each on action steps', async () => {
    host.innerHTML = '<button id="t">T</button><button id="u">U</button><button id="v">V</button>';
    await mount(createElement(Tour, { chapters: actionStep({ targets: ['#u', '#v'] }) }));
    await open('h');
    expect(document.querySelectorAll('[data-tour-spotlight]').length).toBe(3);
    expect(document.querySelector('[data-tour-block="hole"]')).toBeNull();
    await act(async () => store().endTour());
    await mount(createElement(Tour, { chapters: [{ id: 'r', title: 'R', summary: 's', steps: [{ id: 'a', title: 'A', body: 'b', target: '#t', targets: ['#u', '#v'] }] }] }));
    await open('r');
    expect(document.querySelectorAll('[data-tour-spotlight]').length).toBe(3);
    expect(document.querySelectorAll('[data-tour-block="hole"]').length).toBe(3);
  });
});

describe('Tour overlay', () => {
  it('renders nothing until the tutorial starts', async () => {
    await mount();
    expect(card()).toBeNull();
    expect(document.querySelector('.tour')).toBeNull();
  });

  it('shows "Chapter · Step n of N" and gates Next on a hands-on step', async () => {
    await mount();
    await open('one', 1);
    expect(text()).toContain('Chapter One · Step 2 of 3');
    expect(text()).toContain('Press the button.');
    expect(btn('Next').disabled).toBe(true);
    document.body.dataset.pressed = '1';
    await flush(400); // the DOM poll notices
    expect(btn('Next').disabled).toBe(false);
    expect(text()).toContain('✓ Done');
  });

  it('Show me does the action and unlocks Next', async () => {
    await mount();
    await open('one', 1);
    await click('Show me');
    await flush(150);
    expect(document.body.dataset.pressed).toBe('1');
    expect(btn('Next').disabled).toBe(false);
  });

  it('a read-only step has Next ready and blocks its target; an action step leaves a hole', async () => {
    await mount();
    await open('one', 0);
    expect(btn('Next').disabled).toBe(false);
    expect(document.querySelector('[data-tour-block="hole"]')).not.toBeNull();
    expect(['top', 'bottom', 'left', 'right'].every((p) => document.querySelector(`[data-tour-block="${p}"]`))).toBe(true);
    await click('Next');
    await flush(120);
    expect(store().tour.step).toBe(1);
    expect(document.querySelector('[data-tour-block="hole"]')).toBeNull(); // the target is clickable
    expect(['top', 'bottom', 'left', 'right'].every((p) => document.querySelector(`[data-tour-block="${p}"]`))).toBe(true);
  });

  it('swallows clicks on the blocking rectangles', async () => {
    await mount();
    await open('one', 1);
    const top = document.querySelector('[data-tour-block="top"]') as HTMLElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => void top.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true); // swallowed by the blocker, not passed to the app
  });

  it('falls back to a centred card when the target is missing', async () => {
    await mount();
    await open('one', 2);
    await flush(2300);
    expect(card()?.dataset.placement).toBe('center');
    expect(document.querySelector('[data-tour-block="all"]')).not.toBeNull();
  });

  it('ArrowRight / Enter advance only when Next is enabled; ArrowLeft goes back', async () => {
    await mount();
    await open('one', 1);
    await key('ArrowRight');
    expect(store().tour.step).toBe(1);
    await key('ArrowLeft');
    expect(store().tour.step).toBe(0);
  });

  it('leaves keys alone while typing in a field inside the spotlight', async () => {
    host.innerHTML = '<div id="t"><input id="field" /></div>';
    await mount();
    await open('one', 0);
    const input = document.getElementById('field') as HTMLInputElement;
    input.focus();
    await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(store().tour.active).toBe(true);
  });

  it('Esc ends the tutorial without the app underneath seeing it (an open brief stays open)', async () => {
    await mount();
    await open('one', 0);
    const underneath = vi.fn();
    window.addEventListener('keydown', underneath); // like the brief's own Esc handler
    await key('Escape');
    await flush(50);
    window.removeEventListener('keydown', underneath);
    expect(underneath).not.toHaveBeenCalled();
    expect(store().tour.active).toBe(false);
  });

  it('"I got it, skip tutorial" ends it and puts the crew setup back', async () => {
    useAppStore.setState({ colorVision: 'deuteranopia', layers: { ...store().layers, sand: true } });
    const before = { stops: store().stops, constraints: store().constraints, layers: store().layers, vision: store().colorVision };
    await mount();
    await open('one', 0);
    expect(store().layers.sand).toBe(false); // practice run
    await click('I got it, skip tutorial');
    await flush(50);
    expect(store().tour.active).toBe(false);
    expect(card()).toBeNull();
    expect(store().stops).toEqual(before.stops);
    expect(store().constraints).toEqual(before.constraints);
    expect(store().layers).toEqual(before.layers);
    expect(store().colorVision).toBe(before.vision);
  });

  it('Esc also restores the crew setup', async () => {
    const before = store().stops;
    await mount();
    await open('one', 0);
    await act(async () => store().moveStop(store().stops[0]!.id, store().stops[0]!.cell));
    await key('Escape');
    await flush(50);
    expect(store().stops).toEqual(before);
  });
});

describe('chapter menu', () => {
  it('lists chapters, ticks finished ones from localStorage, and has Run all and Close', async () => {
    localStorage.setItem(DONE_KEY, JSON.stringify(['two']));
    await mount();
    await open(null);
    expect(text()).toContain('Chapter One');
    const two = document.querySelector('[data-chapter="two"]')!;
    const one = document.querySelector('[data-chapter="one"]')!;
    expect(two.textContent).toContain('✓');
    expect(one.textContent).not.toContain('✓');
    expect(btn('Run all')).toBeDefined();
    await click('Close');
    await flush(50);
    expect(store().tour.active).toBe(false);
  });

  it('finishing a chapter remembers it and returns to the menu', async () => {
    await mount();
    await open('two', 0);
    await click('Finish chapter');
    await flush(50);
    expect(JSON.parse(localStorage.getItem(DONE_KEY)!)).toEqual(['two']);
    expect(store().tour.chapter).toBeNull();
    expect(document.querySelector('[data-chapter="two"]')!.textContent).toContain('✓');
  });

  it('Run all continues into the next chapter', async () => {
    await mount();
    await open(null);
    await click('Run all');
    await flush(120);
    expect(store().tour.chapter).toBe('one');
  });
});

describe('FirstVisitPrompt', () => {
  it('shows once per browser', async () => {
    await mount(createElement(FirstVisitPrompt));
    expect(text()).toContain('New here? Try the tutorial');
    const prompt = document.querySelector('[role="dialog"][aria-modal="true"][aria-label="Tutorial prompt"]');
    expect(prompt).not.toBeNull();
    expect(prompt?.parentElement?.className).toContain('items-center');
    expect(prompt?.parentElement?.className).toContain('justify-center');
    await click('No thanks');
    expect(text()).not.toContain('New here?');
    expect(localStorage.getItem(SEEN_KEY)).toBe('1');
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await mount(createElement(FirstVisitPrompt));
    expect(text()).not.toContain('New here?');
  });

  it('Start opens the tutorial', async () => {
    await mount(createElement(FirstVisitPrompt));
    await act(async () => btn('Start').click());
    await flush(50);
    expect(store().tour.active).toBe(true);
    expect(localStorage.getItem(SEEN_KEY)).toBe('1');
  });

  it('is not shown for a share link or #brief', async () => {
    location.hash = '#brief';
    await mount(createElement(FirstVisitPrompt));
    expect(text()).not.toContain('New here?');
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    location.hash = `#brief=${encodeShare(sharePlanFrom(store(), 'test', new Date()))}`;
    await mount(createElement(FirstVisitPrompt));
    expect(text()).not.toContain('New here?');
  });
});
