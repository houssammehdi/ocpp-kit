import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex as NodeDuplex } from 'node:stream';
import type { PeerCertificate, SecureVersion, TLSSocket } from 'node:tls';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CentralSystemToChargePoint, ChargePointToCentralSystem } from '../messages/index.js';
import { RpcError } from '../rpc/errors.js';
import type { JsonObject } from '../rpc/frames.js';
import { HandlerRegistry, type CallOptions, type RequestHandler } from '../rpc/peer.js';
import type { ActionName, RequestOf, ResponseOf } from '../rpc/validation.js';
import { OCPP16_SUBPROTOCOL } from '../transport/websocket.js';
import { TypedEventEmitter } from '../util/typed-emitter.js';
import { timerDelay } from '../util/timers.js';
import { parseBasicAuth, type Authenticator } from './auth.js';
import { certificateMatchesIdentity, type CertificateIdentityBinding } from './certificates.js';
import { ChargePointConnection, type CentralSystemHandlerContext } from './connection.js';

type Inbound = typeof ChargePointToCentralSystem;
type Outbound = typeof CentralSystemToChargePoint;

/** PEM material: one item or several (e.g. a certificate chain or several CAs). */
export type PemInput = string | Buffer | readonly (string | Buffer)[];

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
export interface CentralSystemOptions {
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
export interface CentralSystemCallEvent {
  readonly connection: ChargePointConnection;
  readonly action: string;
  readonly messageId: string;
  readonly request: JsonObject;
  readonly response?: JsonObject;
  readonly error?: RpcError;
  /** Exception thrown by the handler when it was not an {@link RpcError}. */
  readonly cause?: unknown;
  readonly durationMs: number;
}

/** Events emitted by {@link CentralSystem}. */
export interface CentralSystemEvents {
  connect: (connection: ChargePointConnection) => void;
  disconnect: (connection: ChargePointConnection, code: number, reason: string) => void;
  call: (event: CentralSystemCallEvent) => void;
  rejected: (info: {
    readonly reason: RejectionReason;
    readonly identity: string | undefined;
    readonly remoteAddress: string | undefined;
    /** Why, when there is more to say than the reason (e.g. which certificate check failed). */
    readonly detail?: string;
  }) => void;
  badMessage: (connection: ChargePointConnection, raw: string, error: RpcError) => void;
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
 * An OCPP 1.6-J Central System (CSMS) WebSocket server.
 *
 * ```ts
 * const cs = new CentralSystem();
 * cs.handle('BootNotification', () => ({ status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 }));
 * cs.on('connect', (cp) => console.log(`${cp.identity} connected`));
 * await cs.listen(9220);
 * ```
 */
export class CentralSystem extends TypedEventEmitter<CentralSystemEvents> {
  readonly #options: Required<
    Omit<CentralSystemOptions, 'authenticate' | 'tls' | 'clientCertificates'>
  > &
    Pick<CentralSystemOptions, 'authenticate' | 'tls' | 'clientCertificates'>;
  readonly #handlers = new HandlerRegistry<Inbound, CentralSystemHandlerContext>();
  readonly #connections = new Map<string, ChargePointConnection>();
  readonly #wss: WebSocketServer;
  #ownServer: Server | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  readonly #alive = new WeakSet<ChargePointConnection>();
  /** Identities whose latest BootNotification was accepted. */
  readonly #registered = new Set<string>();
  #closing = false;

  constructor(options: CentralSystemOptions = {}) {
    super();
    this.#options = {
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
      handleProtocols: (protocols) =>
        protocols.has(OCPP16_SUBPROTOCOL) ? OCPP16_SUBPROTOCOL : false,
    });
  }

  /** Currently connected charge points, keyed by identity. */
  get connections(): ReadonlyMap<string, ChargePointConnection> {
    return this.#connections;
  }

  /**
   * Register the handler for a Charge Point initiated action. Handlers receive the typed request
   * and a context holding the {@link ChargePointConnection}; they return the typed response.
   */
  handle<A extends ActionName<Inbound>>(
    action: A,
    handler: RequestHandler<Inbound, A, CentralSystemHandlerContext>,
  ): this {
    const guarded: RequestHandler<Inbound, A, CentralSystemHandlerContext> = async (
      payload,
      context,
    ) => {
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
        connection.lastBootNotification = payload as RequestOf<Inbound, 'BootNotification'>;
        const accepted =
          (response as ResponseOf<Inbound, 'BootNotification'>).status === 'Accepted';
        if (accepted) this.#registered.add(connection.identity);
        else this.#registered.delete(connection.identity);
        connection.bootAccepted = accepted;
      }
      return response;
    };
    this.#handlers.set(action, guarded);
    return this;
  }

  /** Send a typed CALL to a connected charge point. Rejects when it is not connected. */
  call<A extends ActionName<Outbound>>(
    identity: string,
    action: A,
    payload: RequestOf<Outbound, A>,
    options?: CallOptions,
  ): Promise<ResponseOf<Outbound, A>> {
    const connection = this.#connections.get(identity);
    if (!connection) {
      return Promise.reject(
        new RpcError('GenericError', `Charge point ${identity} is not connected`),
      );
    }
    return connection.call(action, payload, options);
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
      response.end('OCPP 1.6-J endpoint: connect with a WebSocket client\n');
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
    if (ws.protocol !== OCPP16_SUBPROTOCOL) {
      // OCPP-J: complete the handshake without a subprotocol, then close immediately.
      this.emit('rejected', {
        reason: 'subprotocol',
        identity,
        remoteAddress: request.socket.remoteAddress,
      });
      ws.close(1002, `Subprotocol ${OCPP16_SUBPROTOCOL} is required`);
      return;
    }
    const previous = this.#connections.get(identity);
    if (previous) void previous.close(4000, 'Replaced by a new connection');

    const connection = new ChargePointConnection(ws, identity, request, {
      handlers: this.#handlers,
      bootAccepted: this.#registered.has(identity),
      callTimeoutMs: this.#options.callTimeoutMs,
      validateInbound: this.#options.validateInbound,
      validateOutbound: this.#options.validateOutbound,
    });
    this.#connections.set(identity, connection);
    this.#alive.add(connection);
    ws.on('pong', () => this.#alive.add(connection));
    connection.peer.on('message', () => this.#alive.add(connection));
    connection.peer.on('callHandled', (event) => {
      this.emit('call', { connection, ...event });
    });
    connection.peer.on('badMessage', (raw, error) => {
      this.emit('badMessage', connection, raw, error);
    });
    connection.peer.once('close', (code, reason) => {
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
