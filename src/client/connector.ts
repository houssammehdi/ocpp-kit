import {
  checkServerIdentity,
  type ConnectionOptions,
  type PeerCertificate,
  type SecureVersion,
} from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import type { Duplex } from '../rpc/duplex.js';
import { OcppKitError } from '../rpc/errors.js';
import { OCPP16_SUBPROTOCOL, webSocketDuplex } from '../transport/websocket.js';
import { timerDelay } from '../util/timers.js';

/** PEM material: one item or several (a chain, several CAs). */
type Pem = string | Buffer | readonly (string | Buffer)[];

/**
 * TLS settings of a charge point for `wss://` (Security Profiles 2 and 3).
 */
export interface ChargePointTlsOptions {
  /**
   * CAs to trust instead of the system store: only a server certificate issued by one of them is
   * accepted, which pins the Central System's CA.
   */
  readonly ca?: Pem;
  /** Client certificate, optionally followed by intermediates (Security Profile 3). */
  readonly cert?: Pem;
  /** Private key of the client certificate. */
  readonly key?: string | Buffer;
  /** Passphrase of an encrypted key. */
  readonly passphrase?: string;
  /**
   * SHA-256 fingerprints (`AB:CD:...`, case and separators do not matter) of which the server
   * certificate must be one, checked after normal chain and host name validation.
   */
  readonly pinnedFingerprints?: readonly string[];
  /** Name for SNI and host name verification. Default: the host of the URL. */
  readonly servername?: string;
  /** Oldest accepted TLS version. Default: `TLSv1.2`. */
  readonly minVersion?: SecureVersion;
  /** Verify the server certificate. Default: true; only turn it off in tests. */
  readonly rejectUnauthorized?: boolean;
}

function normaliseFingerprint(value: string): string {
  return value.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * Translate {@link ChargePointTlsOptions} into the options `ws` hands to `tls.connect()`. They are
 * typed with Node's `ConnectionOptions`: `@types/ws` declares `checkServerIdentity` as returning
 * a boolean, but ws passes it to Node unchanged, which expects an `Error` or `undefined`.
 */
export function tlsClientOptions(tls: ChargePointTlsOptions | undefined): ConnectionOptions {
  if (!tls) return {};
  const pins = tls.pinnedFingerprints?.map(normaliseFingerprint);
  return {
    ...(tls.ca === undefined ? {} : { ca: tls.ca as string | Buffer | (string | Buffer)[] }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert as string | Buffer | (string | Buffer)[] }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    ...(tls.passphrase === undefined ? {} : { passphrase: tls.passphrase }),
    ...(tls.servername === undefined ? {} : { servername: tls.servername }),
    ...(tls.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: tls.rejectUnauthorized }),
    minVersion: tls.minVersion ?? 'TLSv1.2',
    ...(pins && pins.length > 0
      ? {
          checkServerIdentity: (host: string, certificate: PeerCertificate): Error | undefined => {
            const error = checkServerIdentity(host, certificate);
            if (error) return error;
            if (!pins.includes(normaliseFingerprint(certificate.fingerprint256))) {
              return new Error(
                `Server certificate ${certificate.fingerprint256} matches no pinned fingerprint`,
              );
            }
            return undefined;
          },
        }
      : {}),
  };
}

/** Parameters for opening a connection to a Central System. */
export interface ConnectRequest {
  /** Full endpoint URL including the charge point identity. */
  readonly url: string;
  /** Offered subprotocols, in preference order. */
  readonly protocols: readonly string[];
  /** Extra HTTP headers for the handshake, e.g. `Authorization`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly handshakeTimeoutMs: number;
  /**
   * Keep-alive: send a WebSocket ping this often and drop the connection (code 1006) when the
   * previous ping was not answered. 0 or absent disables pings.
   */
  readonly pingIntervalMs?: number;
  /** TLS settings for `wss://` URLs. */
  readonly tls?: ChargePointTlsOptions;
}

/**
 * Opens a transport to the Central System. The default implementation uses `ws`; tests inject
 * in-memory duplexes to exercise reconnect and replay logic without sockets.
 */
export type Connector = (request: ConnectRequest) => Promise<Duplex>;

/** The WebSocket handshake failed (HTTP error status, wrong subprotocol, network error). */
export class HandshakeError extends OcppKitError {
  constructor(
    message: string,
    /** HTTP status of the refused handshake, when there was one. */
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

/** Ping `ws` every `intervalMs`; terminate it when a ping is still unanswered at the next one. */
function keepAlive(ws: WebSocket, intervalMs: number): void {
  if (!(intervalMs > 0)) return;
  let answered = true;
  ws.on('pong', () => {
    answered = true;
  });
  const timer = setInterval(() => {
    if (!answered) {
      ws.terminate();
      return;
    }
    answered = false;
    ws.ping();
  }, timerDelay(intervalMs));
  ws.once('close', () => {
    clearInterval(timer);
  });
}

/** Default {@link Connector} based on the `ws` package. */
export const webSocketConnector: Connector = (request) =>
  new Promise<Duplex>((resolve, reject) => {
    const options = {
      ...tlsClientOptions(request.tls),
      headers: { ...request.headers },
      handshakeTimeout: timerDelay(request.handshakeTimeoutMs),
    } as ClientOptions;
    const ws = new WebSocket(request.url, [...request.protocols], options);
    let settled = false;
    const fail = (error: HandshakeError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    ws.on('error', (error) => {
      fail(new HandshakeError(error.message));
    });
    ws.once('unexpected-response', (req, res) => {
      fail(new HandshakeError(`Handshake refused with HTTP ${res.statusCode}`, res.statusCode));
      res.resume();
      req.destroy();
    });
    ws.once('close', (code) => {
      fail(new HandshakeError(`Connection closed during handshake (${code})`));
    });
    ws.once('open', () => {
      if (ws.protocol !== OCPP16_SUBPROTOCOL) {
        ws.terminate();
        fail(new HandshakeError(`Server did not accept subprotocol ${OCPP16_SUBPROTOCOL}`));
        return;
      }
      settled = true;
      keepAlive(ws, request.pingIntervalMs ?? 0);
      resolve(webSocketDuplex(ws));
    });
  });
