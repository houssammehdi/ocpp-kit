import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram, MetricsRegistry } from '../../src/index.js';

describe('MetricsRegistry', () => {
  it('renders counters, gauges and histograms in the Prometheus text format', () => {
    const registry = new MetricsRegistry();
    const calls = registry.counter('calls_total', 'Calls answered', ['action', 'result']);
    const open = registry.gauge('open_connections', 'Open connections');
    const latency = registry.histogram('latency_seconds', 'Latency', ['action'], [0.1, 1, 0.5]);
    calls.inc({ action: 'Heartbeat', result: 'ok' });
    calls.inc({ action: 'Heartbeat', result: 'ok' }, 2);
    calls.inc({ action: 'Authorize', result: 'NotSupported' });
    open.set(3);
    open.dec();
    latency.observe({ action: 'Heartbeat' }, 0.05);
    latency.observe({ action: 'Heartbeat' }, 0.5);
    latency.observe({ action: 'Heartbeat' }, 7);
    expect(registry.render()).toBe(
      [
        '# HELP calls_total Calls answered',
        '# TYPE calls_total counter',
        'calls_total{action="Heartbeat",result="ok"} 3',
        'calls_total{action="Authorize",result="NotSupported"} 1',
        '# HELP open_connections Open connections',
        '# TYPE open_connections gauge',
        'open_connections 2',
        '# HELP latency_seconds Latency',
        '# TYPE latency_seconds histogram',
        'latency_seconds_bucket{action="Heartbeat",le="0.1"} 1',
        'latency_seconds_bucket{action="Heartbeat",le="0.5"} 2',
        'latency_seconds_bucket{action="Heartbeat",le="1"} 2',
        'latency_seconds_bucket{action="Heartbeat",le="+Inf"} 3',
        'latency_seconds_sum{action="Heartbeat"} 7.55',
        'latency_seconds_count{action="Heartbeat"} 3',
        '',
      ].join('\n'),
    );
    expect(latency.get({ action: 'Heartbeat' })).toEqual({
      count: 3,
      sum: 7.55,
      buckets: [1, 2, 2],
    });
  });

  it('escapes label values and help text', () => {
    const registry = new MetricsRegistry();
    registry
      .counter('odd_total', 'Help with \\ and\na newline', ['value'])
      .inc({ value: 'quote " backslash \\ newline \n end' });
    expect(registry.render()).toBe(
      [
        '# HELP odd_total Help with \\\\ and\\na newline',
        '# TYPE odd_total counter',
        'odd_total{value="quote \\" backslash \\\\ newline \\n end"} 1',
        '',
      ].join('\n'),
    );
  });

  it('returns the existing metric for a repeated name and refuses conflicts', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('x_total', 'X');
    expect(registry.counter('x_total', 'X')).toBe(counter);
    expect(registry.get('x_total')).toBe(counter);
    expect(() => registry.gauge('x_total', 'X')).toThrow(/already registered as a counter/);
  });

  it('validates names, labels and values', () => {
    expect(() => new Counter('bad name', 'x')).toThrow(/Invalid metric name/);
    expect(() => new Counter('ok_total', 'x', ['le'])).toThrow(/Invalid label name/);
    expect(() => new Counter('ok_total', 'x', ['__reserved'])).toThrow(/Invalid label name/);
    const counter = new Counter('ok_total', 'x', ['a']);
    expect(() => counter.inc({ b: '1' })).toThrow(/Unknown label\(s\) b/);
    expect(() => counter.inc(-1)).toThrow(/cannot decrease/);
    expect(() => new Histogram('h', 'x', [], [1, 1])).toThrow(/distinct, finite/);
    expect(() => new Histogram('h', 'x', [], [])).toThrow(/distinct, finite/);
    const gauge = new Gauge('g', 'x');
    gauge.set(Infinity);
    expect(gauge.render()).toContain('g +Inf');
    gauge.set(Number.NaN);
    expect(gauge.render()).toContain('g NaN');
    gauge.reset();
    expect(gauge.render()).toBe('# HELP g x\n# TYPE g gauge');
  });
});
