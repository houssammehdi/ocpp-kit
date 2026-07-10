/**
 * ocpp-kit benchmarks: frame parsing and serialisation, RPC round trips in memory and over a
 * loopback WebSocket, and a fleet load test. Everything runs in one Node.js process, so the
 * WebSocket and fleet numbers include the work of both ends.
 *
 *   npm run bench                     # full run, prints a Markdown table
 *   npm run bench -- --quick          # small counts, to check that everything runs
 *   npm run bench -- --only fleet     # one group: frames, rpc, ws or fleet
 *   npm run bench -- --json           # machine-readable results
 *
 * Timings depend on the machine and on what else runs on it; the load average is printed before
 * and after every benchmark. Each benchmark is repeated and the median repetition is reported.
 */
import { cpus, loadavg } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import {
  CentralSystem,
  CentralSystemToChargePoint,
  ChargePoint,
  ChargePointToCentralSystem,
  createDuplexPair,
  LatencyTracker,
  parseFrame,
  RpcPeer,
  serializeFrame,
  type ChargePointRequest,
  type Frame,
} from '../src/index.js';

const { values } = parseArgs({
  options: {
    quick: { type: 'boolean', default: false },
    only: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
const QUICK = values.quick;

interface Row {
  readonly group: string;
  readonly name: string;
  readonly result: string;
  /** Median repetition, for --json. */
  readonly metrics: Readonly<Record<string, number>>;
  readonly load: string;
}
const rows: Row[] = [];

const load = (): string =>
  loadavg()
    .map((value) => value.toFixed(2))
    .join(' ');

function median<T>(items: readonly T[], key: (item: T) => number): T {
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  const middle = sorted[Math.floor((sorted.length - 1) / 2)];
  if (middle === undefined) throw new Error('no repetitions');
  return middle;
}

const fmt = (value: number, digits = 0): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });

function report(
  group: string,
  name: string,
  result: string,
  metrics: Record<string, number>,
  before: string,
): void {
  const row = { group, name, result, metrics, load: `${before} -> ${load()}` };
  rows.push(row);
  if (!values.json) process.stderr.write(`${group} / ${name}: ${result} (load ${row.load})\n`);
}

// ---------------------------------------------------------------------------------------------
// Frames

const meterValues: ChargePointRequest<'MeterValues'> = {
  connectorId: 1,
  transactionId: 4711,
  meterValue: [
    {
      timestamp: '2026-09-25T12:00:00.000Z',
      sampledValue: [
        {
          value: '12345.6',
          context: 'Sample.Periodic',
          measurand: 'Energy.Active.Import.Register',
          location: 'Outlet',
          unit: 'Wh',
        },
        { value: '7360', context: 'Sample.Periodic', measurand: 'Power.Active.Import', unit: 'W' },
        {
          value: '32.0',
          context: 'Sample.Periodic',
          measurand: 'Current.Import',
          phase: 'L1',
          unit: 'A',
        },
        {
          value: '230.1',
          context: 'Sample.Periodic',
          measurand: 'Voltage',
          phase: 'L1-N',
          unit: 'V',
        },
        {
          value: '57',
          context: 'Sample.Periodic',
          measurand: 'SoC',
          location: 'EV',
          unit: 'Percent',
        },
      ],
    },
  ],
};
const meterValuesCall: Frame = {
  type: 2,
  messageId: '5f3d4c2a-9b1e-4f7a-8c6d-2e1f0a9b8c7d',
  action: 'MeterValues',
  payload: meterValues,
};
const heartbeatResult: Frame = {
  type: 3,
  messageId: '5f3d4c2a-9b1e-4f7a-8c6d-2e1f0a9b8c7d',
  payload: { currentTime: '2026-09-25T12:00:00.000Z' },
};

function opsPerSecond(iterations: number, fn: () => number): number {
  let sink = 0;
  for (let i = 0; i < iterations / 10; i++) sink += fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) sink += fn();
  const elapsed = performance.now() - start;
  // Keep the results alive so nothing is optimised away.
  if (sink === -1) process.stderr.write('');
  return iterations / (elapsed / 1_000);
}

function benchFrames(): void {
  const iterations = QUICK ? 5_000 : 200_000;
  const repetitions = QUICK ? 1 : 5;
  const meterValuesRaw = serializeFrame(meterValuesCall);
  const heartbeatRaw = serializeFrame(heartbeatResult);
  const cases: [string, () => number][] = [
    [
      `parseFrame, MeterValues CALL (${meterValuesRaw.length} bytes)`,
      () => (parseFrame(meterValuesRaw).ok ? 1 : 0),
    ],
    [
      `parseFrame, Heartbeat CALLRESULT (${heartbeatRaw.length} bytes)`,
      () => (parseFrame(heartbeatRaw).ok ? 1 : 0),
    ],
    ['serializeFrame, MeterValues CALL', () => serializeFrame(meterValuesCall).length],
  ];
  for (const [name, fn] of cases) {
    const before = load();
    const runs = Array.from({ length: repetitions }, () => opsPerSecond(iterations, fn));
    const ops = median(runs, (value) => value);
    report('frames', name, `${fmt(ops)} ops/s`, { opsPerSecond: ops }, before);
  }
}

