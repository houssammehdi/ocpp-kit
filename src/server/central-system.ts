import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex as NodeDuplex } from 'node:stream';
import type { PeerCertificate, SecureVersion, TLSSocket } from 'node:tls';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  CentralSystemToChargePoint,
  ChargePointToCentralSystem,
  ChargingStationToCsms,
  CsmsToChargingStation,
} from '../messages/index.js';
import { RpcError } from '../rpc/errors.js';
import type { JsonObject } from '../rpc/frames.js';
import {
  HandlerRegistry,
  type CallOptions,
  type CompletedCallEvent,
  type RequestHandler,
} from '../rpc/peer.js';
import type { ActionName, ActionSchemaMap, RequestOf, ResponseOf } from '../rpc/validation.js';
import {
  OCPP16_SUBPROTOCOL,
  OCPP201_SUBPROTOCOL,
  type OcppSubprotocol,
} from '../transport/websocket.js';
import { TypedEventEmitter } from '../util/typed-emitter.js';
import type { PemInput } from '../util/pem.js';
import { timerDelay } from '../util/timers.js';
import { parseBasicAuth, type Authenticator } from './auth.js';
import { certificateMatchesIdentity, type CertificateIdentityBinding } from './certificates.js';
import {
  ChargePointConnection,
  ChargingStationConnection,
  type AnyConnection,
  type CentralSystemHandlerContext,
  type CsmsHandlerContext,
} from './connection.js';

type Inbound = typeof ChargePointToCentralSystem;
type Outbound = typeof CentralSystemToChargePoint;
type Inbound201 = typeof ChargingStationToCsms;
type Outbound201 = typeof CsmsToChargingStation;

/** The connection class of each subprotocol. */
export interface ConnectionBySubprotocol {
  readonly 'ocpp1.6': ChargePointConnection;
  readonly 'ocpp2.0.1': ChargingStationConnection;
}

/** The connection type of a subprotocol (or of a union of them). */
export type ConnectionOf<P extends OcppSubprotocol> = ConnectionBySubprotocol[P];

/**
 * The handlers and calls of one OCPP version of a {@link CentralSystem}: `cs.v16` and `cs.v201`.
 * Both work whatever the server accepts; handlers of a version it does not accept never run.
 */
export interface VersionEndpoint<In extends ActionSchemaMap, Out extends ActionSchemaMap, C> {
  /** Register (or replace) the handler for an action the charge point initiates. */
  handle<A extends ActionName<In>>(
    action: A,
    handler: RequestHandler<In, A, C & object>,
  ): VersionEndpoint<In, Out, C>;
  /**
   * Send a typed CALL to a connected charge point of this version. Rejects when it is not
   * connected or speaks another version.
   */
  call<A extends ActionName<Out>>(
    identity: string,
    action: A,
    payload: RequestOf<Out, A>,
    options?: CallOptions,
  ): Promise<ResponseOf<Out, A>>;
}

export type { PemInput } from '../util/pem.js';

/**
 * TLS server settings for Security Profiles 2 and 3 (`wss://`). {@link CentralSystem.listen}
 * then creates an HTTPS server.
 */
export interface CentralSystemTlsOptions {
  /** Server certificate, optionally followed by intermediates (PEM). */
  readonly cert: PemInput;
  /** Private key of the server certificate (PEM). */
  readonly key: string | Buffer;
  /** Passphrase of an encrypted key. */
  readonly passphrase?: string;
  /** CAs that sign charge point certificates (Security Profile 3). */
  readonly ca?: PemInput;
  /**
   * Oldest accepted TLS version. Default: `TLSv1.2`, the minimum the OCPP 1.6 security
   * whitepaper allows.
   */
  readonly minVersion?: SecureVersion;
  /** OpenSSL cipher list, when the defaults must be narrowed. */
  readonly ciphers?: string;
}

