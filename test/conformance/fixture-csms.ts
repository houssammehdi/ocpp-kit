import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ChargePointToCentralSystem,
  ChargingStationToCsms,
  OCPP16_ERROR_CODES,
  OCPP201_ERROR_CODES,
  validatePayload,
  type ActionSchemaMap,
} from '../../src/index.js';

/**
 * Ways the fixture Central System can be broken, each violating what one conformance check
 * verifies (the comment names the check).
 */
export const BREAKAGES = [
  'no-subprotocol', // ws.subprotocol
  'accept-any-subprotocol', // ws.subprotocol-refusal
  'ignore-password', // ws.basic-auth
  'accept-without-certificate', // tls.client-certificate
  'no-pong', // ws.ping
  'keep-duplicates', // ws.duplicate-connection
  'boot-invalid', // boot.response
  'boot-interval-zero', // boot.interval
  'boot-clock-skew', // boot.clock
  'heartbeat-invalid', // heartbeat.response
  'status0-error', // status.connector0
  'status-invalid', // status.connector
  'authorize-invalid', // authorize.response
  'start-invalid', // transaction.start
  'meter-values-error', // transaction.meter-values
  'stop-invalid', // transaction.stop
  'main-meter-error', // meter-values.no-transaction
  'same-transaction-id', // transaction.id-unique
  'replay-new-id', // transaction.start-replay
  'stop-unknown-error', // transaction.stop-unknown
  'data-transfer-accepted', // data-transfer.unknown-vendor
  'ignore-unknown-action', // rpc.unknown-action
  'unknown-action-not-supported', // rpc.unknown-action-code
  'no-validation', // rpc.invalid-payload
  'ignore-malformed-frames', // rpc.malformed-frame
  'close-on-bad-json', // rpc.malformed-json
  'answer-unknown-type', // rpc.unknown-message-type
  'answer-unmatched', // rpc.unmatched-response
  'slow', // latency
  'concurrent-calls', // rpc.single-outstanding-call
  'invalid-server-call', // rpc.server-calls
] as const;

/** Breakages of the checks only the OCPP 2.0.1 suite has. */
export const BREAKAGES_201 = [
  'updated-error', // transaction.updated
  'ended-invalid', // transaction.ended
  'offline-error', // transaction.offline
  'replay-error', // transaction.replay
  'ended-unknown-error', // transaction.ended-unknown
  'security-event-error', // security-event.response
  'v16-error-codes', // rpc.error-codes
  'message-type-not-supported', // rpc.unknown-message-type still passes (tolerated code)
] as const;

/** One way to break the fixture. */
export type Breakage = (typeof BREAKAGES)[number] | (typeof BREAKAGES_201)[number];

/** Options of {@link FixtureCsms}. */
export interface FixtureOptions {
  readonly breakages?: readonly Breakage[];
  /** Require this Basic auth password. */
  readonly password?: string;
  /** Serve wss://; with `ca`, require client certificates issued by it. */
  readonly tls?: { readonly cert: string; readonly key: string; readonly ca?: string };
  /** Delay of every answer with the `slow` breakage. Default: 50 ms. */
  readonly slowMs?: number;
  /** Registration status handed out. Default: Accepted. */
  readonly bootStatus?: 'Accepted' | 'Pending' | 'Rejected';
  /** The OCPP version spoken. Default: `ocpp1.6`. */
  readonly protocol?: 'ocpp1.6' | 'ocpp2.0.1';
}

type Answer = { readonly payload: Record<string, unknown> } | { readonly error: string };

/**
 * A deliberately small OCPP 1.6-J or 2.0.1 Central System written directly on `ws`, without
 * ocpp-kit's RPC layer, so that it can break the protocol in ways the library never would.
 * Without breakages it passes every conformance check of its version.
 */
export class FixtureCsms {
  readonly #options: FixtureOptions;
  readonly #broken: ReadonlySet<Breakage>;
  readonly #server: Server;
  readonly #wss: WebSocketServer;
  readonly #connections = new Map<string, WebSocket[]>();
  readonly #starts = new Map<string, number>();
  readonly #transactions = new Set<number>();
  /** 2.0.1: seqNos seen per transaction. */
  readonly #events = new Map<string, Set<number>>();
  #nextTransactionId = 1;

