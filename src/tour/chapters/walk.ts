/** Tutorial chapters 5 and 6: walking the route, and storms and safety (#105). */
import type { TourApi, TourChapter, TourState, TourStep } from '../types.ts';

const MODE_TABS = '[role=tablist][aria-label="Mode"]';
const HUD_LEFT = '[data-tour="hud-left"]';
const HUD_CENTRE = '[data-tour="hud-centre"]';
const HUD_RIGHT = '[data-tour="hud-right"]';
const WARNING = '[role=dialog][aria-label="Walk warning"]';
const REPLAY = '[role=group][aria-label="Walk replay"]';
const ALERTS = 'ul[aria-label="Alerts"]';
const CHIP = '[data-tour="space-weather"]';
const MAP = '.leaflet-container';
const REPLAN_NOTE = '[role=status][aria-label="Replan result"]';

/** Elements matching `sel`, or none without a document (unit tests). */
const all = (sel: string): Element[] => (typeof document === 'undefined' ? [] : [...document.querySelectorAll(sel)]);

/** Clicks the Walk tab of the real mode switch (which opens the warning when one applies). */
async function clickWalkTab(api: TourApi): Promise<boolean> {
  const tab = all(`${MODE_TABS} [role=tab]`).find((t) => /walk/i.test(t.textContent ?? ''));
  if (!tab) return false;
  (tab as HTMLElement).click();
  await api.sleep(50);
  return true;
}

/** Puts the app in Walk mode. Never plays or replans by itself. */
function inWalk(api: TourApi) {
  if (api.state().mode !== 'walk') api.state().setMode('walk');
}

async function freshWalk(api: TourApi) {
  inWalk(api);
  const replanned = !!api.state().replanned;
  api.state().resetWalk();
  // After a replan, wait for the original route to be planned again.
  if (replanned) for (let i = 0; i < 100 && (api.state().replanned || api.state().route.status !== 'ready'); i++) await api.sleep(50);
}

function stormOn(api: TourApi) {
  if (!api.state().spaceWeather.demo) api.state().setSpaceWeatherDemo(true);
}

/** Walk mode with the storm on and the crew a little way out, paused. */
async function walkedOut(api: TourApi) {
  stormOn(api);
  if (api.state().replanned) await freshWalk(api);
  inWalk(api);
  if (!awayFromHabitat(api.state())) api.state().seekWalk(0.3);
  api.state().pauseWalk();
}

// Values noted when a step starts, so "changed" means changed by the person.
let speedBaseline = 0;
let seekBaseline = 0;

/** The crew has used most of its air: what is left no longer covers the stops ahead, but does cover the way home. */
function lowerOxygen(api: TourApi) {
  const s = api.state();
  const route = s.route;
  const walk = s.walk;
  if (route.status !== 'ready' || !walk) return;
  const reserve = (s.constraints.oxygenMin * s.constraints.reservePct) / 100;
  const left = reserve + route.result.oxygenUsedMin * 0.45;
  s.setWalk({ ...walk, oxygenLeftMin: Math.min(walk.oxygenLeftMin, left) });
}

const awayFromHabitat = (s: TourState) => (s.walk?.pathIdx ?? 0) > 0;

