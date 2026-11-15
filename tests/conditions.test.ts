import { describe, expect, it } from 'vitest';
import {
  CONDITIONS,
  assessMeda,
  assessRad,
  deriveConditions,
  marsLocalHour,
  sampleMeda,
  sampleRad,
  windFromLabel,
} from '../src/engine/conditions.ts';
import { JEZERO_BOUNDS } from '../src/data/sites.ts';

const LON = (JEZERO_BOUNDS.minLon + JEZERO_BOUNDS.maxLon) / 2;

/** Pick a UTC instant whose Mars local hour at Jezero is near `wantHour`. */
function atLocalHour(wantHour: number): Date {
  // Brute-force a few sols; the model only needs "afternoon vs night".
  for (let h = 0; h < 48; h++) {
    const at = new Date(Date.UTC(2026, 0, 1, h, 0, 0));
    const got = marsLocalHour(LON, at);
    if (Math.abs(((got - wantHour + 12) % 24) - 12) < 0.6) return at;
  }
  throw new Error(`no sample near local hour ${wantHour}`);
}

describe('marsLocalHour', () => {
  it('stays in [0, 24)', () => {
    for (let i = 0; i < 20; i++) {
      const h = marsLocalHour(LON, new Date(1_700_000_000_000 + i * 3_600_000));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(24);
    }
  });
});

describe('windFromLabel', () => {
  it('maps bearings to cardinals', () => {
    expect(windFromLabel(0)).toBe('N');
    expect(windFromLabel(90)).toBe('E');
    expect(windFromLabel(180)).toBe('S');
    expect(windFromLabel(270)).toBe('W');
    expect(windFromLabel(315)).toBe('NW');
  });
});

describe('sampleMeda', () => {
  it('is warmer and windier in the afternoon than near dawn', () => {
    const day = sampleMeda('jezero', LON, atLocalHour(15));
    const night = sampleMeda('jezero', LON, atLocalHour(3));
    expect(day.airTempC).toBeGreaterThan(night.airTempC);
    expect(day.windSpeedMs).toBeGreaterThan(night.windSpeedMs);
    expect(night.humidityPct).toBeGreaterThan(day.humidityPct);
  });

  it('keeps pressure near the Jezero baseline', () => {
    const m = sampleMeda('jezero', LON, atLocalHour(12));
    expect(m.pressurePa).toBeGreaterThan(700);
    expect(m.pressurePa).toBeLessThan(740);
  });
});

describe('sampleRad / assessRad', () => {
  it('is quiet under clear space weather', () => {
    const r = assessRad(sampleRad('jezero', 'clear'));
    expect(r.status).toBe('ok');
    expect(r.doseRateUGyH).toBeLessThan(CONDITIONS.radCautionUGyH);
  });

  it('elevates under tighten and goes high under block', () => {
    const tight = assessRad(sampleRad('jezero', 'tighten'));
    const blocked = assessRad(sampleRad('jezero', 'block'));
    expect(tight.status).toBe('caution');
    expect(blocked.status).toBe('critical');
    expect(blocked.doseRateUGyH).toBeGreaterThan(tight.doseRateUGyH);
  });
});

describe('assessMeda', () => {
  it('flags extreme wind as severe', () => {
    const base = sampleMeda('jezero', LON, atLocalHour(15));
    const severe = assessMeda({ ...base, windSpeedMs: CONDITIONS.windCriticalMs }, 'jezero');
    expect(severe.status).toBe('critical');
    expect(severe.statusWord).toBe('SEVERE');
  });
});

describe('deriveConditions', () => {
  it('returns MEDA + RAD readings with instrument credits', () => {
    const { meda, rad, credit } = deriveConditions({
      siteId: 'jezero',
      bounds: JEZERO_BOUNDS,
      at: atLocalHour(12),
      spaceWeather: null,
    });
    expect(meda.statusWord).toMatch(/OK|ROUGH|SEVERE/);
    expect(rad.statusWord).toMatch(/OK|ELEVATED|HIGH/);
    expect(credit.meda).toContain('MEDA');
    expect(credit.rad).toContain('RAD');
  });
});
