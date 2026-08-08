/** OCPP-J 1.6 checks of the RPC framework: error handling, robustness, synchronicity. */
import {
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
import { KIT16, now, send } from './shared.js';

export const unknownAction = unknownActionCheck(KIT16, 'OCPP-J 1.6 §4.2.3');

export const unknownActionCode = unknownActionCodeCheck(
  KIT16,
  'OCPP-J 1.6 §4.2.3 (NotImplemented: requested Action is not known by receiver)',
);

const authorize = (payload: string) => (id: string) =>
  `[2,${JSON.stringify(id)},"Authorize",${payload}]`;

export const invalidPayload = invalidPayloadCheck(KIT16, 'OCPP-J 1.6 §4.2.3', [
  {
    label: 'Authorize without idTag',
    raw: authorize('{}'),
    expected: ['OccurenceConstraintViolation', 'ProtocolError', 'FormationViolation'],
  },
  {
    label: 'Authorize with a numeric idTag',
    raw: authorize('{"idTag":12345}'),
    expected: ['TypeConstraintViolation', 'FormationViolation'],
  },
  {
    label: 'Authorize with a 21-character idTag',
    raw: authorize(JSON.stringify({ idTag: 'X'.repeat(21) })),
    expected: ['PropertyConstraintViolation', 'OccurenceConstraintViolation', 'FormationViolation'],
  },
]);

export const malformedFrame = malformedFrameCheck(
  KIT16,
  'OCPP-J 1.6 §4.2.3',
  malformedFrameCases({
    withoutPayload: ['ProtocolError', 'FormationViolation'],
    stringPayload: ['FormationViolation', 'TypeConstraintViolation'],
    longId: ['FormationViolation', 'ProtocolError', 'PropertyConstraintViolation'],
  }),
);

export const malformedJson = malformedJsonCheck(
  KIT16,
  'Robustness (OCPP-J 1.6 §4.2.3: no message id to answer)',
);

export const unknownMessageType = unknownMessageTypeCheck(KIT16, 'OCPP-J 1.6 §4.1.3');

export const unmatchedResponse = unmatchedResponseCheck(
  KIT16,
  'Robustness (OCPP-J 1.6 §4.1.4: responses are matched by message id)',
);

// An Available connector invites a RemoteStartTransaction.
export const singleOutstandingCall = singleOutstandingCallCheck(
  KIT16,
  'OCPP-J 1.6 §4.1.1',
  (connection, context) =>
    send(
      connection,
      'StatusNotification',
      { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: now() },
      context.options.timeoutMs,
    ),
);

export const serverCalls = serverCallsCheck(
  KIT16,
  'OCPP-J 1.6 §4.1.3, §4.1.4, §4.2.1; OCPP 1.6 JSON schemas',
  'OCPP 1.6 Central System',
  '.req',
);

export const latency = latencyCheck(KIT16, 'Performance (OCPP does not specify response times)');
