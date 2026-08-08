import {
  basicAuthCheck,
  clientCertificateCheck,
  duplicateConnectionCheck,
  pingCheck,
  subprotocolCheck,
  subprotocolRefusalCheck,
} from '../common/connection-checks.js';
import { now } from '../common/exchange.js';
import {
  errorCodesCheck,
  invalidPayloadCheck,
  latencyCheck,
  malformedFrameCases,
  malformedFrameCheck,
  malformedJsonCheck,
  serverCallsCheck,
  singleOutstandingCallCheck,
  unknownActionCheck,
  unknownActionCodeCheck,
  unknownMessageTypeCheck,
  unmatchedResponseCheck,
} from '../common/rpc-checks.js';
import type { Check } from '../types.js';
import {
  authorize,
  bootClock,
  bootInterval,
  bootResponse,
  dataTransfer,
  heartbeat,
  meterValuesMainMeter,
  securityEvent,
  statusNotification,
  transactionEnded,
  transactionEndedUnknown,
  transactionOffline,
  transactionReplay,
  transactionStarted,
  transactionUpdated,
} from './core.js';
import { KIT201, send } from './shared.js';

const PART4 = 'OCPP-J 2.0.1 (Part 4)';
const CODES = `${PART4}, RPC Framework Error Codes`;

const authorize201 = (payload: string) => (id: string) =>
  `[2,${JSON.stringify(id)},"Authorize",${payload}]`;

/** Every OCPP 2.0.1 CSMS check, in execution order. */
export const OCPP201_CHECKS: readonly Check[] = [
  subprotocolCheck(KIT201, `${PART4}, OCPP version (WebSocket subprotocol)`),
  subprotocolRefusalCheck(`${PART4}, OCPP version; RFC 6455 §4.2.2`),
  basicAuthCheck('OCPP 2.0.1 Part 2, Security (Security Profiles 1 and 2); RFC 7617'),
  clientCertificateCheck('OCPP 2.0.1 Part 2, Security (Security Profile 3)'),
  pingCheck('RFC 6455 §5.5.2'),
  bootResponse,
  bootInterval,
  bootClock,
  heartbeat,
  statusNotification,
  authorize,
  transactionStarted,
  transactionUpdated,
  transactionEnded,
  transactionOffline,
  transactionReplay,
  transactionEndedUnknown,
  meterValuesMainMeter,
  securityEvent,
  dataTransfer,
  unknownActionCheck(KIT201, `${PART4}, CALLERROR`),
  unknownActionCodeCheck(
    KIT201,
    `${CODES} (NotImplemented: Requested Action is not known by receiver)`,
  ),
  invalidPayloadCheck(KIT201, CODES, [
    {
      label: 'Authorize without idToken',
      raw: authorize201('{}'),
      expected: ['OccurrenceConstraintViolation', 'ProtocolError', 'FormatViolation'],
    },
    {
      label: 'Authorize with a numeric idToken',
      raw: authorize201('{"idToken":{"idToken":12345,"type":"Central"}}'),
      expected: ['TypeConstraintViolation', 'FormatViolation'],
    },
    {
      label: 'Authorize with a 37-character idToken',
      raw: authorize201(JSON.stringify({ idToken: { idToken: 'X'.repeat(37), type: 'Central' } })),
      expected: ['PropertyConstraintViolation', 'OccurrenceConstraintViolation', 'FormatViolation'],
    },
  ]),
  malformedFrameCheck(
    KIT201,
    `${CODES} (RpcFrameworkError, FormatViolation)`,
    malformedFrameCases({
      withoutPayload: ['RpcFrameworkError', 'ProtocolError', 'FormatViolation'],
      stringPayload: ['FormatViolation', 'TypeConstraintViolation', 'RpcFrameworkError'],
      longId: [
        'RpcFrameworkError',
        'FormatViolation',
        'ProtocolError',
        'PropertyConstraintViolation',
      ],
    }),
  ),
  malformedJsonCheck(KIT201, `Robustness (${PART4}: no message id to answer)`),
  unknownMessageTypeCheck(KIT201, 'OCPP-J 2.0.1 §4.1.3', ['MessageTypeNotSupported']),
  unmatchedResponseCheck(KIT201, `Robustness (${PART4}: responses are matched by message id)`),
  latencyCheck(KIT201, 'Performance (OCPP does not specify response times)'),
  duplicateConnectionCheck(KIT201, 'Robustness (OCPP 2.0.1 does not specify this)'),
  // An Available connector invites a RequestStartTransaction.
  singleOutstandingCallCheck(KIT201, `${PART4}, synchronicity`, (connection, context) =>
    send(
      connection,
      'StatusNotification',
      { timestamp: now(), connectorStatus: 'Available', evseId: 1, connectorId: 1 },
      context.options.timeoutMs,
    ),
  ),
  serverCallsCheck(
    KIT201,
    `${PART4}, RPC framework; OCPP 2.0.1 JSON schemas`,
    'OCPP 2.0.1 CSMS',
    'Request',
  ),
  errorCodesCheck(KIT201, CODES),
];
