/**
 * Tutorial chapters 2 to 4 (#104): plan a route, map layers and tools, mission brief.
 * Steps are data on the #103 engine. Setups put the app in the right state and never do the
 * step's own action; each `doIt` uses store actions so it works without the Leaflet map.
 */
import type { Cell } from '../../contracts.ts';
import { DEFAULT_CONSTRAINTS, REPLAN_DELAY_MS, isWalkable, useAppStore } from '../../store.ts';
import type { LayerId } from '../../store.ts';
import type { TourApi, TourChapter, TourState, TourStep } from '../types.ts';

// ---------- helpers ----------

const SETTINGS = 'section[aria-label="EVA settings"]';
const ROUTE_PANEL = 'section[aria-label="Route stats"]';
const BRIEF = '[role="dialog"][aria-label="Mission brief"]';
const MAP = '.leaflet-container';
const LAYERS_PANEL = '[data-tour="layers"]';

const gridOf = (s: TourState) => (s.data.status === 'ready' ? s.data.grid : null);

/** Waits for a pending replan (the settings sliders debounce) and any best-order search to finish. */
async function settled(api: TourApi): Promise<void> {
  await api.sleep(REPLAN_DELAY_MS + 60);
  for (let i = 0; i < 60; i++) {
    const s = api.state();
    if (s.route.status !== 'planning' && !s.ordering) return;
    await api.sleep(50);
  }
}

const clearOfStops = (s: TourState, c: Cell) => s.stops.every((st) => Math.abs(st.cell.x - c.x) > 2 || Math.abs(st.cell.y - c.y) > 2);

/**
 * A walkable cell at least `minR` cells from `around`, searching outward ring by ring and skipping
 * cells next to an existing stop. Null only if the whole grid is blocked.
 */
function walkableNear(s: TourState, around: Cell, minR: number): Cell | null {
  const grid = gridOf(s);
  if (!grid) return null;
  const maxR = Math.max(grid.meta.width, grid.meta.height);
  for (let r = minR; r < maxR; r++) {
    for (let d = -r; d <= r; d++) {
      const ring: Cell[] = [
        { x: around.x + d, y: around.y - r },
        { x: around.x + d, y: around.y + r },
        { x: around.x - r, y: around.y + d },
        { x: around.x + r, y: around.y + d },
      ];
      const hit = ring.find((c) => isWalkable(grid, c) && clearOfStops(s, c));
      if (hit) return hit;
    }
  }
  return null;
}

const habitatOf = (s: TourState): Cell => gridOf(s)?.meta.habitat ?? { x: 0, y: 0 };
/** Somewhere easy to walk to from the habitat, so the new stop is reachable on the default oxygen supply. */
const nearHabitat = (s: TourState) => walkableNear(s, habitatOf(s), 12);

/** The stop the card steps work on: the one already open, else the newest. */
function focusStopId(s: TourState): string | null {
  return s.stops.find((st) => st.id === s.selectedStopId)?.id ?? s.stops.at(-1)?.id ?? null;
}

/** Opens the card of the stop the card steps work on. */
function ensureCard(api: TourApi): void {
  const id = focusStopId(api.state());
  if (id) api.state().selectStop(id);
}

/** Baselines taken in setup, so `done` means "this changed since the step began". */
const base = {
  stopCount: 0,
  cells: {} as Record<string, string>,
  names: {} as Record<string, string>,
  stars: {} as Record<string, number>,
  goals: {} as Record<string, string>,
  oxygenMin: DEFAULT_CONSTRAINTS.oxygenMin,
  zones: 0,
};
const cellKey = (c: Cell) => `${c.x},${c.y}`;
const snapshot = (s: TourState) => {
  base.cells = Object.fromEntries(s.stops.map((st) => [st.id, cellKey(st.cell)]));
  base.names = Object.fromEntries(s.stops.map((st) => [st.id, st.name]));
  base.stars = Object.fromEntries(s.stops.map((st) => [st.id, st.scienceValue]));
  base.goals = Object.fromEntries(s.stops.map((st) => [st.id, st.goal]));
};

