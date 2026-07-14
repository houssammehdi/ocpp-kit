# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, minor versions may
contain breaking changes.

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
