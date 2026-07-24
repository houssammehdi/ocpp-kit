/** A realistic, valid example of every OCPP 2.0.1 request and response in the catalogue. */
import type {
  v201,
  CsmsAction,
  CsmsRequest,
  CsmsResponse,
  StationAction,
  StationRequest,
  StationResponse,
} from '../../src/index.js';

const T = '2026-09-26T10:00:00.000Z';
const idToken = { idToken: '04A2B3C4D5E6F7', type: 'ISO14443' } as const;
const component = { name: 'OCPPCommCtrlr' };
const variable = { name: 'HeartbeatInterval' };
const profile: v201.ChargingProfile = {
  id: 7,
  stackLevel: 1,
  chargingProfilePurpose: 'TxDefaultProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: [
    {
      id: 1,
      startSchedule: T,
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [
        { startPeriod: 0, limit: 11_000, numberPhases: 3 },
        { startPeriod: 3_600, limit: 7_400 },
      ],
    },
  ],
};

type StationExamples = {
  readonly [A in StationAction]: {
    readonly request: StationRequest<A>;
    readonly response: StationResponse<A>;
  };
};
type CsmsExamples = {
  readonly [A in CsmsAction]: {
    readonly request: CsmsRequest<A>;
    readonly response: CsmsResponse<A>;
  };
};

export const STATION_EXAMPLES: StationExamples = {
  BootNotification: {
    request: {
      chargingStation: {
        model: 'Wallbox 22',
        vendorName: 'Acme',
        serialNumber: 'SN-0001',
        firmwareVersion: '1.2.3',
        modem: { iccid: '8947000000000000001', imsi: '242010000000001' },
      },
      reason: 'PowerUp',
    },
    response: { currentTime: T, interval: 300, status: 'Accepted' },
  },
  NotifyReport: {
    request: {
      requestId: 1,
      generatedAt: T,
      seqNo: 0,
      tbc: false,
      reportData: [
        {
          component,
          variable,
          variableAttribute: [{ type: 'Actual', value: '300', mutability: 'ReadWrite' }],
          variableCharacteristics: { dataType: 'integer', unit: 's', supportsMonitoring: false },
        },
      ],
    },
    response: {},
  },
  Authorize: {
    request: { idToken },
    response: { idTokenInfo: { status: 'Accepted', cacheExpiryDateTime: T } },
  },
  TransactionEvent: {
    request: {
      eventType: 'Started',
      timestamp: T,
      triggerReason: 'CablePluggedIn',
      seqNo: 0,
      transactionInfo: { transactionId: 'f0b1c2d3-0001', chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      meterValue: [
        {
          timestamp: T,
          sampledValue: [
            {
              value: 1234.5,
              context: 'Transaction.Begin',
              measurand: 'Energy.Active.Import.Register',
              unitOfMeasure: { unit: 'Wh' },
            },
          ],
        },
      ],
    },
    response: { idTokenInfo: { status: 'Accepted' }, totalCost: 0 },
  },
  Heartbeat: { request: {}, response: { currentTime: T } },
  StatusNotification: {
    request: { timestamp: T, connectorStatus: 'Available', evseId: 1, connectorId: 1 },
    response: {},
  },
  ReservationStatusUpdate: {
    request: { reservationId: 3, reservationUpdateStatus: 'Expired' },
    response: {},
  },
  MeterValues: {
    request: {
      evseId: 0,
      meterValue: [
        {
          timestamp: T,
          sampledValue: [{ value: 52_000, context: 'Sample.Clock', location: 'Outlet' }],
        },
      ],
    },
    response: {},
  },
  ReportChargingProfiles: {
    request: {
      requestId: 4,
      chargingLimitSource: 'CSO',
      evseId: 0,
      chargingProfile: [profile],
    },
    response: {},
  },
  NotifyChargingLimit: {
    request: { chargingLimit: { chargingLimitSource: 'EMS', isGridCritical: false }, evseId: 1 },
    response: {},
  },
  ClearedChargingLimit: { request: { chargingLimitSource: 'EMS', evseId: 1 }, response: {} },
  NotifyEVChargingNeeds: {
    request: {
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_three_phase',
        acChargingParameters: {
          energyAmount: 30_000,
          evMinCurrent: 6,
          evMaxCurrent: 32,
          evMaxVoltage: 400,
        },
      },
    },
    response: { status: 'Accepted' },
  },
  FirmwareStatusNotification: { request: { status: 'Downloading', requestId: 5 }, response: {} },
  LogStatusNotification: { request: { status: 'Uploaded', requestId: 6 }, response: {} },
  NotifyEvent: {
    request: {
      generatedAt: T,
      seqNo: 0,
      eventData: [
        {
          eventId: 1,
          timestamp: T,
          trigger: 'Delta',
          actualValue: 'Faulted',
          component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
          variable: { name: 'AvailabilityState' },
          eventNotificationType: 'HardWiredNotification',
        },
      ],
    },
    response: {},
  },
  SecurityEventNotification: {
    request: { type: 'StartupOfTheDevice', timestamp: T, techInfo: 'cold boot' },
    response: {},
  },
  DataTransfer: {
    request: { vendorId: 'com.example', messageId: 'ping', data: { nested: [1, 2, 3] } },
    response: { status: 'UnknownVendorId' },
  },
};

