import type { IncomingMessage } from 'node:http';
import type { PeerCertificate } from 'node:tls';

/** Credentials extracted from an HTTP `Authorization: Basic ...` header. */
export interface BasicCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Parse an HTTP Basic `Authorization` header value.
 *
 * @returns the credentials, or `undefined` when the header is absent or malformed.
 */
export function parseBasicAuth(header: string | undefined): BasicCredentials | undefined {
  if (!header) return undefined;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return undefined;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Build an HTTP Basic `Authorization` header value. */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** Information handed to an {@link Authenticator} during the WebSocket handshake. */
export interface AuthenticationRequest {
  /** Charge point identity taken from the URL path. */
  readonly identity: string;
  /**
   * Password from HTTP Basic auth (OCPP Security Profile 1: the username must equal the
   * identity). `undefined` when no valid Basic credentials for this identity were sent.
   */
  readonly password: string | undefined;
  /** The raw upgrade request, e.g. to inspect the remote address or headers. */
  readonly request: IncomingMessage;
  /**
   * The charge point's TLS client certificate, when `clientCertificates` is configured and the
   * certificate was verified (trusted and matching the identity).
   */
  readonly certificate?: PeerCertificate;
}

/** Decide whether a charge point may connect. Throwing counts as a rejection. */
export type Authenticator = (request: AuthenticationRequest) => boolean | Promise<boolean>;
