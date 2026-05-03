import { randomUUID } from 'node:crypto';
import { TypedEventEmitter } from '../util/typed-emitter.js';
import type { Duplex } from './duplex.js';
import { CallAbortedError, CallTimeoutError, ConnectionClosedError, RpcError } from './errors.js';
import {
  callErrorFrame,
  MessageType,
  parseFrame,
  serializeFrame,
  type CallErrorFrame,
  type CallFrame,
  type CallResultFrame,
  type Frame,
  type JsonObject,
} from './frames.js';
import {
  validatePayload,
  type ActionName,
  type ActionSchemaMap,
  type RequestOf,
  type ResponseOf,
} from './validation.js';

/** Per-call metadata passed to every request handler. */
export interface CallMeta {
  readonly messageId: string;
  readonly action: string;
}

/** Awaitable value. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A typed handler for inbound CALLs of action `A`. Return the response payload, or throw an
 * {@link RpcError} to answer with a specific CALLERROR code.
 */
export type RequestHandler<
  M extends ActionSchemaMap,
  A extends ActionName<M>,
  C extends object = object,
> = (payload: RequestOf<M, A>, context: C & CallMeta) => MaybePromise<ResponseOf<M, A>>;

/** Type-erased handler as stored in a {@link HandlerRegistry}. */
export type AnyRequestHandler<C extends object = object> = (
  payload: unknown,
  context: C & CallMeta,
) => unknown;

/**
 * Registry of typed request handlers. It can be shared by many peers, e.g. a central system uses
 * one registry for all of its charge point connections.
 */
export class HandlerRegistry<M extends ActionSchemaMap, C extends object = object> {
  readonly #handlers = new Map<string, AnyRequestHandler<C>>();

  /** Register (or replace) the handler for `action`. */
  set<A extends ActionName<M>>(action: A, handler: RequestHandler<M, A, C>): this {
    this.#handlers.set(action, handler);
    return this;
  }

  /** Look up the handler for `action`. */
  get(action: string): AnyRequestHandler<C> | undefined {
    return this.#handlers.get(action);
  }

  /** Whether a handler is registered for `action`. */
  has(action: string): boolean {
    return this.#handlers.has(action);
  }

  /** Remove the handler for `action`. */
  delete(action: ActionName<M>): boolean {
    return this.#handlers.delete(action);
  }
}

/** Options of {@link RpcPeer}. */
export interface RpcPeerOptions<
  In extends ActionSchemaMap,
  Out extends ActionSchemaMap,
  C extends object,
> {
  /** Actions this peer may receive (and must answer). */
  readonly inbound: In;
  /** Actions this peer may send. */
  readonly outbound: Out;
  /** Handlers for inbound actions. Defaults to a private registry filled via {@link RpcPeer.handle}. */
  readonly handlers?: HandlerRegistry<In, C>;
  /** Extra fields merged into every handler context. */
  readonly context?: C;
  /** Default time to wait for a CALLRESULT/CALLERROR, in milliseconds. Default: 30 000. */
  readonly callTimeoutMs?: number;
  /** Validate inbound requests and the responses to our calls. Default: true. */
  readonly validateInbound?: boolean;
  /** Validate our outbound requests and the responses our handlers produce. Default: true. */
  readonly validateOutbound?: boolean;
  /** Message id generator. Must return unique strings of at most 36 characters. Default: UUID v4. */
  readonly generateId?: () => string;
}

/** Options of a single {@link RpcPeer.call}. */
export interface CallOptions {
  /** Overrides the peer's default call timeout. The clock starts when the frame is sent. */
  readonly timeoutMs?: number;
  /** Abort the call while queued or in flight. */
  readonly signal?: AbortSignal;
}

/** Emitted after an inbound CALL has been answered. */
export interface HandledCallEvent {
  readonly messageId: string;
  readonly action: string;
  readonly request: JsonObject;
  /** Response payload when the call succeeded. */
  readonly response?: JsonObject;
  /** Error sent back as CALLERROR when the call failed. */
  readonly error?: RpcError;
  /** Original exception when a handler threw something other than an {@link RpcError}. */
  readonly cause?: unknown;
  readonly durationMs: number;
}