const ch5Steps: TourStep[] = [
  {
    id: 'walking-switch',
    title: 'Switch to Walk',
    body: 'Plan is for deciding; Walk is for rehearsing. Walk mode replays your route as a spacewalk, minute by minute, from the habitat.',
    target: MODE_TABS,
    placement: 'bottom',
    setup: (api) => {
      api.state().setSpaceWeatherDemo(false);
      if (api.state().mode !== 'plan') api.state().setMode('plan');
    },
    action: {
      prompt: 'Click Walk in the mode switch.',
      done: (s) => s.mode === 'walk',
      doIt: async (api) => {
        api.state().setMode('walk');
      },
    },
  },
  {
    id: 'walking-hud',
    title: 'The helmet display',
    body: 'This is what the crew would see in the helmet: a few gauges built to be read at a glance, not studied. Everything on it updates as the walk goes on.',
    target: HUD_LEFT,
    targets: [HUD_CENTRE, HUD_RIGHT, REPLAY],
    placement: 'bottom',
    setup: (api) => {
      api.state().setSpaceWeatherDemo(false);
      inWalk(api);
    },
  },
  {
    id: 'walking-play',
    title: 'Play the walk',
    body: "The replay walks the route at 50 m per minute, using one oxygen-minute per minute. Those are Marcia's planning estimates, not measurements.",
    target: REPLAY,
    placement: 'top',
    setup: freshWalk,
    action: {
      prompt: 'Press Play.',
      done: (s) => s.replay.status === 'playing' || s.replay.elapsedMin > 0,
      doIt: async (api) => {
        api.state().playWalk();
      },
    },
  },
  {
    id: 'walking-speed',
    title: 'Change the speed',
    body: 'A real walk takes as long as it takes. The replay runs faster so you can see the whole route: 60, 240 or 600 times real time.',
    target: '[role=group][aria-label="Replay speed"]',
    placement: 'top',
    setup: (api) => {
      inWalk(api);
      speedBaseline = api.state().replay.speed;
    },
    action: {
      prompt: 'Pick a different speed.',
      done: (s) => s.replay.speed !== speedBaseline,
      doIt: async (api) => {
        api.state().setWalkSpeed(speedBaseline === 600 ? 240 : 600);
      },
    },
  },
  {
    id: 'walking-scrub',
    title: 'Drag the scrubber',
    body: 'Jump anywhere in the walk. The gauges, alerts and mini-map all move to that moment, so you can check any point of the route.',
    target: 'input[aria-label="Walk progress"]',
    placement: 'top',
    setup: (api) => {
      inWalk(api);
      api.state().pauseWalk();
      seekBaseline = api.state().replay.elapsedMin;
    },
    action: {
      prompt: 'Drag the progress bar to a new spot.',
      done: (s) => s.replay.elapsedMin !== seekBaseline,
      doIt: async (api) => {
        api.state().seekWalk(0.4);
      },
    },
  },
  {
    id: 'walking-compass',
    title: 'Compass and next stop',
    body: 'The compass shows which way you are heading, and the next-stop card shows where you are going and how far is left to walk.',
    target: '[role=img][aria-label^="Compass"]',
    placement: 'right',
    setup: inWalk,
  },
  {
    id: 'walking-oxygen',
    title: 'Oxygen and return margin',
    body: 'The oxygen gauge shows what is left in the tank. The return margin is the spare oxygen you would have if you turned for home right now. As it nears zero, it is time to turn back.',
    target: '[role=img][aria-label^="Return margin"]',
    placement: 'top',
    setup: inWalk,
  },
  {
    id: 'walking-meda-rad',
    title: 'Weather and radiation',
    body: 'The weather (MEDA) and radiation (RAD) gauges are modelled estimates shaped on ranges published for the Perseverance and Curiosity rovers. They are not live telemetry.',
    target: '[role=img][aria-label^="Weather MEDA"]',
    placement: 'top',
    setup: inWalk,
  },
  {
    id: 'walking-minimap',
    title: 'Mini-map and turn-back ring',
    body: 'The mini-map shows you, your route and the live turn-back ring: how far you could still walk out and get back from. The ring shrinks as your oxygen drops.',
    target: '[role=img][aria-label^="Mini-map"]',
    placement: 'left',
    setup: inWalk,
  },
  {
    id: 'walking-alerts',
    title: 'Alerts',
    body: 'Alerts appear when something needs attention: low oxygen, going off the route, a slope over your limit, or space weather. Red alerts are critical and sit at the top.',
    target: ALERTS,
    placement: 'bottom',
    setup: inWalk,
  },
  {
    id: 'walking-replan',
    title: 'Replan from here',
    body: 'If the route no longer fits your oxygen, replan from where you stand. Marcia drops the lowest-science stops until the route fits, and always gives you a way home.',
    target: '[data-tour="replan"]',
    placement: 'top',
    setup: async (api) => {
      inWalk(api);
      // A replan from an earlier visit: plan the route again from the habitat first.
      if (api.state().replanned) {
        api.state().resetWalk();
        for (let i = 0; i < 100 && (api.state().replanned || api.state().route.status !== 'ready'); i++) await api.sleep(50);
      }
      api.state().seekWalk(0.3);
      api.state().pauseWalk();
      lowerOxygen(api);
    },
    action: {
      prompt: 'Press Replan from here.',
      done: (s) => (s.replanned?.droppedIds.length ?? 0) > 0,
      doIt: async (api) => {
        await api.state().replanWalk();
      },
    },
  },
  {
    id: 'walking-replan-result',
    title: 'The replanned route',
    body: 'The route was redrawn from where you stand, and the stops it could no longer fit are greyed out. Marcia dropped the lowest science value first, so you can still get home with your reserve.',
    target: REPLAN_NOTE,
    targets: [MAP],
    placement: 'top',
    setup: inWalk,
  },
];

