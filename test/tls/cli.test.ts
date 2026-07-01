import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCsms } from '../../src/cli/csms.js';
import { runSim } from '../../src/cli/sim.js';
import type { FleetStats } from '../../src/index.js';
import { until } from '../helpers.js';
import { createTestPki, opensslAvailable, type TestPki } from './pki.js';

const describeTls = opensslAvailable ? describe : describe.skip;

let pki: TestPki;
let dir: string;
const file = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

beforeAll(() => {
  if (!opensslAvailable) return;
  pki = createTestPki();
  dir = mkdtempSync(join(tmpdir(), 'ocpp-kit-cli-tls-'));
});
afterAll(() => {
  if (opensslAvailable) pki.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describeTls('CLI with Security Profile 3', () => {
  it('runs the demo CSMS on wss:// with client certificates and a fleet against it', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const controller = new AbortController();
    try {
      const csms = runCsms(
        [
          '--port',
          '0',
          '--host',
          '127.0.0.1',
          '--no-table',
          '--tls-cert',
          file('server.crt', pki.server.cert),
          '--tls-key',
          file('server.key', pki.server.key),
          '--tls-ca',
          file('ca.crt', pki.ca.cert),
        ],
        { signal: controller.signal },
      );
      await until(() => lines.some((line) => line.includes('listening on wss://')));
      const port = /:(\d+)\/<identity>/.exec(lines.find((l) => l.includes('listening')) ?? '')?.[1];
      expect(lines.find((l) => l.includes('listening'))).toContain('client certificates');
      const client = pki.client('TLS-001');
      await runSim([
        '--url',
        `wss://127.0.0.1:${port}`,
        '-n',
        '1',
        '--prefix',
        'TLS-',
        '--no-autopilot',
        '--ca',
        file('ca-for-sim.crt', pki.ca.cert),
        '--cert',
        file('client.crt', client.cert),
        '--key',
        file('client.key', client.key),
        '--duration',
        '700ms',
        '--json',
      ]);
      const stats = JSON.parse(stdout.join('')) as FleetStats;
      expect(stats).toMatchObject({ chargers: 1, registered: 1 });
      controller.abort();
      await csms;
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('validates the TLS flags', async () => {
    await expect(runCsms(['--tls-cert', 'x.pem'])).rejects.toThrow(/go together/);
    await expect(runCsms(['--client-certs', 'optional'])).rejects.toThrow(/need --tls-ca/);
    await expect(
      runCsms(['--tls-cert', join(dir, 'missing.pem'), '--tls-key', join(dir, 'missing.key')]),
    ).rejects.toThrow(/cannot read/);
    await expect(runSim(['--cert', 'a.pem'])).rejects.toThrow(/--cert needs --key/);
  });
});
