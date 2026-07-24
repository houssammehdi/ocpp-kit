export * from './v16/index.js';
/**
 * The OCPP 2.0.1 schemas and types, e.g. `v201.TransactionEventRequest`. Their names overlap
 * with the OCPP 1.6 ones exported at the top level, hence the namespace.
 */
export * as v201 from './v201/index.js';
export {
  ACTION_BLOCKS,
  ChargingStationToCsms,
  CsmsToChargingStation,
  FUNCTIONAL_BLOCKS,
  OCPP201_PROTOCOL,
  UNSUPPORTED_ACTIONS_201,
  type Action201,
  type CsmsAction,
  type CsmsRequest,
  type CsmsResponse,
  type FunctionalBlock,
  type StationAction,
  type StationRequest,
  type StationResponse,
} from './v201/catalogue.js';
