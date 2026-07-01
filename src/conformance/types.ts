/**
 * Version-agnostic types of the conformance checker. The checks of a protocol version live in a
 * sub-module (`v16/` for OCPP 1.6-J) and depend only on these types and on the probe.
 */
import type { ChargePointTlsOptions } from '../client/connector.js';
import type { ProbeConnection, ProbeResponder } from './probe.js';

/**
 * `MUST`: the check verifies a requirement of the specification (SHALL/MUST, or a MUST of an
 * RFC it builds on); a failure makes the CLI exit with a non-zero status. `SHOULD`: the check
 * verifies a recommendation, or a robustness property that interoperability depends on.
 */
export type CheckLevel = 'MUST' | 'SHOULD';

/**
 * Outcome of one check. `skip`: not applicable, or a check it depends on did not pass. `error`:
 * the check could not be carried out (e.g. the Central System was unreachable or did not accept
 * the probe's BootNotification), so nothing is known about the requirement.
 */
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'error';

/** Static description of a check. */
export interface CheckInfo {
  /** Stable identifier, e.g. `rpc.unknown-action`. */
  readonly id: string;
  /** One-line description of what is verified. */
  readonly title: string;
  readonly level: CheckLevel;
  /** Where the requirement comes from, e.g. `OCPP-J 1.6 §4.1.3`. */
  readonly spec: string;
}

/** The result of running one check. */
export interface CheckResult extends CheckInfo {
  readonly status: CheckStatus;
  /** One-line outcome. */
  readonly message: string;
  /** Evidence: frames sent and received, measurements, ... */
  readonly details: readonly string[];
  readonly durationMs: number;
}

/** What a check returns. Throwing instead yields the status `error`. */
export interface CheckOutcome {
  readonly status: Exclude<CheckStatus, 'error'>;
  readonly message: string;
  readonly details?: readonly string[];
}

/** Settings of a conformance run. */
export interface ConformanceOptions {
  /** Central System endpoint without the identity, e.g. `ws://csms.example.com/ocpp`. */
  readonly url: string;
  /** Charge point identity to connect as. */
  readonly identity: string;
  /** Basic auth password, if the Central System requires one. */
  readonly password?: string;
  /** TLS settings for `wss://` endpoints. */
  readonly tls?: ChargePointTlsOptions;
  /** Id tag used for Authorize and the test transactions. Default: `OCPPKIT-PROBE`. */
  readonly idTag?: string;
  /** How long to wait for any single answer. Default: 10 000 ms. */
  readonly timeoutMs?: number;
  /**
   * How long to watch for Central System behaviour that may take a while to show: CALLs sent
   * while an earlier one is unanswered, the fate of a duplicate connection. Default: 5 000 ms.
   */
  readonly observeMs?: number;
  /** 95th percentile Heartbeat round-trip time that counts as acceptable. Default: 1 000 ms. */
  readonly latencyBudgetMs?: number;
  /** Heartbeats sent to measure latency. Default: 20. */
  readonly latencySamples?: number;
  /**
   * Run only the checks whose id equals or starts with one of these entries (`rpc.` selects every
   * RPC framework check), plus the checks they depend on. Default: every check.
   */
  readonly only?: readonly string[];
  /** Skip the checks whose id equals or starts with one of these entries. */
  readonly skip?: readonly string[];
  /** Called with every result as soon as the check completes. */
  readonly onResult?: (result: CheckResult) => void;
}

/** Summary counts of a report. */
export interface ConformanceSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errors: number;
  /** Failed MUST checks: a non-zero count means the Central System does not conform. */
  readonly mustFailed: number;
  /** MUST checks that could not be carried out: the run is inconclusive. */
  readonly mustErrors: number;
  readonly shouldFailed: number;
}

/** The report of a conformance run. */
export interface ConformanceReport {
  readonly tool: { readonly name: 'ocpp-kit'; readonly version: string };
  /** Protocol version the checks are written for, e.g. `OCPP 1.6-J`. */
  readonly protocol: string;
  readonly target: { readonly url: string; readonly identity: string };
  /** ISO 8601 start time. */
  readonly startedAt: string;
  readonly durationMs: number;
  readonly summary: ConformanceSummary;
  readonly results: readonly CheckResult[];
}

/** Settings of a run after defaults were applied. */
export type ResolvedConformanceOptions = Required<
  Pick<
    ConformanceOptions,
    'url' | 'identity' | 'idTag' | 'timeoutMs' | 'observeMs' | 'latencyBudgetMs' | 'latencySamples'
  >
> &
  Pick<ConformanceOptions, 'password' | 'tls'>;

/** Per-connection overrides of {@link CheckContext.connect}. */
export interface ConnectOverrides {
  /** Offered subprotocols. Default: the suite's subprotocol. */
  readonly protocols?: readonly string[];
  /** Basic auth password; `null` sends no credentials. Default: the configured password. */
  readonly password?: string | null;
  /** TLS settings. Default: the configured ones. */
  readonly tls?: ChargePointTlsOptions;
  /** Answers Central System CALLs. Default: the suite's responder. */
  readonly respond?: ProbeResponder;
}

/** Shared state and helpers handed to every check. */
export interface CheckContext {
  readonly options: ResolvedConformanceOptions;
  /**
   * The shared connection, opened on first use and again after it closed. Rejects with the
   * handshake error when it cannot be opened.
   */
  session(): Promise<ProbeConnection>;
  /** Close the shared connection, e.g. before a check that must be the only connection. */
  endSession(): Promise<void>;
  /** Open an additional connection; it is closed automatically when the check ends. */
  connect(overrides?: ConnectOverrides): Promise<ProbeConnection>;
  /** Every connection opened so far in this run, including closed ones. */
  readonly connections: readonly ProbeConnection[];
  /** Values checks hand to later checks, e.g. a transaction id. */
  readonly state: Map<string, unknown>;
}

/** A check: its description and the function that performs it. */
export interface Check extends CheckInfo {
  /**
   * Ids of earlier checks whose results this check builds on: when one did not pass, this check
   * is skipped. `only` selections include them automatically.
   */
  readonly requires?: readonly string[];
  run(context: CheckContext): Promise<CheckOutcome>;
}

/** The checks of one protocol version and how the probe behaves while running them. */
export interface ConformanceSuite {
  /** Protocol version, e.g. `OCPP 1.6-J`. */
  readonly protocol: string;
  /** WebSocket subprotocol the probe offers. */
  readonly subprotocol: string;
  /** Checks in execution order. */
  readonly checks: readonly Check[];
  /** Answers the Central System's CALLs on every probe connection. */
  readonly respond: ProbeResponder;
}
