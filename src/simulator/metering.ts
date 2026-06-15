import {
  ciKey,
  Measurand,
  Phase,
  type MeterValue,
  type ReadingContext,
  type SampledValue,
} from '../messages/index.js';

/** A measurand configuration item such as `Energy.Active.Import.Register` or `Current.Import.L2`. */
export interface MeasurandItem {
  readonly measurand: Measurand;
  /** Phase qualifier; without it the simulator reports its default breakdown (see below). */
  readonly phase?: Phase;
}

const PER_PHASE: readonly Phase[] = ['L1', 'L2', 'L3'];

/**
 * Measurands the simulator produces, with the phase qualifiers each accepts. `RPM` is not
 * supported: a configuration list that asks for it is rejected, as a real charger would.
 */
const SUPPORTED: ReadonlyMap<Measurand, readonly Phase[]> = new Map<Measurand, readonly Phase[]>([
  ['Energy.Active.Import.Register', PER_PHASE],
  ['Energy.Active.Export.Register', PER_PHASE],
  ['Energy.Reactive.Import.Register', []],
  ['Energy.Reactive.Export.Register', []],
  ['Energy.Active.Import.Interval', PER_PHASE],
  ['Energy.Active.Export.Interval', PER_PHASE],
  ['Energy.Reactive.Import.Interval', []],
  ['Energy.Reactive.Export.Interval', []],
  ['Power.Active.Import', PER_PHASE],
  ['Power.Active.Export', PER_PHASE],
  ['Power.Reactive.Import', []],
  ['Power.Reactive.Export', []],
  ['Power.Offered', []],
  ['Power.Factor', []],
  ['Current.Import', [...PER_PHASE, 'N']],
  ['Current.Export', [...PER_PHASE, 'N']],
  ['Current.Offered', []],
  ['Voltage', ['L1-N', 'L2-N', 'L3-N', 'L1', 'L2', 'L3', 'L1-L2', 'L2-L3', 'L3-L1']],
  ['Frequency', []],
  ['Temperature', []],
  ['SoC', []],
]);

/** Measurands the simulator can report. */
export const SUPPORTED_MEASURANDS: readonly Measurand[] = [...SUPPORTED.keys()];

const CANONICAL_MEASURANDS = new Map<string, Measurand>(
  Measurand.anyOf.map(({ const: name }) => [ciKey(name), name]),
);
const CANONICAL_PHASES = new Map<string, Phase>(
  Phase.anyOf.map(({ const: name }) => [ciKey(name), name]),
);

/**
 * Parse one item of a measurand list. The specification lets a measurand be combined with a
 * phase, e.g. `Voltage.L1-N`. Items are CiStrings, so matching ignores case.
 *
 * @returns the item, or `undefined` when it is unknown or not supported by the simulator
 */
export function parseMeasurandItem(item: string): MeasurandItem | undefined {
  const text = item.trim();
  const whole = CANONICAL_MEASURANDS.get(ciKey(text));
  if (whole) return SUPPORTED.has(whole) ? { measurand: whole } : undefined;
  const dot = text.lastIndexOf('.');
  if (dot < 0) return undefined;
  const measurand = CANONICAL_MEASURANDS.get(ciKey(text.slice(0, dot)));
  const phase = CANONICAL_PHASES.get(ciKey(text.slice(dot + 1)));
  if (!measurand || !phase || !SUPPORTED.get(measurand)?.includes(phase)) return undefined;
  return { measurand, phase };
}

/**
 * Parse a comma-separated measurand list (`MeterValuesSampledData` and friends). An empty value
 * is an empty list.
 *
 * @returns the items, or `undefined` when any item is invalid
 */
export function parseMeasurandList(value: string): MeasurandItem[] | undefined {
  if (value.trim() === '') return [];
  const items: MeasurandItem[] = [];
  for (const part of value.split(',')) {
    const item = parseMeasurandItem(part);
    if (!item) return undefined;
    items.push(item);
  }
  return items;
}

/** Canonical text of a measurand list, as stored in the configuration. */
export function formatMeasurandList(items: readonly MeasurandItem[]): string {
  return items
    .map((item) => (item.phase ? `${item.measurand}.${item.phase}` : item.measurand))
    .join(',');
}

/** Whether a measurand accumulates over an interval (`Energy.*.Interval`). */
export function isIntervalMeasurand(measurand: Measurand): boolean {
  return measurand.endsWith('.Interval');
}

/** Electrical state of a connector (or of the whole charge point) at one instant. */
export interface MeterSnapshot {
  /** Energy register, Wh. */
  readonly energyWh: number;
  /** Active power drawn, W. */
  readonly powerW: number;
  /** Power the charge point currently offers, W. */
  readonly offeredW: number;
  /** Phase-to-neutral voltage, V. */
  readonly voltage: number;
  /** Number of wired phases (1 or 3). */
  readonly phases: number;
  /** EV state of charge, 0..1, when an EV is connected. */
  readonly soc?: number | undefined;
  /** Temperature of the charge point body, degrees Celsius. */
  readonly temperatureC: number;
  /** Grid frequency, Hz. */
  readonly frequencyHz: number;
}

