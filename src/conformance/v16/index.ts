import type { ConformanceSuite } from '../types.js';
import { OCPP16_CHECKS } from './checks.js';
import { OCPP16 } from './shared.js';
import { decliningChargePoint } from './responder.js';

export { OCPP16_CHECKS } from './checks.js';
export { decliningChargePoint } from './responder.js';

/** The OCPP 1.6-J Central System conformance checks. */
export const ocpp16Conformance: ConformanceSuite = {
  protocol: 'OCPP 1.6-J',
  subprotocol: OCPP16,
  checks: OCPP16_CHECKS,
  respond: decliningChargePoint,
};
