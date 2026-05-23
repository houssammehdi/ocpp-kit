import { describe, expect, it } from 'vitest';
import { ciEquals, ciKey } from '../../src/index.js';

describe('CiString helpers', () => {
  it('compare case-insensitively', () => {
    expect(ciEquals('04a2b3c4', '04A2B3C4')).toBe(true);
    expect(ciEquals('HeartbeatInterval', 'heartbeatinterval')).toBe(true);
    expect(ciEquals('TAG-1', 'TAG-2')).toBe(false);
    expect(ciKey('AbC')).toBe(ciKey('aBc'));
  });
});
