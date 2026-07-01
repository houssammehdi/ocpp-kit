import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { MessageTrigger } from '../messages/index.js';
import {
  parseCertificateIdentity,
  parseDuration,
  parseInteger,
  readPem,
  UsageError,
} from './args.js';
import { DemoCsms, type DemoCsmsOptions, type StationView } from './demo-csms.js';
import { fit, formatNumber, renderTable, untilInterrupted, type Column } from './format.js';

export const CSMS_USAGE = `Usage: ocpp-kit csms [options]

Run a demo Central System that accepts every charge point and id tag.

Options:
  -p, --port <n>            Port to listen on (default 9220)
      --host <addr>         Interface to bind (default: all)
      --path <prefix>       URL path prefix before the identity (default /)
      --password <secret>   Require HTTP Basic auth (Security Profile 1, or 2 with TLS)
      --tls-cert <file>     Serve wss:// with this PEM certificate (Security Profile 2)
      --tls-key <file>      Private key of --tls-cert
      --tls-ca <file>       Require client certificates issued by this CA (Profile 3)
      --client-certs <mode> required (default with --tls-ca) or optional
      --cert-identity <r>   How the identity must match the client certificate:
                            cn-or-san (default), cn, san or none
      --heartbeat <dur>     Heartbeat interval handed out at boot (default 60s)
      --auto-start <dur>    Remote-start an idle connector on every charger each interval
      --no-table            Log events line by line instead of drawing a live table
  -h, --help                Show this help

Interactive commands (when attached to a terminal):
  start <id> [connector] [idTag]        stop <id> [connector|txId]
  limit <id> <kW|off>                   reset <id> [hard]
  reserve <id> <connector> <idTag> [minutes]    cancel <id> <reservationId>
  trigger <id> <message> [connector]    config <id> <key> [value]
  firmware <id> <url>                   diagnostics <id> <url>
  list   help   quit`;

const COMMAND_HELP =
  'commands: start | stop | limit | reset | reserve | cancel | trigger | config | firmware | diagnostics | list | quit (help for details)';

const COMMAND_DETAILS = `start <id> [connector] [idTag]  stop <id> [connector|txId]  limit <id> <kW|off>  reset <id> [hard]
reserve <id> <connector> <idTag> [minutes]  cancel <id> <reservationId>
trigger <id> <message> [connector]  config <id> <key> [value]  firmware <id> <url>  diagnostics <id> <url>`;

const TRIGGERS: ReadonlySet<string> = new Set(
  MessageTrigger.anyOf.map((literal: { const: string }) => literal.const),
);

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
      return output(COMMAND_DETAILS);
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
    case 'reserve': {
      const [connector, idTag, minutes] = args;
      if (connector === undefined || idTag === undefined) {
        throw new UsageError('usage: reserve <id> <connector> <idTag> [minutes]');
      }
      return output(
        csms.reserve(
          needIdentity(),
          parseInteger(connector, 'connector', 0),
          idTag,
          minutes === undefined ? undefined : parseInteger(minutes, 'minutes'),
        ),
      );
    }
    case 'cancel': {
      if (args[0] === undefined) throw new UsageError('usage: cancel <id> <reservationId>');
      return output(
        csms.cancelReservation(needIdentity(), parseInteger(args[0], 'reservationId', 0)),
      );
    }
    case 'trigger': {
      const [message, connector] = args;
      if (message === undefined || !TRIGGERS.has(message)) {
        throw new UsageError(`usage: trigger <id> <${[...TRIGGERS].join('|')}> [connector]`);
      }
      return output(
        csms.trigger(
          needIdentity(),
          message as MessageTrigger,
          connector === undefined ? undefined : parseInteger(connector, 'connector', 0),
        ),
      );
    }
    case 'config': {
      const [key, value] = args;
      if (key === undefined) throw new UsageError('usage: config <id> <key> [value]');
      return output(csms.configure(needIdentity(), key, value));
    }
    case 'firmware':
    case 'diagnostics': {
      const [location] = args;
      if (location === undefined) throw new UsageError(`usage: ${command} <id> <url>`);
      const identity = needIdentity();
      return output(
        command === 'firmware'
          ? csms.updateFirmware(identity, location)
          : csms.getDiagnostics(identity, location),
      );
    }
    default:
      return output(`unknown command "${command}" (${COMMAND_HELP})`);
  }
}

/** Server TLS settings from the `csms` flags. */
function serverTlsFromFlags(values: {
  readonly 'tls-cert'?: string | undefined;
  readonly 'tls-key'?: string | undefined;
  readonly 'tls-ca'?: string | undefined;
  readonly 'client-certs'?: string | undefined;
  readonly 'cert-identity'?: string | undefined;
}): Pick<DemoCsmsOptions, 'tls' | 'clientCertificates'> {
  const certFile = values['tls-cert'];
  const keyFile = values['tls-key'];
  const caFile = values['tls-ca'];
  if (certFile === undefined || keyFile === undefined) {
    if (certFile !== undefined || keyFile !== undefined || caFile !== undefined) {
      throw new UsageError('--tls-cert and --tls-key go together (and --tls-ca needs both)');
    }
    if (values['client-certs'] !== undefined || values['cert-identity'] !== undefined) {
      throw new UsageError('--client-certs and --cert-identity need --tls-ca');
    }
    return {};
  }
  const tls = {
    cert: readPem(certFile, 'tls-cert'),
    key: readPem(keyFile, 'tls-key'),
    ...(caFile === undefined ? {} : { ca: readPem(caFile, 'tls-ca') }),
  };
  if (caFile === undefined) {
    if (values['client-certs'] !== undefined || values['cert-identity'] !== undefined) {
      throw new UsageError('--client-certs and --cert-identity need --tls-ca');
    }
    return { tls };
  }
  const mode = values['client-certs'] ?? 'required';
  if (mode !== 'required' && mode !== 'optional') {
    throw new UsageError(`--client-certs must be required or optional, got "${mode}"`);
  }
  const binding =
    values['cert-identity'] === undefined
      ? undefined
      : parseCertificateIdentity(values['cert-identity']);
  return {
    tls,
    clientCertificates: {
      required: mode === 'required',
      ...(binding === undefined ? {} : { identityBinding: binding }),
    },
  };
}

/** `ocpp-kit csms` entry point. */
export async function runCsms(
  argv: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<void> {
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
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      'tls-ca': { type: 'string' },
      'client-certs': { type: 'string' },
      'cert-identity': { type: 'string' },
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
  const tls = serverTlsFromFlags(values);
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
    ...tls,
  });
  const address = await csms.listen(port, values.host);
  const shown = values.host ?? 'localhost';
  log(
    `listening on ${tls.tls ? 'wss' : 'ws'}://${shown}:${address.port}${values.path === '/' ? '' : values.path}/<identity> (ocpp1.6${tls.clientCertificates ? ', client certificates' : ''})`,
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
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      for (const timer of timers) clearInterval(timer);
      rl?.close();
      await csms.close();
      if (table) process.stdout.write('\n');
      console.log('CSMS stopped.');
    })());

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

  const interrupted = new AbortController();
  options.signal?.addEventListener('abort', () => interrupted.abort(), { once: true });
  rl?.once('close', () => interrupted.abort());
  await untilInterrupted(interrupted.signal);
  await stop();
}
