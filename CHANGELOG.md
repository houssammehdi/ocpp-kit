# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, minor versions may
contain breaking changes.

## 0.3.0 - 2026-09-26

### Added

- OCPP 2.0.1: a hand-written TypeBox catalogue of 40 of the 64 messages
  (`ChargingStationToCsms`, `CsmsToChargingStation`, the `v201` namespace of types,
  `FUNCTIONAL_BLOCKS`, `ACTION_BLOCKS`, and `UNSUPPORTED_ACTIONS_201` for the 24 left out),
  compared field by field with the official JSON schemas.
- `OcppProtocol`, with `OCPP16_PROTOCOL` and `OCPP201_PROTOCOL`: what the server, the clients
  and the conformance suites need to know about a version.
- The OCPP-J 2.0.1 error codes (`Ocpp201ErrorCodes`, `OCPP201_ERROR_CODES`), and `ErrorCodeSet`
  so that `parseFrame`, `validatePayload` and `RpcPeer` (`errorCodes` option) report faults in
  the vocabulary of the connection's version. Codes thrown by handlers in the other version's
  spelling are translated; received codes the version does not define become `GenericError`
  with `originalErrorCode`.
- `CentralSystem` serves OCPP 1.6 and 2.0.1 on one port with
  `protocols: ['ocpp2.0.1', 'ocpp1.6']` (the server's order of preference). 2.0.1 handlers and
  calls go through `cs.v201`; connections are `ChargePointConnection` or
  `ChargingStationConnection` and carry `version`.
- `ChargingStation`, the OCPP 2.0.1 client, and `OcppClient`, the base class it shares with
  `ChargePoint`. TransactionEvent goes through the offline queue; a full queue evicts only
  periodic and clock-aligned `Updated` events (`evictMeterValueUpdates`).
- `SimulatedChargingStation`: EVSEs, a Device Model with the standard controller variables,
  TransactionEvent driven by TxStartPoint and TxStopPoint, offline queueing, authorization
  (Local Authorization List, Authorization Cache, group idTokens), smart charging with the K01
  rules and external constraints, availability, reservations, firmware updates, log uploads,
  NotifyEvent, SecurityEventNotification and a seeded autopilot. `Fleet` runs either kind or
  both (`create`, `chargerFactory`, `stationFactory`).
- CLI: `ocpp-kit sim --ocpp 1.6|2.0.1|mixed`; `ocpp-kit csms` serves both versions by default
  (`--ocpp both|1.6|2.0.1`), shows each charger's version and maps its commands to it;
  `ocpp-kit conform --ocpp 2.0.1`.
- Conformance: `ocpp201Conformance`, 32 checks of a 2.0.1 CSMS, among them TransactionEvent
  Started/Updated/Ended, offline and replayed events, main-meter MeterValues and
  `rpc.error-codes`. The connection and RPC checks are shared factories in
  `src/conformance/common`. CI runs both suites against the demo CSMS.
- Metrics and logs work on a Central System of either version.
- Benchmarks of the 2.0.1 TransactionEvent (parse, serialise, validate, in-memory round trip)
  and a mixed 1.6/2.0.1 fleet; `examples/multi-version.ts`; `docs/ocpp201-field-notes.md`.

### Changed

- `RpcError.code` and `CallErrorFrame.errorCode` are `RpcErrorCode` (the union of the 1.6 and
  2.0.1 codes) instead of `OcppErrorCode`. Code that switches on them over the 1.6 codes still
  compiles; code that assigns them to an `OcppErrorCode` needs a check such as
  `isOcppErrorCode`.
- `QueuedMessage`, `OfflineQueue` and `QueueInsertion` take the action type as a parameter
  (default: the 1.6 transaction actions); `OfflineQueueStore.load()` and `save()` use
  `QueuedMessage<string>`, so a custom store must accept the actions of either version.
- `FleetStats.connectorStatuses` is keyed by the 1.6 and the 2.0.1 connector statuses;
  `Fleet`, `FleetOptions` and `FleetEvents` take the member type as a parameter (default:
  `SimulatedCharger`).
- `DemoCsms` accepts both versions by default (`protocols` option).
- The smart-charging evaluation (`evaluateProfile`, `compositePeriods`, `maxMinFairShare`, ...)
  is a version-neutral engine shared by both simulators.
- `requireAcceptedBoot` keeps registrations per subprotocol and identity.

### Fixed

- A transaction message queued right before `close()` was lost instead of being kept in the
  queue (in 0.2.0's `ChargePoint` too).
- GetCompositeSchedule could report two periods with the same `startPeriod` when two
  breakpoints less than a second apart rounded to the same second.

## 0.2.0 - 2026-09-25

### Added

- The message catalogue has all 28 OCPP 1.6 messages of the six feature profiles (Firmware
  Management, Local Auth List Management and Reservation are new), plus `FEATURE_PROFILES` and
  `ACTION_PROFILES`.
- The simulator implements all six profiles: sampled and clock-aligned metering with phases
  and `transactionData`; the Authorization Cache and Local Authorization List with
  `LocalPreAuthorize`, `LocalAuthorizeOffline`, `AllowOfflineTxForUnknownId`,
  `StopTransactionOnInvalidId` and parentIdTag groups; reservations with the Reserved state;
  simulated firmware updates and diagnostics uploads with retries and failure injection;
  TriggerMessage for every message; per-profile enabling with `featureProfiles`.
- Security Profiles 2 and 3: the server serves `wss://`, checks client certificates with a
  configurable identity binding (CN, SAN or a function) and reports why it refused; the client
  pins CAs or certificate fingerprints and presents client certificates. CLI flags
  `--tls-cert`, `--tls-key`, `--tls-ca`, `--client-certs`, `--cert-identity` (csms) and
  `--ca`, `--cert`, `--key` (sim).
- Conformance checker: `runConformance()` and `ocpp-kit conform` run 31 checks of a Central
  System, each with a specification reference and a MUST/SHOULD level, with text, JSON and
  JUnit reports. CI runs it against the demo CSMS.
- Observability: `MetricsRegistry` with Prometheus text exposition, `instrumentCentralSystem()`
  and `attachLogger()`; `ocpp-kit csms --metrics-port` and `--log-json`.
- `CentralSystem` emits `callCompleted` for CALLs it sent and `message` for every frame.
- Client: `ChargePoint.startTransaction()` queues a whole transaction before its id is known;
  retry settings can be changed at run time; optional keep-alive pings (`pingIntervalMs`).
- The demo CSMS answers replayed StartTransactions with the same id, handles the firmware and
  diagnostics notifications, and has `reserve`, `cancel`, `trigger`, `config`, `firmware` and
  `diagnostics` commands.
- `npm run bench` (frames, RPC in memory and over WebSockets, fleet load test), property-based
  tests with fast-check, TypeDoc API docs (`npm run docs`), `docs/architecture.md`,
  `docs/conformance.md` and `docs/ocpp16-field-notes.md`.
- `VERSION` constant.

### Changed

- Cached transaction messages are replayed only after an accepted BootNotification (OCPP 1.6
  §4.2); `offlineQueue.holdUntilBootAccepted` (default true) controls it.
- Frames with an unknown message type are ignored instead of being answered (OCPP-J 1.6
  §4.1.3), and a CALL reusing the id of a CALL still being handled gets `GenericError`.
- The simulator no longer accepts unknown id tags offline unless `AllowOfflineTxForUnknownId`
  is set, follows the registration rules of §4.2 (retry, Pending, Rejected), and answers
  GetConfiguration for too many keys with `OccurenceConstraintViolation` instead of
  truncating.
- `ocpp-kit --version` prints the version constant instead of reading `package.json`.

### Fixed

- Timer delays above 2^31-1 ms (e.g. a huge heartbeat interval) no longer turn into 1 ms loops.
- `ocpp-kit sim --json` keeps stdout machine-readable.
- Id tags are compared case-insensitively (CiString).
- TriggerMessage for connector 0 is accepted.
- Absolute charging schedules without `startSchedule` start when charging starts.
- RpcPeer: action names such as `toString` are no longer looked up on the prototype, and stray
  frames of an unknown type no longer settle the call in flight.
- Offline queue: persisted queues of any size are restored; the message being delivered is never
  evicted; enqueuing before `connect()` no longer overwrites the persisted queue; offline
  MeterValues are no longer dropped.
- The demo CSMS answers DataTransfer with `UnknownVendorId`, and main-meter values of connector 0
  no longer make it remote-start connector 0.
- An invalid `--max-power` is a usage error.

## 0.1.0 - 2026-09-25

The first version (commit `41cc852`; no tag).

### Added

- OCPP-J framing, error-code mapping, payload validation and `RpcPeer` with correlation,
  timeouts and one outstanding CALL.
- Typed OCPP 1.6 catalogue for the Core profile, TriggerMessage and Smart Charging.
- `CentralSystem` WebSocket server with Basic auth (Security Profile 1), duplicate-connection
  policy, pings and graceful shutdown; `attach()` to an existing HTTP or HTTPS server.
- `ChargePoint` client with reconnects (backoff with full jitter) and a persistent offline queue
  for transaction messages.
- Simulator: `SimulatedCharger` (connector state machine, EV model, configuration, smart
  charging with max-min fair sharing) and `Fleet`.
- CLI: `ocpp-kit sim` and `ocpp-kit csms`.
- Examples, integration tests over real WebSockets, README and CI on Node 20 and 22.