/** Client certificate checks for Security Profile 3 (TLS with client certificates). */
export interface ClientCertificateOptions {
  /**
   * Refuse charge points that present no certificate. With `false`, a charge point without a
   * certificate may still connect (e.g. with Basic auth, Security Profile 2), but one that
   * presents an untrusted or mismatching certificate is refused. Default: true.
   */
  readonly required?: boolean;
  /**
   * How the identity in the URL must match the certificate, or `false` to accept any trusted
   * certificate for any identity. Default: `'cn-or-san'`.
   */
  readonly identityBinding?: CertificateIdentityBinding | false;
}

/** Options of {@link CentralSystem}. */
export interface CentralSystemOptions<P extends OcppSubprotocol = 'ocpp1.6'> {
  /**
   * WebSocket subprotocols to accept, in order of preference: when a charge point offers several,
   * the first of this list that it offers wins. `['ocpp2.0.1', 'ocpp1.6']` serves both versions
   * on one port. Default: `['ocpp1.6']`.
   */
  readonly protocols?: readonly P[];
  /**
   * URL path prefix. The charge point identity is the single path segment following it, e.g.
   * with `basePath: '/ocpp'` a charge point connects to `ws://host/ocpp/CP-001`. Default: `/`.
   */
  readonly basePath?: string;
  /**
   * Authentication hook for HTTP Basic auth (Security Profiles 1 and 2). It also sees the
   * verified client certificate, if any. Default: accept all.
   */
  readonly authenticate?: Authenticator;
  /** Serve `wss://` with this certificate (Security Profiles 2 and 3). */
  readonly tls?: CentralSystemTlsOptions;
  /**
   * Request and verify client certificates (Security Profile 3). The certificate must chain to
   * `tls.ca` (or, for {@link CentralSystem.attach}, to the CAs of your HTTPS server, which must
   * set `requestCert`) and match the identity.
   */
  readonly clientCertificates?: ClientCertificateOptions;
  /** Default timeout for CALLs sent to charge points. Default: 30 000 ms. */
  readonly callTimeoutMs?: number;
  /**
   * Interval of WebSocket pings; a connection that has not answered the previous ping is
   * terminated. `0` disables pinging. Default: 30 000 ms.
   */
  readonly pingIntervalMs?: number;
  /**
   * Answer every CALL other than BootNotification with `SecurityError` until the charge point
   * has received an `Accepted` BootNotification response. Registration is remembered per
   * identity for the lifetime of this server, because OCPP 1.6 charge points do not re-send
   * BootNotification after a mere reconnect. Default: false.
   */
  readonly requireAcceptedBoot?: boolean;
  /**
   * What to do when an identity connects while already connected: `replace` closes the old
   * connection (code 4000), `reject` refuses the new handshake with HTTP 409. Default: `replace`.
   */
  readonly duplicateConnection?: 'replace' | 'reject';
  /** Maximum accepted frame size in bytes. Default: 1 MiB. */
  readonly maxPayloadBytes?: number;
  /** Validate inbound requests and responses. Default: true. */
  readonly validateInbound?: boolean;
  /** Validate outbound requests and handler responses. Default: true. */
  readonly validateOutbound?: boolean;
}

/** Why a connection attempt was refused. */
export type RejectionReason =
  'path' | 'auth' | 'certificate' | 'subprotocol' | 'duplicate' | 'shutdown';

/** Emitted after an inbound CALL from a charge point was answered. */
export interface CentralSystemCallEvent<C extends AnyConnection = ChargePointConnection> {
  readonly connection: C;
  readonly action: string;
  readonly messageId: string;
  readonly request: JsonObject;
  readonly response?: JsonObject;
  readonly error?: RpcError;
  /** Exception thrown by the handler when it was not an {@link RpcError}. */
  readonly cause?: unknown;
  readonly durationMs: number;
}

/** Emitted after a CALL sent to a charge point settled (answered, failed or timed out). */
export interface CentralSystemCallCompletedEvent<
  C extends AnyConnection = ChargePointConnection,
