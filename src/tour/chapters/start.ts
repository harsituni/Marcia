import { hasNoData, noDataText } from '../../engine/spaceWeather.ts';
import type { TourApi, TourChapter, TourState } from '../types.ts';

/** Chapter 1 (#103): Getting started. See `../steps.ts` for the step format. */

/**
 * Only when NASA DONKI is unreachable right now (or answers with gaps): says live
 * space weather is paused. Nothing while the live check is fine, still loading,
 * or the storm demo (saved data) is on.
 */
export function liveDataPausedNote(state: TourState): string | null {
  const sw = state.spaceWeather;
  if (sw.demo || sw.loading) return null;
  const tail = 'Everything else still works, and the storm demo uses saved data.';
  if (!sw.assessment) {
    return sw.error ? `Live space weather is paused: NASA DONKI can't be reached right now. ${tail}` : null;
  }
  if (sw.stale) return `Live space weather is paused: NASA DONKI can't be reached right now, so this shows the last saved check. ${tail}`;
  if (hasNoData(sw.assessment)) return `Part of the live feed is paused right now (${noDataText(sw.assessment)}). ${tail}`;
  return null;
}

const CHIP = '[data-tour="space-weather"]';
const PANEL = 'section[aria-label="Space weather"]';
const ABOUT = '[data-tour="about"]';
const ABOUT_DIALOG = '[role="dialog"][aria-label="About and data sources"]';
const ABOUT_CLOSE = `${ABOUT_DIALOG} button[aria-label="Close"]`;

async function closePanel(api: TourApi): Promise<void> {
  if (document.querySelector(PANEL)) await api.click(CHIP);
}

async function closeAbout(api: TourApi): Promise<void> {
  await api.click(ABOUT_CLOSE);
}

export const START_CHAPTER: TourChapter = {
  id: 'getting-started',
  title: 'Getting started',
  summary: 'The site, space weather, the brief and the two modes.',
  steps: [
    {
      id: 'welcome',
      title: 'Welcome to Marcia',
      body:
        'Marcia plans a safe walk on Mars, from the habitat through science stops at Jezero or Gale crater, then guides it on a helmet display. This is a practice run on Jezero: your own setup comes back when the tutorial ends. Use Show me if you get stuck, or "I got it, skip tutorial" at any time.',
      target: null,
      placement: 'center',
    },
    {
      id: 'site',
      title: 'Pick a site',
      body:
        'There are two sites: Jezero crater and Gale crater. At Gale, walking cost comes from slope alone, because no sand or thermal-inertia map covers it, and it has no geology or mineral layers. Switching site clears your stops, so we stay on Jezero.',
      target: '[data-tour="site"]',
      placement: 'bottom',
    },
    {
      id: 'space-weather-chip',
      title: 'Space weather',
      body: 'This chip shows whether solar activity is quiet, tightens your limits, or blocks the walk.',
      target: CHIP,
      placement: 'bottom',
      note: liveDataPausedNote,
      setup: closePanel,
      action: {
        prompt: 'Click the space-weather chip.',
        done: (_s, doc) => !!doc.querySelector(PANEL),
        doIt: (api) => api.ensureExpanded(CHIP),
      },
    },
    {
      id: 'space-weather-panel',
      title: 'Why it says that',
      body:
        'Marcia checks NASA DONKI for solar particle events, flares and storms heading for Mars, and lists the reasons here. Particle and flare readings are taken near Earth, so they are a stand-in for Mars. The storm-demo checkbox replays a real past storm; the Storms chapter uses it.',
      target: PANEL,
      placement: 'left',
      note: liveDataPausedNote,
      setup: (api) => api.ensureExpanded(CHIP),
    },
    {
      id: 'brief',
      title: 'Mission brief',
      body: 'A printable plan: each leg, the totals, the alerts to expect and every data source. You can share it as a link.',
      target: '[data-tour="brief"]',
      placement: 'bottom',
      setup: closePanel,
    },
    {
      id: 'about',
      title: 'Where the data comes from',
      body: 'About lists every dataset behind the site, and what is a modelled estimate rather than a measurement.',
      target: ABOUT,
      placement: 'bottom',
      setup: async (api) => {
        await closePanel(api);
        await closeAbout(api);
      },
      action: {
        prompt: 'Open About to see every data source.',
        done: (_s, doc) => !!doc.querySelector(ABOUT_DIALOG),
        doIt: async (api) => {
          if (!document.querySelector(ABOUT_DIALOG)) await api.click(ABOUT);
        },
      },
    },
    {
      id: 'view',
      title: '2D and 3D',
      body:
        '3D drapes the orbital photo over the terrain, with heights exaggerated 3 times so slopes stand out. You can look around in 3D; stops are edited in 2D.',
      target: '[role="tablist"][aria-label="Map view"]',
      placement: 'bottom',
      setup: closeAbout,
    },
    {
      id: 'mode',
      title: 'Plan, then Walk',
      body:
        'Plan the route here in the habitat. Then switch to Walk to follow it on the helmet display, as a simulated replay of the walk. That is the end of this chapter.',
      target: '[role="tablist"][aria-label="Mode"]',
      placement: 'bottom',
      setup: closeAbout,
    },
  ],
};