const ch6Steps: TourStep[] = [
  {
    id: 'storms-demo',
    title: 'Try a storm',
    body: 'Marcia checks NASA space-weather data. Open the space-weather chip and switch on the demo to replay a historical storm. The storm rules are Marcia estimates, and near-Earth readings stand in for Mars.',
    target: CHIP,
    placement: 'bottom',
    setup: (api) => {
      api.state().setSpaceWeatherDemo(false);
      if (api.state().mode !== 'plan') api.state().setMode('plan');
    },
    action: {
      prompt: 'Turn on "Demo: replay a historical storm".',
      done: (s) => s.spaceWeather.demo,
      doIt: async (api) => {
        api.state().setSpaceWeatherDemo(true);
      },
    },
  },
  {
    id: 'storms-warning',
    title: 'The Walk warning',
    body: 'When a storm blocks the spacewalk, Marcia warns you before the walk starts and lets you cancel. The warning lists why: the storm blocks the spacewalk, or stops are out of range. Walks here are a simulation.',
    target: MODE_TABS,
    placement: 'bottom',
    setup: async (api) => {
      stormOn(api);
      await freshWalk(api);
      if (api.state().mode !== 'plan') api.state().setMode('plan');
    },
    action: {
      prompt: 'Click the Walk tab.',
      done: (s, doc) => s.mode === 'walk' || !!doc.querySelector?.(WARNING),
      doIt: async (api) => {
        if (!(await clickWalkTab(api))) api.state().setMode('walk');
      },
    },
  },
  {
    id: 'storms-start-anyway',
    title: 'Start anyway',
    body: 'This is the warning: it lists why the walk is flagged (the storm blocks the spacewalk, or stops are out of range). You can cancel, or start anyway. Nothing here controls a real suit or a real walk: it is a simulation.',
    target: `${WARNING} section`,
    placement: 'right',
    setup: async (api) => {
      stormOn(api);
      if (api.state().mode !== 'plan') api.state().setMode('plan');
      if (!all(WARNING).length) {
        await clickWalkTab(api);
        await api.waitFor(WARNING, 500);
      }
    },
    action: {
      prompt: 'Press Start anyway (simulation).',
      done: (s) => s.mode === 'walk',
      doIt: async (api) => {
        const btn = all(`${WARNING} button`).find((b) => /start anyway/i.test(b.textContent ?? ''));
        if (btn) (btn as HTMLElement).click();
        else api.state().setMode('walk');
      },
    },
  },
  {
    id: 'storms-walk-out',
    title: 'Walk out',
    body: 'Start the walk and let it go a little way from the habitat. The storm demo is on, so the space-weather rules now count against you.',
    target: REPLAY,
    placement: 'top',
    setup: async (api) => {
      stormOn(api);
      await freshWalk(api);
    },
    action: {
      prompt: 'Press Play, or drag the scrubber, to walk away from the habitat.',
      done: (s) => awayFromHabitat(s),
      doIt: async (api) => {
        api.state().seekWalk(0.3);
      },
    },
  },
  {
    id: 'storms-alert',
    title: 'The red alert',
    body: 'Away from the habitat, the storm becomes a red critical alert: return to the habitat now. Red means act now, so it sits above everything else.',
    target: ALERTS,
    placement: 'bottom',
    setup: walkedOut,
  },
  {
    id: 'storms-head-home',
    title: 'Head home now',
    body: 'Head home now plans a direct way back to the habitat and drops every stop still ahead. It only shows when you are away from the habitat with a red alert.',
    target: '[data-tour="head-home"]',
    placement: 'top',
    setup: walkedOut,
    action: {
      prompt: 'Press Head home now.',
      done: (s) => s.replanned?.headedHome === true,
      doIt: async (api) => {
        await api.state().headHome();
      },
    },
  },
  {
    id: 'storms-heading-home',
    title: 'Heading straight home',
    body: 'The note reads "Heading straight home." The route now goes directly to the habitat, and the stops you skipped are greyed out.',
    target: REPLAN_NOTE,
    placement: 'top',
    setup: inWalk,
  },
  {
    id: 'storms-done',
    title: "That's the tour",
    body: 'Reopen the tutorial any time from the Tutorial button, and your own setup comes back when you leave. Marcia is a planning aid built on estimates, so always follow your real mission rules.',
    target: '[data-tour="tutorial"]',
    placement: 'bottom',
  },
];

export const WALK_CHAPTERS: TourChapter[] = [
  {
    id: 'walking',
    title: 'Walking the route',
    summary: 'Replay a walk, read the helmet display and replan.',
    steps: ch5Steps,
  },
  {
    id: 'storms',
    title: 'Storms and safety',
    summary: 'See a storm alert and head home.',
    steps: ch6Steps,
  },
];
