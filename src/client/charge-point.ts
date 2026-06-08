import { randomUUID } from 'node:crypto';
import {
  CentralSystemToChargePoint,
  ChargePointToCentralSystem,
  isTransactionAction,
  type ChargePointAction,
  type ChargePointRequest,
  type ChargePointResponse,
  type MeterValue,
  type RegistrationStatus,
} from '../messages/index.js';
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
import { validatePayload, type ActionName } from '../rpc/validation.js';
import { basicAuthHeader } from '../server/auth.js';
import { OCPP16_SUBPROTOCOL } from '../transport/websocket.js';
import { TypedEventEmitter } from '../util/typed-emitter.js';
import { timerDelay } from '../util/timers.js';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.js';
import { webSocketConnector, type Connector } from './connector.js';
import {
  MemoryQueueStore,
  OfflineQueue,
  type OfflineQueueStore,
  type QueuedMessage,
} from './offline-queue.js';

type Inbound = typeof CentralSystemToChargePoint;
type Outbound = typeof ChargePointToCentralSystem;

/** Context passed to every Charge Point handler. */
export interface ChargePointHandlerContext {
  readonly chargePoint: ChargePoint;
}

/** Reconnect policy of {@link ChargePoint}. */
export interface ReconnectOptions extends BackoffOptions {
  /** Give up after this many consecutive failed attempts. Default: unlimited. */
  readonly maxAttempts?: number;
  /**
   * A connection must stay up this long before the backoff counter resets, so a server that
   * accepts and immediately drops connections is not hammered. Default: 10 000 ms.
   */
  readonly resetAfterMs?: number;
}

/** Options of {@link ChargePoint}. */
export interface ChargePointOptions {
  /** Charge point identity, appended to `url` as the last path segment. */
  readonly identity: string;
  /** Central System endpoint without the identity, e.g. `ws://localhost:9220/ocpp`. */
  readonly url: string;
  /** Security Profile 1 password (HTTP Basic auth with the identity as username). */
  readonly password?: string;
  /** Default CALL timeout. Default: 30 000 ms. */
  readonly callTimeoutMs?: number;
  /** WebSocket handshake timeout. Default: 10 000 ms. */
  readonly handshakeTimeoutMs?: number;
  /** Reconnect policy, or `false` to disable automatic reconnects. */
  readonly reconnect?: ReconnectOptions | false;
  /**
   * Offline queue for StartTransaction, StopTransaction and MeterValues, or `false` to send them
   * like any other message. Default: in-memory store, 10 000 messages.
   */
  readonly offlineQueue?: OfflineQueueOptions | false;
  /**
   * Attempts per transaction message when the Central System answers with CALLERROR or does not
   * answer in time (`TransactionMessageAttempts`). Connection loss does not count. Default: 3.
   */
  readonly transactionMessageAttempts?: number;
  /**
   * Base wait between attempts; attempt `n` waits `n` times this value
   * (`TransactionMessageRetryInterval`). Default: 5 000 ms.
   */
  readonly transactionMessageRetryIntervalMs?: number;
  /** Uniform random source used for backoff jitter. Default: `Math.random`. */
  readonly random?: () => number;
  /** Transport factory. Default: `ws` WebSocket connector. */
  readonly connector?: Connector;
  readonly validateInbound?: boolean;
  readonly validateOutbound?: boolean;
}

/** Options of the {@link ChargePoint} offline queue. */
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
   * A `ChargePoint` instance models one boot cycle, so reconnects keep the registration.
   * Set it to `false` if you never send BootNotification through this client. Default: `true`.
   */
  readonly holdUntilBootAccepted?: boolean;
}

