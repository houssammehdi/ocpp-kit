import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoCsms } from '../../src/cli/demo-csms.js';
import {
  conforms,
  OCPP16_CHECKS,
  ocpp16Conformance,
  runConformance,
  type ConformanceOptions,
} from '../../src/index.js';
import { BREAKAGES, FixtureCsms, type Breakage, type FixtureOptions } from './fixture-csms.js';

/** Short waits keep the suite fast; the fixture answers within milliseconds. */
const FAST = { timeoutMs: 1_000, observeMs: 300, latencySamples: 5 } as const;

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const csms = new FixtureCsms(options);
  cleanups.push(() => csms.close());
  return csms.listen();
}

interface FailureCase {
  readonly breakage: Breakage;
  /** Extra run options. */
  readonly options?: Partial<ConformanceOptions>;
  /** Checks to run, when running the failing one alone is not enough. */
  readonly only?: readonly string[];
}

const PASSWORD = 'correct horse battery';

/** For every check (but the TLS one, see test/tls): a breakage that must make it fail. */
const FAILURES: Readonly<Record<string, FailureCase>> = {
  'ws.subprotocol': { breakage: 'no-subprotocol' },
  'ws.subprotocol-refusal': { breakage: 'accept-any-subprotocol' },
  'ws.basic-auth': { breakage: 'ignore-password', options: { password: PASSWORD } },
  'ws.ping': { breakage: 'no-pong' },
  'boot.response': { breakage: 'boot-invalid' },
  'boot.interval': { breakage: 'boot-interval-zero' },
  'boot.clock': { breakage: 'boot-clock-skew' },
  'heartbeat.response': { breakage: 'heartbeat-invalid' },
  'status.connector0': { breakage: 'status0-error' },
  'status.connector': { breakage: 'status-invalid' },
  'authorize.response': { breakage: 'authorize-invalid' },
  'transaction.start': { breakage: 'start-invalid' },
  'transaction.meter-values': { breakage: 'meter-values-error' },
  'transaction.stop': { breakage: 'stop-invalid' },
  'meter-values.no-transaction': { breakage: 'main-meter-error' },
  'transaction.id-unique': { breakage: 'same-transaction-id' },
  'transaction.start-replay': { breakage: 'replay-new-id' },
  'transaction.stop-unknown': { breakage: 'stop-unknown-error' },
  'data-transfer.unknown-vendor': { breakage: 'data-transfer-accepted' },
  'rpc.unknown-action': { breakage: 'ignore-unknown-action' },
  'rpc.unknown-action-code': { breakage: 'unknown-action-not-supported' },
  'rpc.invalid-payload': { breakage: 'no-validation' },
  'rpc.malformed-frame': { breakage: 'ignore-malformed-frames' },
  'rpc.malformed-json': { breakage: 'close-on-bad-json' },
  'rpc.unknown-message-type': { breakage: 'answer-unknown-type' },
  'rpc.unmatched-response': { breakage: 'answer-unmatched' },
  latency: { breakage: 'slow', options: { latencyBudgetMs: 20 } },
  'ws.duplicate-connection': { breakage: 'keep-duplicates' },
  'rpc.single-outstanding-call': { breakage: 'concurrent-calls' },
  // A passive check: give the fixture's post-boot CALLs time to arrive first.
  'rpc.server-calls': { breakage: 'invalid-server-call', only: ['latency', 'rpc.server-calls'] },
};

describe('OCPP 1.6 conformance checks', () => {
  it('pass against a correct Central System', async () => {
    const url = await fixture({ password: PASSWORD });
    const report = await runConformance(ocpp16Conformance, {
      url,
      identity: 'CP-GOOD',
      password: PASSWORD,
      ...FAST,
    });
    const notPassed = report.results
      .filter((result) => result.status !== 'pass')
      .map((result) => `${result.id}: ${result.status}: ${result.message}`);
    expect(notPassed).toEqual(['tls.client-certificate: skip: no client certificate configured']);
    expect(report.results.map((result) => result.id)).toEqual(OCPP16_CHECKS.map((c) => c.id));
    expect(conforms(report)).toBe(true);
  });

  it('can each be made to fail by a Central System that breaks the rule', () => {
    const tlsOnly = ['tls.client-certificate'];
    expect(Object.keys(FAILURES).sort()).toEqual(
      OCPP16_CHECKS.map((check) => check.id)
        .filter((id) => !tlsOnly.includes(id))
        .sort(),
    );
    expect(new Set(Object.values(FAILURES).map((failure) => failure.breakage))).toEqual(
      new Set(BREAKAGES.filter((breakage) => breakage !== 'accept-without-certificate')),
    );
  });

  it.each(Object.entries(FAILURES))(
    '%s fails when the Central System breaks it',
    async (id, { breakage, options, only }) => {
      const url = await fixture({
        breakages: [breakage],
        ...(options?.password === undefined ? {} : { password: options.password }),
      });
      const report = await runConformance(ocpp16Conformance, {
        url,
        identity: 'CP-BROKEN',
        ...FAST,
        ...options,
        only: only ?? [id],
      });
      const result = report.results.find((candidate) => candidate.id === id);
      expect(result?.status, result?.message).toBe('fail');
      expect(conforms(report)).toBe(result?.level !== 'MUST');
    },
  );

  it('passes against the demo CSMS', async () => {
    const demo = new DemoCsms({ password: PASSWORD });
    const { port } = await demo.listen(0, '127.0.0.1');
    cleanups.push(() => demo.close());
    // The demo only sends CALLs when asked to; auto-start gives the CALL checks something to see.
    const timer = setInterval(() => void demo.autoStart(), 100);
    cleanups.push(() => {
      clearInterval(timer);
      return Promise.resolve();
    });
    const report = await runConformance(ocpp16Conformance, {
      url: `ws://127.0.0.1:${port}`,
      identity: 'CP-DEMO',
      password: PASSWORD,
      ...FAST,
    });
    const notPassed = report.results
      .filter((result) => result.status !== 'pass')
      .map((result) => `${result.id}: ${result.status}: ${result.message}`);
    expect(notPassed).toEqual(['tls.client-certificate: skip: no client certificate configured']);
  });
});

