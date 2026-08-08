/** Helpers shared by the OCPP 2.0.1 checks: typed wrappers over the version-generic ones. */
import {
  OCPP201_PROTOCOL,
  type StationAction,
  type StationRequest,
  type StationResponse,
} from '../../messages/index.js';
import { VERSION } from '../../version.js';
import {
  bootKey,
  describe as describeExchange,
  registeredWith,
  sendCall,
  type BootRecord as GenericBootRecord,
  type Exchange as GenericExchange,
  type SuiteKit,
} from '../common/exchange.js';
import type { ProbeConnection } from '../probe.js';
import type { CheckContext, CheckOutcome } from '../types.js';

/** The subprotocol of OCPP 2.0.1. */
export const OCPP201 = 'ocpp2.0.1';

/** The BootNotificationRequest the probe sends. */
export function bootRequest(): StationRequest<'BootNotification'> {
  return {
    chargingStation: {
      vendorName: 'ocpp-kit',
      model: 'conformance-probe',
      firmwareVersion: VERSION,
    },
    reason: 'PowerUp',
  };
}

/** What the version-generic checks need to know about OCPP 2.0.1. */
export const KIT201: SuiteKit = {
  protocol: OCPP201_PROTOCOL,
  key: 'v201',
  responseSuffix: 'Response',
  bootRequest,
};

/** What became of one request sent to the CSMS. */
export type Exchange<A extends StationAction> = GenericExchange<A, StationResponse<A>>;

/** Send a typed request and classify the answer, validating CALLRESULTs against the schema. */
export function send<A extends StationAction>(
  connection: ProbeConnection,
  action: A,
  payload: StationRequest<A>,
  timeoutMs: number,
): Promise<Exchange<A>> {
  return sendCall(
    connection,
    OCPP201_PROTOCOL.fromChargePoint,
    action,
    payload,
    timeoutMs,
  ) as Promise<Exchange<A>>;
}

/** A failed outcome describing an unsuccessful exchange. */
export function failed(exchange: Exchange<StationAction>, prefix = ''): CheckOutcome {
  return {
    status: 'fail',
    message: `${prefix}${describeExchange(exchange, 'Response')}`,
    details: exchange.evidence,
  };
}

/** State key of the first BootNotificationResponse. */
export const BOOT = bootKey(KIT201);

/** The first BootNotificationResponse, kept for the checks that inspect it. */
export type BootRecord = GenericBootRecord<StationResponse<'BootNotification'>>;

/** The shared connection, registered with an accepted BootNotification. */
export function registered(context: CheckContext): Promise<ProbeConnection> {
  return registeredWith(KIT201, context);
}

/** The idToken of the probe's authorizations and transactions. */
export function probeToken(context: CheckContext): { idToken: string; type: 'Central' } {
  return { idToken: context.options.idTag, type: 'Central' };
}
