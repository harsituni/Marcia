/**
 * "What's estimated" for the mission brief (M37): every modelled number and
 * the constant behind it, read from the config modules so the brief can't
 * drift from the code. tests/brief.test.ts fails if a numeric constant is
 * added to model.ts or SPACE_WEATHER without appearing here.
 */
import * as model from '../engine/model.ts';
import { SPACE_WEATHER } from '../engine/spaceWeather.ts';

export interface Estimate {
  /** Config name, e.g. `WALK_SPEED_M_PER_MIN` or `SPACE_WEATHER.blockSepWithinH`. */
  key: string;
  label: string;
  value: number | string;
  unit: string;
  /** What it drives. */
  drives: string;
}

export function estimates(): Estimate[] {
  const sw = SPACE_WEATHER;
  return [
    { key: 'WALK_SPEED_M_PER_MIN', label: 'Walking speed', value: model.WALK_SPEED_M_PER_MIN, unit: 'm/min', drives: 'walk time' },
    { key: 'ENERGY_KJ_PER_MIN', label: 'Metabolic energy', value: model.ENERGY_KJ_PER_MIN, unit: 'kJ/min', drives: 'energy' },
    { key: 'OXYGEN_MIN_PER_MIN', label: 'Oxygen use', value: model.OXYGEN_MIN_PER_MIN, unit: 'supply-min per min walked', drives: 'oxygen used' },
    { key: 'MAX_SLOPE_DEG', label: 'Blocked above slope', value: model.MAX_SLOPE_DEG, unit: '°', drives: 'slope cost' },
    { key: 'SAND_COST_MULT', label: 'Sand cost factor', value: model.SAND_COST_MULT, unit: '×', drives: 'slope cost' },
    { key: 'SOFT_COST_MULT', label: 'Soft-ground cost factor', value: model.SOFT_COST_MULT, unit: '×', drives: 'slope cost' },
    { key: 'SOFT_GROUND_TI_MAX', label: 'Soft ground below thermal inertia', value: model.SOFT_GROUND_TI_MAX, unit: 'J m⁻² K⁻¹ s⁻½', drives: 'slope cost' },
    { key: 'OFF_ROUTE_WARN_M', label: 'Off-route warning', value: model.OFF_ROUTE_WARN_M, unit: 'm', drives: 'alerts' },
    { key: 'OFF_ROUTE_CRITICAL_M', label: 'Off-route critical', value: model.OFF_ROUTE_CRITICAL_M, unit: 'm', drives: 'alerts' },
    { key: 'SLOPE_WARN_MARGIN_DEG', label: 'Slope warning margin', value: model.SLOPE_WARN_MARGIN_DEG, unit: '°', drives: 'alerts' },
    { key: 'OXYGEN_MARGIN_WARN_MIN', label: 'Oxygen margin warning', value: model.OXYGEN_MARGIN_WARN_MIN, unit: 'min', drives: 'alerts' },
    { key: 'SPACE_WEATHER.blockSepWithinH', label: 'Block: SEP event within', value: sw.blockSepWithinH, unit: 'h', drives: 'space weather' },
    { key: 'SPACE_WEATHER.blockCmeArrivalWindowH', label: 'Block: CME at Mars within ±', value: sw.blockCmeArrivalWindowH, unit: 'h', drives: 'space weather' },
    { key: 'SPACE_WEATHER.tightenFlareWithinH', label: 'Tighten: M/X flare within', value: sw.tightenFlareWithinH, unit: 'h', drives: 'space weather' },
    { key: 'SPACE_WEATHER.tightenFlareClasses', label: 'Tighten: flare classes', value: sw.tightenFlareClasses.join(', '), unit: '', drives: 'space weather' },
    { key: 'SPACE_WEATHER.tightenCmeArrivalWithinH', label: 'Tighten: CME at Mars within', value: sw.tightenCmeArrivalWithinH, unit: 'h', drives: 'space weather' },
    { key: 'SPACE_WEATHER.tightenReservePctAdd', label: 'Tighten: reserve raised by', value: sw.tightenReservePctAdd, unit: 'points', drives: 'space weather' },
    { key: 'SPACE_WEATHER.tightenRingOxygenFactor', label: 'Tighten: ring oxygen', value: sw.tightenRingOxygenFactor, unit: '× usable', drives: 'space weather' },
    { key: 'SPACE_WEATHER.lookbackDays', label: 'DONKI history fetched', value: sw.lookbackDays, unit: 'days', drives: 'space weather' },
    { key: 'SPACE_WEATHER.lookaheadDays', label: 'DONKI forecast fetched', value: sw.lookaheadDays, unit: 'days', drives: 'space weather' },
    { key: 'SPACE_WEATHER.refetchMin', label: 'DONKI refetch interval', value: sw.refetchMin, unit: 'min', drives: 'space weather' },
  ];
}
