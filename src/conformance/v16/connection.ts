/** OCPP 1.6-J checks of the WebSocket connection: subprotocol, authentication, pings. */
import {
  basicAuthCheck,
  clientCertificateCheck,
  duplicateConnectionCheck,
  pingCheck,
  subprotocolCheck,
  subprotocolRefusalCheck,
} from '../common/connection-checks.js';
import { KIT16 } from './shared.js';

export const subprotocol = subprotocolCheck(KIT16, 'OCPP-J 1.6 §3.1.2');

export const subprotocolRefusal = subprotocolRefusalCheck('OCPP-J 1.6 §3.1.2; RFC 6455 §4.2.2');

export const basicAuth = basicAuthCheck(
  'OCPP 1.6 security whitepaper (Security Profiles 1 and 2); RFC 7617',
);

export const clientCertificate = clientCertificateCheck(
  'OCPP 1.6 security whitepaper (Security Profile 3)',
);

export const ping = pingCheck('RFC 6455 §5.5.2; OCPP-J 1.6 §5.3');

export const duplicateConnection = duplicateConnectionCheck(
  KIT16,
  'Robustness (OCPP 1.6 does not specify this)',
);
