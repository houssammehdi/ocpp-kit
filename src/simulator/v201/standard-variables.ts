/**
 * The standard components and variables of OCPP 2.0.1 (Part 2, "Referenced Components and
 * Variables") that the simulated charging station implements, with the values it starts with.
 */
import type { AttributeDefinition, VariableDefinition, VariableRef } from './device-model.js';

/** Measurands a simulated 2.0.1 station can sample (the 2.0.1 names; no Temperature). */
export const MEASURANDS_201 = [
  'Energy.Active.Import.Register',
  'Energy.Active.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Active.Import.Interval',
  'Energy.Active.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Energy.Reactive.Export.Interval',
  'Power.Active.Import',
  'Power.Active.Export',
  'Power.Reactive.Import',
  'Power.Reactive.Export',
  'Power.Offered',
  'Power.Factor',
  'Current.Import',
  'Current.Export',
  'Current.Offered',
  'Voltage',
  'Frequency',
  'SoC',
] as const;

/** Transaction start and stop points the simulator supports (`TxStartPoint`, `TxStopPoint`). */
export const TX_POINTS = [
  'EVConnected',
  'Authorized',
  'PowerPathClosed',
  'EnergyTransfer',
] as const;

/** A transaction start or stop point. */
export type TxPoint = (typeof TX_POINTS)[number];

