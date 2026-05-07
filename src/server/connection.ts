import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
  CentralSystemToChargePoint,
  ChargePointToCentralSystem,
  type BootNotificationRequest,
} from '../messages/index.js';
import type { HandlerRegistry } from '../rpc/peer.js';
import { RpcPeer, type CallOptions } from '../rpc/peer.js';
import type { ActionName, RequestOf, ResponseOf } from '../rpc/validation.js';
import { webSocketDuplex } from '../transport/websocket.js';

/** Context passed to every Central System handler. */
export interface CentralSystemHandlerContext {
  /** The charge point that sent the request. */
  readonly connection: ChargePointConnection;
}

/** Peer type used for one charge point connection. */
export type CentralSystemPeer = RpcPeer<
  typeof ChargePointToCentralSystem,
  typeof CentralSystemToChargePoint,
  CentralSystemHandlerContext
>;

/** Options used when creating a {@link ChargePointConnection}. */
export interface ConnectionOptions {
  readonly handlers: HandlerRegistry<
    typeof ChargePointToCentralSystem,
    CentralSystemHandlerContext
  >;
  readonly callTimeoutMs: number;
  readonly validateInbound: boolean;
  readonly validateOutbound: boolean;
}

/** A connected charge point as seen by the Central System. */
export class ChargePointConnection {
  /** Charge point identity (last URL path segment). */
  readonly identity: string;
  /** Remote IP address of the charge point. */
  readonly remoteAddress: string | undefined;
  /** When the WebSocket connection was established. */
  readonly connectedAt: Date;
  /** The underlying RPC peer. Exposed for advanced use such as protocol logging. */
  readonly peer: CentralSystemPeer;
  /** The most recent BootNotification received on this connection. */
  lastBootNotification: BootNotificationRequest | undefined;
  /** Whether a BootNotification on this connection was answered with `Accepted`. */
  bootAccepted = false;
  /** Timestamp of the last frame received from the charge point. */
  lastSeen: Date;

  readonly #ws: WebSocket;
  readonly #closed: Promise<{ code: number; reason: string }>;

  constructor(
    ws: WebSocket,
    identity: string,
    request: IncomingMessage,
    options: ConnectionOptions,
  ) {
    this.#ws = ws;
    this.identity = identity;
    this.remoteAddress = request.socket.remoteAddress;
    this.connectedAt = new Date();
    this.lastSeen = this.connectedAt;
    this.peer = new RpcPeer(webSocketDuplex(ws), {
      inbound: ChargePointToCentralSystem,
      outbound: CentralSystemToChargePoint,
      handlers: options.handlers,
      context: { connection: this },
      callTimeoutMs: options.callTimeoutMs,
      validateInbound: options.validateInbound,
      validateOutbound: options.validateOutbound,
    });
    this.peer.on('message', (direction) => {
      if (direction === 'in') this.lastSeen = new Date();
    });
    this.#closed = new Promise((resolve) => {
      this.peer.once('close', (code, reason) => {
        resolve({ code, reason });
      });
    });
  }

  /** Whether the connection is still open. */
  get isOpen(): boolean {
    return this.peer.isOpen;
  }

  /** Resolves with the close code and reason once the connection is closed. */
  get closed(): Promise<{ code: number; reason: string }> {
    return this.#closed;
  }

  /** Send a typed CALL to this charge point. */
  call<A extends ActionName<typeof CentralSystemToChargePoint>>(
    action: A,
    payload: RequestOf<typeof CentralSystemToChargePoint, A>,
    options?: CallOptions,
  ): Promise<ResponseOf<typeof CentralSystemToChargePoint, A>> {
    return this.peer.call(action, payload, options);
  }

  /** Close the connection gracefully. */
  close(code = 1000, reason = ''): Promise<void> {
    return this.peer.close(code, reason);
  }

  /** Drop the connection immediately without a closing handshake. */
  terminate(): void {
    this.#ws.terminate();
  }

  /** @internal Send a WebSocket ping; used by the server's liveness check. */
  ping(): void {
    this.#ws.ping();
  }
}