// ---------------------------------------------------------------------------------------------
// RPC round trips

interface RoundTrips {
  readonly callsPerSecond: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

async function sequentialCalls(count: number, call: () => Promise<unknown>): Promise<RoundTrips> {
  const tracker = new LatencyTracker(count);
  for (let i = 0; i < Math.min(500, count / 10); i++) await call();
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const sent = performance.now();
    await call();
    tracker.record(performance.now() - sent);
  }
  const elapsed = performance.now() - start;
  const { p50, p95, p99 } = tracker.summary();
  return { callsPerSecond: count / (elapsed / 1_000), p50, p95, p99 };
}

function describeRoundTrips(result: RoundTrips): string {
  return `${fmt(result.callsPerSecond)} calls/s, p50 ${fmt(result.p50, 3)} ms, p95 ${fmt(result.p95, 3)} ms, p99 ${fmt(result.p99, 3)} ms`;
}

async function benchRpcMemory(): Promise<void> {
  const count = QUICK ? 1_000 : 20_000;
  const repetitions = QUICK ? 1 : 3;
  for (const [name, call] of [
    [
      'Heartbeat',
      (cp: RpcPeer<typeof CentralSystemToChargePoint, typeof ChargePointToCentralSystem>) =>
        cp.call('Heartbeat', {}),
    ],
    [
      'MeterValues (5 samples)',
      (cp: RpcPeer<typeof CentralSystemToChargePoint, typeof ChargePointToCentralSystem>) =>
        cp.call('MeterValues', meterValues),
    ],
  ] as const) {
    const before = load();
    const runs: RoundTrips[] = [];
    for (let r = 0; r < repetitions; r++) {
      const [a, b] = createDuplexPair();
      const cp = new RpcPeer(a, {
        inbound: CentralSystemToChargePoint,
        outbound: ChargePointToCentralSystem,
      });
      const cs = new RpcPeer(b, {
        inbound: ChargePointToCentralSystem,
        outbound: CentralSystemToChargePoint,
      });
      cs.handle('Heartbeat', () => ({ currentTime: '2026-09-25T12:00:00.000Z' }));
      cs.handle('MeterValues', () => ({}));
      runs.push(await sequentialCalls(count, () => call(cp)));
      await cp.close();
    }
    const result = median(runs, (run) => run.callsPerSecond);
    report(
      'rpc',
      `in memory, sequential ${name}, validation on`,
      describeRoundTrips(result),
      { ...result },
      before,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// WebSocket

async function server(): Promise<{ cs: CentralSystem; url: string }> {
  const cs = new CentralSystem({ pingIntervalMs: 0 });
  cs.handle('BootNotification', () => ({
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: 3_600,
  }));
  cs.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
  cs.handle('MeterValues', () => ({}));
  const { port } = await cs.listen(0, '127.0.0.1');
  return { cs, url: `ws://127.0.0.1:${port}` };
}

async function bootedClient(url: string, identity: string): Promise<ChargePoint> {
  const cp = new ChargePoint({ identity, url, reconnect: false });
  await cp.connect();
  await cp.call('BootNotification', { chargePointVendor: 'ocpp-kit', chargePointModel: 'bench' });
  return cp;
}

async function benchWebSocket(): Promise<void> {
  const repetitions = QUICK ? 1 : 3;
  {
    const count = QUICK ? 500 : 5_000;
    const before = load();
    const runs: RoundTrips[] = [];
    for (let r = 0; r < repetitions; r++) {
      const { cs, url } = await server();
      const cp = await bootedClient(url, 'BENCH-1');
      runs.push(await sequentialCalls(count, () => cp.call('Heartbeat', {})));
      await cp.close();
      await cs.close();
    }
    const result = median(runs, (run) => run.callsPerSecond);
    report(
      'ws',
      'loopback, 1 client, sequential Heartbeat',
      describeRoundTrips(result),
      { ...result },
      before,
    );
  }
  {
    const clients = QUICK ? 10 : 50;
    const perClient = QUICK ? 50 : 400;
    const before = load();
    const runs: RoundTrips[] = [];
    for (let r = 0; r < repetitions; r++) {
      const { cs, url } = await server();
      const cps = await Promise.all(
        Array.from({ length: clients }, (_, i) => bootedClient(url, `BENCH-${i}`)),
      );
      const tracker = new LatencyTracker(clients * perClient);
      const start = performance.now();
      await Promise.all(
        cps.map(async (cp) => {
          for (let i = 0; i < perClient; i++) {
            const sent = performance.now();
            await cp.call('Heartbeat', {});
            tracker.record(performance.now() - sent);
          }
        }),
      );
      const elapsed = performance.now() - start;
      const { p50, p95, p99 } = tracker.summary();
      runs.push({ callsPerSecond: (clients * perClient) / (elapsed / 1_000), p50, p95, p99 });
      await Promise.all(cps.map((cp) => cp.close()));
      await cs.close();
    }
    const result = median(runs, (run) => run.callsPerSecond);
    report(
      'ws',
      `loopback, ${clients} clients, each sequential Heartbeat`,
      describeRoundTrips(result),
      { ...result },
      before,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Fleet

async function fleetRun(chargers: number, ratePerCharger: number, seconds: number) {
  const { cs, url } = await server();
  const cps: ChargePoint[] = [];
  for (let i = 0; i < chargers; i += 50) {
    cps.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(50, chargers - i) }, (_, j) =>
          bootedClient(url, `FLEET-${i + j}`),
        ),
      )),
    );
  }
  const tracker = new LatencyTracker(Math.ceil(chargers * ratePerCharger * seconds * 1.2));
  let answered = 0;
  let failed = 0;
  for (const cp of cps) {
    cp.on('dropped', () => failed++);
    cp.on('callCompleted', (event) => {
      if (event.error) failed++;
      else {
        answered++;
        tracker.record(event.durationMs);
      }
    });
  }
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  const interval = 1_000 / ratePerCharger;
  const timers = cps.map((cp, i) => {
    let timer: NodeJS.Timeout | undefined;
    const send = (): void => {
      void cp.call('MeterValues', meterValues).catch(() => undefined);
    };
    // Spread the chargers evenly over one interval so they do not send in lockstep.
    const first = setTimeout(
      () => {
        send();
        timer = setInterval(send, interval);
      },
      (interval * i) / chargers,
    );
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  for (const stop of timers) stop();
  const elapsed = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  lag.disable();
  // Let the last answers arrive before closing.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await Promise.all(cps.map((cp) => cp.close()));
  await cs.close();
  const { p50, p95, p99, max } = tracker.summary();
  return {
    offered: chargers * ratePerCharger,
    achieved: answered / (elapsed / 1_000),
    failed,
    p50,
    p95,
    p99,
    max,
    cpuPercent: ((cpu.user + cpu.system) / 1_000 / elapsed) * 100,
    lagP99: lag.percentile(99) / 1e6,
  };
}

async function benchFleet(): Promise<void> {
  const scenarios: [number, number, number][] = QUICK
    ? [[20, 2, 2]]
    : [
        [500, 2, 20],
        [1_000, 2, 20],
        [2_000, 2, 20],
      ];
  const repetitions = QUICK ? 1 : 3;
  for (const [chargers, rate, seconds] of scenarios) {
    const before = load();
    const runs = [];
    for (let r = 0; r < repetitions; r++) runs.push(await fleetRun(chargers, rate, seconds));
    const result = median(runs, (run) => run.p95);
    report(
      'fleet',
      `${fmt(chargers)} charge points x ${rate} MeterValues/s for ${seconds} s`,
      `${fmt(result.achieved)} of ${fmt(result.offered)} msg/s answered, ${result.failed} failed, RTT p50 ${fmt(result.p50, 2)} ms, p95 ${fmt(result.p95, 2)} ms, p99 ${fmt(result.p99, 2)} ms, CPU ${fmt(result.cpuPercent)} % of one core, event-loop lag p99 ${fmt(result.lagP99, 1)} ms`,
      { ...result },
      before,
    );
  }
}

// ---------------------------------------------------------------------------------------------

const groups: Record<string, () => void | Promise<void>> = {
  frames: benchFrames,
  rpc: benchRpcMemory,
  ws: benchWebSocket,
  fleet: benchFleet,
};
if (values.only !== undefined && !(values.only in groups)) {
  throw new Error(`--only must be one of ${Object.keys(groups).join(', ')}`);
}
const environment = {
  node: process.version,
  cpu: `${cpus().length} x ${cpus()[0]?.model ?? 'unknown CPU'}`,
  loadBefore: load(),
  quick: QUICK,
};
for (const [name, run] of Object.entries(groups)) {
  if (values.only === undefined || values.only === name) await run();
}
if (values.json) {
  process.stdout.write(
    `${JSON.stringify({ environment: { ...environment, loadAfter: load() }, results: rows }, null, 2)}\n`,
  );
} else {
  process.stdout.write(
    [
      `Node ${environment.node}, ${environment.cpu}, load average ${environment.loadBefore} before, ${load()} after${QUICK ? ' (quick run: numbers are not meaningful)' : ''}`,
      '',
      '| Group | Benchmark | Result (median repetition) |',
      '| --- | --- | --- |',
      ...rows.map((row) => `| ${row.group} | ${row.name} | ${row.result} |`),
      '',
    ].join('\n'),
  );
}
