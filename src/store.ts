import { create } from 'zustand';
import { START_ID } from './contracts.ts';
import type { Alert, Cell, Constraints, RingResult, RouteResult, ScienceValue, Stop } from './contracts.ts';
import { browserStorage, checkDonki } from './data/donki.ts';
import type { DonkiCheck } from './data/donki.ts';
import { loadGrid } from './data/grid.ts';
import { DEFAULT_SITE_ID, FALLBACK_SITES, SITES_FILE, parseSites, siteDataUrl, siteHasLayer } from './data/sites.ts';
import type { SiteInfo } from './data/sites.ts';
import type { GridData } from './data/grid.ts';
import { checkAlerts } from './engine/alerts.ts';
import { createWorkerEngine } from './engine/client.ts';
import type { EngineClient } from './engine/client.ts';
import { usableOxygenMin } from './engine/model.ts';
import { assessSpaceWeather, effectiveConstraints, eventIds, hasNoData, noDataText, ringOxygenFor, spaceWeatherAlert, spaceWeatherHeadline } from './engine/spaceWeather.ts';
import type { SharedPlan, SpaceWeatherSnapshot } from './brief/share.ts';
import type { DonkiBundle, SpaceWeather } from './engine/spaceWeather.ts';
import stormDemo from '../fixtures/donki/storm.json';
import { clampConstraints } from './plan/constraints.ts';
import { MIN_ZONE_POINTS } from './engine/avoid.ts';
import type { AvoidZone } from './engine/avoid.ts';
import type { Vision } from './map/colorblind.ts';
import { UNKNOWN_UNIT, scienceAt } from './map/inspect.ts';
import type { StopScience } from './map/inspect.ts';
import { positionAt } from './walk/hud.ts';
import type { WalkState } from './walk/hud.ts';
import { IDLE_REPLAY, RING_STEP_MIN, advance, walkAt } from './walk/replay.ts';
import type { Replay } from './walk/replay.ts';

export type Mode = 'plan' | 'walk';

/** Map projection: Leaflet 2D (editable) or Cesium 3D (view-only, M33). */
export type MapKind = '2d' | '3d';

/** Data root (`public/data/`): `sites.json` plus one folder per site (M36). */
export const DATA_ROOT = `${import.meta.env?.BASE_URL ?? '/'}data`;
/** Where the default site's grid data comes from: the real Jezero files in `public/data/jezero/`. */
export const DATA_URL = siteDataUrl(DATA_ROOT, DEFAULT_SITE_ID);

/** Starting constraints; the crew edits them in the settings panel. */
export const DEFAULT_CONSTRAINTS: Constraints = { oxygenMin: 480, reservePct: 20, maxSlopeDeg: 25 };

export type DataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; grid: GridData }
  | { status: 'error'; message: string };

export type LayerId = 'difficulty' | 'sand' | 'geology' | 'crism' | 'ring';

/** What a Plan-mode map click did (#91). */
export type MapClickResult = 'zone' | 'inspect' | 'stop' | 'blocked';

/** Set once the crew has replanned mid-walk; `route` is then the replanned one. */
export interface Replanned {
  /** Stops dropped by this and any earlier replan, in planned order. */
  droppedIds: string[];
  /** Oxygen in the tank where the replanned route starts. */
  startOxygenMin: number;
  /** EVA minutes walked before the replanned route starts. */
  offsetMin: number;
  /** True when the last replan was "Head home now": no stops, straight to the habitat. */
  headedHome?: boolean;
}

/** Space-weather check (M35): the DONKI data and what the rules make of it. */
export interface SpaceWeatherState {
  /** Rules applied to the current check (or the demo storm); null until the first check lands. */
  assessment: SpaceWeather | null;
  /** True when the live fetch failed and this is the last good check. */
  stale: boolean;
  loading: boolean;
  /** Last fetch error, shown when there is no check at all or it's stale. */
  error: string | null;
  /** "Demo: replay a historical storm" is on. */
  demo: boolean;
}

/** Saved DONKI responses for a real past storm; judged at its own `fetchedAt`. */
export const STORM_DEMO = stormDemo as DonkiBundle;

export type RouteState =
  | { status: 'idle' }
  | { status: 'planning' }
  | { status: 'ready'; result: RouteResult }
  | { status: 'error'; message: string };

interface AppState {
  mode: Mode;
  setMode: (mode: Mode) => void;

  /** Leaflet (2D) or Cesium (3D). Stop edit only works in 2D. */
  mapKind: MapKind;
  setMapKind: (kind: MapKind) => void;

  /** EVA sites from `sites.json` (M36), and the one loaded. */
  sites: SiteInfo[];
  siteId: string;
  loadSites: () => Promise<void>;
  /** Switches site: reloads the grid (the worker gets `init`), clears stops and route, keeps the settings. */
  setSite: (id: string) => Promise<void>;

  data: DataState;
  loadData: (baseUrl?: string) => Promise<void>;

