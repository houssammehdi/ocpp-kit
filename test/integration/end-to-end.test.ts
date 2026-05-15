import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  CentralSystem,
  ChargePoint,
  Fleet,
  type ChargePointRequest,
  type MeterValue,
} from '../../src/index.js';
import { until } from '../helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Ledger {
  boots: string[];
  authorizations: string[];
  started: Map<number, { identity: string; meterStart: number }>;
  meterValues: Map<number, number[]>;
  stopped: Map<number, ChargePointRequest<'StopTransaction'>>;
}

/** A small but complete Central System used by the integration tests. */
async function startCsms(options: { port?: number; authenticate?: () => boolean } = {}) {
  const ledger: Ledger = {
    boots: [],
    authorizations: [],
    started: new Map(),
    meterValues: new Map(),
    stopped: new Map(),
  };
  let nextId = 1_000;
  const cs = new CentralSystem({
    requireAcceptedBoot: true,
    pingIntervalMs: 1_000,
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
  });
  cs.handle('BootNotification', (_payload, { connection }) => {
    ledger.boots.push(connection.identity);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
  });
  cs.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
  cs.handle('StatusNotification', () => ({}));
  cs.handle('Authorize', ({ idTag }) => {
    ledger.authorizations.push(idTag);
    return { idTagInfo: { status: 'Accepted' } };
  });
  cs.handle('StartTransaction', ({ meterStart }, { connection }) => {
    const transactionId = nextId++;
    ledger.started.set(transactionId, { identity: connection.identity, meterStart });
    return { idTagInfo: { status: 'Accepted' }, transactionId };
  });
  cs.handle('MeterValues', ({ transactionId, meterValue }) => {
    if (transactionId === undefined) return {};
    const readings = ledger.meterValues.get(transactionId) ?? [];
    readings.push(...meterValue.map((mv) => Number(mv.sampledValue[0]?.value)));
    ledger.meterValues.set(transactionId, readings);
    return {};
  });
  cs.handle('StopTransaction', (payload) => {
    ledger.stopped.set(payload.transactionId, payload);
    return { idTagInfo: { status: 'Accepted' } };
  });
  const address = await cs.listen(options.port ?? 0, '127.0.0.1');
  cleanups.push(() => cs.close({ timeoutMs: 500 }));
  return { cs, ledger, port: address.port, url: `ws://127.0.0.1:${address.port}` };
}

