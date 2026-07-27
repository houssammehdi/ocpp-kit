import type { Duplex } from '../rpc/duplex.js';
import { CallTimeoutError, ConnectionClosedError, OcppKitError, RpcError } from '../rpc/errors.js';
import type { JsonObject } from '../rpc/frames.js';
import {
  HandlerRegistry,
  RpcPeer,
  type CallOptions,
  type CompletedCallEvent,
  type RequestHandler,
} from '../rpc/peer.js';
import type { OcppProtocol } from '../rpc/protocol.js';
import {
  validatePayload,
  type ActionName,
  type ActionSchemaMap,
  type RequestOf,
  type ResponseOf,
} from '../rpc/validation.js';
import { basicAuthHeader } from '../server/auth.js';
import { TypedEventEmitter } from '../util/typed-emitter.js';
import { timerDelay } from '../util/timers.js';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.js';
import { webSocketConnector, type ChargePointTlsOptions, type Connector } from './connector.js';
import {
  MemoryQueueStore,
  OfflineQueue,
  type EvictionPolicy,
  type OfflineQueueStore,
  type QueuedMessage,
} from './offline-queue.js';

/** Reconnect policy of a client. */
export interface ReconnectOptions extends BackoffOptions {
  /** Give up after this many consecutive failed attempts. Default: unlimited. */
  readonly maxAttempts?: number;
  /**
   * A connection must stay up this long before the backoff counter resets, so a server that
   * accepts and immediately drops connections is not hammered. Default: 10 000 ms.
   */
  readonly resetAfterMs?: number;
}

/** Options of the client offline queue. */
export interface OfflineQueueOptions {
  /** Persistence backend. Default: {@link MemoryQueueStore}. */
  readonly store?: OfflineQueueStore;
  /** Maximum number of queued messages. Default: 10 000. */
  readonly maxSize?: number;
  /**
   * Hold queued messages until a BootNotification sent through this client has been answered
   * with `Accepted`. OCPP 1.6 section 4.2 forbids any other request between a (re)boot and the
   * BootNotification response, "This includes cached messages that are still present in the
   * Charge Point from before", and a Pending charge point may only send what it is asked for.
   * A client instance models one boot cycle, so reconnects keep the registration.
   * Set it to `false` if you never send BootNotification through this client. Default: `true`.
   */
  readonly holdUntilBootAccepted?: boolean;
}

/** Options shared by the clients of every OCPP version. */
export interface OcppClientOptions {
  /** Charge point identity, appended to `url` as the last path segment. */
  readonly identity: string;
  /** Central System endpoint without the identity, e.g. `ws://localhost:9220/ocpp`. */
  readonly url: string;
  /**
   * Password for HTTP Basic auth with the identity as username (Security Profile 1 over `ws://`,
   * Security Profile 2 over `wss://`).
   */
  readonly password?: string;
  /** TLS settings for `wss://` URLs: CA pinning and, for Security Profile 3, a client cert. */
  readonly tls?: ChargePointTlsOptions;
  /** Default CALL timeout. Default: 30 000 ms. */
  readonly callTimeoutMs?: number;
  /** WebSocket handshake timeout. Default: 10 000 ms. */
  readonly handshakeTimeoutMs?: number;
  /** Reconnect policy, or `false` to disable automatic reconnects. */
  readonly reconnect?: ReconnectOptions | false;
  /**
   * Offline queue for the transaction-related messages (1.6: StartTransaction, StopTransaction
   * and MeterValues; 2.0.1: TransactionEvent), or `false` to send them like any other message.
   * Default: in-memory store, 10 000 messages.
   */
  readonly offlineQueue?: OfflineQueueOptions | false;
  /**
   * Attempts per transaction message when the Central System answers with CALLERROR or does not
   * answer in time (1.6 `TransactionMessageAttempts`, 2.0.1 `MessageAttempts`). Connection loss
   * does not count. A function is read before every message, so configuration changes apply at
   * once. Default: 3.
   */
  readonly transactionMessageAttempts?: number | (() => number);
  /**
   * Base wait between attempts; attempt `n` waits `n` times this value (1.6
   * `TransactionMessageRetryInterval`, 2.0.1 `MessageAttemptInterval`). A function is read before
   * every wait. Default: 5 000 ms.
   */
  readonly transactionMessageRetryIntervalMs?: number | (() => number);
  /**
   * Send a WebSocket ping this often and drop the connection when the previous ping got no pong
   * (`WebSocketPingInterval`). 0 disables client-side pings. Default: 0.
   */
  readonly pingIntervalMs?: number;
  /** Uniform random source used for backoff jitter. Default: `Math.random`. */
  readonly random?: () => number;
  /** Transport factory. Default: `ws` WebSocket connector. */
  readonly connector?: Connector;
  readonly validateInbound?: boolean;
  readonly validateOutbound?: boolean;
}

