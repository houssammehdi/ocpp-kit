/**
 * The OCPP 2.0.1 Device Model: a charging station described as components (controllers such as
 * `OCPPCommCtrlr`, and physical parts such as an `EVSE` or a `Connector`) with variables. A
 * variable has up to four attributes (Actual, Target, MinSet, MaxSet), each with its own value,
 * mutability and persistence, and fixed characteristics (data type, unit, limits, allowed
 * values). GetVariables, SetVariables, GetBaseReport and GetReport all work on it.
 */
import { RpcError } from '../../rpc/errors.js';
import { DATE_TIME_PATTERN } from '../../messages/v16/primitives.js';
import type { v201 } from '../../messages/index.js';

/** Attribute kinds, as in `AttributeEnumType`. */
export type AttributeKind = v201.AttributeKind;

/** One attribute of a variable definition. */
export interface AttributeDefinition {
  /** Initial value. Omitted for a write-only secret that has no value yet. */
  readonly value?: string;
  /** Default: `ReadWrite`. */
  readonly mutability?: v201.Mutability;
  /** Survives a reboot. Default: true for writable attributes, false for read-only ones. */
  readonly persistent?: boolean;
  /** Can never change (set by the manufacturer). Default: false. */
  readonly constant?: boolean;
}

/** A variable of a component, with its attributes and characteristics. */
export interface VariableDefinition {
  readonly component: string;
  readonly componentInstance?: string;
  /** EVSE (and connector) the component belongs to. */
  readonly evse?: { readonly id: number; readonly connectorId?: number };
  readonly variable: string;
  readonly variableInstance?: string;
  readonly dataType: v201.DataKind;
  readonly unit?: string;
  readonly minLimit?: number;
  readonly maxLimit?: number;
  /** Allowed values of an OptionList, MemberList or SequenceList. */
  readonly valuesList?: readonly string[];
  /** The attributes the variable has; at least one. */
  readonly attributes: Readonly<Partial<Record<AttributeKind, AttributeDefinition>>>;
  /** SetVariables answers `RebootRequired`: the new value applies after the next boot. */
  readonly rebootRequired?: boolean;
}

/** Reads the live Actual value of a variable backed by the simulation (e.g. an EVSE's power). */
export type ValueProvider = () => string;

/** Identifies a variable: component (with instance and EVSE) and variable (with instance). */
export interface VariableRef {
  readonly component: string;
  readonly componentInstance?: string | undefined;
  readonly evse?: { readonly id: number; readonly connectorId?: number | undefined } | undefined;
  readonly variable: string;
  readonly variableInstance?: string | undefined;
}

/** Called after an attribute value changed through SetVariables or {@link DeviceModel.set}. */
export type DeviceModelListener = (
  ref: VariableRef,
  attribute: AttributeKind,
  value: string,
) => void;

interface AttributeState {
  readonly definition: AttributeDefinition;
  value: string | undefined;
  /** A SetVariables value that applies after the next reboot. */
  pending: string | undefined;
}

interface Entry {
  readonly definition: VariableDefinition;
  readonly attributes: Map<AttributeKind, AttributeState>;
  provider: ValueProvider | undefined;
}

const ci = (value: string | undefined): string => (value ?? '').toLowerCase();

function componentKey(ref: {
  readonly component: string;
  readonly componentInstance?: string | undefined;
  readonly evse?: { readonly id: number; readonly connectorId?: number | undefined } | undefined;
}): string {
  const evse = ref.evse ? `${ref.evse.id}/${ref.evse.connectorId ?? ''}` : '';
  return `${ci(ref.component)}|${ci(ref.componentInstance)}|${evse}`;
}

function variableKey(ref: VariableRef): string {
  return `${componentKey(ref)}|${ci(ref.variable)}|${ci(ref.variableInstance)}`;
}

/** The reference of a request's component and variable. */
export function refOf(component: v201.Component, variable: v201.Variable): VariableRef {
  return {
    component: component.name,
    componentInstance: component.instance,
    evse: component.evse,
    variable: variable.name,
    variableInstance: variable.instance,
  };
}

/** Component of a definition as sent on the wire. */
function wireComponent(definition: VariableDefinition): v201.Component {
  return {
    name: definition.component,
    ...(definition.componentInstance === undefined
      ? {}
      : { instance: definition.componentInstance }),
    ...(definition.evse === undefined ? {} : { evse: definition.evse }),
  };
}

/** Variable of a definition as sent on the wire. */
function wireVariable(definition: VariableDefinition): v201.Variable {
  return {
    name: definition.variable,
    ...(definition.variableInstance === undefined ? {} : { instance: definition.variableInstance }),
  };
}

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATE_TIME = new RegExp(DATE_TIME_PATTERN);

