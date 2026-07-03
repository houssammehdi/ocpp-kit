#!/usr/bin/env node
import { VERSION } from '../version.js';
import { UsageError } from './args.js';
import { runConform } from './conform.js';
import { runCsms } from './csms.js';
import { runSim } from './sim.js';

const USAGE = `ocpp-kit - OCPP 1.6-J toolkit

Usage:
  ocpp-kit sim     [options]   Simulate charge points (load testing)
  ocpp-kit csms    [options]   Run a demo Central System
  ocpp-kit conform [options]   Check a Central System against the specification

Run "ocpp-kit <command> --help" for command options.`;

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'sim':
      await runSim(rest);
      return;
    case 'csms':
      await runCsms(rest);
      return;
    case 'conform':
      process.exitCode = await runConform(rest);
      return;
    case '--version':
    case '-v':
      console.log(VERSION);
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