  /** Planned stops, in visiting order. Starts as `stops.json`. */
  stops: Stop[];
  /** Adds a stop at the end of the route. Returns false if the cell isn't walkable. */
  addStop: (cell: Cell) => boolean;
  /** Moves a stop. Returns false (and leaves it) if the cell isn't walkable. */
  moveStop: (id: string, cell: Cell) => boolean;
  removeStop: (id: string) => void;
  /** #98: renames a stop (trimmed, 1-40 chars). Returns false and keeps the old name if empty. Never reroutes. */
  renameStop: (id: string, name: string) => boolean;
  /** #98: edits a stop's goal (trimmed, up to 200 chars, may be empty) and/or science value (1-3). Never reroutes. */
  editStop: (id: string, patch: { goal?: string; scienceValue?: ScienceValue }) => boolean;
  /** #98: rock unit and minerals at a cell from the site's map layers, for crew-added stops; tests swap it out. */
  stopScience: (cell: Cell) => Promise<StopScience>;

  /** M32: crew-drawn avoid zones (polygons of grid cells); the router treats cells inside as blocked. */
  avoidZones: AvoidZone[];
  /** Corners of the zone being drawn, or null when not drawing. While drawing, map clicks add corners, not stops. */
  drawingZone: Cell[] | null;
  startZone: () => void;
  addZonePoint: (cell: Cell) => void;
  /** Closes the zone being drawn and reroutes. Returns false (and keeps drawing) with fewer than 3 corners. */
  finishZone: () => boolean;
  cancelZone: () => void;
  /** Removes every avoid zone and reroutes. */
  clearZones: () => void;

  /** #91: Inspect mode. While on, a Plan-mode map click opens the spot's details instead of adding a stop. */
  inspecting: boolean;
  /** Cell whose details are open, or null. */
  inspectCell: Cell | null;
  /** Turns Inspect on or off. On cancels zone drawing; off closes the details. */
  setInspecting: (on: boolean) => void;
  closeInspect: () => void;
  /** Routes a Plan-mode map click: a zone corner while drawing, the details while inspecting, else a new stop. */
  mapClick: (cell: Cell) => MapClickResult;

  /** Stop whose card is open, if any. */
  selectedStopId: string | null;
  selectStop: (id: string | null) => void;

  /** Short message shown over the map, cleared after a few seconds. */
  notice: string | null;
  showNotice: (message: string) => void;

  constraints: Constraints;
  /** Updates some constraints (clamped to valid ranges) and reroutes shortly after. */
  setConstraints: (patch: Partial<Constraints>) => void;
  route: RouteState;
  /** Asks the engine for a route from the habitat through the current stops. */
  planRoute: () => Promise<void>;
  /** #99: true while "Find best order" waits for the engine. */
  ordering: boolean;
  /** #99: the stops before and after the last "Find best order"; Undo is offered only while the stops still match `after`. */
  orderUndo: { before: Stop[]; after: Stop[] } | null;
  /** Reorders the stops into the shortest out-and-back walk, then reroutes. Plan mode, 3+ stops. */
  bestOrder: () => Promise<void>;
  /** Puts the stops back in the order before the last `bestOrder`, then reroutes. */
  undoOrder: () => void;

  /** Which map overlays are switched on. */
  layers: Record<LayerId, boolean>;
  /** M34: the crew's colour vision. Anything but normal swaps geology / CRISM to colour-blind-safe colours. */
  colorVision: Vision;
  setColorVision: (v: Vision) => void;
  toggleLayer: (id: LayerId) => void;
  /** Turn-back ring for the usable oxygen; fetched while the ring layer is on. */
  ring: RingResult | null;
  planRing: () => Promise<void>;

  /**
   * Progress along the route in Walk mode. Null until a walk starts; the HUD
   * then shows the crew at the habitat with a full supply. The replay (M25)
   * drives this.
   */
  walk: WalkState | null;
  setWalk: (walk: WalkState | null) => void;

  /** Simulated walk along the route (Walk mode). */
  replay: Replay;
  playWalk: () => void;
  pauseWalk: () => void;
  /** Back to the habitat with a full supply. */
  resetWalk: () => void;
  /** Jumps to a point in the walk, 0 (start) to 1 (home again). */
  seekWalk: (fraction: number) => void;
  setWalkSpeed: (speed: number) => void;
  /** Advances the replay by `dtRealSec` of real time; called once per frame. */
  tickWalk: (dtRealSec: number) => void;

  /** Walk-mode alerts for where the crew is now (`checkAlerts`), critical first. */
  alerts: Alert[];
  /** Non-null after a mid-walk replan. Planning again from the habitat clears it. */
  replanned: Replanned | null;
  /** True while a replan request is with the worker; the replay clock holds. */
  replanning: boolean;
  /**
   * Replans from the crew's position through the stops still ahead, with the
   * oxygen left. Swaps the new route in and records which stops were dropped.
   * With `headHome` it keeps no stops: straight to the habitat, every stop ahead dropped.
   */
  replanWalk: (headHome?: boolean) => Promise<void>;
  /** "Head home now": `replanWalk(true)`. */
  headHome: () => Promise<void>;

