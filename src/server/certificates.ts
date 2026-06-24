import type { PeerCertificate } from 'node:tls';

/**
 * How a charge point's identity must relate to its TLS client certificate (Security Profile 3):
 *
 * - `'cn'`: the subject common name equals the identity;
 * - `'san'`: a `DNS` or `URI` subjectAltName equals the identity (DNS names compare
 *   case-insensitively);
 * - `'cn-or-san'`: either of the two;
 * - a function deciding for itself, e.g. to accept `urn:example:<identity>` URIs.
 *
 * The OCPP 1.6 security whitepaper has charge point certificates carry the charge point's serial
 * number in the subject common name; deployments that put the identity elsewhere can choose
 * another rule.
 */
export type CertificateIdentityBinding =
  'cn' | 'san' | 'cn-or-san' | ((identity: string, certificate: PeerCertificate) => boolean);

/** A subjectAltName entry, e.g. `{ type: 'DNS', value: 'cp-001.example.com' }`. */
export interface SubjectAltName {
  readonly type: string;
  readonly value: string;
}

/**
 * Parse Node's `subjectaltname` string (`DNS:a.example, URI:urn:x, IP Address:10.0.0.1`).
 * Node quotes values containing separators or quotes as JSON strings, which is handled.
 */
export function parseSubjectAltNames(text: string | undefined): SubjectAltName[] {
  if (!text) return [];
  const entries: SubjectAltName[] = [];
  let index = 0;
  while (index < text.length) {
    const colon = text.indexOf(':', index);
    if (colon < 0) break;
    const type = text.slice(index, colon).trim();
    let cursor = colon + 1;
    let value: string;
    if (text[cursor] === '"') {
      // A JSON string: find its closing quote, honouring escapes.
      let end = cursor + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      try {
        value = JSON.parse(text.slice(cursor, end + 1)) as string;
      } catch {
        value = text.slice(cursor + 1, end);
      }
      cursor = end + 1;
    } else {
      const separator = text.indexOf(', ', cursor);
      const end = separator < 0 ? text.length : separator;
      value = text.slice(cursor, end);
      cursor = end;
    }
    entries.push({ type, value });
    const next = text.indexOf(', ', cursor);
    if (next < 0) break;
    index = next + 2;
  }
  return entries;
}

/** Subject common names of a certificate (a subject may carry several). */
export function commonNames(certificate: PeerCertificate): string[] {
  const cn: unknown = (certificate.subject as Record<string, unknown> | undefined)?.CN;
  if (typeof cn === 'string') return [cn];
  if (Array.isArray(cn)) return cn.filter((value): value is string => typeof value === 'string');
  return [];
}

/** Whether `certificate` belongs to the charge point `identity` under `binding`. */
export function certificateMatchesIdentity(
  identity: string,
  certificate: PeerCertificate,
  binding: CertificateIdentityBinding,
): boolean {
  if (typeof binding === 'function') return binding(identity, certificate);
  const byCommonName = (): boolean => commonNames(certificate).includes(identity);
  const byAltName = (): boolean =>
    parseSubjectAltNames(certificate.subjectaltname).some(({ type, value }) =>
      type === 'DNS'
        ? value.toLowerCase() === identity.toLowerCase()
        : type === 'URI' && value === identity,
    );
  switch (binding) {
    case 'cn':
      return byCommonName();
    case 'san':
      return byAltName();
    case 'cn-or-san':
      return byCommonName() || byAltName();
  }
}
