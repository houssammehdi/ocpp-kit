# Conformance checker

`ocpp-kit conform` connects to a Central System (CSMS) as an OCPP 1.6 charge point or, with
`--ocpp 2.0.1`, as an OCPP 2.0.1 charging station. It runs a fixed list of checks against it and
reports each one with the specification clause it verifies and a level:

- **MUST**: the check verifies a SHALL/MUST of OCPP 1.6, OCPP-J 1.6, the OCPP 1.6 security
  whitepaper, OCPP 2.0.1 (Parts 2 and 4), or an RFC they build on (RFC 6455 for WebSocket). A
  failed MUST check makes the command exit with status 1.
- **SHOULD**: the check verifies a recommendation, or a robustness property that
  interoperability with real charge points depends on. The reference column says which; where
  OCPP does not specify the behaviour at all, it says so. SHOULD failures are reported but do
  not change the exit status.

The checker is a testing tool, not a certification (for OCPP 2.0.1 that is the OCA's
certification programme with its own test tool). It exercises the Central System side of the
parts of OCPP-J that a charge point can drive; it cannot see what the Central System does
internally, and it cannot prove the absence of bugs it has no check for.

```bash
ocpp-kit conform --url ws://localhost:9220 --identity CP001
ocpp-kit conform --url wss://csms.example.com/ocpp --identity CP001 \
  --ca ca.pem --cert cp001.pem --key cp001.key --format junit --output conformance.xml
ocpp-kit conform --url ws://localhost:9220 --identity CS001 --ocpp 2.0.1
ocpp-kit conform --list          # the checks with their references (add --ocpp 2.0.1)
```

| Flag                            | Meaning                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `--url`, `--identity`           | Endpoint without the identity, and the identity to connect as (required)   |
| `--ocpp`                        | Protocol version to test: `1.6` (default) or `2.0.1`                       |
| `--password`                    | HTTP Basic auth password (Security Profiles 1 and 2)                       |
| `--ca`, `--cert`/`--key`        | CA to trust for `wss://`; client certificate for Security Profile 3        |
| `--id-tag`                      | Id tag / idToken for Authorize and the test transactions (`OCPPKIT-PROBE`) |
| `--format`, `--output`          | `text` (default, streamed), `json` or `junit`; write to a file             |
| `--timeout`                     | How long to wait for any single answer (default 10 s)                      |
| `--observe`                     | Observation window for CALLs and duplicate connections (default 5 s)       |
| `--latency-budget`, `--samples` | Acceptable Heartbeat p95 (default 1 s) and number of Heartbeats (20)       |
| `--only`, `--skip`              | Comma-separated check ids or groups (`rpc`, `boot`, ...)                   |

Exit status: `0` when every MUST check that ran passed or was skipped, `1` when a MUST check
failed or could not be carried out (status `error`, e.g. the endpoint is unreachable or the
BootNotification was not accepted), `2` for invalid usage.

The same checks are available as a library:

```ts
import { formatText, ocpp16Conformance, ocpp201Conformance, runConformance } from 'ocpp-kit';

const report = await runConformance(ocpp16Conformance, { url, identity: 'CP001' });
console.log(formatText(report));
const report201 = await runConformance(ocpp201Conformance, { url, identity: 'CS001' });
```

## What an OCPP 1.6 run does to the Central System

The probe sends a BootNotification (vendor `ocpp-kit`, model `conformance-probe`),
StatusNotifications `Available` for connectors 0, 1 and 2, an Authorize, a handful of short
transactions on connectors 1 and 2 (each stopped again, with no energy or 250 Wh), a
StopTransaction for a random transaction id above 2,147,000,000, a DataTransfer to the vendor
id `invalid.ocpp-kit.probe`, and deliberately invalid frames. It opens a few extra connections
for the same identity (wrong credentials, an unsupported subprotocol, a duplicate connection).

While the checks run, the probe answers the Central System's own CALLs like a charge point
that declines everything with a valid answer (`Rejected`, `NotSupported`, no local list version,
no diagnostics file, and `NotImplemented` for unknown actions). A run therefore changes nothing
on the "charge point" side, but it does leave transactions and status updates in the Central
System's records. Use a test system, or an identity and id tag reserved for testing.

The BootNotification must be answered with `Accepted`. With `Pending` or `Rejected`, every check
that needs a registered charge point reports `error` with the answer received, because OCPP 1.6
§4.2 does not allow a charge point to send other requests before it is accepted.

## The OCPP 1.6 checks