/** Restores the default settings; used by steps that read the sliders or the route stats. */
async function defaultSettings(api: TourApi): Promise<void> {
  const c = api.state().constraints;
  if (c.oxygenMin === DEFAULT_CONSTRAINTS.oxygenMin && c.reservePct === DEFAULT_CONSTRAINTS.reservePct && c.maxSlopeDeg === DEFAULT_CONSTRAINTS.maxSlopeDeg) return;
  api.state().setConstraints(DEFAULT_CONSTRAINTS);
  await settled(api);
}

/** Reorders the stops so the walk is probably not the shortest (near, far, 2nd near, 2nd far, ...). */
function scrambleStops(api: TourApi): void {
  const s = api.state();
  const h = habitatOf(s);
  const dist = (c: Cell) => Math.hypot(c.x - h.x, c.y - h.y);
  const sorted = [...s.stops].sort((a, b) => dist(a.cell) - dist(b.cell));
  const mixed: typeof sorted = [];
  while (sorted.length) {
    mixed.push(sorted.shift()!);
    if (sorted.length) mixed.push(sorted.pop()!);
  }
  // Rotate by one so it doesn't start at the nearest stop, which is where the best order usually starts.
  mixed.push(mixed.shift()!);
  // The store has no "reorder" action, so write the list the way bestOrder does, then reroute.
  useAppStore.setState({ stops: mixed, orderUndo: null });
  void useAppStore.getState().planRoute();
}

const toggleOnly = (api: TourApi, id: LayerId, want: boolean) => {
  if (api.state().layers[id] !== want) api.state().toggleLayer(id);
};

/** Every layer off and normal colour vision, so the map is clean for the next step. */
function layersOff(api: TourApi): void {
  for (const id of ['difficulty', 'sand', 'geology', 'crism', 'ring'] as LayerId[]) toggleOnly(api, id, false);
  api.state().setColorVision('normal');
}

/** Three spread-out walkable corners near the habitat, clear of the stops. */
function zoneCorners(s: TourState): Cell[] | null {
  const a = walkableNear(s, habitatOf(s), 6);
  if (!a) return null;
  const grid = gridOf(s);
  const spread = (from: Cell, dx: number, dy: number): Cell | null => {
    for (let k = 5; k >= 1; k--) {
      const c = { x: from.x + dx * k, y: from.y + dy * k };
      if (grid && isWalkable(grid, c)) return c;
    }
    return null;
  };
  const b = spread(a, 1, 0);
  const c = spread(a, 0, 1);
  if (b && c) return [a, b, c];
  return routeBlockCorners(s);
}

const step = (s: TourStep): TourStep => s;

// ---------- Chapter 2: Plan a route ----------