> extends CompletedCallEvent {
  readonly connection: C;
}

/**
 * Events emitted by {@link CentralSystem}. `C` is the connection type: `ChargePointConnection`
 * for a 1.6-only server, a union discriminated by `version` for a multi-version one.
 */
export interface CentralSystemEvents<C extends AnyConnection = ChargePointConnection> {
  connect: (connection: C) => void;
  disconnect: (connection: C, code: number, reason: string) => void;
  /** An inbound CALL from a charge point was answered. */
  call: (event: CentralSystemCallEvent<C>) => void;
  /** A CALL sent to a charge point settled, with its round-trip time. */
  callCompleted: (event: CentralSystemCallCompletedEvent<C>) => void;
  /** Raw frame traffic of every connection, for protocol logging. */
  message: (connection: C, direction: 'in' | 'out', raw: string) => void;
  rejected: (info: {
    readonly reason: RejectionReason;
    readonly identity: string | undefined;
    readonly remoteAddress: string | undefined;
    /** Why, when there is more to say than the reason (e.g. which certificate check failed). */
    readonly detail?: string;
  }) => void;
  badMessage: (connection: C, raw: string, error: RpcError) => void;
}

/** Options of {@link CentralSystem.close}. */
export interface CloseOptions {
  /** WebSocket close code sent to charge points. Default: 1001 (going away). */
  readonly code?: number;
  readonly reason?: string;
  /** How long to wait for closing handshakes before terminating sockets. Default: 5 000 ms. */
  readonly timeoutMs?: number;
}

const DEFAULTS = {
  basePath: '/',
  callTimeoutMs: 30_000,
  pingIntervalMs: 30_000,
  maxPayloadBytes: 1024 * 1024,
} as const;

function normaliseBasePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function refuse(socket: NodeDuplex, status: number, message: string, headers: string[] = []): void {
  if (socket.destroyed) return;
  socket.end(
    [
      `HTTP/1.1 ${status} ${message}`,
      'Connection: close',
      'Content-Length: 0',
      ...headers,
      '',
      '',
    ].join('\r\n'),
  );
  socket.destroy();
}

/**
 * An OCPP-J Central System (CSMS) WebSocket server for OCPP 1.6 and 2.0.1.
 *
 * By default it speaks OCPP 1.6 only. With `protocols: ['ocpp2.0.1', 'ocpp1.6']` it serves both
 * versions on the same port: the subprotocol negotiated in the handshake decides, per
 * connection, which catalogue and error codes apply. `cs.handle()` and `cs.call()` are the
 * OCPP 1.6 API (also available as `cs.v16`); `cs.v201` is the OCPP 2.0.1 one. Connections carry
 * their `version`.
 *
 * ```ts
 * const cs = new CentralSystem({ protocols: ['ocpp2.0.1', 'ocpp1.6'] });
 * cs.handle('BootNotification', () => ({ status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 }));
 * cs.v201.handle('BootNotification', () => ({ status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 }));
 * cs.on('connect', (cp) => console.log(`${cp.identity} connected with OCPP ${cp.version}`));
 * await cs.listen(9220);
 * ```
 *
 * @typeParam P - the accepted subprotocols
 */
export class CentralSystem<P extends OcppSubprotocol = 'ocpp1.6'> extends TypedEventEmitter<
  CentralSystemEvents<ConnectionOf<P>>
