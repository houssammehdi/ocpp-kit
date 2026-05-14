import { describe, expect, it } from 'vitest';
import {
  parseDuration,
  parseInteger,
  parseRangeSeconds,
  parseRate,
  parseUrl,
  UsageError,
} from '../../src/cli/args.js';
import { fit, formatClock, renderTable } from '../../src/cli/format.js';
import { formatStats } from '../../src/cli/sim.js';

describe('CLI argument parsing', () => {
  it.each([
    ['250ms', 250],
    ['30s', 30_000],
    ['1.5s', 1_500],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['45', 45_000],
    [' 10S ', 10_000],
  ])('parses duration %s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['', 'soon', '5d', '-1s', '1m30s'])('rejects duration %j', (input) => {
    expect(() => parseDuration(input)).toThrow(UsageError);
  });

  it.each([
    ['5/s', 5],
    ['5', 5],
    ['120/m', 2],
    ['120/min', 2],
    ['3600/h', 1],
    ['0.5/s', 0.5],
  ])('parses rate %s', (input, perSecond) => {
    expect(parseRate(input)).toBe(perSecond);
  });

  it.each(['0/s', 'fast', '5/d', '/s'])('rejects rate %j', (input) => {
    expect(() => parseRate(input)).toThrow(UsageError);
  });

  it('parses ranges, integers and URLs', () => {
    expect(parseRangeSeconds('30-300')).toEqual([30, 300]);
    expect(parseRangeSeconds('30s-5m')).toEqual([30, 300]);
    expect(() => parseRangeSeconds('5m-30s')).toThrow(/min > max/);
    expect(() => parseRangeSeconds('30')).toThrow(UsageError);
    expect(parseInteger('50', 'count')).toBe(50);
    expect(parseInteger('0', 'seed', 0)).toBe(0);
    expect(() => parseInteger('0', 'count')).toThrow(/at least 1/);
    expect(() => parseInteger('1.5', 'count')).toThrow(/integer/);
    expect(parseUrl('ws://localhost:9220/ocpp')).toBe('ws://localhost:9220/ocpp');
    expect(parseUrl('wss://csms.example.com')).toBe('wss://csms.example.com');
    expect(() => parseUrl('http://localhost')).toThrow(/ws:\/\//);
    expect(() => parseUrl('not a url')).toThrow(UsageError);
  });
});

describe('CLI formatting', () => {
  it('formats clocks and fits text', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(3_723_000)).toBe('01:02:03');
    expect(fit('abc', 5)).toBe('abc  ');
    expect(fit('abcdef', 4)).toBe('abc~');
  });

  it('renders fixed-width tables with overflow summary', () => {
    const table = renderTable(
      [
        { header: 'ID', width: 4, value: (row: { id: string; n: number }) => row.id },
        { header: 'N', width: 3, align: 'right', value: (row) => String(row.n) },
      ],
      [
        { id: 'A', n: 1 },
        { id: 'LONGER', n: 22 },
        { id: 'C', n: 3 },
      ],
      2,
    );
    expect(table.split('\n')).toEqual([
      'ID      N',
      '----  ---',
      'A       1',
      'LON~   22',
      '... 1 more',
    ]);
  });

  it('summarises fleet statistics on one line', () => {
    const line = formatStats(
      {
        chargers: 50,
        started: 50,
        connected: 49,
        registered: 48,
        activeTransactions: 20,
        sessionsStarted: 25,
        sessionsCompleted: 5,
        energyKWh: 12.345,
        powerKW: 220,
        callsSent: 1_000,
        callErrors: 2,
        connectorStatuses: {},
        latency: { count: 10, p50: 1.23, p95: 4.5, p99: 9, max: 12 },
      },
      65_000,
    );
    expect(line).toBe(
      't=00:01:05 started 50/50 online 49 booted 48 | tx 20 (done 5) | 220.0 kW 12.3 kWh | calls 1000 err 2 | rtt p50 1.2 p95 4.5 p99 9.0 ms',
    );
  });
});
