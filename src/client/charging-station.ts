import {
  OCPP201_PROTOCOL,
  type ChargingStationToCsms,
  type CsmsToChargingStation,
  type v201,
} from '../messages/index.js';
import { OcppClient, type OcppClientEvents, type OcppClientOptions } from './client.js';
import type { EvictionPolicy, QueuedMessage } from './offline-queue.js';

/** Context passed to every OCPP 2.0.1 Charging Station handler. */
export interface ChargingStationHandlerContext {
  readonly chargingStation: ChargingStation;
}

/** Options of {@link ChargingStation}. */
export type ChargingStationOptions = OcppClientOptions;

/** Events emitted by {@link ChargingStation}. */
export type ChargingStationEvents = OcppClientEvents<'TransactionEvent'>;

/** Trigger reasons of TransactionEvent messages that only carry periodic meter values. */
const SAMPLE_TRIGGERS: ReadonlySet<string> = new Set(['MeterValuePeriodic', 'MeterValueClock']);

/**
 * What a full 2.0.1 offline queue may discard: `Updated` events that only report periodic or
 * clock-aligned meter values. `Started` and `Ended` events, and updates that change the state of
 * a transaction, are kept. A discarded event leaves a gap in the `seqNo` sequence, which is how
 * the CSMS can tell that something is missing.
 */
export const evictMeterValueUpdates: EvictionPolicy<'TransactionEvent'> = (message) => {
  const payload = message.payload as Partial<v201.TransactionEventRequest>;
  return payload.eventType === 'Updated' && SAMPLE_TRIGGERS.has(payload.triggerReason ?? '');
};

/**
 * An OCPP 2.0.1 Charging Station client.
 *
 * - Reconnects automatically with exponential backoff and full jitter.
 * - Delivers TransactionEvent messages reliably: they are persisted in an offline queue and
 *   replayed in order after an accepted BootNotification, with bounded retries on CALLERROR
 *   (`MessageAttempts` / `MessageAttemptInterval` of `OCPPCommCtrlr`). The transaction id is
 *   chosen by the station, so events of a transaction that started offline need no late binding.
 * - Other messages are sent immediately and fail fast with `NotConnectedError` when offline.
 *
 * ```ts
 * const cs = new ChargingStation({ identity: 'CS-001', url: 'ws://localhost:9220' });
 * await cs.connect();
 * await cs.call('BootNotification', {
 *   chargingStation: { vendorName: 'Acme', model: 'Wallbox 22' },
 *   reason: 'PowerUp',
 * });
 * ```
 */
export class ChargingStation extends OcppClient<
  typeof ChargingStationToCsms,
  typeof CsmsToChargingStation,
  ChargingStationHandlerContext,
  'TransactionEvent'
> {
  constructor(options: ChargingStationOptions) {
    const context: { chargingStation?: ChargingStation } = {};
    super(
      {
        protocol: OCPP201_PROTOCOL,
        queued: OCPP201_PROTOCOL.transactionActions,
        evictable: evictMeterValueUpdates,
      },
      options,
      context as ChargingStationHandlerContext,
    );
    context.chargingStation = this;
  }

  /** Status of the latest BootNotificationResponse on this client, if any. */
  get registrationStatus(): v201.RegistrationStatus | undefined {
    return this.bootStatus as v201.RegistrationStatus | undefined;
  }

  /**
   * Whether TransactionEvent messages wait for delivery: of `transactionId`, or of any
   * transaction. This is the `messagesInQueue` of a GetTransactionStatusResponse.
   */
  hasQueuedEvents(transactionId?: string): boolean {
    const queued: readonly QueuedMessage<'TransactionEvent'>[] = this.queue?.list() ?? [];
    return queued.some(
      (message) =>
        transactionId === undefined ||
        (message.payload as Partial<v201.TransactionEventRequest>).transactionInfo
          ?.transactionId === transactionId,
    );
  }
}
