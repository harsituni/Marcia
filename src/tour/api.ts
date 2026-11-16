import { useAppStore } from '../store.ts';
import type { TourApi, TourState } from './types.ts';

/** Default wait for a step's target. */
export const WAIT_MS = 2000;

/** Clicks the first element matching `selector`; false if none. */
export async function click(selector: string): Promise<boolean> {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
}

/** Clicks a toggle only when its `aria-expanded` is "false". */
export async function ensureExpanded(selector: string): Promise<void> {
  const el = document.querySelector(selector);
  if (el instanceof HTMLElement && el.getAttribute('aria-expanded') === 'false') el.click();
}

/** Clicks a toggle only when its `aria-expanded` is "true" (closes it). */
export async function ensureCollapsed(selector: string): Promise<void> {
  const el = document.querySelector(selector);
  if (el instanceof HTMLElement && el.getAttribute('aria-expanded') === 'true') el.click();
}

export function waitFor(selector: string, ms = WAIT_MS): Promise<Element | null> {
  const found = document.querySelector(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const el = document.querySelector(selector);
      if (el || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve(el);
      }
    }, 50);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once `test(state)` is true, or after `ms` (with the last answer). */
export function waitForStore(test: (s: TourState) => boolean, ms = 5000): Promise<boolean> {
  if (test(useAppStore.getState())) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(test(useAppStore.getState()));
    }, ms);
    const unsub = useAppStore.subscribe((s) => {
      if (!test(s)) return;
      clearTimeout(timer);
      unsub();
      resolve(true);
    });
  });
}

/** The api a step's `setup` and `doIt` get, over the live store and document. Store actions: `api.state().setMode('walk')`. */
export function makeTourApi(): TourApi {
  return { state: () => useAppStore.getState(), click, ensureExpanded, waitFor, sleep };
}
