import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { tlsClientOptions, type ChargePointTlsOptions } from '../client/connector.js';
import { OcppKitError, type OcppErrorCode } from '../rpc/errors.js';
import {
  MessageType,
  parseFrame,
  serializeFrame,
  type CallErrorFrame,
  type CallFrame,
  type CallResultFrame,
  type Frame,
  type JsonObject,
} from '../rpc/frames.js';

/** One frame on the wire, as seen by the probe. */
export interface ProbeRecord {
  readonly direction: 'in' | 'out';
  readonly raw: string;
  /** `performance.now()` when sent or received. */
  readonly at: number;
}

/** A received frame that parsed as valid OCPP-J, with its raw text. */
export interface ProbeFrame {
  readonly frame: Frame;
  readonly raw: string;
  /** `performance.now()` when received. */
  readonly at: number;
}

/** A CALL the Central System sent to the probe. */
export interface ServerCall {
  readonly frame: CallFrame;
  readonly receivedAt: number;
  /** When the probe answered it, if it has. */
  answeredAt?: number;
}

/** How the probe answers a Central System CALL: a payload, an error, or not at all. */
export type ProbeAnswer =
  | { readonly payload: JsonObject }
  | { readonly error: OcppErrorCode; readonly description?: string }
  | undefined;

/** Decides the answer to a Central System CALL. */
export type ProbeResponder = (call: CallFrame) => ProbeAnswer;

/**
 * The connection could not be established: the TCP or TLS connection failed, the server refused
 * the WebSocket handshake with an HTTP status, or the probe failed a handshake the server
 * completed (for example because the server chose a subprotocol that was not offered).
 */
export class ProbeHandshakeError extends OcppKitError {
  constructor(
    message: string,
    /** HTTP status of the server's answer: 101 when it completed the handshake. */
    readonly statusCode?: number,
    /** The `Sec-WebSocket-Protocol` header of a completed handshake (`''` when absent). */
    readonly subprotocol?: string,
  ) {
    super(message);
  }
}

/** Options of {@link ProbeConnection.open}. */
export interface ProbeConnectOptions {
  /** Full URL including the identity. */
  readonly url: string;
  /** Offered subprotocols; empty offers none. */
  readonly protocols: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly tls?: ChargePointTlsOptions;
  readonly timeoutMs: number;
  /** Answers Central System CALLs. Default: CALLERROR NotSupported. */
  readonly respond?: ProbeResponder;
}

/** The answer to a CALL the probe sent. */
export interface ProbeCallResult {
  /** The CALLRESULT or CALLERROR, `undefined` on timeout or when the connection closed. */
  readonly frame: CallResultFrame | CallErrorFrame | undefined;
  /** Raw text of the answer. */
  readonly raw: string | undefined;
  readonly messageId: string;
  /** Round-trip time in milliseconds (the time waited when unanswered). */
  readonly rttMs: number;
}

