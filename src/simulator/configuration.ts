import {
  ciKey,
  FEATURE_PROFILES,
  type ConfigurationStatus,
  type FeatureProfile,
  type GetConfigurationResponse,
  type KeyValue,
} from '../messages/index.js';
import { RpcError } from '../rpc/errors.js';
import { formatMeasurandList, parseMeasurandList, type MeasurandItem } from './metering.js';

/** Value kinds used to validate ChangeConfiguration requests. */
export type ConfigValueType = 'integer' | 'boolean' | 'string' | 'measurands' | 'phaseRotation';

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
  /**
   * For list values: the key holding the maximum number of items, e.g.
   * `MeterValuesSampledDataMaxLength` for `MeterValuesSampledData`.
   */
  readonly maxItemsKey?: string;
}

const PHASE_ROTATIONS = ['NotApplicable', 'Unknown', 'RST', 'RTS', 'SRT', 'STR', 'TRS', 'TSR'];
const CANONICAL_ROTATIONS = new Map(PHASE_ROTATIONS.map((name) => [ciKey(name), name]));

/**
 * Parse a `ConnectorPhaseRotation` value: a comma-separated list of `<connectorId>.<rotation>`,
 * e.g. `0.RST,1.RST,2.RTS` (0 is the main meter).
 */
function parsePhaseRotation(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const items: string[] = [];
  for (const part of value.split(',')) {
    const match = /^(\d+)\.([A-Za-z]+)$/.exec(part.trim());
    const rotation =
      match?.[2] === undefined ? undefined : CANONICAL_ROTATIONS.get(ciKey(match[2]));
    if (!match || rotation === undefined) return undefined;
    items.push(`${Number(match[1])}.${rotation}`);
  }
  return items.join(',');
}

/** Listener invoked after a key changed. */
export type ConfigChangeListener = (key: string, value: string) => void;

interface Entry {
  readonly definition: ConfigKeyDefinition;
  value: string;
}

/**
 * Charge point configuration as exposed through GetConfiguration/ChangeConfiguration. Keys are
 * matched case-insensitively, as CiString keys are, and values are validated and normalised per
 * type (booleans in lower case, measurand lists in canonical spelling).
 */
export class ConfigurationStore {
  readonly #entries = new Map<string, Entry>();
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