const planRoute: TourChapter = {
  id: 'plan-route',
  title: 'Plan a route',
  summary: 'Add and edit stops, set your oxygen limits, and let Marcia order the stops.',
  steps: [
    step({
      id: 'plan-route-habitat',
      title: 'The habitat and your stops',
      body: 'The habitat is where every walk starts and ends. The numbered pins are the stops, visited in order. The route is a walking-time estimate over the real terrain, so it goes around steep ground rather than straight through it.',
      target: MAP,
      placement: 'right',
    }),
    step({
      id: 'plan-route-add-stop',
      title: 'Add a stop',
      body: 'In Plan mode a click on open ground adds a stop to the end of the route. A stop you add gets its rock unit and minerals from the map layers at that spot, so at Jezero they fill in for you.',
      target: MAP,
      placement: 'right',
      setup: (api) => {
        const s = api.state();
        s.setInspecting(false);
        s.cancelZone();
        base.stopCount = s.stops.length;
      },
      action: {
        prompt: 'Click open ground on the map to add a stop.',
        done: (s) => s.stops.length > base.stopCount,
        doIt: async (api) => {
          const cell = nearHabitat(api.state());
          if (cell) api.state().addStop(cell);
          await settled(api);
        },
      },
    }),
    step({
      id: 'plan-route-drag-pin',
      title: 'Drag a pin',
      body: 'In Plan mode pins can be dragged to a new spot, and the route is replanned to follow. A stop you added gets its rock unit and minerals re-read from the map at the new spot.',
      target: '.leaflet-marker-draggable',
      placement: 'right',
      setup: (api) => snapshot(api.state()),
      action: {
        prompt: 'Drag a pin to a new spot.',
        done: (s) => s.stops.some((st) => base.cells[st.id] !== undefined && base.cells[st.id] !== cellKey(st.cell)),
        doIt: async (api) => {
          const s = api.state();
          const stop = s.stops.at(-1);
          if (!stop) return;
          const cell = walkableNear(s, stop.cell, 8);
          if (cell) api.state().moveStop(stop.id, cell);
          await settled(api);
        },
      },
    }),
    step({
      id: 'plan-route-open-card',
      title: 'Open a stop card',
      body: 'Selecting a pin opens its stop card: the name, science value, goal, rock unit and minerals for that stop.',
      target: '.leaflet-marker-draggable',
      placement: 'right',
      setup: (api) => api.state().selectStop(null),
      action: {
        prompt: 'Click a pin to open its stop card.',
        done: (s) => s.selectedStopId !== null,
        doIt: async (api) => {
          const id = focusStopId(api.state());
          if (id) api.state().selectStop(id);
        },
      },
    }),
    step({
      id: 'plan-route-rename',
      title: 'Rename the stop',
      body: 'In Plan mode the stop card lets you rename the stop. Names are up to 40 characters, and renaming does not change the route.',
      target: 'article[aria-label^="Stop "]',
      placement: 'left',
      setup: (api) => {
        ensureCard(api);
        snapshot(api.state());
      },
      action: {
        prompt: 'Press Rename stop, type a new name and press Enter.',
        done: (s) => s.stops.some((st) => base.names[st.id] !== undefined && base.names[st.id] !== st.name),
        doIt: async (api) => {
          const id = focusStopId(api.state());
          if (id) api.state().renameStop(id, 'Crater rim sample');
        },
      },
    }),
    step({
      id: 'plan-route-stars',
      title: 'Set the science value',
      body: 'Stars (1 to 3) say how much the crew wants this stop. They do not change the walk itself. When the route is replanned mid-walk and not everything fits, the lowest-valued stops are dropped first.',
      target: '[role="radiogroup"][aria-label="Science value"]',
      placement: 'left',
      setup: (api) => {
        ensureCard(api);
        snapshot(api.state());
      },
      action: {
        prompt: 'Pick a different number of stars.',
        done: (s) => s.stops.some((st) => base.stars[st.id] !== undefined && base.stars[st.id] !== st.scienceValue),
        doIt: async (api) => {
          const id = focusStopId(api.state());
          const cur = api.state().stops.find((st) => st.id === id)?.scienceValue;
          if (id) api.state().editStop(id, { scienceValue: cur === 3 ? 1 : 3 });
        },
      },
    }),
    step({
      id: 'plan-route-goal',
      title: 'Edit the goal',
      body: 'The goal is a short note on what the crew wants to do at the stop. It shows on the stop card and in the mission brief.',
      target: 'article[aria-label^="Stop "]',
      placement: 'left',
      setup: (api) => {
        ensureCard(api);
        snapshot(api.state());
      },
      action: {
        prompt: 'Press Edit goal, change the text and save it.',
        done: (s) => s.stops.some((st) => base.goals[st.id] !== undefined && base.goals[st.id] !== st.goal),
        doIt: async (api) => {
          const id = focusStopId(api.state());
          if (id) api.state().editStop(id, { goal: 'Collect a rock sample and photograph the layering.' });
        },
      },
    }),
    step({
      id: 'plan-route-oxygen',
      title: 'Set your oxygen supply',
      body: 'Oxygen supply is how many minutes of air the suit carries. Move the slider and the route is checked against it straight away.',
      target: SETTINGS,
      placement: 'right',
      setup: async (api) => {
        await api.ensureExpanded(`${SETTINGS} button[aria-expanded]`);
        await defaultSettings(api);
        base.oxygenMin = api.state().constraints.oxygenMin;
      },
      action: {
        prompt: 'Move the Oxygen supply slider.',
        done: (s) => s.constraints.oxygenMin !== base.oxygenMin,
        doIt: async (api) => {
          api.state().setConstraints({ oxygenMin: base.oxygenMin - 120 });
          await settled(api);
        },
      },
    }),
    step({
      id: 'plan-route-limits',
      title: 'Reserve, slope and usable oxygen',
      body: 'Reserve on return keeps a share of the air in hand for the walk home, and Max slope is the steepest ground you will cross. The usable oxygen readout is the supply minus that reserve. Reset puts all three back to the defaults.',
      target: SETTINGS,
      placement: 'right',
      setup: async (api) => {
        await api.ensureExpanded(`${SETTINGS} button[aria-expanded]`);
        await defaultSettings(api);
      },
    }),
    step({
      id: 'plan-route-out-of-range',
      title: 'Out of range',
      body: 'We cut the oxygen supply to a short one. A stop is listed as "Out of range" when the walk there and back would not fit in the usable oxygen. Marcia skips it and plans the rest, so the route is always one you could finish.',
      target: ROUTE_PANEL,
      placement: 'left',
      setup: async (api) => {
        await api.ensureExpanded(`${ROUTE_PANEL} button[aria-expanded]`);
        await defaultSettings(api);
        // Half the oxygen this route needs: the farthest stops can't be reached and returned from.
        const r = api.state().route;
        const used = r.status === 'ready' ? r.result.oxygenUsedMin : 60;
        const usableShare = 1 - api.state().constraints.reservePct / 100;
        const oxygenMin = Math.max(60, Math.floor((used * 0.5) / usableShare / 15) * 15);
        api.state().setConstraints({ oxygenMin, ...(oxygenMin === 60 ? { reservePct: 50 } : {}) });
        await settled(api);
      },
    }),
    step({
      id: 'plan-route-best-order',
      title: 'Find the best order',
      body: 'Find best order rearranges your stops into the shortest walk from the habitat and back. It needs at least 3 stops. We mixed up the order so you can see it work. The walk is still an estimate, but the order it picks is the shorter one by the same cost.',
      target: `${ROUTE_PANEL} button[aria-expanded]`,
      placement: 'left',
      setup: async (api) => {
        await defaultSettings(api);
        await api.ensureExpanded(`${ROUTE_PANEL} button[aria-expanded]`);
        scrambleStops(api);
        await settled(api);
      },
      action: {
        prompt: 'Press Find best order.',
        done: (s) => s.orderUndo !== null,
        doIt: async (api) => {
          await settled(api);
          await api.state().bestOrder();
          await settled(api);
        },
      },
    }),
    step({
      id: 'plan-route-undo',
      title: 'Undo the reorder',
      body: 'Undo puts your own order back. It is there only while the stops are as the reorder left them; once you edit the stops it goes away.',
      target: ROUTE_PANEL,
      placement: 'left',
      setup: async (api) => {
        await api.ensureExpanded(`${ROUTE_PANEL} button[aria-expanded]`);
        if (!api.state().orderUndo) {
          scrambleStops(api);
          await settled(api);
          await api.state().bestOrder();
          await settled(api);
        }
      },
      action: {
        prompt: 'Press Undo.',
        done: (s) => s.orderUndo === null,
        doIt: async (api) => {
          await settled(api);
          api.state().undoOrder();
          await settled(api);
        },
      },
    }),
    step({
      id: 'plan-route-stats',
      title: 'Route stats and the oxygen meter',
      body: 'The panel shows distance, walking time, energy and oxygen used against what is usable. All of these are estimates from a walking-speed and cost model, not measurements. The meter turns amber past 80% and red when the route needs more oxygen than you have.',
      target: '[data-tour="route-stats"]',
      placement: 'left',
      setup: async (api) => {
        await defaultSettings(api);
        await api.ensureExpanded(`${ROUTE_PANEL} button[aria-expanded]`);
      },
    }),
    step({
      id: 'plan-route-profile',
      title: 'Elevation profile',
      body: 'Under the stats, the elevation profile shows how high and low the route goes along the way, with the stops marked. Use it to spot the climbs before you commit to them.',
      target: '[data-tour="elevation-profile"]',
      placement: 'left',
      setup: (api) => api.ensureExpanded(`${ROUTE_PANEL} button[aria-expanded]`),
    }),
  ],
};

