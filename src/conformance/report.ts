import { conforms } from './runner.js';
import type { CheckResult, CheckStatus, ConformanceReport } from './types.js';

const STATUS_LABEL: Readonly<Record<CheckStatus, string>> = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
  error: 'ERROR',
};

const INDENT = ' '.repeat(15);

/** The first lines of a text report, printed before any check runs. */
export function formatTextHeader(target: {
  readonly url: string;
  readonly identity: string;
  readonly protocol: string;
  readonly version: string;
}): string {
  return `ocpp-kit ${target.version} conformance check: ${target.protocol} Central System\nTarget: ${target.url} as ${target.identity}\n`;
}

/** One check in a text report: status, level, id and outcome, then its title and reference. */
export function formatTextResult(result: CheckResult): string {
  const lines = [
    `${STATUS_LABEL[result.status].padEnd(6)} ${result.level.padEnd(7)} ${result.id}: ${result.message}`,
    `${INDENT}${result.title} [${result.spec}]`,
  ];
  if (result.status !== 'pass') {
    for (const detail of result.details) lines.push(`${INDENT}  ${detail}`);
  }
  return lines.join('\n');
}

/** The closing lines of a text report. */
export function formatTextSummary(report: ConformanceReport): string {
  const { summary } = report;
  const verdict = conforms(report)
    ? 'no MUST check failed'
    : [
        summary.mustFailed > 0 ? `${summary.mustFailed} MUST check(s) failed` : '',
        summary.mustErrors > 0
          ? `${summary.mustErrors} MUST check(s) could not be carried out`
          : '',
      ]
        .filter(Boolean)
        .join(', ');
  return [
    '',
    `${summary.total} checks in ${(report.durationMs / 1_000).toFixed(1)} s: ${summary.passed} passed, ${summary.failed} failed (${summary.mustFailed} MUST, ${summary.shouldFailed} SHOULD), ${summary.skipped} skipped, ${summary.errors} error(s)`,
    `Result: ${conforms(report) ? 'PASS' : 'FAIL'} (${verdict})`,
  ].join('\n');
}

/** Human-readable report. */
export function formatText(report: ConformanceReport): string {
  return `${[
    formatTextHeader({ ...report.target, protocol: report.protocol, version: report.tool.version }),
    ...report.results.map(formatTextResult),
    formatTextSummary(report),
  ].join('\n')}\n`;
}

/** The report as a JSON document. */
export function formatJson(report: ConformanceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Characters XML 1.0 does not allow, including unpaired surrogates. */
const INVALID_XML =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Escape text for XML: `&`, `<` and `>` become entities and characters XML 1.0 cannot carry
 * become U+FFFD. For attribute values quotes are escaped too, and line breaks and tabs are
 * written as character references so parsers do not normalise them to spaces.
 */
export function escapeXml(text: string, attribute = false): string {
  const escaped = text
    .replace(INVALID_XML, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return attribute
    ? escaped
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/\n/g, '&#10;')
        .replace(/\r/g, '&#13;')
        .replace(/\t/g, '&#9;')
    : escaped;
}

/** {@link escapeXml} for attribute values. */
const attr = (text: string): string => escapeXml(text, true);

const seconds = (ms: number): string => (ms / 1_000).toFixed(3);

function junitCase(result: CheckResult): string {
  const text = escapeXml(
    [`${result.title} [${result.spec}]`, result.message, ...result.details].join('\n'),
  );
  const open = `    <testcase name="${attr(result.id)}" classname="${attr(`conformance.${result.level}`)}" time="${seconds(result.durationMs)}">`;
  const body: string[] = [];
  switch (result.status) {
    case 'fail':
      body.push(
        `      <failure message="${attr(result.message)}" type="${result.level}">${text}</failure>`,
      );
      break;
    case 'error':
      body.push(
        `      <error message="${attr(result.message)}" type="${result.level}">${text}</error>`,
      );
      break;
    case 'skip':
      body.push(`      <skipped message="${attr(result.message)}"/>`);
      break;
    case 'pass':
      break;
  }
  body.push(`      <system-out>${text}</system-out>`);
  return [open, ...body, '    </testcase>'].join('\n');
}

/**
 * JUnit XML with one `<testsuite>` per level (`MUST`, `SHOULD`), for CI systems that display
 * test reports. A check that could not be carried out is an `<error>`.
 */
export function formatJunit(report: ConformanceReport): string {
  const suites = (['MUST', 'SHOULD'] as const).map((level) => {
    const results = report.results.filter((result) => result.level === level);
    const count = (status: CheckStatus): number =>
      results.filter((r) => r.status === status).length;
    const time = results.reduce((sum, result) => sum + result.durationMs, 0);
    return [
      `  <testsuite name="${attr(`${report.protocol} ${level}`)}" tests="${results.length}" failures="${count('fail')}" errors="${count('error')}" skipped="${count('skip')}" time="${seconds(time)}" timestamp="${attr(report.startedAt)}">`,
      '    <properties>',
      `      <property name="target" value="${attr(report.target.url)}"/>`,
      `      <property name="identity" value="${attr(report.target.identity)}"/>`,
      `      <property name="tool" value="${attr(`${report.tool.name} ${report.tool.version}`)}"/>`,
      '    </properties>',
      ...results.map(junitCase),
      '  </testsuite>',
    ].join('\n');
  });
  const { summary } = report;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${attr(`ocpp-kit conformance: ${report.protocol}`)}" tests="${summary.total}" failures="${summary.failed}" errors="${summary.errors}" skipped="${summary.skipped}" time="${seconds(report.durationMs)}">`,
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}

/** Report formats of {@link formatReport}. */
export type ReportFormat = 'text' | 'json' | 'junit';

/** Render a report in one of the supported formats. */
export function formatReport(report: ConformanceReport, format: ReportFormat): string {
  switch (format) {
    case 'text':
      return formatText(report);
    case 'json':
      return formatJson(report);
    case 'junit':
      return formatJunit(report);
  }
}
