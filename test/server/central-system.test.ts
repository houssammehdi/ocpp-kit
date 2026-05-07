import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  basicAuthHeader,
  CentralSystem,
  ChargePoint,
  HandshakeError,
  parseBasicAuth,
  RpcError,
  type CentralSystemCallEvent,
  type CentralSystemOptions,
} from '../../src/index.js';
import { nextEvent, NOW, until } from '../helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(options: CentralSystemOptions = {}) {
  const cs = new CentralSystem(options);
  const { port } = await cs.listen(0, '127.0.0.1');
  cleanups.push(() => cs.close({ timeoutMs: 500 }));
  return { cs, url: `ws://127.0.0.1:${port}`, port };
}

function client(
  url: string,
  identity: string,
  extra: Partial<ConstructorParameters<typeof ChargePoint>[0]> = {},
) {
  const cp = new ChargePoint({ identity, url, reconnect: false, ...extra });
  cleanups.push(() => cp.close());
  return cp;
}

function rawSocket(
  url: string,
  protocols: string[] = ['ocpp1.6'],
  options: ConstructorParameters<typeof WebSocket>[2] = {},
) {
  const ws = new WebSocket(url, protocols, options);
  ws.on('error', () => undefined);
  cleanups.push(async () => {
    ws.terminate();
    await Promise.resolve();
  });
  return ws;
}

describe('CentralSystem connections', () => {
  it('accepts ocpp1.6 clients, takes the identity from the path and dispatches typed calls', async () => {
    const { cs, url } = await startServer();
    cs.handle('BootNotification', (payload, { connection }) => {
      expect(connection.identity).toBe('CP-001');
      expect(payload.chargePointModel).toBe('Model');
      return { status: 'Accepted', currentTime: NOW, interval: 60 };
    });
    const calls: CentralSystemCallEvent[] = [];
    cs.on('call', (event) => calls.push(event));
    const connected = nextEvent(cs, 'connect');
    const cp = client(url, 'CP-001');
    await cp.connect();
    const [connection] = await connected;
    expect(connection.identity).toBe('CP-001');
    expect(cs.connections.get('CP-001')).toBe(connection);

    const response = await cp.call('BootNotification', {
      chargePointVendor: 'Vendor',
      chargePointModel: 'Model',
    });
    expect(response.status).toBe('Accepted');
    expect(connection.bootAccepted).toBe(true);
    expect(connection.lastBootNotification?.chargePointVendor).toBe('Vendor');
    await until(() => calls.length === 1);
    expect(calls[0]).toMatchObject({ action: 'BootNotification', response: { interval: 60 } });

    cp.handle('Reset', ({ type }) => ({ status: type === 'Soft' ? 'Accepted' : 'Rejected' }));
    await expect(cs.call('CP-001', 'Reset', { type: 'Soft' })).resolves.toEqual({
      status: 'Accepted',
    });
    await expect(connection.call('Reset', { type: 'Hard' })).resolves.toEqual({
      status: 'Rejected',
    });
  });

  it('decodes percent-encoded identities and honours the base path', async () => {
    const { cs, url } = await startServer({ basePath: '/ocpp/' });
    const rejected = nextEvent(cs, 'rejected');
    const wrong = rawSocket(`${url}/elsewhere/CP-1`);
    await new Promise((resolve) => wrong.once('close', resolve));
    expect((await rejected)[0]).toMatchObject({ reason: 'path' });

    const connected = nextEvent(cs, 'connect');
    const cp = client(`${url}/ocpp`, 'Station 7/A');
    await cp.connect();
    expect((await connected)[0].identity).toBe('Station 7/A');
  });

  it('rejects paths without an identity', async () => {
    const { cs, url } = await startServer();
    const rejected = nextEvent(cs, 'rejected');
    rawSocket(`${url}/`);
    expect((await rejected)[0].reason).toBe('path');
  });

  it('completes the handshake without a subprotocol and closes when ocpp1.6 is not offered', async () => {
    const { cs, url } = await startServer();
    const rejected = nextEvent(cs, 'rejected');
    const ws = rawSocket(`${url}/CP-1`, []);
    const [code] = await new Promise<[number]>((resolve) => ws.once('close', (c) => resolve([c])));
    expect(code).toBe(1002);
    expect((await rejected)[0]).toMatchObject({ reason: 'subprotocol', identity: 'CP-1' });
    expect(cs.connections.size).toBe(0);

    // A client that insists on another protocol fails its handshake.
    const other = rawSocket(`${url}/CP-2`, ['ocpp2.0.1']);
    const error = await new Promise<Error>((resolve) => other.once('error', resolve));
    expect(error.message).toMatch(/subprotocol/i);
  });

  it('answers plain HTTP requests with 426 Upgrade Required', async () => {
    const { port } = await startServer();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/CP-1' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(426);
  });
});