// ---------- Chapter 3: Map layers and tools ----------

/** A layer step: the user ticks the layer, Show me toggles it. */
function layerStep(id: LayerId, title: string, body: string, prompt: string): TourStep {
  return {
    id: `map-layers-${id}`,
    title,
    body,
    target: LAYERS_PANEL,
    placement: 'right',
    setup: (api) => toggleOnly(api, id, false),
    action: {
      prompt,
      done: (s) => s.layers[id],
      doIt: async (api) => toggleOnly(api, id, true),
    },
  };
}

/** A cell on the route to put an avoid zone across, away from the stops; null if there is no route. */
function routeBlockCorners(s: TourState): Cell[] | null {
  if (s.route.status !== 'ready') return null;
  const path = s.route.result.path;
  for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) {
    const p = path[Math.floor(path.length * f)];
    if (!p) continue;
    if (s.stops.some((st) => Math.hypot(st.cell.x - p.x, st.cell.y - p.y) < 8)) continue;
    return [
      { x: p.x - 3, y: p.y + 3 },
      { x: p.x + 3, y: p.y + 3 },
      { x: p.x, y: p.y - 4 },
    ];
  }
  return null;
}

const mapLayers: TourChapter = {
  id: 'map-layers',
  title: 'Map layers and tools',
  summary: 'Layers, the turn-back ring, colour-blind palettes, avoid zones and Inspect.',
  steps: [
    layerStep(
      'difficulty',
      'Walking difficulty',
      'Walking difficulty shades the map by how costly each patch is to cross, from easy to hard, using slope. The route planner uses the same cost, so the route tends to follow the easy colours.',
      'Tick Walking difficulty.',
    ),
    layerStep(
      'sand',
      'Soft sand',
      'Soft sand is stippled where mapped dunes and ripples probably make for loose ground. The planner treats walking on it as harder (we assume about twice the effort of rock), so it avoids it where it can. That factor is an estimate.',
      'Tick Soft sand.',
    ),
    layerStep(
      'geology',
      'Geology',
      'Geology colours the map by mapped rock unit. This is the layer a stop you add reads its rock unit from.',
      'Tick Geology.',
    ),
    {
      id: 'map-layers-geology-legend',
      title: 'Open the geology legend',
      body: 'The legend lists each rock unit and colour on the map, with where the data comes from.',
      target: '[aria-controls="geology-legend"]',
      placement: 'right',
      setup: async (api) => {
        toggleOnly(api, 'geology', true);
        await api.waitFor('[aria-controls="geology-legend"]');
      },
      action: {
        prompt: 'Press Geology legend.',
        done: (_s, doc) => doc.querySelector('[aria-controls="geology-legend"]')?.getAttribute('aria-expanded') === 'true',
        doIt: (api) => api.ensureExpanded('[aria-controls="geology-legend"]'),
      },
    },
    layerStep(
      'crism',
      'CRISM minerals',
      'CRISM minerals shows where orbital spectra suggest minerals such as clays and carbonates. A stop you add reads its minerals from here. The legend works like the geology one.',
      'Tick CRISM minerals.',
    ),
    layerStep(
      'ring',
      'Turn-back ring',
      'The turn-back ring is the area from which you could still walk home on the oxygen you have left after your reserve. Inside the ring you can get back; outside it you could not. It follows the oxygen and slope settings.',
      'Tick Turn-back ring.',
    ),
    {
      id: 'map-layers-route-key',
      title: 'The route key',
      body: 'Once a route is planned, this key in the Layers panel tells the two line styles apart: a solid line is the way out and a dotted line is the way home.',
      target: '[role="group"][aria-label="Route key"]',
      placement: 'right',
    },
    {
      id: 'map-layers-colour-vision',
      title: 'Colour vision',
      body: 'Colour vision swaps the geology and CRISM colours for palettes that stay readable with common colour-blindness. The choices simulate protanopia, deuteranopia and tritanopia.',
      target: LAYERS_PANEL,
      placement: 'right',
      setup: (api) => {
        api.state().setColorVision('normal');
        if (!api.state().layers.geology && !api.state().layers.crism) api.state().toggleLayer('geology');
      },
      action: {
        prompt: 'Pick a colour vision other than Normal.',
        done: (s) => s.colorVision !== 'normal',
        doIt: async (api) => api.state().setColorVision('deuteranopia'),
      },
    },
    {
      id: 'map-layers-avoid-zone',
      title: 'Draw an avoid zone',
      body: 'An avoid zone is an area the route must not cross, such as ground you know is unsafe. Press Draw zone, click three or more corners on the map, then press Finish. The route replans around it.',
      target: MAP,
      targets: ['[role="group"][aria-label="Avoid zones"]'],
      placement: 'left',
      setup: (api) => {
        layersOff(api);
        api.state().cancelZone();
        api.state().setInspecting(false);
        base.zones = api.state().avoidZones.length;
      },
      action: {
        prompt: 'Press Draw zone, click 3 spots on the map, then press Finish.',
        done: (s) => s.avoidZones.length > base.zones,
        doIt: async (api) => {
          const corners = zoneCorners(api.state());
          if (!corners) return;
          api.state().cancelZone();
          api.state().startZone();
          for (const c of corners) {
            api.state().addZonePoint(c);
            await api.sleep(150);
          }
          if (!api.state().finishZone()) console.warn('Tutorial: finishZone refused the zone');
          await settled(api);
        },
      },
    },
    {
      id: 'map-layers-route-bends',
      title: 'Watch the route bend',
      body: 'The zone is drawn dashed on the map and the route is replanned around it, so the line can bend and the distance and time can go up. Clear removes your zones and the route goes back.',
      target: MAP,
      placement: 'right',
    },
    {
      id: 'map-layers-inspect',
      title: 'Inspect a spot',
      body: 'Inspect lets you click anywhere to read about that spot without adding a stop. Press Inspect to turn it on, then click the map.',
      target: '[data-tour="inspect"]',
      targets: [MAP],
      placement: 'right',
      setup: (api) => {
        layersOff(api);
        api.state().cancelZone();
        api.state().setInspecting(false);
      },
      action: {
        prompt: 'Press Inspect, then click a spot on the map.',
        done: (s) => s.inspecting && s.inspectCell !== null,
        doIt: async (api) => {
          const cell = nearHabitat(api.state());
          api.state().setInspecting(true);
          if (cell) api.state().mapClick(cell);
        },
      },
    },
    {
      id: 'map-layers-spot-details',
      title: 'Spot details',
      body: 'The popup gives the spot’s elevation and slope from the terrain data, its rock unit from the geology map, and its CRISM mineral class, each with its source. Close it and click elsewhere, or press Inspect again to go back to adding stops.',
      target: '[role="dialog"][aria-label="Spot details"]',
      placement: 'right',
      setup: async (api) => {
        if (!api.state().inspectCell) {
          const cell = nearHabitat(api.state());
          api.state().setInspecting(true);
          if (cell) api.state().mapClick(cell);
        }
        await api.waitFor('[role="dialog"][aria-label="Spot details"]');
      },
    },
  ],
};

