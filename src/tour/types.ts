/**
 * Tutorial step format shared by the engine (#103) and the chapter files (#104, #105).
 * Keep this file identical across branches.
 */
import type { useAppStore } from '../store.ts';

export type TourState = ReturnType<typeof useAppStore.getState>;

/** What a step's setup / Show me can do. */
export interface TourApi {
  /** Current store state (call again after awaiting; it changes). */
  state: () => TourState;
  /** Clicks the first element matching `selector`; false if none. */
  click: (selector: string) => Promise<boolean>;
  /** Clicks a toggle only when its `aria-expanded` is "false". */
  ensureExpanded: (selector: string) => Promise<void>;
  /** Resolves with the element once it exists, or null after `ms` (default 2000). */
  waitFor: (selector: string, ms?: number) => Promise<Element | null>;
  sleep: (ms: number) => Promise<void>;
}

/** A hands-on step: the user does it, or presses Show me. */
export interface TourAction {
  /** Instruction shown on the card, e.g. "Click the map to add a stop." */
  prompt: string;
  /** True once the action has really happened (checked on every store change and a short DOM poll). */
  done: (state: TourState, doc: Document) => boolean;
  /** What Show me does. */
  doIt: (api: TourApi) => Promise<void>;
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector for the highlighted control, or null for a centred card. */
  target: string | null;
  /** More spotlight rects besides `target`; everything else is dimmed and blocked. */
  targets?: string[];
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  /** Puts the app in the right state before the step shows. Never performs the step's own action. */
  setup?: (api: TourApi) => Promise<void> | void;
  action?: TourAction;
  /** Extra line shown under the body only when it returns text (e.g. live data is paused right now). */
  note?: (state: TourState) => string | null;
}

export interface TourChapter {
  id: string;
  title: string;
  /** One line for the chapter menu. */
  summary: string;
  steps: TourStep[];
}
