# OCPP 1.6-J field notes

Practical notes for people building or testing OCPP 1.6-J Central Systems and charge points.
Each note says what the specification requires (with the clause), where it leaves room, and
what ocpp-kit does. Where OCPP says nothing, the note says so instead of inventing a rule.
Chapter 3 of OCPP 1.6 is cited by section title; chapters 4 and 5 (the operations) by number.

## transactionId

- The Central System assigns it in StartTransaction.conf (OCPP 1.6 §4.8), and it is required
  there even when `idTagInfo.status` is not `Accepted`: the charge point still needs an id to
  stop the transaction it may already have started.
- The charge point must use that id in MeterValues and StopTransaction. A transaction started
  while offline has no id until its StartTransaction is delivered, so its MeterValues and
  StopTransaction cannot be sent before that. ocpp-kit's client queues them with a transaction
  reference and fills in the id when StartTransaction.conf arrives
  (`ChargePoint.startTransaction()`).
- The schema only says `integer`. Keeping ids within the signed 32-bit range is the safe choice,
  because many implementations store them that way.
- Transaction messages are delivered at least once (see "Replay ordering"), so a Central System
  should answer a repeated identical StartTransaction with the same id instead of opening a
  second transaction. The conformance check `transaction.start-replay` tests this, and the demo
  CSMS does it.

## CiString and id tag case

- `idTag` is an `IdToken`, a `CiString20Type`: a case-insensitive string of at most 20
  characters (OCPP 1.6, `CiString20Type` in the types chapter). `04A2B3C4` and `04a2b3c4` are the same identifier, so
  compare and index id tags case-insensitively (ocpp-kit: `ciEquals`, `ciKey`). The same applies
  to configuration keys and other CiString fields such as vendor ids.
- The length limit counts characters, and a longer value is a schema violation, not something
  to truncate. How a reader turns an RFID UID into a string (byte order, hex case) is not
  specified by OCPP; decide it once per fleet.

## StatusNotification bursts

- A charge point reports every status change of every connector, plus connector 0 for the
  charge point as a whole (OCPP 1.6 §4.9). After a boot it typically reports all connectors at
  once, so a site of chargers rebooting together produces a burst of `connectors + 1` messages
  per charger.
- The optional configuration key `MinimumStatusDuration` lets a charge point wait until a
  status has been stable for that long before reporting it, which suppresses short-lived
  flapping.
- §4.9 lists which transitions are meaningful; a Central System should still accept any valid
  StatusNotification, because a transition it considers odd (e.g. after a lost message) is
  still the charge point's current state.

## Heartbeat vs WebSocket ping

- OCPP-J 1.6 §5.3: WebSocket ping/pong can replace most Heartbeats for keeping the connection
  alive, but not the time synchronisation that Heartbeat.conf provides, so a charge point
  SHOULD still send at least one Heartbeat every 24 hours.
- `HeartbeatInterval` is an interval of inactivity: a charge point may skip a Heartbeat when
  other messages were exchanged in the meantime. Do not treat a missing Heartbeat as "offline"
  while other traffic flows; use the connection state or pings for liveness.
- The BootNotification.conf `interval` sets the heartbeat interval when the status is
  `Accepted`; with `Pending` or `Rejected` it is the minimum time before the next
  BootNotification (§4.2). The conformance check `boot.interval` flags values that are 0 or
  longer than 24 hours.
- ocpp-kit: `CentralSystemOptions.pingIntervalMs` (server pings, default 30 s, terminates a
  connection that did not answer the previous ping) and `ChargePointOptions.pingIntervalMs`
  (client pings, off by default).

## Sampled vs clock-aligned meter values

- Sampled data (`MeterValueSampleInterval`, `MeterValuesSampledData`) belongs to a
  transaction: samples every N seconds while charging, context `Sample.Periodic`. A value of 0
  disables them.
- Clock-aligned data (`ClockAlignedDataInterval`, `MeterValuesAlignedData`) is taken at evenly
  spaced points of the day starting at midnight, whether or not a transaction runs, context
  `Sample.Clock`; typically on connector 0 for the main meter. The specification does not say
  which time zone "midnight" is in; ocpp-kit's simulator aligns to midnight UTC.
- `StopTxnSampledData` and `StopTxnAlignedData` select what goes into
  `StopTransaction.transactionData`, which is how a Central System can get
  `Transaction.Begin` / `Transaction.End` readings in the same message as the stop.
- MeterValues without `transactionId` are valid (§4.7); a Central System must accept them.

## Measurand, phase, unit, context

- Defaults matter because many chargers omit fields: `measurand` defaults to
  `Energy.Active.Import.Register`, `unit` to `Wh`, `context` to `Sample.Periodic`, `location` to
  `Outlet`, `format` to `Raw`. A sample with only `value` is an energy register reading in Wh.
- `value` is a string, even for numbers. Parse it as a decimal; do not assume an integer.
- `Energy.*.Register` values are cumulative meter readings; `Energy.*.Interval` values are the
  energy of one interval. Mixing them up is a classic cause of absurd session totals.
- Units vary: the same measurand may come in `Wh` or `kWh`, `W` or `kW`. Normalise on receipt.
- `phase` qualifies per-phase values (`L1`, `L1-N`, `L1-L2`, ...). Measurand lists in the
  configuration may carry a phase (`Voltage.L1-N`), which ocpp-kit's simulator supports.
