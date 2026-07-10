import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OCPP16_CHECKS } from '../src/index.js';

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
});
