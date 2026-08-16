# OCPP 2.0.1 field notes

Practical notes for people moving a Central System (CSMS) or a charging station from OCPP 1.6-J
to OCPP 2.0.1, or serving both. Like the [1.6 notes](ocpp16-field-notes.md), each note says what
the specification requires, where it leaves room, and what ocpp-kit does; where a behaviour is
an ocpp-kit choice rather than a rule, the note says so.

Use cases of OCPP 2.0.1 Part 2 are cited by their id (E01 is the first use case of functional
block E, Transactions; requirement ids such as K01.FR.06 belong to them). Part 4 (OCPP-J, the
JSON over WebSocket binding) is cited by section title, except §4.1.3, whose number this project
could confirm. The message shapes described here are those of the OCA JSON schemas, which the
ocpp-kit schemas were compared against field by field (see "How the schemas were checked").

## Serving 1.6 and 2.0.1 on one endpoint

- The version is negotiated with the WebSocket subprotocol: `ocpp1.6` or `ocpp2.0.1`. A station
  may offer several; the server selects one in the handshake (RFC 6455 §4.2.2), and the whole
  connection then speaks that version.
- Nothing in OCPP requires a separate URL per version, so one endpoint can serve both. ocpp-kit
  does this with `new CentralSystem({ protocols: ['ocpp2.0.1', 'ocpp1.6'] })`: the list is the
  server's order of preference, so a station that offers both gets 2.0.1.
- Keep the identity space in mind: a 1.6 charge point and a 2.0.1 station may use the same
  identity string. ocpp-kit's registration bookkeeping (`requireAcceptedBoot`) is keyed by
  subprotocol and identity, so a boot accepted on one version does not register the other.

## Error codes are not the same

OCPP-J 2.0.1 defines twelve CALLERROR codes, and they differ from 1.6 in ways that matter to a
CSMS that shares its error handling between versions:

| Meaning                                | OCPP-J 1.6                     | OCPP-J 2.0.1                    |
| -------------------------------------- | ------------------------------ | ------------------------------- |
| Payload does not match the PDU syntax  | `FormationViolation`           | `FormatViolation`               |
| Missing or excess occurrence of fields | `OccurenceConstraintViolation` | `OccurrenceConstraintViolation` |
| Frame is not a valid RPC message       | (none)                         | `RpcFrameworkError`             |
| Unknown message type                   | (none)                         | `MessageTypeNotSupported`       |

- The 1.6 spelling `OccurenceConstraintViolation` (one "r") is not a 2.0.1 code. A 2.0.1 station
  that validates CALLERRORs may treat it as unknown. The conformance check `rpc.error-codes`
  fails a CSMS that sends 1.6 codes on a 2.0.1 connection.
- OCPP-J 2.0.1 §4.1.3 says to ignore a message with an unknown message type. The
  `MessageTypeNotSupported` answer of earlier text was deprecated by an errata, so a receiver
  should ignore such a frame; ocpp-kit does, and its conformance check accepts either behaviour.
- ocpp-kit passes the code set of the connection's version to the parser, the validator and
  the peer. A handler that throws `FormationViolation` on a 2.0.1 connection has it sent as
  `FormatViolation`, and a received code the version does not define is reported as
  `GenericError` with `originalErrorCode` set.

## Transactions: one message, three event types

- 1.6 has StartTransaction, MeterValues and StopTransaction; 2.0.1 has one message,
  TransactionEvent, with `eventType` `Started`, `Updated` or `Ended`, a `triggerReason` saying
  why it was sent, and optional meter values (E01, E06, J02).
- The station generates the `transactionId` (a string of at most 36 characters) and sends it in
  the first event. The CSMS no longer hands out ids, so a transaction that starts offline needs
  no late binding. Two stations may choose the same id; the demo CSMS keys transactions by
  identity and id.
- When a transaction starts is configurable: `TxStartPoint` and `TxStopPoint` of `TxCtrlr` list
  the events (`EVConnected`, `Authorized`, `PowerPathClosed`, `EnergyTransfer`, ...) that start
  and end it. With `TxStartPoint` `EVConnected` a transaction starts when the cable is plugged in,
  before anyone is authorized, so its `Started` event carries no idToken; the idToken arrives in
  a later `Updated` event with `triggerReason` `Authorized`. A CSMS must not assume the idToken
  is in `Started`. The simulator implements these start and stop points
  (`TX_POINTS` lists the ones it supports).
- The TransactionEventResponse has no transaction id and no required fields. `idTokenInfo` is
  expected when the request carried an idToken; its status tells the station whether the driver
  may charge (C01), and a station may end or suspend the transaction when it is not `Accepted`.

## seqNo and at-least-once delivery

- Every TransactionEvent carries a `seqNo`, an incrementing number that lets the CSMS tell
  whether it has received all messages of a transaction.
- The station must deliver transaction events reliably: it keeps them while offline and sends
  them again when a delivery fails, as often as `MessageAttempts` (instance `TransactionEvent`,
  component `OCPPCommCtrlr`) allows, waiting `MessageAttemptInterval` between attempts (E13).
  The CSMS therefore sees duplicates: an event whose response was lost arrives again with the
  same transaction id and `seqNo`. De-duplicate on (identity, transactionId, seqNo) and answer
  the duplicate like the original. The conformance check `transaction.replay` tests this, and
  the demo CSMS does it.
