import { OcppKitError } from '../rpc/errors.js';
import { VERSION } from '../version.js';
import { ProbeConnection, ProbeHandshakeError } from './probe.js';
import type {
  Check,
  CheckContext,
  CheckOutcome,
  CheckResult,
  ConformanceOptions,
  ConformanceReport,
  ConformanceSuite,
  ConformanceSummary,
  ConnectOverrides,
  ResolvedConformanceOptions,
} from './types.js';

const DEFAULTS = {
  idTag: 'OCPPKIT-PROBE',
  timeoutMs: 10_000,
  observeMs: 5_000,
  latencyBudgetMs: 1_000,
  latencySamples: 20,
} as const;

/** The options of a conformance run are invalid. */
export class ConformanceOptionsError extends OcppKitError {}

/** The connection URL of `identity`: the endpoint plus the percent-encoded identity. */
export function endpointUrl(url: string, identity: string): string {
  return `${url.replace(/\/+$/, '')}/${encodeURIComponent(identity)}`;
}

/** Whether `pattern` selects check `id`: the same id, or a group prefix such as `rpc` or `rpc.`. */
function selects(pattern: string, id: string): boolean {
  if (pattern === id) return true;
  const group = pattern.endsWith('.') ? pattern : `${pattern}.`;
  return id.startsWith(group);
}

/** The checks a run executes, and the `only`/`skip` entries that match no check. */
export function selectChecks(
  checks: readonly Check[],
  only: readonly string[] | undefined,
  skip: readonly string[] = [],
): { readonly selected: readonly Check[]; readonly unknown: readonly string[] } {
  const unknown = [...(only ?? []), ...skip].filter(
    (pattern) => !checks.some((check) => selects(pattern, check.id)),
  );
  const skipped = (check: Check): boolean => skip.some((pattern) => selects(pattern, check.id));
  const wanted = new Set<string>();
  const want = (check: Check): void => {
    if (wanted.has(check.id) || skipped(check)) return;
    wanted.add(check.id);
    for (const id of check.requires ?? []) {
      const required = checks.find((candidate) => candidate.id === id);
      if (required) want(required);
    }
  };
  for (const check of checks) {
    if (only === undefined || only.some((pattern) => selects(pattern, check.id))) want(check);
  }
  return { selected: checks.filter((check) => wanted.has(check.id)), unknown };
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConformanceOptionsError(`${name} must be a positive number, got ${value}`);
  }
  return value;
}

