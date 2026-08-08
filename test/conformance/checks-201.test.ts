import { afterEach, describe, expect, it } from 'vitest';
import { DemoCsms } from '../../src/cli/demo-csms.js';
import {
  conforms,
  OCPP201_CHECKS,
  ocpp201Conformance,
  runConformance,
  type ConformanceOptions,
} from '../../src/index.js';
import {
  BREAKAGES,
  BREAKAGES_201,
  FixtureCsms,
  type Breakage,
  type FixtureOptions,
} from './fixture-csms.js';

/** Short waits keep the suite fast; the fixture answers within milliseconds. */
const FAST = { timeoutMs: 1_000, observeMs: 300, latencySamples: 5 } as const;
const PASSWORD = 'correct horse battery';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const csms = new FixtureCsms({ protocol: 'ocpp2.0.1', ...options });
  cleanups.push(() => csms.close());
  return csms.listen();
}

interface FailureCase {
  readonly breakage: Breakage;
  readonly options?: Partial<ConformanceOptions>;
  readonly only?: readonly string[];
}

/** For every 2.0.1 check (but the TLS one, see test/tls): a breakage that must make it fail. */
const FAILURES: Readonly<Record<string, FailureCase>> = {
  'ws.subprotocol': { breakage: 'no-subprotocol' },
  'ws.subprotocol-refusal': { breakage: 'accept-any-subprotocol' },
  'ws.basic-auth': { breakage: 'ignore-password', options: { password: PASSWORD } },
  'ws.ping': { breakage: 'no-pong' },
  'boot.response': { breakage: 'boot-invalid' },
  'boot.interval': { breakage: 'boot-interval-zero' },
  'boot.clock': { breakage: 'boot-clock-skew' },
  'heartbeat.response': { breakage: 'heartbeat-invalid' },
  'status.notification': { breakage: 'status-invalid' },
  'authorize.response': { breakage: 'authorize-invalid' },
  'transaction.started': { breakage: 'start-invalid' },
  'transaction.updated': { breakage: 'updated-error' },
  'transaction.ended': { breakage: 'ended-invalid' },
  'transaction.offline': { breakage: 'offline-error' },
  'transaction.replay': { breakage: 'replay-error' },
  'transaction.ended-unknown': { breakage: 'ended-unknown-error' },
  'meter-values.main-meter': { breakage: 'main-meter-error' },
  'security-event.response': { breakage: 'security-event-error' },
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
  // Passive checks: give the fixture's post-boot CALLs, or its CALLERRORs, time to arrive.
  'rpc.server-calls': { breakage: 'invalid-server-call', only: ['latency', 'rpc.server-calls'] },
  'rpc.error-codes': {
    breakage: 'v16-error-codes',
    only: ['rpc.invalid-payload', 'rpc.error-codes'],
  },
};

/** The 1.6 breakages that have no 2.0.1 check, because 2.0.1 has no such rule or message. */
const V16_ONLY: readonly Breakage[] = [
  'accept-without-certificate', // tls.client-certificate is exercised in test/tls
  'status0-error', // 2.0.1 has no connector 0
  'meter-values-error', // transaction meter values travel in TransactionEvent
  'stop-invalid',
  'same-transaction-id', // 2.0.1 stations choose the transaction id
  'replay-new-id',
  'stop-unknown-error',
];