- ocpp-kit numbers `seqNo` per transaction, starting at 0 with the `Started` event. That is an
  ocpp-kit choice; a CSMS should rely on the order and on gaps, not on a particular start value.
- A full offline queue in ocpp-kit discards only `Updated` events with `triggerReason`
  `MeterValuePeriodic` or `MeterValueClock`. `Started`, `Ended` and state changes are kept. A
  discarded event leaves a gap in the `seqNo` sequence, which is how the CSMS can tell.
- Events generated while offline carry `offline: true` and the time they happened, not the time
  they were delivered (E04). Order and bill by `timestamp` and `seqNo`, never by arrival time.

## EVSEs, connectors and `evseId` 0

- 2.0.1 models a station as EVSEs (independently usable charging points, numbered from 1), each
  with connectors numbered from 1 within the EVSE. 1.6's connector 0 has no status equivalent:
  StatusNotification is always for one connector of one EVSE (G01).
- `evseId` 0 still means the station as a whole where a message has an `evseId` field:
  SetChargingProfile for station-wide profiles and MeterValues of the main meter (J01).
  Messages with an optional `evse` object instead, such as ChangeAvailability, address the
  whole station by leaving it out.
- A TransactionEvent names its EVSE (`evse`) in the first event of a transaction; later events
  may omit it. ocpp-kit's simulator sends it in the first event only; the demo CSMS remembers it.

## Meter values changed shape

- `sampledValue.value` is a JSON number in 2.0.1, not a string as in 1.6.
- The unit moved into `unitOfMeasure`, an object with `unit` and a power-of-ten `multiplier`
  (`{ unit: 'kWh', multiplier: 0 }`). Convert with the multiplier before comparing values.
- Measurand, phase, location and context work as in 1.6, but the set of measurands differs
  (1.6's `Temperature` and `RPM` are gone); the simulator samples the 2.0.1 names only
  (`MEASURANDS_201`).

## Configuration is the Device Model

- 1.6's flat configuration keys become components and variables: `OCPPCommCtrlr.HeartbeatInterval`
  rather than `HeartbeatInterval`. GetVariables and SetVariables replace GetConfiguration and
  ChangeConfiguration and address a variable by component (with optional instance and EVSE),
  variable (with optional instance) and attribute type.
- A variable has up to four attributes: `Actual`, `Target`, `MinSet` and `MaxSet`. Omitting the
  attribute type means `Actual`.
- Full reports are asynchronous: GetBaseReport and GetReport are answered at once with a status,
  and the data follows in NotifyReport messages carrying the `requestId`, a `seqNo` and `tbc`
  ("to be continued") until the last part. A CSMS must collect the parts; it cannot expect the
  report in the response. The simulator splits reports into parts, and the demo CSMS logs each
  part.
- The number of entries a station accepts per GetVariables or SetVariables request is itself a
  variable (`DeviceDataCtrlr.ItemsPerMessage`, instances `GetVariables` and `SetVariables`).
  Split large requests accordingly.

## idToken has a type

- An idToken is a value (at most 36 characters) plus a `type` (`ISO14443`, `ISO15693`,
  `eMAID`, `Central`, `Local`, `KeyCode`, `MacAddress`, `NoAuthorization`). The same value with a
  different type is a different token. The simulator keys its Authorization Cache and Local
  Authorization List by type and value, and compares values case-insensitively.
- Group membership moved from `parentIdTag` to `groupIdToken` in `idTokenInfo` (C09).

## Smart charging tightened the rules

The profile purposes and schedule evaluation are those of 1.6, with a few rules a 1.6 CSMS can
fall foul of. These are the K01 requirements the simulator enforces when it answers
SetChargingProfile:

- A `TxProfile` needs a `transactionId` (K01.FR.03) and an EVSE other than 0 (K01.FR.16).
- `ChargingStationExternalConstraints` cannot be set by the CSMS (K01.FR.22); it represents a
  local limit, e.g. from an energy management system, and ClearChargingProfile does not remove
  it (K10.FR.06).
- A `ChargingStationMaxProfile` cannot be `Relative` (K01.FR.38).
- Unlike 1.6, a second profile with the same purpose and stack level on the same EVSE whose
  validity overlaps an installed one is refused instead of replacing it (K01.FR.06; for
  TxProfiles, the same stack level and transaction, K01.FR.39). Replace a profile by reusing its
  id.

## Every object has `customData`

- Every object in the 2.0.1 schemas may carry a `customData` object with a required `vendorId`
  and any other properties, and no object allows other additional properties. ocpp-kit's
  schemas encode both, so a payload with an unknown property is refused with `FormatViolation`,
  while vendor extensions in `customData` pass validation.

## How the schemas were checked

The 2.0.1 schemas in `src/messages/v201/` are written by hand in TypeBox. Before the release
each of the 80 request and response schemas was compiled to JSON Schema and compared, property
by property (types, required fields, enumerations, string length, numeric and array limits,
date-time fields and additional properties), with the JSON schemas shipped in the Python `ocpp` package
(version 2.1.0, `ocpp/v201/schemas`), which are the OCA schemas. The comparison found no
differences; five deliberately injected faults were all reported. The script is not part of the
repository because it needs the Python package; the method is what is documented here.
