/** Helpers shared by the OCPP 1.6-J checks: typed wrappers over the version-generic ones. */
import {
  OCPP16_PROTOCOL,
  type ChargePointAction,
  type ChargePointRequest,
  type ChargePointResponse,
} from '../../messages/index.js';
import { VERSION } from '../../version.js';
import {
  bootKey,
  bootWith,
  describe as describeExchange,
  registeredWith,
  sendCall,
  serviceProblemWith,
  type BootRecord as GenericBootRecord,
  type Exchange as GenericExchange,
  type SuiteKit,
} from '../common/exchange.js';
import type { ProbeConnection } from '../probe.js';
import type { CheckContext, CheckOutcome } from '../types.js';

export {
  clip,
  describeIssues,
  fail,
  grace,
  now,
  pass,
  rawErrorCode,
  receivedLine,
  sentLine,
  skip,
  sleep,
} from '../common/exchange.js';

/** The subprotocol of OCPP 1.6-J. */
export const OCPP16 = 'ocpp1.6';

/** The BootNotification the probe sends. */
export function bootRequest(): ChargePointRequest<'BootNotification'> {
  return {
    chargePointVendor: 'ocpp-kit',
    chargePointModel: 'conformance-probe',
    firmwareVersion: VERSION,
  };
}

/** What the version-generic checks need to know about OCPP 1.6-J. */
export const KIT16: SuiteKit = {
  protocol: OCPP16_PROTOCOL,
  key: 'v16',
  responseSuffix: '.conf',
  bootRequest,
};

/** What became of one request sent to the Central System. */
export type Exchange<A extends ChargePointAction> = GenericExchange<A, ChargePointResponse<A>>;

/** Send a typed request and classify the answer, validating CALLRESULTs against the schema. */
export function send<A extends ChargePointAction>(
  connection: ProbeConnection,
  action: A,
  payload: ChargePointRequest<A>,
  timeoutMs: number,
): Promise<Exchange<A>> {
  return sendCall(
    connection,
    OCPP16_PROTOCOL.fromChargePoint,
    action,
    payload,
    timeoutMs,
  ) as Promise<Exchange<A>>;
}

/** One-line description of an unsuccessful exchange. */
export function describe(exchange: Exchange<ChargePointAction>): string {
  return describeExchange(exchange, '.conf');
}

/** A failed outcome describing an unsuccessful exchange. */
export function failed(exchange: Exchange<ChargePointAction>, prefix = ''): CheckOutcome {
  return { status: 'fail', message: `${prefix}${describe(exchange)}`, details: exchange.evidence };
}

/** State key of the answer to the first BootNotification (see {@link BootRecord}). */
export const BOOT = bootKey(KIT16);

/** The first BootNotification answer, kept for the checks that inspect it. */
export type BootRecord = GenericBootRecord<ChargePointResponse<'BootNotification'>>;

/**
 * Send BootNotification on `connection`. An `Accepted` answer registers the connection; any other
 * outcome is remembered, so later checks report it instead of booting again.
 */
export function boot(
  connection: ProbeConnection,
  context: CheckContext,
): Promise<Exchange<'BootNotification'>> {
  return bootWith(KIT16, connection, context) as Promise<Exchange<'BootNotification'>>;
}

/**
 * The shared connection, registered with an accepted BootNotification (sent once per connection).
 * Throws when the Central System does not accept the probe, which makes the check an `error`.
 */
export function registered(context: CheckContext): Promise<ProbeConnection> {
  return registeredWith(KIT16, context);
}

/**
 * Whether the Central System still serves `connection`: `undefined` when a Heartbeat is answered
 * (with a valid Heartbeat.conf, or with any answer when `anyAnswer` is set), otherwise what went
 * wrong.
 */
export function serviceProblem(
  connection: ProbeConnection,
  context: CheckContext,
  anyAnswer = false,
): Promise<{ readonly problem: string; readonly evidence: readonly string[] } | undefined> {
  return serviceProblemWith(KIT16, connection, context, anyAnswer);
}
