import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSMS_USAGE, runCsms } from '../../src/cli/csms.js';
import { runSim, SIM_USAGE } from '../../src/cli/sim.js';
import type { FleetStats } from '../../src/index.js';
import { until } from '../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function captureConsole(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return lines;
}

describe('CLI commands', () => {
  it('prints help for both commands', async () => {
    const lines = captureConsole();
    await runSim(['--help']);
    await runCsms(['-h']);
    expect(lines).toEqual([SIM_USAGE, CSMS_USAGE]);
  });

  it('rejects invalid options', async () => {
    await expect(runSim(['--count', 'many'])).rejects.toThrow(/integer/);
    await expect(runSim(['--url', 'http://x'])).rejects.toThrow(/ws:\/\//);
    await expect(runSim(['--max-power', '-3'])).rejects.toThrow(/max-power/);
    await expect(runCsms(['--heartbeat', 'often'])).rejects.toThrow(/duration/);
    await expect(runCsms(['--bogus'])).rejects.toThrow(/Unknown option/);
  });

  it('runs the demo CSMS and a simulated fleet against it', async () => {
    const lines = captureConsole();
    const controller = new AbortController();
    const csms = runCsms(['--port', '0', '--host', '127.0.0.1', '--auto-start', '300ms'], {
      signal: controller.signal,
    });
    await until(() => lines.some((line) => line.includes('listening on')));
    const port = /:(\d+)\/<identity>/.exec(
      lines.find((line) => line.includes('listening on')) ?? '',
    )?.[1];
    expect(port).toBeDefined();

    await runSim([
      '--url',
      `ws://127.0.0.1:${port}`,
      '-n',
      '3',
      '--ramp',
      '100/s',
      '--connectors',
      '1',
      '--meter-interval',
      '1s',
      '--idle',
      '5m-10m',
      '--duration',
      '1500ms',
      '--json',
    ]);
    const json = lines.find((line) => line.startsWith('{'));
    const stats = JSON.parse(json ?? '{}') as FleetStats;
    expect(stats).toMatchObject({ chargers: 3, started: 3, registered: 3, callErrors: 0 });
    // Remote starts were accepted; the simulated drivers are now walking up to plug in.
    expect(lines.some((line) => /auto-start: \d session\(s\) requested/.test(line))).toBe(true);
    expect(stats.connectorStatuses.Preparing).toBeGreaterThanOrEqual(1);

    controller.abort();
    await csms;
    expect(lines.at(-1)).toBe('CSMS stopped.');
  });
});
