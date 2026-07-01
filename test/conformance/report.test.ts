import { describe, expect, it } from 'vitest';
import {
  escapeXml,
  formatJson,
  formatJunit,
  formatReport,
  formatText,
  summarize,
  type CheckResult,
  type ConformanceReport,
} from '../../src/index.js';

function result(overrides: Partial<CheckResult>): CheckResult {
  return {
    id: 'rpc.example',
    title: 'Does the example thing',
    level: 'MUST',
    spec: 'OCPP-J 1.6 §4.2.3',
    status: 'pass',
    message: 'fine',
    details: [],
    durationMs: 12.5,
    ...overrides,
  };
}

function report(results: CheckResult[]): ConformanceReport {
  return {
    tool: { name: 'ocpp-kit', version: '9.9.9' },
    protocol: 'OCPP 1.6-J',
    target: { url: 'ws://csms.example.com/ocpp', identity: 'CP<1>' },
    startedAt: '2026-09-25T10:00:00.000Z',
    durationMs: 1234,
    summary: summarize(results),
    results,
  };
}

const MIXED = report([
  result({ id: 'ws.ping', status: 'pass', message: 'pong after 1 ms', details: ['hidden'] }),
  result({
    id: 'boot.clock',
    level: 'SHOULD',
    status: 'fail',
    message: 'currentTime is 3600 s ahead',
    details: ['currentTime 2026-09-25T11:00:00Z'],
  }),
  result({
    id: 'rpc.unknown-action',
    status: 'fail',
    message: 'answered with "Oops" <&> \u0001',
    details: ['< [4,"x","Oops","",{}]'],
  }),
  result({ id: 'ws.basic-auth', status: 'skip', message: 'no password configured' }),
  result({ id: 'heartbeat.response', status: 'error', message: 'could not connect: refused' }),
]);

describe('conformance reports', () => {
  it('summarises results by status and level', () => {
    expect(MIXED.summary).toEqual({
      total: 5,
      passed: 1,
      failed: 2,
      skipped: 1,
      errors: 1,
      mustFailed: 1,
      mustErrors: 1,
      shouldFailed: 1,
    });
  });

  it('renders text with evidence for everything that did not pass', () => {
    const text = formatText(MIXED);
    expect(text).toContain('ocpp-kit 9.9.9 conformance check: OCPP 1.6-J Central System');
    expect(text).toContain('Target: ws://csms.example.com/ocpp as CP<1>');
    expect(text).toContain('PASS   MUST    ws.ping: pong after 1 ms');
    expect(text).toContain('FAIL   SHOULD  boot.clock: currentTime is 3600 s ahead');
    expect(text).toContain('               Does the example thing [OCPP-J 1.6 §4.2.3]');
    expect(text).toContain('                 currentTime 2026-09-25T11:00:00Z');
    expect(text).not.toContain('hidden');
    expect(text).toContain('ERROR  MUST    heartbeat.response: could not connect: refused');
    expect(text).toContain(
      '5 checks in 1.2 s: 1 passed, 2 failed (1 MUST, 1 SHOULD), 1 skipped, 1 error(s)',
    );
    expect(text).toContain(
      'Result: FAIL (1 MUST check(s) failed, 1 MUST check(s) could not be carried out)',
    );
    expect(formatText(report([result({})]))).toContain('Result: PASS (no MUST check failed)');
  });

  it('renders JSON that parses back to the report', () => {
    expect(JSON.parse(formatJson(MIXED))).toEqual(MIXED);
    expect(formatReport(MIXED, 'json')).toBe(formatJson(MIXED));
    expect(formatReport(MIXED, 'text')).toBe(formatText(MIXED));
  });

  it('renders JUnit XML with one suite per level', () => {
    const xml = formatJunit(MIXED);
    expect(formatReport(MIXED, 'junit')).toBe(xml);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
    expect(xml).toContain('tests="5" failures="2" errors="1" skipped="1" time="1.234"');
    expect(xml).toContain(
      '<testsuite name="OCPP 1.6-J MUST" tests="4" failures="1" errors="1" skipped="1"',
    );
    expect(xml).toContain('<testsuite name="OCPP 1.6-J SHOULD" tests="1" failures="1" errors="0"');
    expect(xml).toContain('<property name="identity" value="CP&lt;1&gt;"/>');
    expect(xml).toContain(
      '<testcase name="rpc.unknown-action" classname="conformance.MUST" time="0.013">',
    );
    expect(xml).toContain(
      '<failure message="answered with &quot;Oops&quot; &lt;&amp;&gt; \uFFFD" type="MUST">',
    );
    expect(xml).toContain('&lt; [4,"x","Oops","",{}]</failure>');
    expect(xml).toContain('<skipped message="no password configured"/>');
    expect(xml).toContain('<error message="could not connect: refused" type="MUST">');
    // Every element that is opened is closed again.
    for (const element of ['testsuites', 'testsuite', 'testcase', 'properties']) {
      const opened = xml.match(new RegExp(`<${element}[ >]`, 'g'))?.length ?? 0;
      expect(xml.match(new RegExp(`</${element}>`, 'g'))?.length ?? 0).toBe(opened);
    }
  });

  it('escapes text and attributes for XML', () => {
    expect(escapeXml(`a<b>&"c"'\n`)).toBe(`a&lt;b&gt;&amp;"c"'\n`);
    expect(escapeXml(`"x"\n\t'`, true)).toBe('&quot;x&quot;&#10;&#9;&apos;');
    expect(escapeXml('\u0000\u0008\u000B\u001F\uFFFE ok')).toBe(
      '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD ok',
    );
    // Lone surrogates cannot be written; a proper pair (an emoji) can.
    expect(escapeXml('\uD83D x \uDE00 \uD83D\uDE00')).toBe('\uFFFD x \uFFFD \uD83D\uDE00');
  });
});
