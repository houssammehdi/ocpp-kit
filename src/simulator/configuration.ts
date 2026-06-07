import {
  ciKey,
  Measurand,
  type ConfigurationStatus,
  type GetConfigurationResponse,
  type KeyValue,
} from '../messages/index.js';
import { RpcError } from '../rpc/errors.js';

/** Value kinds used to validate ChangeConfiguration requests. */
export type ConfigValueType = 'integer' | 'boolean' | 'string' | 'measurands';

/** Definition of one configuration key. */
export interface ConfigKeyDefinition {
  readonly key: string;
  readonly value: string;
  readonly readonly: boolean;
  readonly type: ConfigValueType;
  /** Lowest accepted value for integer keys. */
  readonly min?: number;
  /** Changing the key only takes effect after a reboot (answers `RebootRequired`). */
  readonly rebootRequired?: boolean;
}

const MEASURANDS: ReadonlySet<string> = new Set(
  Measurand.anyOf.map((literal: { const: string }) => literal.const),
);

function isValid(definition: ConfigKeyDefinition, value: string): boolean {
  switch (definition.type) {
    case 'integer': {
      if (!/^-?\d+$/.test(value)) return false;
      return Number(value) >= (definition.min ?? Number.MIN_SAFE_INTEGER);
    }
    case 'boolean':
      // Values are CiStrings, so "TRUE" is as good as "true".
      return /^(true|false)$/i.test(value);
    case 'measurands':
      return value === '' || value.split(',').every((item) => MEASURANDS.has(item.trim()));
    case 'string':
      return true;
  }
}

/** Listener invoked after a key changed. */
export type ConfigChangeListener = (key: string, value: string) => void;

/**
 * Charge point configuration as exposed through GetConfiguration/ChangeConfiguration. Keys are
 * matched case-insensitively, as CiString keys are.
 */
export class ConfigurationStore {
  readonly #entries = new Map<string, { definition: ConfigKeyDefinition; value: string }>();
  readonly #listeners: ConfigChangeListener[] = [];
  readonly #defaultMaxKeys: number;

  /**
   * @param maxKeys - limit of keys per GetConfiguration request when the store has no
   *   `GetConfigurationMaxKeys` key
   */
  constructor(definitions: readonly ConfigKeyDefinition[], maxKeys = 100) {
    for (const definition of definitions) {
      this.#entries.set(ciKey(definition.key), { definition, value: definition.value });
    }
    this.#defaultMaxKeys = maxKeys;
  }

  /** Raw value of `key`, if defined. */
  get(key: string): string | undefined {
    return this.#entries.get(ciKey(key))?.value;
  }

  /** Integer value of `key`, or `fallback` when missing or not an integer. */
  getInteger(key: string, fallback: number): number {
    const value = Number(this.get(key));
    return Number.isInteger(value) ? value : fallback;
  }

  /** Boolean value of `key`, or `fallback` when missing. */
  getBoolean(key: string, fallback: boolean): boolean {
    const value = this.get(key);
    return value === undefined ? fallback : value.toLowerCase() === 'true';
  }

  /** Comma-separated list value of `key`. */
  getList(key: string): string[] {
    const value = this.get(key);
    return value
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  }

