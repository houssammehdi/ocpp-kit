# Architecture

ocpp-kit is layered so that everything protocol-version specific sits in one place and the
RPC core never touches a socket.

```mermaid
flowchart TB
  subgraph Tools["Tools"]
    CLI["CLI: sim, csms, conform"]
    CONF["conformance: probe, runner, reports<br/>+ v16 suite"]
    BENCH["bench/run.ts"]
  end
  subgraph Roles["OCPP roles"]
    SRV["server: CentralSystem,<br/>ChargePointConnection, TLS, certificates"]
    CLT["client: ChargePoint, backoff,<br/>offline queue + stores, TLS"]
    SIM["simulator: SimulatedCharger, Fleet,<br/>connector state, metering, authorization,<br/>reservations, firmware, smart charging"]
    OBS["observability: metrics registry,<br/>Prometheus exposition, structured logs"]
  end
  subgraph Core["Version-agnostic core"]
    RPC["rpc: frames, error codes, validation,<br/>RpcPeer (correlation, timeouts, one outstanding CALL)"]
    DPX["Duplex (send, close, one receiver)"]
  end
  subgraph V16["OCPP 1.6 specific"]
    MSG["messages/v16: TypeBox schemas for all 28 messages,<br/>action maps, feature profiles"]
  end
  WS["transport: ws adapter"]
  MEM["in-memory duplex pair (tests, benchmarks)"]

  CLI --> SIM & SRV & CONF
  CONF --> CLT
  SIM --> CLT
  OBS -. events .-> SRV
  SRV --> RPC
  CLT --> RPC
  SRV --> MSG
  CLT --> MSG
  RPC --> DPX
  DPX --> WS
  DPX --> MEM
```

## The core: `Duplex` and `RpcPeer`

`RpcPeer<In, Out>` is parameterised by two action catalogues: the actions it receives and
answers (`In`) and the actions it sends (`Out`). A catalogue is a plain object mapping an action
name to a request and a response schema, so the peer itself contains nothing specific to OCPP
1.6: the Central System is `RpcPeer<ChargePointToCentralSystem, CentralSystemToChargePoint>`,
the charge point the other way round. A second protocol version needs a second catalogue, not a
second RPC layer.

The peer talks to a `Duplex`: `send(text)`, `close(code, reason)` and one receiver for messages
and the close event. The `ws` adapter implements it for real sockets, `createDuplexPair()` for
tests and benchmarks.

What happens to an inbound frame:

```mermaid
flowchart TD
  IN["text frame"] --> P{"parseFrame"}
  P -- "not JSON / no string id" --> IGN1["ignore (badMessage event)"]
  P -- "unknown message type" --> IGN2["ignore (OCPP-J 1.6 §4.1.3)"]
  P -- "malformed CALL with id" --> CE1["CALLERROR FormationViolation / ProtocolError"]
  P -- "CALL" --> DUP{"id already being handled?"}
  DUP -- yes --> CE2["CALLERROR GenericError"]
  DUP -- no --> KNOWN{"action in In catalogue?"}
  KNOWN -- no --> CE3["CALLERROR NotImplemented"]
  KNOWN -- "yes, no handler" --> CE4["CALLERROR NotSupported"]
  KNOWN -- yes --> VAL{"request valid?"}
  VAL -- no --> CE5["CALLERROR with the fitting constraint code"]
  VAL -- yes --> H["handler"] --> RV{"response valid?"}
  RV -- no --> CE6["CALLERROR InternalError"]
  RV -- yes --> CR["CALLRESULT"]
  P -- "CALLRESULT / CALLERROR" --> M{"matches the call in flight?"}
  M -- no --> UM["ignore (unmatchedResponse event)"]
  M -- yes --> SETTLE["validate, settle the call, send the next queued CALL"]
```

Outbound calls go through a FIFO queue: the next CALL is only written once the previous one has
been answered, has failed or has timed out (OCPP-J 1.6 §4.1.1). The timeout starts when the
frame is written, not when the call is queued. Property-based tests
(`test/rpc/fuzz.test.ts`) check under random interleavings of calls, answers in any order,
stray frames, aborts and timeouts that there is never more than one CALL outstanding.

