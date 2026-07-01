/** OCPP 1.6 checks of the Core operations a charge point initiates. */
import { randomInt } from 'node:crypto';
import type { ChargePointAction, ChargePointRequest, MeterValue } from '../../messages/index.js';
import type { ProbeConnection } from '../probe.js';
import type { Check, CheckContext, CheckOutcome } from '../types.js';
import {
  BOOT,
  boot,
  fail,
  failed,
  now,
  pass,
  registered,
  send,
  type BootRecord,
  type Exchange,
} from './shared.js';

/** State key of the transaction opened by `transaction.start`. */
const TRANSACTION = 'v16.transaction';

interface OpenTransaction {
  readonly transactionId: number;
  readonly meterStart: number;
}

function startRequest(
  context: CheckContext,
  connectorId: number,
  meterStart: number,
): ChargePointRequest<'StartTransaction'> {
  return { connectorId, idTag: context.options.idTag, meterStart, timestamp: now() };
}

function energySample(
  valueWh: number,
  context: 'Sample.Periodic' | 'Sample.Clock' | 'Transaction.End',
): MeterValue {
  return {
    timestamp: now(),
    sampledValue: [
      {
        value: String(valueWh),
        context,
        measurand: 'Energy.Active.Import.Register',
        location: 'Outlet',
        unit: 'Wh',
      },
    ],
  };
}

/** Stop the transactions a check opened, without consumption; the answers do not matter. */
async function stopQuietly(
  connection: ProbeConnection,
  context: CheckContext,
  transactions: readonly OpenTransaction[],
): Promise<void> {
  const stopped = new Set<number>();
  for (const { transactionId, meterStart } of transactions) {
    if (stopped.has(transactionId)) continue;
    stopped.add(transactionId);
    await send(
      connection,
      'StopTransaction',
      { transactionId, meterStop: meterStart, timestamp: now(), reason: 'Other' },
      context.options.timeoutMs,
    );
  }
}

