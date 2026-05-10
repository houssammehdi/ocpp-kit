import { describe, expect, it } from 'vitest';
import {
  acceptedPowerW,
  deriveSeed,
  ElectricVehicle,
  Random,
  randomEvProfile,
  type EvProfile,
} from '../../src/index.js';

const ev: EvProfile = { batteryKWh: 60, initialSoc: 0.2, targetSoc: 1, maxPowerW: 11_000 };

describe('charging curve', () => {
  it('draws full power in the constant-current phase', () => {
    for (const soc of [0, 0.2, 0.5, 0.79]) expect(acceptedPowerW(ev, soc)).toBe(11_000);
  });

  it('tapers above ~80 % SoC (constant-voltage phase)', () => {
    const p80 = acceptedPowerW(ev, 0.8);
    const p90 = acceptedPowerW(ev, 0.9);
    const p95 = acceptedPowerW(ev, 0.95);
    const p99 = acceptedPowerW(ev, 0.99);
    expect(p80).toBe(11_000);
    expect(p90).toBeCloseTo(5_500);
    expect(p95).toBeCloseTo(2_750);
    expect(p99).toBeCloseTo(550);
    expect(p80).toBeGreaterThan(p90);
  });

  it('stops at the target SoC and respects a custom taper start', () => {
    expect(acceptedPowerW({ ...ev, targetSoc: 0.8 }, 0.8)).toBe(0);
    expect(acceptedPowerW(ev, 1)).toBe(0);
    expect(acceptedPowerW({ ...ev, taperStartSoc: 0.5 }, 0.75)).toBeCloseTo(5_500);
  });
});

describe('ElectricVehicle', () => {
  it('integrates energy into SoC with charging losses', () => {
    const car = new ElectricVehicle({ ...ev, efficiency: 0.9 });
    const drawn = car.charge(22_000, 3_600);
    expect(drawn).toBe(11_000);
    // 11 kWh from the grid, 9.9 kWh stored in a 60 kWh battery.
    expect(car.soc).toBeCloseTo(0.2 + 9.9 / 60);
  });

  it('never draws more than offered and stops when full', () => {
    const car = new ElectricVehicle({ ...ev, initialSoc: 0.5, targetSoc: 0.6 });
    expect(car.charge(4_000, 60)).toBe(4_000);
    expect(car.charge(-5, 60)).toBe(0);
    for (let i = 0; i < 10_000 && !car.isFull; i++) car.charge(11_000, 60);
    expect(car.isFull).toBe(true);
    expect(car.soc).toBeGreaterThanOrEqual(0.6);
    expect(car.charge(11_000, 60)).toBe(0);
  });

  it('takes longer for the last 20 % than a CC-only model would', () => {
    const car = new ElectricVehicle({ ...ev, initialSoc: 0.8, efficiency: 1 });
    let seconds = 0;
    while (!car.isFull) {
      car.charge(11_000, 10);
      seconds += 10;
    }
    const ccOnlySeconds = (0.2 * 60_000 * 3_600) / 11_000;
    expect(seconds).toBeGreaterThan(2 * ccOnlySeconds);
  });
});

describe('seeded randomness', () => {
  it('is reproducible for the same seed and differs for others', () => {
    const a = new Random(42);
    const b = new Random(42);
    const c = new Random(43);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
  });

  it('keeps values in range', () => {
    const random = new Random(7);
    for (let i = 0; i < 1_000; i++) {
      const value = random.int(3, 5);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
      expect(random.float(-1, 1)).toBeLessThan(1);
    }
    expect(() => random.pick([])).toThrow(RangeError);
    expect(new Random(1).chance(0)).toBe(false);
    expect(new Random(1).chance(1)).toBe(true);
  });

  it('derives independent seeds per charger', () => {
    const seeds = new Set(Array.from({ length: 100 }, (_, i) => deriveSeed(1, `SIM-${i}`)));
    expect(seeds.size).toBe(100);
    expect(deriveSeed(1, 'x')).toBe(deriveSeed(1, 'x'));
    expect(deriveSeed(1, 'x')).not.toBe(deriveSeed(2, 'x'));
  });

  it('generates plausible EV profiles deterministically', () => {
    const one = randomEvProfile(new Random(5));
    expect(randomEvProfile(new Random(5))).toEqual(one);
    expect(one.batteryKWh).toBeGreaterThanOrEqual(40);
    expect(one.initialSoc).toBeGreaterThanOrEqual(0.1);
    expect(one.initialSoc).toBeLessThanOrEqual(0.6);
    expect([7_400, 11_000, 22_000]).toContain(one.maxPowerW);
  });
});
