import { X509Certificate } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CentralSystem,
  ChargePoint,
  HandshakeError,
  parseSubjectAltNames,
  SimulatedCharger,
  type CentralSystemOptions,
  type ChargePointOptions,
} from '../../src/index.js';
import { nextEvent, NOW, until } from '../helpers.js';
import { createTestPki, opensslAvailable, type TestPki } from './pki.js';

if (!opensslAvailable) {
  process.stderr.write('Skipping the TLS tests: the openssl CLI was not found on PATH.\n');
}
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

async function tlsServer(options: Omit<CentralSystemOptions, 'tls'> & { ca?: boolean } = {}) {
  const { ca, ...rest } = options;
  const cs = new CentralSystem({
    ...rest,
    tls: { cert: pki.server.cert, key: pki.server.key, ...(ca ? { ca: pki.ca.cert } : {}) },
  });
  cs.handle('BootNotification', () => ({ status: 'Accepted', currentTime: NOW, interval: 60 }));
  const { port } = await cs.listen(0, '127.0.0.1');
  cleanups.push(() => cs.close({ timeoutMs: 500 }));
  return { cs, url: `wss://127.0.0.1:${port}` };
}

function client(url: string, identity: string, extra: Partial<ChargePointOptions> = {}) {
  const cp = new ChargePoint({ identity, url, reconnect: false, ...extra });
  cleanups.push(() => cp.close());
  return cp;
}

describeTls('Security Profile 2: TLS with Basic auth', () => {
  it('serves wss:// and checks the Basic auth password over TLS', async () => {
    const { cs, url } = await tlsServer({
      authenticate: ({ identity, password }) =>
        identity === 'CP-001' && password === 'hunter2hunter2',
    });
    const cp = client(url, 'CP-001', { password: 'hunter2hunter2', tls: { ca: pki.ca.cert } });
    await cp.connect();
    await expect(
      cp.call('BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' }),
    ).resolves.toMatchObject({ status: 'Accepted' });
    expect(cs.connections.has('CP-001')).toBe(true);

    const wrong = client(url, 'CP-001', { password: 'guess', tls: { ca: pki.ca.cert } });
    await expect(wrong.connect()).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refuses a Central System whose certificate the charge point does not trust', async () => {
    const { url } = await tlsServer();
    const cp = client(url, 'CP-001'); // system trust store only
    const error = await cp.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HandshakeError);
    expect((error as Error).message).toMatch(/certificate/i);
  });

  it('can pin the server certificate by its SHA-256 fingerprint', async () => {
    const { url } = await tlsServer();
    const fingerprint = new X509Certificate(pki.server.cert).fingerprint256;
    const pinned = client(url, 'CP-001', {
      tls: { ca: pki.ca.cert, pinnedFingerprints: [fingerprint.toLowerCase()] },
    });
    await pinned.connect();
    const other = client(url, 'CP-002', {
      tls: { ca: pki.ca.cert, pinnedFingerprints: ['AA:BB:CC'] },
    });
    await expect(other.connect()).rejects.toThrow(/matches no pinned fingerprint/);
  });

  it('runs a simulated charger over wss://', async () => {
    const { cs, url } = await tlsServer();
    cs.handle('StatusNotification', () => ({}));
    const charger = new SimulatedCharger({
      identity: 'SIM-TLS',
      url,
      connectors: 1,
      client: { reconnect: false, tls: { ca: pki.ca.cert } },
    });
    cleanups.push(() => charger.stop());
    await charger.start();
    await until(() => charger.isRegistered);
  });
});