export const bootResponse: Check = {
  id: 'boot.response',
  title: 'Answers BootNotification with a valid BootNotification.conf (RFC 3339 currentTime)',
  level: 'MUST',
  spec: 'OCPP 1.6 §4.2',
  async run(context) {
    const exchange = await boot(await context.session(), context);
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
  spec: 'OCPP 1.6 §4.2; OCPP-J 1.6 §5.3',
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
    if (interval < 1) {
      return Promise.resolve(fail(`interval ${interval} s cannot be a heartbeat interval`));
    }
    if (interval > DAY_S) {
      return Promise.resolve(
        fail(
          `interval ${interval} s: charge points would synchronise their clock less than once a day (OCPP-J 1.6 §5.3 asks for a Heartbeat at least every 24 hours)`,
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
  spec: 'OCPP 1.6 §4.2 (charge points set their clock from it)',
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
function simpleExchange<A extends ChargePointAction>(
  info: Omit<Check, 'run'>,
  action: A,
  payload: (context: CheckContext) => ChargePointRequest<A>,
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
    title: 'Answers Heartbeat with a valid Heartbeat.conf (RFC 3339 currentTime)',
    level: 'MUST',
    spec: 'OCPP 1.6 §4.6',
  },
  'Heartbeat',
  () => ({}),
  ({ payload, rttMs }) => pass(`currentTime ${payload.currentTime}, ${rttMs.toFixed(1)} ms`),
);

export const statusConnector0 = simpleExchange(
  {
    id: 'status.connector0',
    title: 'Accepts StatusNotification for connector 0 (the charge point as a whole)',
    level: 'MUST',
    spec: 'OCPP 1.6 §4.9',
  },
  'StatusNotification',
  () => ({ connectorId: 0, errorCode: 'NoError', status: 'Available', timestamp: now() }),
  () => pass('StatusNotification.conf received'),
);

export const statusConnector: Check = {
  id: 'status.connector',
  title: 'Accepts StatusNotification for connectors 1 and 2',
  level: 'MUST',
  spec: 'OCPP 1.6 §4.9',
  async run(context) {
    const connection = await registered(context);
    const evidence: string[] = [];
    for (const connectorId of [1, 2]) {
      const exchange = await send(
        connection,
        'StatusNotification',
        { connectorId, errorCode: 'NoError', status: 'Available', timestamp: now() },
        context.options.timeoutMs,
      );
      evidence.push(...exchange.evidence);
      if (exchange.kind !== 'result') return failed(exchange, `connector ${connectorId}: `);
    }
    return pass('StatusNotification.conf received for both connectors', evidence);
  },
};

export const authorize = simpleExchange(
  {
    id: 'authorize.response',
    title: 'Answers Authorize with a valid Authorize.conf',
    level: 'MUST',
    spec: 'OCPP 1.6 §4.1',
  },
  'Authorize',
  (context) => ({ idTag: context.options.idTag }),
  ({ payload }, context) => pass(`${context.options.idTag}: ${payload.idTagInfo.status}`),
);

export const transactionStart = simpleExchange(
  {
    id: 'transaction.start',
    title: 'Answers StartTransaction with an integer transactionId and idTagInfo',
    level: 'MUST',
    spec: 'OCPP 1.6 §4.8',
  },
  'StartTransaction',
  (context) => startRequest(context, 1, 1_000),
  ({ payload }, context) => {
    const transaction: OpenTransaction = {
      transactionId: payload.transactionId,
      meterStart: 1_000,
    };
    context.state.set(TRANSACTION, transaction);
    return pass(
      `transactionId ${payload.transactionId}, idTagInfo.status ${payload.idTagInfo.status}`,
    );
  },
);

function openTransaction(context: CheckContext): OpenTransaction {
  const transaction = context.state.get(TRANSACTION) as OpenTransaction | undefined;
  if (!transaction) throw new Error('no transaction recorded');
  return transaction;
}

export const transactionMeterValues = simpleExchange(
  {
    id: 'transaction.meter-values',
    title: 'Accepts MeterValues for the transaction',
    level: 'MUST',
    spec: 'OCPP 1.6 §4.7',
    requires: ['transaction.start'],
  },
  'MeterValues',
  (context) => {
    const { transactionId, meterStart } = openTransaction(context);
    const meterValue = energySample(meterStart + 125, 'Sample.Periodic');
    return {
      connectorId: 1,
      transactionId,
      meterValue: [
        {
          ...meterValue,
          sampledValue: [
            ...meterValue.sampledValue,
            {
              value: '7360',
              context: 'Sample.Periodic',
              measurand: 'Power.Active.Import',
              unit: 'W',
            },
          ],
        },
      ],
    };
  },
  () => pass('MeterValues.conf received'),
);

export const transactionStop = simpleExchange(
  {
    id: 'transaction.stop',
    title: 'Answers StopTransaction with a valid StopTransaction.conf',
    level: 'MUST',
    spec: 'OCPP 1.6 §4.10',
    requires: ['transaction.start'],
  },
  'StopTransaction',
  (context) => {
    const { transactionId, meterStart } = openTransaction(context);
    return {
      transactionId,
      idTag: context.options.idTag,
      meterStop: meterStart + 250,
      timestamp: now(),
      reason: 'Local',
      transactionData: [energySample(meterStart + 250, 'Transaction.End')],
    };
  },
  ({ payload }) =>
    pass(
      payload.idTagInfo
        ? `idTagInfo.status ${payload.idTagInfo.status}`
        : 'StopTransaction.conf without idTagInfo',
    ),
);

export const meterValuesWithoutTransaction = simpleExchange(
  {
    id: 'meter-values.no-transaction',
    title: 'Accepts MeterValues without a transactionId (connector 0, clock-aligned)',
    level: 'MUST',
    spec: 'OCPP 1.6 §4.7',
  },
  'MeterValues',
  () => ({ connectorId: 0, meterValue: [energySample(52_000, 'Sample.Clock')] }),
  () => pass('MeterValues.conf received'),
);

export const transactionIdUnique: Check = {
  id: 'transaction.id-unique',
  title: 'Gives concurrent transactions on two connectors distinct ids',
  level: 'SHOULD',
  spec: 'OCPP 1.6 §4.8 (the transactionId identifies the transaction)',
  async run(context) {
    const connection = await registered(context);
    const opened: OpenTransaction[] = [];
    const evidence: string[] = [];
    try {
      for (const connectorId of [1, 2]) {
        const meterStart = 2_000 * connectorId;
        const exchange = await send(
          connection,
          'StartTransaction',
          startRequest(context, connectorId, meterStart),
          context.options.timeoutMs,
        );
        evidence.push(...exchange.evidence);
        if (exchange.kind !== 'result') return failed(exchange, `connector ${connectorId}: `);
        opened.push({ transactionId: exchange.payload.transactionId, meterStart });
      }
    } finally {
      if (connection.isOpen) await stopQuietly(connection, context, opened);
    }
    const [a, b] = opened.map((transaction) => transaction.transactionId);
    return a !== b
      ? pass(`connector 1 got ${a ?? '?'}, connector 2 got ${b ?? '?'}`, evidence)
      : fail(`both transactions got transactionId ${a ?? '?'}`, evidence);
  },
};

export const transactionStartReplay: Check = {
  id: 'transaction.start-replay',
  title: 'Answers a re-sent identical StartTransaction with the same transactionId',
  level: 'SHOULD',
  spec: "Robustness: charge points re-send transaction messages (OCPP 1.6 'Transaction-related messages')",
  async run(context) {
    const connection = await registered(context);
    const meterStart = 4_000;
    const request = startRequest(context, 1, meterStart);
    const opened: OpenTransaction[] = [];
    const evidence: string[] = [];
    try {
      for (const attempt of ['first', 'replay']) {
        const exchange = await send(
          connection,
          'StartTransaction',
          request,
          context.options.timeoutMs,
        );
        evidence.push(...exchange.evidence);
        if (exchange.kind !== 'result') return failed(exchange, `${attempt}: `);
        opened.push({ transactionId: exchange.payload.transactionId, meterStart });
      }
    } finally {
      if (connection.isOpen) await stopQuietly(connection, context, opened);
    }
    const [first, replay] = opened.map((transaction) => transaction.transactionId);
    return first === replay
      ? pass(`both answers carry transactionId ${first ?? '?'}`, evidence)
      : fail(
          `the replay got transactionId ${replay ?? '?'} after ${first ?? '?'}: one charging session now counts as two transactions`,
          evidence,
        );
  },
};

export const transactionStopUnknown = simpleExchange(
  {
    id: 'transaction.stop-unknown',
    title: 'Answers StopTransaction for an unknown transactionId without a CALLERROR',
    level: 'SHOULD',
    spec: "Robustness: a CALLERROR makes charge points retry it (OCPP 1.6 'Error responses to transaction-related messages')",
  },
  'StopTransaction',
  // A random id near the top of the 32-bit range, which a Central System has hardly issued.
  () => ({
    transactionId: 2_147_000_000 + randomInt(400_000),
    meterStop: 0,
    timestamp: now(),
    reason: 'Other',
  }),
  ({ payload }) =>
    pass(
      payload.idTagInfo
        ? `answered with idTagInfo.status ${payload.idTagInfo.status}`
        : 'answered with an empty StopTransaction.conf',
    ),
);

const UNKNOWN_VENDOR = 'invalid.ocpp-kit.probe';

export const dataTransfer = simpleExchange(
  {
    id: 'data-transfer.unknown-vendor',
    title: 'Answers DataTransfer for an unknown vendorId with UnknownVendorId',
    level: 'MUST',
    spec: 'OCPP 1.6 §4.3',
  },
  'DataTransfer',
  () => ({ vendorId: UNKNOWN_VENDOR, messageId: 'probe', data: 'ocpp-kit conformance probe' }),
  ({ payload }) =>
    payload.status === 'UnknownVendorId'
      ? pass('status UnknownVendorId')
      : fail(`status ${payload.status} for vendorId ${UNKNOWN_VENDOR}`),
);
