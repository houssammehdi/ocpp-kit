import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DemoCsms } from '../../src/cli/demo-csms.js';
import { ocpp16Conformance, runConformance, type ConformanceReport } from '../../src/index.js';
import { FixtureCsms } from '../conformance/fixture-csms.js';
import { createTestPki, opensslAvailable, type TestPki } from './pki.js';

const describeTls = opensslAvailable ? describe : describe.skip;

let pki: TestPki;
beforeAll(() => {
  if (opensslAvailable) pki = createTestPki();
});
afterAll(() => {
  if (opensslAvailable) pki.dispose();
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FAST = { timeoutMs: 2_000, observeMs: 300, latencySamples: 3 } as const;
const statuses = (report: ConformanceReport) =>
  Object.fromEntries(report.results.map((result) => [result.id, result.status]));

describeTls('conformance checks over TLS', () => {
  it('pass against the demo CSMS with Security Profile 3', async () => {
    const demo = new DemoCsms({
      tls: { cert: pki.server.cert, key: pki.server.key, ca: pki.ca.cert },
      clientCertificates: {},
    });
    const { port } = await demo.listen(0, '127.0.0.1');
    cleanups.push(() => demo.close());
    const report = await runConformance(ocpp16Conformance, {
      url: `wss://127.0.0.1:${port}`,
      identity: 'CP-TLS-CONF',
      tls: { ca: pki.ca.cert, ...pki.client('CP-TLS-CONF') },
      ...FAST,
      only: ['ws.', 'tls.', 'boot.response', 'heartbeat.response'],
    });
    expect(statuses(report)).toEqual({
      'ws.subprotocol': 'pass',
      'ws.subprotocol-refusal': 'pass',
      'ws.basic-auth': 'skip',
      'tls.client-certificate': 'pass',
      'ws.ping': 'pass',
      'boot.response': 'pass',
      'heartbeat.response': 'pass',
      'ws.duplicate-connection': 'pass',
    });
    expect(report.results.find((r) => r.id === 'tls.client-certificate')?.message).toBe(
      'without a client certificate it refused with HTTP 403',
    );
  });

  it('check Basic auth over TLS (Security Profile 2)', async () => {
    const demo = new DemoCsms({
      tls: { cert: pki.server.cert, key: pki.server.key },
      password: 'tls-profile-2-password',
    });
    const { port } = await demo.listen(0, '127.0.0.1');
    cleanups.push(() => demo.close());
    const report = await runConformance(ocpp16Conformance, {
      url: `wss://127.0.0.1:${port}`,
      identity: 'CP-SP2',
      password: 'tls-profile-2-password',
      tls: { ca: pki.ca.cert },
      ...FAST,
      only: ['ws.basic-auth', 'tls.client-certificate'],
    });
    expect(statuses(report)).toEqual({
      'ws.basic-auth': 'pass',
      'tls.client-certificate': 'skip',
    });
  });

  it('fail tls.client-certificate when a Central System accepts connections without one', async () => {
    const tls = { cert: pki.server.cert, key: pki.server.key, ca: pki.ca.cert };
    const run = async (csms: FixtureCsms) => {
      const url = await csms.listen();
      cleanups.push(() => csms.close());
      return runConformance(ocpp16Conformance, {
        url,
        identity: 'CP-FIXTURE',
        tls: { ca: pki.ca.cert, ...pki.client('CP-FIXTURE') },
        ...FAST,
        only: ['tls.client-certificate'],
      });
    };
    expect(statuses(await run(new FixtureCsms({ tls })))).toEqual({
      'tls.client-certificate': 'pass',
    });
    const broken = await run(new FixtureCsms({ tls, breakages: ['accept-without-certificate'] }));
    expect(broken.results[0]).toMatchObject({
      status: 'fail',
      message: 'accepted a connection without a client certificate or password',
    });
  });
});