/** References of the variables the simulator reads, by what they are for. */
export const V = {
  heartbeatInterval: { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' },
  messageTimeout: {
    component: 'OCPPCommCtrlr',
    variable: 'MessageTimeout',
    variableInstance: 'Default',
  },
  messageAttempts: {
    component: 'OCPPCommCtrlr',
    variable: 'MessageAttempts',
    variableInstance: 'TransactionEvent',
  },
  messageAttemptInterval: {
    component: 'OCPPCommCtrlr',
    variable: 'MessageAttemptInterval',
    variableInstance: 'TransactionEvent',
  },
  offlineThreshold: { component: 'OCPPCommCtrlr', variable: 'OfflineThreshold' },
  webSocketPingInterval: { component: 'OCPPCommCtrlr', variable: 'WebSocketPingInterval' },
  unlockOnEvSideDisconnect: { component: 'OCPPCommCtrlr', variable: 'UnlockOnEVSideDisconnect' },
  evConnectionTimeOut: { component: 'TxCtrlr', variable: 'EVConnectionTimeOut' },
  stopTxOnEvSideDisconnect: { component: 'TxCtrlr', variable: 'StopTxOnEVSideDisconnect' },
  txStartPoint: { component: 'TxCtrlr', variable: 'TxStartPoint' },
  txStopPoint: { component: 'TxCtrlr', variable: 'TxStopPoint' },
  stopTxOnInvalidId: { component: 'TxCtrlr', variable: 'StopTxOnInvalidId' },
  maxEnergyOnInvalidId: { component: 'TxCtrlr', variable: 'MaxEnergyOnInvalidId' },
  sampledDataEnabled: { component: 'SampledDataCtrlr', variable: 'Enabled' },
  txStartedMeasurands: { component: 'SampledDataCtrlr', variable: 'TxStartedMeasurands' },
  txUpdatedMeasurands: { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands' },
  txUpdatedInterval: { component: 'SampledDataCtrlr', variable: 'TxUpdatedInterval' },
  txEndedMeasurands: { component: 'SampledDataCtrlr', variable: 'TxEndedMeasurands' },
  txEndedInterval: { component: 'SampledDataCtrlr', variable: 'TxEndedInterval' },
  alignedDataEnabled: { component: 'AlignedDataCtrlr', variable: 'Enabled' },
  alignedDataInterval: { component: 'AlignedDataCtrlr', variable: 'Interval' },
  alignedDataMeasurands: { component: 'AlignedDataCtrlr', variable: 'Measurands' },
  alignedDataSendDuringIdle: { component: 'AlignedDataCtrlr', variable: 'SendDuringIdle' },
  authEnabled: { component: 'AuthCtrlr', variable: 'Enabled' },
  authorizeRemoteStart: { component: 'AuthCtrlr', variable: 'AuthorizeRemoteStart' },
  localAuthorizeOffline: { component: 'AuthCtrlr', variable: 'LocalAuthorizeOffline' },
  localPreAuthorize: { component: 'AuthCtrlr', variable: 'LocalPreAuthorize' },
  offlineTxForUnknownId: { component: 'AuthCtrlr', variable: 'OfflineTxForUnknownIdEnabled' },
  authCacheEnabled: { component: 'AuthCacheCtrlr', variable: 'Enabled' },
  authCacheLifeTime: { component: 'AuthCacheCtrlr', variable: 'LifeTime' },
  localAuthListEnabled: { component: 'LocalAuthListCtrlr', variable: 'Enabled' },
  localAuthListEntries: { component: 'LocalAuthListCtrlr', variable: 'Entries' },
  localAuthListItemsPerMessage: { component: 'LocalAuthListCtrlr', variable: 'ItemsPerMessage' },
  smartChargingEnabled: { component: 'SmartChargingCtrlr', variable: 'Enabled' },
  profileStackLevel: { component: 'SmartChargingCtrlr', variable: 'ProfileStackLevel' },
  periodsPerSchedule: { component: 'SmartChargingCtrlr', variable: 'PeriodsPerSchedule' },
  limitChangeSignificance: { component: 'SmartChargingCtrlr', variable: 'LimitChangeSignificance' },
  chargingProfileEntries: {
    component: 'SmartChargingCtrlr',
    variable: 'Entries',
    variableInstance: 'ChargingProfiles',
  },
  reservationEnabled: { component: 'ReservationCtrlr', variable: 'Enabled' },
  nonEvseSpecific: { component: 'ReservationCtrlr', variable: 'NonEvseSpecific' },
  itemsPerMessageGetVariables: {
    component: 'DeviceDataCtrlr',
    variable: 'ItemsPerMessage',
    variableInstance: 'GetVariables',
  },
  itemsPerMessageSetVariables: {
    component: 'DeviceDataCtrlr',
    variable: 'ItemsPerMessage',
    variableInstance: 'SetVariables',
  },
  itemsPerMessageGetReport: {
    component: 'DeviceDataCtrlr',
    variable: 'ItemsPerMessage',
    variableInstance: 'GetReport',
  },
  basicAuthPassword: { component: 'SecurityCtrlr', variable: 'BasicAuthPassword' },
  stationPower: { component: 'ChargingStation', variable: 'Power' },
  stationAvailabilityState: { component: 'ChargingStation', variable: 'AvailabilityState' },
} as const satisfies Record<string, VariableRef>;

/** The variable reference of a variable of an EVSE (or of one of its connectors). */
export function evseVariable(evseId: number, variable: string, connectorId?: number): VariableRef {
  return connectorId === undefined
    ? { component: 'EVSE', evse: { id: evseId }, variable }
    : { component: 'Connector', evse: { id: evseId, connectorId }, variable };
}

/** Settings the standard device model is built from. */
export interface StandardDeviceModelOptions {
  readonly identity: string;
  readonly vendor: string;
  readonly model: string;
  readonly serialNumber?: string;
  /** Number of EVSEs, each with one connector. */
  readonly evses: number;
  /** Hardware power limit per EVSE, W. */
  readonly maxPowerW: number;
  readonly phases: number;
  readonly heartbeatIntervalS: number;
  readonly txUpdatedIntervalS: number;
  readonly txStartPoint: readonly TxPoint[];
  readonly txStopPoint: readonly TxPoint[];
  /** Maximum number of installed charging profiles. */
  readonly maxProfiles: number;
  /** Security profile the station connects with (0 when unsecured, 1 with Basic auth, ...). */
  readonly securityProfile: number;
}

const RW: AttributeDefinition['mutability'] = 'ReadWrite';
const RO: AttributeDefinition['mutability'] = 'ReadOnly';

function actual(
  value: string | undefined,
  mutability: AttributeDefinition['mutability'] = RW,
  extra: Omit<AttributeDefinition, 'value' | 'mutability'> = {},
): VariableDefinition['attributes'] {
  return { Actual: { ...(value === undefined ? {} : { value }), mutability, ...extra } };
}

const AVAILABILITY = ['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted'];

/**
 * The standard device model of a simulated station: the controllers the simulated use cases
 * need (OCPPCommCtrlr, TxCtrlr, SampledDataCtrlr, AlignedDataCtrlr, AuthCtrlr, AuthCacheCtrlr,
 * LocalAuthListCtrlr, SmartChargingCtrlr, ReservationCtrlr, DeviceDataCtrlr, ClockCtrlr,
 * SecurityCtrlr) and the physical components (ChargingStation, each EVSE, each Connector).
 */
export function standardDeviceModel(options: StandardDeviceModelOptions): VariableDefinition[] {
  const measurands = [...MEASURANDS_201];
  const points = [...TX_POINTS];
  const controller = (
    component: string,
    variable: string,
    dataType: VariableDefinition['dataType'],
    attributes: VariableDefinition['attributes'],
    extra: Partial<VariableDefinition> = {},
  ): VariableDefinition => ({ component, variable, dataType, attributes, ...extra });
  const definitions: VariableDefinition[] = [
    // OCPPCommCtrlr
    controller(
      'OCPPCommCtrlr',
      'HeartbeatInterval',
      'integer',
      actual(String(options.heartbeatIntervalS)),
      {
        unit: 's',
        minLimit: 0,
      },
    ),
    controller('OCPPCommCtrlr', 'MessageTimeout', 'integer', actual('30'), {
      variableInstance: 'Default',
      unit: 's',
      minLimit: 1,
    }),
    controller('OCPPCommCtrlr', 'MessageAttempts', 'integer', actual('3'), {
      variableInstance: 'TransactionEvent',
      minLimit: 1,
    }),
    controller('OCPPCommCtrlr', 'MessageAttemptInterval', 'integer', actual('10'), {
      variableInstance: 'TransactionEvent',
      unit: 's',
      minLimit: 0,
    }),
    controller('OCPPCommCtrlr', 'OfflineThreshold', 'integer', actual('60'), {
      unit: 's',
      minLimit: 0,
    }),
    controller('OCPPCommCtrlr', 'ResetRetries', 'integer', actual('1'), { minLimit: 0 }),
    controller('OCPPCommCtrlr', 'UnlockOnEVSideDisconnect', 'boolean', actual('true')),
    controller('OCPPCommCtrlr', 'WebSocketPingInterval', 'integer', actual('0'), {
      unit: 's',
      minLimit: 0,
      rebootRequired: true,
    }),
    controller('OCPPCommCtrlr', 'NetworkConfigurationPriority', 'SequenceList', actual('0'), {
      valuesList: ['0', '1', '2'],
    }),
    controller('OCPPCommCtrlr', 'NetworkProfileConnectionAttempts', 'integer', actual('3'), {
      minLimit: 1,
    }),
    controller('OCPPCommCtrlr', 'FileTransferProtocols', 'MemberList', actual('HTTPS,FTPS', RO), {
      valuesList: ['FTP', 'FTPS', 'HTTP', 'HTTPS', 'SFTP'],
    }),
    controller('OCPPCommCtrlr', 'QueueAllMessages', 'boolean', actual('false')),
    // TxCtrlr
    controller('TxCtrlr', 'EVConnectionTimeOut', 'integer', actual('60'), {
      unit: 's',
      minLimit: 0,
    }),
    controller('TxCtrlr', 'StopTxOnEVSideDisconnect', 'boolean', actual('true')),
    controller('TxCtrlr', 'TxStartPoint', 'MemberList', actual(options.txStartPoint.join(',')), {
      valuesList: points,
    }),
    controller('TxCtrlr', 'TxStopPoint', 'MemberList', actual(options.txStopPoint.join(',')), {
      valuesList: points,
    }),
    controller('TxCtrlr', 'StopTxOnInvalidId', 'boolean', actual('true')),
    controller('TxCtrlr', 'MaxEnergyOnInvalidId', 'integer', actual('0'), {
      unit: 'Wh',
      minLimit: 0,
    }),
    controller('TxCtrlr', 'TxBeforeAcceptedEnabled', 'boolean', actual('false', RO)),
    // SampledDataCtrlr
    controller('SampledDataCtrlr', 'Enabled', 'boolean', actual('true')),
    controller(
      'SampledDataCtrlr',
      'TxStartedMeasurands',
      'MemberList',
      actual('Energy.Active.Import.Register'),
      { valuesList: measurands },
    ),
    controller(
      'SampledDataCtrlr',
      'TxUpdatedMeasurands',
      'MemberList',
      actual('Energy.Active.Import.Register,Power.Active.Import,SoC'),
      { valuesList: measurands },
    ),
    controller(
      'SampledDataCtrlr',
      'TxUpdatedInterval',
      'integer',
      actual(String(options.txUpdatedIntervalS)),
      {
        unit: 's',
        minLimit: 0,
      },
    ),
    controller(
      'SampledDataCtrlr',
      'TxEndedMeasurands',
      'MemberList',
      actual('Energy.Active.Import.Register'),
      { valuesList: measurands },
    ),
    controller('SampledDataCtrlr', 'TxEndedInterval', 'integer', actual('0'), {
      unit: 's',
      minLimit: 0,
    }),
    // AlignedDataCtrlr
    controller('AlignedDataCtrlr', 'Enabled', 'boolean', actual('true')),
    controller('AlignedDataCtrlr', 'Interval', 'integer', actual('0'), { unit: 's', minLimit: 0 }),
    controller(
      'AlignedDataCtrlr',
      'Measurands',
      'MemberList',
      actual('Energy.Active.Import.Register'),
      {
        valuesList: measurands,
      },
    ),
    controller('AlignedDataCtrlr', 'SendDuringIdle', 'boolean', actual('false')),
    // AuthCtrlr
    controller('AuthCtrlr', 'Enabled', 'boolean', actual('true')),
    controller('AuthCtrlr', 'AuthorizeRemoteStart', 'boolean', actual('false')),
    controller('AuthCtrlr', 'LocalAuthorizeOffline', 'boolean', actual('true')),
    controller('AuthCtrlr', 'LocalPreAuthorize', 'boolean', actual('false')),
    controller('AuthCtrlr', 'OfflineTxForUnknownIdEnabled', 'boolean', actual('false')),
    controller('AuthCtrlr', 'DisableRemoteAuthorization', 'boolean', actual('false')),
    // AuthCacheCtrlr
    controller('AuthCacheCtrlr', 'Enabled', 'boolean', actual('true')),
    controller('AuthCacheCtrlr', 'Available', 'boolean', actual('true', RO)),
    controller('AuthCacheCtrlr', 'LifeTime', 'integer', actual('86400'), {
      unit: 's',
      minLimit: 0,
    }),
    controller('AuthCacheCtrlr', 'Policy', 'OptionList', actual('LRU'), { valuesList: ['LRU'] }),
    // LocalAuthListCtrlr
    controller('LocalAuthListCtrlr', 'Enabled', 'boolean', actual('true')),
    controller('LocalAuthListCtrlr', 'Available', 'boolean', actual('true', RO)),
    controller('LocalAuthListCtrlr', 'Entries', 'integer', actual('0', RO), { maxLimit: 1_000 }),
    controller('LocalAuthListCtrlr', 'ItemsPerMessage', 'integer', actual('250', RO)),
    // SmartChargingCtrlr
    controller('SmartChargingCtrlr', 'Enabled', 'boolean', actual('true')),
    controller('SmartChargingCtrlr', 'Available', 'boolean', actual('true', RO)),
    controller('SmartChargingCtrlr', 'ProfileStackLevel', 'integer', actual('8', RO)),
    controller('SmartChargingCtrlr', 'PeriodsPerSchedule', 'integer', actual('24', RO)),
    controller('SmartChargingCtrlr', 'Entries', 'integer', actual('0', RO), {
      variableInstance: 'ChargingProfiles',
      maxLimit: options.maxProfiles,
    }),
    controller('SmartChargingCtrlr', 'RateUnit', 'MemberList', actual('A,W', RO), {
      valuesList: ['A', 'W'],
    }),
    controller('SmartChargingCtrlr', 'LimitChangeSignificance', 'decimal', actual('1'), {
      unit: 'Percent',
      minLimit: 0,
    }),
    // ReservationCtrlr
    controller('ReservationCtrlr', 'Enabled', 'boolean', actual('true')),
    controller('ReservationCtrlr', 'Available', 'boolean', actual('true', RO)),
    controller('ReservationCtrlr', 'NonEvseSpecific', 'boolean', actual('true')),
    // DeviceDataCtrlr
    ...['GetVariables', 'SetVariables', 'GetReport'].map((instance) =>
      controller(
        'DeviceDataCtrlr',
        'ItemsPerMessage',
        'integer',
        actual(instance === 'GetReport' ? '100' : '50', RO),
        {
          variableInstance: instance,
        },
      ),
    ),
    controller('DeviceDataCtrlr', 'ConfigurationValueSize', 'integer', actual('1000', RO)),
    controller('DeviceDataCtrlr', 'ReportingValueSize', 'integer', actual('2500', RO)),
    // ClockCtrlr
    controller('ClockCtrlr', 'DateTime', 'dateTime', actual(new Date(0).toISOString(), RO)),
    controller('ClockCtrlr', 'TimeSource', 'SequenceList', actual('Heartbeat'), {
      valuesList: [
        'Heartbeat',
        'NTP',
        'GPS',
        'RealTimeClock',
        'MobileNetwork',
        'RadioTimeTransmitter',
      ],
    }),
    // SecurityCtrlr
    controller(
      'SecurityCtrlr',
      'SecurityProfile',
      'integer',
      actual(String(options.securityProfile), RO),
    ),
    controller('SecurityCtrlr', 'Identity', 'string', actual(options.identity.slice(0, 48), RO), {
      maxLimit: 48,
    }),
    controller('SecurityCtrlr', 'OrganizationName', 'string', actual('ocpp-kit')),
    controller('SecurityCtrlr', 'BasicAuthPassword', 'string', actual(undefined, 'WriteOnly'), {
      minLimit: 16,
      maxLimit: 40,
      rebootRequired: true,
    }),
    controller('SecurityCtrlr', 'CertificateEntries', 'integer', actual('0', RO)),
    // ChargingStation
    controller('ChargingStation', 'AvailabilityState', 'OptionList', actual('Available', RO), {
      valuesList: AVAILABILITY,
    }),
    controller('ChargingStation', 'Available', 'boolean', actual('true', RO)),
    controller('ChargingStation', 'Model', 'string', actual(options.model, RO, { constant: true })),
    controller(
      'ChargingStation',
      'VendorName',
      'string',
      actual(options.vendor, RO, { constant: true }),
    ),
    ...(options.serialNumber === undefined
      ? []
      : [
          controller(
            'ChargingStation',
            'SerialNumber',
            'string',
            actual(options.serialNumber, RO, { constant: true }),
          ),
        ]),
    controller('ChargingStation', 'SupplyPhases', 'integer', actual(String(options.phases), RO)),
    // Power: the Actual draw, and an installer-set MaxSet cap that the simulation honours.
    controller(
      'ChargingStation',
      'Power',
      'decimal',
      {
        Actual: { value: '0', mutability: RO },
        MaxSet: { value: String(options.maxPowerW * options.evses), mutability: RW },
      },
      { unit: 'W', minLimit: 0, maxLimit: options.maxPowerW * options.evses },
    ),
  ];
  for (let id = 1; id <= options.evses; id++) {
    const evse = { id };
    const connector = { id, connectorId: 1 };
    definitions.push(
      {
        component: 'EVSE',
        evse,
        variable: 'AvailabilityState',
        dataType: 'OptionList',
        valuesList: AVAILABILITY,
        attributes: actual('Available', RO),
      },
      {
        component: 'EVSE',
        evse,
        variable: 'Available',
        dataType: 'boolean',
        attributes: actual('true', RO),
      },
      {
        component: 'EVSE',
        evse,
        variable: 'Power',
        dataType: 'decimal',
        unit: 'W',
        minLimit: 0,
        maxLimit: options.maxPowerW,
        attributes: {
          Actual: { value: '0', mutability: RO },
          MaxSet: { value: String(options.maxPowerW), mutability: RW },
        },
      },
      {
        component: 'EVSE',
        evse,
        variable: 'SupplyPhases',
        dataType: 'integer',
        attributes: actual(String(options.phases), RO),
      },
      {
        component: 'Connector',
        evse: connector,
        variable: 'AvailabilityState',
        dataType: 'OptionList',
        valuesList: AVAILABILITY,
        attributes: actual('Available', RO),
      },
      {
        component: 'Connector',
        evse: connector,
        variable: 'Available',
        dataType: 'boolean',
        attributes: actual('true', RO),
      },
      {
        component: 'Connector',
        evse: connector,
        variable: 'ConnectorType',
        dataType: 'OptionList',
        valuesList: ['cType2', 'sType2', 'cCCS2'],
        attributes: actual('cType2', RO, { constant: true }),
      },
      {
        component: 'Connector',
        evse: connector,
        variable: 'SupplyPhases',
        dataType: 'integer',
        attributes: actual(String(options.phases), RO),
      },
    );
  }
  return definitions;
}
