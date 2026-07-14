import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTION_PROFILES, OCPP16_CHECKS } from '../src/index.js';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('documentation', () => {
  it('lists every conformance check with its level in docs/conformance.md', () => {
    const doc = read('docs/conformance.md');
    for (const check of OCPP16_CHECKS) {
      expect(doc, check.id).toMatch(
        new RegExp(`\\| \`${check.id.replace(/\./g, '\\.')}\` +\\| ${check.level} `),
      );
    }
  });

  it('lists all 28 messages in the README coverage table', () => {
    const readme = read('README.md');
    const actions = Object.keys(ACTION_PROFILES);
    expect(actions).toHaveLength(28);
    for (const action of actions) expect(readme, action).toMatch(new RegExp(`\\| ${action} +\\|`));
  });
});
