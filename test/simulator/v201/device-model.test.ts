import { describe, expect, it } from 'vitest';
import {
  DeviceModel,
  standardDeviceModel,
  validateValue,
  type v201,
  type VariableDefinition,
} from '../../../src/index.js';
import { advance, charging, started, useSimulatedTime } from './harness.js';

const definitions: VariableDefinition[] = [
  {
    component: 'OCPPCommCtrlr',
    variable: 'HeartbeatInterval',
    dataType: 'integer',
    unit: 's',
    minLimit: 0,
    attributes: { Actual: { value: '300' } },
  },
  {
    component: 'TxCtrlr',
    variable: 'TxStartPoint',
    dataType: 'MemberList',
    valuesList: ['EVConnected', 'Authorized', 'PowerPathClosed'],
    attributes: { Actual: { value: 'PowerPathClosed' } },
  },
  {
    component: 'ChargingStation',
    variable: 'Model',
    dataType: 'string',
    attributes: { Actual: { value: 'M1', mutability: 'ReadOnly', constant: true } },
  },
  {
    component: 'SecurityCtrlr',
    variable: 'BasicAuthPassword',
    dataType: 'string',
    minLimit: 16,
    maxLimit: 40,
    rebootRequired: true,
    attributes: { Actual: { mutability: 'WriteOnly' } },
  },
  {
    component: 'EVSE',
    evse: { id: 1 },
    variable: 'Power',
    dataType: 'decimal',
    unit: 'W',
    maxLimit: 22_000,
    attributes: { Actual: { value: '0', mutability: 'ReadOnly' }, MaxSet: { value: '22000' } },
  },
  {
    component: 'AuthCtrlr',
    variable: 'Enabled',
    dataType: 'boolean',
    attributes: { Actual: { value: 'true', persistent: false } },
  },
];

const get = (component: v201.Component, variable: string, attributeType?: v201.AttributeKind) => ({
  component,
  variable: { name: variable },
  ...(attributeType === undefined ? {} : { attributeType }),
});
const set = (
  component: v201.Component,
  variable: string,
  attributeValue: string,
  attributeType?: v201.AttributeKind,
) => ({
  ...get(component, variable, attributeType),
  attributeValue,
});

