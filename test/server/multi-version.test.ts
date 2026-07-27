import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  CentralSystem,
  ChargePoint,
  ChargingStation,
  HandshakeError,
  RpcError,
  type AnyConnection,
  type CentralSystemOptions,
  type OcppSubprotocol,
} from '../../src/index.js';
import { nextEvent, NOW, until } from '../helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer<P extends OcppSubprotocol>(options: CentralSystemOptions<P>) {
  const cs = new CentralSystem(options);
  const { port } = await cs.listen(0, '127.0.0.1');
  cleanups.push(() => cs.close({ timeoutMs: 500 }));
  return { cs, url: `ws://127.0.0.1:${port}` };
}

const BOTH = {
  protocols: ['ocpp2.0.1', 'ocpp1.6'],
} as const satisfies CentralSystemOptions<OcppSubprotocol>;

function station(url: string, identity: string) {
  const cs = new ChargingStation({ identity, url, reconnect: false });
  cleanups.push(() => cs.close());
  return cs;
}

function chargePoint(url: string, identity: string) {
  const cp = new ChargePoint({ identity, url, reconnect: false });
  cleanups.push(() => cp.close());
  return cp;
}

/** Open a raw socket offering `protocols`; resolves once open with the negotiated protocol. */
async function raw(url: string, protocols: string[]): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols);
  ws.on('error', () => undefined);
  cleanups.push(async () => {
    ws.terminate();
    await Promise.resolve();
  });
  await new Promise((resolve) => ws.once('open', resolve));
  return ws;
}

function nextFrame(ws: WebSocket): Promise<unknown[]> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => {
      resolve(JSON.parse(data.toString('utf8')) as unknown[]);
    });
  });
}