function resolveOptions(
  suite: ConformanceSuite,
  options: ConformanceOptions,
): ResolvedConformanceOptions {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new ConformanceOptionsError(`Invalid URL "${options.url}"`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ConformanceOptionsError(`The URL must use ws:// or wss://, got "${options.url}"`);
  }
  if (options.identity.length === 0) throw new ConformanceOptionsError('The identity is empty');
  const idTag = options.idTag ?? DEFAULTS.idTag;
  const maxIdTag = suite.idTagMaxLength ?? 20;
  if (idTag.length === 0 || idTag.length > maxIdTag) {
    throw new ConformanceOptionsError(
      `The id tag must be 1 to ${maxIdTag} characters long${maxIdTag === 20 ? ' (CiString20)' : ''}`,
    );
  }
  return {
    url: options.url,
    identity: options.identity,
    idTag,
    timeoutMs: positive(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs'),
    observeMs: positive(options.observeMs, DEFAULTS.observeMs, 'observeMs'),
    latencyBudgetMs: positive(options.latencyBudgetMs, DEFAULTS.latencyBudgetMs, 'latencyBudgetMs'),
    latencySamples: Math.round(
      positive(options.latencySamples, DEFAULTS.latencySamples, 'latencySamples'),
    ),
    ...(options.password === undefined ? {} : { password: options.password }),
    ...(options.tls === undefined ? {} : { tls: options.tls }),
  };
}

/** Counts of a list of results. */
export function summarize(results: readonly CheckResult[]): ConformanceSummary {
  const count = (predicate: (result: CheckResult) => boolean): number =>
    results.filter(predicate).length;
  return {
    total: results.length,
    passed: count((r) => r.status === 'pass'),
    failed: count((r) => r.status === 'fail'),
    skipped: count((r) => r.status === 'skip'),
    errors: count((r) => r.status === 'error'),
    mustFailed: count((r) => r.level === 'MUST' && r.status === 'fail'),
    mustErrors: count((r) => r.level === 'MUST' && r.status === 'error'),
    shouldFailed: count((r) => r.level === 'SHOULD' && r.status === 'fail'),
  };
}

/**
 * Whether the report shows conformance: no MUST check failed and none could not be carried out.
 * The `conform` CLI exits with status 1 otherwise.
 */
export function conforms(report: ConformanceReport): boolean {
  return report.summary.mustFailed === 0 && report.summary.mustErrors === 0;
}

function describeError(error: unknown): string {
  if (error instanceof ProbeHandshakeError) return `could not connect: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** One run: the shared session and every connection opened. */
class Run {
  readonly state = new Map<string, unknown>();
  readonly connections: ProbeConnection[] = [];
  #session: ProbeConnection | undefined;
  #opening: Promise<ProbeConnection> | undefined;
  #sessionFailure: Error | undefined;

  constructor(
    readonly suite: ConformanceSuite,
    readonly options: ResolvedConformanceOptions,
  ) {}

  async open(overrides: ConnectOverrides = {}): Promise<ProbeConnection> {
    const { identity } = this.options;
    const password =
      overrides.password === undefined ? this.options.password : (overrides.password ?? undefined);
    const tls = overrides.tls ?? this.options.tls;
    const connection = await ProbeConnection.open({
      url: endpointUrl(this.options.url, identity),
      protocols: overrides.protocols ?? [this.suite.subprotocol],
      headers:
        password === undefined
          ? {}
          : {
              Authorization: `Basic ${Buffer.from(`${identity}:${password}`).toString('base64')}`,
            },
      ...(tls === undefined ? {} : { tls }),
      timeoutMs: this.options.timeoutMs,
      respond: overrides.respond ?? this.suite.respond,
    });
    this.connections.push(connection);
    return connection;
  }

  /** The shared connection; once opening it failed, later calls fail the same way at once. */
  session(): Promise<ProbeConnection> {
    if (this.#session?.isOpen) return Promise.resolve(this.#session);
    if (this.#sessionFailure !== undefined) return Promise.reject(this.#sessionFailure);
    this.#opening ??= this.open().then(
      (connection) => {
        this.#session = connection;
        this.#opening = undefined;
        return connection;
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#sessionFailure = failure;
        this.#opening = undefined;
        throw failure;
      },
    );
    return this.#opening;
  }

  async endSession(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    await session?.close();
  }

  async execute(check: Check, done: ReadonlyMap<string, CheckResult>): Promise<CheckResult> {
    const started = performance.now();
    let outcome: CheckOutcome | { status: 'error'; message: string };
    const unmet = (check.requires ?? []).filter((id) => done.get(id)?.status !== 'pass');
    if (unmet.length > 0) {
      outcome = {
        status: 'skip',
        message: `needs ${unmet.map((id) => `${id} (${done.get(id)?.status ?? 'not run'})`).join(', ')}`,
      };
    } else {
      const opened: ProbeConnection[] = [];
      const context: CheckContext = {
        options: this.options,
        session: () => this.session(),
        endSession: () => this.endSession(),
        connect: async (overrides) => {
          const connection = await this.open(overrides);
          opened.push(connection);
          return connection;
        },
        connections: this.connections,
        state: this.state,
      };
      try {
        outcome = await check.run(context);
      } catch (error) {
        outcome = { status: 'error', message: describeError(error) };
      } finally {
        await Promise.all(opened.map((connection) => connection.close()));
      }
    }
    const { id, title, level, spec } = check;
    return {
      id,
      title,
      level,
      spec,
      status: outcome.status,
      message: outcome.message,
      details: 'details' in outcome ? (outcome.details ?? []) : [],
      durationMs: performance.now() - started,
    };
  }

  async dispose(): Promise<void> {
    await Promise.all(this.connections.map((connection) => connection.close()));
  }
}

/**
 * Check a Central System: connect to it as a charge point and run the suite's checks in order.
 * Never rejects because of the Central System's behaviour (that is what the report is for), only
 * for invalid options ({@link ConformanceOptionsError}).
 *
 * ```ts
 * const report = await runConformance(ocpp16Conformance, { url: 'ws://localhost:9220', identity: 'CP001' });
 * console.log(formatText(report));
 * ```
 */
export async function runConformance(
  suite: ConformanceSuite,
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const resolved = resolveOptions(suite, options);
  const { selected, unknown } = selectChecks(suite.checks, options.only, options.skip);
  if (unknown.length > 0) {
    throw new ConformanceOptionsError(
      `No check matches ${unknown.map((u) => `"${u}"`).join(', ')}`,
    );
  }
  const startedAt = new Date();
  const started = performance.now();
  const run = new Run(suite, resolved);
  const results: CheckResult[] = [];
  const done = new Map<string, CheckResult>();
  try {
    for (const check of selected) {
      const result = await run.execute(check, done);
      results.push(result);
      done.set(check.id, result);
      options.onResult?.(result);
    }
  } finally {
    await run.dispose();
  }
  return {
    tool: { name: 'ocpp-kit', version: VERSION },
    protocol: suite.protocol,
    target: { url: resolved.url, identity: resolved.identity },
    startedAt: startedAt.toISOString(),
    durationMs: performance.now() - started,
    summary: summarize(results),
    results,
  };
}