/**
 * Check `value` against a variable's characteristics. Returns the canonical value (booleans in
 * lower case, lists without spaces around the commas) or a reason why it is invalid.
 */
export function validateValue(
  definition: VariableDefinition,
  value: string,
): { readonly value: string } | { readonly invalid: string } {
  const inRange = (n: number): string | undefined => {
    if (definition.minLimit !== undefined && n < definition.minLimit) {
      return `below the minimum ${definition.minLimit}`;
    }
    if (definition.maxLimit !== undefined && n > definition.maxLimit) {
      return `above the maximum ${definition.maxLimit}`;
    }
    return undefined;
  };
  const allowed = definition.valuesList;
  const list = (): string[] =>
    value.trim() === '' ? [] : value.split(',').map((item) => item.trim());
  switch (definition.dataType) {
    case 'integer': {
      if (!INTEGER.test(value.trim())) return { invalid: 'not an integer' };
      const n = Number(value);
      const problem = inRange(n);
      return problem ? { invalid: problem } : { value: String(n) };
    }
    case 'decimal': {
      if (!DECIMAL.test(value.trim())) return { invalid: 'not a decimal' };
      const n = Number(value);
      const problem = inRange(n);
      return problem ? { invalid: problem } : { value: String(n) };
    }
    case 'boolean': {
      const lower = value.trim().toLowerCase();
      return lower === 'true' || lower === 'false'
        ? { value: lower }
        : { invalid: 'not a boolean' };
    }
    case 'dateTime':
      return DATE_TIME.test(value) ? { value } : { invalid: 'not an RFC 3339 date-time' };
    case 'string': {
      const problem = inRange(value.length);
      return problem ? { invalid: `length ${problem}` } : { value };
    }
    case 'OptionList':
      if (allowed && !allowed.includes(value))
        return { invalid: `not one of ${allowed.join(',')}` };
      return { value };
    case 'MemberList':
    case 'SequenceList': {
      const items = list();
      if (new Set(items).size !== items.length) return { invalid: 'lists an item twice' };
      const unknown = allowed ? items.filter((item) => !allowed.includes(item)) : [];
      if (unknown.length > 0) return { invalid: `${unknown.join(',')} not allowed` };
      return { value: items.join(',') };
    }
  }
}

/** Options of {@link DeviceModel}. */
export interface DeviceModelOptions {
  /**
   * Maximum number of GetVariableData or SetVariableData entries per request
   * (`DeviceDataCtrlr.ItemsPerMessage`); more is answered with a CALLERROR. Default: unlimited.
   */
  readonly itemsPerMessage?: () => number | undefined;
}

/**
 * A Device Model: the variables of a charging station, answering GetVariables, SetVariables and
 * reports. Component and variable names are compared case-insensitively.
 */
export class DeviceModel {
  readonly #entries = new Map<string, Entry>();
  readonly #components = new Set<string>();
  readonly #listeners: DeviceModelListener[] = [];
  readonly #options: DeviceModelOptions;

  constructor(definitions: readonly VariableDefinition[], options: DeviceModelOptions = {}) {
    this.#options = options;
    for (const definition of definitions) this.define(definition);
  }

  /** Add or replace a variable. */
  define(definition: VariableDefinition): void {
    const kinds = Object.keys(definition.attributes) as AttributeKind[];
    if (kinds.length === 0) {
      throw new RangeError(`${definition.component}.${definition.variable} has no attribute`);
    }
    const attributes = new Map<AttributeKind, AttributeState>();
    for (const kind of kinds) {
      const attribute = definition.attributes[kind] ?? {};
      if (attribute.value !== undefined) {
        const checked = validateValue(definition, attribute.value);
        if ('invalid' in checked) {
          throw new RangeError(
            `${definition.component}.${definition.variable} ${kind}: ${attribute.value} is ${checked.invalid}`,
          );
        }
      }
      attributes.set(kind, { definition: attribute, value: attribute.value, pending: undefined });
    }
    this.#entries.set(variableKey(definition), { definition, attributes, provider: undefined });
    this.#components.add(componentKey(definition));
  }

  /** Back the Actual value of a variable with a live reading. */
  bind(ref: VariableRef, provider: ValueProvider): void {
    const entry = this.#entry(ref);
    if (!entry) throw new RangeError(`Unknown variable ${ref.component}.${ref.variable}`);
    entry.provider = provider;
  }

  /** Subscribe to value changes. */
  onChange(listener: DeviceModelListener): void {
    this.#listeners.push(listener);
  }

