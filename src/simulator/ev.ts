import type { Random } from './random.js';

/** Static characteristics of a simulated electric vehicle. */
export interface EvProfile {
  /** Usable battery capacity in kWh. */
  readonly batteryKWh: number;
  /** State of charge when plugged in, 0..1. */
  readonly initialSoc: number;
  /** State of charge at which the EV stops charging, 0..1. */
  readonly targetSoc: number;
  /** Maximum power the on-board charger accepts, in W. */
  readonly maxPowerW: number;
  /**
   * SoC where the battery leaves the constant-current phase and power tapers off
   * (constant-voltage phase). Default: 0.8.
   */
  readonly taperStartSoc?: number;
  /** Fraction of grid energy stored in the battery. Default: 0.92. */
  readonly efficiency?: number;
}

/** Lowest fraction of maximum power drawn during the constant-voltage taper. */
const MIN_TAPER_FRACTION = 0.05;

/**
 * Power the EV accepts at a given state of charge (CC/CV curve): full power up to the taper
 * start, then a linear decline towards `MIN_TAPER_FRACTION` of maximum power at 100 %, and zero
 * once the target SoC is reached.
 */
export function acceptedPowerW(profile: EvProfile, soc: number): number {
  if (soc >= profile.targetSoc || soc >= 1) return 0;
  const taperStart = profile.taperStartSoc ?? 0.8;
  if (soc < taperStart) return profile.maxPowerW;
  const fraction = Math.max(MIN_TAPER_FRACTION, (1 - soc) / (1 - taperStart));
  return profile.maxPowerW * fraction;
}

/** A simulated EV whose battery integrates the energy it receives. */
export class ElectricVehicle {
  readonly profile: EvProfile;
  #soc: number;

  constructor(profile: EvProfile) {
    this.profile = profile;
    this.#soc = profile.initialSoc;
  }

  /** Current state of charge, 0..1. */
  get soc(): number {
    return this.#soc;
  }

  /** Whether the EV reached its target state of charge. */
  get isFull(): boolean {
    return acceptedPowerW(this.profile, this.#soc) === 0;
  }

  /**
   * Draw energy for `seconds` with at most `offeredW` available.
   *
   * @returns the power drawn from the grid in W
   */
  charge(offeredW: number, seconds: number): number {
    const drawnW = Math.max(0, Math.min(offeredW, acceptedPowerW(this.profile, this.#soc)));
    const storedWh = (drawnW * seconds * (this.profile.efficiency ?? 0.92)) / 3_600;
    this.#soc = Math.min(1, this.#soc + storedWh / (this.profile.batteryKWh * 1_000));
    return drawnW;
  }
}

const BATTERIES_KWH = [40, 52, 58, 64, 77, 82, 100] as const;
const ONBOARD_CHARGERS_W = [7_400, 11_000, 11_000, 22_000] as const;

/** Generate a plausible EV profile from a seeded random source. */
export function randomEvProfile(random: Random): EvProfile {
  return {
    batteryKWh: random.pick(BATTERIES_KWH),
    initialSoc: Math.round(random.float(0.1, 0.6) * 100) / 100,
    targetSoc: random.pick([0.8, 0.9, 1]),
    maxPowerW: random.pick(ONBOARD_CHARGERS_W),
  };
}
