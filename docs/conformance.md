# Conformance checker

`ocpp-kit conform` connects to a Central System (CSMS) as a charge point, runs a fixed list of
checks against it and reports each one with the specification clause it verifies and a level:

- **MUST**: the check verifies a SHALL/MUST of OCPP 1.6, OCPP-J 1.6, the OCPP 1.6 security
  whitepaper, or an RFC they build on (RFC 6455 for WebSocket). A failed MUST check makes the
  command exit with status 1.
- **SHOULD**: the check verifies a recommendation, or a robustness property that
  interoperability with real charge points depends on. The reference column says which; where
  OCPP does not specify the behaviour at all, it says so. SHOULD failures are reported but do
  not change the exit status.

The checker is a testing tool, not a certification. It exercises the Central System side of
the parts of OCPP 1.6-J that a charge point can drive; it cannot see what the Central System
does internally, and it cannot prove the absence of bugs it has no check for.

```bash
ocpp-kit conform --url ws://localhost:9220 --identity CP001
ocpp-kit conform --url wss://csms.example.com/ocpp --identity CP001 \
  --ca ca.pem --cert cp001.pem --key cp001.key --format junit --output conformance.xml
ocpp-kit conform --list          # the checks with their references
```

| Flag                            | Meaning                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `--url`, `--identity`           | Endpoint without the identity, and the identity to connect as (required)      |
| `--password`                    | HTTP Basic auth password (Security Profiles 1 and 2)                          |
| `--ca`, `--cert`/`--key`        | CA to trust for `wss://`; client certificate for Security Profile 3           |
| `--id-tag`                      | Id tag used for Authorize and the test transactions (default `OCPPKIT-PROBE`) |
| `--format`, `--output`          | `text` (default, streamed), `json` or `junit`; write to a file                |
| `--timeout`                     | How long to wait for any single answer (default 10 s)                         |
| `--observe`                     | Observation window for CALLs and duplicate connections (default 5 s)          |
| `--latency-budget`, `--samples` | Acceptable Heartbeat p95 (default 1 s) and number of Heartbeats (20)          |
| `--only`, `--skip`              | Comma-separated check ids or groups (`rpc`, `boot`, ...)                      |

Exit status: `0` when every MUST check that ran passed or was skipped, `1` when a MUST check
failed or could not be carried out (status `error`, e.g. the endpoint is unreachable or the
BootNotification was not accepted), `2` for invalid usage.

The same checks are available as a library:

```ts
import { formatText, ocpp16Conformance, runConformance } from 'ocpp-kit';

const report = await runConformance(ocpp16Conformance, { url, identity: 'CP001' });
console.log(formatText(report));
```

## What a run does to the Central System

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

## The checks

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

## How the checks are tested

Every check is proven to be able to fail: `test/conformance/checks.test.ts` runs the suite
against a small Central System written directly on `ws` (`test/conformance/fixture-csms.ts`),
which passes every check, and against one copy of it per check with exactly one rule broken
(no subprotocol, a missing `currentTime`, no pong, `NotSupported` for unknown actions, two
CALLs at once, and so on). A test asserts that the table of breakages covers every check. The
TLS check is tested the same way with certificates generated by `openssl`
(`test/tls/conformance.test.ts`).

CI runs the built CLI against the demo CSMS (`ocpp-kit csms --password ... --auto-start 1s`)
and fails on any MUST failure; a second run writes a JUnit report kept as a build artifact.

## Design

The checker is split so that a second protocol version can be added without touching the
runner:

- `src/conformance/probe.ts`: `ProbeConnection`, a raw WebSocket client that sends any text,
  records every frame and answers the Central System through a pluggable responder with an
  adjustable delay.
- `src/conformance/runner.ts` and `types.ts`: version-agnostic `runConformance(suite, options)`,
  check selection, dependencies between checks, the shared session and result statuses.
- `src/conformance/report.ts`: text, JSON and JUnit renderers.
- `src/conformance/v16/`: the OCPP 1.6-J suite (connection, Core and RPC checks, and the
  declining charge point responder).