  constructor(options: FixtureOptions = {}) {
    this.#options = options;
    this.#broken = new Set(options.breakages);
    const { tls } = options;
    this.#server = tls
      ? createHttpsServer({
          cert: tls.cert,
          key: tls.key,
          ...(tls.ca ? { ca: tls.ca, requestCert: true, rejectUnauthorized: false } : {}),
        })
      : createServer();
    this.#wss = new WebSocketServer({
      noServer: true,
      autoPong: !this.broken('no-pong'),
      handleProtocols: (protocols) => {
        if (this.broken('no-subprotocol')) return false;
        if (protocols.has(this.protocol)) return this.protocol;
        return this.broken('accept-any-subprotocol') ? ([...protocols][0] ?? false) : false;
      },
    });
    this.#server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.#onUpgrade(request, socket, head);
    });
  }

  /** The subprotocol spoken. */
  get protocol(): 'ocpp1.6' | 'ocpp2.0.1' {
    return this.#options.protocol ?? 'ocpp1.6';
  }

  /** The charge point actions of the version. */
  get catalogue(): ActionSchemaMap {
    return this.protocol === 'ocpp2.0.1' ? ChargingStationToCsms : ChargePointToCentralSystem;
  }

  /** The error codes used, which `v16-error-codes` makes the 1.6 ones on a 2.0.1 connection. */
  get errorCodes() {
    return this.protocol === 'ocpp2.0.1' && !this.broken('v16-error-codes')
      ? OCPP201_ERROR_CODES
      : OCPP16_ERROR_CODES;
  }

  /** Whether `breakage` is switched on. */
  broken(breakage: Breakage): boolean {
    return this.#broken.has(breakage);
  }

  /** Start listening on an ephemeral port; resolves with the endpoint URL. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address() as AddressInfo;
    return `${this.#options.tls ? 'wss' : 'ws'}://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const sockets of this.#connections.values()) {
      for (const ws of sockets) ws.terminate();
    }
    this.#wss.close();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  #onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: string): void => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const identity = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname.slice(1));
    const { password, tls } = this.#options;
    if (tls?.ca && !this.broken('accept-without-certificate')) {
      if (!(request.socket as TLSSocket).authorized) {
        refuse('403 Forbidden');
        return;
      }
    }
    if (password !== undefined && !this.broken('ignore-password')) {
      const expected = `Basic ${Buffer.from(`${identity}:${password}`).toString('base64')}`;
      if (request.headers.authorization !== expected) {
        refuse('401 Unauthorized');
        return;
      }
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#onConnection(ws, identity);
    });
  }

  #onConnection(ws: WebSocket, identity: string): void {
    if (ws.protocol !== this.protocol && !this.broken('accept-any-subprotocol')) {
      ws.close(1002, `${this.protocol} is required`);
      return;
    }
    const sockets = this.#connections.get(identity) ?? [];
    if (!this.broken('keep-duplicates')) {
      for (const previous of sockets) previous.close(4000, 'Replaced by a new connection');
    }
    this.#connections.set(identity, [...sockets, ws]);
    ws.on('close', () => {
      this.#connections.set(
        identity,
        (this.#connections.get(identity) ?? []).filter((other) => other !== ws),
      );
    });
    new FixtureSession(this, ws);
  }

  /** The Central System logic: answer one valid Charge Point request. */
  answer(action: string, payload: Record<string, unknown>): Answer {
    if (this.protocol === 'ocpp2.0.1') return this.#answer201(action, payload);
    return this.#answer16(action, payload);
  }

  #answer16(action: string, payload: Record<string, unknown>): Answer {
    const currentTime = new Date().toISOString();
    switch (action) {
      case 'BootNotification':
        return {
          payload: {
            status: this.#options.bootStatus ?? 'Accepted',
            ...(this.broken('boot-invalid') ? {} : { currentTime }),
            interval: this.broken('boot-interval-zero') ? 0 : 300,
            ...(this.broken('boot-clock-skew')
              ? { currentTime: new Date(Date.now() + 3_600_000).toISOString() }
              : {}),
          },
        };
      case 'Heartbeat':
        return {
          payload: {
            currentTime: this.broken('heartbeat-invalid') ? '2026-09-25 12:00' : currentTime,
          },
        };
      case 'StatusNotification':
        if (payload.connectorId === 0 && this.broken('status0-error')) {
          return { error: 'PropertyConstraintViolation' };
        }
        return {
          payload: payload.connectorId !== 0 && this.broken('status-invalid') ? { ok: true } : {},
        };
      case 'Authorize':
        return {
          payload: this.broken('authorize-invalid')
            ? { status: 'Accepted' }
            : { idTagInfo: { status: 'Accepted' } },
        };
      case 'StartTransaction': {
        const fingerprint = JSON.stringify(payload);
        let transactionId = this.broken('replay-new-id')
          ? undefined
          : this.#starts.get(fingerprint);
        if (transactionId === undefined) {
          transactionId = this.broken('same-transaction-id') ? 1 : this.#nextTransactionId++;
          this.#starts.set(fingerprint, transactionId);
          this.#transactions.add(transactionId);
        }
        return {
          payload: {
            idTagInfo: { status: 'Accepted' },
            transactionId: this.broken('start-invalid') ? `T-${transactionId}` : transactionId,
          },
        };
      }
      case 'MeterValues':
        if (payload.transactionId === undefined && this.broken('main-meter-error')) {
          return { error: 'InternalError' };
        }
        if (payload.transactionId !== undefined && this.broken('meter-values-error')) {
          return { error: 'InternalError' };
        }
        return { payload: {} };
      case 'StopTransaction': {
        const known = this.#transactions.delete(payload.transactionId as number);
        if (!known && this.broken('stop-unknown-error'))
          return { error: 'PropertyConstraintViolation' };
        if (known && this.broken('stop-invalid'))
          return { payload: { idTagInfo: { status: 'Fine' } } };
        return { payload: known ? { idTagInfo: { status: 'Accepted' } } : {} };
      }
      case 'DataTransfer':
        return {
          payload: {
            status: this.broken('data-transfer-accepted') ? 'Accepted' : 'UnknownVendorId',
          },
        };
      default:
        return { payload: {} };
    }
  }

  #answer201(action: string, payload: Record<string, unknown>): Answer {
    const currentTime = new Date().toISOString();
    switch (action) {
      case 'BootNotification':
      case 'Heartbeat':
      case 'DataTransfer':
        // Same shapes as in 1.6.
        return this.#answer16(action, payload);
      case 'StatusNotification':
        return { payload: this.broken('status-invalid') ? { ok: true } : {} };
      case 'Authorize':
        return {
          payload: this.broken('authorize-invalid')
            ? { status: 'Accepted' }
            : { idTokenInfo: { status: 'Accepted' } },
        };
      case 'TransactionEvent': {
        const info = payload.transactionInfo as { transactionId: string };
        const seqNo = payload.seqNo as number;
        const seen = this.#events.get(info.transactionId);
        const known = seen !== undefined;
        if (seen?.has(seqNo) && this.broken('replay-error'))
          return { error: 'PropertyConstraintViolation' };
        if (payload.offline === true && this.broken('offline-error'))
          return { error: 'InternalError' };
        const events = seen ?? new Set<number>();
        events.add(seqNo);
        if (payload.eventType === 'Started') this.#events.set(info.transactionId, events);
        switch (payload.eventType) {
          case 'Started':
            return {
              payload: {
                idTokenInfo: { status: this.broken('start-invalid') ? 'Fine' : 'Accepted' },
              },
            };
          case 'Updated':
            return this.broken('updated-error') ? { error: 'InternalError' } : { payload: {} };
          default:
            if (!known && this.broken('ended-unknown-error'))
              return { error: 'PropertyConstraintViolation' };
            if (known && this.broken('ended-invalid')) return { payload: { totalCost: 'free' } };
            this.#events.delete(info.transactionId);
            return { payload: {} };
        }
      }
      case 'MeterValues':
        return this.broken('main-meter-error') ? { error: 'InternalError' } : { payload: {} };
      case 'SecurityEventNotification':
        return this.broken('security-event-error') ? { error: 'NotSupported' } : { payload: {} };
      default:
        return { payload: { currentTime } };
    }
  }

  /** Delay of every answer. */
  get answerDelayMs(): number {
    return this.broken('slow') ? (this.#options.slowMs ?? 50) : 0;
  }
}

