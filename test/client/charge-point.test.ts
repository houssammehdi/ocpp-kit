import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChargePoint,
  MemoryQueueStore,
  NotConnectedError,
  RpcError,
  TransactionNotStartedError,
  type ChargePointOptions,
  type QueuedMessage,
} from '../../src/index.js';
import { FakeCentralSystem, nextEvent, NOW, until } from '../helpers.js';

const clients: ChargePoint[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.close();
});

const boot = { chargePointVendor: 'Acme', chargePointModel: 'X1' };

/**
 * A client against an in-memory CSMS. Like a real charge point it sends BootNotification once,
 * on its first connection (`autoBoot: false` skips that).
 */
function setup(options: Partial<ChargePointOptions> & { autoBoot?: boolean } = {}) {
  const { autoBoot = true, ...clientOptions } = options;
  const csms = new FakeCentralSystem();
  let bootStatus: 'Accepted' | 'Pending' = 'Accepted';
  csms.handlers.set('BootNotification', () => ({
    status: bootStatus,
    currentTime: NOW,
    interval: 60,
  }));
  csms.handlers.set('Heartbeat', () => ({ currentTime: NOW }));
  let nextTx = 100;
  csms.handlers.set('StartTransaction', () => ({
    idTagInfo: { status: 'Accepted' },
    transactionId: nextTx++,
  }));
  csms.handlers.set('StopTransaction', () => ({}));
  csms.handlers.set('MeterValues', () => ({}));
  const cp = new ChargePoint({
    identity: 'CP 1',
    url: 'ws://csms.test/ocpp/',
    connector: csms.connector,
    reconnect: { initialDelayMs: 5, maxDelayMs: 20, resetAfterMs: 1 },
    transactionMessageRetryIntervalMs: 5,
    ...clientOptions,
  });
  if (autoBoot) {
    cp.once('open', () => void cp.call('BootNotification', boot).catch(() => undefined));
  }
  clients.push(cp);
  const setBootStatus = (status: 'Accepted' | 'Pending'): void => {
    bootStatus = status;
  };
  return { csms, cp, setBootStatus };
}

const start = { connectorId: 1, idTag: 'TAG', meterStart: 0, timestamp: NOW };
const stop = (transactionId: number) => ({ transactionId, meterStop: 1_000, timestamp: NOW });
const meter = (transactionId: number, wh: number) => ({
  connectorId: 1,
  transactionId,
  meterValue: [{ timestamp: NOW, sampledValue: [{ value: String(wh) }] }],
});