describe('DeviceModel', () => {
  it('reads attributes and tells unknown components, variables and attributes apart', () => {
    const model = new DeviceModel(definitions);
    const { getVariableResult } = model.getVariables({
      getVariableData: [
        get({ name: 'OCPPCommCtrlr' }, 'HeartbeatInterval'),
        get({ name: 'ocppcommctrlr' }, 'heartbeatinterval'), // case-insensitive
        get({ name: 'OCPPCommCtrlr' }, 'NoSuchVariable'),
        get({ name: 'NoSuchCtrlr' }, 'HeartbeatInterval'),
        get({ name: 'OCPPCommCtrlr' }, 'HeartbeatInterval', 'MaxSet'),
        get({ name: 'SecurityCtrlr' }, 'BasicAuthPassword'),
        get({ name: 'EVSE', evse: { id: 1 } }, 'Power', 'MaxSet'),
        get({ name: 'EVSE', evse: { id: 2 } }, 'Power'),
      ],
    });
    expect(getVariableResult.map((r) => [r.attributeStatus, r.attributeValue])).toEqual([
      ['Accepted', '300'],
      ['Accepted', '300'],
      ['UnknownVariable', undefined],
      ['UnknownComponent', undefined],
      ['NotSupportedAttributeType', undefined],
      ['Rejected', undefined],
      ['Accepted', '22000'],
      ['UnknownComponent', undefined],
    ]);
    // The request's component and variable are echoed.
    expect(getVariableResult[1]?.component).toEqual({ name: 'ocppcommctrlr' });
  });

  it('writes values after checking mutability, type, limits and allowed values', () => {
    const model = new DeviceModel(definitions);
    const changes: string[] = [];
    model.onChange((ref, attribute, value) =>
      changes.push(`${ref.variable}.${attribute}=${value}`),
    );
    const { setVariableResult } = model.setVariables({
      setVariableData: [
        set({ name: 'OCPPCommCtrlr' }, 'HeartbeatInterval', '120'),
        set({ name: 'OCPPCommCtrlr' }, 'HeartbeatInterval', '-1'),
        set({ name: 'OCPPCommCtrlr' }, 'HeartbeatInterval', '1.5'),
        set({ name: 'TxCtrlr' }, 'TxStartPoint', 'EVConnected, Authorized'),
        set({ name: 'TxCtrlr' }, 'TxStartPoint', 'ParkingBayOccupancy'),
        set({ name: 'ChargingStation' }, 'Model', 'M2'),
        set({ name: 'EVSE', evse: { id: 1 } }, 'Power', '11000', 'MaxSet'),
        set({ name: 'EVSE', evse: { id: 1 } }, 'Power', '11000'),
        set({ name: 'SecurityCtrlr' }, 'BasicAuthPassword', 'short'),
        set({ name: 'SecurityCtrlr' }, 'BasicAuthPassword', 'a-long-enough-password'),
        set({ name: 'AuthCtrlr' }, 'Enabled', 'FALSE'),
      ],
    });
    expect(
      setVariableResult.map((r) => [r.attributeStatus, r.attributeStatusInfo?.reasonCode]),
    ).toEqual([
      ['Accepted', undefined],
      ['Rejected', 'InvalidValue'],
      ['Rejected', 'InvalidValue'],
      ['Accepted', undefined],
      ['Rejected', 'InvalidValue'],
      ['Rejected', 'ReadOnly'],
      ['Accepted', undefined],
      ['Rejected', 'ReadOnly'],
      ['Rejected', 'InvalidValue'],
      ['RebootRequired', undefined],
      ['Accepted', undefined],
    ]);
    expect(changes).toEqual([
      'HeartbeatInterval.Actual=120',
      'TxStartPoint.Actual=EVConnected,Authorized',
      'Power.MaxSet=11000',
      'Enabled.Actual=false',
    ]);
    expect(model.list({ component: 'TxCtrlr', variable: 'TxStartPoint' })).toEqual([
      'EVConnected',
      'Authorized',
    ]);
    expect(model.boolean({ component: 'AuthCtrlr', variable: 'Enabled' }, true)).toBe(false);
  });

  it('applies RebootRequired values and forgets non-persistent ones at a reboot', () => {
    const model = new DeviceModel(definitions);
    model.setVariables({
      setVariableData: [
        set({ name: 'SecurityCtrlr' }, 'BasicAuthPassword', 'a-long-enough-password'),
        set({ name: 'AuthCtrlr' }, 'Enabled', 'false'),
        set({ name: 'OCPPCommCtrlr' }, 'HeartbeatInterval', '90'),
      ],
    });
    expect(
      model.read({ component: 'SecurityCtrlr', variable: 'BasicAuthPassword' }),
    ).toBeUndefined();
    model.reboot();
    expect(model.read({ component: 'SecurityCtrlr', variable: 'BasicAuthPassword' })).toBe(
      'a-long-enough-password',
    );
    expect(model.read({ component: 'AuthCtrlr', variable: 'Enabled' })).toBe('true');
    expect(model.read({ component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' })).toBe('90');
  });

  it('reports inventories with attributes and characteristics, never revealing write-only values', () => {
    const model = new DeviceModel(definitions);
    model.bind({ component: 'EVSE', evse: { id: 1 }, variable: 'Power' }, () => '7400');
    const full = model.baseReport('FullInventory');
    expect(full).toHaveLength(definitions.length);
    const power = full.find((d) => d.variable.name === 'Power');
    expect(power).toEqual({
      component: { name: 'EVSE', evse: { id: 1 } },
      variable: { name: 'Power' },
      variableAttribute: [
        {
          type: 'Actual',
          value: '7400',
          mutability: 'ReadOnly',
          persistent: false,
          constant: false,
        },
        {
          type: 'MaxSet',
          value: '22000',
          mutability: 'ReadWrite',
          persistent: true,
          constant: false,
        },
      ],
      variableCharacteristics: {
        dataType: 'decimal',
        supportsMonitoring: false,
        unit: 'W',
        maxLimit: 22_000,
      },
    });
    const password = full.find((d) => d.variable.name === 'BasicAuthPassword');
    expect(password?.variableAttribute[0]).toEqual({
      type: 'Actual',
      mutability: 'WriteOnly',
      persistent: true,
      constant: false,
    });
    const configuration = model.baseReport('ConfigurationInventory').map((d) => d.variable.name);
    expect(configuration).toEqual([
      'HeartbeatInterval',
      'TxStartPoint',
      'BasicAuthPassword',
      'Power',
      'Enabled',
    ]);
    expect(
      model
        .customReport([{ component: { name: 'TxCtrlr' } }], undefined)
        .map((d) => d.variable.name),
    ).toEqual(['TxStartPoint']);
    expect(model.customReport(undefined, ['Problem'])).toEqual([]);
  });

  it('refuses invalid definitions and too many items per message', () => {
    expect(
      () =>
        new DeviceModel([{ component: 'X', variable: 'Y', dataType: 'integer', attributes: {} }]),
    ).toThrow(RangeError);
    expect(
      () =>
        new DeviceModel([
          {
            component: 'X',
            variable: 'Y',
            dataType: 'integer',
            attributes: { Actual: { value: 'x' } },
          },
        ]),
    ).toThrow(/not an integer/);
    const model = new DeviceModel(definitions, { itemsPerMessage: () => 1 });
    expect(() =>
      model.getVariables({
        getVariableData: [
          get({ name: 'TxCtrlr' }, 'TxStartPoint'),
          get({ name: 'TxCtrlr' }, 'TxStartPoint'),
        ],
      }),
    ).toThrow(/items per message/);
  });

  it('validates every data type', () => {
    const of = (
      dataType: VariableDefinition['dataType'],
      extra: Partial<VariableDefinition> = {},
    ) => ({
      component: 'C',
      variable: 'V',
      dataType,
      attributes: { Actual: {} },
      ...extra,
    });
    expect(validateValue(of('decimal'), '1e3')).toEqual({ value: '1000' });
    expect(validateValue(of('decimal'), 'x')).toEqual({ invalid: 'not a decimal' });
    expect(validateValue(of('dateTime'), '2026-09-26T10:00:00Z')).toEqual({
      value: '2026-09-26T10:00:00Z',
    });
    expect(validateValue(of('dateTime'), 'tomorrow')).toHaveProperty('invalid');
    expect(validateValue(of('boolean'), 'True')).toEqual({ value: 'true' });
    expect(validateValue(of('OptionList', { valuesList: ['A', 'B'] }), 'C')).toHaveProperty(
      'invalid',
    );
    expect(validateValue(of('SequenceList', { valuesList: ['A', 'B'] }), 'B,A')).toEqual({
      value: 'B,A',
    });
    expect(validateValue(of('MemberList', { valuesList: ['A', 'B'] }), 'A,A')).toEqual({
      invalid: 'lists an item twice',
    });
    expect(validateValue(of('MemberList'), '')).toEqual({ value: '' });
    expect(validateValue(of('string', { maxLimit: 3 }), 'abcd')).toHaveProperty('invalid');
  });

  it('builds a standard model whose every initial value is valid, with one EVSE and connector per EVSE', () => {
    const standard = standardDeviceModel({
      identity: 'CS-1',
      vendor: 'V',
      model: 'M',
      evses: 3,
      maxPowerW: 11_000,
      phases: 3,
      heartbeatIntervalS: 300,
      txUpdatedIntervalS: 60,
      txStartPoint: ['PowerPathClosed'],
      txStopPoint: ['EVConnected', 'Authorized'],
      maxProfiles: 16,
      securityProfile: 1,
    });
    const model = new DeviceModel(standard);
    expect(
      standard.filter((d) => d.component === 'Connector' && d.variable === 'AvailabilityState'),
    ).toHaveLength(3);
    for (const name of [
      'OCPPCommCtrlr',
      'TxCtrlr',
      'SampledDataCtrlr',
      'AlignedDataCtrlr',
      'AuthCtrlr',
      'AuthCacheCtrlr',
      'LocalAuthListCtrlr',
      'SmartChargingCtrlr',
      'ReservationCtrlr',
      'DeviceDataCtrlr',
      'ClockCtrlr',
      'SecurityCtrlr',
      'ChargingStation',
      'EVSE',
      'Connector',
    ]) {
      expect(
        standard.some((d) => d.component === name),
        name,
      ).toBe(true);
    }
    expect(
      model.read({
        component: 'OCPPCommCtrlr',
        variable: 'MessageAttempts',
        variableInstance: 'TransactionEvent',
      }),
    ).toBe('3');
  });
});

describe('the Device Model of a simulated station', () => {
  useSimulatedTime();

  it('answers GetVariables and SetVariables, and a new HeartbeatInterval takes effect at once', async () => {
    const { csms, station } = await started();
    const peer = csms.current!;
    const read = await peer.call('GetVariables', {
      getVariableData: [
        get({ name: 'OCPPCommCtrlr' }, 'HeartbeatInterval'),
        get({ name: 'SecurityCtrlr' }, 'Identity'),
        get({ name: 'ClockCtrlr' }, 'DateTime'),
      ],
    });
    expect(read.getVariableResult.map((r) => r.attributeValue)).toEqual([
      '60',
      'CS-001',
      new Date().toISOString(),
    ]);
    await advance(0);
    const before = csms.requestsOf('Heartbeat').length;
    const written = await peer.call('SetVariables', {
      setVariableData: [set({ name: 'OCPPCommCtrlr' }, 'HeartbeatInterval', '10')],
    });
    expect(written.setVariableResult[0]?.attributeStatus).toBe('Accepted');
    await advance(31);
    expect(csms.requestsOf('Heartbeat').length - before).toBe(3);
    // Changing a security variable is a security event.
    await peer.call('SetVariables', {
      setVariableData: [set({ name: 'SecurityCtrlr' }, 'OrganizationName', 'Fount')],
    });
    await advance(0);
    expect(csms.requestsOf('SecurityEventNotification').map((r) => r.type)).toContain(
      'ReconfigurationOfSecurityParameters',
    );
    expect(
      station.deviceModel.read({ component: 'SecurityCtrlr', variable: 'OrganizationName' }),
    ).toBe('Fount');
  });

  it('refuses more items than DeviceDataCtrlr.ItemsPerMessage with a 2.0.1 CALLERROR', async () => {
    const { csms } = await started();
    const many = Array.from({ length: 51 }, () => get({ name: 'TxCtrlr' }, 'TxStartPoint'));
    await expect(
      csms.current!.call('GetVariables', { getVariableData: many }),
    ).rejects.toMatchObject({
      code: 'OccurrenceConstraintViolation',
    });
  });

  it('sends a GetBaseReport as NotifyReport parts with seqNo and tbc', async () => {
    const { csms, station } = await started({ evses: 4 });
    await charging(station);
    const peer = csms.current!;
    expect(await peer.call('GetBaseReport', { requestId: 7, reportBase: 'FullInventory' })).toEqual(
      { status: 'Accepted' },
    );
    await advance(0);
    const parts = csms.requestsOf('NotifyReport') as unknown as v201.NotifyReportRequest[];
    const total = station.deviceModel.definitions.length;
    expect(total).toBeGreaterThan(100);
    expect(parts).toHaveLength(Math.ceil(total / 100));
    expect(parts.map((p) => [p.seqNo, p.tbc])).toEqual(
      parts.map((_, i) => [i, i < parts.length - 1]),
    );
    expect(parts.every((p) => p.requestId === 7)).toBe(true);
    const all = parts.flatMap((p) => p.reportData ?? []);
    expect(all).toHaveLength(total);
    const occupied = all.find(
      (d) =>
        d.component.name === 'Connector' &&
        d.component.evse?.id === 1 &&
        d.variable.name === 'AvailabilityState',
    );
    expect(occupied?.variableAttribute[0]?.value).toBe('Occupied');
    expect(
      await peer.call('GetBaseReport', { requestId: 8, reportBase: 'SummaryInventory' }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await peer.call('GetReport', {
        requestId: 9,
        componentVariable: [{ component: { name: 'Nope' } }],
      }),
    ).toEqual({ status: 'EmptyResultSet' });
    expect(
      await peer.call('GetReport', {
        requestId: 10,
        componentVariable: [{ component: { name: 'TxCtrlr' }, variable: { name: 'TxStopPoint' } }],
      }),
    ).toEqual({ status: 'Accepted' });
    await advance(0);
    const custom = (
      csms.requestsOf('NotifyReport') as unknown as v201.NotifyReportRequest[]
    ).filter((p) => p.requestId === 10);
    expect(custom[0]?.reportData?.map((d) => d.variable.name)).toEqual(['TxStopPoint']);
  });

  it('stores network profiles unless they lower the security profile', async () => {
    const { csms, station } = await started({ password: 'a-long-enough-password' });
    const profile = {
      ocppVersion: 'OCPP20',
      ocppTransport: 'JSON',
      ocppCsmsUrl: 'wss://x/ocpp',
      messageTimeout: 30,
      ocppInterface: 'Wired0',
    } as const;
    expect(
      await csms.current!.call('SetNetworkProfile', {
        configurationSlot: 1,
        connectionData: { ...profile, securityProfile: 0 },
      }),
    ).toMatchObject({ status: 'Rejected' });
    expect(
      await csms.current!.call('SetNetworkProfile', {
        configurationSlot: 1,
        connectionData: { ...profile, securityProfile: 2 },
      }),
    ).toEqual({ status: 'Accepted' });
    expect(station.networkProfiles.get(1)?.securityProfile).toBe(2);
  });
});