/** Connection lifecycle state. */
export type ChargePointState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Events emitted by a client.
 *
 * @typeParam Q - the names of the queued (transaction-related) actions
 */
export interface OcppClientEvents<Q extends string> {
  open: () => void;
  close: (code: number, reason: string) => void;
  /** A reconnect is scheduled after `delayMs`; `attempt` starts at 1. */
  reconnecting: (attempt: number, delayMs: number) => void;
  connectFailed: (error: Error, attempt: number) => void;
  /** A queued transaction message was delivered. */
  delivered: (message: QueuedMessage<Q>, response: JsonObject) => void;
  /** A queued transaction message was abandoned after exhausting its attempts or evicted. */
  dropped: (message: QueuedMessage<Q>, error: Error) => void;
  /** Every outbound CALL that settled, with its round-trip time. */
  callCompleted: (event: CompletedCallEvent) => void;
  message: (direction: 'in' | 'out', raw: string) => void;
}

/** A call could not be sent because the client is not connected. */
export class NotConnectedError extends OcppKitError {
  constructor(readonly action: string) {
    super(`Cannot send ${action}: not connected`);
  }
}

interface Deferred {
  readonly resolve: (value: JsonObject) => void;
  readonly reject: (error: Error) => void;
}

/** What a subclass tells {@link OcppClient} about its OCPP version. */
export interface OcppClientProfile<
  Up extends ActionSchemaMap,
  Down extends ActionSchemaMap,
  Q extends ActionName<Up>,
> {
  readonly protocol: OcppProtocol<string, Up, Down>;
  /** The actions that go through the offline queue. */
  readonly queued: readonly Q[];
  /** Which queued messages a full queue may discard. */
  readonly evictable: EvictionPolicy<Q>;
}

/**
 * The version-generic part of an OCPP charge point client: connection with reconnects
 * (exponential backoff with full jitter), keep-alive pings, typed handlers and calls, and a
 * persistent offline queue that delivers the transaction-related messages at least once and in
 * order, replaying them after an accepted BootNotification.
 *
 * {@link ChargePoint} (OCPP 1.6) and {@link ChargingStation} (OCPP 2.0.1) are the concrete
 * clients.
 *
 * @typeParam Up - actions the client sends
 * @typeParam Down - actions the client receives
 * @typeParam C - handler context
 * @typeParam Q - queued action names
 */
export abstract class OcppClient<
  Up extends ActionSchemaMap,
  Down extends ActionSchemaMap,
  C extends object,
  Q extends ActionName<Up>,