/** One charge point connection of the fixture. */
class FixtureSession {
  /** Message id of our CALL awaiting its answer. */
  #outstanding: string | undefined;
  readonly #queue: [string, Record<string, unknown>][] = [];

  constructor(
    readonly fixture: FixtureCsms,
    readonly ws: WebSocket,
  ) {
    ws.on('message', (data: Buffer) => {
      this.#onMessage(data.toString('utf8'));
    });
  }

  #send(frame: unknown[]): void {
    const send = (): void => {
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
    };
    const delay = this.fixture.answerDelayMs;
    if (delay > 0) setTimeout(send, delay);
    else send();
  }

  #onMessage(raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      if (this.fixture.broken('close-on-bad-json')) this.ws.close(1007, 'Invalid JSON');
      return;
    }
    if (!Array.isArray(value) || typeof value[1] !== 'string') return;
    const frame: unknown[] = value;
    const id = value[1];
    switch (frame[0]) {
      case 2:
        this.#onCall(frame, id);
        return;
      case 3:
      case 4:
        if (id === this.#outstanding) {
          this.#outstanding = undefined;
          this.#pump();
        } else if (this.fixture.broken('answer-unmatched')) {
          this.#send([4, id, 'ProtocolError', 'Unexpected response', {}]);
        }
        return;
      default:
        if (this.fixture.broken('answer-unknown-type')) {
          this.#send([4, id, 'ProtocolError', 'Unknown message type', {}]);
        } else if (this.fixture.broken('message-type-not-supported')) {
          this.#send([4, id, 'MessageTypeNotSupported', 'Unknown message type', {}]);
        }
    }
  }

  #onCall(frame: unknown[], id: string): void {
    const [, , action, payload] = frame;
    if (
      frame.length !== 4 ||
      typeof action !== 'string' ||
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      id.length > 36
    ) {
      if (!this.fixture.broken('ignore-malformed-frames')) {
        const codes = this.fixture.errorCodes;
        this.#send([
          4,
          id,
          frame.length < 4 ? codes.incompleteFrame : codes.rpcFramework,
          'Malformed CALL',
          {},
        ]);
      }
      return;
    }
    const request = payload as Record<string, unknown>;
    const catalogue = this.fixture.catalogue;
    if (!Object.hasOwn(catalogue, action)) {
      if (this.fixture.broken('ignore-unknown-action')) return;
      const code = this.fixture.broken('unknown-action-not-supported')
        ? 'NotSupported'
        : 'NotImplemented';
      this.#send([4, id, code, `Unknown action ${action}`, {}]);
      return;
    }
    if (!this.fixture.broken('no-validation')) {
      const schema = catalogue[action];
      const error = schema
        ? validatePayload(schema.request, request, 'Payload', this.fixture.errorCodes)
        : undefined;
      if (error) {
        this.#send([4, id, error.code, error.message, {}]);
        return;
      }
    }
    const answer = this.fixture.answer(action, request);
    this.#send('error' in answer ? [4, id, answer.error, '', {}] : [3, id, answer.payload]);
    if (
      action === 'BootNotification' &&
      'payload' in answer &&
      answer.payload.status === 'Accepted'
    ) {
      this.#afterBoot();
    }
  }

  /** Configure the charge point after it registered, like many Central Systems do. */
  #afterBoot(): void {
    const modern = this.fixture.protocol === 'ocpp2.0.1';
    this.#queue.push(
      modern
        ? [
            'GetVariables',
            {
              getVariableData: [
                { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
              ],
            },
          ]
        : ['GetConfiguration', {}],
      ['TriggerMessage', { requestedMessage: 'StatusNotification' }],
    );
    if (this.fixture.broken('invalid-server-call'))
      this.#queue.push([modern ? 'RequestStartTransaction' : 'RemoteStartTransaction', {}]);
    if (this.fixture.broken('concurrent-calls')) {
      for (const [action, payload] of this.#queue.splice(0)) {
        this.ws.send(JSON.stringify([2, randomUUID(), action, payload]));
      }
      return;
    }
    this.#pump();
  }

  #pump(): void {
    if (this.#outstanding !== undefined) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#outstanding = randomUUID();
    this.ws.send(JSON.stringify([2, this.#outstanding, ...next]));
  }
}