interface Waiter {
  readonly predicate: (frame: Frame) => boolean;
  readonly resolve: (frame: ProbeFrame | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * A charge point connection under the conformance checker's full control: it can send any text,
 * including malformed frames, correlates answers by message id, records every frame, answers
 * Central System CALLs through a pluggable responder with an adjustable delay, and reports how and
 * when the connection closed.
 */
export class ProbeConnection {
  /** The negotiated subprotocol (`''` when none). */
  readonly protocol: string;
  /** Every frame sent and received, in order. */
  readonly log: ProbeRecord[] = [];
  /** Every CALL the Central System sent. */
  readonly serverCalls: ServerCall[] = [];
  /** Resolves with the close code and reason once the connection is closed. */
  readonly closed: Promise<{ code: number; reason: string }>;

  readonly #ws: WebSocket;
  readonly #waiters = new Set<Waiter>();
  #respond: ProbeResponder;
  #answerDelayMs = 0;
  #closeInfo: { code: number; reason: string } | undefined;

  private constructor(ws: WebSocket, respond: ProbeResponder) {
    this.#ws = ws;
    this.protocol = ws.protocol;
    this.#respond = respond;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.#closeInfo = { code, reason: reason.toString('utf8') };
        for (const waiter of this.#waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(undefined);
        }
        this.#waiters.clear();
        resolve(this.#closeInfo);
      });
    });
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      this.#onMessage(raw);
    });
  }

  /** Open a connection; rejects with {@link ProbeHandshakeError} when the handshake fails. */
  static open(options: ProbeConnectOptions): Promise<ProbeConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(options.url, [...options.protocols], {
        ...tlsClientOptions(options.tls),
        headers: { ...options.headers },
        handshakeTimeout: options.timeoutMs,
        // Frames go on the wire exactly as the checks wrote them.
        perMessageDeflate: false,
      });
      let settled = false;
      let upgrade: { subprotocol: string } | undefined;
      const fail = (error: ProbeHandshakeError): void => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(error);
      };
      ws.on('error', (error) => {
        fail(
          new ProbeHandshakeError(error.message, upgrade ? 101 : undefined, upgrade?.subprotocol),
        );
      });
      ws.once('upgrade', (response: IncomingMessage) => {
        const header = response.headers['sec-websocket-protocol'];
        upgrade = { subprotocol: typeof header === 'string' ? header : '' };
      });
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        fail(
          new ProbeHandshakeError(
            `handshake refused with HTTP ${response.statusCode ?? '?'}`,
            response.statusCode,
          ),
        );
      });
      ws.once('open', () => {
        if (settled) return;
        settled = true;
        resolve(new ProbeConnection(ws, options.respond ?? (() => ({ error: 'NotSupported' }))));
      });
    });
  }

  /** Whether the connection is open. */
  get isOpen(): boolean {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  /** How the connection closed, once it has. */
  get closeInfo(): { code: number; reason: string } | undefined {
    return this.#closeInfo;
  }

  /**
   * Answer Central System CALLs after `delayMs` (default 0), with `respond` when given. Answers
   * already scheduled keep their delay.
   */
  answerCalls(options: { readonly delayMs?: number; readonly respond?: ProbeResponder }): void {
    this.#answerDelayMs = options.delayMs ?? 0;
    if (options.respond) this.#respond = options.respond;
  }

  /** Send raw text, as-is. Does nothing once the connection is closed. */
  send(raw: string): void {
    if (!this.isOpen) return;
    this.#ws.send(raw);
    this.log.push({ direction: 'out', raw, at: performance.now() });
  }

  /** Send a CALL and wait for its CALLRESULT or CALLERROR (matched by message id). */
  async call(action: string, payload: JsonObject, timeoutMs: number): Promise<ProbeCallResult> {
    const messageId = randomUUID();
    const answer = this.waitFor(
      (frame) =>
        (frame.type === MessageType.CallResult || frame.type === MessageType.CallError) &&
        frame.messageId === messageId,
      timeoutMs,
    );
    const sentAt = performance.now();
    this.send(serializeFrame({ type: MessageType.Call, messageId, action, payload }));
    const received = await answer;
    return {
      frame: received?.frame as CallResultFrame | CallErrorFrame | undefined,
      raw: received?.raw,
      messageId,
      rttMs: (received?.at ?? performance.now()) - sentAt,
    };
  }

  /**
   * Wait for a valid frame received from now on that satisfies `predicate`; `undefined` on
   * timeout or when the connection closes.
   */
  waitFor(
    predicate: (frame: Frame) => boolean,
    timeoutMs: number,
  ): Promise<ProbeFrame | undefined> {
    if (!this.isOpen) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          resolve(undefined);
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  /** Frames received after log position `from` whose raw text contains `text`. */
  receivedSince(from: number, text?: string): ProbeRecord[] {
    return this.log
      .slice(from)
      .filter(
        (record) => record.direction === 'in' && (text === undefined || record.raw.includes(text)),
      );
  }

  /** Send a WebSocket ping; resolves whether a pong arrived within `timeoutMs`. */
  ping(timeoutMs: number): Promise<boolean> {
    if (!this.isOpen) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onPong = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#ws.off('pong', onPong);
        resolve(false);
      }, timeoutMs);
      this.#ws.once('pong', onPong);
      this.#ws.ping();
    });
  }

  /** Resolves whether the connection closed within `ms`. */
  async closesWithin(ms: number): Promise<boolean> {
    if (!this.isOpen) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, ms);
    });
    const result = await Promise.race([this.closed.then(() => true as const), timeout]);
    clearTimeout(timer);
    return result;
  }

  /** Close the connection and wait for it (at most one second, then the socket is destroyed). */
  async close(): Promise<void> {
    if (this.#closeInfo) return;
    if (this.#ws.readyState === WebSocket.CONNECTING || this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.close(1000, 'Conformance check done');
    }
    if (!(await this.closesWithin(1_000))) this.#ws.terminate();
    await this.closed;
  }

  #onMessage(raw: string): void {
    const at = performance.now();
    this.log.push({ direction: 'in', raw, at });
    const parsed = parseFrame(raw);
    if (!parsed.ok) return;
    const { frame } = parsed;
    if (frame.type === MessageType.Call) this.#onServerCall(frame, at);
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve({ frame, raw, at });
    }
  }

  #onServerCall(frame: CallFrame, receivedAt: number): void {
    const record: ServerCall = { frame, receivedAt };
    this.serverCalls.push(record);
    const answer = this.#respond(frame);
    if (answer === undefined) return;
    const send = (): void => {
      if (!this.isOpen) return;
      record.answeredAt = performance.now();
      this.send(
        'payload' in answer
          ? serializeFrame({
              type: MessageType.CallResult,
              messageId: frame.messageId,
              payload: answer.payload,
            })
          : serializeFrame({
              type: MessageType.CallError,
              messageId: frame.messageId,
              errorCode: answer.error,
              errorDescription: answer.description ?? '',
              errorDetails: {},
            }),
      );
    };
    if (this.#answerDelayMs > 0) setTimeout(send, this.#answerDelayMs);
    else send();
  }
}
