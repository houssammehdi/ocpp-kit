/** OCPP 2.0.1 checks of the requests a charging station sends. */
import { randomUUID } from 'node:crypto';
import type { StationAction, StationRequest, v201 } from '../../messages/index.js';
import { bootWith, fail, now, pass } from '../common/exchange.js';
import type { Check, CheckContext, CheckOutcome } from '../types.js';
import {
  BOOT,
  failed,
  KIT201,
  probeToken,
  registered,
  send,
  type BootRecord,
  type Exchange,
} from './shared.js';

/** State key of the transaction opened by `transaction.started`. */
const TRANSACTION = 'v201.transaction';

function energy(valueWh: number, context: v201.ReadingContext, at = now()): v201.MeterValue {
  return {
    timestamp: at,
    sampledValue: [
      {
        value: valueWh,
        context,
        measurand: 'Energy.Active.Import.Register',
        location: 'Outlet',
        unitOfMeasure: { unit: 'Wh' },
      },
    ],
  };
}

/** A TransactionEvent of the probe's transaction `transactionId`. */
function event(
  context: CheckContext,
  transactionId: string,
  seqNo: number,
  eventType: v201.TransactionEventKind,
  extra: Partial<v201.TransactionEventRequest> = {},
): v201.TransactionEventRequest {
  const at = extra.timestamp ?? now();
  return {
    eventType,
    timestamp: at,
    triggerReason:
      eventType === 'Started'
        ? 'Authorized'
        : eventType === 'Ended'
          ? 'StopAuthorized'
          : 'MeterValuePeriodic',
    seqNo,
    transactionInfo: {
      transactionId,
      chargingState: eventType === 'Ended' ? 'EVConnected' : 'Charging',
      ...(eventType === 'Ended' ? { stoppedReason: 'Local' } : {}),
    },
    ...(eventType === 'Started'
      ? { evse: { id: 1, connectorId: 1 }, idToken: probeToken(context) }
      : {}),
    meterValue: [
      energy(
        1_000 + 250 * seqNo,
        eventType === 'Started'
          ? 'Transaction.Begin'
          : eventType === 'Ended'
            ? 'Transaction.End'
            : 'Sample.Periodic',
        at,
      ),
    ],
    ...extra,
  };
}

/** Send the events of a whole transaction; returns the first unsuccessful exchange, if any. */
async function sendAll(
  context: CheckContext,
  events: readonly v201.TransactionEventRequest[],
): Promise<{ readonly problem?: Exchange<'TransactionEvent'>; readonly evidence: string[] }> {
  const connection = await registered(context);
  const evidence: string[] = [];
  for (const request of events) {
    const exchange = await send(connection, 'TransactionEvent', request, context.options.timeoutMs);
    evidence.push(...exchange.evidence);
    if (exchange.kind !== 'result') return { problem: exchange, evidence };
  }
  return { evidence };
}

export const bootResponse: Check = {
  id: 'boot.response',
  title: 'Answers BootNotification with a valid BootNotificationResponse (RFC 3339 currentTime)',
  level: 'MUST',
  spec: 'OCPP 2.0.1 Part 2, B01 (Cold Boot Charging Station)',
  async run(context) {
    const exchange = (await bootWith(
      KIT201,
      await context.session(),
      context,
    )) as Exchange<'BootNotification'>;
    if (exchange.kind !== 'result') return failed(exchange);
    const { status, interval, currentTime } = exchange.payload;
    return pass(
      `status ${status}, interval ${interval} s, currentTime ${currentTime}`,
      exchange.evidence,
    );
  },
};

function bootRecord(context: CheckContext): BootRecord {
  const record = context.state.get(BOOT) as BootRecord | undefined;
  if (!record) throw new Error('no BootNotification answer recorded');
  return record;
}

const DAY_S = 86_400;

export const bootInterval: Check = {
  id: 'boot.interval',
  title: 'Hands out a heartbeat interval between 1 s and 24 h',
  level: 'SHOULD',
  spec: 'OCPP 2.0.1 Part 2, B01; G02 (Heartbeat)',
  requires: ['boot.response'],
  run(context) {
    const { status, interval } = bootRecord(context).payload;
    if (status !== 'Accepted') {
      return Promise.resolve(
        interval >= 0
          ? pass(`status ${status}: retry after at least ${interval} s`)
          : fail(`status ${status} with a negative retry interval ${interval}`),
      );
    }
    if (interval < 1)
      return Promise.resolve(fail(`interval ${interval} s cannot be a heartbeat interval`));
    if (interval > DAY_S) {
      return Promise.resolve(
        fail(
          `interval ${interval} s: charging stations would synchronise their clock less than once a day`,
        ),
      );
    }
    return Promise.resolve(pass(`interval ${interval} s`));
  },
};

