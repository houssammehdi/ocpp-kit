import {
  FEATURE_PROFILES,
  ciKey,
  type CentralSystemAction,
  type CentralSystemResponse,
} from '../../messages/index.js';
import type { JsonObject } from '../../rpc/frames.js';
import type { ProbeResponder } from '../probe.js';

/** Read-only configuration the probe reports through GetConfiguration. */
const CONFIGURATION: Readonly<Record<string, string>> = {
  NumberOfConnectors: '2',
  SupportedFeatureProfiles: FEATURE_PROFILES.join(','),
};

function getConfiguration(request: JsonObject): CentralSystemResponse<'GetConfiguration'> {
  const known = new Map(
    Object.entries(CONFIGURATION).map(([key, value]) => [ciKey(key), { key, value }]),
  );
  // No key list (or an empty one) asks for every key.
  const requested =
    Array.isArray(request.key) && request.key.length > 0
      ? request.key.filter((key): key is string => typeof key === 'string' && key.length <= 50)
      : undefined;
  if (requested === undefined) {
    return {
      configurationKey: [...known.values()].map((entry) => ({ ...entry, readonly: true })),
    };
  }
  const found = requested.flatMap((key) => {
    const entry = known.get(ciKey(key));
    return entry ? [{ ...entry, readonly: true }] : [];
  });
  const unknownKey = requested.filter((key) => !known.has(ciKey(key)));
  return {
    ...(found.length > 0 ? { configurationKey: found } : {}),
    ...(unknownKey.length > 0 ? { unknownKey } : {}),
  };
}

type Answers = {
  readonly [A in CentralSystemAction]: (request: JsonObject) => CentralSystemResponse<A>;
};

/** Valid, side-effect free answers: the probe accepts nothing that would change its state. */
const ANSWERS: Answers = {
  CancelReservation: () => ({ status: 'Rejected' }),
  ChangeAvailability: () => ({ status: 'Rejected' }),
  ChangeConfiguration: () => ({ status: 'Rejected' }),
  ClearCache: () => ({ status: 'Rejected' }),
  ClearChargingProfile: () => ({ status: 'Unknown' }),
  DataTransfer: () => ({ status: 'UnknownVendorId' }),
  GetCompositeSchedule: () => ({ status: 'Rejected' }),
  GetConfiguration: getConfiguration,
  GetDiagnostics: () => ({}),
  GetLocalListVersion: () => ({ listVersion: -1 }),
  RemoteStartTransaction: () => ({ status: 'Rejected' }),
  RemoteStopTransaction: () => ({ status: 'Rejected' }),
  ReserveNow: () => ({ status: 'Rejected' }),
  Reset: () => ({ status: 'Rejected' }),
  SendLocalList: () => ({ status: 'NotSupported' }),
  SetChargingProfile: () => ({ status: 'NotSupported' }),
  TriggerMessage: () => ({ status: 'NotImplemented' }),
  UnlockConnector: () => ({ status: 'NotSupported' }),
  UpdateFirmware: () => ({}),
};

/**
 * How the conformance probe answers Central System CALLs: like a two-connector charge point
 * that declines every request with a valid answer (`Rejected`, `NotSupported`, no local list, no
 * diagnostics, ...), so a run never changes anything, and answers unknown actions with a
 * `NotImplemented` CALLERROR.
 */
export const decliningChargePoint: ProbeResponder = (call) => {
  if (!Object.hasOwn(ANSWERS, call.action)) {
    return { error: 'NotImplemented', description: `Unknown action ${call.action}` };
  }
  const answer = ANSWERS[call.action as CentralSystemAction];
  return { payload: answer(call.payload) };
};