  /** Whether `key` is defined. */
  has(key: string): boolean {
    return this.#entries.has(ciKey(key));
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

  /** Parsed measurand list of `key` (empty when missing or invalid). */
  getMeasurands(key: string): MeasurandItem[] {
    return parseMeasurandList(this.get(key) ?? '') ?? [];
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
    if (entry.definition.readonly) return 'Rejected';
    const normalised = this.#normalise(entry.definition, value);
    if (normalised === undefined) return 'Rejected';
    this.set(entry.definition.key, normalised);
    return entry.definition.rebootRequired ? 'RebootRequired' : 'Accepted';
  }

  /** The value to store for `value`, or `undefined` when it is not valid for the key. */
  #normalise(definition: ConfigKeyDefinition, value: string): string | undefined {
    switch (definition.type) {
      case 'integer': {
        if (!/^-?\d+$/.test(value.trim())) return undefined;
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < (definition.min ?? -Infinity)) {
          return undefined;
        }
        return String(number);
      }
      case 'boolean':
        // Values are CiStrings, so "TRUE" is as good as "true".
        return /^(true|false)$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
      case 'measurands': {
        const items = parseMeasurandList(value);
        if (!items) return undefined;
        const max =
          definition.maxItemsKey === undefined
            ? Infinity
            : this.getInteger(definition.maxItemsKey, Infinity);
        return items.length <= max ? formatMeasurandList(items) : undefined;
      }
      case 'phaseRotation':
        return parsePhaseRotation(value);
      case 'string':
        return value;
    }
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
    const toKeyValue = ({ definition, value }: Entry): KeyValue => ({
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

/** Options of {@link defaultConfiguration}. */
export interface DefaultConfigurationOptions {
  readonly connectors: number;
  /** Wired phases, for ConnectorPhaseRotation. Default: 3. */
  readonly phases?: number;
  /** Supported feature profiles; keys of other profiles are left out. Default: all six. */
  readonly profiles?: readonly FeatureProfile[];
  readonly heartbeatIntervalS?: number;
  readonly meterValueSampleIntervalS?: number;
}

/**
 * The standard OCPP 1.6 configuration keys (chapter 9 of the specification) with simulator
 * defaults: every key the specification marks as required for the supported profiles, plus the
 * optional keys whose behaviour the simulator implements.
 */
export function defaultConfiguration(options: DefaultConfigurationOptions): ConfigKeyDefinition[] {
  const profiles = new Set(options.profiles ?? FEATURE_PROFILES);
  const rw = (
    key: string,
    value: string,
    type: ConfigValueType,
    extra: Partial<ConfigKeyDefinition> = {},
  ): ConfigKeyDefinition => ({ key, value, type, readonly: false, ...extra });
  const ro = (key: string, value: string, type: ConfigValueType): ConfigKeyDefinition => ({
    key,
    value,
    type,
    readonly: true,
  });
  const ids = Array.from({ length: options.connectors }, (_, index) => index + 1);
  const rotation = (options.phases ?? 3) === 3 ? 'RST' : 'NotApplicable';

  const core: ConfigKeyDefinition[] = [
    rw('AllowOfflineTxForUnknownId', 'false', 'boolean'),
    rw('AuthorizationCacheEnabled', 'true', 'boolean'),
    rw('AuthorizeRemoteTxRequests', 'false', 'boolean'),
    rw('ClockAlignedDataInterval', '0', 'integer', { min: 0 }),
    rw('ConnectionTimeOut', '60', 'integer', { min: 1 }),
    rw('ConnectorPhaseRotation', ids.map((id) => `${id}.${rotation}`).join(','), 'phaseRotation'),
    ro('GetConfigurationMaxKeys', '100', 'integer'),
    rw('HeartbeatInterval', String(options.heartbeatIntervalS ?? 300), 'integer', { min: 0 }),
    rw('LocalAuthorizeOffline', 'true', 'boolean'),
    rw('LocalPreAuthorize', 'false', 'boolean'),
    rw('MaxEnergyOnInvalidId', '0', 'integer', { min: 0 }),
    rw('MeterValuesAlignedData', 'Energy.Active.Import.Register', 'measurands', {
      maxItemsKey: 'MeterValuesAlignedDataMaxLength',
    }),
    ro('MeterValuesAlignedDataMaxLength', '10', 'integer'),
    rw(
      'MeterValuesSampledData',
      'Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage,SoC',
      'measurands',
      { maxItemsKey: 'MeterValuesSampledDataMaxLength' },
    ),
    ro('MeterValuesSampledDataMaxLength', '10', 'integer'),
    rw('MeterValueSampleInterval', String(options.meterValueSampleIntervalS ?? 60), 'integer', {
      min: 0,
    }),
    ro('NumberOfConnectors', String(options.connectors), 'integer'),
    rw('ResetRetries', '1', 'integer', { min: 0 }),
    rw('StopTransactionOnEVSideDisconnect', 'true', 'boolean'),
    rw('StopTransactionOnInvalidId', 'true', 'boolean'),
    rw('StopTxnAlignedData', '', 'measurands', { maxItemsKey: 'StopTxnAlignedDataMaxLength' }),
    ro('StopTxnAlignedDataMaxLength', '10', 'integer'),
    rw('StopTxnSampledData', 'Energy.Active.Import.Register', 'measurands', {
      maxItemsKey: 'StopTxnSampledDataMaxLength',
    }),
    ro('StopTxnSampledDataMaxLength', '10', 'integer'),
    ro(
      'SupportedFeatureProfiles',
      FEATURE_PROFILES.filter((profile) => profiles.has(profile)).join(','),
      'string',
    ),
    rw('TransactionMessageAttempts', '3', 'integer', { min: 1 }),
    rw('TransactionMessageRetryInterval', '10', 'integer', { min: 0 }),
    rw('UnlockConnectorOnEVSideDisconnect', 'true', 'boolean'),
    rw('WebSocketPingInterval', '0', 'integer', { min: 0, rebootRequired: true }),
  ];
  const localAuthList: ConfigKeyDefinition[] = [
    rw('LocalAuthListEnabled', 'true', 'boolean'),
    ro('LocalAuthListMaxLength', '1000', 'integer'),
    ro('SendLocalListMaxLength', '250', 'integer'),
  ];
  const reservation: ConfigKeyDefinition[] = [
    ro('ReserveConnectorZeroSupported', 'true', 'boolean'),
  ];
  const smartCharging: ConfigKeyDefinition[] = [
    ro('ChargeProfileMaxStackLevel', '8', 'integer'),
    ro('ChargingScheduleAllowedChargingRateUnit', 'Current,Power', 'string'),
    ro('ChargingScheduleMaxPeriods', '24', 'integer'),
    ro('ConnectorSwitch3to1PhaseSupported', 'false', 'boolean'),
    ro('MaxChargingProfilesInstalled', '16', 'integer'),
  ];
  return [
    ...core,
    ...(profiles.has('LocalAuthListManagement') ? localAuthList : []),
    ...(profiles.has('Reservation') ? reservation : []),
    ...(profiles.has('SmartCharging') ? smartCharging : []),
  ];
}