> extends TypedEventEmitter<OcppClientEvents<Q>> {
  /** Charge point identity. */
  readonly identity: string;
  /** The offline queue, when enabled. */
  protected readonly queue: OfflineQueue<Q> | undefined;
  readonly #protocol: OcppProtocol<string, Up, Down>;
  readonly #queued: ReadonlySet<string>;
  readonly #options: OcppClientOptions;
  readonly #handlers = new HandlerRegistry<Down, C>();
  readonly #context: C;
  readonly #deferred = new Map<number, Deferred>();
  readonly #attempts = new Map<number, number>();
  readonly #connector: Connector;
  #peer: RpcPeer<Down, Up, C> | undefined;
  #state: ChargePointState = 'idle';
  #stopped = false;
  #draining = false;
  #running: Promise<void> | undefined;
  readonly #wakers = new Set<() => void>();
  #connectWaiters: Deferred[] = [];
  readonly #holdUntilBootAccepted: boolean;
  #registrationStatus: string | undefined;
  /** Delay of the next reconnect when {@link reconnectAfter} asked for one. */
  #reconnectDelay: number | undefined;

  protected constructor(
    profile: OcppClientProfile<Up, Down, Q>,
    options: OcppClientOptions,
    context: C,
  ) {
    super();
    this.identity = options.identity;
    this.#protocol = profile.protocol;
    this.#queued = new Set(profile.queued);
    this.#options = options;
    this.#context = context;
    this.#connector = options.connector ?? webSocketConnector;
    if (options.offlineQueue !== false) {
      this.queue = new OfflineQueue<Q>(
        options.offlineQueue?.store ?? new MemoryQueueStore(),
        options.offlineQueue?.maxSize,
        profile.evictable,
      );
    }
    this.#holdUntilBootAccepted =
      options.offlineQueue === false
        ? false
        : (options.offlineQueue?.holdUntilBootAccepted ?? true);
  }

  /** The OCPP version this client speaks. */
  get protocol(): OcppProtocol<string, Up, Down> {
    return this.#protocol;
  }

  /** Current lifecycle state. */
  get state(): ChargePointState {
    return this.#state;
  }

  /** Whether the client is connected right now. */
  get isConnected(): boolean {
    return this.#peer?.isOpen ?? false;
  }

  /** Number of transaction messages waiting for delivery. */
  get queueSize(): number {
    return this.queue?.size ?? 0;
  }

  /** Endpoint URL including the identity. */
  get endpoint(): string {
    return `${this.#options.url.replace(/\/+$/, '')}/${encodeURIComponent(this.identity)}`;
  }

  /** Status of the latest BootNotification answered on this client, if any. */
  protected get bootStatus(): string | undefined {
    return this.#registrationStatus;
  }

  /** Register a typed handler for a Central System initiated action. */
  handle<A extends ActionName<Down>>(action: A, handler: RequestHandler<Down, A, C>): this {
    this.#handlers.set(action, handler);
    return this;
  }

  /**
   * Connect (retrying per the reconnect policy) and resolve once the first connection is open.
   * Loads persisted offline messages first so they are replayed right after connecting.
   */
  async connect(): Promise<void> {
    if (this.#stopped) throw new OcppKitError(`${this.constructor.name} has been closed`);
    if (this.isConnected) return;
    const opened = new Promise<void>((resolve, reject) => {
      this.#connectWaiters.push({ resolve: () => resolve(), reject });
    });
    if (!this.#running) {
      await this.queue?.init();
      this.#running = this.#run();
    }
    return opened;
  }

  /**
   * Send a typed CALL to the Central System.
   *
   * Transaction-related actions go through the offline queue: the promise resolves once the
   * message has been delivered, which may be after one or more reconnects.
   */
  call<A extends ActionName<Up>>(
    action: A,
    payload: RequestOf<Up, A>,
    options?: CallOptions,
  ): Promise<ResponseOf<Up, A>> {
    if (this.queue && this.#queued.has(action)) {
      return this.enqueue(action as unknown as Q, payload as JsonObject);
    }
    const peer = this.#peer;
    if (!peer?.isOpen) return Promise.reject(new NotConnectedError(action));
    const pending = peer.call(action, payload, options);
    if (action !== 'BootNotification') return pending;
    return pending.then((response) => {
      this.#onBootResponse((response as { readonly status: string }).status);
      return response;
    });
  }

  #onBootResponse(status: string): void {
    this.#registrationStatus = status;
    if (status === 'Accepted') void this.#drain();
  }

  /**
   * Close the current connection and connect again after `delayMs` instead of the backoff
   * delay, keeping the offline queue and pending calls. A charge point whose BootNotification was
   * Rejected can use it to stay off the network until the retry interval has passed. The
   * reconnect happens even when automatic reconnects are disabled.
   */
  async reconnectAfter(delayMs: number, reason = 'Reconnecting'): Promise<void> {
    if (this.#stopped) return;
    this.#reconnectDelay = delayMs;
    const peer = this.#peer;
    if (peer) await peer.close(1000, reason);
  }

  /**
   * Stop reconnecting and close the connection. Queued messages stay in the store (and are
   * replayed by the next client using the same store); their pending promises reject.
   */
  async close(code = 1000, reason = ''): Promise<void> {
    this.#stopped = true;
    for (const wake of [...this.#wakers]) wake();
    const peer = this.#peer;
    if (peer) await peer.close(code, reason);
    await this.#running;
    this.#state = 'closed';
    const closed = new ConnectionClosedError(code, reason || 'Client closed');
    for (const deferred of this.#deferred.values()) deferred.reject(closed);
    this.#deferred.clear();
    for (const waiter of this.#connectWaiters.splice(0)) waiter.reject(closed);
  }

  // -------------------------------------------------------------------------------------------
  // Hooks for version-specific queue handling
  // -------------------------------------------------------------------------------------------

  /** The payload validated when `payload` is queued; override for late-bound fields. */
  protected validationPayload(
    _action: Q,
    payload: JsonObject,
    _transactionRef?: string,
  ): JsonObject {
    return payload;
  }

  /**
   * The payload to send for a queued message, or `undefined` when it can never be sent (the
   * message is then dropped with the error from {@link undeliverable}).
   */
  protected payloadFor(message: QueuedMessage<Q>): JsonObject | undefined {
    return message.payload;
  }

  /** The error a message that {@link payloadFor} cannot send is dropped with. */
  protected undeliverable(message: QueuedMessage<Q>): Error {
    return new OcppKitError(`Queued ${message.action} ${message.seq} cannot be sent`);
  }

  /**
   * A queued message was delivered (`outcome` is the response) or abandoned: remove it from the
   * queue and settle its caller with {@link finish}.
   */
  protected async settleQueued(
    message: QueuedMessage<Q>,
    outcome: JsonObject | Error,
  ): Promise<void> {
    await this.queue?.remove(message.seq);
    this.finish(message, outcome);
  }

  /** Settle the caller's promise of a queued message and report the outcome. */
  protected finish(message: QueuedMessage<Q>, outcome: JsonObject | Error): void {
    this.#attempts.delete(message.seq);
    const deferred = this.#deferred.get(message.seq);
    this.#deferred.delete(message.seq);
    if (outcome instanceof Error) {
      deferred?.reject(outcome);
      this.emit('dropped', message, outcome);
    } else {
      deferred?.resolve(outcome);
      this.emit('delivered', message, outcome);
    }
  }

  /**
   * Queue a transaction-related message; resolves with the response once delivered.
   *
   * @param transactionRef - a local reference stored with the message (see
   *   {@link QueuedMessage.transactionRef})
   */
  protected async enqueue(
    action: Q,
    payload: JsonObject,
    transactionRef?: string,
  ): Promise<JsonObject> {
    const queue = this.queue;
    if (!queue) throw new OcppKitError('Offline queue disabled');
    if (this.#options.validateOutbound ?? true) {
      const schema = this.#protocol.fromChargePoint[action];
      const error = schema
        ? validatePayload(
            schema.request,
            this.validationPayload(action, payload, transactionRef),
            `${action} request`,
            this.#protocol.errorCodes,
          )
        : undefined;
      if (error) throw error;
    }
    if (this.#stopped) throw new ConnectionClosedError(1000, 'Client closed');
    if (!queue.isLoaded) {
      // Load persisted messages first: saving before that would overwrite them.
      await queue.init();
      if (this.#isStopped()) throw new ConnectionClosedError(1000, 'Client closed');
    }
    // From here on synchronous: a message queued right before close() is kept in the store.
    const { message, evicted, persisted } = queue.enqueue(
      action,
      payload,
      transactionRef === undefined ? {} : { transactionRef },
    );
    // Register the waiter synchronously, before the drain loop can possibly deliver the message.
    const delivered = new Promise<JsonObject>((resolve, reject) => {
      this.#deferred.set(message.seq, { resolve, reject });
    });
    if (evicted) {
      const error = new OcppKitError('Evicted from a full offline queue');
      this.#deferred.get(evicted.seq)?.reject(error);
      this.#deferred.delete(evicted.seq);
      this.emit('dropped', evicted, error);
    }
    try {
      await persisted;
    } catch (error) {
      // The store could not save it: tell the caller, and do not deliver a message the caller
      // was told failed (unless it is already on the wire; then its outcome settles the promise).
      if (queue.inFlight !== message.seq) {
        this.#deferred.delete(message.seq);
        await queue.remove(message.seq).catch(() => undefined);
        throw error;
      }
    }
    void this.#drain();
    return delivered;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  async #drain(): Promise<void> {
    const queue = this.queue;
    if (!queue || this.#draining) return;
    this.#draining = true;
    const setting = (value: number | (() => number) | undefined, fallback: number): number =>
      typeof value === 'function' ? value() : (value ?? fallback);
    try {
      for (;;) {
        const peer = this.#peer;
        const head = queue.peek();
        if (!peer?.isOpen || !head || this.#stopped || this.#queueHeld()) return;
        const payload = this.payloadFor(head);
        if (!payload) {
          await this.settleQueued(head, this.undeliverable(head));
          continue;
        }
        queue.setInFlight(head.seq);
        try {
          const response = await peer.call(head.action, payload);
          await this.settleQueued(head, response as JsonObject);
        } catch (error) {
          if (error instanceof ConnectionClosedError) return;
          const attempts = (this.#attempts.get(head.seq) ?? 0) + 1;
          const retryable = error instanceof RpcError || error instanceof CallTimeoutError;
          if (!retryable || attempts >= setting(this.#options.transactionMessageAttempts, 3)) {
            await this.settleQueued(
              head,
              error instanceof Error ? error : new Error(String(error)),
            );
          } else {
            this.#attempts.set(head.seq, attempts);
            const retryInterval = setting(this.#options.transactionMessageRetryIntervalMs, 5_000);
            await this.#sleep(retryInterval * attempts);
          }
        } finally {
          queue.setInFlight(undefined);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  /** Whether queued messages must wait for an accepted BootNotification. */
  #queueHeld(): boolean {
    return this.#holdUntilBootAccepted && this.#registrationStatus !== 'Accepted';
  }

  /** Re-reads the flag; TypeScript would otherwise keep its narrowing across `await`. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  /** Wait `ms`, or less if {@link close} is called meanwhile. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.#wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timerDelay(ms));
      this.#wakers.add(wake);
    });
  }

  #createPeer(duplex: Duplex): RpcPeer<Down, Up, C> {
    const peer = new RpcPeer(duplex, {
      inbound: this.#protocol.fromCentralSystem,
      outbound: this.#protocol.fromChargePoint,
      handlers: this.#handlers,
      context: this.#context,
      errorCodes: this.#protocol.errorCodes,
      ...(this.#options.callTimeoutMs === undefined
        ? {}
        : { callTimeoutMs: this.#options.callTimeoutMs }),
      ...(this.#options.validateInbound === undefined
        ? {}
        : { validateInbound: this.#options.validateInbound }),
      ...(this.#options.validateOutbound === undefined
        ? {}
        : { validateOutbound: this.#options.validateOutbound }),
    });
    peer.on('callCompleted', (event) => this.emit('callCompleted', event));
    peer.on('message', (direction, raw) => this.emit('message', direction, raw));
    return peer;
  }

  async #run(): Promise<void> {
    const reconnect = this.#options.reconnect ?? {};
    const backoff = reconnect === false ? DEFAULT_BACKOFF : { ...DEFAULT_BACKOFF, ...reconnect };
    const resetAfterMs = (reconnect === false ? undefined : reconnect.resetAfterMs) ?? 10_000;
    const maxAttempts = reconnect === false ? 1 : (reconnect.maxAttempts ?? Infinity);
    const headers: Record<string, string> =
      this.#options.password === undefined
        ? {}
        : { Authorization: basicAuthHeader(this.identity, this.#options.password) };
    // Exponent of the next reconnect delay; reset once a connection has proven stable.
    let backoffStep = 0;
    // Consecutive failed connection attempts, bounded by maxAttempts.
    let failures = 0;

    while (!this.#stopped) {
      this.#state = this.#state === 'idle' ? 'connecting' : 'reconnecting';
      let duplex: Duplex;
      try {
        duplex = await this.#connector({
          url: this.endpoint,
          protocols: [this.#protocol.subprotocol],
          headers,
          handshakeTimeoutMs: this.#options.handshakeTimeoutMs ?? 10_000,
          pingIntervalMs: this.#options.pingIntervalMs ?? 0,
          ...(this.#options.tls === undefined ? {} : { tls: this.#options.tls }),
        });
      } catch (error) {
        failures++;
        const failure = error instanceof Error ? error : new Error(String(error));
        this.emit('connectFailed', failure, failures);
        if (reconnect === false || failures >= maxAttempts) {
          for (const waiter of this.#connectWaiters.splice(0)) waiter.reject(failure);
          break;
        }
        await this.#backoff(backoffStep++, backoff);
        continue;
      }
      if (this.#isStopped()) {
        duplex.close(1000, 'Client closed');
        break;
      }
      failures = 0;

      const peer = this.#createPeer(duplex);
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        peer.once('close', (code, reason) => {
          resolve({ code, reason });
        });
      });
      const openedAt = Date.now();
      this.#peer = peer;
      this.#state = 'open';
      this.emit('open');
      for (const waiter of this.#connectWaiters.splice(0)) waiter.resolve({});
      void this.#drain();

      const { code, reason } = await closed;
      this.#peer = undefined;
      this.emit('close', code, reason);
      if (this.#isStopped()) break;
      const requestedDelay = this.#reconnectDelay;
      if (requestedDelay !== undefined) {
        this.#reconnectDelay = undefined;
        this.#state = 'reconnecting';
        this.emit('reconnecting', 1, requestedDelay);
        await this.#sleep(requestedDelay);
        continue;
      }
      if (reconnect === false) break;
      // Only a connection that stayed up for a while resets the backoff, so a server that
      // accepts and immediately drops connections is not hammered.
      if (Date.now() - openedAt >= resetAfterMs) backoffStep = 0;
      await this.#backoff(backoffStep++, backoff);
    }
    this.#state = 'closed';
  }

  async #backoff(exponent: number, options: BackoffOptions): Promise<void> {
    if (this.#stopped) return;
    const delay = backoffDelay(exponent, options, this.#options.random);
    this.#state = 'reconnecting';
    this.emit('reconnecting', exponent + 1, delay);
    await this.#sleep(delay);
  }
}