/** Connection lifecycle state. */
export type ChargePointState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Events emitted by {@link ChargePoint}. */
export interface ChargePointEvents {
  open: () => void;
  close: (code: number, reason: string) => void;
  /** A reconnect is scheduled after `delayMs`; `attempt` starts at 1. */
  reconnecting: (attempt: number, delayMs: number) => void;
  connectFailed: (error: Error, attempt: number) => void;
  /** A queued transaction message was delivered. */
  delivered: (message: QueuedMessage, response: JsonObject) => void;
  /** A queued transaction message was abandoned after exhausting its attempts or evicted. */
  dropped: (message: QueuedMessage, error: Error) => void;
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

/**
 * A MeterValues or StopTransaction of a {@link QueuedTransaction} was abandoned because its
 * StartTransaction was never delivered, so no transaction id exists to send it with.
 */
export class TransactionNotStartedError extends OcppKitError {
  constructor(
    readonly transactionRef: string,
    options?: { cause?: unknown },
  ) {
    super(`StartTransaction of transaction ${transactionRef} was not delivered`, options);
  }
}

/**
 * A transaction started with {@link ChargePoint.startTransaction}. Its MeterValues and
 * StopTransaction can be queued at once, even offline and before the Central System has assigned
 * a transaction id: the id is filled in when StartTransaction.conf arrives.
 */
export interface QueuedTransaction {
  /** Local reference, stored with every queued message of this transaction. */
  readonly ref: string;
  /** The Central System's transaction id, once StartTransaction.conf has arrived. */
  readonly transactionId: number | undefined;
  /** Resolves with StartTransaction.conf once delivered; rejects if the start is abandoned. */
  readonly started: Promise<ChargePointResponse<'StartTransaction'>>;
  /** Queue MeterValues for this transaction's connector. */
  meterValues(meterValue: MeterValue[]): Promise<ChargePointResponse<'MeterValues'>>;
  /** Queue the StopTransaction. Later calls on this handle reject. */
  stop(
    request: Omit<ChargePointRequest<'StopTransaction'>, 'transactionId'>,
  ): Promise<ChargePointResponse<'StopTransaction'>>;
}

interface Deferred {
  readonly resolve: (value: JsonObject) => void;
  readonly reject: (error: Error) => void;
}

/**
 * An OCPP 1.6-J Charge Point client.
 *
 * - Reconnects automatically with exponential backoff and full jitter.
 * - Delivers StartTransaction, StopTransaction and MeterValues reliably: they are persisted in an
 *   offline queue and replayed in order after reconnecting, with bounded retries on CALLERROR.
 * - Other messages are sent immediately and fail fast with {@link NotConnectedError} when offline.
 */
export class ChargePoint extends TypedEventEmitter<ChargePointEvents> {
  /** Charge point identity. */
  readonly identity: string;
  readonly #options: ChargePointOptions;
  readonly #handlers = new HandlerRegistry<Inbound, ChargePointHandlerContext>();
  readonly #queue: OfflineQueue | undefined;
  readonly #deferred = new Map<number, Deferred>();
  readonly #attempts = new Map<number, number>();
  readonly #connector: Connector;
  #peer: RpcPeer<Inbound, Outbound, ChargePointHandlerContext> | undefined;
  #state: ChargePointState = 'idle';
  #stopped = false;
  #draining = false;
  #running: Promise<void> | undefined;
  readonly #wakers = new Set<() => void>();
  #connectWaiters: Deferred[] = [];
  readonly #holdUntilBootAccepted: boolean;
  #registrationStatus: RegistrationStatus | undefined;
  /** Delay of the next reconnect when {@link reconnectAfter} asked for one. */
  #reconnectDelay: number | undefined;
  /** Transaction ids of {@link QueuedTransaction}s whose StartTransaction has been answered. */
  readonly #transactionIds = new Map<string, number>();
  /** References of transactions whose StartTransaction was abandoned. */
  readonly #failedRefs = new Set<string>();

  constructor(options: ChargePointOptions) {
    super();
    this.identity = options.identity;
    this.#options = options;
    this.#connector = options.connector ?? webSocketConnector;
    if (options.offlineQueue !== false) {
      this.#queue = new OfflineQueue(
        options.offlineQueue?.store ?? new MemoryQueueStore(),
        options.offlineQueue?.maxSize,
      );
    }
    this.#holdUntilBootAccepted =
      options.offlineQueue === false
        ? false
        : (options.offlineQueue?.holdUntilBootAccepted ?? true);
  }

  /**
   * Status of the latest BootNotification answered on this client, or `undefined` before the
   * first one. Queued transaction messages are only replayed while it is `Accepted` (see
   * {@link OfflineQueueOptions.holdUntilBootAccepted}).
   */
  get registrationStatus(): RegistrationStatus | undefined {
    return this.#registrationStatus;
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
    return this.#queue?.size ?? 0;
  }

  /** Endpoint URL including the identity. */
  get endpoint(): string {
    return `${this.#options.url.replace(/\/+$/, '')}/${encodeURIComponent(this.identity)}`;
  }

