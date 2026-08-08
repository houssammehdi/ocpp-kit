import type { CsmsAction, CsmsResponse } from '../../messages/index.js';
import type { JsonObject } from '../../rpc/frames.js';
import type { ProbeResponder } from '../probe.js';

type Answers = {
  readonly [A in CsmsAction]: (request: JsonObject) => CsmsResponse<A>;
};

const unknownComponents = (request: JsonObject): CsmsResponse<'GetVariables'> => ({
  getVariableResult: (
    (request.getVariableData as CsmsResponse<'GetVariables'>['getVariableResult'] | undefined) ?? []
  ).map(({ component, variable }) => ({
    attributeStatus: 'UnknownComponent' as const,
    component,
    variable,
  })),
});

/** Valid, side-effect free answers: the probe accepts nothing that would change its state. */
const ANSWERS: Answers = {
  CancelReservation: () => ({ status: 'Rejected' }),
  ChangeAvailability: () => ({ status: 'Rejected' }),
  ClearCache: () => ({ status: 'Rejected' }),
  ClearChargingProfile: () => ({ status: 'Unknown' }),
  DataTransfer: () => ({ status: 'UnknownVendorId' }),
  GetBaseReport: () => ({ status: 'NotSupported' }),
  GetChargingProfiles: () => ({ status: 'NoProfiles' }),
  GetCompositeSchedule: () => ({ status: 'Rejected' }),
  GetLocalListVersion: () => ({ versionNumber: 0 }),
  GetLog: () => ({ status: 'Rejected' }),
  GetReport: () => ({ status: 'NotSupported' }),
  GetTransactionStatus: () => ({ messagesInQueue: false }),
  GetVariables: unknownComponents,
  RequestStartTransaction: () => ({ status: 'Rejected' }),
  RequestStopTransaction: () => ({ status: 'Rejected' }),
  ReserveNow: () => ({ status: 'Rejected' }),
  Reset: () => ({ status: 'Rejected' }),
  SendLocalList: () => ({ status: 'Failed' }),
  SetChargingProfile: () => ({ status: 'Rejected' }),
  SetNetworkProfile: () => ({ status: 'Rejected' }),
  SetVariables: (request) => ({
    setVariableResult: (
      (request.setVariableData as CsmsResponse<'SetVariables'>['setVariableResult'] | undefined) ??
      []
    ).map(({ component, variable }) => ({
      attributeStatus: 'UnknownComponent' as const,
      component,
      variable,
    })),
  }),
  TriggerMessage: () => ({ status: 'Rejected' }),
  UnlockConnector: () => ({ status: 'UnknownConnector' }),
  UpdateFirmware: () => ({ status: 'Rejected' }),
};

/**
 * How the conformance probe answers CSMS CALLs on an OCPP 2.0.1 connection: like a charging
 * station that declines every request with a valid answer (`Rejected`, `NotSupported`, unknown
 * components, no profiles, ...), so a run never changes anything, and answers unknown actions
 * with a `NotImplemented` CALLERROR.
 */
export const decliningChargingStation: ProbeResponder = (call) => {
  if (!Object.hasOwn(ANSWERS, call.action)) {
    return { error: 'NotImplemented', description: `Unknown action ${call.action}` };
  }
  const answer = ANSWERS[call.action as CsmsAction];
  return { payload: answer(call.payload) };
};
