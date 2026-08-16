import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTION_BLOCKS,
  ACTION_PROFILES,
  OCPP16_CHECKS,
  OCPP201_CHECKS,
  UNSUPPORTED_ACTIONS_201,
  type CheckInfo,
} from '../src/index.js';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The text of `doc` from the heading `start` up to the next heading of the same or a higher level. */
function section(doc: string, start: string): string {
  const from = doc.indexOf(`\n${start}\n`);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const level = (/^#+/.exec(start)?.[0] ?? '##').length;
  const rest = doc.slice(from + start.length + 2);
  const next = new RegExp(`^#{1,${level}} `, 'm').exec(rest);
  return doc.slice(from, next ? from + start.length + 2 + next.index : undefined);
}

/** `text` has a table row for every check, with its level, in the order of `checks`. */
function expectChecksListed(text: string, checks: readonly CheckInfo[]): void {
  for (const check of checks) {
    expect(text, check.id).toMatch(
      new RegExp(`\\| \`${check.id.replace(/\./g, '\\.')}\` +\\| ${check.level} `),
    );
  }
  const listed = [...text.matchAll(/^\| `([a-z0-9.-]+)` +\|/gm)].map((match) => match[1]);
  expect(listed).toEqual(checks.map((check) => check.id));
}

describe('documentation', () => {
  it('lists every OCPP 1.6 conformance check with its level in docs/conformance.md', () => {
    expectChecksListed(
      section(read('docs/conformance.md'), '## The OCPP 1.6 checks'),
      OCPP16_CHECKS,
    );
  });

  it('lists every OCPP 2.0.1 conformance check with its level in docs/conformance.md', () => {
    expectChecksListed(
      section(read('docs/conformance.md'), '## The OCPP 2.0.1 checks'),
      OCPP201_CHECKS,
    );
  });

  it('lists all 28 messages in the README coverage table', () => {
    const readme = read('README.md');
    const actions = Object.keys(ACTION_PROFILES);
    expect(actions).toHaveLength(28);
    for (const action of actions) expect(readme, action).toMatch(new RegExp(`\\| ${action} +\\|`));
  });

  it('lists exactly the implemented and the unsupported OCPP 2.0.1 messages in the README', () => {
    const coverage = section(read('README.md'), '### OCPP 2.0.1 coverage');
    const names = (text: string): string[] =>
      [...text.matchAll(/`([A-Z][A-Za-z0-9]+)`/g)].map((match) => match[1] ?? '');
    const rows = coverage
      .split('\n')
      .filter((line) => line.startsWith('| '))
      .join('\n');
    const unsupported = coverage.slice(
      coverage.indexOf('Not implemented'),
      coverage.indexOf('A CSMS built on'),
    );
    const implemented = Object.keys(ACTION_BLOCKS);
    expect(implemented).toHaveLength(40);
    expect(names(rows).sort()).toEqual([...implemented].sort());
    expect(names(unsupported).sort()).toEqual([...UNSUPPORTED_ACTIONS_201].sort());
  });
});
