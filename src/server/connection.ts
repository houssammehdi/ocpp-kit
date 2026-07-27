import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
  OCPP16_PROTOCOL,
  OCPP201_PROTOCOL,
  type BootNotificationRequest,
  type CentralSystemToChargePoint,
  type ChargePointToCentralSystem,
  type ChargingStationToCsms,
  type CsmsToChargingStation,
  type v201,
} from '../messages/index.js';
import type { HandlerRegistry } from '../rpc/peer.js';
import { RpcPeer, type CallOptions } from '../rpc/peer.js';
import type { OcppProtocol } from '../rpc/protocol.js';
import type { ActionName, ActionSchemaMap, RequestOf, ResponseOf } from '../rpc/validation.js';
import { webSocketDuplex } from '../transport/websocket.js';

/** Context passed to every OCPP 1.6 Central System handler. */
export interface CentralSystemHandlerContext {
  /** The charge point that sent the request. */
  readonly connection: ChargePointConnection;
}

/** Context passed to every OCPP 2.0.1 CSMS handler (see `CentralSystem.v201`). */
export interface CsmsHandlerContext {
  /** The charging station that sent the request. */
  readonly connection: ChargingStationConnection;
}

/** Peer type used for one OCPP 1.6 charge point connection. */
export type CentralSystemPeer = RpcPeer<
  typeof ChargePointToCentralSystem,
  typeof CentralSystemToChargePoint,
  CentralSystemHandlerContext
>;

/** Peer type used for one OCPP 2.0.1 charging station connection. */
export type CsmsPeer = RpcPeer<
  typeof ChargingStationToCsms,
  typeof CsmsToChargingStation,
  CsmsHandlerContext
>;

/** Options used when creating a connection. */
export interface ConnectionOptions<
  In extends ActionSchemaMap = typeof ChargePointToCentralSystem,
  C extends object = CentralSystemHandlerContext,
> {
  readonly handlers: HandlerRegistry<In, C>;
  /** Whether this identity was already registered (accepted boot) earlier. */
  readonly bootAccepted: boolean;
  readonly callTimeoutMs: number;
  readonly validateInbound: boolean;
  readonly validateOutbound: boolean;
}

/**
 * What every connection of a `CentralSystem` has, whatever OCPP version it speaks: identity,
 * liveness, the RPC peer and typed calls.
 *
 * @typeParam V - the OCPP version, `'1.6'` or `'2.0.1'`
 * @typeParam In - actions the charge point sends
 * @typeParam Out - actions the central system sends
 * @typeParam C - handler context
 */
export abstract class OcppConnection<
  V extends string,
  In extends ActionSchemaMap,
  Out extends ActionSchemaMap,
  C extends object,
> {
  /** The OCPP version negotiated for this connection, e.g. `'2.0.1'`. */
  readonly version: V;
  /** The negotiated WebSocket subprotocol, e.g. `'ocpp2.0.1'`. */
  readonly protocol: string;
  /** Charge point identity (last URL path segment). */
  readonly identity: string;
  /** Remote IP address of the charge point. */
  readonly remoteAddress: string | undefined;
  /** When the WebSocket connection was established. */
  readonly connectedAt: Date;
  /** The underlying RPC peer. Exposed for advanced use such as protocol logging. */
  readonly peer: RpcPeer<In, Out, C>;
  /** Whether the charge point's latest BootNotification was answered with `Accepted`. */
  bootAccepted: boolean;
  /** Timestamp of the last frame received from the charge point. */
  lastSeen: Date;

  readonly #ws: WebSocket;
  readonly #closed: Promise<{ code: number; reason: string }>;

  protected constructor(
    protocol: OcppProtocol<V, In, Out>,
    ws: WebSocket,
    identity: string,
    request: IncomingMessage,
    options: ConnectionOptions<In, C>,
    context: C,
  ) {
    this.#ws = ws;
    this.version = protocol.version;
    this.protocol = protocol.subprotocol;
    this.identity = identity;
    this.remoteAddress = request.socket.remoteAddress;
    this.connectedAt = new Date();
    this.lastSeen = this.connectedAt;
    this.bootAccepted = options.bootAccepted;
    this.peer = new RpcPeer(webSocketDuplex(ws), {
      inbound: protocol.fromChargePoint,
      outbound: protocol.fromCentralSystem,
      handlers: options.handlers,
      context,
      errorCodes: protocol.errorCodes,
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
  call<A extends ActionName<Out>>(
    action: A,
    payload: RequestOf<Out, A>,
    options?: CallOptions,
  ): Promise<ResponseOf<Out, A>> {
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

/** A connected OCPP 1.6 charge point as seen by the Central System. */
export class ChargePointConnection extends OcppConnection<
  '1.6',
  typeof ChargePointToCentralSystem,
  typeof CentralSystemToChargePoint,
  CentralSystemHandlerContext
> {
  /** The most recent BootNotification received on this connection. */
  lastBootNotification: BootNotificationRequest | undefined;

  constructor(
    ws: WebSocket,
    identity: string,
    request: IncomingMessage,
    options: ConnectionOptions,
  ) {
    // Handlers see the connection itself; the context is read at every dispatch.
    const context: { connection?: ChargePointConnection } = {};
    super(OCPP16_PROTOCOL, ws, identity, request, options, context as CentralSystemHandlerContext);
    context.connection = this;
  }
}

/** A connected OCPP 2.0.1 charging station as seen by the CSMS. */
export class ChargingStationConnection extends OcppConnection<
  '2.0.1',
  typeof ChargingStationToCsms,
  typeof CsmsToChargingStation,
  CsmsHandlerContext
> {
  /** The most recent BootNotificationRequest received on this connection. */
  lastBootNotification: v201.BootNotificationRequest | undefined;

  constructor(
    ws: WebSocket,
    identity: string,
    request: IncomingMessage,
    options: ConnectionOptions<typeof ChargingStationToCsms, CsmsHandlerContext>,
  ) {
    const context: { connection?: ChargingStationConnection } = {};
    super(OCPP201_PROTOCOL, ws, identity, request, options, context as CsmsHandlerContext);
    context.connection = this;
  }
}

/** A connection of either OCPP version; `version` tells them apart. */
export type AnyConnection = ChargePointConnection | ChargingStationConnection;