const CLOCK_TOLERANCE_S = 300;

export const bootClock: Check = {
  id: 'boot.clock',
  title: `Reports a currentTime within ${CLOCK_TOLERANCE_S / 60} minutes of the probe's clock`,
  level: 'SHOULD',
  spec: 'OCPP 2.0.1 Part 2, B01 (charging stations set their clock from it)',
  requires: ['boot.response'],
  run(context) {
    const { payload, receivedAt } = bootRecord(context);
    const offsetS = (Date.parse(payload.currentTime) - receivedAt) / 1_000;
    const details = [
      `currentTime ${payload.currentTime}, probe clock ${new Date(receivedAt).toISOString()}`,
    ];
    return Promise.resolve(
      Math.abs(offsetS) <= CLOCK_TOLERANCE_S
        ? pass(`offset ${offsetS.toFixed(1)} s from this machine's clock`, details)
        : fail(
            `currentTime is ${Math.abs(offsetS).toFixed(0)} s ${offsetS > 0 ? 'ahead of' : 'behind'} this machine's clock`,
            details,
          ),
    );
  },
};

/** A check that sends one request on the registered session and inspects the valid answer. */
function simpleExchange<A extends StationAction>(
  info: Omit<Check, 'run'>,
  action: A,
  payload: (context: CheckContext) => StationRequest<A>,
  onResult: (
    exchange: Extract<Exchange<A>, { kind: 'result' }>,
    context: CheckContext,
  ) => CheckOutcome,
): Check {
  return {
    ...info,
    async run(context) {
      const connection = await registered(context);
      const exchange = await send(connection, action, payload(context), context.options.timeoutMs);
      if (exchange.kind !== 'result') return failed(exchange);
      const outcome = onResult(exchange, context);
      return { ...outcome, details: [...(outcome.details ?? []), ...exchange.evidence] };
    },
  };
}

export const heartbeat = simpleExchange(
  {
    id: 'heartbeat.response',
    title: 'Answers Heartbeat with a valid HeartbeatResponse (RFC 3339 currentTime)',
    level: 'MUST',
    spec: 'OCPP 2.0.1 Part 2, G02 (Heartbeat)',
  },
  'Heartbeat',
  () => ({}),
  ({ payload, rttMs }) => pass(`currentTime ${payload.currentTime}, ${rttMs.toFixed(1)} ms`),
);

export const statusNotification: Check = {
  id: 'status.notification',
  title: 'Accepts StatusNotification for the connectors of EVSEs 1 and 2',
  level: 'MUST',
  spec: 'OCPP 2.0.1 Part 2, G01 (Status Notification)',
  async run(context) {
    const connection = await registered(context);
    const evidence: string[] = [];
    for (const evseId of [1, 2]) {
      const exchange = await send(
        connection,
        'StatusNotification',
        { timestamp: now(), connectorStatus: 'Available', evseId, connectorId: 1 },
        context.options.timeoutMs,
      );
      evidence.push(...exchange.evidence);
      if (exchange.kind !== 'result') return failed(exchange, `EVSE ${evseId}: `);
    }
    return pass('StatusNotificationResponse received for both EVSEs', evidence);
  },
};

export const authorize = simpleExchange(
  {
    id: 'authorize.response',
    title: 'Answers Authorize with a valid AuthorizeResponse',
    level: 'MUST',
    spec: 'OCPP 2.0.1 Part 2, C01 (EV Driver Authorization using RFID)',
  },
  'Authorize',
  (context) => ({ idToken: probeToken(context) }),
  ({ payload }, context) => pass(`${context.options.idTag}: ${payload.idTokenInfo.status}`),
);

/** The transaction the transaction checks share. */
function openTransaction(context: CheckContext): string {
  let transactionId = context.state.get(TRANSACTION) as string | undefined;
  if (transactionId === undefined) {
    transactionId = randomUUID();
    context.state.set(TRANSACTION, transactionId);
  }
  return transactionId;
}

export const transactionStarted = simpleExchange(
  {
    id: 'transaction.started',
    title: 'Answers a TransactionEvent Started with a station-generated transactionId',
    level: 'MUST',
    spec: 'OCPP 2.0.1 Part 2, E01 (Start Transaction options)',
  },
  'TransactionEvent',
  (context) => event(context, openTransaction(context), 0, 'Started'),
  ({ payload }) =>
    pass(
      payload.idTokenInfo
        ? `idTokenInfo.status ${payload.idTokenInfo.status}`
        : 'TransactionEventResponse without idTokenInfo',
    ),
);