describe('ChargePoint connection', () => {
  it('connects to <url>/<identity> offering ocpp1.6 and sends typed calls', async () => {
    const { csms, cp } = setup({ password: 's3cret' });
    expect(cp.state).toBe('idle');
    await cp.connect();
    expect(cp.state).toBe('open');
    expect(cp.isConnected).toBe(true);
    expect(csms.requests[0]).toMatchObject({
      url: 'ws://csms.test/ocpp/CP%201',
      protocols: ['ocpp1.6'],
      headers: { Authorization: `Basic ${Buffer.from('CP 1:s3cret').toString('base64')}` },
    });
    await expect(cp.call('Heartbeat', {})).resolves.toEqual({ currentTime: NOW });
  });

  it('serves Central System initiated calls through typed handlers', async () => {
    const { csms, cp } = setup();
    cp.handle('RemoteStartTransaction', ({ idTag }, { chargePoint }) => {
      expect(chargePoint).toBe(cp);
      return { status: idTag === 'OK' ? 'Accepted' : 'Rejected' };
    });
    await cp.connect();
    await expect(csms.current!.call('RemoteStartTransaction', { idTag: 'OK' })).resolves.toEqual({
      status: 'Accepted',
    });
  });

  it('fails fast for non-transaction messages while offline', async () => {
    const { csms, cp } = setup();
    await expect(cp.call('Heartbeat', {})).rejects.toBeInstanceOf(NotConnectedError);
    await cp.connect();
    await csms.drop();
    await until(() => !cp.isConnected);
    await expect(cp.call('Heartbeat', {})).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('reconnects with exponential backoff and full jitter', async () => {
    vi.useFakeTimers();
    const { csms, cp } = setup({
      reconnect: { initialDelayMs: 100, maxDelayMs: 1_000, multiplier: 2, resetAfterMs: 5 },
      random: () => 0.5,
    });
    csms.available = false;
    const delays: number[] = [];
    cp.on('reconnecting', (_attempt, delay) => delays.push(delay));
    const connected = cp.connect();
    // Attempts at t = 0, 50, 150, 350; the next one is due at t = 750.
    await vi.advanceTimersByTimeAsync(749);
    expect(delays).toEqual([50, 100, 200, 400]);
    expect(cp.state).toBe('reconnecting');
    expect(csms.requests).toHaveLength(4);
    csms.available = true;
    await vi.advanceTimersByTimeAsync(1);
    await connected;
    expect(csms.requests).toHaveLength(5);
    // After a stable connection the sequence restarts; it is capped at maxDelayMs.
    await vi.advanceTimersByTimeAsync(5);
    csms.available = false;
    await csms.drop();
    await vi.advanceTimersByTimeAsync(50 + 100 + 200 + 400 + 499);
    expect(delays.slice(4)).toEqual([50, 100, 200, 400, 500]);
  });

  it('resets the backoff only after a connection stayed up long enough', async () => {
    vi.useFakeTimers();
    const { csms, cp } = setup({
      reconnect: { initialDelayMs: 100, maxDelayMs: 10_000, resetAfterMs: 1_000, jitter: 'none' },
    });
    const delays: number[] = [];
    cp.on('reconnecting', (_attempt, delay) => delays.push(delay));
    await cp.connect();
    // Flapping: the server drops the connection right after accepting it, three times.
    for (const expected of [100, 200, 400]) {
      await csms.drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(delays.at(-1)).toBe(expected);
      await vi.advanceTimersByTimeAsync(expected);
      expect(cp.isConnected).toBe(true);
    }
    expect(delays).toEqual([100, 200, 400]);
    await vi.advanceTimersByTimeAsync(1_500);
    await csms.drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(delays).toEqual([100, 200, 400, 100]);
  });

  it('gives up after maxAttempts and rejects connect()', async () => {
    const { csms, cp } = setup({ reconnect: { initialDelayMs: 1, maxAttempts: 3 } });
    csms.available = false;
    const failures: number[] = [];
    cp.on('connectFailed', (_error, attempt) => failures.push(attempt));
    await expect(cp.connect()).rejects.toThrow('connection refused');
    expect(failures).toEqual([1, 2, 3]);
    expect(cp.state).toBe('closed');
  });

  it('does not reconnect when reconnect is disabled', async () => {
    const { csms, cp } = setup({ reconnect: false });
    await cp.connect();
    const closed = nextEvent(cp, 'close');
    await csms.drop();
    expect(await closed).toEqual([1006, 'network down']);
    await until(() => cp.state === 'closed');
    expect(csms.requests).toHaveLength(1);
  });

  it('reconnectAfter() closes the link and reconnects after the given delay', async () => {
    vi.useFakeTimers();
    const { csms, cp } = setup({ reconnect: false });
    await cp.connect();
    const delays: number[] = [];
    cp.on('reconnecting', (_attempt, delay) => delays.push(delay));
    await cp.reconnectAfter(5_000, 'Registration rejected');
    expect(cp.isConnected).toBe(false);
    expect(delays).toEqual([5_000]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(csms.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(csms.requests).toHaveLength(2);
    expect(cp.isConnected).toBe(true);
  });

  it('close() stops a pending reconnect loop', async () => {
    const { csms, cp } = setup({ reconnect: { initialDelayMs: 60_000 } });
    csms.available = false;
    const connecting = cp.connect().catch((e: unknown) => e);
    await nextEvent(cp, 'reconnecting');
    await cp.close();
    expect(await connecting).toMatchObject({ reason: 'Client closed' });
    expect(cp.state).toBe('closed');
    await expect(cp.connect()).rejects.toThrow(/closed/);
  });
});

describe('ChargePoint offline queue', () => {
  it('queues transaction messages while offline and replays them in order', async () => {
    const { csms, cp } = setup();
    csms.available = false;
    void cp.connect();
    await nextEvent(cp, 'reconnecting');

    const started = cp.call('StartTransaction', start);
    const sampled = cp.call('MeterValues', meter(100, 500));
    const stopped = cp.call('StopTransaction', stop(100));
    await until(() => cp.queueSize === 3);

    csms.available = true;
    const [startResponse] = await Promise.all([started, sampled, stopped]);
    expect(startResponse.transactionId).toBe(100);
    expect(csms.received).toEqual([
      'BootNotification',
      'StartTransaction',
      'MeterValues',
      'StopTransaction',
    ]);
    expect(cp.queueSize).toBe(0);
  });

  it('keeps ordering when messages are queued while connected', async () => {
    const { csms, cp } = setup();
    await cp.connect();
    const calls = [
      cp.call('StartTransaction', start),
      cp.call('Heartbeat', {}),
      cp.call('MeterValues', meter(100, 1)),
      cp.call('MeterValues', meter(100, 2)),
      cp.call('StopTransaction', stop(100)),
    ];
    await Promise.all(calls);
    expect(csms.received.filter((a) => a !== 'Heartbeat' && a !== 'BootNotification')).toEqual([
      'StartTransaction',
      'MeterValues',
      'MeterValues',
      'StopTransaction',
    ]);
  });

  it('re-sends a message whose connection died before the response arrived', async () => {
    const { csms, cp } = setup();
    let attempts = 0;
    csms.handlers.set('StopTransaction', async () => {
      attempts++;
      if (attempts === 1) {
        await csms.drop();
        return new Promise<never>(() => undefined);
      }
      return { idTagInfo: { status: 'Accepted' } };
    });
    await cp.connect();
    await expect(cp.call('StopTransaction', stop(7))).resolves.toEqual({
      idTagInfo: { status: 'Accepted' },
    });
    expect(attempts).toBe(2);
    expect(csms.peers).toHaveLength(2);
  });

  it('retries on CALLERROR and gives up after transactionMessageAttempts', async () => {
    const { csms, cp } = setup({ transactionMessageAttempts: 3 });
    let calls = 0;
    csms.handlers.set('MeterValues', () => {
      calls++;
      throw new RpcError('InternalError', 'db unavailable');
    });
    const dropped: QueuedMessage[] = [];
    cp.on('dropped', (message) => dropped.push(message));
    await cp.connect();
    const failing = cp.call('MeterValues', meter(1, 1));
    const next = cp.call('StopTransaction', stop(1));
    await expect(failing).rejects.toMatchObject({ code: 'InternalError' });
    await expect(next).resolves.toEqual({});
    expect(calls).toBe(3);
    expect(dropped.map((m) => m.action)).toEqual(['MeterValues']);
  });

  it('never evicts the message that is being delivered', async () => {
    // Regression: a full queue evicted the in-flight MeterValues, which was then reported as
    // both dropped and delivered.
    const { csms, cp } = setup({ offlineQueue: { maxSize: 2 } });
    let release: (() => void) | undefined;
    csms.handlers.set('MeterValues', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return {};
    });
    const dropped: number[] = [];
    const delivered: number[] = [];
    cp.on('dropped', (message) => dropped.push(message.seq));
    cp.on('delivered', (message) => delivered.push(message.seq));
    await cp.connect();
    const first = cp.call('MeterValues', meter(1, 1));
    await until(() => release !== undefined);
    const second = cp.call('MeterValues', meter(1, 2)).catch((e: unknown) => e);
    const third = cp.call('MeterValues', meter(1, 3));
    expect(await second).toMatchObject({ message: 'Evicted from a full offline queue' });
    const releaseFirst = release!;
    release = undefined;
    releaseFirst();
    await expect(first).resolves.toEqual({});
    await until(() => release !== undefined);
    release!();
    await expect(third).resolves.toEqual({});
    expect(dropped).toEqual([2]);
    expect(delivered).toEqual([1, 3]);
  });

  it('reads retry settings given as functions before every message', async () => {
    let attempts = 2;
    const { csms, cp } = setup({ transactionMessageAttempts: () => attempts });
    let calls = 0;
    csms.handlers.set('MeterValues', () => {
      calls++;
      throw new RpcError('InternalError');
    });
    await cp.connect();
    await expect(cp.call('MeterValues', meter(1, 1))).rejects.toMatchObject({
      code: 'InternalError',
    });
    expect(calls).toBe(2);
    attempts = 4;
    await expect(cp.call('MeterValues', meter(1, 2))).rejects.toMatchObject({
      code: 'InternalError',
    });
    expect(calls).toBe(6);
  });

  it('recovers when a later attempt succeeds', async () => {
    const { csms, cp } = setup();
    let calls = 0;
    csms.handlers.set('StartTransaction', () => {
      calls++;
      if (calls < 3) throw new RpcError('GenericError');
      return { idTagInfo: { status: 'Accepted' }, transactionId: 5 };
    });
    await cp.connect();
    await expect(cp.call('StartTransaction', start)).resolves.toMatchObject({ transactionId: 5 });
  });

  it('validates queued payloads before persisting them', async () => {
    const { cp } = setup();
    const invalid = { ...start, connectorId: 0 };
    await expect(cp.call('StartTransaction', invalid)).rejects.toMatchObject({
      code: 'PropertyConstraintViolation',
    });
    expect(cp.queueSize).toBe(0);
  });

  it('replays messages persisted by a previous client instance', async () => {
    const store = new MemoryQueueStore();
    const first = setup({ offlineQueue: { store } });
    first.csms.available = false;
    const firstConnect = first.cp.connect().catch((e: unknown) => e);
    await nextEvent(first.cp, 'reconnecting');
    const pending = first.cp.call('StartTransaction', start).catch((e: unknown) => e);
    await until(() => first.cp.queueSize === 1);
    await first.cp.close();
    expect(await pending).toMatchObject({ reason: 'Client closed' });
    expect(await firstConnect).toMatchObject({ reason: 'Client closed' });

    const second = setup({ offlineQueue: { store } });
    const delivered = nextEvent(second.cp, 'delivered');
    await second.cp.connect();
    const [message, response] = await delivered;
    expect(message.action).toBe('StartTransaction');
    expect(response).toMatchObject({ transactionId: 100 });
    expect(await store.load()).toEqual([]);
  });

  it('sends transaction messages directly when the queue is disabled', async () => {
    const { csms, cp } = setup({ offlineQueue: false, autoBoot: false });
    await expect(cp.call('StartTransaction', start)).rejects.toBeInstanceOf(NotConnectedError);
    await cp.connect();
    await expect(cp.call('StartTransaction', start)).resolves.toMatchObject({ transactionId: 100 });
    expect(csms.received).toEqual(['StartTransaction']);
  });

  it('replays cached messages only after BootNotification was accepted', async () => {
    // Regression: persisted messages used to go out before BootNotification, even while the
    // registration was Pending (OCPP 1.6 section 4.2 forbids both).
    const store = new MemoryQueueStore();
    const cached: QueuedMessage = {
      seq: 1,
      action: 'StartTransaction',
      payload: start,
      enqueuedAt: NOW,
    };
    await store.save([cached]);
    const { csms, cp, setBootStatus } = setup({ offlineQueue: { store }, autoBoot: false });
    setBootStatus('Pending');
    await cp.connect();
    await expect(cp.call('BootNotification', boot)).resolves.toMatchObject({ status: 'Pending' });
    expect(cp.registrationStatus).toBe('Pending');
    const live = cp.call('MeterValues', meter(100, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(csms.received).toEqual(['BootNotification']);
    expect(cp.queueSize).toBe(2);

    setBootStatus('Accepted');
    const delivered = nextEvent(cp, 'delivered');
    await cp.call('BootNotification', boot);
    expect((await delivered)[0].action).toBe('StartTransaction');
    await live;
    expect(csms.received).toEqual([
      'BootNotification',
      'BootNotification',
      'StartTransaction',
      'MeterValues',
    ]);
  });

  it('keeps persisted messages when a message is queued before connect()', async () => {
    // Regression: the early push overwrote the store, losing a persisted StopTransaction, and
    // reused its sequence number.
    const store = new MemoryQueueStore();
    await store.save([{ seq: 1, action: 'StopTransaction', payload: stop(7), enqueuedAt: NOW }]);
    const { csms, cp } = setup({ offlineQueue: { store } });
    const started = cp.call('StartTransaction', start);
    await cp.connect();
    await expect(started).resolves.toMatchObject({ transactionId: 100 });
    expect(csms.received).toEqual(['BootNotification', 'StopTransaction', 'StartTransaction']);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ transactionId: 7 });
    expect(await store.load()).toEqual([]);
  });

  it('keeps the registration across reconnects of the same client', async () => {
    const { csms, cp } = setup();
    await cp.connect();
    await until(() => cp.registrationStatus === 'Accepted');
    await csms.drop();
    await until(() => !cp.isConnected);
    const queued = cp.call('StartTransaction', start);
    await expect(queued).resolves.toMatchObject({ transactionId: 100 });
    expect(csms.received.filter((a) => a === 'BootNotification')).toHaveLength(1);
  });

  it('can replay without a BootNotification when holdUntilBootAccepted is false', async () => {
    const { csms, cp } = setup({ offlineQueue: { holdUntilBootAccepted: false }, autoBoot: false });
    await cp.connect();
    await expect(cp.call('StartTransaction', start)).resolves.toMatchObject({ transactionId: 100 });
    expect(csms.received).toEqual(['StartTransaction']);
  });
});

describe('ChargePoint.startTransaction', () => {
  const reading = (wh: number) => [{ timestamp: NOW, sampledValue: [{ value: String(wh) }] }];

  it('queues MeterValues and StopTransaction before the transaction id is known', async () => {
    const { csms, cp } = setup();
    csms.available = false;
    void cp.connect();
    await nextEvent(cp, 'reconnecting');

    const tx = cp.startTransaction(start);
    expect(tx.transactionId).toBeUndefined();
    const sampled = [tx.meterValues(reading(100)), tx.meterValues(reading(200))];
    const stopped = tx.stop({ meterStop: 300, timestamp: NOW, reason: 'Local' });
    await until(() => cp.queueSize === 4);

    csms.available = true;
    await expect(tx.started).resolves.toMatchObject({ transactionId: 100 });
    await Promise.all([...sampled, stopped]);
    expect(tx.transactionId).toBe(100);
    expect(csms.received).toEqual([
      'BootNotification',
      'StartTransaction',
      'MeterValues',
      'MeterValues',
      'StopTransaction',
    ]);
    expect(csms.requestsOf('MeterValues').map((r) => r.transactionId)).toEqual([100, 100]);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({
      transactionId: 100,
      meterStop: 300,
    });
    await expect(tx.meterValues(reading(400))).rejects.toThrow(/already stopped/);
  });

  it('uses the known id directly once the start has been answered', async () => {
    const { csms, cp } = setup();
    await cp.connect();
    const tx = cp.startTransaction(start);
    await tx.started;
    await tx.meterValues(reading(1));
    await tx.stop({ meterStop: 2, timestamp: NOW });
    expect(csms.requestsOf('MeterValues')[0]).toMatchObject({ connectorId: 1, transactionId: 100 });
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ transactionId: 100 });
  });

  it('binds the id after a restart from a persisted store', async () => {
    const store = new MemoryQueueStore();
    const first = setup({ offlineQueue: { store } });
    first.csms.available = false;
    const connecting = first.cp.connect().catch(() => undefined);
    await nextEvent(first.cp, 'reconnecting');
    const tx = first.cp.startTransaction(start);
    void tx.meterValues(reading(5)).catch(() => undefined);
    void tx.stop({ meterStop: 10, timestamp: NOW }).catch(() => undefined);
    await until(() => first.cp.queueSize === 3);
    await first.cp.close();
    await connecting;
    const persisted = await store.load();
    expect(persisted.map((m) => [m.action, m.payload.transactionId])).toEqual([
      ['StartTransaction', undefined],
      ['MeterValues', undefined],
      ['StopTransaction', undefined],
    ]);

    // A new client instance knows nothing about the handle; the store is enough.
    const second = setup({ offlineQueue: { store } });
    const delivered: string[] = [];
    second.cp.on('delivered', (message) => delivered.push(message.action));
    await second.cp.connect();
    await until(() => delivered.length === 3);
    expect(second.csms.requestsOf('MeterValues')[0]).toMatchObject({ transactionId: 100 });
    expect(second.csms.requestsOf('StopTransaction')[0]).toMatchObject({ transactionId: 100 });
    expect(await store.load()).toEqual([]);
  });

  it('abandons the follow-up messages when the start is abandoned', async () => {
    const { csms, cp } = setup({ transactionMessageAttempts: 2 });
    csms.handlers.set('StartTransaction', () => {
      throw new RpcError('InternalError', 'db down');
    });
    const dropped: string[] = [];
    cp.on('dropped', (message) => dropped.push(message.action));
    await cp.connect();
    const tx = cp.startTransaction(start);
    const sampled = tx.meterValues(reading(1));
    const stopped = tx.stop({ meterStop: 2, timestamp: NOW });
    await expect(tx.started).rejects.toMatchObject({ code: 'InternalError' });
    await expect(sampled).rejects.toBeInstanceOf(TransactionNotStartedError);
    await expect(stopped).rejects.toBeInstanceOf(TransactionNotStartedError);
    expect(dropped).toEqual(['StartTransaction', 'MeterValues', 'StopTransaction']);
    expect(csms.received.filter((a) => a !== 'BootNotification')).toEqual([
      'StartTransaction',
      'StartTransaction',
    ]);
    expect(cp.queueSize).toBe(0);
  });

  it('validates follow-up messages as if the id were already known', async () => {
    const { cp } = setup();
    const tx = cp.startTransaction(start);
    // @ts-expect-error -- meterStop is required
    await expect(tx.stop({ timestamp: NOW })).rejects.toMatchObject({
      code: 'OccurenceConstraintViolation',
    });
  });

  it('chains on the StartTransaction response when the queue is disabled', async () => {
    const { csms, cp } = setup({ offlineQueue: false, autoBoot: false });
    await cp.connect();
    const tx = cp.startTransaction(start);
    await tx.meterValues(reading(1));
    await tx.stop({ meterStop: 2, timestamp: NOW });
    expect(csms.received).toEqual(['StartTransaction', 'MeterValues', 'StopTransaction']);
    expect(csms.requestsOf('StopTransaction')[0]).toMatchObject({ transactionId: 100 });
  });
});

describe('ChargePoint shutdown', () => {
  it('keeps a StopTransaction queued right before close() (regression)', async () => {
    const store = new MemoryQueueStore();
    const { cp } = setup({ offlineQueue: { store } });
    await cp.connect();
    await until(() => cp.registrationStatus === 'Accepted');
    const stop = cp.call('StopTransaction', { transactionId: 7, meterStop: 10, timestamp: NOW });
    stop.catch(() => undefined);
    await cp.close();
    expect((await store.load()).map((message) => message.action)).toEqual(['StopTransaction']);
  });
});
