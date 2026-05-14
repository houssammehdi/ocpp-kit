import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { parseDuration, parseInteger, UsageError } from './args.js';
import { DemoCsms, type StationView } from './demo-csms.js';
import { fit, formatNumber, renderTable, type Column } from './format.js';

export const CSMS_USAGE = `Usage: ocpp-kit csms [options]

Run a demo Central System that accepts every charge point and id tag.

Options:
  -p, --port <n>            Port to listen on (default 9220)
      --host <addr>         Interface to bind (default: all)
      --path <prefix>       URL path prefix before the identity (default /)
      --password <secret>   Require HTTP Basic auth (Security Profile 1)
      --heartbeat <dur>     Heartbeat interval handed out at boot (default 60s)
      --auto-start <dur>    Remote-start an idle connector on every charger each interval
      --no-table            Log events line by line instead of drawing a live table
  -h, --help                Show this help

Interactive commands (when attached to a terminal):
  start <id> [connector] [idTag]   stop <id> [connector|txId]   limit <id> <kW|off>
  reset <id> [hard]                list                         help   quit`;

const COMMAND_HELP =
  'commands: start <id> [conn] [tag] | stop <id> [conn|tx] | limit <id> <kW|off> | reset <id> [hard] | quit';

function connectorSummary(station: StationView): string {
  return [...station.connectors.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, view]) => `${id}:${view.status}`)
    .join(' ');
}

const COLUMNS: readonly Column<StationView>[] = [
  { header: 'CHARGE POINT', width: 14, value: (s) => s.identity },
  { header: 'LINK', width: 7, value: (s) => (s.connected ? 'online' : 'offline') },
  { header: 'MODEL', width: 12, value: (s) => s.model ?? '-' },
  { header: 'CONNECTORS', width: 34, value: connectorSummary },
  {
    header: 'kW',
    width: 6,
    align: 'right',
    value: (s) =>
      formatNumber(
        [...s.connectors.values()].reduce((sum, c) => sum + (c.transactionId ? c.powerW : 0), 0) /
          1_000,
      ),
  },
  {
    header: 'kWh',
    width: 7,
    align: 'right',
    value: (s) =>
      formatNumber(
        [...s.connectors.values()].reduce((sum, c) => sum + (c.transactionId ? c.energyWh : 0), 0) /
          1_000,
        2,
      ),
  },
  { header: 'MSGS', width: 6, align: 'right', value: (s) => String(s.messages) },
  {
    header: 'SEEN',
    width: 5,
    align: 'right',
    value: (s) => `${Math.max(0, Math.round((Date.now() - s.lastSeen.getTime()) / 1_000))}s`,
  },
];

/** Render the live station table (exported for tests). */
export function renderStations(csms: DemoCsms, maxRows: number): string {
  const totals = csms.totals();
  const header =
    `ocpp-kit demo CSMS | ${totals.connected}/${totals.stations} online | ${totals.transactions} tx | ` +
    `${formatNumber(totals.powerKW)} kW | ${formatNumber(totals.energyKWh, 2)} kWh in active sessions`;
  const rows = [...csms.stations.values()].sort((a, b) => a.identity.localeCompare(b.identity));
  return `${header}\n\n${renderTable(COLUMNS, rows, maxRows)}`;
}

/** Result of an interactive command. */
export interface CommandResult {
  readonly output: string;
  readonly quit?: boolean;
}