| Id                             | Level  | Verifies                                                                                                                             | Reference                                                 |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `ws.subprotocol`               | MUST   | Selects the `ocpp1.6` subprotocol offered by the charge point                                                                        | OCPP-J 1.6 §3.1.2                                         |
| `ws.subprotocol-refusal`       | SHOULD | Does not open an OCPP session on a subprotocol it does not support                                                                   | OCPP-J 1.6 §3.1.2; RFC 6455 §4.2.2                        |
| `ws.basic-auth`                | MUST   | Refuses a wrong or missing Basic auth password (only with `--password`)                                                              | OCPP 1.6 security whitepaper (Profiles 1 and 2); RFC 7617 |
| `tls.client-certificate`       | MUST   | Refuses TLS connections without a client certificate (only with `--cert`)                                                            | OCPP 1.6 security whitepaper (Profile 3)                  |
| `ws.ping`                      | MUST   | Answers WebSocket pings with pongs                                                                                                   | RFC 6455 §5.5.2; OCPP-J 1.6 §5.3                          |
| `boot.response`                | MUST   | Valid BootNotification.conf, including an RFC 3339 `currentTime`                                                                     | OCPP 1.6 §4.2                                             |
| `boot.interval`                | SHOULD | Heartbeat interval between 1 s and 24 h (retry wait ≥ 0 when not accepted)                                                           | OCPP 1.6 §4.2; OCPP-J 1.6 §5.3                            |
| `boot.clock`                   | SHOULD | `currentTime` within 5 minutes of the probe's clock                                                                                  | OCPP 1.6 §4.2                                             |
| `heartbeat.response`           | MUST   | Valid Heartbeat.conf                                                                                                                 | OCPP 1.6 §4.6                                             |
| `status.connector0`            | MUST   | Accepts StatusNotification for connector 0                                                                                           | OCPP 1.6 §4.9                                             |
| `status.connector`             | MUST   | Accepts StatusNotification for connectors 1 and 2                                                                                    | OCPP 1.6 §4.9                                             |
| `authorize.response`           | MUST   | Valid Authorize.conf (any status)                                                                                                    | OCPP 1.6 §4.1                                             |
| `transaction.start`            | MUST   | StartTransaction.conf with an integer `transactionId` and `idTagInfo`                                                                | OCPP 1.6 §4.8                                             |
| `transaction.meter-values`     | MUST   | Accepts MeterValues for that transaction                                                                                             | OCPP 1.6 §4.7                                             |
| `transaction.stop`             | MUST   | Valid StopTransaction.conf                                                                                                           | OCPP 1.6 §4.10                                            |
| `meter-values.no-transaction`  | MUST   | Accepts MeterValues without `transactionId` (connector 0)                                                                            | OCPP 1.6 §4.7                                             |
| `transaction.id-unique`        | SHOULD | Concurrent transactions on two connectors get distinct ids                                                                           | OCPP 1.6 §4.8                                             |
| `transaction.start-replay`     | SHOULD | A re-sent identical StartTransaction gets the same id                                                                                | Robustness (transaction messages are re-sent)             |
| `transaction.stop-unknown`     | SHOULD | StopTransaction for an unknown id is answered without a CALLERROR                                                                    | Robustness (CALLERRORs make charge points retry)          |
| `data-transfer.unknown-vendor` | MUST   | DataTransfer for an unknown `vendorId` gets `UnknownVendorId`                                                                        | OCPP 1.6 §4.3                                             |
| `rpc.unknown-action`           | MUST   | A CALL with an unknown action gets a CALLERROR with a defined code                                                                   | OCPP-J 1.6 §4.2.3                                         |
| `rpc.unknown-action-code`      | SHOULD | ... and the code is `NotImplemented`                                                                                                 | OCPP-J 1.6 §4.2.3                                         |
| `rpc.invalid-payload`          | SHOULD | Missing, mistyped and too long fields get a fitting CALLERROR code                                                                   | OCPP-J 1.6 §4.2.3                                         |
| `rpc.malformed-frame`          | SHOULD | A CALL without payload, with a string payload, or with a 37-character id gets a CALLERROR                                            | OCPP-J 1.6 §4.2.3                                         |
| `rpc.malformed-json`           | SHOULD | Keeps serving after a frame that is not JSON                                                                                         | Robustness                                                |
| `rpc.unknown-message-type`     | MUST   | Ignores a frame of message type 7 and keeps serving                                                                                  | OCPP-J 1.6 §4.1.3                                         |
| `rpc.unmatched-response`       | SHOULD | Ignores a CALLRESULT and a CALLERROR that answer no CALL                                                                             | Robustness (OCPP-J 1.6 §4.1.4)                            |
| `latency`                      | SHOULD | Heartbeat round-trip p95 within `--latency-budget`                                                                                   | Performance (not specified by OCPP)                       |
| `ws.duplicate-connection`      | SHOULD | Keeps one usable connection when the identity connects twice                                                                         | Robustness (not specified by OCPP 1.6)                    |
| `rpc.single-outstanding-call`  | SHOULD | No second CALL while the probe delays its answer to the first                                                                        | OCPP-J 1.6 §4.1.1                                         |
| `rpc.server-calls`             | MUST   | Every frame the Central System sent was valid OCPP-J; every CALL had a known action, a schema-valid payload and an unused message id | OCPP-J 1.6 §4.1.3, §4.1.4, §4.2.1; OCPP 1.6 JSON schemas  |

