/**
 * Walking model shared by the mock router and, later, the real engine (M14
 * may tune these numbers). Kept in one place so both tracks agree.
 */

/** Suited walking speed on flat ground, metres per minute (~3 km/h). */
export const WALK_SPEED_M_PER_MIN = 50;

/** Metabolic power of a suited walk, kilojoules per minute (~300 W). */
export const ENERGY_KJ_PER_MIN = 18;

/** Oxygen minutes used per minute walked. */
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

/** Oxygen budget usable before dipping into the reserve. */
export function usableOxygenMin(oxygenMin: number, reservePct: number): number {
  return oxygenMin * (1 - reservePct / 100);
}