describe('CentralSystem with OCPP 1.6 and 2.0.1 on one port', () => {
  it('negotiates the version per connection and routes to the typed handlers of each', async () => {
    const { cs, url } = await startServer(BOTH);
    expect(cs.protocols).toEqual(['ocpp2.0.1', 'ocpp1.6']);
    const seen: string[] = [];
    cs.handle('BootNotification', ({ chargePointModel }, { connection }) => {
      seen.push(`1.6 ${connection.identity} ${chargePointModel} ${connection.version}`);
      return { status: 'Accepted', currentTime: NOW, interval: 60 };
    });
    cs.v201.handle('BootNotification', ({ chargingStation, reason }, { connection }) => {
      seen.push(`2.0.1 ${connection.identity} ${chargingStation.model} ${reason}`);
      return { status: 'Accepted', currentTime: NOW, interval: 30 };
    });
    const versions = new Map<string, string>();
    cs.on('connect', (connection: AnyConnection) =>
      versions.set(connection.identity, connection.version),
    );

    const old = chargePoint(url, 'CP-16');
    const modern = station(url, 'CS-201');
    await Promise.all([old.connect(), modern.connect()]);
    const [a, b] = await Promise.all([
      old.call('BootNotification', { chargePointVendor: 'Acme', chargePointModel: 'W16' }),
      modern.call('BootNotification', {
        chargingStation: { vendorName: 'Acme', model: 'W201' },
        reason: 'PowerUp',
      }),
    ]);
    expect(a.interval).toBe(60);
    expect(b.interval).toBe(30);
    expect(modern.registrationStatus).toBe('Accepted');
    expect(seen.sort()).toEqual(['1.6 CP-16 W16 1.6', '2.0.1 CS-201 W201 PowerUp']);
    expect(Object.fromEntries(versions)).toEqual({ 'CP-16': '1.6', 'CS-201': '2.0.1' });
    const connection = cs.connections.get('CS-201');
    expect(connection?.protocol).toBe('ocpp2.0.1');
    expect(connection?.lastBootNotification).toMatchObject({ reason: 'PowerUp' });
  });

  it('sends typed calls to each version and refuses calls of the wrong one', async () => {
    const { cs, url } = await startServer(BOTH);
    const modern = station(url, 'CS-1');
    const old = chargePoint(url, 'CP-1');
    modern.handle('GetVariables', ({ getVariableData }) => ({
      getVariableResult: getVariableData.map(({ component, variable }) => ({
        attributeStatus: 'Accepted' as const,
        attributeValue: '300',
        component,
        variable,
      })),
    }));
    old.handle('Reset', () => ({ status: 'Accepted' }));
    await Promise.all([modern.connect(), old.connect()]);
    await until(() => cs.connections.size === 2);

    const response = await cs.v201.call('CS-1', 'GetVariables', {
      getVariableData: [
        { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
      ],
    });
    expect(response.getVariableResult[0]?.attributeValue).toBe('300');
    expect((await cs.call('CP-1', 'Reset', { type: 'Soft' })).status).toBe('Accepted');
    expect((await cs.v16.call('CP-1', 'Reset', { type: 'Hard' })).status).toBe('Accepted');

    await expect(cs.call('CS-1', 'Reset', { type: 'Soft' })).rejects.toThrow(/speaks OCPP 2\.0\.1/);
    await expect(cs.v201.call('CP-1', 'Reset', { type: 'Immediate' })).rejects.toThrow(
      /speaks OCPP 1\.6/,
    );
    await expect(cs.v201.call('nobody', 'Reset', { type: 'Immediate' })).rejects.toBeInstanceOf(
      RpcError,
    );
  });

  it('picks the first of its protocols that the charge point offers', async () => {
    const { url } = await startServer(BOTH);
    expect((await raw(`${url}/A`, ['ocpp1.6', 'ocpp2.0.1'])).protocol).toBe('ocpp2.0.1');
    expect((await raw(`${url}/B`, ['ocpp1.6'])).protocol).toBe('ocpp1.6');
    const { url: prefers16 } = await startServer({ protocols: ['ocpp1.6', 'ocpp2.0.1'] });
    expect((await raw(`${prefers16}/C`, ['ocpp2.0.1', 'ocpp1.6'])).protocol).toBe('ocpp1.6');
  });

  it('refuses a version it does not accept', async () => {
    const { cs, url } = await startServer({});
    const rejected = nextEvent(cs, 'rejected');
    const modern = station(url, 'CS-X');
    await expect(modern.connect()).rejects.toBeInstanceOf(HandshakeError);
    expect((await rejected)[0]).toMatchObject({ reason: 'subprotocol', identity: 'CS-X' });

    const { url: only201 } = await startServer({ protocols: ['ocpp2.0.1'] });
    await expect(chargePoint(only201, 'CP-X').connect()).rejects.toBeInstanceOf(HandshakeError);
    await station(only201, 'CS-OK').connect();
    expect(() => new CentralSystem({ protocols: [] })).toThrow(RangeError);
    expect(() => new CentralSystem({ protocols: ['ocpp2.1' as OcppSubprotocol] })).toThrow(
      RangeError,
    );
  });

  it('answers faults with the error codes of the negotiated version', async () => {
    const server = await startServer(BOTH);
    server.cs.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
    server.cs.v201.handle('Authorize', () => ({ idTokenInfo: { status: 'Accepted' } }));
    const modern = await raw(`${server.url}/RAW-201`, ['ocpp2.0.1']);
    const old = await raw(`${server.url}/RAW-16`, ['ocpp1.6']);
    const exchange = async (ws: WebSocket, frame: string) => {
      const answer = nextFrame(ws);
      ws.send(frame);
      return (await answer)[2];
    };
    const extra = '[2,"a","Authorize",{"idToken":{"idToken":"X","type":"Local"},"x":1}]';
    const extra16 = '[2,"a","Authorize",{"idTag":"X","x":1}]';
    expect(await exchange(modern, extra)).toBe('FormatViolation');
    expect(await exchange(old, extra16)).toBe('FormationViolation');
    expect(await exchange(modern, '[2,"b","Authorize",{}]')).toBe('OccurrenceConstraintViolation');
    expect(await exchange(old, '[2,"b","Authorize",{}]')).toBe('OccurenceConstraintViolation');
    expect(await exchange(modern, '[2,"c","Heartbeat"]')).toBe('RpcFrameworkError');
    expect(await exchange(old, '[2,"c","Heartbeat"]')).toBe('ProtocolError');
    expect(await exchange(modern, '[2,"d","Heartbeat","x"]')).toBe('FormatViolation');
    // A 1.6-only action is unknown to a 2.0.1 connection.
    expect(await exchange(modern, '[2,"e","StartTransaction",{}]')).toBe('NotImplemented');
    expect(await exchange(modern, '[2,"f","Heartbeat",{}]')).toBe('NotSupported');
  });

  it('keeps registrations per version with requireAcceptedBoot', async () => {
    const { cs, url } = await startServer({ ...BOTH, requireAcceptedBoot: true });
    cs.v201.handle('BootNotification', () => ({
      status: 'Accepted',
      currentTime: NOW,
      interval: 60,
    }));
    cs.v201.handle('Heartbeat', () => ({ currentTime: NOW }));
    const modern = station(url, 'CS-REG');
    await modern.connect();
    const refused = modern.call('Heartbeat', {});
    await expect(refused).rejects.toMatchObject({ code: 'SecurityError', remote: true });
    await modern.call('BootNotification', {
      chargingStation: { vendorName: 'Acme', model: 'M' },
      reason: 'PowerUp',
    });
    expect((await modern.call('Heartbeat', {})).currentTime).toBe(NOW);
    // The same identity over 1.6 is a different registration.
    await modern.close();
    await until(() => cs.connections.size === 0);
    cs.handle('Heartbeat', () => ({ currentTime: NOW }));
    const old = chargePoint(url, 'CS-REG');
    await old.connect();
    await expect(old.call('Heartbeat', {})).rejects.toMatchObject({ code: 'SecurityError' });
  });
});
