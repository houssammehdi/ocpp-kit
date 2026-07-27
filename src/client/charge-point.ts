import { randomUUID } from 'node:crypto';
import {
  OCPP16_PROTOCOL,
  type ChargePointRequest,
  type ChargePointResponse,
  type ChargePointToCentralSystem,
  type CentralSystemToChargePoint,
  type MeterValue,
  type RegistrationStatus,
  type TransactionAction,
} from '../messages/index.js';
import { OcppKitError } from '../rpc/errors.js';
import type { JsonObject } from '../rpc/frames.js';
import { OcppClient, type OcppClientEvents, type OcppClientOptions } from './client.js';
import { evictMeterValues, type QueuedMessage } from './offline-queue.js';

export {
  NotConnectedError,
  type ChargePointState,
  type OfflineQueueOptions,
  type ReconnectOptions,
} from './client.js';

/** Context passed to every Charge Point handler. */
export interface ChargePointHandlerContext {
  readonly chargePoint: ChargePoint;
}

/** Options of {@link ChargePoint}. */
export type ChargePointOptions = OcppClientOptions;

/** Events emitted by {@link ChargePoint}. */
export type ChargePointEvents = OcppClientEvents<TransactionAction>;

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

/**
 * An OCPP 1.6-J Charge Point client.
 *
 * - Reconnects automatically with exponential backoff and full jitter.
 * - Delivers StartTransaction, StopTransaction and MeterValues reliably: they are persisted in an
 *   offline queue and replayed in order after reconnecting, with bounded retries on CALLERROR.
 * - Other messages are sent immediately and fail fast with {@link NotConnectedError} when offline.
 */
export class ChargePoint extends OcppClient<
  typeof ChargePointToCentralSystem,
  typeof CentralSystemToChargePoint,
  ChargePointHandlerContext,
  TransactionAction
> {
  /** Transaction ids of {@link QueuedTransaction}s whose StartTransaction has been answered. */
  readonly #transactionIds = new Map<string, number>();
  /** References of transactions whose StartTransaction was abandoned. */
  readonly #failedRefs = new Set<string>();

  constructor(options: ChargePointOptions) {
    const context: { chargePoint?: ChargePoint } = {};
    super(
      {
        protocol: OCPP16_PROTOCOL,
        queued: OCPP16_PROTOCOL.transactionActions,
        evictable: evictMeterValues,
      },
      options,
      context as ChargePointHandlerContext,
    );
    context.chargePoint = this;
  }

  /**
   * Status of the latest BootNotification answered on this client, or `undefined` before the
   * first one. Queued transaction messages are only replayed while it is `Accepted` (see
   * {@link OfflineQueueOptions.holdUntilBootAccepted}).
   */
  get registrationStatus(): RegistrationStatus | undefined {
    return this.bootStatus as RegistrationStatus | undefined;
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
    const queued = this.queue !== undefined;
    let transactionId: number | undefined;
    let stopped = false;
    const started = (
      queued
        ? (this.enqueue('StartTransaction', request, ref) as Promise<
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
        ? this.enqueue(action, payload, ref)
        : this.enqueue(action, { ...payload, transactionId: known }, ref);
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

  /** A payload waiting for its transaction id is checked as if the id were already there. */
  protected override validationPayload(
    action: TransactionAction,
    payload: JsonObject,
    transactionRef?: string,
  ): JsonObject {
    const pending =
      transactionRef !== undefined &&
      action !== 'StartTransaction' &&
      payload.transactionId === undefined;
    return pending ? { ...payload, transactionId: 0 } : payload;
  }

  /**
   * The payload with a late-bound transaction id filled in, or `undefined` when the message waits
   * for a transaction id that will never come.
   */
  protected override payloadFor(message: QueuedMessage): JsonObject | undefined {
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

  /** Its StartTransaction was abandoned (or lost from the store): no id to send it with. */
  protected override undeliverable(message: QueuedMessage): Error {
    return new TransactionNotStartedError(message.transactionRef ?? '');
  }

  protected override async settleQueued(
    message: QueuedMessage,
    outcome: JsonObject | Error,
  ): Promise<void> {
    const queue = this.queue;
    const ref = message.transactionRef;
    if (message.action === 'StartTransaction' && ref !== undefined) {
      if (outcome instanceof Error) {
        this.#failedRefs.add(ref);
        await queue?.remove(message.seq);
        this.finish(message, outcome);
        for (const dependent of (await queue?.removeDependents(ref)) ?? []) {
          this.finish(dependent, new TransactionNotStartedError(ref, { cause: outcome }));
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
    this.finish(message, outcome);
  }
}