> {
  /** The OCPP 1.6 handlers and calls (`cs.handle()` and `cs.call()` are shortcuts). */
  readonly v16: VersionEndpoint<Inbound, Outbound, CentralSystemHandlerContext>;
  /** The OCPP 2.0.1 handlers and calls. */
  readonly v201: VersionEndpoint<Inbound201, Outbound201, CsmsHandlerContext>;
  readonly #options: Required<
    Omit<CentralSystemOptions<P>, 'authenticate' | 'tls' | 'clientCertificates'>
  > &
    Pick<CentralSystemOptions<P>, 'authenticate' | 'tls' | 'clientCertificates'>;
  readonly #handlers = new HandlerRegistry<Inbound, CentralSystemHandlerContext>();
  readonly #handlers201 = new HandlerRegistry<Inbound201, CsmsHandlerContext>();
  readonly #connections = new Map<string, AnyConnection>();
  readonly #wss: WebSocketServer;
  #ownServer: Server | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  readonly #alive = new WeakSet<AnyConnection>();
  /** `<subprotocol> <identity>` of charge points whose latest BootNotification was accepted. */
  readonly #registered = new Set<string>();
  #closing = false;

  constructor(options: CentralSystemOptions<P> = {}) {
    super();
    const protocols = options.protocols ?? (['ocpp1.6'] as readonly OcppSubprotocol[] as P[]);
    if (protocols.length === 0) throw new RangeError('protocols must not be empty');
    for (const protocol of protocols) {
      if (protocol !== OCPP16_SUBPROTOCOL && protocol !== OCPP201_SUBPROTOCOL) {
        throw new RangeError(`Unsupported subprotocol ${String(protocol)}`);
      }
    }
    this.#options = {
      protocols,
      basePath: normaliseBasePath(options.basePath ?? DEFAULTS.basePath),
      authenticate: options.authenticate,
      tls: options.tls,
      clientCertificates: options.clientCertificates,
      callTimeoutMs: options.callTimeoutMs ?? DEFAULTS.callTimeoutMs,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULTS.pingIntervalMs,
      requireAcceptedBoot: options.requireAcceptedBoot ?? false,
      duplicateConnection: options.duplicateConnection ?? 'replace',
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes,
      validateInbound: options.validateInbound ?? true,
      validateOutbound: options.validateOutbound ?? true,
    };
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.#options.maxPayloadBytes,
      clientTracking: false,
      // The first subprotocol of our preference list that the charge point offers.
      handleProtocols: (offered) => protocols.find((protocol) => offered.has(protocol)) ?? false,
    });
    this.v16 = this.#endpoint(this.#handlers, '1.6');
    this.v201 = this.#endpoint(this.#handlers201, '2.0.1');
  }

  /** The accepted subprotocols, in order of preference. */
  get protocols(): readonly P[] {
    return this.#options.protocols;
  }

  /** Currently connected charge points, keyed by identity. */
  get connections(): ReadonlyMap<string, ConnectionOf<P>> {
    return this.#connections as unknown as ReadonlyMap<string, ConnectionOf<P>>;
  }

  /**
   * Register the handler for an OCPP 1.6 Charge Point initiated action. Handlers receive the
   * typed request and a context holding the {@link ChargePointConnection}; they return the typed
   * response. For OCPP 2.0.1 use `cs.v201.handle()`.
   */
  handle<A extends ActionName<Inbound>>(
    action: A,
    handler: RequestHandler<Inbound, A, CentralSystemHandlerContext>,
  ): this {
    this.v16.handle(action, handler);
    return this;
  }

  /**
   * Send a typed OCPP 1.6 CALL to a connected charge point. Rejects when it is not connected or
   * speaks OCPP 2.0.1 (use `cs.v201.call()` for those).
   */
  call<A extends ActionName<Outbound>>(
    identity: string,
    action: A,
    payload: RequestOf<Outbound, A>,
    options?: CallOptions,
  ): Promise<ResponseOf<Outbound, A>> {
    return this.v16.call(identity, action, payload, options);
  }

  /** The handler registration and calls of one version. */
  #endpoint<In extends ActionSchemaMap, Out extends ActionSchemaMap, C extends object>(
    registry: HandlerRegistry<In, C & { readonly connection: AnyConnection }>,
    version: AnyConnection['version'],
  ): VersionEndpoint<In, Out, C & { readonly connection: AnyConnection }> {
    const endpoint: VersionEndpoint<In, Out, C & { readonly connection: AnyConnection }> = {
      handle: (action, handler) => {
        registry.set(action, this.#guard(action, handler));
        return endpoint;
      },
      call: (identity, action, payload, options) => {
        const connection = this.#connections.get(identity);
        if (!connection) {
          return Promise.reject(
            new RpcError('GenericError', `Charge point ${identity} is not connected`),
          );
        }
        if (connection.version !== version) {
          return Promise.reject(
            new RpcError(
              'GenericError',
              `Charge point ${identity} speaks OCPP ${connection.version}, not ${version}`,
            ),
          );
        }
        const peer = connection.peer as unknown as {
          call(
            action: string,
            payload: unknown,
            options?: CallOptions,
          ): Promise<ResponseOf<Out, typeof action>>;
        };
        return peer.call(action, payload, options);
      },
    };
    return endpoint;
  }

  /**
   * Wrap a handler with the registration rules shared by both versions: `requireAcceptedBoot`
   * and the bookkeeping of BootNotification answers (both versions answer with a `status`).
   */
  #guard<In extends ActionSchemaMap, A extends ActionName<In>, C extends object>(
    action: A,
    handler: RequestHandler<In, A, C & { readonly connection: AnyConnection }>,
  ): RequestHandler<In, A, C & { readonly connection: AnyConnection }> {
    return async (payload, context) => {
      const { connection } = context;
      if (
        this.#options.requireAcceptedBoot &&
        action !== 'BootNotification' &&
        !connection.bootAccepted
      ) {
        throw new RpcError('SecurityError', 'BootNotification has not been accepted');
      }
      const response = await handler(payload, context);
      if (action === 'BootNotification') {
        (connection as { lastBootNotification: unknown }).lastBootNotification = payload;
        const accepted = (response as { readonly status: string }).status === 'Accepted';
        const key = `${connection.protocol} ${connection.identity}`;
        if (accepted) this.#registered.add(key);
        else this.#registered.delete(key);
        connection.bootAccepted = accepted;
      }
      return response;
    };
  }

  /**
   * Create an HTTP server (HTTPS with `tls`), attach to it and start listening.
   *
   * @returns the bound address; use port `0` to get an ephemeral port.
   */
  async listen(port = 0, host?: string): Promise<AddressInfo> {
    if (this.#ownServer) throw new Error('CentralSystem is already listening');
    const answerPlainHttp = (_request: IncomingMessage, response: ServerResponse): void => {
      response.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket' });
      response.end(
        `OCPP-J endpoint (${this.#options.protocols.join(', ')}): connect with a WebSocket client\n`,
      );
    };
    const { tls, clientCertificates } = this.#options;
    const server: Server | HttpsServer = tls
      ? createHttpsServer(
          {
            cert: tls.cert as string | Buffer | (string | Buffer)[],
            key: tls.key,
            ...(tls.passphrase === undefined ? {} : { passphrase: tls.passphrase }),
            ...(tls.ca === undefined
              ? {}
              : { ca: tls.ca as string | Buffer | (string | Buffer)[] }),
            ...(tls.ciphers === undefined ? {} : { ciphers: tls.ciphers }),
            minVersion: tls.minVersion ?? 'TLSv1.2',
            // Certificates are checked in the upgrade handler, so a refused charge point gets an
            // HTTP answer and a `rejected` event instead of a bare TLS alert.
            requestCert: clientCertificates !== undefined,
            rejectUnauthorized: false,
          },
          answerPlainHttp,
        )
      : createServer(answerPlainHttp);
    this.#ownServer = server;
    this.attach(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server.address() as AddressInfo;
  }

  /**
   * Attach to an existing HTTP or HTTPS server, handling its WebSocket upgrade requests. Use an
   * `https.Server` to terminate TLS yourself (e.g. for Security Profile 2).
   */
  attach(server: Server | HttpsServer): this {
    server.on('upgrade', (request: IncomingMessage, socket: NodeDuplex, head: Buffer) => {
      void this.#onUpgrade(request, socket, head);
    });
    this.#startPinging();
    return this;
  }

  /**
   * Gracefully shut down: refuse new connections, close every charge point connection (waiting
   * up to `timeoutMs` for closing handshakes), then close the HTTP server if we own it.
   */
  async close(options: CloseOptions = {}): Promise<void> {
    const { code = 1001, reason = 'Server shutting down', timeoutMs = 5_000 } = options;
    this.#closing = true;
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
    const connections = [...this.#connections.values()];
    const allClosed = Promise.all(connections.map((connection) => connection.closed));
    for (const connection of connections) void connection.close(code, reason);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timerDelay(timeoutMs));
    });
    await Promise.race([allClosed, timedOut]);
    clearTimeout(timer);
    for (const connection of connections) {
      if (connection.isOpen) connection.terminate();
    }
    this.#wss.close();
    const server = this.#ownServer;
    this.#ownServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    }
  }

  #identityFrom(url: string | undefined): string | undefined {
    const { pathname } = new URL(url ?? '/', 'http://localhost');
    const base = this.#options.basePath === '/' ? '' : this.#options.basePath;
    if (!pathname.startsWith(`${base}/`)) return undefined;
    const rest = pathname.slice(base.length + 1);
    if (rest.length === 0 || rest.includes('/')) return undefined;
    try {
      const identity = decodeURIComponent(rest);
      return identity.length > 0 && identity.length <= 255 ? identity : undefined;
    } catch {
      return undefined;
    }
  }

  async #onUpgrade(request: IncomingMessage, socket: NodeDuplex, head: Buffer): Promise<void> {
    socket.on('error', () => undefined);
    const remoteAddress = request.socket.remoteAddress;
    const rejectWith = (
      reason: RejectionReason,
      identity: string | undefined,
      status: number,
      message: string,
      headers?: string[],
      detail?: string,
    ): void => {
      this.emit('rejected', {
        reason,
        identity,
        remoteAddress,
        ...(detail === undefined ? {} : { detail }),
      });
      refuse(socket, status, message, headers);
    };

    if (this.#closing) {
      rejectWith('shutdown', undefined, 503, 'Service Unavailable');
      return;
    }
    const identity = this.#identityFrom(request.url);
    if (identity === undefined) {
      rejectWith('path', undefined, 404, 'Not Found');
      return;
    }
    const certificate = this.#verifyClientCertificate(request, identity);
    if (typeof certificate === 'string') {
      rejectWith('certificate', identity, 403, 'Forbidden', [], certificate);
      return;
    }
    const { authenticate } = this.#options;
    if (authenticate) {
      const credentials = parseBasicAuth(request.headers.authorization);
      const password = credentials?.username === identity ? credentials.password : undefined;
      let allowed: boolean;
      try {
        allowed = await authenticate({
          identity,
          password,
          request,
          ...(certificate ? { certificate } : {}),
        });
      } catch {
        allowed = false;
      }
      if (!allowed) {
        rejectWith('auth', identity, 401, 'Unauthorized', ['WWW-Authenticate: Basic realm="OCPP"']);
        return;
      }
    }
    if (this.#options.duplicateConnection === 'reject' && this.#connections.has(identity)) {
      rejectWith('duplicate', identity, 409, 'Conflict');
      return;
    }
    if (socket.destroyed || this.#isClosing()) return;
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#onConnection(ws, request, identity);
    });
  }

  /**
   * Security Profile 3 checks. Returns the verified client certificate, `undefined` when none is
   * needed or presented (and none is required), or a string describing why the charge point must
   * be refused.
   */
  #verifyClientCertificate(
    request: IncomingMessage,
    identity: string,
  ): PeerCertificate | undefined | string {
    const options = this.#options.clientCertificates;
    if (!options) return undefined;
    const socket = request.socket as Partial<TLSSocket>;
    if (typeof socket.getPeerCertificate !== 'function') return 'not a TLS connection';
    const certificate = socket.getPeerCertificate();
    // Without a client certificate Node returns an empty object.
    if (Object.keys(certificate).length === 0) {
      return (options.required ?? true) ? 'no client certificate' : undefined;
    }
    if (socket.authorized !== true) {
      const error: unknown = socket.authorizationError;
      return `untrusted client certificate (${error instanceof Error ? error.message : String(error)})`;
    }
    const binding = options.identityBinding ?? 'cn-or-san';
    if (binding !== false && !certificateMatchesIdentity(identity, certificate, binding)) {
      return 'client certificate does not belong to this identity';
    }
    return certificate;
  }

  /** Re-reads the flag; TypeScript would otherwise keep its narrowing across `await`. */
  #isClosing(): boolean {
    return this.#closing;
  }

  #onConnection(ws: WebSocket, request: IncomingMessage, identity: string): void {
    ws.on('error', () => undefined);
    const protocol = this.#options.protocols.find((candidate) => candidate === ws.protocol);
    if (protocol === undefined) {
      // OCPP-J: complete the handshake without a subprotocol, then close immediately.
      this.emit('rejected', {
        reason: 'subprotocol',
        identity,
        remoteAddress: request.socket.remoteAddress,
      });
      ws.close(1002, `Subprotocol ${this.#options.protocols.join(' or ')} is required`);
      return;
    }
    const previous = this.#connections.get(identity);
    if (previous) void previous.close(4000, 'Replaced by a new connection');

    const common = {
      bootAccepted: this.#registered.has(`${protocol} ${identity}`),
      callTimeoutMs: this.#options.callTimeoutMs,
      validateInbound: this.#options.validateInbound,
      validateOutbound: this.#options.validateOutbound,
    };
    const connection: AnyConnection =
      protocol === OCPP201_SUBPROTOCOL
        ? new ChargingStationConnection(ws, identity, request, {
            ...common,
            handlers: this.#handlers201,
          })
        : new ChargePointConnection(ws, identity, request, { ...common, handlers: this.#handlers });
    this.#track(connection, ws);
  }

  /** Register a new connection and forward its events. */
  #track(anyConnection: AnyConnection, ws: WebSocket): void {
    const connection = anyConnection as ConnectionOf<P>;
    const { identity } = connection;
    // The peer's own type differs per version; its events do not.
    const peer = connection.peer as unknown as ChargePointConnection['peer'];
    this.#connections.set(identity, connection);
    this.#alive.add(connection);
    ws.on('pong', () => this.#alive.add(connection));
    peer.on('message', () => this.#alive.add(connection));
    peer.on('callHandled', (event) => {
      this.emit('call', { connection, ...event });
    });
    peer.on('callCompleted', (event) => {
      this.emit('callCompleted', { connection, ...event });
    });
    peer.on('message', (direction, raw) => {
      this.emit('message', connection, direction, raw);
    });
    peer.on('badMessage', (raw, error) => {
      this.emit('badMessage', connection, raw, error);
    });
    peer.once('close', (code, reason) => {
      if (this.#connections.get(identity) === connection) this.#connections.delete(identity);
      this.emit('disconnect', connection, code, reason);
    });
    this.emit('connect', connection);
  }

  #startPinging(): void {
    const interval = this.#options.pingIntervalMs;
    if (interval <= 0 || this.#pingTimer) return;
    this.#pingTimer = setInterval(() => {
      for (const connection of this.#connections.values()) {
        if (!this.#alive.has(connection)) {
          connection.terminate();
          continue;
        }
        this.#alive.delete(connection);
        connection.ping();
      }
    }, timerDelay(interval));
    this.#pingTimer.unref();
  }
}