describe('conformance runner', () => {
  it('reports every check as an error when the Central System is unreachable', async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
      });
    });
    const report = await runConformance(ocpp16Conformance, {
      url: `ws://127.0.0.1:${port}/ocpp`,
      identity: 'CP-NOWHERE',
      ...FAST,
      only: ['ws.', 'boot.response', 'heartbeat.response'],
    });
    expect(report.results.map((result) => [result.id, result.status])).toEqual([
      ['ws.subprotocol', 'error'],
      ['ws.subprotocol-refusal', 'error'],
      ['ws.basic-auth', 'skip'],
      ['ws.ping', 'error'],
      ['boot.response', 'error'],
      ['heartbeat.response', 'error'],
      ['ws.duplicate-connection', 'error'],
    ]);
    expect(report.results[0]?.message).toMatch(/^could not connect: .*ECONNREFUSED/);
    expect(report.summary).toMatchObject({ errors: 6, mustErrors: 4, failed: 0 });
    expect(conforms(report)).toBe(false);
  });

  it('stops after a registration that is not accepted', async () => {
    const url = await fixture({ bootStatus: 'Pending' });
    const report = await runConformance(ocpp16Conformance, {
      url,
      identity: 'CP-PENDING',
      ...FAST,
      only: ['boot.', 'heartbeat.response', 'authorize.response'],
    });
    expect(report.results.map((result) => [result.id, result.status])).toEqual([
      ['boot.response', 'pass'],
      ['boot.interval', 'pass'],
      ['boot.clock', 'pass'],
      ['heartbeat.response', 'error'],
      ['authorize.response', 'error'],
    ]);
    expect(report.results[3]?.message).toBe(
      'the Central System answered BootNotification with Pending; make it accept CP-PENDING and run again',
    );
    expect(conforms(report)).toBe(false);
  });

  it('skips checks whose prerequisite failed and pulls prerequisites into --only', async () => {
    const url = await fixture({ breakages: ['start-invalid'] });
    const report = await runConformance(ocpp16Conformance, {
      url,
      identity: 'CP-DEPS',
      ...FAST,
      only: ['transaction.stop'],
    });
    expect(report.results.map((result) => [result.id, result.status, result.message])).toEqual([
      ['transaction.start', 'fail', expect.stringContaining('StartTransaction.conf is invalid')],
      ['transaction.stop', 'skip', 'needs transaction.start (fail)'],
    ]);
  });

  it('streams results and honours --skip', async () => {
    const url = await fixture();
    const seen: string[] = [];
    const report = await runConformance(ocpp16Conformance, {
      url,
      identity: 'CP-STREAM',
      ...FAST,
      only: ['boot', 'rpc.unknown-action'],
      skip: ['boot.clock', 'rpc.unknown-action-code'],
      onResult: (result) => seen.push(result.id),
    });
    expect(seen).toEqual(['boot.response', 'boot.interval', 'rpc.unknown-action']);
    expect(report.results.map((result) => result.id)).toEqual(seen);
    expect(report).toMatchObject({
      tool: { name: 'ocpp-kit' },
      protocol: 'OCPP 1.6-J',
      target: { url, identity: 'CP-STREAM' },
      summary: { total: 3, passed: 3 },
    });
  });

  it('rejects invalid options', async () => {
    const run = (options: Partial<ConformanceOptions>) =>
      runConformance(ocpp16Conformance, { url: 'ws://127.0.0.1:1', identity: 'CP', ...options });
    await expect(run({ url: 'http://example.com' })).rejects.toThrow(/ws:\/\/ or wss:\/\//);
    await expect(run({ url: 'not a url' })).rejects.toThrow(/Invalid URL/);
    await expect(run({ identity: '' })).rejects.toThrow(/identity is empty/);
    await expect(run({ idTag: 'X'.repeat(21) })).rejects.toThrow(/CiString20/);
    await expect(run({ timeoutMs: 0 })).rejects.toThrow(/timeoutMs must be a positive number/);
    await expect(run({ only: ['rpc.nope'] })).rejects.toThrow(/No check matches "rpc.nope"/);
  });
});
