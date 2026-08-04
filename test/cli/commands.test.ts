import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSMS_USAGE, runCsms } from '../../src/cli/csms.js';
import { DemoCsms } from '../../src/cli/demo-csms.js';
import { runSim, SIM_USAGE } from '../../src/cli/sim.js';
import { ChargePoint, type FleetStats } from '../../src/index.js';
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

  it('keeps stdout machine-readable with --json', async () => {
    // Regression: the banner and progress lines used to go to stdout as well.
    const csms = new DemoCsms();
    const { port } = await csms.listen(0, '127.0.0.1');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const capture =
      (sink: string[]) =>
      (chunk: string | Uint8Array): boolean => {
        sink.push(String(chunk));
        return true;
      };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture(stdout));
    vi.spyOn(process.stderr, 'write').mockImplementation(capture(stderr));
    try {
      await runSim([
        '--url',
        `ws://127.0.0.1:${port}`,
        '-n',
        '2',
        '--ramp',
        '100/s',
        '--no-autopilot',
        '--duration',
        '500ms',
        '--json',
      ]);
    } finally {
      vi.restoreAllMocks();
      await csms.close();
    }
    const stats = JSON.parse(stdout.join('')) as FleetStats;
    expect(stats).toMatchObject({ chargers: 2, started: 2 });
    expect(stderr.join('')).toContain('Simulating 2 charge point(s)');
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

    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
    const stats = JSON.parse(stdout.join('')) as FleetStats;
    expect(stats).toMatchObject({ chargers: 3, started: 3, registered: 3, callErrors: 0 });
    // Remote starts were accepted; the simulated drivers are now walking up to plug in.
    expect(lines.some((line) => /auto-start: \d session\(s\) requested/.test(line))).toBe(true);
    expect(stats.connectorStatuses.Preparing).toBeGreaterThanOrEqual(1);

    controller.abort();
    await csms;
    expect(lines.at(-1)).toBe('CSMS stopped.');
  });
});

describe('ocpp-kit csms observability', () => {
  it('serves Prometheus metrics and writes JSON log lines', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    const controller = new AbortController();
    const csms = runCsms(
      ['--port', '0', '--host', '127.0.0.1', '--metrics-port', '0', '--log-json'],
      { signal: controller.signal },
    );
    await until(() => stderr.some((line) => line.includes('metrics on')));
    const port = /:(\d+)\/<identity>/.exec(stderr.join(''))?.[1];
    const metricsUrl = /(http:\/\/\S+\/metrics)/.exec(stderr.join(''))?.[1];
    expect(port).toBeDefined();
    expect(metricsUrl).toBeDefined();

    const cp = new ChargePoint({
      identity: 'CLI-METRICS',
      url: `ws://127.0.0.1:${port}`,
      reconnect: false,
    });
    await cp.connect();
    await cp.call('BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' });
    const response = await fetch(metricsUrl!.replace('localhost', '127.0.0.1'));
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = await response.text();
    expect(text).toContain('ocpp_connected_charge_points 1');
    expect(text).toContain('ocpp_inbound_calls_total{action="BootNotification",result="ok"} 1');
    expect((await fetch(metricsUrl!.replace('/metrics', '/other'))).status).toBe(404);
    await cp.close();

    const entries = stdout
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; identity?: string });
    expect(entries.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(['connect', 'call']),
    );
    expect(entries.every((entry) => entry.identity === 'CLI-METRICS')).toBe(true);
    controller.abort();
    await csms;
    expect(stderr.join('')).toContain('CSMS stopped.');
    expect(stdout.join('')).not.toContain('CSMS stopped.');
  });
});

describe('ocpp-kit sim --ocpp', () => {
  async function simulate(
    version: string,
    count: number,
  ): Promise<{ stats: FleetStats; csms: DemoCsms; stderr: string }> {
    const csms = new DemoCsms();
    const { port } = await csms.listen(0, '127.0.0.1');
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await runSim([
        '--ocpp',
        version,
        '--url',
        `ws://127.0.0.1:${port}`,
        '-n',
        String(count),
        '--ramp',
        '100/s',
        '--no-autopilot',
        '--duration',
        '800ms',
        '--json',
      ]);
    } finally {
      vi.restoreAllMocks();
    }
    const stats = JSON.parse(stdout.join('')) as FleetStats;
    const result = { stats, csms, stderr: stderr.join('') };
    await csms.close();
    return result;
  }

  it('simulates OCPP 2.0.1 stations', async () => {
    const { stats, csms, stderr } = await simulate('2.0.1', 2);
    expect(stats).toMatchObject({ chargers: 2, registered: 2, callErrors: 0 });
    expect(stats.connectorStatuses.Available).toBe(4);
    expect([...csms.stations.values()].map((station) => station.version)).toEqual([
      '2.0.1',
      '2.0.1',
    ]);
    expect(stderr).toContain('Simulating 2 charge point(s) (OCPP 2.0.1)');
  });

  it('simulates a mixed fleet against one Central System', async () => {
    const { stats, csms } = await simulate('mixed', 4);
    expect(stats).toMatchObject({ chargers: 4, registered: 4, callErrors: 0 });
    expect([...csms.stations.values()].map((station) => station.version).sort()).toEqual([
      '1.6',
      '1.6',
      '2.0.1',
      '2.0.1',
    ]);
  });

  it('rejects unknown versions', async () => {
    await expect(runSim(['--ocpp', '2.1'])).rejects.toThrow(/--ocpp must be/);
    await expect(runCsms(['--ocpp', '1.5'])).rejects.toThrow(/--ocpp must be/);
  });
});
