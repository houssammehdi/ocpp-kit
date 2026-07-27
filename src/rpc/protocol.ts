import type { ErrorCodeSet } from './errors.js';
import type { ActionSchemaMap } from './validation.js';

/**
 * Everything the version-generic layers (RPC, server, client, conformance runner) need to know
 * about one OCPP version: its subprotocol, its error codes and its two action catalogues.
 *
 * The catalogues are named after the roles of OCPP 1.6 because the classes are
 * (`CentralSystem`, `ChargePoint`); OCPP 2.0.1 calls them CSMS and Charging Station.
 *
 * @typeParam V - version, e.g. `'1.6'`
 * @typeParam Up - actions the charge point sends
 * @typeParam Down - actions the central system sends
 * @typeParam T - the transaction-related actions
 */
export interface OcppProtocol<
  V extends string = string,
  Up extends ActionSchemaMap = ActionSchemaMap,
  Down extends ActionSchemaMap = ActionSchemaMap,
  T extends keyof Up & string = keyof Up & string,
> {
  /** Version number, e.g. `'1.6'` or `'2.0.1'`. */
  readonly version: V;
  /** Human-readable name, e.g. `'OCPP 1.6-J'`. */
  readonly name: string;
  /** WebSocket subprotocol, e.g. `'ocpp1.6'`. */
  readonly subprotocol: string;
  /** CALLERROR codes of this version. */
  readonly errorCodes: ErrorCodeSet;
  /** Actions initiated by the charge point (Charging Station). */
  readonly fromChargePoint: Up;
  /** Actions initiated by the central system (CSMS). */
  readonly fromCentralSystem: Down;
  /**
   * Charge point actions that must reach the central system reliably and in order, even across
   * connection loss (the "transaction-related messages").
   */
  readonly transactionActions: readonly T[];
}
