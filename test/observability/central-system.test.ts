import { afterEach, describe, expect, it } from 'vitest';
import {
  attachLogger,
  CentralSystem,
  ChargePoint,
  ChargingStation,
  instrumentCentralSystem,
  jsonLines,
  MetricsRegistry,
  RpcError,
  type LogEntry,
} from '../../src/index.js';
import { NOW, until } from '../helpers.js';
import { WebSocket } from 'ws';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server() {
  const cs = new CentralSystem({ callTimeoutMs: 200 });
  cs.handle('BootNotification', () => ({ status: 'Accepted', currentTime: NOW, interval: 60 }));
  cs.handle('Heartbeat', () => ({ currentTime: NOW }));
  cs.handle('Authorize', () => {
    throw new Error('database down');
  });
  const { port } = await cs.listen(0, '127.0.0.1');
  cleanups.push(() => cs.close({ timeoutMs: 200 }));
  return { cs, url: `ws://127.0.0.1:${port}` };
}

function chargePoint(url: string, identity: string) {
  const cp = new ChargePoint({ identity, url, reconnect: false });
  cleanups.push(() => cp.close());
  return cp;
}

/** Drive one charge point through inbound calls, outbound calls, a timeout and a bad frame. */
async function traffic(cs: CentralSystem, url: string) {
  const cp = chargePoint(url, 'CP-OBS');
  cp.handle('ClearCache', () => ({ status: 'Accepted' }));
  await cp.connect();
  await cp.call('BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' });
  await cp.call('Heartbeat', {});
  await expect(cp.call('Authorize', { idTag: 'X' })).rejects.toBeInstanceOf(RpcError);
  await expect(cs.call('CP-OBS', 'ClearCache', {})).resolves.toEqual({ status: 'Accepted' });
  // Nobody handles Reset on this charge point: CALLERROR NotSupported.
  await expect(cs.call('CP-OBS', 'Reset', { type: 'Soft' })).rejects.toBeInstanceOf(RpcError);
  // A raw client that never answers makes the Central System's call time out.
  const silent = new WebSocket(`${url}/CP-SILENT`, ['ocpp1.6']);
  await new Promise((resolve) => silent.once('open', resolve));
  cleanups.push(() => {
    silent.terminate();
    return Promise.resolve();
  });
  await until(() => cs.connections.has('CP-SILENT'));
  await expect(cs.call('CP-SILENT', 'ClearCache', {})).rejects.toThrow(/timed out/);
  silent.send('not json');
  // Two path segments name no identity: refused with 404.
  const lost = new WebSocket(`${url}/not/an-identity`, ['ocpp1.6']);
  await new Promise((resolve) => lost.once('error', resolve));
}

describe('instrumentCentralSystem', () => {
  it('counts connections, calls in both directions, errors and latencies', async () => {
    const { cs, url } = await server();
    const registry = new MetricsRegistry();
    const metrics = instrumentCentralSystem(cs, { registry });
    expect(metrics.registry).toBe(registry);
    await traffic(cs, url);
    await until(() =>
      metrics.render().includes('ocpp_bad_messages_total{code="FormationViolation"} 1'),
    );

    const text = metrics.render();
    expect(text).toContain('ocpp_connected_charge_points 2');
    expect(text).toContain('ocpp_connections_total 2');
    expect(text).toContain('ocpp_rejected_connections_total{reason="path"} 1');
    expect(text).toContain('ocpp_inbound_calls_total{action="BootNotification",result="ok"} 1');
    expect(text).toContain('ocpp_inbound_calls_total{action="Heartbeat",result="ok"} 1');
    expect(text).toContain('ocpp_inbound_calls_total{action="Authorize",result="InternalError"} 1');
    expect(text).toContain('ocpp_inbound_call_duration_seconds_count{action="Heartbeat"} 1');
    expect(text).toContain('ocpp_outbound_calls_total{action="ClearCache",result="ok"} 1');
    expect(text).toContain('ocpp_outbound_calls_total{action="Reset",result="NotSupported"} 1');
    expect(text).toContain('ocpp_outbound_calls_total{action="ClearCache",result="timeout"} 1');
    expect(text).toContain('ocpp_outbound_call_duration_seconds_count{action="ClearCache"} 2');
    expect(text).toContain('# TYPE ocpp_outbound_call_duration_seconds histogram');

    await cs.connections.get('CP-SILENT')?.close();
    await until(() => metrics.render().includes('ocpp_connected_charge_points 1'));
    expect(metrics.render()).toContain('ocpp_disconnections_total 1');

    metrics.dispose();
    await chargePoint(url, 'CP-AFTER').connect();
    expect(metrics.render()).toContain('ocpp_connections_total 2');
  });

  it('collapses unknown action names into one label value', async () => {
    const { cs, url } = await server();
    const metrics = instrumentCentralSystem(cs, { prefix: 'csms_' });
    const raw = new WebSocket(`${url}/CP-RAW`, ['ocpp1.6']);
    await new Promise((resolve) => raw.once('open', resolve));
    cleanups.push(() => {
      raw.terminate();
      return Promise.resolve();
    });
    for (const action of ['Foo', 'Bar', 'Baz']) raw.send(JSON.stringify([2, action, action, {}]));
    await until(() => metrics.render().includes('result="NotImplemented"} 3'));
    expect(metrics.render()).toContain(
      'csms_inbound_calls_total{action="unknown",result="NotImplemented"} 3',
    );
  });
});

