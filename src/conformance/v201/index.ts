import type { ConformanceSuite } from '../types.js';
import { OCPP201_CHECKS } from './checks.js';
import { decliningChargingStation } from './responder.js';
import { OCPP201 } from './shared.js';

export { OCPP201_CHECKS } from './checks.js';
export { decliningChargingStation } from './responder.js';

/** The OCPP 2.0.1 CSMS conformance checks. */
export const ocpp201Conformance: ConformanceSuite = {
  protocol: 'OCPP 2.0.1',
  subprotocol: OCPP201,
  checks: OCPP201_CHECKS,
  respond: decliningChargingStation,
  idTagMaxLength: 36,
};
