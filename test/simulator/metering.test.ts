import { describe, expect, it } from 'vitest';
import {
  alignedMeterValues,
  formatMeasurandList,
  nextAlignedTime,
  parseMeasurandItem,
  parseMeasurandList,
  previousAlignedTime,
  sampleValues,
  SUPPORTED_MEASURANDS,
  TransactionDataBuffer,
  type MeterSnapshot,
  type MeterValue,
} from '../../src/index.js';

const snapshot: MeterSnapshot = {
  energyWh: 12_345.6,
  powerW: 11_040,
  offeredW: 22_080,
  voltage: 230,
  phases: 3,
  soc: 0.456,
  temperatureC: 31.25,
  frequencyHz: 50,
};

describe('measurand lists', () => {
  it('parses measurands, optionally with a phase, ignoring case', () => {
    expect(parseMeasurandItem('Energy.Active.Import.Register')).toEqual({
      measurand: 'Energy.Active.Import.Register',
    });
    expect(parseMeasurandItem('current.import.l2')).toEqual({
      measurand: 'Current.Import',
      phase: 'L2',
    });
    expect(parseMeasurandItem(' Voltage.L1-N ')).toEqual({ measurand: 'Voltage', phase: 'L1-N' });
  });

  it('rejects unknown, unsupported and wrongly qualified items', () => {
    expect(parseMeasurandItem('Banana')).toBeUndefined();
    expect(parseMeasurandItem('RPM')).toBeUndefined();
    expect(parseMeasurandItem('SoC.L1')).toBeUndefined();
    expect(parseMeasurandItem('Voltage.N')).toBeUndefined();
    expect(parseMeasurandItem('Current.Import.L4')).toBeUndefined();
    expect(SUPPORTED_MEASURANDS).not.toContain('RPM');
    expect(SUPPORTED_MEASURANDS).toHaveLength(21);
  });

  it('parses and formats whole lists canonically', () => {
    expect(parseMeasurandList('')).toEqual([]);
    const items = parseMeasurandList('power.active.import, SoC,Current.Import.L3');
    expect(items && formatMeasurandList(items)).toBe('Power.Active.Import,SoC,Current.Import.L3');
    expect(parseMeasurandList('SoC,Banana')).toBeUndefined();
  });
});

describe('sampleValues', () => {
  const values = (list: string, intervalWh?: number) =>
    sampleValues(parseMeasurandList(list) ?? [], snapshot, 'Sample.Periodic', intervalWh);

  it('reports energy registers in Wh at the outlet', () => {
    expect(values('Energy.Active.Import.Register')).toEqual([
      {
        value: '12346',
        context: 'Sample.Periodic',
        measurand: 'Energy.Active.Import.Register',
        location: 'Outlet',
        unit: 'Wh',
      },
    ]);
    expect(values('Energy.Active.Import.Register.L2')[0]).toMatchObject({
      value: '4115',
      phase: 'L2',
    });
  });

  it('reports Energy.*.Interval only when the interval energy is known', () => {
    expect(values('Energy.Active.Import.Interval')).toEqual([]);
    expect(values('Energy.Active.Import.Interval', 183.4)[0]).toMatchObject({
      value: '183',
      unit: 'Wh',
    });
  });

  it('reports power as a total and current and voltage per wired phase', () => {
    expect(values('Power.Active.Import')[0]).toMatchObject({ value: '11040.0', unit: 'W' });
    expect(values('Power.Active.Import.L1')[0]).toMatchObject({ value: '3680.0', phase: 'L1' });
    expect(values('Current.Import').map((v) => [v.phase, v.value])).toEqual([
      ['L1', '16.00'],
      ['L2', '16.00'],
      ['L3', '16.00'],
    ]);
    expect(values('Current.Import.N')[0]).toMatchObject({ value: '0.00', phase: 'N' });
    expect(values('Voltage').map((v) => v.phase)).toEqual(['L1-N', 'L2-N', 'L3-N']);
    expect(values('Voltage.L1-L2')[0]?.value).toBe((230 * Math.sqrt(3)).toFixed(1));
    expect(values('Current.Offered')[0]).toMatchObject({ value: '32.00', unit: 'A' });
    expect(values('Power.Offered')[0]).toMatchObject({ value: '22080.0', unit: 'W' });
  });

  it('reads 0 on phases a single-phase charger does not have', () => {
    const single = { ...snapshot, phases: 1, powerW: 3_680 };
    const items = parseMeasurandList('Current.Import,Current.Import.L2,Voltage.L2-L3') ?? [];
    expect(sampleValues(items, single, 'Trigger').map((v) => [v.phase, v.value])).toEqual([
      ['L1', '16.00'],
      ['L2', '0.00'],
      ['L2-L3', '0.0'],
    ]);
  });

  it('reports SoC only with an EV, and the other supported measurands', () => {
    expect(values('SoC')[0]).toMatchObject({ value: '46', unit: 'Percent', location: 'EV' });
    expect(
      sampleValues(parseMeasurandList('SoC') ?? [], { ...snapshot, soc: undefined }, 'Trigger'),
    ).toEqual([]);
    expect(values('Temperature')[0]).toMatchObject({
      value: '31.3',
      unit: 'Celsius',
      location: 'Body',
    });
    expect(values('Frequency')[0]).toEqual({
      value: '50.00',
      context: 'Sample.Periodic',
      measurand: 'Frequency',
    });
    expect(values('Power.Factor')[0]?.value).toBe('1.00');
    expect(values('Energy.Active.Export.Register')[0]).toMatchObject({ value: '0', unit: 'Wh' });
    expect(values('Energy.Reactive.Import.Register')[0]).toMatchObject({
      value: '0',
      unit: 'varh',
    });
  });
});

