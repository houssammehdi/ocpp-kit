import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChargePoint,
  MemoryQueueStore,
  NotConnectedError,
  RpcError,
  type ChargePointOptions,
  type QueuedMessage,
} from '../../src/index.js';
import { FakeCentralSystem, nextEvent, NOW, until } from '../helpers.js';

const clients: ChargePoint[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.close();
});

function setup(options: Partial<ChargePointOptions> = {}) {
  const csms = new FakeCentralSystem();
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
    ...options,
  });
  clients.push(cp);
  return { csms, cp };
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
    expect(csms.received).toEqual(['StartTransaction', 'MeterValues', 'StopTransaction']);
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
    expect(csms.received.filter((a) => a !== 'Heartbeat')).toEqual([
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
    const { csms, cp } = setup({ offlineQueue: false });
    await expect(cp.call('StartTransaction', start)).rejects.toBeInstanceOf(NotConnectedError);
    await cp.connect();
    await expect(cp.call('StartTransaction', start)).resolves.toMatchObject({ transactionId: 100 });
    expect(csms.received).toEqual(['StartTransaction']);
  });
});