  spaceWeather: SpaceWeatherState;
  /** Checks DONKI (cached for 15 min unless `force`) and reroutes if the status changed. */
  checkSpaceWeather: (force?: boolean) => Promise<void>;
  /** Switches the historical-storm demo on or off. */
  setSpaceWeatherDemo: (on: boolean) => void;

  /** Engine factory; tests swap in a fake worker. */
  makeEngine: () => EngineClient;
  /** DONKI fetch and clock; tests swap them out. */
  fetchDonki: (url: string) => Promise<Response>;
  now: () => Date;

  /** Mission brief (M37) is open. */
  briefOpen: boolean;
  setBriefOpen: (open: boolean) => void;
  /** Space weather recorded in a shared link; the brief shows it instead of the live check. */
  sharedSpaceWeather: SpaceWeatherSnapshot | null;
  /** Restores a plan from a share link: site, stops, constraints; reruns the route and opens the brief. */
  restoreShared: (plan: SharedPlan) => Promise<void>;
}

let engine: EngineClient | null = null;
let engineGrid: GridData | null = null;
let planSeq = 0;
let ringSeq = 0;
/** Oxygen value the last ring was requested for, and whether one is in flight. */
let ringOxygen: number | null = null;
let ringBusy = false;
let replanSeq = 0;
let orderSeq = 0;
let liveCheck: DonkiCheck | null = null;

/** Same stops in the same order, ignoring everything but id, cell and name (#99). */
export function sameStops(a: Stop[], b: Stop[]): boolean {
  return a.length === b.length && a.every((s, i) => s.id === b[i]!.id && s.name === b[i]!.name && s.cell.x === b[i]!.cell.x && s.cell.y === b[i]!.cell.y);
}

/** Returns the engine, initialised with `grid` (once per grid). */
function engineFor(grid: GridData, make: () => EngineClient): EngineClient {
  if (!engine) engine = make();
  if (engineGrid !== grid) {
    engine.init(grid.meta, grid.cost, grid.elevation);
    engineGrid = grid;
    // A fresh engine has no avoid zones; resend the crew's (M32).
    const zones = useAppStore.getState().avoidZones;
    if (zones.length) engine.avoid(zones);
  }
  return engine;
}
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let replanTimer: ReturnType<typeof setTimeout> | undefined;

/** Wait after the last settings change before rerouting, so dragging a slider sends one request. */
export const REPLAN_DELAY_MS = 200;

/** True if `cell` is inside the grid and not blocked in `cost.bin`. */
export function isWalkable(grid: GridData, cell: Cell): boolean {
  const { width, height } = grid.meta;
  if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y)) return false;
  if (cell.x < 0 || cell.y < 0 || cell.x >= width || cell.y >= height) return false;
  return Number.isFinite(grid.cost[cell.y * width + cell.x]!);
}

/** Longest stop name the crew can type (#98). */
export const MAX_STOP_NAME = 40;
/** Longest stop goal the crew can type (#98). */
export const MAX_STOP_GOAL = 200;

/** True for a stop the crew added (not one of the site's preset stops). */
export function isCrewStop(grid: Pick<GridData, 'stops'>, id: string): boolean {
  return !grid.stops.some((s) => s.id === id);
}

/** A crew-added stop; its rock unit and minerals are filled from the map layers (#98), the rest by the crew. */
function customStop(cell: Cell, existing: Stop[]): Stop {
  let n = 1;
  while (existing.some((s) => s.id === `custom-${n}`)) n++;
  return {
    id: `custom-${n}`,
    name: `Custom stop ${n}`,
    cell,
    goal: '',
    geologyUnit: 'Unknown',
    minerals: [],
    photo: '',
    scienceValue: 1,
  };
}

