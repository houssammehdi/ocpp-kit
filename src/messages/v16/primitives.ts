import { Type, type TLiteral, type TString, type TUnion, type TInteger } from '@sinclair/typebox';

/** Options shared by every PDU object: OCPP 1.6 JSON schemas forbid undeclared properties. */
export const strict = { additionalProperties: false } as const;

/** Case-insensitive string with a maximum length (`CiStringNType` in the specification). */
export function CiString(maxLength: number): TString {
  return Type.String({ maxLength });
}

type LiteralTuple<T extends readonly string[]> = { -readonly [K in keyof T]: TLiteral<T[K]> };

/** A string enumeration, statically typed as a union of string literals. */
export function StringEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  description?: string,
): TUnion<LiteralTuple<T>> {
  const literals = values.map((value) => Type.Literal(value));
  return Type.Union(
    literals,
    description === undefined ? {} : { description },
  ) as unknown as TUnion<LiteralTuple<T>>;
}

/** RFC 3339 / ISO 8601 date-time with an explicit offset, e.g. `2026-01-31T12:00:00.000Z`. */
export const DATE_TIME_PATTERN =
  '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])[Tt]([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?([Zz]|[+-]([01]\\d|2[0-3]):[0-5]\\d)$';

/** `dateTime` as used throughout OCPP 1.6. */
export function DateTime(description?: string): TString {
  return Type.String({
    pattern: DATE_TIME_PATTERN,
    ...(description === undefined ? {} : { description }),
  });
}

/** Integer >= 0. */
export function NonNegativeInteger(description?: string): TInteger {
  return Type.Integer({ minimum: 0, ...(description === undefined ? {} : { description }) });
}

/** Integer >= 1. */
export function PositiveInteger(description?: string): TInteger {
  return Type.Integer({ minimum: 1, ...(description === undefined ? {} : { description }) });
}