  /** Every variable definition. */
  get definitions(): VariableDefinition[] {
    return [...this.#entries.values()].map((entry) => entry.definition);
  }

  /** The value of an attribute, or `undefined` when there is none (or it is write-only). */
  read(ref: VariableRef, attribute: AttributeKind = 'Actual'): string | undefined {
    const entry = this.#entry(ref);
    const state = entry?.attributes.get(attribute);
    if (!entry || !state) return undefined;
    if (attribute === 'Actual' && entry.provider) return entry.provider();
    return state.value;
  }

  /** An integer attribute, or `fallback` when missing or not a number. */
  integer(ref: VariableRef, fallback: number, attribute: AttributeKind = 'Actual'): number {
    const value = Number(this.read(ref, attribute));
    return Number.isFinite(value) ? value : fallback;
  }

  /** A boolean attribute, or `fallback` when missing. */
  boolean(ref: VariableRef, fallback: boolean, attribute: AttributeKind = 'Actual'): boolean {
    const value = this.read(ref, attribute);
    return value === undefined ? fallback : value === 'true';
  }

  /** A list attribute (MemberList, SequenceList) as its items. */
  list(ref: VariableRef, attribute: AttributeKind = 'Actual'): string[] {
    const value = this.read(ref, attribute);
    return value === undefined || value === '' ? [] : value.split(',');
  }

  /**
   * Set an attribute locally (not through SetVariables: mutability is not checked, validation
   * is). Used for values the station itself changes, e.g. the heartbeat interval from a
   * BootNotificationResponse.
   */
  set(ref: VariableRef, value: string, attribute: AttributeKind = 'Actual'): void {
    const entry = this.#entry(ref);
    const state = entry?.attributes.get(attribute);
    if (!entry || !state) throw new RangeError(`Unknown variable ${ref.component}.${ref.variable}`);
    const checked = validateValue(entry.definition, value);
    if ('invalid' in checked) throw new RangeError(`${value} is ${checked.invalid}`);
    this.#store(entry, state, attribute, checked.value);
  }

  /** Handle GetVariablesRequest. */
  getVariables(request: v201.GetVariablesRequest): v201.GetVariablesResponse {
    this.#checkItems(request.getVariableData.length);
    return {
      getVariableResult: request.getVariableData.map(
        ({ component, variable, attributeType }): v201.GetVariableResult => {
          const attribute = attributeType ?? 'Actual';
          const base = {
            component,
            variable,
            ...(attributeType === undefined ? {} : { attributeType }),
          };
          const ref = refOf(component, variable);
          const entry = this.#entry(ref);
          if (!entry) {
            return {
              ...base,
              attributeStatus: this.#components.has(componentKey(ref))
                ? 'UnknownVariable'
                : 'UnknownComponent',
            };
          }
          const state = entry.attributes.get(attribute);
          if (!state) return { ...base, attributeStatus: 'NotSupportedAttributeType' };
          if (state.definition.mutability === 'WriteOnly') {
            return {
              ...base,
              attributeStatus: 'Rejected',
              attributeStatusInfo: { reasonCode: 'WriteOnly' },
            };
          }
          const value = this.read(ref, attribute);
          return {
            ...base,
            attributeStatus: 'Accepted',
            ...(value === undefined ? {} : { attributeValue: value }),
          };
        },
      ),
    };
  }

  /** Handle SetVariablesRequest. Each entry is applied (or refused) on its own. */
  setVariables(request: v201.SetVariablesRequest): v201.SetVariablesResponse {
    this.#checkItems(request.setVariableData.length);
    return {
      setVariableResult: request.setVariableData.map(
        ({ component, variable, attributeType, attributeValue }): v201.SetVariableResult => {
          const attribute = attributeType ?? 'Actual';
          const base = {
            component,
            variable,
            ...(attributeType === undefined ? {} : { attributeType }),
          };
          const ref = refOf(component, variable);
          const entry = this.#entry(ref);
          if (!entry) {
            return {
              ...base,
              attributeStatus: this.#components.has(componentKey(ref))
                ? 'UnknownVariable'
                : 'UnknownComponent',
            };
          }
          const state = entry.attributes.get(attribute);
          if (!state) return { ...base, attributeStatus: 'NotSupportedAttributeType' };
          const rejected = (
            reasonCode: string,
            additionalInfo?: string,
          ): v201.SetVariableResult => ({
            ...base,
            attributeStatus: 'Rejected',
            attributeStatusInfo: {
              reasonCode,
              ...(additionalInfo === undefined ? {} : { additionalInfo }),
            },
          });
          const { mutability = 'ReadWrite', constant = false } = state.definition;
          if (mutability === 'ReadOnly' || constant) return rejected('ReadOnly');
          const checked = validateValue(entry.definition, attributeValue);
          if ('invalid' in checked) return rejected('InvalidValue', checked.invalid);
          if (entry.definition.rebootRequired) {
            state.pending = checked.value;
            return { ...base, attributeStatus: 'RebootRequired' };
          }
          this.#store(entry, state, attribute, checked.value);
          return { ...base, attributeStatus: 'Accepted' };
        },
      ),
    };
  }

  /**
   * The report data of GetBaseReport:
   *
   * - `FullInventory`: every variable;
   * - `ConfigurationInventory`: the variables with a writable attribute;
   * - `SummaryInventory`: the availability and problem state of the components
   *   (`AvailabilityState`, `Available`, `Problem`).
   */
  baseReport(base: v201.ReportBase): v201.ReportData[] {
    const entries = [...this.#entries.values()].filter((entry) => {
      switch (base) {
        case 'FullInventory':
          return true;
        case 'ConfigurationInventory':
          return [...entry.attributes.values()].some(
            (state) => (state.definition.mutability ?? 'ReadWrite') !== 'ReadOnly',
          );
        case 'SummaryInventory':
          return ['availabilitystate', 'available', 'problem'].includes(
            ci(entry.definition.variable),
          );
      }
    });
    return entries.map((entry) => this.#reportData(entry));
  }

  /**
   * The report data of GetReport: the listed components (all variables, or the one given) that
   * meet every criterion. `Enabled`, `Available` and `Active` read the component's variable of
   * that name (a component without it counts as meeting the criterion); `Problem` selects
   * components whose `Problem` variable is true.
   */
  customReport(
    componentVariable: readonly v201.ComponentVariable[] | undefined,
    criteria: readonly v201.ComponentCriterion[] | undefined,
  ): v201.ReportData[] {
    const selected = [...this.#entries.values()].filter((entry) => {
      const { definition } = entry;
      if (componentVariable) {
        const listed = componentVariable.some(
          ({ component, variable }) =>
            componentKey(definition) ===
              componentKey({
                component: component.name,
                componentInstance: component.instance,
                evse: component.evse,
              }) &&
            (variable === undefined ||
              (ci(variable.name) === ci(definition.variable) &&
                ci(variable.instance) === ci(definition.variableInstance))),
        );
        if (!listed) return false;
      }
      for (const criterion of criteria ?? []) {
        const flag = this.read({ ...definition, variable: criterion, variableInstance: undefined });
        if (criterion === 'Problem' ? flag !== 'true' : flag === 'false') return false;
      }
      return true;
    });
    return selected.map((entry) => this.#reportData(entry));
  }

  /**
   * A reboot: attributes that are not persistent return to their initial value, and values
   * that were set with `RebootRequired` take effect.
   */
  reboot(): void {
    for (const entry of this.#entries.values()) {
      for (const [kind, state] of entry.attributes) {
        const { mutability = 'ReadWrite' } = state.definition;
        const persistent = state.definition.persistent ?? mutability !== 'ReadOnly';
        if (state.pending !== undefined) {
          const pending = state.pending;
          state.pending = undefined;
          this.#store(entry, state, kind, pending);
        } else if (!persistent && state.value !== state.definition.value) {
          state.value = state.definition.value;
        }
      }
    }
  }

  #checkItems(count: number): void {
    const limit = this.#options.itemsPerMessage?.();
    if (limit !== undefined && limit > 0 && count > limit) {
      throw new RpcError(
        'OccurrenceConstraintViolation',
        `At most ${limit} items per message (DeviceDataCtrlr.ItemsPerMessage)`,
      );
    }
  }

