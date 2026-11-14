/**
 * Walking model and other tuning constants, shared by the mock router and the
 * real A* engine. This is the ONE config file for them: don't hard-code these
 * numbers anywhere else.
 *
 * Route stats (`RouteResult.distanceM`, `timeMin`, `energyKJ`,
 * `oxygenUsedMin`) are ESTIMATES. Distance is the 8-connected grid path
 * length; time, energy and oxygen scale from it with the flat-ground walking
 * constants below. Slope and terrain don't change them yet (they only steer
 * the path through `cost.bin`).
 */

/** True while route stats come from the estimate constants below; the UI can show it as a label. */
export const STATS_ARE_ESTIMATES = true;

/**
 * ESTIMATE, no source yet. Suited walking speed on flat ground, metres per
 * minute (50 m/min = 3 km/h). Assumes steady walking with no stops, and the
 * same speed uphill, downhill and on sand. `timeMin = distanceM / this`.
 */
export const WALK_SPEED_M_PER_MIN = 50;

/**
 * ESTIMATE, no source yet. Metabolic energy of a suited walk, kilojoules per
 * minute walked (18 kJ/min = 300 W). Assumes a constant rate regardless of
 * slope, terrain or load. `energyKJ = timeMin × this`.
 */
export const ENERGY_KJ_PER_MIN = 18;

/**
 * ESTIMATE, no source yet. Oxygen-supply minutes used per minute walked.
 * Assumes the suit's oxygen budget (`Constraints.oxygenMin`) is rated in
 * minutes at walking effort, so 1 minute walked uses 1 minute of supply.
 * `oxygenUsedMin = timeMin × this`.
 */
export const OXYGEN_MIN_PER_MIN = 1;

/**
 * ESTIMATE. No published TI cutoff for loose sand exists. Mini-TES found
 * bedforms at ~200 J m^-2 K^-1 s^-1/2 (~160 µm grains; Fergason et al. 2006b,
 * abstract), while medium-sand dunes in nearby Hargraves crater average
 * 238±17 (Emran et al. 2021, Results). THEMIS TI accuracy is ~20%
 * (Fergason et al. 2006a, abstract); source map is 100 m (Edwards & Buz 2021).
 * In our box TI<200 flags 15.8% of cells, matching only 27.3% of mapped
 * bedforms (both computed by us, scripts/compute-sand.ts), so the primary sand
 * mask comes from Stack et al. (2020) aeolian bedform units (Ab-l/Ab-s).
 * Thermal inertia in J m⁻² K⁻¹ s⁻½; cells below this are "soft ground".
 */
export const SOFT_GROUND_TI_MAX = 200;

/**
 * ESTIMATE, no source yet. Slope (degrees) above which a cell is blocked in
 * `cost.bin` (written to `GridMeta.maxSlopeDeg`). Matches the fixture grid.
 */
export const MAX_SLOPE_DEG = 25;

/**
 * ESTIMATE, no source yet. Cost multiplier on mapped sand (aeolian bedforms,
 * `sand.bin`): walking on loose sand assumed twice as hard as on rock.
 * Matches the fixture grid.
 */
export const SAND_COST_MULT = 2;

/**
 * ESTIMATE, no source yet. Cost multiplier on soft ground (THEMIS TI below
 * `SOFT_GROUND_TI_MAX`) that isn't already mapped sand.
 */
export const SOFT_COST_MULT = 1.3;

/** Oxygen budget usable before dipping into the reserve. */
export function usableOxygenMin(oxygenMin: number, reservePct: number): number {
  return oxygenMin * (1 - reservePct / 100);
}

// --- Walk-mode alert thresholds (M26, `alerts.ts`) --------------------------

/**
 * JUDGEMENT CALL, no source. Metres from the planned path before an off-route
 * warning. 15 m is three 5 m cells: beyond a normal step around a rock, and
 * beyond the half-cell a between-cells position can sit from the line.
 */
export const OFF_ROUTE_WARN_M = 15;

/** JUDGEMENT CALL, no source. Metres from the planned path before the off-route alert turns critical. */
export const OFF_ROUTE_CRITICAL_M = 40;

/**
 * JUDGEMENT CALL, no source. Warn when the ground is within this many degrees
 * of the crew's slope limit (`Constraints.maxSlopeDeg`); over the limit is critical.
 */
export const SLOPE_WARN_MARGIN_DEG = 3;

/**
 * JUDGEMENT CALL, no source. Warn when finishing the route would leave fewer
 * than this many oxygen-minutes above the reserve; below zero is critical.
 */
export const OXYGEN_MARGIN_WARN_MIN = 15;
