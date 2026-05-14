#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { UsageError } from './args.js';
import { runCsms } from './csms.js';
import { runSim } from './sim.js';

const USAGE = `ocpp-kit - OCPP 1.6-J toolkit

Usage:
  ocpp-kit sim  [options]   Simulate charge points (load testing)
  ocpp-kit csms [options]   Run a demo Central System

Run "ocpp-kit <command> --help" for command options.`;

function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'sim':
      await runSim(rest);
      return;
    case 'csms':
      await runCsms(rest);
      return;
    case '--version':
    case '-v':
      console.log(version());
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      throw new UsageError(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  () => {
    process.exit(process.exitCode ?? 0);
  },
  (error: unknown) => {
    const usage =
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    console.error(`ocpp-kit: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(usage ? 2 : 1);
  },
);