  #entry(ref: VariableRef): Entry | undefined {
    return this.#entries.get(variableKey(ref));
  }

  #store(entry: Entry, state: AttributeState, attribute: AttributeKind, value: string): void {
    if (state.value === value) return;
    state.value = value;
    for (const listener of this.#listeners) listener(entry.definition, attribute, value);
  }

  #reportData(entry: Entry): v201.ReportData {
    const { definition } = entry;
    const variableAttribute = [...entry.attributes].map(([kind, state]): v201.VariableAttribute => {
      const mutability = state.definition.mutability ?? 'ReadWrite';
      const value =
        mutability === 'WriteOnly' ? undefined : this.read(definition, kind)?.slice(0, 2_500);
      return {
        type: kind,
        ...(value === undefined ? {} : { value }),
        mutability,
        persistent: state.definition.persistent ?? mutability !== 'ReadOnly',
        constant: state.definition.constant ?? false,
      };
    });
    return {
      component: wireComponent(definition),
      variable: wireVariable(definition),
      variableAttribute,
      variableCharacteristics: {
        dataType: definition.dataType,
        supportsMonitoring: false,
        ...(definition.unit === undefined ? {} : { unit: definition.unit }),
        ...(definition.minLimit === undefined ? {} : { minLimit: definition.minLimit }),
        ...(definition.maxLimit === undefined ? {} : { maxLimit: definition.maxLimit }),
        ...(definition.valuesList === undefined
          ? {}
          : { valuesList: definition.valuesList.join(',').slice(0, 1_000) }),
      },
    };
  }
}
