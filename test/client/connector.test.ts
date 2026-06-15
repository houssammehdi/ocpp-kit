import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { webSocketConnector } from '../../src/index.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(autoPong: boolean): Promise<string> {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    autoPong,
    handleProtocols: () => 'ocpp1.6',
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(resolve);
      }),
  );
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/CP-1`;
}

function connect(url: string, pingIntervalMs: number) {
  return webSocketConnector({
    url,
    protocols: ['ocpp1.6'],
    headers: {},
    handshakeTimeoutMs: 2_000,
    pingIntervalMs,
  });
}

describe('webSocketConnector keep-alive', () => {
  it('drops a connection whose pings go unanswered', async () => {
    const duplex = await connect(await server(false), 30);
    const started = Date.now();
    const code = await new Promise<number>((resolve) => {
      duplex.attach({ message: () => undefined, close: (closeCode) => resolve(closeCode) });
    });
    expect(code).toBe(1006);
    // The first ping goes out after one interval and is found unanswered at the second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('keeps a connection whose pings are answered', async () => {
    const duplex = await connect(await server(true), 20);
    let closed = false;
    duplex.attach({
      message: () => undefined,
      close: () => {
        closed = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(closed).toBe(false);
    expect(duplex.isOpen).toBe(true);
    duplex.close();
  });
});