  /** Register a typed handler for a Central System initiated action. */
  handle<A extends ActionName<Inbound>>(
    action: A,
    handler: RequestHandler<Inbound, A, ChargePointHandlerContext>,
  ): this {
    this.#handlers.set(action, handler);
    return this;
  }

  /**
   * Connect (retrying per the reconnect policy) and resolve once the first connection is open.
   * Loads persisted offline messages first so they are replayed right after connecting.
   */
  async connect(): Promise<void> {
    if (this.#stopped) throw new OcppKitError('ChargePoint has been closed');
    if (this.isConnected) return;
    const opened = new Promise<void>((resolve, reject) => {
      this.#connectWaiters.push({ resolve: () => resolve(), reject });
    });
    if (!this.#running) {
      await this.#queue?.init();
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
  call<A extends ChargePointAction>(
    action: A,
    payload: ChargePointRequest<A>,
    options?: CallOptions,
  ): Promise<ChargePointResponse<A>> {
    if (this.#queue && isTransactionAction(action)) {
      return this.#enqueue(action, payload);
    }
    const peer = this.#peer;
    if (!peer?.isOpen) return Promise.reject(new NotConnectedError(action));
    const pending = peer.call(action, payload, options);
    if (action !== 'BootNotification') return pending;
    return pending.then((response) => {
      this.#onBootResponse(response as ChargePointResponse<'BootNotification'>);
      return response;
    });
  }

  /**
   * Start a transaction whose messages all go through the offline queue (see
   * {@link QueuedTransaction}). Messages are delivered in order and, with a persistent store,
   * survive restarts: a restarted client fills in the transaction id as soon as it has replayed
   * the StartTransaction. Without an offline queue the messages are sent directly, each after
   * StartTransaction.conf has arrived.
   */
  startTransaction(request: ChargePointRequest<'StartTransaction'>): QueuedTransaction {
    const ref = randomUUID();
    const queued = this.#queue !== undefined;
    let transactionId: number | undefined;
    let stopped = false;
    const started = (
      queued
        ? (this.#enqueue('StartTransaction', request, ref) as Promise<
            ChargePointResponse<'StartTransaction'>
          >)
        : this.call('StartTransaction', request)
    ).then((response) => {
      transactionId = response.transactionId;
      return response;
    });
    // The caller may never look at `started`; the follow-up calls report failures anyway.
    started.catch(() => undefined);
    const follow = (action: 'MeterValues' | 'StopTransaction', payload: JsonObject) => {
      if (stopped) return Promise.reject(new OcppKitError(`Transaction ${ref} already stopped`));
      if (action === 'StopTransaction') stopped = true;
      if (!queued) {
        return started.then((response) =>
          this.call(action, { ...payload, transactionId: response.transactionId } as never),
        );
      }
      if (this.#failedRefs.has(ref)) {
        if (stopped) this.#failedRefs.delete(ref);
        return Promise.reject(new TransactionNotStartedError(ref));
      }
      const known = this.#transactionIds.get(ref);
      return known === undefined
        ? this.#enqueue(action, payload, ref)
        : this.#enqueue(action, { ...payload, transactionId: known }, ref);
    };
    return {
      ref,
      get transactionId() {
        return transactionId;
      },
      started,
      meterValues: (meterValue) =>
        follow('MeterValues', { connectorId: request.connectorId, meterValue }),
      stop: (stopRequest) => follow('StopTransaction', stopRequest),
    };
  }

  #onBootResponse(response: ChargePointResponse<'BootNotification'>): void {
    this.#registrationStatus = response.status;
    if (response.status === 'Accepted') void this.#drain();
  }

  /**
   * Close the current connection and connect again after `delayMs` instead of the backoff
   * delay, keeping the offline queue and pending calls. A charge point whose BootNotification was
   * Rejected can use it to stay off the network until the retry interval has passed (OCPP 1.6
   * section 4.2). The reconnect happens even when automatic reconnects are disabled.
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

  /**
   * @param transactionRef - for StartTransaction the reference it defines; for MeterValues and
   *   StopTransaction the transaction whose id is filled in on delivery if `payload` lacks one
   */
  async #enqueue(
    action: QueuedMessage['action'],
    payload: JsonObject,
    transactionRef?: string,
  ): Promise<JsonObject> {
    const queue = this.#queue;
    if (!queue) throw new OcppKitError('Offline queue disabled');
    if (this.#options.validateOutbound ?? true) {
      // A payload waiting for its transaction id is checked as if the id were already there.
      const pending =
        transactionRef !== undefined &&
        action !== 'StartTransaction' &&
        payload.transactionId === undefined;
      const error = validatePayload(
        ChargePointToCentralSystem[action].request,
        pending ? { ...payload, transactionId: 0 } : payload,
        `${action} request`,
      );
      if (error) throw error;
    }
    if (this.#stopped) throw new ConnectionClosedError(1000, 'Client closed');
    // Load persisted messages first: saving before that would overwrite them.
    await queue.init();
    if (this.#isStopped()) throw new ConnectionClosedError(1000, 'Client closed');
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

  async #drain(): Promise<void> {
    const queue = this.#queue;
    if (!queue || this.#draining) return;
    this.#draining = true;
    const maxAttempts = this.#options.transactionMessageAttempts ?? 3;
    const retryInterval = this.#options.transactionMessageRetryIntervalMs ?? 5_000;
    try {
      for (;;) {
        const peer = this.#peer;
        const head = queue.peek();
        if (!peer?.isOpen || !head || this.#stopped || this.#queueHeld()) return;
        const payload = this.#payloadFor(head);
        if (!payload) {
          // Its StartTransaction was abandoned (or lost from the store): no id to send it with.
          await this.#settleQueued(head, new TransactionNotStartedError(head.transactionRef ?? ''));
          continue;
        }
        queue.setInFlight(head.seq);
        try {
          const response = await peer.call(head.action, payload as never);
          await this.#settleQueued(head, response);
        } catch (error) {
          if (error instanceof ConnectionClosedError) return;
          const attempts = (this.#attempts.get(head.seq) ?? 0) + 1;
          const retryable = error instanceof RpcError || error instanceof CallTimeoutError;
          if (!retryable || attempts >= maxAttempts) {
            await this.#settleQueued(
              head,
              error instanceof Error ? error : new Error(String(error)),
            );
          } else {
            this.#attempts.set(head.seq, attempts);
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

  /**
   * The payload to send for a queued message, with a late-bound transaction id filled in, or
   * `undefined` when the message waits for a transaction id that will never come.
   */
  #payloadFor(message: QueuedMessage): JsonObject | undefined {
    const ref = message.transactionRef;
    if (
      ref === undefined ||
      message.action === 'StartTransaction' ||
      message.payload.transactionId !== undefined
    ) {
      return message.payload;
    }
    const transactionId = this.#transactionIds.get(ref);
    return transactionId === undefined ? undefined : { ...message.payload, transactionId };
  }

  async #settleQueued(message: QueuedMessage, outcome: JsonObject | Error): Promise<void> {
    const queue = this.#queue;
    const ref = message.transactionRef;
    if (message.action === 'StartTransaction' && ref !== undefined) {
      if (outcome instanceof Error) {
        this.#failedRefs.add(ref);
        await queue?.remove(message.seq);
        this.#finish(message, outcome);
        for (const dependent of (await queue?.removeDependents(ref)) ?? []) {
          this.#finish(dependent, new TransactionNotStartedError(ref, { cause: outcome }));
        }
        return;
      }
      const { transactionId } = outcome as ChargePointResponse<'StartTransaction'>;
      // Record the id before anything else can run, so a MeterValues queued from now on is
      // created with it; completeStart() rewrites the ones already queued.
      this.#transactionIds.set(ref, transactionId);
      await queue?.completeStart(message.seq, ref, transactionId);
    } else {
      await queue?.remove(message.seq);
      if (message.action === 'StopTransaction' && ref !== undefined) {
        this.#transactionIds.delete(ref);
        this.#failedRefs.delete(ref);
      }
    }
    this.#finish(message, outcome);
  }

  /** Settle the caller's promise of a queued message and report the outcome. */
  #finish(message: QueuedMessage, outcome: JsonObject | Error): void {
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

  #createPeer(duplex: Duplex): RpcPeer<Inbound, Outbound, ChargePointHandlerContext> {
    const peer = new RpcPeer(duplex, {
      inbound: CentralSystemToChargePoint,
      outbound: ChargePointToCentralSystem,
      handlers: this.#handlers,
      context: { chargePoint: this },
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
          protocols: [OCPP16_SUBPROTOCOL],
          headers,
          handshakeTimeoutMs: this.#options.handshakeTimeoutMs ?? 10_000,
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