describeTls('Security Profile 3: TLS with client certificates', () => {
  it('accepts a charge point whose certificate CN is its identity', async () => {
    let seen: PeerCertificate | undefined;
    const { cs, url } = await tlsServer({
      ca: true,
      clientCertificates: {},
      authenticate: ({ certificate }) => {
        seen = certificate;
        return true;
      },
    });
    const { cert, key } = pki.client('CP-001');
    await client(url, 'CP-001', { tls: { ca: pki.ca.cert, cert, key } }).connect();
    expect(cs.connections.has('CP-001')).toBe(true);
    expect(seen?.subject.CN).toBe('CP-001');
  });

  it('refuses a certificate issued for another identity', async () => {
    const { cs, url } = await tlsServer({ ca: true, clientCertificates: {} });
    const rejected = nextEvent(cs, 'rejected');
    const { cert, key } = pki.client('CP-001');
    const impostor = client(url, 'CP-002', { tls: { ca: pki.ca.cert, cert, key } });
    await expect(impostor.connect()).rejects.toMatchObject({ statusCode: 403 });
    expect((await rejected)[0]).toMatchObject({
      reason: 'certificate',
      identity: 'CP-002',
      detail: 'client certificate does not belong to this identity',
    });
  });

  it('refuses a missing certificate unless client certificates are optional', async () => {
    const { cs, url } = await tlsServer({ ca: true, clientCertificates: {} });
    const rejected = nextEvent(cs, 'rejected');
    await expect(
      client(url, 'CP-001', { tls: { ca: pki.ca.cert } }).connect(),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await rejected)[0]).toMatchObject({ detail: 'no client certificate' });

    // Profile 2 and 3 side by side: without a certificate, Basic auth decides.
    const mixed = await tlsServer({
      ca: true,
      clientCertificates: { required: false },
      authenticate: ({ password, certificate }) =>
        certificate !== undefined || password === 'pw-1234567890123',
    });
    await client(mixed.url, 'CP-BASIC', {
      password: 'pw-1234567890123',
      tls: { ca: pki.ca.cert },
    }).connect();
    await expect(
      client(mixed.url, 'CP-NONE', { tls: { ca: pki.ca.cert } }).connect(),
    ).rejects.toMatchObject({ statusCode: 401 });
    const { cert, key } = pki.client('CP-CERT');
    await client(mixed.url, 'CP-CERT', { tls: { ca: pki.ca.cert, cert, key } }).connect();
  });

  it('refuses certificates from a CA it does not trust', async () => {
    const { cs, url } = await tlsServer({ ca: true, clientCertificates: {} });
    const rejected = nextEvent(cs, 'rejected');
    const { cert, key } = pki.rogueClient('CP-001');
    await expect(
      client(url, 'CP-001', { tls: { ca: pki.ca.cert, cert, key } }).connect(),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await rejected)[0].detail).toMatch(/^untrusted client certificate/);
  });

  it('binds identities to subjectAltNames or a custom rule', async () => {
    const sanOnly = await tlsServer({ ca: true, clientCertificates: { identityBinding: 'san' } });
    const dns = pki.client('ignored-cn', 'DNS:cp-dns.chargers.example.com');
    await client(sanOnly.url, 'CP-DNS.chargers.example.com', {
      tls: { ca: pki.ca.cert, ...dns },
    }).connect();
    const cnOnly = pki.client('CP-CN');
    await expect(
      client(sanOnly.url, 'CP-CN', { tls: { ca: pki.ca.cert, ...cnOnly } }).connect(),
    ).rejects.toMatchObject({ statusCode: 403 });

    const custom = await tlsServer({
      ca: true,
      clientCertificates: {
        identityBinding: (identity, certificate) =>
          parseSubjectAltNames(certificate.subjectaltname).some(
            ({ type, value }) => type === 'URI' && value === `urn:example:cp:${identity}`,
          ),
      },
    });
    const urn = pki.client('whatever', 'URI:urn:example:cp:CP-777');
    await client(custom.url, 'CP-777', { tls: { ca: pki.ca.cert, ...urn } }).connect();
    await expect(
      client(custom.url, 'CP-778', { tls: { ca: pki.ca.cert, ...urn } }).connect(),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('can accept any trusted certificate for any identity', async () => {
    const { url } = await tlsServer({ ca: true, clientCertificates: { identityBinding: false } });
    const { cert, key } = pki.client('SHARED-FLEET-CERT');
    await client(url, 'CP-900', { tls: { ca: pki.ca.cert, cert, key } }).connect();
  });
});