export const CSMS_EXAMPLES: CsmsExamples = {
  GetVariables: {
    request: { getVariableData: [{ component, variable, attributeType: 'Actual' }] },
    response: {
      getVariableResult: [
        {
          attributeStatus: 'Accepted',
          attributeType: 'Actual',
          attributeValue: '300',
          component,
          variable,
        },
      ],
    },
  },
  SetVariables: {
    request: { setVariableData: [{ component, variable, attributeValue: '120' }] },
    response: { setVariableResult: [{ attributeStatus: 'Accepted', component, variable }] },
  },
  GetBaseReport: {
    request: { requestId: 1, reportBase: 'FullInventory' },
    response: { status: 'Accepted' },
  },
  GetReport: {
    request: {
      requestId: 2,
      componentVariable: [{ component: { name: 'TxCtrlr' } }],
      componentCriteria: ['Enabled'],
    },
    response: { status: 'EmptyResultSet' },
  },
  Reset: { request: { type: 'OnIdle' }, response: { status: 'Scheduled' } },
  SetNetworkProfile: {
    request: {
      configurationSlot: 1,
      connectionData: {
        ocppVersion: 'OCPP20',
        ocppTransport: 'JSON',
        ocppCsmsUrl: 'wss://csms.example.com/ocpp',
        messageTimeout: 30,
        securityProfile: 2,
        ocppInterface: 'Wired0',
      },
    },
    response: { status: 'Accepted' },
  },
  ClearCache: { request: {}, response: { status: 'Accepted' } },
  GetLocalListVersion: { request: {}, response: { versionNumber: 3 } },
  SendLocalList: {
    request: {
      versionNumber: 4,
      updateType: 'Differential',
      localAuthorizationList: [{ idToken, idTokenInfo: { status: 'Blocked' } }],
    },
    response: { status: 'Accepted' },
  },
  GetTransactionStatus: {
    request: { transactionId: 'f0b1c2d3-0001' },
    response: { ongoingIndicator: true, messagesInQueue: false },
  },
  RequestStartTransaction: {
    request: { idToken, remoteStartId: 42, evseId: 1 },
    response: { status: 'Accepted' },
  },
  RequestStopTransaction: {
    request: { transactionId: 'f0b1c2d3-0001' },
    response: { status: 'Rejected', statusInfo: { reasonCode: 'TxNotFound' } },
  },
  TriggerMessage: {
    request: { requestedMessage: 'StatusNotification', evse: { id: 1, connectorId: 1 } },
    response: { status: 'Accepted' },
  },
  UnlockConnector: {
    request: { evseId: 1, connectorId: 1 },
    response: { status: 'OngoingAuthorizedTransaction' },
  },
  ChangeAvailability: {
    request: { operationalStatus: 'Inoperative', evse: { id: 2 } },
    response: { status: 'Scheduled' },
  },
  ReserveNow: {
    request: { id: 3, expiryDateTime: T, idToken, evseId: 1, connectorType: 'cType2' },
    response: { status: 'Accepted' },
  },
  CancelReservation: { request: { reservationId: 3 }, response: { status: 'Rejected' } },
  SetChargingProfile: {
    request: { evseId: 0, chargingProfile: profile },
    response: { status: 'Accepted' },
  },
  GetChargingProfiles: {
    request: { requestId: 4, chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile' } },
    response: { status: 'NoProfiles' },
  },
  ClearChargingProfile: {
    request: { chargingProfileCriteria: { evseId: 0, chargingProfilePurpose: 'TxDefaultProfile' } },
    response: { status: 'Unknown' },
  },
  GetCompositeSchedule: {
    request: { duration: 3_600, evseId: 1, chargingRateUnit: 'A' },
    response: {
      status: 'Accepted',
      schedule: {
        evseId: 1,
        duration: 3_600,
        scheduleStart: T,
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
      },
    },
  },
  UpdateFirmware: {
    request: {
      requestId: 5,
      retries: 2,
      retryInterval: 30,
      firmware: { location: 'https://fw.example.com/acme-2.0.bin', retrieveDateTime: T },
    },
    response: { status: 'Accepted' },
  },
  GetLog: {
    request: {
      requestId: 6,
      logType: 'DiagnosticsLog',
      log: { remoteLocation: 'https://logs.example.com/upload', oldestTimestamp: T },
    },
    response: { status: 'Accepted', filename: 'CS-001-diagnostics.log' },
  },
  DataTransfer: {
    request: { vendorId: 'com.example', data: 'text is fine too' },
    response: { status: 'Accepted', data: 42 },
  },
};
