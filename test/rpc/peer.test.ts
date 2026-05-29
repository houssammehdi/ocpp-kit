import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CallAbortedError,
  CallTimeoutError,
  ConnectionClosedError,
  createDuplexPair,
  HandlerRegistry,
  RpcError,
  RpcPeer,
  type HandledCallEvent,
} from '../../src/rpc/index.js';
import {
  CentralSystemToChargePoint,
  ChargePointToCentralSystem,
} from '../../src/messages/index.js';
import { flush, NOW, peerPair, rawPair } from '../helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

const boot = { chargePointVendor: 'Acme', chargePointModel: 'X1' };

describe('RpcPeer request/response', () => {
  it('performs a typed round trip', async () => {
    const { cp, cs } = peerPair();
    cs.handle('BootNotification', (payload, ctx) => {
      expect(payload.chargePointVendor).toBe('Acme');
      expect(ctx.action).toBe('BootNotification');
      expect(ctx.messageId).toMatch(/^[0-9a-f-]{36}$/);
      return { status: 'Accepted', currentTime: NOW, interval: 300 };
    });
    const response = await cp.call('BootNotification', boot);
    expect(response).toEqual({ status: 'Accepted', currentTime: NOW, interval: 300 });
  });

  it('supports async handlers and passes the configured context', async () => {
    const registry = new HandlerRegistry<typeof ChargePointToCentralSystem, { tenant: string }>();
    registry.set('Authorize', async (payload, ctx) => {
      await Promise.resolve();
      return { idTagInfo: { status: payload.idTag === ctx.tenant ? 'Accepted' : 'Invalid' } };
    });
    const [a, b] = createDuplexPair();
    new RpcPeer(b, {
      inbound: ChargePointToCentralSystem,
      outbound: CentralSystemToChargePoint,
      handlers: registry,
      context: { tenant: 'T1' },
    });
    const client = new RpcPeer(a, {
      inbound: CentralSystemToChargePoint,
      outbound: ChargePointToCentralSystem,
    });
    await expect(client.call('Authorize', { idTag: 'T1' })).resolves.toEqual({
      idTagInfo: { status: 'Accepted' },
    });
    await expect(client.call('Authorize', { idTag: 'X' })).resolves.toEqual({
      idTagInfo: { status: 'Invalid' },
    });
    await client.close();
  });

  it('answers with NotSupported when a known action has no handler', async () => {
    const { cp } = peerPair();
    await expect(cp.call('Heartbeat', {})).rejects.toMatchObject({
      code: 'NotSupported',
      remote: true,
    });
  });

  it('answers with NotImplemented for actions outside the catalogue', async () => {
    const { next, remote } = rawPair();
    remote.send('[2,"m1","FlyToTheMoon",{}]');
    expect(await next()).toEqual([4, 'm1', 'NotImplemented', 'Unknown action FlyToTheMoon', {}]);
    // Prototype keys must not be mistaken for actions.
    remote.send('[2,"m2","toString",{}]');
    expect((await next())[2]).toBe('NotImplemented');
  });

  it('propagates RpcError codes thrown by handlers', async () => {
    const { cp, cs } = peerPair();
    cs.handle('Authorize', () => {
      throw new RpcError('SecurityError', 'Not registered', { hint: 'boot first' });
    });
    const error = await cp.call('Authorize', { idTag: 'A' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({
      code: 'SecurityError',
      message: 'Not registered',
      details: { hint: 'boot first' },
      remote: true,
    });
  });

  it('maps unexpected handler exceptions to InternalError without leaking the message', async () => {
    const { cp, cs } = peerPair();
    const handled: HandledCallEvent[] = [];
    cs.on('callHandled', (event) => handled.push(event));
    cs.handle('Authorize', () => {
      throw new Error('database password is hunter2');
    });
    const error = (await cp.call('Authorize', { idTag: 'A' }).catch((e: unknown) => e)) as RpcError;
    expect(error.code).toBe('InternalError');
    expect(error.message).not.toContain('hunter2');
    expect(handled[0]?.cause).toBeInstanceOf(Error);
  });
});

describe('RpcPeer validation', () => {
  it('rejects invalid outbound requests locally without sending anything', async () => {
    const { cp, cs } = peerPair();
    const sent: string[] = [];
    cp.on('message', (direction, raw) => direction === 'out' && sent.push(raw));
    const handler = vi.fn();
    cs.handle('BootNotification', handler);
    const incomplete = { chargePointVendor: 'A' };
    // @ts-expect-error -- chargePointModel is required
    const pending = cp.call('BootNotification', incomplete);
    const error = (await pending.catch((e: unknown) => e)) as RpcError;
    expect(error.code).toBe('OccurenceConstraintViolation');
    expect(error.remote).toBe(false);
    expect(sent).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers invalid inbound requests with the mapped CALLERROR code', async () => {
    const { cs, remote, next } = rawPair();
    const handler = vi.fn();
    cs.handle('StartTransaction', handler);
    remote.send(
      JSON.stringify([
        2,
        'm1',
        'StartTransaction',
        { connectorId: '1', idTag: 'A', meterStart: 0, timestamp: NOW },
      ]),
    );
    const reply = await next();
    expect(reply.slice(0, 3)).toEqual([4, 'm1', 'TypeConstraintViolation']);
    expect(reply[4]).toMatchObject({ errors: [{ path: '/connectorId' }] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('replies InternalError when our own handler produces an invalid response', async () => {
    const { cp, cs } = peerPair();
    // @ts-expect-error -- deliberately wrong status
    cs.handle('Authorize', () => ({ idTagInfo: { status: 'Maybe' } }));
    await expect(cp.call('Authorize', { idTag: 'A' })).rejects.toMatchObject({
      code: 'InternalError',
      remote: true,
    });
  });

  it('rejects the call when the remote sends an invalid CALLRESULT', async () => {
    const { cs, remote, next } = rawPair();
    const pending = cs.call('Reset', { type: 'Soft' });
    const [, id] = await next();
    remote.send(JSON.stringify([3, id, { status: 'Whatever' }]));
    await expect(pending).rejects.toMatchObject({
      code: 'PropertyConstraintViolation',
      remote: false,
    });
  });

  it('can disable validation per direction', async () => {
    const { cs, remote, next } = rawPair({ validateInbound: false, validateOutbound: false });
    cs.handle('Heartbeat', () => ({ currentTime: 'not a date' }));
    remote.send('[2,"h1","Heartbeat",{"unexpected":true}]');
    expect(await next()).toEqual([3, 'h1', { currentTime: 'not a date' }]);
  });

  it('still refuses to send non-object responses when validation is disabled', async () => {
    const { cs, remote, next } = rawPair({ validateOutbound: false });
    // @ts-expect-error -- deliberately wrong type
    cs.handle('Heartbeat', () => undefined);
    remote.send('[2,"h1","Heartbeat",{}]');
    expect((await next()).slice(0, 3)).toEqual([4, 'h1', 'InternalError']);
  });
});

describe('RpcPeer framing faults', () => {
  it('replies to malformed CALLs whose id can be recovered', async () => {
    const { cs, remote, next } = rawPair();
    const bad = vi.fn();
    cs.on('badMessage', bad);
    remote.send('[2,"m1","Heartbeat"]');
    expect(await next()).toEqual([4, 'm1', 'ProtocolError', expect.any(String), {}]);
    expect(bad).toHaveBeenCalledOnce();
  });

  it('ignores garbage whose id cannot be recovered but reports it', async () => {
    const { cs, remote, received } = rawPair();
    const bad = vi.fn();
    cs.on('badMessage', bad);
    remote.send('not json at all');
    await flush();
    expect(received).toHaveLength(0);
    expect(bad.mock.calls[0]?.[1]).toMatchObject({ code: 'FormationViolation' });
  });

  it('fails the outstanding call immediately when its response is malformed', async () => {
    const { cs, remote, next } = rawPair();
    const pending = cs.call('ClearCache', {});
    const [, id] = await next();
    remote.send(JSON.stringify([3, id]));
    await expect(pending).rejects.toMatchObject({ code: 'ProtocolError' });
  });

  it('ignores frames with an unknown message type even if their id matches our call', async () => {
    // Regression: such a frame used to fail the outstanding call with ProtocolError.
    const { cs, remote, next } = rawPair();
    const bad = vi.fn();
    cs.on('badMessage', bad);
    const pending = cs.call('ClearCache', {});
    const [, id] = await next();
    remote.send(JSON.stringify([7, id, { status: 'Accepted' }]));
    await flush();
    expect(bad).toHaveBeenCalledOnce();
    expect(cs.hasCallInFlight).toBe(true);
    remote.send(JSON.stringify([3, id, { status: 'Accepted' }]));
    await expect(pending).resolves.toEqual({ status: 'Accepted' });
  });

  it('answers a CALL that reuses the id of one still being handled with a CALLERROR', async () => {
    const { cs, remote, next } = rawPair();
    let release!: () => void;
    cs.handle('Heartbeat', async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { currentTime: NOW };
    });
    remote.send('[2,"dup","Heartbeat",{}]');
    await flush();
    remote.send('[2,"dup","Heartbeat",{}]');
    expect(await next()).toEqual([
      4,
      'dup',
      'GenericError',
      'A CALL with message id dup is already being handled',
      {},
    ]);
    release();
    expect(await next()).toEqual([3, 'dup', { currentTime: NOW }]);
    // Once answered, the id may be used again.
    remote.send('[2,"dup","Heartbeat",{}]');
    await flush();
    release();
    expect(await next()).toEqual([3, 'dup', { currentTime: NOW }]);
  });

  it('reports responses that match no outstanding call', async () => {
    const { cs, remote } = rawPair();
    const unmatched = vi.fn();
    cs.on('unmatchedResponse', unmatched);
    remote.send('[3,"nobody-asked",{}]');
    await flush();
    expect(unmatched).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'nobody-asked' }));
  });
});

describe('RpcPeer queueing (one outstanding CALL per direction)', () => {
  it('sends the next CALL only after the previous one is answered', async () => {
    const { cs, remote, next, received } = rawPair();
    const results: string[] = [];
    const first = cs.call('Reset', { type: 'Soft' }).then((r) => results.push(`reset:${r.status}`));
    const second = cs.call('ClearCache', {}).then((r) => results.push(`cache:${r.status}`));
    const third = cs
      .call('UnlockConnector', { connectorId: 1 })
      .then((r) => results.push(`unlock:${r.status}`));

    const call1 = await next();
    expect(call1[2]).toBe('Reset');
    await flush();
    expect(received).toHaveLength(0);
    expect(cs.queueLength).toBe(2);
    expect(cs.hasCallInFlight).toBe(true);

    remote.send(JSON.stringify([3, call1[1], { status: 'Accepted' }]));
    const call2 = await next();
    expect(call2[2]).toBe('ClearCache');
    remote.send(JSON.stringify([4, call2[1], 'GenericError', 'busy', {}]));
    const call3 = await next();
    expect(call3[2]).toBe('UnlockConnector');
    remote.send(JSON.stringify([3, call3[1], { status: 'Unlocked' }]));

    await first;
    await expect(second).rejects.toMatchObject({ code: 'GenericError', message: 'busy' });
    await third;
    expect(results).toEqual(['reset:Accepted', 'unlock:Unlocked']);
    expect(cs.queueLength).toBe(0);
    expect(cs.hasCallInFlight).toBe(false);
  });

  it('keeps directions independent: inbound CALLs are served while our CALL is pending', async () => {
    const { cp, cs } = peerPair();
    cp.handle('ClearCache', () => ({ status: 'Accepted' }));
    let releaseBoot!: () => void;
    cs.handle('BootNotification', async () => {
      await new Promise<void>((resolve) => (releaseBoot = resolve));
      return { status: 'Accepted', currentTime: NOW, interval: 10 };
    });
    const boot = cp.call('BootNotification', { chargePointVendor: 'A', chargePointModel: 'B' });
    await flush();
    await expect(cs.call('ClearCache', {})).resolves.toEqual({ status: 'Accepted' });
    releaseBoot();
    await expect(boot).resolves.toMatchObject({ status: 'Accepted' });
  });

  it('uses unique message ids for consecutive calls', async () => {
    const { cp, cs } = peerPair();
    const ids = new Set<string>();
    cs.on('callHandled', (event) => ids.add(event.messageId));
    cs.handle('Heartbeat', () => ({ currentTime: NOW }));
    await Promise.all(Array.from({ length: 25 }, () => cp.call('Heartbeat', {})));
    expect(ids.size).toBe(25);
  });
});

describe('RpcPeer timeouts', () => {
  it('times out a call, then continues with the queue and ignores the late answer', async () => {
    vi.useFakeTimers();
    const { cs, remote, next } = rawPair({ callTimeoutMs: 1_000 });
    const unmatched = vi.fn();
    cs.on('unmatchedResponse', unmatched);
    const first = cs.call('ClearCache', {});
    const firstError = first.catch((e: unknown) => e);
    const second = cs.call('Reset', { type: 'Hard' }, { timeoutMs: 5_000 });
    const call1 = await next();

    await vi.advanceTimersByTimeAsync(999);
    expect(cs.queueLength).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await firstError;
    expect(error).toBeInstanceOf(CallTimeoutError);
    expect(error).toMatchObject({ action: 'ClearCache', timeoutMs: 1_000 });

    const call2 = await next();
    expect(call2[2]).toBe('Reset');
    remote.send(JSON.stringify([3, call1[1], { status: 'Accepted' }]));
    await flush();
    expect(unmatched).toHaveBeenCalledOnce();

    remote.send(JSON.stringify([3, call2[1], { status: 'Accepted' }]));
    await expect(second).resolves.toEqual({ status: 'Accepted' });
  });

  it('does not time out after 1 ms when the timeout exceeds the timer range', async () => {
    vi.useFakeTimers();
    const { cs, remote, next } = rawPair({ callTimeoutMs: 2 ** 31 });
    const pending = cs.call('ClearCache', {});
    const [, id] = await next();
    await vi.advanceTimersByTimeAsync(1_000);
    remote.send(JSON.stringify([3, id, { status: 'Accepted' }]));
    await expect(pending).resolves.toEqual({ status: 'Accepted' });
  });

  it('starts the timeout clock when the frame is sent, not when it is queued', async () => {
    vi.useFakeTimers();
    const { cs, remote, next } = rawPair({ callTimeoutMs: 1_000 });
    const first = cs.call('ClearCache', {});
    const second = cs.call('ClearCache', {});
    const call1 = await next();
    await vi.advanceTimersByTimeAsync(900);
    remote.send(JSON.stringify([3, call1[1], { status: 'Accepted' }]));
    await first;
    const call2 = await next();
    await vi.advanceTimersByTimeAsync(900);
    remote.send(JSON.stringify([3, call2[1], { status: 'Rejected' }]));
    await expect(second).resolves.toEqual({ status: 'Rejected' });
  });
});

describe('RpcPeer cancellation and shutdown', () => {
  it('aborts queued and in-flight calls through AbortSignal', async () => {
    const { cs, next } = rawPair();
    const inflight = new AbortController();
    const queued = new AbortController();
    const first = cs.call('ClearCache', {}, { signal: inflight.signal });
    const second = cs.call('ClearCache', {}, { signal: queued.signal });
    const third = cs.call('Reset', { type: 'Soft' });
    await next();
    queued.abort();
    await expect(second).rejects.toBeInstanceOf(CallAbortedError);
    inflight.abort();
    await expect(first).rejects.toBeInstanceOf(CallAbortedError);
    expect((await next())[2]).toBe('Reset');
    void third.catch(() => undefined);
    await expect(cs.call('ClearCache', {}, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      CallAbortedError,
    );
  });

  it('rejects in-flight and queued calls when the connection closes', async () => {
    const { cs, remote, next } = rawPair();
    const closed = vi.fn();
    cs.on('close', closed);
    const first = cs.call('ClearCache', {});
    const second = cs.call('ClearCache', {});
    await next();
    remote.close(1001, 'going away');
    await expect(first).rejects.toBeInstanceOf(ConnectionClosedError);
    await expect(second).rejects.toMatchObject({ code: 1001, reason: 'going away' });
    expect(closed).toHaveBeenCalledWith(1001, 'going away');
    expect(cs.isOpen).toBe(false);
    await expect(cs.call('ClearCache', {})).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('close() resolves once the peer has observed the close', async () => {
    const { cp, cs } = peerPair();
    await cp.close(1000, 'bye');
    expect(cp.isOpen).toBe(false);
    await flush();
    expect(cs.isOpen).toBe(false);
    await cp.close();
  });

  it('rejects calls for actions outside the outbound catalogue', async () => {
    const { cp } = peerPair();
    // @ts-expect-error -- not a charge point initiated action
    await expect(cp.call('Reset', { type: 'Soft' })).rejects.toMatchObject({
      code: 'NotImplemented',
    });
    // Regression: prototype keys used to be mistaken for actions and threw synchronously.
    const untyped = cp as unknown as { call(action: string, payload: object): Promise<unknown> };
    await expect(untyped.call('toString', {})).rejects.toMatchObject({ code: 'NotImplemented' });
    await expect(untyped.call('constructor', {})).rejects.toMatchObject({
      code: 'NotImplemented',
    });
  });
});