/** App-wide UI state. Plan/Walk features add their slices here. */
export const useAppStore = create<AppState>()((set, get) => ({
  mode: 'plan',
  setMode: (mode) => {
    if (mode === get().mode) return;
    // Leaving Walk pauses the replay; it resumes from the same spot.
    const replay = get().replay;
    set({ mode, replay: replay.status === 'playing' ? { ...replay, status: 'paused' } : replay });
    // Plan mode always shows the plan from the habitat, so a replanned walk ends here.
    if (mode === 'plan' && get().replanned) {
      void get().planRoute();
      return;
    }
    refreshAlerts();
    // The ring means "now" in Walk and "as planned" in Plan.
    if (mode === 'walk' || get().layers.ring) void get().planRing();
  },

  mapKind: '2d',
  setMapKind: (mapKind) => {
    if (mapKind !== get().mapKind) set({ mapKind });
  },

  sites: FALLBACK_SITES,
  siteId: DEFAULT_SITE_ID,
  loadSites: async () => {
    try {
      const res = await fetch(`${DATA_ROOT}/${SITES_FILE}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set({ sites: parseSites(await res.json()) });
    } catch (err) {
      console.warn(`sites.json: ${errorMessage(err)}; only the default site is listed`);
    }
  },
  setSite: async (id) => {
    if (id === get().siteId || get().data.status === 'loading' || !get().sites.some((s) => s.id === id)) return;
    // New grid: drop everything tied to the old one. Settings (constraints, layers, space weather) stay.
    planSeq++;
    ringSeq++;
    replanSeq++;
    set({
      siteId: id,
      stops: [],
      avoidZones: [],
      drawingZone: null,
      selectedStopId: null,
      route: { status: 'idle' },
      ring: null,
      walk: null,
      replay: { ...IDLE_REPLAY, speed: get().replay.speed },
      replanned: null,
      replanning: false,
      alerts: [],
    });
    await get().loadData(siteDataUrl(DATA_ROOT, id));
  },

  data: { status: 'idle' },
  loadData: async (baseUrl = DATA_URL) => {
    if (get().data.status === 'loading') return;
    set({ data: { status: 'loading' } });
    try {
      const grid = await loadGrid(baseUrl);
      set({
        data: { status: 'ready', grid },
        stops: grid.stops,
        selectedStopId: null,
        inspectCell: null,
        constraints: clampConstraints(get().constraints, grid.meta.maxSlopeDeg),
      });
    } catch (err) {
      set({ data: { status: 'error', message: errorMessage(err) } });
      return;
    }
    await get().planRoute();
  },

  stops: [],
  addStop: (cell) => {
    const data = get().data;
    if (data.status !== 'ready' || !isWalkable(data.grid, cell)) return false;
    const stop = customStop(cell, get().stops);
    set({ stops: [...get().stops, stop] });
    fillScience(stop.id);
    void get().planRoute();
    return true;
  },
  moveStop: (id, cell) => {
    const data = get().data;
    if (data.status !== 'ready' || !isWalkable(data.grid, cell)) return false;
    // #98: a crew stop's rock unit and minerals are read from the map, so they follow it; preset stops keep theirs.
    const crew = isCrewStop(data.grid, id);
    set({ stops: get().stops.map((s) => (s.id === id ? { ...s, cell, ...(crew ? { geologyUnit: UNKNOWN_UNIT, minerals: [] } : {}) } : s)) });
    if (crew) fillScience(id);
    void get().planRoute();
    return true;
  },
  removeStop: (id) => {
    set({
      stops: get().stops.filter((s) => s.id !== id),
      selectedStopId: get().selectedStopId === id ? null : get().selectedStopId,
    });
    void get().planRoute();
  },
  renameStop: (id, name) => {
    const next = name.trim().slice(0, MAX_STOP_NAME).trim();
    if (!next || !get().stops.some((s) => s.id === id)) return false;
    set({ stops: get().stops.map((s) => (s.id === id ? { ...s, name: next } : s)) });
    return true;
  },
  editStop: (id, patch) => {
    if (!get().stops.some((s) => s.id === id)) return false;
    const goal = patch.goal === undefined ? undefined : patch.goal.trim().slice(0, MAX_STOP_GOAL).trim();
    const value = patch.scienceValue;
    if (value !== undefined && value !== 1 && value !== 2 && value !== 3) return false;
    set({
      stops: get().stops.map((s) =>
        s.id === id ? { ...s, ...(goal !== undefined ? { goal } : {}), ...(value !== undefined ? { scienceValue: value } : {}) } : s,
      ),
    });
    return true;
  },
  stopScience: (cell) => {
    const s = get();
    if (s.data.status !== 'ready') return Promise.resolve({ geologyUnit: UNKNOWN_UNIT, minerals: [] });
    return scienceAt(siteDataUrl(DATA_ROOT, s.siteId), s.sites.find((x) => x.id === s.siteId), s.data.grid.meta, cell);
  },

  avoidZones: [],
  drawingZone: null,
  inspecting: false,
  inspectCell: null,
  setInspecting: (on) => set(on ? { inspecting: true, drawingZone: null } : { inspecting: false, inspectCell: null }),
  closeInspect: () => set({ inspectCell: null }),
  mapClick: (cell) => {
    if (get().drawingZone) {
      get().addZonePoint(cell);
      return 'zone';
    }
    if (get().inspecting) {
      set({ inspectCell: cell });
      return 'inspect';
    }
    return get().addStop(cell) ? 'stop' : 'blocked';
  },
  startZone: () => set({ drawingZone: [], selectedStopId: null, inspecting: false, inspectCell: null }),
  addZonePoint: (cell) => {
    const drawing = get().drawingZone;
    if (drawing) set({ drawingZone: [...drawing, cell] });
  },
  finishZone: () => {
    const drawing = get().drawingZone;
    if (!drawing || drawing.length < MIN_ZONE_POINTS) return false;
    set({ avoidZones: [...get().avoidZones, drawing], drawingZone: null });
    syncAvoid(get());
    return true;
  },
  cancelZone: () => set({ drawingZone: null }),
  clearZones: () => {
    if (!get().avoidZones.length && !get().drawingZone) return;
    set({ avoidZones: [], drawingZone: null });
    syncAvoid(get());
  },

  selectedStopId: null,
  selectStop: (id) => set({ selectedStopId: id && get().stops.some((s) => s.id === id) ? id : null }),

  notice: null,
  showNotice: (message) => {
    clearTimeout(noticeTimer);
    set({ notice: message });
    noticeTimer = setTimeout(() => set({ notice: null }), 3000);
  },

  constraints: DEFAULT_CONSTRAINTS,
  setConstraints: (patch) => {
    const data = get().data;
    const gridMax = data.status === 'ready' ? data.grid.meta.maxSlopeDeg : DEFAULT_CONSTRAINTS.maxSlopeDeg;
    set({ constraints: clampConstraints({ ...get().constraints, ...patch }, gridMax) });
    clearTimeout(replanTimer);
    replanTimer = setTimeout(() => void get().planRoute(), REPLAN_DELAY_MS);
  },
  route: { status: 'idle' },
  planRoute: async () => {
    const data = get().data;
    if (data.status !== 'ready') return;
    const { grid } = data;
    const seq = ++planSeq;
    set({ route: { status: 'planning' } });
    try {
      const result = await engineFor(grid, get().makeEngine).route({ start: grid.meta.habitat, stops: get().stops, constraints: planConstraints(get()) });
      // A new route starts a new walk: the old position indexed the old path.
      if (seq === planSeq) {
        replanSeq++; // a replan still in flight is for the old route
        set({ route: { status: 'ready', result }, walk: null, replay: { ...IDLE_REPLAY, speed: get().replay.speed }, replanned: null, replanning: false });
        refreshAlerts();
      }
    } catch (err) {
      if (seq === planSeq) set({ route: { status: 'error', message: errorMessage(err) } });
    }
    // Constraints changes reroute through here, so the ring follows them too.
    if (get().layers.ring || get().mode === 'walk') await get().planRing();
  },

  ordering: false,
  orderUndo: null,
  bestOrder: async () => {
    const s = get();
    if (s.data.status !== 'ready' || s.mode !== 'plan' || s.route.status === 'planning' || s.drawingZone || s.ordering || s.stops.length < 3) return;
    const before = s.stops;
    const seq = ++orderSeq;
    set({ ordering: true });
    try {
      const ids = await engineFor(s.data.grid, s.makeEngine).order(before, planConstraints(s).maxSlopeDeg);
      // Stops added, moved, removed or renamed meanwhile: the answer is for a list that's gone.
      if (seq !== orderSeq || !sameStops(get().stops, before)) return;
      const byId = new Map(before.map((st) => [st.id, st]));
      const after = ids.map((id) => byId.get(id)).filter((st): st is Stop => !!st);
      if (after.length !== before.length || after.every((st, i) => st.id === before[i]!.id)) {
        get().showNotice('The stops are already in the shortest order.');
        return;
      }
      set({ stops: after, orderUndo: { before, after } });
      await get().planRoute();
    } catch (err) {
      if (seq === orderSeq) get().showNotice(`Couldn't find a better order: ${errorMessage(err)}`);
    } finally {
      if (seq === orderSeq) set({ ordering: false });
    }
  },
  undoOrder: () => {
    const u = get().orderUndo;
    if (!u || get().mode !== 'plan' || get().route.status === 'planning' || !sameStops(get().stops, u.after)) return;
    orderSeq++;
    set({ stops: u.before, orderUndo: null, ordering: false });
    void get().planRoute();
  },

  layers: { difficulty: false, sand: false, geology: false, crism: false, ring: false },
  colorVision: 'normal',
  setColorVision: (colorVision) => set({ colorVision }),
  toggleLayer: (id) => {
    const on = !get().layers[id];
    // #82: a site's missing layers can't be switched on.
    if (on && (id === 'sand' || id === 'geology' || id === 'crism') && !siteHasLayer(get().sites.find((s) => s.id === get().siteId), id)) return;
    set({ layers: { ...get().layers, [id]: on } });
    if (id === 'ring' && on) void get().planRing();
  },
  ring: null,
  planRing: async () => {
    const data = get().data;
    if (data.status !== 'ready') return;
    const seq = ++ringSeq;
    const oxygen = ringOxygenNow(get());
    ringOxygen = oxygen;
    ringBusy = true;
    try {
      const ring = await engineFor(data.grid, get().makeEngine).ring(oxygen, get().constraints.maxSlopeDeg);
      if (seq === ringSeq) set({ ring });
    } catch (err) {
      if (seq === ringSeq) {
        set({ ring: null });
        get().showNotice(`Couldn't compute the turn-back ring: ${errorMessage(err)}`);
      }
    } finally {
      if (seq === ringSeq) ringBusy = false;
    }
  },

  walk: null,
  setWalk: (walk) => set({ walk }),

  replay: IDLE_REPLAY,
  playWalk: () => {
    const route = get().route;
    if (route.status !== 'ready' || route.result.timeMin <= 0) return;
    const replay = get().replay;
    // Play from the end starts over.
    const elapsedMin = replay.status === 'done' ? 0 : replay.elapsedMin;
    moveWalk({ ...replay, status: 'playing', elapsedMin });
  },
  pauseWalk: () => {
    if (get().replay.status === 'playing') set({ replay: { ...get().replay, status: 'paused' } });
  },
  resetWalk: () => {
    // After a replan the planned route is gone; plan it again from the habitat.
    if (get().replanned) {
      void get().planRoute();
      return;
    }
    set({ walk: null, replay: { ...IDLE_REPLAY, speed: get().replay.speed } });
    refreshAlerts();
    if (get().mode === 'walk') void get().planRing();
  },
  seekWalk: (fraction) => {
    const route = get().route;
    if (route.status !== 'ready') return;
    const replay = get().replay;
    const elapsedMin = Math.min(1, Math.max(0, fraction)) * route.result.timeMin;
    const status = elapsedMin >= route.result.timeMin ? 'done' : replay.status === 'playing' ? 'playing' : 'paused';
    moveWalk({ ...replay, status, elapsedMin }, true);
  },
  setWalkSpeed: (speed) => set({ replay: { ...get().replay, speed } }),
  tickWalk: (dtRealSec) => {
    const route = get().route;
    const replay = get().replay;
    if (route.status !== 'ready' || replay.status !== 'playing' || get().replanning) return;
    moveWalk(advance(replay, dtRealSec, route.result.timeMin));
  },

  alerts: [],
  replanned: null,
  replanning: false,
  replanWalk: async (headHome = false) => {
    const { data, route } = get();
    if (data.status !== 'ready' || route.status !== 'ready' || get().replanning) return;
    const { grid } = data;
    const current = route.result;
    const walk = get().walk ?? { pathIdx: 0, oxygenLeftMin: startOxygen(get()) };
    const p = positionAt(current.path, walk.pathIdx);
    const from = { x: Math.round(p.x), y: Math.round(p.y) };
    // Stops still ahead on the current route, in order.
    const aheadIds = current.legs.filter((l) => l.endIdx > walk.pathIdx && l.toId !== START_ID).map((l) => l.toId);
    const ahead = aheadIds.flatMap((id) => get().stops.filter((s) => s.id === id));

    const seq = ++replanSeq;
    set({ replanning: true });
    try {
      const result = await engineFor(grid, get().makeEngine).replan(from, headHome ? [] : ahead, planConstraints(get()), walk.oxygenLeftMin);
      if (seq !== replanSeq) return;
      if (result.path.length < 2) {
        const atHome = from.x === grid.meta.habitat.x && from.y === grid.meta.habitat.y;
        get().showNotice(atHome ? 'Already at the habitat: nothing to replan.' : "Can't find a walkable way home from here.");
        return;
      }
      const before = get().replanned;
      const dropped = new Set([...(before?.droppedIds ?? []), ...(headHome ? aheadIds : result.outOfRangeIds)]);
      const replay = get().replay;
      set({
        route: { status: 'ready', result },
        walk: { pathIdx: 0, oxygenLeftMin: walk.oxygenLeftMin },
        replanned: {
          droppedIds: get().stops.filter((s) => dropped.has(s.id)).map((s) => s.id),
          startOxygenMin: walk.oxygenLeftMin,
          offsetMin: (before?.offsetMin ?? 0) + replay.elapsedMin,
          ...(headHome ? { headedHome: true } : {}),
        },
        // Carry on from the start of the new route; a finished or unstarted walk waits for Play.
        replay: { ...replay, elapsedMin: 0, status: replay.status === 'playing' ? 'playing' : 'paused' },
      });
      refreshAlerts();
      void get().planRing();
    } catch (err) {
      if (seq === replanSeq) get().showNotice(`Couldn't replan: ${errorMessage(err)}`);
    } finally {
      if (seq === replanSeq) set({ replanning: false });
    }
  },

  headHome: () => get().replanWalk(true),

  spaceWeather: { assessment: null, stale: false, loading: false, error: null, demo: false },
  checkSpaceWeather: async (force = false) => {
    const sw = get().spaceWeather;
    if (sw.loading) return;
    set({ spaceWeather: { ...sw, loading: true } });
    try {
      liveCheck = await checkDonki({ now: get().now(), fetch: get().fetchDonki, storage: browserStorage(), force });
      set({ spaceWeather: { ...get().spaceWeather, loading: false, stale: liveCheck.stale, error: liveCheck.error ?? null } });
    } catch (err) {
      set({ spaceWeather: { ...get().spaceWeather, loading: false, error: errorMessage(err) } });
    }
    applySpaceWeather();
  },
  setSpaceWeatherDemo: (on) => {
    set({ spaceWeather: { ...get().spaceWeather, demo: on } });
    applySpaceWeather();
  },

  makeEngine: createWorkerEngine,
  fetchDonki: (url) => fetch(url),
  now: () => new Date(),

  briefOpen: false,
  setBriefOpen: (open) => {
    set({ briefOpen: open });
    // The brief map shows the turn-back ring as planned.
    if (open && !get().ring) void get().planRing();
  },
  sharedSpaceWeather: null,
  restoreShared: async (plan) => {
    await get().loadSites();
    const known = get().sites.some((s) => s.id === plan.siteId);
    if (!known) get().showNotice(`Shared plan is for an unknown site '${plan.siteId}'; showing ${get().sites[0]?.name ?? 'the default site'}.`);
    const siteId = known ? plan.siteId : DEFAULT_SITE_ID;
    set({ siteId, mode: 'plan' });
    await get().loadData(siteDataUrl(DATA_ROOT, siteId));
    const data = get().data;
    if (data.status !== 'ready') return;
    const byId = new Map(data.grid.stops.map((s) => [s.id, s]));
    const stops: Stop[] = [];
    for (const p of plan.stops) {
      if (!isWalkable(data.grid, p.cell)) continue; // a damaged or foreign link; skip rather than break routing
      const base = byId.get(p.id);
      const stop = base ? { ...base, cell: p.cell, ...(p.name ? { name: p.name.slice(0, MAX_STOP_NAME) } : {}) } : { ...customStop(p.cell, stops), id: p.id, name: p.name ?? p.id };
      // #98: the crew's own goal and science value travel with the link.
      if (p.goal !== undefined) stop.goal = p.goal.slice(0, MAX_STOP_GOAL);
      if (p.scienceValue !== undefined) stop.scienceValue = p.scienceValue;
      stops.push(stop);
    }
    if (stops.length < plan.stops.length) get().showNotice(`${plan.stops.length - stops.length} shared stop(s) were off the walkable grid and were left out.`);
    set({
      stops,
      constraints: clampConstraints(plan.constraints, data.grid.meta.maxSlopeDeg),
      sharedSpaceWeather: plan.spaceWeather,
    });
    for (const s of stops) if (!byId.has(s.id)) fillScience(s.id);
    await get().planRoute();
    get().setBriefOpen(true);
  },
}));

/** The current plan as a share-link payload (M37). */
export function sharePlanFrom(s: AppState, app: string, createdAt: Date): SharedPlan {
  const siteStops = s.data.status === 'ready' ? new Map(s.data.grid.stops.map((x) => [x.id, x])) : new Map<string, Stop>();
  const a = s.spaceWeather.assessment;
  return {
    siteId: s.siteId,
    // Only what differs from the site's preset (everything, for a crew stop) goes in the link.
    stops: s.stops.map((x) => {
      const base = siteStops.get(x.id);
      return {
        id: x.id,
        cell: x.cell,
        ...(base?.name !== x.name ? { name: x.name } : {}),
        ...((base ? base.goal !== x.goal : x.goal !== '') ? { goal: x.goal } : {}),
        ...((base ? base.scienceValue !== x.scienceValue : x.scienceValue !== 1) ? { scienceValue: x.scienceValue } : {}),
      };
    }),
    constraints: s.constraints,
    spaceWeather: a
      ? { status: a.status, reason: a.reasons[0]?.text ?? (hasNoData(a) ? noDataText(a) : 'quiet'), eventIds: eventIds(a), fetchedAt: a.fetchedAt, demo: s.spaceWeather.demo }
      : null,
    app,
    createdAt: createdAt.toISOString(),
  };
}

/**
 * Reasons not to start a walk now (#89): space weather blocks the EVA, or a stop is out of range
 * on the ready route. Empty when the walk can start without a warning.
 */
export function walkWarnings(s: Pick<AppState, 'spaceWeather' | 'route' | 'stops'>): string[] {
  const reasons: string[] = [];
  const sw = s.spaceWeather.assessment;
  if (sw?.status === 'block') reasons.push(spaceWeatherHeadline(sw));
  if (s.route.status === 'ready') {
    for (const id of s.route.result.outOfRangeIds) {
      reasons.push(`${s.stops.find((x) => x.id === id)?.name ?? id} is out of range`);
    }
  }
  return reasons;
}

/** Re-runs the space-weather rules and, if the status changed, follows it through the route, ring and alerts. */
function applySpaceWeather(): void {
  const s = useAppStore.getState();
  const bundle = s.spaceWeather.demo ? STORM_DEMO : liveCheck?.bundle;
  const assessment = bundle ? assessSpaceWeather(bundle, s.spaceWeather.demo ? new Date(STORM_DEMO.fetchedAt) : s.now()) : null;
  const before = s.spaceWeather.assessment;
  useAppStore.setState({ spaceWeather: { ...s.spaceWeather, assessment } });
  if ((before?.status ?? 'clear') === (assessment?.status ?? 'clear')) {
    refreshAlerts(); // the reason text may have changed
    return;
  }
  // Tightening changes the reserve: Plan mode reroutes; Walk keeps its route but updates the ring and alerts.
  if (s.mode === 'plan') void s.planRoute();
  else {
    refreshAlerts();
    void s.planRing();
  }
}

/** Constraints sent to the engine: the crew's settings, tightened by space weather. */
export function planConstraints(s: Pick<AppState, 'constraints' | 'spaceWeather'>): Constraints {
  return effectiveConstraints(s.constraints, s.spaceWeather.assessment);
}

/** Usable oxygen the ring should be drawn for: right now in Walk mode, as planned otherwise. */
function ringOxygenNow(s: AppState): number {
  const { oxygenMin, reservePct } = planConstraints(s);
  const usable = s.mode !== 'walk' || !s.walk ? usableOxygenMin(oxygenMin, reservePct) : Math.max(0, s.walk.oxygenLeftMin - (oxygenMin * reservePct) / 100);
  return ringOxygenFor(usable, s.spaceWeather.assessment);
}

/** Oxygen in the tank at the start of the route being walked. */
function startOxygen(s: AppState): number {
  return s.replanned?.startOxygenMin ?? s.constraints.oxygenMin;
}

/** Runs `checkAlerts` for where the crew is now (Walk mode only). */
function refreshAlerts(): void {
  const s = useAppStore.getState();
  if (s.mode !== 'walk' || s.route.status !== 'ready' || s.data.status !== 'ready' || s.route.result.path.length === 0) {
    if (s.alerts.length > 0) useAppStore.setState({ alerts: [] });
    return;
  }
  const route = s.route.result;
  const walk = s.walk ?? { pathIdx: 0, oxygenLeftMin: startOxygen(s) };
  const sw = spaceWeatherAlert(s.spaceWeather.assessment);
  const found = checkAlerts(positionAt(route.path, walk.pathIdx), route, planConstraints(s), walk.oxygenLeftMin, s.data.grid);
  // Critical first, as checkAlerts orders them; space weather leads its own severity group.
  const alerts = sw ? [sw, ...found].sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical')) : found;
  // Keep the same array while nothing changed, so the banner doesn't re-render every frame.
  const same = alerts.length === s.alerts.length && alerts.every((a, i) => a.kind === s.alerts[i]!.kind && a.severity === s.alerts[i]!.severity && a.message === s.alerts[i]!.message);
  if (!same) useAppStore.setState({ alerts });
}

/** Applies a replay clock: moves the crew, checks alerts, and refreshes the ring as the oxygen drops. */
function moveWalk(replay: Replay, forceRing = false): void {
  const s = useAppStore.getState();
  if (s.route.status !== 'ready' || s.data.status !== 'ready') return;
  useAppStore.setState({ replay, walk: walkAt(s.route.result, { oxygenMin: startOxygen(s) }, s.data.grid.meta, replay.elapsedMin) });
  refreshAlerts();
  if (useAppStore.getState().mode !== 'walk') return;
  const oxygen = ringOxygenNow(useAppStore.getState());
  const stale = ringOxygen === null || Math.abs(oxygen - ringOxygen) >= RING_STEP_MIN;
  // One request at a time: the next tick picks up whatever changed meanwhile.
  if (forceRing || replay.status === 'done' || (stale && !ringBusy)) void useAppStore.getState().planRing();
}

/** Sends the avoid zones to the engine and reroutes (M32). */
function syncAvoid(s: AppState): void {
  if (s.data.status !== 'ready') return;
  engineFor(s.data.grid, s.makeEngine).avoid(s.avoidZones);
  void s.planRoute();
}

/**
 * #98: fills a crew stop's rock unit and minerals from the map layers at its
 * cell. Dropped if the stop has moved, gone, or the site changed meanwhile.
 */
function fillScience(id: string): void {
  const s = useAppStore.getState();
  const stop = s.stops.find((x) => x.id === id);
  if (!stop) return;
  const { cell } = stop;
  const siteId = s.siteId;
  s.stopScience(cell).then(
    (science) => {
      const now = useAppStore.getState();
      const cur = now.stops.find((x) => x.id === id);
      if (now.siteId !== siteId || !cur || cur.cell.x !== cell.x || cur.cell.y !== cell.y) return;
      useAppStore.setState({ stops: now.stops.map((x) => (x.id === id ? { ...x, ...science } : x)) });
    },
    () => {}, // a layer that can't load leaves "Unknown", as before
  );
}

/** Drops the cached engine (tests, or after swapping the factory). */
export function resetEngine(): void {
  ringOxygen = null;
  ringBusy = false;
  liveCheck = null;
  replanSeq++;
  clearTimeout(replanTimer);
  engine?.terminate();
  engine = null;
  engineGrid = null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