/** Execute one interactive command. */
export async function executeCommand(csms: DemoCsms, line: string): Promise<CommandResult> {
  const output = (text: string | Promise<string>): Promise<CommandResult> =>
    Promise.resolve(text).then((value) => ({ output: value }));
  const [command, identity, ...args] = line.trim().split(/\s+/);
  const needIdentity = (): string => {
    if (!identity) throw new UsageError(`usage: ${command ?? ''} <chargePointId> ...`);
    return identity;
  };
  switch (command) {
    case undefined:
    case '':
      return output('');
    case 'help':
      return output(COMMAND_HELP);
    case 'quit':
    case 'exit':
      return { output: '', quit: true };
    case 'list':
      return output([...csms.stations.keys()].join(' ') || '(no charge points yet)');
    case 'start': {
      const connector = args[0] === undefined ? undefined : parseInteger(args[0], 'connector');
      return output(csms.remoteStart(needIdentity(), connector, args[1]));
    }
    case 'stop': {
      const target = args[0] === undefined ? undefined : parseInteger(args[0], 'target', 0);
      return output(csms.remoteStop(needIdentity(), target));
    }
    case 'limit': {
      const value = args[0];
      if (value === undefined) throw new UsageError('usage: limit <id> <kW|off>');
      const kW = value === 'off' ? undefined : Number(value);
      if (kW !== undefined && !(kW >= 0)) throw new UsageError(`Invalid power "${value}"`);
      return output(csms.setLimit(needIdentity(), kW));
    }
    case 'reset':
      return output(csms.reset(needIdentity(), args[0] === 'hard' ? 'Hard' : 'Soft'));
    default:
      return output(`unknown command "${command}" (${COMMAND_HELP})`);
  }
}

/** `ocpp-kit csms` entry point. */
export async function runCsms(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: 'string', short: 'p', default: '9220' },
      host: { type: 'string' },
      path: { type: 'string', default: '/' },
      password: { type: 'string' },
      heartbeat: { type: 'string', default: '60s' },
      'auto-start': { type: 'string' },
      'no-table': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(CSMS_USAGE);
    return;
  }
  const port = parseInteger(values.port, 'port', 0);
  const heartbeatIntervalS = Math.round(parseDuration(values.heartbeat) / 1_000);
  const autoStartMs =
    values['auto-start'] === undefined ? undefined : parseDuration(values['auto-start']);
  const interactive = process.stdout.isTTY && process.stdin.isTTY;
  const table = interactive && !values['no-table'];
  const recent: string[] = [];
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    if (table) {
      recent.push(stamped);
      if (recent.length > 6) recent.shift();
    } else {
      console.log(stamped);
    }
  };

  const csms = new DemoCsms({
    heartbeatIntervalS,
    basePath: values.path,
    log,
    ...(values.password === undefined ? {} : { password: values.password }),
  });
  const address = await csms.listen(port, values.host);
  const shown = values.host ?? 'localhost';
  log(
    `listening on ws://${shown}:${address.port}${values.path === '/' ? '' : values.path}/<identity> (ocpp1.6)`,
  );

  const timers: NodeJS.Timeout[] = [];
  if (autoStartMs !== undefined) {
    timers.push(
      setInterval(() => {
        void csms.autoStart().then((n) => {
          if (n > 0) log(`auto-start: ${n} session(s) requested`);
        });
      }, autoStartMs),
    );
  }

  let rl: ReturnType<typeof createInterface> | undefined;
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    rl?.close();
    await csms.close();
    if (table) process.stdout.write('\n');
    console.log('CSMS stopped.');
  };

  if (table) {
    const draw = (): void => {
      const rows = Math.max(5, (process.stdout.rows || 40) - 14);
      const screen = [
        renderStations(csms, rows),
        '',
        ...recent,
        '',
        fit(COMMAND_HELP, process.stdout.columns || 120),
      ];
      process.stdout.write(`\x1b[H\x1b[2J${screen.join('\n')}\n`);
      rl?.prompt(true);
    };
    timers.push(setInterval(draw, 1_000));
    draw();
  } else if (!interactive) {
    timers.push(
      setInterval(() => {
        const t = csms.totals();
        log(
          `${t.connected}/${t.stations} online, ${t.transactions} tx, ${formatNumber(t.powerKW)} kW`,
        );
      }, 10_000),
    );
  }

  if (interactive) {
    rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    rl.on('line', (line) => {
      executeCommand(csms, line)
        .then((result) => {
          if (result.quit) void stop();
          else if (result.output) log(result.output);
        })
        .catch((error: unknown) => {
          log(`error: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
    rl.on('SIGINT', () => void stop());
    rl.prompt();
  }

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      void stop().then(resolve);
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    rl?.once('close', finish);
  });
}
