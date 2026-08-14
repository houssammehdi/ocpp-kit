/**
 * ocpp-kit benchmarks: frame parsing, serialisation and validation (OCPP 1.6 and 2.0.1), RPC
 * round trips in memory and over a loopback WebSocket, an OCPP 1.6 fleet load test and a mixed
 * 1.6/2.0.1 fleet load test. Everything runs in one Node.js process, so the WebSocket and fleet
 * numbers include the work of both ends.
 *
 *   npm run bench                     # full run, prints a Markdown table
 *   npm run bench -- --quick          # small counts, to check that everything runs
 *   npm run bench -- --only fleet     # one group: frames, rpc, ws, fleet or mixed
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
  ChargingStation,
  ChargingStationToCsms,
  createDuplexPair,
  CsmsToChargingStation,
  LatencyTracker,
  OCPP201_ERROR_CODES,
  parseFrame,
  RpcPeer,
  serializeFrame,
  validatePayload,
  type ChargePointRequest,
  type Frame,
  type OcppSubprotocol,
  type StationRequest,
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
/** The OCPP 2.0.1 counterpart of `meterValues`: a periodic TransactionEvent update. */
const transactionEvent: StationRequest<'TransactionEvent'> = {
  eventType: 'Updated',
  timestamp: '2026-09-25T12:00:00.000Z',
  triggerReason: 'MeterValuePeriodic',
  seqNo: 7,
  transactionInfo: {
    transactionId: '0b6f8a52-3c1d-4e7f-9a2b-6c5d4e3f2a1b',
    chargingState: 'Charging',
  },
  evse: { id: 1, connectorId: 1 },
  meterValue: [
    {
      timestamp: '2026-09-25T12:00:00.000Z',
      sampledValue: [
        {
          value: 12345.6,
          context: 'Sample.Periodic',
          measurand: 'Energy.Active.Import.Register',
          location: 'Outlet',
          unitOfMeasure: { unit: 'Wh' },
        },
        {
          value: 7360,
          context: 'Sample.Periodic',
          measurand: 'Power.Active.Import',
          unitOfMeasure: { unit: 'W' },
        },
        {
          value: 32,
          context: 'Sample.Periodic',
          measurand: 'Current.Import',
          phase: 'L1',
          unitOfMeasure: { unit: 'A' },
        },
        {
          value: 230.1,
          context: 'Sample.Periodic',
          measurand: 'Voltage',
          phase: 'L1-N',
          unitOfMeasure: { unit: 'V' },
        },
        {
          value: 57,
          context: 'Sample.Periodic',
          measurand: 'SoC',
          location: 'EV',
          unitOfMeasure: { unit: 'Percent' },
        },
      ],
    },
  ],
};
const transactionEventCall: Frame = {
  type: 2,
  messageId: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  action: 'TransactionEvent',
  payload: transactionEvent,
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
  const transactionEventRaw = serializeFrame(transactionEventCall);
  const meterValuesSchema = ChargePointToCentralSystem.MeterValues.request;
  const transactionEventSchema = ChargingStationToCsms.TransactionEvent.request;
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
    [
      'validatePayload, MeterValues request (1.6)',
      () => (validatePayload(meterValuesSchema, meterValues) === undefined ? 1 : 0),
    ],
    [
      `parseFrame, 2.0.1 TransactionEvent CALL (${transactionEventRaw.length} bytes)`,
      () => (parseFrame(transactionEventRaw, OCPP201_ERROR_CODES).ok ? 1 : 0),
    ],
    [
      'serializeFrame, 2.0.1 TransactionEvent CALL',
      () => serializeFrame(transactionEventCall).length,
    ],
    [
      'validatePayload, 2.0.1 TransactionEvent request',
      () =>
        validatePayload(
          transactionEventSchema,
          transactionEvent,
          'Payload',
          OCPP201_ERROR_CODES,
        ) === undefined
          ? 1
          : 0,
    ],
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
  {
    const before = load();
    const runs: RoundTrips[] = [];
    for (let r = 0; r < repetitions; r++) {
      const [a, b] = createDuplexPair();
      const station = new RpcPeer(a, {
        inbound: CsmsToChargingStation,
        outbound: ChargingStationToCsms,
        errorCodes: OCPP201_ERROR_CODES,
      });
      const csms = new RpcPeer(b, {
        inbound: ChargingStationToCsms,
        outbound: CsmsToChargingStation,
        errorCodes: OCPP201_ERROR_CODES,
      });
      csms.handle('TransactionEvent', () => ({}));
      runs.push(
        await sequentialCalls(count, () => station.call('TransactionEvent', transactionEvent)),
      );
      await station.close();
    }
    const result = median(runs, (run) => run.callsPerSecond);
    report(
      'rpc',
      'in memory, sequential 2.0.1 TransactionEvent (5 samples), validation on',
      describeRoundTrips(result),
      { ...result },
      before,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// WebSocket

/** A Central System that accepts OCPP 1.6 and 2.0.1 and answers the messages benchmarked here. */
async function server(): Promise<{ cs: CentralSystem<OcppSubprotocol>; url: string }> {
  const cs = new CentralSystem<OcppSubprotocol>({
    pingIntervalMs: 0,
    protocols: ['ocpp2.0.1', 'ocpp1.6'],
  });
  const boot = () => ({
    status: 'Accepted' as const,
    currentTime: new Date().toISOString(),
    interval: 3_600,
  });
  cs.handle('BootNotification', boot);
  cs.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
  cs.handle('MeterValues', () => ({}));
  cs.v201.handle('BootNotification', boot).handle('TransactionEvent', () => ({}));
  const { port } = await cs.listen(0, '127.0.0.1');
  return { cs, url: `ws://127.0.0.1:${port}` };
}

async function bootedClient(url: string, identity: string): Promise<ChargePoint> {
  const cp = new ChargePoint({ identity, url, reconnect: false });
  await cp.connect();
  await cp.call('BootNotification', { chargePointVendor: 'ocpp-kit', chargePointModel: 'bench' });
  return cp;
}

async function bootedStation(url: string, identity: string): Promise<ChargingStation> {
  const station = new ChargingStation({ identity, url, reconnect: false });
  await station.connect();
  await station.call('BootNotification', {
    chargingStation: { vendorName: 'ocpp-kit', model: 'bench' },
    reason: 'PowerUp',
  });
  return station;
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

/** One client of a fleet run, sending its version's meter-value message. */
interface FleetClient {
  readonly client: ChargePoint | ChargingStation;
  readonly send: () => Promise<unknown>;
}

async function fleetClient(url: string, index: number, v201: boolean): Promise<FleetClient> {
  if (!v201) {
    const cp = await bootedClient(url, `FLEET-${index}`);
    return { client: cp, send: () => cp.call('MeterValues', meterValues) };
  }
  const station = await bootedStation(url, `FLEET-${index}`);
  let seqNo = 0;
  return {
    client: station,
    send: () => station.call('TransactionEvent', { ...transactionEvent, seqNo: seqNo++ }),
  };
}

/**
 * `chargers` clients send meter values at `ratePerCharger` messages per second for `seconds`;
 * every `v201Every`-th client (none when 0) is an OCPP 2.0.1 Charging Station sending
 * TransactionEvent updates, the others are OCPP 1.6 charge points sending MeterValues.
 */
async function fleetRun(chargers: number, ratePerCharger: number, seconds: number, v201Every = 0) {
  const { cs, url } = await server();
  const clients: FleetClient[] = [];
  for (let i = 0; i < chargers; i += 50) {
    clients.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(50, chargers - i) }, (_, j) =>
          fleetClient(url, i + j, v201Every > 0 && (i + j) % v201Every === 0),
        ),
      )),
    );
  }
  const cps = clients.map(({ client }) => client);
  const tracker = new LatencyTracker(Math.ceil(chargers * ratePerCharger * seconds * 1.2));
  let answered = 0;
  let failed = 0;
  for (const cp of cps) {
    cp.on('dropped', () => failed++);
    cp.on('callCompleted', (event: { readonly error?: unknown; readonly durationMs: number }) => {
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
  const timers = clients.map((client, i) => {
    let timer: NodeJS.Timeout | undefined;
    const send = (): void => {
      void client.send().catch(() => undefined);
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

async function benchMixedFleet(): Promise<void> {
  const scenarios: [number, number, number][] = QUICK
    ? [[20, 2, 2]]
    : [
        [1_000, 2, 20],
        [2_000, 2, 20],
      ];
  const repetitions = QUICK ? 1 : 3;
  for (const [chargers, rate, seconds] of scenarios) {
    const before = load();
    const runs = [];
    for (let r = 0; r < repetitions; r++) runs.push(await fleetRun(chargers, rate, seconds, 2));
    const result = median(runs, (run) => run.p95);
    report(
      'mixed',
      `${fmt(chargers / 2)} OCPP 1.6 (MeterValues) + ${fmt(chargers / 2)} OCPP 2.0.1 (TransactionEvent) x ${rate} msg/s for ${seconds} s`,
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
  mixed: benchMixedFleet,
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