## Server

`CentralSystem` owns an HTTP or HTTPS server (or attaches to yours) and handles the WebSocket
upgrade itself, so every refusal is an HTTP answer plus a `rejected` event with a reason:

```mermaid
sequenceDiagram
  participant CP as Charge point
  participant CS as CentralSystem
  CP->>CS: GET /ocpp/CP001 Upgrade: websocket, Sec-WebSocket-Protocol: ocpp1.6
  alt path has no identity
    CS-->>CP: 404
  else Security Profile 3 check fails (no, untrusted or foreign certificate)
    CS-->>CP: 403
  else authenticate() refuses (Basic auth, Profiles 1 and 2)
    CS-->>CP: 401 WWW-Authenticate: Basic
  else duplicate identity with duplicateConnection: 'reject'
    CS-->>CP: 409
  else
    CS-->>CP: 101 (ocpp1.6, or no subprotocol followed by a close)
    Note over CS: an existing connection of the identity is closed (4000) by default
  end
```

Each accepted socket becomes a `ChargePointConnection` with its own `RpcPeer`; all connections
share one handler registry. Liveness uses WebSocket pings; a connection that did not answer the
previous ping is terminated.

## Client

`ChargePoint` wraps a connector (the `ws` one by default) with reconnects (exponential backoff
with full jitter, reset only after a stable connection), keep-alive pings, TLS options, and an
offline queue for StartTransaction, MeterValues and StopTransaction:

```mermaid
stateDiagram-v2
  [*] --> Queued: call() / startTransaction()
  Queued --> InFlight: connected, boot accepted, first in queue
  InFlight --> Delivered: CALLRESULT
  InFlight --> Queued: connection lost (sent again after reconnect)
  InFlight --> Queued: CALLERROR or timeout, attempts left
  InFlight --> Dropped: attempts exhausted
  Queued --> Dropped: evicted (full queue, oldest MeterValues first)
  Delivered --> [*]
  Dropped --> [*]
```

Messages of a transaction started offline carry a transaction reference instead of an id; the
id is filled in when StartTransaction.conf arrives, and the queue (optionally persisted to a
file) survives restarts. Cached messages are replayed only after an accepted BootNotification
(OCPP 1.6 §4.2).

## Simulator

`SimulatedCharger` is a `ChargePoint` plus models, each in its own module with its own tests:

| Module            | Models                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `connector-state` | the StatusNotification state machine of OCPP 1.6 §4.9, incl. Reserved |
| `configuration`   | the standard configuration keys, read-only flags and value validation |
| `metering`        | sampled and clock-aligned meter values, measurands, phases, units     |
| `authorization`   | Authorization Cache, Local Authorization List, offline rules          |
| `reservations`    | ReserveNow / CancelReservation bookkeeping and expiry                 |
| `firmware`        | UpdateFirmware and GetDiagnostics status sequences, retries, failures |
| `smart-charging`  | profile stacking, purposes, recurring and composite schedules         |
| `ev`              | a CC/CV charging curve and battery model                              |

`Fleet` starts many chargers at a given ramp rate and aggregates their statistics; the
`ocpp-kit sim` command is a thin wrapper around it.

## Conformance checker

The checker reuses nothing from the client on purpose: a probe must be able to send frames a
correct client never would. See [conformance.md](conformance.md).

## Adding a protocol version

1. Add `src/messages/v201/` with the schemas and two action maps.
2. `CentralSystem` and `ChargePoint` currently hard-wire the v16 action maps and
   `OCPP16_SUBPROTOCOL`. That is where a version switch goes: negotiate the subprotocol, then
   create the connection's `RpcPeer` with the matching pair of maps. `RpcPeer`, `parseFrame`
   and validation need no change.
3. Add `src/conformance/v201/` with a `ConformanceSuite` (checks plus a responder); the runner,
   probe and reports are shared.