describe('clock alignment', () => {
  const at = (iso: string) => new Date(iso);

  it('finds the next boundary of evenly spaced intervals starting at midnight UTC', () => {
    expect(nextAlignedTime(at('2026-05-01T12:07:30Z'), 900).toISOString()).toBe(
      '2026-05-01T12:15:00.000Z',
    );
    expect(nextAlignedTime(at('2026-05-01T12:15:00Z'), 900).toISOString()).toBe(
      '2026-05-01T12:30:00.000Z',
    );
    expect(previousAlignedTime(at('2026-05-01T12:07:30Z'), 900).toISOString()).toBe(
      '2026-05-01T12:00:00.000Z',
    );
  });

  it('restarts the intervals at midnight when they do not divide the day', () => {
    // 7-hour intervals: 00:00, 07:00, 14:00, 21:00, then the next midnight.
    expect(nextAlignedTime(at('2026-05-01T22:00:00Z'), 7 * 3_600).toISOString()).toBe(
      '2026-05-02T00:00:00.000Z',
    );
    expect(nextAlignedTime(at('2026-05-02T00:00:00Z'), 7 * 3_600).toISOString()).toBe(
      '2026-05-02T07:00:00.000Z',
    );
  });

  it('stamps per-period values with the interval start and readings with the boundary', () => {
    const items = parseMeasurandList('Energy.Active.Import.Interval,Energy.Active.Import.Register');
    const entries: MeterValue[] = alignedMeterValues(
      items ?? [],
      snapshot,
      at('2026-05-01T12:15:00Z'),
      at('2026-05-01T12:00:00Z'),
      2_760,
    );
    expect(entries).toEqual([
      {
        timestamp: '2026-05-01T12:00:00.000Z',
        sampledValue: [expect.objectContaining({ value: '2760', context: 'Sample.Clock' })],
      },
      {
        timestamp: '2026-05-01T12:15:00.000Z',
        sampledValue: [expect.objectContaining({ value: '12346', context: 'Sample.Clock' })],
      },
    ]);
  });
});

describe('TransactionDataBuffer', () => {
  const reading = (n: number): MeterValue => ({
    timestamp: `2026-05-01T12:00:${String(n).padStart(2, '0')}Z`,
    sampledValue: [{ value: String(n) }],
  });

  it('keeps Begin, the readings and End in order', () => {
    const buffer = new TransactionDataBuffer();
    buffer.begin(reading(0));
    buffer.add(reading(1));
    buffer.add(reading(2));
    expect(buffer.toArray(reading(3)).map((mv) => mv.sampledValue[0]?.value)).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    expect(new TransactionDataBuffer().toArray()).toEqual([]);
  });

  it('thins out intermediate readings instead of growing without bound', () => {
    const buffer = new TransactionDataBuffer(10);
    buffer.begin(reading(0));
    for (let n = 1; n <= 40; n++) buffer.add(reading(n));
    const all = buffer.toArray(reading(59));
    expect(all.length).toBeLessThanOrEqual(10);
    expect(all[0]?.sampledValue[0]?.value).toBe('0');
    expect(all.at(-1)?.sampledValue[0]?.value).toBe('59');
    expect(buffer.decimations).toBeGreaterThan(0);
    // Still chronological and spread over the whole session.
    const values = all.map((mv) => Number(mv.sampledValue[0]?.value));
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(values[1]).toBeLessThan(10);
    expect(() => new TransactionDataBuffer(2)).toThrow(RangeError);
  });
});
