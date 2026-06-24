import type { PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { certificateMatchesIdentity, commonNames, parseSubjectAltNames } from '../../src/index.js';

const certificate = (subject: Record<string, unknown>, subjectaltname?: string) =>
  ({
    subject,
    ...(subjectaltname === undefined ? {} : { subjectaltname }),
  }) as unknown as PeerCertificate;

describe('parseSubjectAltNames', () => {
  it('splits Node subjectaltname strings into typed entries', () => {
    expect(
      parseSubjectAltNames('DNS:cp.example.com, URI:urn:ocpp:CP-1, IP Address:10.0.0.1'),
    ).toEqual([
      { type: 'DNS', value: 'cp.example.com' },
      { type: 'URI', value: 'urn:ocpp:CP-1' },
      { type: 'IP Address', value: '10.0.0.1' },
    ]);
    expect(parseSubjectAltNames(undefined)).toEqual([]);
    expect(parseSubjectAltNames('')).toEqual([]);
  });

  it('decodes the JSON-quoted values Node uses for unusual characters', () => {
    expect(parseSubjectAltNames('URI:"urn:x:a, b", DNS:after.example')).toEqual([
      { type: 'URI', value: 'urn:x:a, b' },
      { type: 'DNS', value: 'after.example' },
    ]);
    expect(parseSubjectAltNames('DNS:"quote\\"d"')).toEqual([{ type: 'DNS', value: 'quote"d' }]);
  });
});

describe('certificateMatchesIdentity', () => {
  it('matches the common name, DNS names case-insensitively and URIs exactly', () => {
    const cert = certificate({ CN: 'CP-1' }, 'DNS:Cp-2.Example.com, URI:urn:cp:3');
    expect(certificateMatchesIdentity('CP-1', cert, 'cn')).toBe(true);
    expect(certificateMatchesIdentity('cp-1', cert, 'cn')).toBe(false);
    expect(certificateMatchesIdentity('cp-2.example.com', cert, 'san')).toBe(true);
    expect(certificateMatchesIdentity('urn:cp:3', cert, 'san')).toBe(true);
    expect(certificateMatchesIdentity('URN:CP:3', cert, 'san')).toBe(false);
    expect(certificateMatchesIdentity('CP-1', cert, 'san')).toBe(false);
    expect(certificateMatchesIdentity('CP-1', cert, 'cn-or-san')).toBe(true);
    expect(certificateMatchesIdentity('urn:cp:3', cert, 'cn-or-san')).toBe(true);
    expect(certificateMatchesIdentity('CP-9', cert, () => true)).toBe(true);
  });

  it('handles subjects with several common names', () => {
    const cert = certificate({ CN: ['CP-A', 'CP-B'] });
    expect(commonNames(cert)).toEqual(['CP-A', 'CP-B']);
    expect(certificateMatchesIdentity('CP-B', cert, 'cn')).toBe(true);
    expect(commonNames(certificate({}))).toEqual([]);
  });
});
