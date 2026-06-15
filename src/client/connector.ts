import { WebSocket } from 'ws';
import type { Duplex } from '../rpc/duplex.js';
import { OcppKitError } from '../rpc/errors.js';
import { OCPP16_SUBPROTOCOL, webSocketDuplex } from '../transport/websocket.js';
import { timerDelay } from '../util/timers.js';

/** Parameters for opening a connection to a Central System. */
export interface ConnectRequest {
  /** Full endpoint URL including the charge point identity. */
  readonly url: string;
  /** Offered subprotocols, in preference order. */
  readonly protocols: readonly string[];
  /** Extra HTTP headers for the handshake, e.g. `Authorization`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly handshakeTimeoutMs: number;
  /**
   * Keep-alive: send a WebSocket ping this often and drop the connection (code 1006) when the
   * previous ping was not answered. 0 or absent disables pings.
   */
  readonly pingIntervalMs?: number;
}

/**
 * Opens a transport to the Central System. The default implementation uses `ws`; tests inject
 * in-memory duplexes to exercise reconnect and replay logic without sockets.
 */
export type Connector = (request: ConnectRequest) => Promise<Duplex>;

/** The WebSocket handshake failed (HTTP error status, wrong subprotocol, network error). */
export class HandshakeError extends OcppKitError {
  constructor(
    message: string,
    /** HTTP status of the refused handshake, when there was one. */
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

/** Ping `ws` every `intervalMs`; terminate it when a ping is still unanswered at the next one. */
function keepAlive(ws: WebSocket, intervalMs: number): void {
  if (!(intervalMs > 0)) return;
  let answered = true;
  ws.on('pong', () => {
    answered = true;
  });
  const timer = setInterval(() => {
    if (!answered) {
      ws.terminate();
      return;
    }
    answered = false;
    ws.ping();
  }, timerDelay(intervalMs));
  ws.once('close', () => {
    clearInterval(timer);
  });
}

/** Default {@link Connector} based on the `ws` package. */
export const webSocketConnector: Connector = (request) =>
  new Promise<Duplex>((resolve, reject) => {
    const ws = new WebSocket(request.url, [...request.protocols], {
      headers: { ...request.headers },
      handshakeTimeout: timerDelay(request.handshakeTimeoutMs),
    });
    let settled = false;
    const fail = (error: HandshakeError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    ws.on('error', (error) => {
      fail(new HandshakeError(error.message));
    });
    ws.once('unexpected-response', (req, res) => {
      fail(new HandshakeError(`Handshake refused with HTTP ${res.statusCode}`, res.statusCode));
      res.resume();
      req.destroy();
    });
    ws.once('close', (code) => {
      fail(new HandshakeError(`Connection closed during handshake (${code})`));
    });
    ws.once('open', () => {
      if (ws.protocol !== OCPP16_SUBPROTOCOL) {
        ws.terminate();
        fail(new HandshakeError(`Server did not accept subprotocol ${OCPP16_SUBPROTOCOL}`));
        return;
      }
      settled = true;
      keepAlive(ws, request.pingIntervalMs ?? 0);
      resolve(webSocketDuplex(ws));
    });
  });