describe('OCPP 2.0.1 conformance checks', () => {
  it('pass against a correct CSMS', async () => {
    const url = await fixture({ password: PASSWORD });
    const report = await runConformance(ocpp201Conformance, {
      url,
      identity: 'CS-GOOD',
      password: PASSWORD,
      ...FAST,
    });
    const notPassed = report.results
      .filter((result) => result.status !== 'pass')
      .map((result) => `${result.id}: ${result.status}: ${result.message}`);
    expect(notPassed).toEqual(['tls.client-certificate: skip: no client certificate configured']);
    expect(report.results.map((result) => result.id)).toEqual(OCPP201_CHECKS.map((c) => c.id));
    expect(report.protocol).toBe('OCPP 2.0.1');
    expect(conforms(report)).toBe(true);
  });

  it('can each be made to fail by a CSMS that breaks the rule', () => {
    expect(Object.keys(FAILURES).sort()).toEqual(
      OCPP201_CHECKS.map((check) => check.id)
        .filter((id) => id !== 'tls.client-certificate')
        .sort(),
    );
    const used = new Set(Object.values(FAILURES).map((failure) => failure.breakage));
    const expected = new Set<Breakage>(
      [...BREAKAGES, ...BREAKAGES_201].filter(
        (breakage) => !V16_ONLY.includes(breakage) && breakage !== 'message-type-not-supported',
      ),
    );
    expect(used).toEqual(expected);
  });

  it.each(Object.entries(FAILURES))(
    '%s fails when the CSMS breaks it',
    async (id, { breakage, options, only }) => {
      const url = await fixture({
        breakages: [breakage],
        ...(options?.password === undefined ? {} : { password: options.password }),
      });
      const report = await runConformance(ocpp201Conformance, {
        url,
        identity: 'CS-BROKEN',
        ...FAST,
        ...options,
        only: only ?? [id],
      });
      const result = report.results.find((candidate) => candidate.id === id);
      expect(result?.status, result?.message).toBe('fail');
      expect(conforms(report)).toBe(result?.level !== 'MUST');
    },
  );

  it('tolerates the deprecated MessageTypeNotSupported answer to an unknown message type', async () => {
    const url = await fixture({ breakages: ['message-type-not-supported'] });
    const report = await runConformance(ocpp201Conformance, {
      url,
      identity: 'CS-MTNS',
      ...FAST,
      only: ['rpc.unknown-message-type'],
    });
    expect(report.results[0]).toMatchObject({
      status: 'pass',
      message: 'answered with CALLERROR MessageTypeNotSupported and kept serving',
    });
  });

  it('flags a CSMS that answers a 2.0.1 connection with 1.6 error codes', async () => {
    const url = await fixture({ breakages: ['v16-error-codes'] });
    const report = await runConformance(ocpp201Conformance, {
      url,
      identity: 'CS-CODES',
      ...FAST,
      only: ['rpc.invalid-payload', 'rpc.error-codes'],
    });
    expect(report.results.find((r) => r.id === 'rpc.error-codes')?.message).toMatch(
      /^used "OccurenceConstraintViolation", which OCPP 2\.0\.1 does not define$/,
    );
  });

  it('passes against the demo CSMS, which serves 1.6 and 2.0.1 on one port', async () => {
    const demo = new DemoCsms({ password: PASSWORD });
    const { port } = await demo.listen(0, '127.0.0.1');
    cleanups.push(() => demo.close());
    const timer = setInterval(() => void demo.autoStart(), 100);
    cleanups.push(() => {
      clearInterval(timer);
      return Promise.resolve();
    });
    const report = await runConformance(ocpp201Conformance, {
      url: `ws://127.0.0.1:${port}`,
      identity: 'CS-DEMO',
      password: PASSWORD,
      ...FAST,
    });
    const notPassed = report.results
      .filter((result) => result.status !== 'pass')
      .map((result) => `${result.id}: ${result.status}: ${result.message}`);
    expect(notPassed).toEqual(['tls.client-certificate: skip: no client certificate configured']);
  });

  it('accepts id tags up to the 36 characters of a 2.0.1 idToken', async () => {
    const url = await fixture();
    const report = await runConformance(ocpp201Conformance, {
      url,
      identity: 'CS-TOKEN',
      idTag: 'T'.repeat(36),
      ...FAST,
      only: ['authorize.response'],
    });
    expect(report.results.at(-1)?.status).toBe('pass');
    await expect(
      runConformance(ocpp201Conformance, { url, identity: 'CS', idTag: 'T'.repeat(37) }),
    ).rejects.toThrow(/1 to 36 characters/);
  });
});
