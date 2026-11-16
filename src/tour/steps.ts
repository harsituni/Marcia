/**
 * Hands-on tutorial chapters (#103). Steps are data (types in `./types.ts`);
 * `Tour.tsx` runs them.
 *
 * HOW TO ADD CHAPTERS (#104, #105)
 * - Put them in their own file under `chapters/` exporting a `TourChapter[]`, then
 *   spread that array into `CHAPTERS` at its placeholder below. Touch nothing else.
 * - Every chapter starts on a fresh practice run: Jezero, its preset stops, default
 *   settings, Plan mode, 2D, layers off, no avoid zones, storm demo off, nothing open.
 *
 * A STEP
 * - `id`: unique within the chapter (lowercase-dashed). `title`, `body`: 1-3 plain
 *   sentences. Say only what the app really does; call estimates estimates.
 * - `target`: CSS selector of the control to spotlight. Use only an existing
 *   `aria-label` (`section[aria-label="Route stats"]`) or a `data-tour` anchor
 *   (`[data-tour="layers"]`); a test checks every one exists in `src/`. `null` gives a
 *   centred card, and so does a target not found within 2 s.
 * - `placement`: where the card sits beside the target (default 'bottom'; 'center'
 *   centres it). On phones the card docks to the bottom (or top) edge.
 * - `setup(api)`: puts the app in the state this step needs (switch mode, open a
 *   panel, close what the last step opened). It runs on Next AND on Back, so make it
 *   idempotent. It must NEVER do the step's own action.
 * - `action` (optional; a hands-on step). Without one the step is read-and-Next and
 *   its target can't be clicked. With one the target stays clickable and Next stays
 *   disabled until `done` (or until Show me has run).
 *   - `prompt`: the instruction, e.g. "Click the map to add a stop."
 *   - `done(state, document)`: true once it has really happened. Checked on every store
 *     change and every 250 ms; for UI with local state (panels, About), look at the DOM.
 *   - `doIt(api)`: what Show me does. Afterwards `done` should be true.
 *
 * THE API (`makeTourApi()` in `./api.ts`)
 * - `api.state()`: the live store, actions included: `api.state().setMode('walk')`,
 *   `api.state().addStop(cell)`. `toggleLayer` toggles, so check `api.state().layers` first.
 * - `api.click(sel)`, `api.ensureExpanded(sel)` (clicks only if `aria-expanded="false"`),
 *   `api.waitFor(sel, ms)`, `api.sleep(ms)`.
 */
import { START_CHAPTER } from './chapters/start.ts';
import type { TourChapter } from './types.ts';

/** Every chapter, in menu order. */
export const CHAPTERS: TourChapter[] = [
  START_CHAPTER,
];