const WIRED: readonly Phase[] = ['L1', 'L2', 'L3'];
const LINE_TO_LINE: Readonly<Partial<Record<Phase, readonly [number, number]>>> = {
  'L1-L2': [1, 2],
  'L2-L3': [2, 3],
  'L3-L1': [3, 1],
};

function phaseIndex(phase: Phase): number | undefined {
  const match = /^L([123])(-N)?$/.exec(phase);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Build the sampled values for `items`.
 *
 * Without a phase qualifier, energy and power are reported as totals, while current and voltage
 * are reported per wired phase (with `phase` set), which is how most chargers break them down.
 * With a qualifier, only that phase is reported; phases that are not wired read 0.
 * `Energy.*.Interval` items are only reported when `intervalWh` (the energy of the interval that
 * ended) is given.
 */
export function sampleValues(
  items: readonly MeasurandItem[],
  snapshot: MeterSnapshot,
  context: ReadingContext,
  intervalWh?: number,
): SampledValue[] {
  const { phases } = snapshot;
  const wired = WIRED.slice(0, phases);
  const perPhase = (total: number, phase: Phase | undefined): number => {
    if (phase === undefined) return total;
    const index = phaseIndex(phase);
    return index !== undefined && index <= phases ? total / phases : 0;
  };
  const currentA = snapshot.powerW / (snapshot.voltage * phases);
  const values: SampledValue[] = [];
  const push = (
    measurand: Measurand,
    value: string,
    extra: Omit<SampledValue, 'value' | 'measurand' | 'context'> = {},
  ): void => {
    values.push({ value, context, measurand, ...extra });
  };
  const withPhase = (phase: Phase | undefined) => (phase === undefined ? {} : { phase });

  for (const { measurand, phase } of items) {
    switch (measurand) {
      case 'Energy.Active.Import.Register':
        push(measurand, String(Math.round(perPhase(snapshot.energyWh, phase))), {
          ...withPhase(phase),
          location: 'Outlet',
          unit: 'Wh',
        });
        break;
      case 'Energy.Active.Import.Interval':
        if (intervalWh !== undefined) {
          push(measurand, String(Math.round(perPhase(intervalWh, phase))), {
            ...withPhase(phase),
            location: 'Outlet',
            unit: 'Wh',
          });
        }
        break;
      case 'Energy.Active.Export.Register':
      case 'Energy.Active.Export.Interval':
        if (isIntervalMeasurand(measurand) && intervalWh === undefined) break;
        push(measurand, '0', { ...withPhase(phase), unit: 'Wh' });
        break;
      case 'Energy.Reactive.Import.Register':
      case 'Energy.Reactive.Export.Register':
      case 'Energy.Reactive.Import.Interval':
      case 'Energy.Reactive.Export.Interval':
        if (isIntervalMeasurand(measurand) && intervalWh === undefined) break;
        push(measurand, '0', { unit: 'varh' });
        break;
      case 'Power.Active.Import':
        push(measurand, perPhase(snapshot.powerW, phase).toFixed(1), {
          ...withPhase(phase),
          unit: 'W',
        });
        break;
      case 'Power.Active.Export':
        push(measurand, '0.0', { ...withPhase(phase), unit: 'W' });
        break;
      case 'Power.Reactive.Import':
      case 'Power.Reactive.Export':
        push(measurand, '0.0', { unit: 'var' });
        break;
      case 'Power.Offered':
        push(measurand, snapshot.offeredW.toFixed(1), { unit: 'W' });
        break;
      case 'Power.Factor':
        push(measurand, '1.00');
        break;
      case 'Current.Import':
      case 'Current.Export': {
        const amps = measurand === 'Current.Import' ? currentA : 0;
        if (phase === undefined) {
          for (const p of wired) push(measurand, amps.toFixed(2), { phase: p, unit: 'A' });
        } else {
          // Balanced load: no neutral current.
          const value = phase === 'N' ? 0 : perPhase(amps * phases, phase);
          push(measurand, value.toFixed(2), { phase, unit: 'A' });
        }
        break;
      }
      case 'Current.Offered':
        push(measurand, (snapshot.offeredW / (snapshot.voltage * phases)).toFixed(2), {
          unit: 'A',
        });
        break;
      case 'Voltage': {
        if (phase === undefined) {
          for (const p of wired) {
            push(measurand, snapshot.voltage.toFixed(1), { phase: `${p}-N` as Phase, unit: 'V' });
          }
          break;
        }
        const pair = LINE_TO_LINE[phase];
        const reading = pair
          ? pair.every((index) => index <= phases)
            ? snapshot.voltage * Math.sqrt(3)
            : 0
          : (phaseIndex(phase) ?? 1) <= phases
            ? snapshot.voltage
            : 0;
        push(measurand, reading.toFixed(1), { phase, unit: 'V' });
        break;
      }
      case 'Frequency':
        // UnitOfMeasure has no hertz in OCPP 1.6; the unit is left out.
        push(measurand, snapshot.frequencyHz.toFixed(2));
        break;
      case 'Temperature':
        push(measurand, snapshot.temperatureC.toFixed(1), { location: 'Body', unit: 'Celsius' });
        break;
      case 'SoC':
        if (snapshot.soc !== undefined) {
          push(measurand, String(Math.round(snapshot.soc * 100)), {
            location: 'EV',
            unit: 'Percent',
          });
        }
        break;
      default:
        break;
    }
  }
  return values;
}

/**
 * The MeterValue entries for one clock-aligned boundary. Per-period values (`Energy.*.Interval`,
 * the energy of the interval that just ended) bear the interval start time, as the definition of
 * `ClockAlignedDataInterval` asks; instantaneous values (registers, power, current, ...) are
 * read at the boundary and bear that time.
 */
export function alignedMeterValues(
  items: readonly MeasurandItem[],
  snapshot: MeterSnapshot,
  boundary: Date,
  intervalStart: Date,
  intervalWh: number,
): MeterValue[] {
  const perPeriod = items.filter((item) => isIntervalMeasurand(item.measurand));
  const instant = items.filter((item) => !isIntervalMeasurand(item.measurand));
  const entries: MeterValue[] = [];
  const periodValues = sampleValues(perPeriod, snapshot, 'Sample.Clock', intervalWh);
  if (periodValues.length > 0) {
    entries.push({ timestamp: intervalStart.toISOString(), sampledValue: periodValues });
  }
  const instantValues = sampleValues(instant, snapshot, 'Sample.Clock');
  if (instantValues.length > 0) {
    entries.push({ timestamp: boundary.toISOString(), sampledValue: instantValues });
  }
  return entries;
}

const DAY_MS = 86_400_000;

/**
 * The first clock-aligned instant strictly after `after`. `ClockAlignedDataInterval` divides each
 * day into intervals starting at midnight; the simulator uses midnight UTC, and an interval that
 * does not divide the day evenly is cut short at the next midnight.
 */
export function nextAlignedTime(after: Date, intervalS: number): Date {
  const time = after.getTime();
  const dayStart = time - (((time % DAY_MS) + DAY_MS) % DAY_MS);
  const intervalMs = intervalS * 1_000;
  const candidate = dayStart + (Math.floor((time - dayStart) / intervalMs) + 1) * intervalMs;
  return new Date(Math.min(candidate, dayStart + DAY_MS));
}

/** The latest clock-aligned instant at or before `at` (see {@link nextAlignedTime}). */
export function previousAlignedTime(at: Date, intervalS: number): Date {
  const time = at.getTime();
  const dayStart = time - (((time % DAY_MS) + DAY_MS) % DAY_MS);
  const intervalMs = intervalS * 1_000;
  return new Date(dayStart + Math.floor((time - dayStart) / intervalMs) * intervalMs);
}

/**
 * Collects the `transactionData` of a StopTransaction: the Transaction.Begin reading, the
 * periodic and clock-aligned readings taken during the transaction, and the Transaction.End
 * reading.
 *
 * A long session sampled often would otherwise produce a StopTransaction too large for many
 * Central Systems (a day at 10-second sampling is 8 640 entries). When `maxEntries` would be
 * exceeded, every other intermediate reading is dropped, so the data keeps covering the whole
 * session at a coarser resolution; Begin and End are always kept.
 */
export class TransactionDataBuffer {
  readonly #maxEntries: number;
  #begin: MeterValue | undefined;
  #readings: MeterValue[] = [];
  #decimations = 0;

  constructor(maxEntries = 1_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 3) {
      throw new RangeError('maxEntries must be an integer >= 3');
    }
    this.#maxEntries = maxEntries;
  }

  /** How often the intermediate readings were thinned out. */
  get decimations(): number {
    return this.#decimations;
  }

  /** Record the Transaction.Begin reading. */
  begin(meterValue: MeterValue): void {
    this.#begin = meterValue;
  }

  /** Record an intermediate (periodic or clock-aligned) reading. */
  add(meterValue: MeterValue): void {
    if (this.#readings.length >= this.#maxEntries - 2) {
      this.#readings = this.#readings.filter((_, index) => index % 2 === 0);
      this.#decimations++;
    }
    this.#readings.push(meterValue);
  }

  /** The transactionData array, ending with `end` when given. */
  toArray(end?: MeterValue): MeterValue[] {
    return [...(this.#begin ? [this.#begin] : []), ...this.#readings, ...(end ? [end] : [])];
  }
}
