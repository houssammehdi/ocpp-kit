/**
 * Building blocks of the OCPP 2.0.1 schemas. The date-time and enumeration helpers are the ones
 * the OCPP 1.6 catalogue uses; what is new is `customData`, which every 2.0.1 object carries.
 */
import {
  Type,
  type Static,
  type TObject,
  type TOptional,
  type TProperties,
  type TString,
} from '@sinclair/typebox';

export { DateTime, StringEnum } from '../v16/primitives.js';

/**
 * `CustomDataType`: vendor extensions. Every OCPP 2.0.1 object may carry it, and it is the only
 * object that accepts properties it does not declare.
 */
export const CustomData = Type.Object(
  { vendorId: Type.String({ maxLength: 255 }) },
  { additionalProperties: true },
);
/** Vendor-specific data attached to any OCPP 2.0.1 object. */
export type CustomData = Static<typeof CustomData>;

/** The properties of `P` plus the optional `customData` of every OCPP 2.0.1 object. */
export type WithCustomData<P extends TProperties> = P & {
  customData: TOptional<typeof CustomData>;
};

/**
 * An OCPP 2.0.1 object type: the given properties, an optional `customData`, and no other
 * properties (`additionalProperties: false`, like the official schemas).
 */
export function Obj<P extends TProperties>(
  properties: P,
  description?: string,
): TObject<WithCustomData<P>> {
  return Type.Object(
    { customData: Type.Optional(CustomData), ...properties },
    { additionalProperties: false, ...(description === undefined ? {} : { description }) },
  );
}

/** A PDU with no fields besides `customData`, e.g. `HeartbeatRequest`. */
export function EmptyPdu(): TObject<{ customData: TOptional<typeof CustomData> }> {
  return Obj({});
}

/** A string of at most `maxLength` characters (the 2.0.1 `string[0..n]` fields). */
export function Str(maxLength: number, description?: string): TString {
  return Type.String({ maxLength, ...(description === undefined ? {} : { description }) });
}