Notes on individual checks:

- **Accepted error codes.** OCPP-J defines the codes but not a mapping from each fault to one
  code, so the checks accept every code whose definition fits: for a missing field
  `OccurenceConstraintViolation`, `ProtocolError` or `FormationViolation`; for a mistyped field
  `TypeConstraintViolation` or `FormationViolation`; for a too long string
  `PropertyConstraintViolation`, `OccurenceConstraintViolation` or `FormationViolation`.
- **`ws.subprotocol-refusal`** passes when the Central System either completes the handshake
  without selecting a subprotocol (the probe then fails the connection, as RFC 6455 §4.1
  requires of a client) or refuses the handshake with an HTTP 4xx status.
- **`rpc.single-outstanding-call`** re-registers on a fresh connection, holds the answer to the
  first CALL it receives for `--observe`, and fails if a second CALL arrives meanwhile. It is
  skipped when the Central System sends no CALL within the window; run the Central System with
  something that makes it send CALLs (the demo's `--auto-start`, or a CSMS that configures
  charge points after boot). Keep `--observe` below the Central System's own call timeout:
  after a timeout, sending the next CALL is allowed.
- **`transaction.start-replay`** reflects at-least-once delivery: a charge point that lost the
  connection before StartTransaction.conf arrived sends the same request again, and a Central
  System that answers with a new id ends up with two transactions for one charging session.
- **`ws.duplicate-connection`** passes when the Central System closes either connection, or
  refuses the second, and keeps serving the other; it fails when both stay open and answer,
  because it is then undefined which one receives the Central System's CALLs.

## What an OCPP 2.0.1 run does to the CSMS

The probe offers only the `ocpp2.0.1` subprotocol and sends a BootNotification (vendor
`ocpp-kit`, model `conformance-probe`, reason `PowerUp`), StatusNotifications `Available` for
connector 1 of EVSEs 1 and 2, an Authorize with the idToken `--id-tag` of type `Central`, a few
short transactions with random UUIDs as transaction ids (Started, Updated with meter values,
Ended; one of them marked `offline: true` and time-shifted into the past, one with a repeated
Updated event), an Ended event for a random transaction id the CSMS cannot know, a clock-aligned
MeterValues for EVSE 0 (the main meter), a SecurityEventNotification `StartupOfTheDevice`, a
DataTransfer to the vendor id `invalid.ocpp-kit.probe`, and deliberately invalid frames. It
opens extra connections as the 1.6 suite does.

While the checks run, the probe declines every CSMS request with a valid answer (`Rejected`,
`NotSupported`, `UnknownComponent` for every GetVariables and SetVariables entry, no charging
profiles, local list version 0) and answers unknown actions with `NotImplemented`. The
BootNotification must be answered with `Accepted`; with `Pending` or `Rejected` the checks that
need a registered station report `error`, because OCPP 2.0.1 (B02, B03) restricts what a
station may send before it is accepted.

## The OCPP 2.0.1 checks

The references name the OCPP 2.0.1 Part 2 use case (e.g. E01) or the section of Part 4
(OCPP-J) by title. The one section number given, OCPP-J 2.0.1 §4.1.3, is the one this project
could confirm; the other references are deliberately given by name rather than by a number that
might differ between editions of the specification.