// ---------- Chapter 4: Mission brief ----------

const ensureBrief = async (api: TourApi) => {
  api.state().setInspecting(false);
  if (!api.state().briefOpen) api.state().setBriefOpen(true);
  await api.waitFor(BRIEF);
};

const missionBrief: TourChapter = {
  id: 'mission-brief',
  title: 'Mission brief',
  summary: 'One-page brief: legs, totals, alerts, space weather, data sources, share link.',
  steps: [
    {
      id: 'mission-brief-open',
      title: 'Open the mission brief',
      body: 'The mission brief is a one-page summary of your plan. It is available once a route is planned.',
      target: '[data-tour="brief"]',
      placement: 'bottom',
      setup: async (api) => {
        api.state().setInspecting(false);
        api.state().setBriefOpen(false);
        await settled(api);
      },
      action: {
        prompt: 'Press Mission brief.',
        done: (s) => s.briefOpen,
        doIt: async (api) => api.state().setBriefOpen(true),
      },
    },
    {
      id: 'mission-brief-legs',
      title: 'Legs and totals',
      body: 'Each leg is one stretch of the route (habitat to stop, stop to stop, and home) with its distance and time. Totals add up distance, walking time, energy and oxygen. All are estimates from the planner’s model.',
      target: `${BRIEF} article`,
      placement: 'right',
      setup: ensureBrief,
    },
    {
      id: 'mission-brief-alerts',
      title: 'Alerts expected along the route',
      body: 'This section lists the warnings you would get when walking this route, such as steep slopes or low oxygen, worked out from the plan ahead of time. Walk mode raises the live ones.',
      target: `${BRIEF} article`,
      placement: 'right',
      setup: ensureBrief,
    },
    {
      id: 'mission-brief-weather',
      title: 'Space weather at plan time',
      body: 'This records what space-weather data (NASA DONKI) said when the brief was made, and whether it was quiet, tightened or blocked. The readings come from near Earth and stand in for Mars, so treat them as a rough guide.',
      target: `${BRIEF} article`,
      placement: 'right',
      setup: ensureBrief,
    },
    {
      id: 'mission-brief-datasets',
      title: 'Datasets and what is estimated',
      body: 'Datasets used lists the data behind the plan and where it came from. What’s estimated lists the numbers that are Marcia’s own estimates, such as walking speed, oxygen use and cost weights. They are not measurements or NASA guidance.',
      target: `${BRIEF} article`,
      placement: 'right',
      setup: ensureBrief,
    },
    {
      id: 'mission-brief-copy-link',
      title: 'Copy a share link',
      body: 'Copy link puts a link to this plan on your clipboard. It carries the site, stops, settings and the space-weather snapshot, so whoever opens it sees the same plan. There is no server: the plan lives in the link itself.',
      target: '[data-tour="copy-link"]',
      placement: 'bottom',
      setup: ensureBrief,
      action: {
        prompt: 'Press Copy link.',
        done: (_s, doc) => (doc.querySelector(`${BRIEF} .brief-toolbar [role="status"]`)?.textContent ?? '').includes('Link copied'),
        doIt: async (api) => {
          await api.click('[data-tour="copy-link"]');
        },
      },
    },
    {
      id: 'mission-brief-pdf',
      title: 'Download PDF',
      body: 'Download PDF opens your browser’s print dialog; choose Save as PDF there. The brief is laid out in black on white so it prints cleanly. We will not open it now.',
      target: '[data-tour="download-pdf"]',
      placement: 'bottom',
      setup: ensureBrief,
    },
  ],
};

export const PLAN_CHAPTERS: TourChapter[] = [planRoute, mapLayers, missionBrief];
