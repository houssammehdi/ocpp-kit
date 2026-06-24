import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Whether the `openssl` CLI is on PATH (it is on GitHub's Ubuntu runners). */
export const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

/** A PEM certificate and its private key. */
export interface KeyPair {
  readonly cert: string;
  readonly key: string;
}

/** A throwaway PKI for one test file, generated with openssl in a temporary directory. */
export interface TestPki {
  /** The CA that issues the server and the trusted client certificates. */
  readonly ca: KeyPair;
  /** Server certificate for 127.0.0.1 and localhost. */
  readonly server: KeyPair;
  /** Issue a client certificate from the test CA. */
  client(commonName: string, subjectAltName?: string): KeyPair;
  /** Issue a client certificate from a second CA that nobody trusts. */
  rogueClient(commonName: string): KeyPair;
  /** Delete the temporary directory. */
  dispose(): void;
}

function openssl(dir: string, args: readonly string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

function createCa(dir: string, name: string, commonName: string): KeyPair & { name: string } {
  openssl(dir, [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.crt`,
    '-days',
    '2',
    '-subj',
    `/CN=${commonName}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  return {
    name,
    cert: readFileSync(join(dir, `${name}.crt`), 'utf8'),
    key: readFileSync(join(dir, `${name}.key`), 'utf8'),
  };
}

function issue(
  dir: string,
  ca: { name: string },
  name: string,
  commonName: string,
  extensions: readonly string[],
): KeyPair {
  openssl(dir, [
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    `/CN=${commonName}`,
  ]);
  writeFileSync(join(dir, `${name}.ext`), `${extensions.join('\n')}\n`);
  openssl(dir, [
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    `${ca.name}.crt`,
    '-CAkey',
    `${ca.name}.key`,
    '-set_serial',
    `0x${randomBytes(8).toString('hex')}`,
    '-days',
    '2',
    '-extfile',
    `${name}.ext`,
    '-out',
    `${name}.crt`,
  ]);
  return {
    cert: readFileSync(join(dir, `${name}.crt`), 'utf8'),
    key: readFileSync(join(dir, `${name}.key`), 'utf8'),
  };
}

/** Generate a CA, a server certificate and a factory for client certificates. */
export function createTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 'ocpp-kit-pki-'));
  const ca = createCa(dir, 'ca', 'ocpp-kit test CA');
  const rogue = createCa(dir, 'rogue', 'untrusted test CA');
  const server = issue(dir, ca, 'server', 'localhost', [
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  let counter = 0;
  const clientExtensions = (subjectAltName?: string) => [
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature',
    'extendedKeyUsage=clientAuth',
    ...(subjectAltName === undefined ? [] : [`subjectAltName=${subjectAltName}`]),
  ];
  return {
    ca,
    server,
    client: (commonName, subjectAltName) =>
      issue(dir, ca, `client-${++counter}`, commonName, clientExtensions(subjectAltName)),
    rogueClient: (commonName) =>
      issue(dir, rogue, `rogue-${++counter}`, commonName, clientExtensions()),
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