const reading = (wh: number): MeterValue => ({
  timestamp: new Date().toISOString(),
  sampledValue: [{ value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
});

/** Drive one charge point through a whole session using the low-level client. */
async function session(url: string, identity: string, meterStart: number) {
  const cp = new ChargePoint({ identity, url, reconnect: false });
  cleanups.push(() => cp.close());
  await cp.connect();
  const boot = await cp.call('BootNotification', {
    chargePointVendor: 'IT',
    chargePointModel: 'E2E',
  });
  expect(boot.status).toBe('Accepted');
  await cp.call('StatusNotification', {
    connectorId: 1,
    errorCode: 'NoError',
    status: 'Preparing',
  });
  const auth = await cp.call('Authorize', { idTag: identity.slice(-20) });
  expect(auth.idTagInfo.status).toBe('Accepted');
  const { transactionId } = await cp.call('StartTransaction', {
    connectorId: 1,
    idTag: identity.slice(-20),
    meterStart,
    timestamp: new Date().toISOString(),
  });
  const samples = [meterStart + 100, meterStart + 250, meterStart + 400];
  await Promise.all(
    samples.map((wh) =>
      cp.call('MeterValues', { connectorId: 1, transactionId, meterValue: [reading(wh)] }),
    ),
  );
  await cp.call('StopTransaction', {
    transactionId,
    meterStop: meterStart + 500,
    timestamp: new Date().toISOString(),
    reason: 'Local',
  });
  await cp.call('StatusNotification', {
    connectorId: 1,
    errorCode: 'NoError',
    status: 'Available',
  });
  return transactionId;
}

describe('end-to-end over WebSockets', () => {
  it('runs boot -> authorize -> start -> meter values -> stop for 20 concurrent chargers', async () => {
    const { cs, ledger, url } = await startCsms();
    const identities = Array.from(
      { length: 20 },
      (_, i) => `E2E-${String(i + 1).padStart(2, '0')}`,
    );
    const transactionIds = await Promise.all(
      identities.map((id, i) => session(url, id, i * 10_000)),
    );

    expect(new Set(transactionIds).size).toBe(20);
    expect(ledger.boots.sort()).toEqual(identities);
    expect(ledger.authorizations).toHaveLength(20);
    expect(cs.connections.size).toBe(20);
    for (const [index, transactionId] of transactionIds.entries()) {
      const start = ledger.started.get(transactionId);
      expect(start).toEqual({ identity: identities[index], meterStart: index * 10_000 });
      // The offline queue delivers transaction messages in order.
      expect(ledger.meterValues.get(transactionId)).toEqual(
        [100, 250, 400].map((d) => d + index * 10_000),
      );
      expect(ledger.stopped.get(transactionId)?.meterStop).toBe(index * 10_000 + 500);
    }
  });

  it('drives 20 simulated chargers through remote start and remote stop', async () => {
    const { cs, ledger, url } = await startCsms();
    const fleet = new Fleet({
      url,
      count: 20,
      ratePerSecond: 200,
      seed: 3,
      charger: { connectors: 1, meterValueSampleIntervalS: 1, tickMs: 50 },
    });
    cleanups.push(() => fleet.stop());
    await fleet.start();
    await until(() => fleet.stats().registered === 20);

    const identities = [...cs.connections.keys()];
    const responses = await Promise.all(
      identities.map((identity) =>
        cs.call(identity, 'RemoteStartTransaction', { idTag: 'FLEET', connectorId: 1 }),
      ),
    );
    expect(responses.every((r) => r.status === 'Accepted')).toBe(true);
    for (const charger of fleet.chargers) {
      charger.plugIn(1, { batteryKWh: 40, initialSoc: 0.5, targetSoc: 1, maxPowerW: 11_000 });
    }
    await until(() => ledger.started.size === 20);
    await until(() => [...ledger.meterValues.values()].filter((v) => v.length > 0).length === 20);
    expect(fleet.stats().activeTransactions).toBe(20);

    const stops = await Promise.all(
      [...ledger.started.entries()].map(([transactionId, { identity }]) =>
        cs.call(identity, 'RemoteStopTransaction', { transactionId }),
      ),
    );
    expect(stops.every((r) => r.status === 'Accepted')).toBe(true);
    await until(() => ledger.stopped.size === 20);
    for (const stop of ledger.stopped.values()) {
      expect(stop.reason).toBe('Remote');
      expect(stop.meterStop).toBeGreaterThan(0);
    }
    // The CSMS has seen every stop; the chargers count a session once they got the response.
    await until(() => fleet.stats().sessionsCompleted === 20);
    const stats = fleet.stats();
    expect(stats).toMatchObject({ connected: 20, activeTransactions: 0, callErrors: 0 });
    expect(stats.latency.count).toBeGreaterThan(100);
  });

  it('queues transaction messages through an outage and replays them in order', async () => {
    let outage = false;
    const { cs, ledger, url } = await startCsms({ authenticate: () => !outage });
    const cp = new ChargePoint({
      identity: 'RESILIENT',
      url,
      reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
    });
    cleanups.push(() => cp.close());
    const refused: number[] = [];
    cp.on('connectFailed', (error) =>
      refused.push((error as { statusCode?: number }).statusCode ?? 0),
    );
    await cp.connect();
    await cp.call('BootNotification', { chargePointVendor: 'IT', chargePointModel: 'E2E' });
    const { transactionId } = await cp.call('StartTransaction', {
      connectorId: 1,
      idTag: 'T',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });

    // Network outage: the link drops and reconnects are refused for a while.
    outage = true;
    cs.connections.get('RESILIENT')!.terminate();
    await until(() => !cp.isConnected);
    const queued = [1, 2, 3].map((n) =>
      cp.call('MeterValues', { connectorId: 1, transactionId, meterValue: [reading(n * 100)] }),
    );
    const stopped = cp.call('StopTransaction', {
      transactionId,
      meterStop: 400,
      timestamp: new Date().toISOString(),
    });
    await until(() => cp.queueSize === 4 && refused.length >= 2);
    await expect(cp.call('Heartbeat', {})).rejects.toThrow(/not connected/);
    expect(refused.every((status) => status === 401)).toBe(true);

    outage = false;
    await Promise.all([...queued, stopped]);
    // No new BootNotification was needed: the registration survived the reconnect.
    expect(ledger.boots).toEqual(['RESILIENT']);
    expect(ledger.meterValues.get(transactionId)).toEqual([100, 200, 300]);
    expect(ledger.stopped.get(transactionId)?.meterStop).toBe(400);
    expect(cp.queueSize).toBe(0);
  });

  it('replays queued messages to a lenient Central System in order', async () => {
    const first = await startCsms();
    const cp = new ChargePoint({
      identity: 'REPLAY',
      url: first.url,
      reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
    });
    cleanups.push(() => cp.close());
    await cp.connect();
    await cp.call('BootNotification', { chargePointVendor: 'IT', chargePointModel: 'E2E' });
    await first.cs.close();
    await until(() => !cp.isConnected);

    const pending = [
      cp.call('StartTransaction', {
        connectorId: 1,
        idTag: 'T',
        meterStart: 0,
        timestamp: new Date().toISOString(),
      }),
      cp.call('MeterValues', { connectorId: 1, transactionId: 1_000, meterValue: [reading(100)] }),
      cp.call('MeterValues', { connectorId: 1, transactionId: 1_000, meterValue: [reading(200)] }),
      cp.call('StopTransaction', {
        transactionId: 1_000,
        meterStop: 300,
        timestamp: new Date().toISOString(),
      }),
    ];
    const order: string[] = [];
    const lenient = new CentralSystem({ pingIntervalMs: 0 });
    lenient.on('call', ({ action }) => order.push(action));
    lenient.handle('StartTransaction', () => ({
      idTagInfo: { status: 'Accepted' },
      transactionId: 1_000,
    }));
    lenient.handle('MeterValues', () => ({}));
    lenient.handle('StopTransaction', () => ({}));
    await lenient.listen(first.port, '127.0.0.1');
    cleanups.push(() => lenient.close({ timeoutMs: 500 }));

    const [start] = await Promise.all(pending);
    expect(start).toMatchObject({ transactionId: 1_000 });
    expect(order).toEqual(['StartTransaction', 'MeterValues', 'MeterValues', 'StopTransaction']);
  });
});

describe('wire-level protocol behaviour', () => {
  async function rawClient(url: string) {
    const ws = new WebSocket(`${url}/RAW-1`, ['ocpp1.6']);
    cleanups.push(async () => {
      ws.terminate();
      await Promise.resolve();
    });
    const inbox: unknown[][] = [];
    const waiters: ((frame: unknown[]) => void)[] = [];
    ws.on('message', (data) => {
      const frame = JSON.parse((data as Buffer).toString('utf8')) as unknown[];
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else inbox.push(frame);
    });
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
    const next = (): Promise<unknown[]> =>
      inbox.length > 0
        ? Promise.resolve(inbox.shift()!)
        : new Promise((resolve) => waiters.push(resolve));
    return { ws, next, inbox };
  }

  it('answers malformed and unknown CALLs with the right CALLERROR codes', async () => {
    const { url } = await startCsms();
    const { ws, next } = await rawClient(url);
    ws.send('[2,"a","Teleport",{}]');
    expect((await next()).slice(0, 3)).toEqual([4, 'a', 'NotImplemented']);
    ws.send('[2,"b","BootNotification",{"chargePointVendor":"V"}]');
    expect((await next()).slice(0, 3)).toEqual([4, 'b', 'OccurenceConstraintViolation']);
    ws.send('[2,"c","Heartbeat",{}]');
    expect((await next()).slice(0, 3)).toEqual([4, 'c', 'SecurityError']);
    ws.send('[2,"d","BootNotification",{"chargePointVendor":"V","chargePointModel":"M"}]');
    expect((await next())[0]).toBe(3);
    ws.send('[2,"e","Heartbeat"]');
    expect((await next()).slice(0, 3)).toEqual([4, 'e', 'ProtocolError']);
    ws.send(
      '[2,"f","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Dancing"}]',
    );
    expect((await next()).slice(0, 3)).toEqual([4, 'f', 'PropertyConstraintViolation']);
    ws.send('[2,"g","Heartbeat",{}]');
    expect((await next())[0]).toBe(3);
  });

  it('keeps at most one CALL outstanding towards a charge point', async () => {
    const { cs, url } = await startCsms();
    const { ws, next, inbox } = await rawClient(url);
    const connection = await until(() => cs.connections.has('RAW-1')).then(() =>
      cs.connections.get('RAW-1')!,
    );
    const calls = [
      connection.call('ClearCache', {}),
      connection.call('Reset', { type: 'Soft' }),
      connection.call('UnlockConnector', { connectorId: 1 }),
    ];
    const seen: string[] = [];
    for (const status of ['Accepted', 'Accepted', 'Unlocked']) {
      const frame = await next();
      seen.push(frame[2] as string);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(inbox).toHaveLength(0);
      ws.send(JSON.stringify([3, frame[1], { status }]));
    }
    expect(seen).toEqual(['ClearCache', 'Reset', 'UnlockConnector']);
    await expect(Promise.all(calls)).resolves.toEqual([
      { status: 'Accepted' },
      { status: 'Accepted' },
      { status: 'Unlocked' },
    ]);
  });
});