export const transactionUpdated = simpleExchange(
  {
    id: 'transaction.updated',
    title: 'Answers a TransactionEvent Updated with meter values',
    level: 'MUST',
    spec: 'OCPP 2.0.1 Part 2, J02 (Sending transaction related Meter Values)',
    requires: ['transaction.started'],
  },
  'TransactionEvent',
  (context) => event(context, openTransaction(context), 1, 'Updated'),
  () => pass('TransactionEventResponse received'),
);

export const transactionEnded = simpleExchange(
  {
    id: 'transaction.ended',
    title: 'Answers a TransactionEvent Ended',
    level: 'MUST',
    spec: 'OCPP 2.0.1 Part 2, E06 (Stop Transaction options)',
    requires: ['transaction.started'],
  },
  'TransactionEvent',
  (context) => event(context, openTransaction(context), 2, 'Ended'),
  () => pass('TransactionEventResponse received'),
);

export const transactionOffline: Check = {
  id: 'transaction.offline',
  title: 'Accepts a transaction that happened offline, delivered afterwards with offline: true',
  level: 'SHOULD',
  spec: 'OCPP 2.0.1 Part 2, E04 (Transaction started while Charging Station is offline)',
  async run(context) {
    const transactionId = randomUUID();
    const start = Date.now() - 20 * 60_000;
    const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
    const { problem, evidence } = await sendAll(context, [
      event(context, transactionId, 0, 'Started', { offline: true, timestamp: at(0) }),
      event(context, transactionId, 1, 'Updated', { offline: true, timestamp: at(5) }),
      event(context, transactionId, 2, 'Ended', { offline: true, timestamp: at(10) }),
    ]);
    return problem
      ? failed(problem, 'offline events: ')
      : pass('all three offline events answered', evidence);
  },
};

export const transactionReplay: Check = {
  id: 'transaction.replay',
  title: 'Answers a re-sent TransactionEvent (same transaction and seqNo) without a CALLERROR',
  level: 'SHOULD',
  spec: 'Robustness: stations re-send TransactionEvents until they are answered (OCPP 2.0.1 Part 2, E13)',
  async run(context) {
    const transactionId = randomUUID();
    const started = event(context, transactionId, 0, 'Started');
    const updated = event(context, transactionId, 1, 'Updated');
    const { problem, evidence } = await sendAll(context, [
      started,
      updated,
      updated,
      event(context, transactionId, 2, 'Ended'),
    ]);
    return problem
      ? failed(problem, 'the replay: ')
      : pass('the repeated Updated event was answered like the first', evidence);
  },
};

export const transactionEndedUnknown = simpleExchange(
  {
    id: 'transaction.ended-unknown',
    title: 'Answers a TransactionEvent Ended of an unknown transaction without a CALLERROR',
    level: 'SHOULD',
    spec: 'Robustness: a CALLERROR makes stations retry it (OCPP 2.0.1 Part 2, E13)',
  },
  'TransactionEvent',
  (context) => event(context, randomUUID(), 7, 'Ended'),
  () => pass('answered with a TransactionEventResponse'),
);

export const meterValuesMainMeter = simpleExchange(
  {
    id: 'meter-values.main-meter',
    title: 'Accepts MeterValues of the main meter (evseId 0, clock-aligned)',
    level: 'MUST',
    spec: 'OCPP 2.0.1 Part 2, J01 (Sending Meter Values not related to a transaction)',
  },
  'MeterValues',
  () => ({ evseId: 0, meterValue: [energy(52_000, 'Sample.Clock')] }),
  () => pass('MeterValuesResponse received'),
);

export const securityEvent = simpleExchange(
  {
    id: 'security-event.response',
    title: 'Answers SecurityEventNotification',
    level: 'SHOULD',
    spec: 'OCPP 2.0.1 Part 2, A04 (Security Event Notification)',
  },
  'SecurityEventNotification',
  () => ({ type: 'StartupOfTheDevice', timestamp: now(), techInfo: 'ocpp-kit conformance probe' }),
  () => pass('SecurityEventNotificationResponse received'),
);

const UNKNOWN_VENDOR = 'invalid.ocpp-kit.probe';

export const dataTransfer = simpleExchange(
  {
    id: 'data-transfer.unknown-vendor',
    title: 'Answers DataTransfer for an unknown vendorId with UnknownVendorId',
    level: 'MUST',
    spec: 'OCPP 2.0.1 Part 2, P02 (Data Transfer to the CSMS)',
  },
  'DataTransfer',
  () => ({ vendorId: UNKNOWN_VENDOR, messageId: 'probe', data: { probe: 'ocpp-kit' } }),
  ({ payload }) =>
    payload.status === 'UnknownVendorId'
      ? pass('status UnknownVendorId')
      : fail(`status ${payload.status} for vendorId ${UNKNOWN_VENDOR}`),
);