describe('CentralSystem security profile 1', () => {
  it('parses and builds Basic auth headers', () => {
    expect(parseBasicAuth(basicAuthHeader('CP-1', 'p:ss'))).toEqual({
      username: 'CP-1',
      password: 'p:ss',
    });
    expect(parseBasicAuth(undefined)).toBeUndefined();
    expect(parseBasicAuth('Bearer abc')).toBeUndefined();
    expect(parseBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeUndefined();
  });

  it('authenticates with HTTP Basic auth where the username is the identity', async () => {
    const seen: (string | undefined)[] = [];
    const { cs, url } = await startServer({
      authenticate: ({ identity, password }) => {
        seen.push(password);
        return identity === 'CP-1' && password === 'correct horse';
      },
    });
    const rejected = nextEvent(cs, 'rejected');
    const bad = client(url, 'CP-1', { password: 'wrong' });
    const error = await bad.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HandshakeError);
    expect((error as HandshakeError).statusCode).toBe(401);
    expect((await rejected)[0]).toMatchObject({ reason: 'auth', identity: 'CP-1' });

    const good = client(url, 'CP-1', { password: 'correct horse' });
    await good.connect();
    expect(cs.connections.has('CP-1')).toBe(true);
    expect(seen).toEqual(['wrong', 'correct horse']);
  });

  it('does not pass credentials issued for another identity and treats throwing hooks as denial', async () => {
    const seen: (string | undefined)[] = [];
    const { url } = await startServer({
      authenticate: ({ password }) => {
        seen.push(password);
        if (password === 'boom') throw new Error('backend down');
        return true;
      },
    });
    const ws = rawSocket(`${url}/CP-1`, ['ocpp1.6'], {
      headers: { Authorization: basicAuthHeader('CP-OTHER', 'secret') },
    });
    await new Promise((resolve) => ws.once('open', resolve));
    expect(seen).toEqual([undefined]);

    const failing = client(url, 'CP-2', { password: 'boom' });
    await expect(failing.connect()).rejects.toMatchObject({ statusCode: 401 });
  });

  it('can require an accepted BootNotification before other messages', async () => {
    const { cs, url } = await startServer({ requireAcceptedBoot: true });
    let status: 'Accepted' | 'Pending' = 'Pending';
    cs.handle('BootNotification', () => ({ status, currentTime: NOW, interval: 1 }));
    cs.handle('Heartbeat', () => ({ currentTime: NOW }));
    const cp = client(url, 'CP-1');
    await cp.connect();
    await expect(cp.call('Heartbeat', {})).rejects.toMatchObject({ code: 'SecurityError' });
    await cp.call('BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' });
    await expect(cp.call('Heartbeat', {})).rejects.toBeInstanceOf(RpcError);
    status = 'Accepted';
    await cp.call('BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' });
    await expect(cp.call('Heartbeat', {})).resolves.toEqual({ currentTime: NOW });
  });
});

describe('CentralSystem connection management', () => {
  it('replaces an existing connection with the same identity by default', async () => {
    const { cs, url } = await startServer();
    const first = client(url, 'CP-1');
    await first.connect();
    const oldConnection = cs.connections.get('CP-1')!;
    const closed = nextEvent(first, 'close');
    const second = client(url, 'CP-1');
    await second.connect();
    expect((await closed)[0]).toBe(4000);
    await until(() => cs.connections.get('CP-1') !== oldConnection);
    expect(cs.connections.size).toBe(1);
    expect(cs.connections.get('CP-1')?.isOpen).toBe(true);
  });

  it('can reject duplicate identities with HTTP 409', async () => {
    const { url } = await startServer({ duplicateConnection: 'reject' });
    await client(url, 'CP-1').connect();
    await expect(client(url, 'CP-1').connect()).rejects.toMatchObject({ statusCode: 409 });
  });

  it('terminates connections that stop answering pings', async () => {
    const { cs, url } = await startServer({ pingIntervalMs: 40 });
    const healthy = client(url, 'HEALTHY');
    await healthy.connect();
    const disconnected = nextEvent(cs, 'disconnect');
    rawSocket(`${url}/SILENT`, ['ocpp1.6'], { autoPong: false });
    const [connection, code] = await disconnected;
    expect(connection.identity).toBe('SILENT');
    expect(code).toBe(1006);
    expect(cs.connections.has('HEALTHY')).toBe(true);
  });

  it('rejects calls to unknown charge points', async () => {
    const { cs } = await startServer();
    await expect(cs.call('NOPE', 'ClearCache', {})).rejects.toMatchObject({
      code: 'GenericError',
    });
  });

  it('shuts down gracefully, closing every connection with 1001', async () => {
    const cs = new CentralSystem();
    const { port } = await cs.listen(0, '127.0.0.1');
    const url = `ws://127.0.0.1:${port}`;
    const clients = ['A', 'B', 'C'].map((id) => client(url, id));
    await Promise.all(clients.map((c) => c.connect()));
    const closes = clients.map((c) => nextEvent(c, 'close'));
    const disconnects: string[] = [];
    cs.on('disconnect', (connection) => disconnects.push(connection.identity));
    await cs.close();
    for (const [code] of await Promise.all(closes)) expect(code).toBe(1001);
    expect(disconnects.sort()).toEqual(['A', 'B', 'C']);
    expect(cs.connections.size).toBe(0);
    await expect(client(url, 'D').connect()).rejects.toBeInstanceOf(HandshakeError);
  });

  it('emits badMessage for malformed frames', async () => {
    const { cs, url } = await startServer();
    const ws = rawSocket(`${url}/CP-1`);
    await new Promise((resolve) => ws.once('open', resolve));
    const bad = nextEvent(cs, 'badMessage');
    ws.send('[2,"x"');
    const [connection, raw, error] = await bad;
    expect(connection.identity).toBe('CP-1');
    expect(raw).toBe('[2,"x"');
    expect(error.code).toBe('FormationViolation');
  });
});
