import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  formatReport,
  formatTextHeader,
  formatTextResult,
  formatTextSummary,
  type ReportFormat,
} from '../conformance/report.js';
import { conforms, runConformance, selectChecks } from '../conformance/runner.js';
import type { CheckResult, ConformanceOptions } from '../conformance/types.js';
import { ocpp16Conformance } from '../conformance/v16/index.js';
import { VERSION } from '../version.js';
import { clientTlsFromFlags, parseDuration, parseInteger, parseUrl, UsageError } from './args.js';

export const CONFORM_USAGE = `Usage: ocpp-kit conform --url <ws-url> --identity <id> [options]

Check a Central System against OCPP 1.6-J: connect to it as a charge point, run
every check and report each one with its specification reference and level.

Options:
      --url <ws-url>          Central System endpoint without the identity (required)
      --identity <id>         Charge point identity to connect as (required)
      --password <secret>     HTTP Basic auth password (Security Profiles 1 and 2)
      --ca <file>             Trust this CA for wss://
      --cert <file>           Client certificate for Security Profile 3 (with --key)
      --key <file>            Private key of --cert
      --id-tag <tag>          Id tag for Authorize and the test transactions (default OCPPKIT-PROBE)
      --format <format>       text (default), json or junit
      --output <file>         Write the report to this file instead of stdout
      --timeout <dur>         Wait this long for each answer (default 10s)
      --observe <dur>         Watch this long for CALLs and duplicate-connection handling (default 5s)
      --latency-budget <dur>  Acceptable 95th percentile Heartbeat round trip (default 1s)
      --samples <n>           Heartbeats for the latency check (default 20)
      --only <ids>            Comma-separated check ids or groups to run, e.g. rpc,boot.clock
      --skip <ids>            Comma-separated check ids or groups to leave out
      --list                  List the checks and exit
  -h, --help                  Show this help

Exit status: 0 when every MUST check passed or was skipped, 1 when a MUST check
failed or could not be carried out, 2 on invalid usage.

The checks send test traffic: a BootNotification, StatusNotifications for
connectors 0 to 2, an Authorize, a few short transactions (StartTransaction,
MeterValues, StopTransaction) with the id tag above, and deliberately invalid
frames. Run them against a test system or with an identity reserved for testing.`;

const FORMATS: readonly ReportFormat[] = ['text', 'json', 'junit'];

function list(values: string | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** The check table printed by `--list`. */
export function formatCheckList(): string {
  const width = Math.max(...ocpp16Conformance.checks.map((check) => check.id.length));
  return ocpp16Conformance.checks
    .map(
      (check) =>
        `${check.id.padEnd(width)}  ${check.level.padEnd(6)}  ${check.title}\n${' '.repeat(width + 10)}${check.spec}`,
    )
    .join('\n');
}

/**
 * `ocpp-kit conform` entry point.
 *
 * @returns the exit status: 0 when the Central System passed every MUST check that ran, 1 when
 *   one failed or could not be carried out.
 */
export async function runConform(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      url: { type: 'string' },
      identity: { type: 'string' },
      password: { type: 'string' },
      ca: { type: 'string' },
      cert: { type: 'string' },
      key: { type: 'string' },
      'id-tag': { type: 'string' },
      format: { type: 'string', default: 'text' },
      output: { type: 'string' },
      timeout: { type: 'string' },
      observe: { type: 'string' },
      'latency-budget': { type: 'string' },
      samples: { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(CONFORM_USAGE);
    return 0;
  }
  if (values.list) {
    console.log(formatCheckList());
    return 0;
  }
  if (values.url === undefined) throw new UsageError('--url is required');
  if (values.identity === undefined || values.identity.length === 0) {
    throw new UsageError('--identity is required');
  }
  const format = values.format as ReportFormat;
  if (!FORMATS.includes(format)) {
    throw new UsageError(`--format must be text, json or junit, got "${values.format}"`);
  }
  const idTag = values['id-tag'];
  if (idTag !== undefined && (idTag.length === 0 || idTag.length > 20)) {
    throw new UsageError('--id-tag must be 1 to 20 characters long');
  }
  const only = list(values.only);
  const skip = list(values.skip);
  const { unknown } = selectChecks(ocpp16Conformance.checks, only, skip);
  if (unknown.length > 0) {
    throw new UsageError(`No check matches ${unknown.join(', ')} (see --list)`);
  }
  const tls = clientTlsFromFlags(values);

  const { output } = values;
  // Text to stdout is written as the checks complete; otherwise stdout (or the file) receives
  // only the finished document and progress goes to stderr.
  const live = format === 'text' && output === undefined;
  const progress = (line: string): void => {
    (live ? process.stdout : process.stderr).write(`${line}\n`);
  };
  const options: ConformanceOptions = {
    url: parseUrl(values.url),
    identity: values.identity,
    ...(values.password === undefined ? {} : { password: values.password }),
    ...(tls === undefined ? {} : { tls }),
    ...(idTag === undefined ? {} : { idTag }),
    ...(values.timeout === undefined ? {} : { timeoutMs: parseDuration(values.timeout) }),
    ...(values.observe === undefined ? {} : { observeMs: parseDuration(values.observe) }),
    ...(values['latency-budget'] === undefined
      ? {}
      : { latencyBudgetMs: parseDuration(values['latency-budget']) }),
    ...(values.samples === undefined
      ? {}
      : { latencySamples: parseInteger(values.samples, 'samples') }),
    ...(only === undefined ? {} : { only }),
    ...(skip === undefined ? {} : { skip }),
    onResult: (result: CheckResult) => {
      progress(live ? formatTextResult(result) : `${result.status.toUpperCase()} ${result.id}`);
    },
  };
  for (const [name, value] of [
    ['timeout', options.timeoutMs],
    ['observe', options.observeMs],
    ['latency-budget', options.latencyBudgetMs],
  ] as const) {
    if (value !== undefined && value <= 0) throw new UsageError(`--${name} must be positive`);
  }
  if (live) {
    progress(
      formatTextHeader({
        url: options.url,
        identity: options.identity,
        protocol: ocpp16Conformance.protocol,
        version: VERSION,
      }),
    );
  }
  const report = await runConformance(ocpp16Conformance, options);
  if (live) {
    progress(formatTextSummary(report));
  } else if (output === undefined) {
    process.stdout.write(formatReport(report, format));
  } else {
    writeFileSync(output, formatReport(report, format));
    progress(formatTextSummary(report).trim());
  }
  return conforms(report) ? 0 : 1;
}