describe('attachLogger', () => {
  it('emits structured entries for every event, frames on request', async () => {
    const { cs, url } = await server();
    const entries: LogEntry[] = [];
    const detach = attachLogger(cs, (entry) => entries.push(entry), { frames: true });
    await traffic(cs, url);
    await until(() => entries.some((entry) => entry.event === 'badMessage'));
    const find = (predicate: (entry: LogEntry) => boolean) => entries.find(predicate);

    expect(find((e) => e.event === 'connect')).toMatchObject({
      level: 'info',
      identity: 'CP-OBS',
      remoteAddress: '127.0.0.1',
    });
    expect(find((e) => e.event === 'rejected')).toMatchObject({ level: 'warn', reason: 'path' });
    expect(find((e) => e.event === 'call' && e.action === 'Heartbeat')).toMatchObject({
      level: 'debug',
      identity: 'CP-OBS',
      durationMs: expect.any(Number),
    });
    expect(find((e) => e.event === 'call' && e.action === 'Authorize')).toMatchObject({
      level: 'error',
      code: 'InternalError',
      reason: 'Failed to process Authorize: database down',
    });
    expect(find((e) => e.event === 'callCompleted' && e.action === 'Reset')).toMatchObject({
      level: 'warn',
      code: 'NotSupported',
    });
    expect(find((e) => e.event === 'callCompleted' && e.code === 'CallTimeoutError')).toMatchObject(
      { level: 'warn', identity: 'CP-SILENT', action: 'ClearCache' },
    );
    expect(find((e) => e.event === 'badMessage')).toMatchObject({
      code: 'FormationViolation',
      frame: 'not json',
    });
    expect(find((e) => e.event === 'frame' && e.direction === 'out')).toMatchObject({
      level: 'debug',
      frame: expect.stringMatching(/^\[3,/),
    });
    for (const entry of entries) expect(Date.parse(entry.time)).not.toBeNaN();

    detach();
    const count = entries.length;
    await chargePoint(url, 'CP-LATER').connect();
    expect(entries).toHaveLength(count);

    await cs.connections.get('CP-OBS')?.close(1000, 'bye');
    expect(entries).toHaveLength(count);
  });

  it('writes JSON lines', () => {
    const lines: string[] = [];
    jsonLines({ write: (chunk: string) => lines.push(chunk) })({
      time: NOW,
      level: 'info',
      event: 'connect',
      identity: 'CP-1',
    });
    expect(lines).toEqual([
      `{"time":"${NOW}","level":"info","event":"connect","identity":"CP-1"}\n`,
    ]);
  });

  it('logs disconnects with their close code', async () => {
    const { cs, url } = await server();
    const entries: LogEntry[] = [];
    attachLogger(cs, (entry) => entries.push(entry));
    const cp = chargePoint(url, 'CP-BYE');
    await cp.connect();
    await cs.connections.get('CP-BYE')?.close(4001, 'maintenance');
    await until(() => entries.some((entry) => entry.event === 'disconnect'));
    expect(entries.find((entry) => entry.event === 'disconnect')).toMatchObject({
      level: 'info',
      identity: 'CP-BYE',
      code: 4001,
      reason: 'maintenance',
    });
    expect(entries.some((entry) => entry.event === 'frame')).toBe(false);
  });
});

describe('observability of a multi-version Central System', () => {
  it('labels 2.0.1 actions from the 2.0.1 catalogue and logs the version', async () => {
    const cs = new CentralSystem({ protocols: ['ocpp2.0.1', 'ocpp1.6'] });
    cs.v201.handle('Heartbeat', () => ({ currentTime: NOW }));
    const { port } = await cs.listen(0, '127.0.0.1');
    cleanups.push(() => cs.close({ timeoutMs: 200 }));
    const metrics = instrumentCentralSystem(cs);
    const entries: LogEntry[] = [];
    const detach = attachLogger(cs, (entry) => entries.push(entry));
    const station = new ChargingStation({
      identity: 'CS-OBS',
      url: `ws://127.0.0.1:${port}`,
      reconnect: false,
    });
    cleanups.push(() => station.close());
    station.handle('ClearCache', () => ({ status: 'Accepted' }));
    await station.connect();
    await station.call('Heartbeat', {});
    await cs.v201.call('CS-OBS', 'ClearCache', {});
    const text = metrics.render();
    expect(text).toContain('ocpp_inbound_calls_total{action="Heartbeat",result="ok"} 1');
    expect(text).toContain('ocpp_outbound_calls_total{action="ClearCache",result="ok"} 1');
    expect(text).not.toContain('action="unknown"');
    expect(entries.find((entry) => entry.event === 'connect')).toMatchObject({
      identity: 'CS-OBS',
      version: '2.0.1',
    });
    detach();
    metrics.dispose();
  });
});