- The official JSON schema spells `Celcius`, the specification text `Celsius`; ocpp-kit accepts
  both. Some copies of the schema also allow `Hertz` for `Frequency`.

## Replay ordering

- StartTransaction, MeterValues and StopTransaction must reach the Central System reliably and
  in chronological order, including across connection loss (OCPP 1.6, "Transaction-related
  messages"). A charge point keeps them while offline and sends them in order afterwards.
- Consequences for a Central System: expect bursts after a reconnect; use the timestamps in
  the payloads, not the arrival time; expect duplicates of a message whose answer was lost.
- A CALLERROR in answer to a transaction message makes the charge point retry it
  (`TransactionMessageAttempts`, `TransactionMessageRetryInterval`; "Error responses to
  transaction-related messages"), and after the last attempt it may drop the message. Answer
  what you can (e.g. a StopTransaction for an unknown id) rather than erroring.
- OCPP 1.6 §4.2: nothing, cached messages included, may be sent before the BootNotification
  was accepted. ocpp-kit's client holds its queue until then.

## Reconnect storms and jitter

- OCPP 1.6 defines no reconnect back-off configuration (OCPP 2.0.1 added some). When a Central
  System restarts, thousands of chargers reconnect at once, and plain exponential back-off
  keeps them synchronised.
- Full jitter (`random(0, min(max, base * 2^attempt))`) spreads the reconnects out; reset the
  attempt counter only after a connection stayed up for a while, or a server that accepts and
  drops connections gets hammered at the minimum delay. ocpp-kit's client does both.
- On the server side, BootNotification `Pending` with an `interval` is the protocol's own
  throttle: it tells a charger when to try again.

## Offline authorization pitfalls

- The relevant keys: `LocalAuthorizeOffline` (start offline for idTags that are locally
  known and valid), `LocalPreAuthorize` (online, start for locally valid idTags without waiting
  for Authorize.conf), `AllowOfflineTxForUnknownId` (start offline for unknown idTags),
  `AuthorizationCacheEnabled`, `LocalAuthListEnabled`.
- Local knowledge has expiry: an entry whose `expiryDate` has passed must be treated as expired
  ("Unknown Offline Authorization"). A locally known `Blocked`, `Expired` or `Invalid` idTag
  must not start a transaction offline even when unknown idTags may.
- A transaction started offline can turn out to be unauthorized when its StartTransaction is
  delivered. With `StopTransactionOnInvalidId` true the charge point stops it (reason
  `DeAuthorized`); otherwise it only stops energy delivery, optionally after
  `MaxEnergyOnInvalidId` Wh.
- `AllowOfflineTxForUnknownId` is off by default in ocpp-kit's simulator: turning it on means
  anyone can charge during an outage.
- SendLocalList: `VersionMismatch` only applies to differential updates; a full update replaces
  the list. A list version of 0 means an empty list, -1 that the list is not supported. Split
  large lists according to `SendLocalListMaxLength`.

## Security profile pitfalls

(From the OCPP 1.6 security whitepaper and the TLS basics it builds on.)

- Profile 1 sends the Basic auth password over plain `ws://`: it is only base64-encoded, so it
  is readable on the network. Use it only on networks you trust, or move to Profile 2.
- The Basic auth user name is the charge point identity. A Central System should check that the
  user name equals the identity in the URL, not just that the password is right; ocpp-kit's
  server hands the password to your `authenticate` hook only when the user name is the
  identity.
- Profiles 2 and 3 require TLS 1.2 or newer; ocpp-kit's server and client default to a minimum
  of TLS 1.2.
- Profile 3 identifies the charge point by its client certificate. Decide how the certificate
  names the identity (subject CN, a subjectAltName, or something else) and check it on every
  connection; a trusted certificate issued to charger A must not let a client connect as
  charger B. ocpp-kit checks CN or SAN by default and accepts a custom rule.
- Certificates have validity periods, and checking them needs a correct clock, which a charger
  may only get from the Central System over the very connection that TLS protects. Keep the
  charge point's clock from drifting (Heartbeats) and use validity periods with some slack.
- The server certificate must name the host the charge points connect to (DNS name or IP
  address in subjectAltName), or clients that verify the host name refuse it.

## Time formats

- Every `dateTime` is an RFC 3339 date-time with a time zone offset, e.g.
  `2026-09-25T12:00:00Z` or `2026-09-25T14:00:00.123+02:00` (the official JSON schemas use
  `format: date-time`). A value without an offset is ambiguous and ocpp-kit rejects it.
- Send UTC (`Z`). Accept any offset and fractional seconds of any length.
- A charge point sets its clock from BootNotification.conf and Heartbeat.conf `currentTime`
  (§4.2, §4.6). Timestamps it produced before that may be wrong; a Central System should be
  prepared for readings dated far in the past.

## Message size

- OCPP 1.6 sets no maximum message size. The largest messages in practice are GetConfiguration
  answers for all keys, full SendLocalList requests, composite schedules and MeterValues with
  many samples or queued readings.
- Limits exist anyway: WebSocket libraries cap frame sizes (ocpp-kit's server defaults to
  1 MiB, `maxPayloadBytes`) and charger firmware often has small receive buffers. Use the
  paging the protocol offers: `GetConfigurationMaxKeys` limits the keys per GetConfiguration,
  `SendLocalListMaxLength` the entries per SendLocalList.
- Message ids are at most 36 characters (OCPP-J 1.6), enough for a UUID.
