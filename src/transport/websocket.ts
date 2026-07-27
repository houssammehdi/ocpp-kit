import { WebSocket, type RawData } from 'ws';
import type { Duplex, DuplexHandlers } from '../rpc/duplex.js';
import { ConnectionClosedError } from '../rpc/errors.js';

/** WebSocket subprotocol negotiated for OCPP 1.6-J. */
export const OCPP16_SUBPROTOCOL = 'ocpp1.6';

/** WebSocket subprotocol negotiated for OCPP 2.0.1. */
export const OCPP201_SUBPROTOCOL = 'ocpp2.0.1';

/** A WebSocket subprotocol ocpp-kit speaks. */
export type OcppSubprotocol = typeof OCPP16_SUBPROTOCOL | typeof OCPP201_SUBPROTOCOL;

function decode(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * Adapt a `ws` WebSocket to the {@link Duplex} interface used by the RPC layer.
 *
 * Text and binary frames are both decoded as UTF-8; OCPP-J only uses text frames.
 */
export function webSocketDuplex(ws: WebSocket): Duplex {
  let attached = false;
  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send(data: string) {
      if (ws.readyState !== WebSocket.OPEN) throw new ConnectionClosedError();
      // Delivery errors surface as a 'close' event, which fails outstanding calls.
      ws.send(data, () => undefined);
    },
    close(code = 1000, reason = '') {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
      ws.close(code, reason);
    },
    attach(handlers: DuplexHandlers) {
      if (attached) throw new Error('Duplex already has a receiver');
      attached = true;
      ws.on('message', (data) => {
        handlers.message(decode(data));
      });
      ws.on('close', (code, reason) => {
        handlers.close(code, reason.toString('utf8'));
      });
      if (ws.readyState === WebSocket.CLOSED) {
        queueMicrotask(() => handlers.close(1006, 'Socket already closed'));
      }
    },
  };
}
