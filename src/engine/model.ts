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

/** Oxygen budget usable before dipping into the reserve. */
export function usableOxygenMin(oxygenMin: number, reservePct: number): number {
  return oxygenMin * (1 - reservePct / 100);
}