| Id                             | Level  | Verifies                                                                                                    | Reference                                                                |
| ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ws.subprotocol`               | MUST   | Selects the `ocpp2.0.1` subprotocol offered by the charging station                                         | OCPP-J 2.0.1 (Part 4), OCPP version (WebSocket subprotocol)              |
| `ws.subprotocol-refusal`       | SHOULD | Does not open an OCPP session on a subprotocol it does not support                                          | OCPP-J 2.0.1 (Part 4), OCPP version; RFC 6455 §4.2.2                     |
| `ws.basic-auth`                | MUST   | Refuses a wrong or missing Basic auth password (only with `--password`)                                     | OCPP 2.0.1 Part 2, Security (Security Profiles 1 and 2); RFC 7617        |
| `tls.client-certificate`       | MUST   | Refuses TLS connections without a client certificate (only with `--cert`)                                   | OCPP 2.0.1 Part 2, Security (Security Profile 3)                         |
| `ws.ping`                      | MUST   | Answers WebSocket pings with pongs                                                                          | RFC 6455 §5.5.2                                                          |
| `boot.response`                | MUST   | Valid BootNotificationResponse, including an RFC 3339 `currentTime`                                         | OCPP 2.0.1 Part 2, B01 (Cold Boot Charging Station)                      |
| `boot.interval`                | SHOULD | Heartbeat interval between 1 s and 24 h                                                                     | OCPP 2.0.1 Part 2, B01; G02 (Heartbeat)                                  |
| `boot.clock`                   | SHOULD | `currentTime` within 5 minutes of the probe's clock                                                         | OCPP 2.0.1 Part 2, B01                                                   |
| `heartbeat.response`           | MUST   | Valid HeartbeatResponse                                                                                     | OCPP 2.0.1 Part 2, G02 (Heartbeat)                                       |
| `status.notification`          | MUST   | Accepts StatusNotification for the connectors of EVSEs 1 and 2                                              | OCPP 2.0.1 Part 2, G01 (Status Notification)                             |
| `authorize.response`           | MUST   | Valid AuthorizeResponse (any status)                                                                        | OCPP 2.0.1 Part 2, C01 (EV Driver Authorization using RFID)              |
| `transaction.started`          | MUST   | Answers a TransactionEvent Started with a station-generated `transactionId`                                 | OCPP 2.0.1 Part 2, E01 (Start Transaction options)                       |
| `transaction.updated`          | MUST   | Answers a TransactionEvent Updated with meter values                                                        | OCPP 2.0.1 Part 2, J02 (Sending transaction related Meter Values)        |
| `transaction.ended`            | MUST   | Answers a TransactionEvent Ended                                                                            | OCPP 2.0.1 Part 2, E06 (Stop Transaction options)                        |
| `transaction.offline`          | SHOULD | Accepts a transaction that happened offline, delivered afterwards with `offline: true`                      | OCPP 2.0.1 Part 2, E04 (Transaction started while offline)               |
| `transaction.replay`           | SHOULD | Answers a re-sent TransactionEvent (same transaction and `seqNo`) without a CALLERROR                       | Robustness: stations re-send until answered (OCPP 2.0.1 Part 2, E13)     |
| `transaction.ended-unknown`    | SHOULD | Answers a TransactionEvent Ended of an unknown transaction without a CALLERROR                              | Robustness: a CALLERROR makes stations retry it (OCPP 2.0.1 Part 2, E13) |
| `meter-values.main-meter`      | MUST   | Accepts MeterValues of the main meter (`evseId` 0, clock-aligned)                                           | OCPP 2.0.1 Part 2, J01 (Meter Values not related to a transaction)       |
| `security-event.response`      | SHOULD | Answers SecurityEventNotification                                                                           | OCPP 2.0.1 Part 2, A04 (Security Event Notification)                     |
| `data-transfer.unknown-vendor` | MUST   | DataTransfer for an unknown `vendorId` gets `UnknownVendorId`                                               | OCPP 2.0.1 Part 2, P02 (Data Transfer to the CSMS)                       |
| `rpc.unknown-action`           | MUST   | A CALL with an unknown action gets a CALLERROR                                                              | OCPP-J 2.0.1 (Part 4), CALLERROR                                         |
| `rpc.unknown-action-code`      | SHOULD | ... and the code is `NotImplemented`                                                                        | OCPP-J 2.0.1 (Part 4), RPC Framework Error Codes                         |
| `rpc.invalid-payload`          | SHOULD | Missing, mistyped and too long fields get a fitting CALLERROR code                                          | OCPP-J 2.0.1 (Part 4), RPC Framework Error Codes                         |
| `rpc.malformed-frame`          | SHOULD | A CALL without payload, with a string payload, or with a 37-character id gets a CALLERROR                   | OCPP-J 2.0.1 (Part 4), RPC Framework Error Codes                         |
| `rpc.malformed-json`           | SHOULD | Keeps serving after a frame that is not JSON                                                                | Robustness (no message id to answer)                                     |
| `rpc.unknown-message-type`     | MUST   | Ignores a frame of message type 7 and keeps serving                                                         | OCPP-J 2.0.1 §4.1.3                                                      |
| `rpc.unmatched-response`       | SHOULD | Ignores a CALLRESULT and a CALLERROR that answer no CALL                                                    | Robustness (responses are matched by message id)                         |
| `latency`                      | SHOULD | Heartbeat round-trip p95 within `--latency-budget`                                                          | Performance (not specified by OCPP)                                      |
| `ws.duplicate-connection`      | SHOULD | Keeps one usable connection when the identity connects twice                                                | Robustness (not specified by OCPP 2.0.1)                                 |
| `rpc.single-outstanding-call`  | SHOULD | No second CALL while the probe delays its answer to the first                                               | OCPP-J 2.0.1 (Part 4), synchronicity                                     |
| `rpc.server-calls`             | MUST   | Every frame the CSMS sent was valid OCPP-J; every CALL had a known action, a valid payload and an unused id | OCPP-J 2.0.1 (Part 4), RPC framework; OCPP 2.0.1 JSON schemas            |
| `rpc.error-codes`              | MUST   | Every CALLERROR the CSMS sent used a code OCPP 2.0.1 defines (not the 1.6 spellings)                        | OCPP-J 2.0.1 (Part 4), RPC Framework Error Codes                         |

Notes on the 2.0.1 checks:

- **Accepted error codes.** As for 1.6, every code whose definition fits is accepted: for a
  missing field `OccurrenceConstraintViolation`, `ProtocolError` or `FormatViolation`; for a
  mistyped field `TypeConstraintViolation` or `FormatViolation`; for a too long idToken
  `PropertyConstraintViolation`, `OccurrenceConstraintViolation` or `FormatViolation`; for a
  structurally broken CALL also `RpcFrameworkError`.
- **`rpc.error-codes`** collects the CALLERRORs of the whole run (it runs last) and fails when
  one uses a code 2.0.1 does not define, typically the 1.6 spellings
  `OccurenceConstraintViolation` or `FormationViolation` from a CSMS that shares its 1.6 error
  handling. It is skipped when the CSMS sent no CALLERROR.
- **`rpc.unknown-message-type`**: OCPP-J 2.0.1 §4.1.3 (edition 4 of Part 4) says to ignore a
  message with an unknown message type. Earlier text answered it with a
  `MessageTypeNotSupported` CALLERROR, which an errata deprecated; a CSMS that answers that way
  and keeps serving still passes.
- **`transaction.replay`** sends an Updated event twice with the same `seqNo`, as a station does
  when the first TransactionEventResponse was lost; the second copy must be answered like the
  first so the station can move on.
- **`transaction.started`** and the other transaction checks accept any `idTokenInfo` status:
  the probe's idToken need not be known to the CSMS.

## How the checks are tested

Every check is proven to be able to fail: `test/conformance/checks.test.ts` runs the suite
against a small Central System written directly on `ws` (`test/conformance/fixture-csms.ts`),
which passes every check, and against one copy of it per check with exactly one rule broken
(no subprotocol, a missing `currentTime`, no pong, `NotSupported` for unknown actions, two
CALLs at once, and so on). A test asserts that the table of breakages covers every check. The
TLS check is tested the same way with certificates generated by `openssl`
(`test/tls/conformance.test.ts`). The 2.0.1 suite is tested the same way by
`test/conformance/checks-201.test.ts`: the fixture runs in 2.0.1 mode, and a test asserts that
each 2.0.1 check has a breakage that makes it fail and that every breakage is used.

CI runs the built CLI with both suites against the demo CSMS (`ocpp-kit csms --password ...
--auto-start 1s`, which serves 1.6 and 2.0.1 on one port) and fails on any MUST failure;
second runs write JUnit reports kept as build artifacts.

## Design

The checker is split so that the runner, probe and reports know nothing about a protocol
version:

- `src/conformance/probe.ts`: `ProbeConnection`, a raw WebSocket client that sends any text,
  records every frame and answers the Central System through a pluggable responder with an
  adjustable delay.
- `src/conformance/runner.ts` and `types.ts`: version-agnostic `runConformance(suite, options)`,
  check selection, dependencies between checks, the shared session and result statuses.
- `src/conformance/report.ts`: text, JSON and JUnit renderers.
- `src/conformance/common/`: check factories shared by both suites (subprotocol, Basic auth,
  client certificate, ping, duplicate connection, and all RPC-framework checks), parameterised
  by a `SuiteKit` (the protocol definition, how the probe boots, how responses are named), plus
  the helpers that send a typed request and classify the answer.
- `src/conformance/v16/`: the OCPP 1.6-J suite (Core checks, instantiations of the shared
  checks, and the declining charge point responder).
- `src/conformance/v201/`: the OCPP 2.0.1 suite (Core and transaction checks, instantiations of
  the shared checks, `rpc.error-codes`, and the declining charging station responder).
