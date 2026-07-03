import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCheckList, runConform } from '../../src/cli/conform.js';
import { OCPP16_CHECKS, type ConformanceReport } from '../../src/index.js';
import { FixtureCsms, type FixtureOptions } from '../conformance/fixture-csms.js';

const cleanups: (() => Promise<unknown>)[] = [];
let stdout: string[];
let stderr: string[];
let logged: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  logged = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const csms = new FixtureCsms(options);
  cleanups.push(() => csms.close());
  return csms.listen();
}

const FAST = ['--timeout', '1s', '--observe', '300ms', '--samples', '3'];

describe('ocpp-kit conform', () => {
  it('prints help and the list of checks', async () => {
    expect(await runConform(['--help'])).toBe(0);
    expect(logged.join('\n')).toContain('Usage: ocpp-kit conform --url <ws-url> --identity <id>');
    expect(await runConform(['--list'])).toBe(0);
    const listing = formatCheckList();
    expect(logged.at(-1)).toBe(listing);
    for (const check of OCPP16_CHECKS) {
      expect(listing).toContain(check.id);
      expect(listing).toContain(check.spec);
    }
  });

  it('streams a text report and exits with 0 when every MUST check passes', async () => {
    const url = await fixture();
    const status = await runConform([
      '--url',
      url,
      '--identity',
      'CLI-1',
      ...FAST,
      '--only',
      'boot',
    ]);
    expect(status).toBe(0);
    const text = stdout.join('');
    expect(text).toContain(`Target: ${url} as CLI-1`);
    expect(text).toContain('PASS   MUST    boot.response: status Accepted, interval 300 s');
    expect(text).toContain('3 checks in');
    expect(text).toContain('Result: PASS (no MUST check failed)');
    expect(stderr).toEqual([]);
  });

  it('exits with 1 when a MUST check fails, and writes JSON to stdout', async () => {
    const url = await fixture({ breakages: ['boot-invalid'] });
    const status = await runConform([
      '--url',
      url,
      '--identity',
      'CLI-2',
      ...FAST,
      '--only',
      'boot.response',
      '--format',
      'json',
    ]);
    expect(status).toBe(1);
    const report = JSON.parse(stdout.join('')) as ConformanceReport;
    expect(report.summary).toMatchObject({ total: 1, failed: 1, mustFailed: 1 });
    expect(stderr.join('')).toContain('FAIL boot.response');
  });

  it('writes a JUnit report to a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocpp-kit-conform-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });
    const url = await fixture({ password: 'pw-for-conform' });
    const output = join(dir, 'report.xml');
    const status = await runConform([
      '--url',
      url,
      '--identity',
      'CLI-3',
      '--password',
      'pw-for-conform',
      '--id-tag',
      'CLI-TAG',
      ...FAST,
      '--latency-budget',
      '2s',
      '--only',
      'ws.basic-auth,authorize.response,latency',
      '--skip',
      'latency',
      '--format',
      'junit',
      '--output',
      output,
    ]);
    expect(status).toBe(0);
    const xml = readFileSync(output, 'utf8');
    expect(xml).toContain('<testcase name="ws.basic-auth"');
    expect(xml).toContain('CLI-TAG: Accepted');
    expect(xml).not.toContain('name="latency"');
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('Result: PASS');
  });

  it('rejects invalid usage', async () => {
    await expect(runConform([])).rejects.toThrow('--url is required');
    await expect(runConform(['--url', 'ws://x'])).rejects.toThrow('--identity is required');
    await expect(runConform(['--url', 'http://x', '--identity', 'A'])).rejects.toThrow(
      /must use ws:\/\/ or wss:\/\//,
    );
    const base = ['--url', 'ws://127.0.0.1:1', '--identity', 'A'];
    await expect(runConform([...base, '--format', 'xml'])).rejects.toThrow(/--format must be/);
    await expect(runConform([...base, '--only', 'nope'])).rejects.toThrow(
      'No check matches nope (see --list)',
    );
    await expect(runConform([...base, '--id-tag', 'X'.repeat(21)])).rejects.toThrow(/--id-tag/);
    await expect(runConform([...base, '--timeout', 'soon'])).rejects.toThrow(/Invalid duration/);
    await expect(runConform([...base, '--timeout', '0s'])).rejects.toThrow(
      /--timeout must be positive/,
    );
    await expect(runConform([...base, '--samples', '0'])).rejects.toThrow(/--samples/);
    await expect(runConform([...base, '--cert', 'c.pem'])).rejects.toThrow(/--cert needs --key/);
    await expect(runConform([...base, '--bogus'])).rejects.toThrow(/Unknown option/);
  });
});