  /** Set a value internally, bypassing read-only protection (e.g. firmware-managed keys). */
  set(key: string, value: string): void {
    const entry = this.#entries.get(ciKey(key));
    if (!entry) throw new RangeError(`Unknown configuration key ${key}`);
    entry.value = value;
    for (const listener of this.#listeners) listener(entry.definition.key, value);
  }

  /** Apply a ChangeConfiguration request. */
  change(key: string, value: string): ConfigurationStatus {
    const entry = this.#entries.get(ciKey(key));
    if (!entry) return 'NotSupported';
    if (entry.definition.readonly || !isValid(entry.definition, value)) return 'Rejected';
    this.set(
      entry.definition.key,
      entry.definition.type === 'boolean' ? value.toLowerCase() : value,
    );
    return entry.definition.rebootRequired ? 'RebootRequired' : 'Accepted';
  }

  /** Maximum number of keys in one GetConfiguration request (`GetConfigurationMaxKeys`). */
  get maxKeys(): number {
    return this.getInteger('GetConfigurationMaxKeys', this.#defaultMaxKeys);
  }

  /**
   * Answer a GetConfiguration request.
   *
   * @throws {@link RpcError} `OccurenceConstraintViolation` when more keys are requested than
   *   `GetConfigurationMaxKeys` allows; answering only some of them would silently drop keys.
   */
  getConfiguration(keys?: readonly string[]): GetConfigurationResponse {
    const toKeyValue = ({
      definition,
      value,
    }: {
      definition: ConfigKeyDefinition;
      value: string;
    }): KeyValue => ({
      key: definition.key,
      readonly: definition.readonly,
      value,
    });
    if (!keys || keys.length === 0) {
      return { configurationKey: [...this.#entries.values()].map(toKeyValue) };
    }
    if (keys.length > this.maxKeys) {
      throw new RpcError(
        'OccurenceConstraintViolation',
        `At most ${this.maxKeys} keys may be requested at once (GetConfigurationMaxKeys)`,
      );
    }
    const configurationKey: KeyValue[] = [];
    const unknownKey: string[] = [];
    for (const key of keys) {
      const entry = this.#entries.get(ciKey(key));
      if (entry) configurationKey.push(toKeyValue(entry));
      else unknownKey.push(key);
    }
    return {
      ...(configurationKey.length > 0 ? { configurationKey } : {}),
      ...(unknownKey.length > 0 ? { unknownKey } : {}),
    };
  }

  /** Subscribe to value changes. */
  onChange(listener: ConfigChangeListener): void {
    this.#listeners.push(listener);
  }
}

/** Standard Core and Smart Charging configuration keys with simulator defaults. */
export function defaultConfiguration(options: {
  readonly connectors: number;
  readonly heartbeatIntervalS?: number;
  readonly meterValueSampleIntervalS?: number;
}): ConfigKeyDefinition[] {
  const rw = (
    key: string,
    value: string,
    type: ConfigValueType,
    extra: Partial<ConfigKeyDefinition> = {},
  ) => ({ key, value, type, readonly: false, ...extra }) satisfies ConfigKeyDefinition;
  const ro = (key: string, value: string, type: ConfigValueType) =>
    ({ key, value, type, readonly: true }) satisfies ConfigKeyDefinition;
  return [
    rw('AllowOfflineTxForUnknownId', 'false', 'boolean'),
    rw('AuthorizeRemoteTxRequests', 'false', 'boolean'),
    rw('ClockAlignedDataInterval', '0', 'integer', { min: 0 }),
    rw('ConnectionTimeOut', '60', 'integer', { min: 1 }),
    ro('GetConfigurationMaxKeys', '100', 'integer'),
    rw('HeartbeatInterval', String(options.heartbeatIntervalS ?? 300), 'integer', { min: 0 }),
    rw('LocalAuthorizeOffline', 'true', 'boolean'),
    rw('LocalPreAuthorize', 'false', 'boolean'),
    rw('MeterValuesAlignedData', 'Energy.Active.Import.Register', 'measurands'),
    rw(
      'MeterValuesSampledData',
      'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage,SoC',
      'measurands',
    ),
    rw('MeterValueSampleInterval', String(options.meterValueSampleIntervalS ?? 60), 'integer', {
      min: 0,
    }),
    ro('NumberOfConnectors', String(options.connectors), 'integer'),
    rw('ResetRetries', '1', 'integer', { min: 0 }),
    rw('StopTransactionOnEVSideDisconnect', 'true', 'boolean'),
    rw('StopTransactionOnInvalidId', 'true', 'boolean'),
    rw('StopTxnSampledData', 'Energy.Active.Import.Register', 'measurands'),
    ro('SupportedFeatureProfiles', 'Core,SmartCharging,RemoteTrigger', 'string'),
    rw('TransactionMessageAttempts', '3', 'integer', { min: 1 }),
    rw('TransactionMessageRetryInterval', '10', 'integer', { min: 0 }),
    rw('UnlockConnectorOnEVSideDisconnect', 'true', 'boolean'),
    rw('WebSocketPingInterval', '0', 'integer', { min: 0, rebootRequired: true }),
    ro('ChargeProfileMaxStackLevel', '8', 'integer'),
    ro('ChargingScheduleAllowedChargingRateUnit', 'Current,Power', 'string'),
    ro('ChargingScheduleMaxPeriods', '24', 'integer'),
    ro('MaxChargingProfilesInstalled', '16', 'integer'),
  ];
}
