import { parseArgs } from 'node:util';
import { Fleet, type FleetStats } from '../simulator/fleet.js';
import { parseDuration, parseInteger, parseRangeSeconds, parseRate, parseUrl } from './args.js';
import { formatClock, formatNumber } from './format.js';

export const SIM_USAGE = `Usage: ocpp-kit sim [options]

Spawn simulated OCPP 1.6-J charge points against a Central System.

Options:
      --url <ws-url>          Central System endpoint without identity (default ws://localhost:9220)
  -n, --count <n>             Number of charge points (default 1)
      --ramp <rate>           Start rate, e.g. 5/s or 120/m (default 10/s)
      --prefix <text>         Identity prefix (default SIM-)
      --connectors <n>        Connectors per charge point (default 2)
      --max-power <kW>        Hardware limit per connector (default 22)
      --seed <n>              Seed for deterministic behaviour (default 1)
      --password <secret>     HTTP Basic auth password (Security Profile 1)
      --meter-interval <dur>  MeterValueSampleInterval (default 60s)
      --idle <range>          Idle time between sessions (default 30s-5m)
      --max-session <dur>     Maximum session length (default 4h)
      --no-autopilot          Do not start sessions automatically
      --duration <dur>        Stop after this long (default: run until Ctrl-C)
      --json                  Print the final statistics as JSON
  -h, --help                  Show this help`;

/** One-line status summary (exported for tests). */
export function formatStats(stats: FleetStats, elapsedMs: number): string {
  const { latency } = stats;
  return [
    `t=${formatClock(elapsedMs)}`,
    `started ${stats.started}/${stats.chargers}`,
    `online ${stats.connected}`,
    `booted ${stats.registered}`,
    `| tx ${stats.activeTransactions} (done ${stats.sessionsCompleted})`,
    `| ${formatNumber(stats.powerKW)} kW ${formatNumber(stats.energyKWh, 1)} kWh`,
    `| calls ${stats.callsSent} err ${stats.callErrors}`,
    `| rtt p50 ${formatNumber(latency.p50)} p95 ${formatNumber(latency.p95)} p99 ${formatNumber(latency.p99)} ms`,
  ].join(' ');
}

/** `ocpp-kit sim` entry point. */
export async function runSim(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      url: { type: 'string', default: 'ws://localhost:9220' },
      count: { type: 'string', short: 'n', default: '1' },
      ramp: { type: 'string', default: '10/s' },
      prefix: { type: 'string', default: 'SIM-' },
      connectors: { type: 'string', default: '2' },
      'max-power': { type: 'string', default: '22' },
      seed: { type: 'string', default: '1' },
      password: { type: 'string' },
      'meter-interval': { type: 'string', default: '60s' },
      idle: { type: 'string', default: '30s-5m' },
      'max-session': { type: 'string', default: '4h' },
      'no-autopilot': { type: 'boolean', default: false },
      duration: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(SIM_USAGE);
    return;
  }
  const maxPowerKW = Number(values['max-power']);
  if (!(maxPowerKW > 0)) throw new Error('--max-power must be a positive number of kW');
  const fleet = new Fleet({
    url: parseUrl(values.url),
    count: parseInteger(values.count, 'count'),
    ratePerSecond: parseRate(values.ramp),
    identityPrefix: values.prefix,
    seed: parseInteger(values.seed, 'seed', 0),
    charger: {
      connectors: parseInteger(values.connectors, 'connectors'),
      maxPowerW: maxPowerKW * 1_000,
      meterValueSampleIntervalS: Math.round(parseDuration(values['meter-interval']) / 1_000),
      autopilot: values['no-autopilot']
        ? false
        : {
            idleS: parseRangeSeconds(values.idle),
            maxSessionS: parseDuration(values['max-session']) / 1_000,
          },
      ...(values.password === undefined ? {} : { password: values.password }),
    },
  });
  const durationMs = values.duration === undefined ? undefined : parseDuration(values.duration);

  const startedAt = Date.now();
  const tty = process.stdout.isTTY;
  const print = (): void => {
    const line = formatStats(fleet.stats(), Date.now() - startedAt);
    if (tty) process.stdout.write(`\r\x1b[2K${line}`);
    else console.log(line);
  };
  const ticker = setInterval(print, tty ? 1_000 : 5_000);
  console.log(
    `Simulating ${fleet.chargers.length} charge point(s) against ${values.url} (Ctrl-C to stop)`,
  );
  void fleet.start();

  await new Promise<void>((resolve) => {
    const timer = durationMs === undefined ? undefined : setTimeout(resolve, durationMs);
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  clearInterval(ticker);
  const final = fleet.stats();
  await fleet.stop();
  if (tty) process.stdout.write('\n');
  if (values.json) console.log(JSON.stringify(final, null, 2));
  else console.log(`Final: ${formatStats(final, Date.now() - startedAt)}`);
}