/** Emitted after an outbound CALL has settled. */
export interface CompletedCallEvent {
  readonly messageId: string;
  readonly action: string;
  readonly request: JsonObject;
  readonly response?: JsonObject;
  readonly error?: Error;
  /** Round-trip time from sending the frame until the call settled. */
  readonly durationMs: number;
}

/** Events emitted by {@link RpcPeer}. */
export interface RpcPeerEvents {
  /** Raw frame traffic, useful for protocol logging. */
  message: (direction: 'in' | 'out', raw: string) => void;
  /** A frame could not be parsed or was not valid OCPP-J. */
  badMessage: (raw: string, error: RpcError) => void;
  /** A CALLRESULT/CALLERROR arrived that matches no outstanding call (e.g. after a timeout). */
  unmatchedResponse: (frame: CallResultFrame | CallErrorFrame) => void;
  callHandled: (event: HandledCallEvent) => void;
  callCompleted: (event: CompletedCallEvent) => void;
  close: (code: number, reason: string) => void;
}

interface PendingCall {
  readonly action: string;
  readonly payload: JsonObject;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: JsonObject) => void;
  readonly reject: (reason: Error) => void;
  onAbort?: () => void;
}

interface InFlightCall {
  readonly call: PendingCall;
  readonly messageId: string;
  readonly timer: NodeJS.Timeout;
  readonly sentAt: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * A transport-agnostic OCPP-J RPC endpoint.
 *
 * - Parses and validates every inbound frame, answering malformed CALLs with the matching
 *   CALLERROR code and dispatching valid ones to typed handlers.
 * - Enforces the OCPP-J rule that a sender has at most one outstanding CALL: further calls are
 *   queued FIFO and sent when the previous one is answered, fails or times out.
 * - Correlates responses by message id and applies a per-call timeout.
 * - Validates payloads in both directions against the action catalogues.
 *
 * @typeParam In - actions received from the other side
 * @typeParam Out - actions sent to the other side
 * @typeParam C - extra handler context
 */
export class RpcPeer<
  In extends ActionSchemaMap,
  Out extends ActionSchemaMap,
  C extends object = object,
> extends TypedEventEmitter<RpcPeerEvents> {
  readonly #duplex: Duplex;
  readonly #inbound: In;
  readonly #outbound: Out;
  readonly #handlers: HandlerRegistry<In, C>;
  readonly #context: C;
  readonly #callTimeoutMs: number;
  readonly #validateInbound: boolean;
  readonly #validateOutbound: boolean;
  readonly #generateId: () => string;
  readonly #queue: PendingCall[] = [];
  #inFlight: InFlightCall | undefined;
  #closed = false;
  #closeInfo: { code: number; reason: string } | undefined;
  readonly #closeWaiters: (() => void)[] = [];

  constructor(duplex: Duplex, options: RpcPeerOptions<In, Out, C>) {
    super();
    this.#duplex = duplex;
    this.#inbound = options.inbound;
    this.#outbound = options.outbound;
    this.#handlers = options.handlers ?? new HandlerRegistry<In, C>();
    this.#context = options.context ?? ({} as C);
    this.#callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#validateInbound = options.validateInbound ?? true;
    this.#validateOutbound = options.validateOutbound ?? true;
    this.#generateId = options.generateId ?? randomUUID;
    duplex.attach({
      message: (data) => {
        this.#onMessage(data);
      },
      close: (code, reason) => {
        this.#onClose(code, reason);
      },
    });
  }

  /** Whether the peer can still send and receive. */
  get isOpen(): boolean {
    return !this.#closed && this.#duplex.isOpen;
  }

  /** Number of calls waiting behind the outstanding one. */
  get queueLength(): number {
    return this.#queue.length;
  }

  /** Whether a CALL is currently awaiting its response. */
  get hasCallInFlight(): boolean {
    return this.#inFlight !== undefined;
  }

  /** Register a typed handler for an inbound action. */
  handle<A extends ActionName<In>>(action: A, handler: RequestHandler<In, A, C>): this {
    this.#handlers.set(action, handler);
    return this;
  }

  /**
   * Send a CALL and resolve with the (validated) CALLRESULT payload.
   *
   * Rejects with {@link RpcError} (CALLERROR from the peer, or local validation failure),
   * {@link CallTimeoutError}, {@link ConnectionClosedError} or {@link CallAbortedError}.
   */
  call<A extends ActionName<Out>>(
    action: A,
    payload: RequestOf<Out, A>,
    options: CallOptions = {},
  ): Promise<ResponseOf<Out, A>> {
    const schema = this.#outbound[action];
    if (!schema) {
      return Promise.reject(new RpcError('NotImplemented', `Unknown outbound action ${action}`));
    }
    if (this.#closed) {
      return Promise.reject(
        new ConnectionClosedError(this.#closeInfo?.code, this.#closeInfo?.reason),
      );
    }
    if (this.#validateOutbound) {
      const error = validatePayload(schema.request, payload, `${action} request`);
      if (error) return Promise.reject(error);
    }
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(new CallAbortedError(action));

    return new Promise<JsonObject>((resolve, reject) => {
      const pending: PendingCall = {
        action,
        payload: payload as JsonObject,
        timeoutMs: options.timeoutMs ?? this.#callTimeoutMs,
        signal,
        resolve,
        reject,
      };
      if (signal) {
        pending.onAbort = () => {
          this.#abort(pending);
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.#queue.push(pending);
      this.#pump();
    });
  }

  /** Close the underlying channel and resolve once the peer is closed. */
  close(code = 1000, reason = ''): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const done = new Promise<void>((resolve) => this.#closeWaiters.push(resolve));
    this.#duplex.close(code, reason);
    return done;
  }

  #send(frame: Frame): boolean {
    const raw = serializeFrame(frame);
    try {
      this.#duplex.send(raw);
    } catch {
      return false;
    }
    this.emit('message', 'out', raw);
    return true;
  }

  #pump(): void {
    while (!this.#inFlight && !this.#closed) {
      const next = this.#queue.shift();
      if (!next) return;
      const messageId = this.#generateId();
      const frame: CallFrame = {
        type: MessageType.Call,
        messageId,
        action: next.action,
        payload: next.payload,
      };
      const timer = setTimeout(() => {
        this.#settle(new CallTimeoutError(next.action, messageId, next.timeoutMs));
      }, next.timeoutMs);
      this.#inFlight = { call: next, messageId, timer, sentAt: performance.now() };
      if (!this.#send(frame)) {
        // The channel died underneath us; its close event will fail the rest of the queue.
        this.#inFlight = undefined;
        clearTimeout(timer);
        if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
        next.reject(new ConnectionClosedError());
      }
    }
  }

  /** Settle the in-flight call with a response payload or an error, then send the next one. */
  #settle(outcome: JsonObject | Error): void {
    const inFlight = this.#inFlight;
    if (!inFlight) return;
    this.#inFlight = undefined;
    clearTimeout(inFlight.timer);
    const { call, messageId } = inFlight;
    if (call.signal && call.onAbort) call.signal.removeEventListener('abort', call.onAbort);
    const durationMs = performance.now() - inFlight.sentAt;
    if (outcome instanceof Error) {
      call.reject(outcome);
      this.emit('callCompleted', {
        messageId,
        action: call.action,
        request: call.payload,
        error: outcome,
        durationMs,
      });
    } else {
      call.resolve(outcome);
      this.emit('callCompleted', {
        messageId,
        action: call.action,
        request: call.payload,
        response: outcome,
        durationMs,
      });
    }
    this.#pump();
  }

  #abort(pending: PendingCall): void {
    if (this.#inFlight?.call === pending) {
      this.#settle(new CallAbortedError(pending.action));
      return;
    }
    const index = this.#queue.indexOf(pending);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      pending.reject(new CallAbortedError(pending.action));
    }
  }

  #onMessage(raw: string): void {
    if (this.#closed) return;
    this.emit('message', 'in', raw);
    const result = parseFrame(raw);
    if (!result.ok) {
      this.emit('badMessage', raw, result.error);
      if (result.messageId === undefined) return;
      if (result.messageType === MessageType.Call) {
        this.#send(callErrorFrame(result.messageId, result.error));
      } else if (this.#inFlight?.messageId === result.messageId) {
        // A malformed answer to our call: fail it now instead of waiting for the timeout.
        this.#settle(result.error);
      }
      return;
    }
    const { frame } = result;
    switch (frame.type) {
      case MessageType.Call:
        void this.#dispatch(frame);
        return;
      case MessageType.CallResult:
      case MessageType.CallError:
        this.#onResponse(frame);
        return;
    }
  }

  #onResponse(frame: CallResultFrame | CallErrorFrame): void {
    const inFlight = this.#inFlight;
    if (inFlight?.messageId !== frame.messageId) {
      this.emit('unmatchedResponse', frame);
      return;
    }
    if (frame.type === MessageType.CallError) {
      this.#settle(
        new RpcError(frame.errorCode, frame.errorDescription, frame.errorDetails, { remote: true }),
      );
      return;
    }
    const { action } = inFlight.call;
    const schema = this.#outbound[action];
    if (this.#validateInbound && schema) {
      const error = validatePayload(schema.response, frame.payload, `${action} response`);
      if (error) {
        this.#settle(error);
        return;
      }
    }
    this.#settle(frame.payload);
  }

  async #dispatch(frame: CallFrame): Promise<void> {
    const { messageId, action, payload } = frame;
    const startedAt = performance.now();
    const finish = (
      outcome: { response: JsonObject } | { error: RpcError; cause?: unknown },
    ): void => {
      if ('response' in outcome) {
        this.#send({ type: MessageType.CallResult, messageId, payload: outcome.response });
      } else {
        this.#send(callErrorFrame(messageId, outcome.error));
      }
      this.emit('callHandled', {
        messageId,
        action,
        request: payload,
        ...outcome,
        durationMs: performance.now() - startedAt,
      });
    };

    const schema = Object.hasOwn(this.#inbound, action) ? this.#inbound[action] : undefined;
    const handler = this.#handlers.get(action);
    if (!schema) {
      finish({ error: new RpcError('NotImplemented', `Unknown action ${action}`) });
      return;
    }
    if (!handler) {
      finish({ error: new RpcError('NotSupported', `Action ${action} is not supported`) });
      return;
    }
    if (this.#validateInbound) {
      const error = validatePayload(schema.request, payload, `${action} request`);
      if (error) {
        finish({ error });
        return;
      }
    }

    let response: unknown;
    try {
      response = await handler(payload, { ...this.#context, messageId, action });
    } catch (cause) {
      finish(
        cause instanceof RpcError
          ? { error: cause }
          : { error: new RpcError('InternalError', `Failed to process ${action}`), cause },
      );
      return;
    }
    if (this.#validateOutbound) {
      const error = validatePayload(schema.response, response, `${action} response`);
      if (error) {
        finish({
          error: new RpcError(
            'InternalError',
            `Produced an invalid ${action} response`,
            error.details,
          ),
          cause: error,
        });
        return;
      }
    }
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      finish({ error: new RpcError('InternalError', `Produced an invalid ${action} response`) });
      return;
    }
    finish({ response: response as JsonObject });
  }

  #onClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeInfo = { code, reason };
    const error = (): ConnectionClosedError => new ConnectionClosedError(code, reason);
    if (this.#inFlight) this.#settle(error());
    for (const pending of this.#queue.splice(0)) {
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(error());
    }
    this.emit('close', code, reason);
    for (const resolve of this.#closeWaiters.splice(0)) resolve();
  }
}
