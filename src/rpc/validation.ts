import type { Static, TSchema } from '@sinclair/typebox';
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';
import { ValueErrorType, type ValueError } from '@sinclair/typebox/errors';
import { RpcError, type OcppErrorCode } from './errors.js';

/** Request/response schema pair describing one OCPP action. */
export interface ActionSchema {
  readonly request: TSchema;
  readonly response: TSchema;
}

/** A catalogue of actions a peer can send or receive, keyed by action name. */
export type ActionSchemaMap = Readonly<Record<string, ActionSchema>>;

/** Action names contained in a catalogue. */
export type ActionName<M extends ActionSchemaMap> = keyof M & string;

/** Static request payload type of action `A`. */
export type RequestOf<M extends ActionSchemaMap, A extends ActionName<M>> = Static<M[A]['request']>;

/** Static response payload type of action `A`. */
export type ResponseOf<M extends ActionSchemaMap, A extends ActionName<M>> = Static<
  M[A]['response']
>;

/** A single schema violation, as reported in CALLERROR `errorDetails.errors`. */
export interface ValidationIssue {
  /** JSON pointer to the offending value, e.g. `/idTagInfo/status`. */
  readonly path: string;
  readonly message: string;
  readonly code: OcppErrorCode;
}

/** Maximum number of issues copied into error details, to keep CALLERROR frames small. */
const MAX_REPORTED_ISSUES = 10;

const compiled = new WeakMap<TSchema, TypeCheck<TSchema>>();

function checker(schema: TSchema): TypeCheck<TSchema> {
  let check = compiled.get(schema);
  if (!check) {
    check = TypeCompiler.Compile(schema);
    compiled.set(schema, check);
  }
  return check;
}

/** Codes ordered from most to least structural; the first matching one wins. */
const PRIORITY: readonly OcppErrorCode[] = [
  'FormationViolation',
  'OccurenceConstraintViolation',
  'TypeConstraintViolation',
  'PropertyConstraintViolation',
];

/** A union made only of literals of the same primitive type behaves like a JSON Schema enum. */
function isEnumOfSameType(schema: TSchema, value: unknown): boolean {
  const variants: unknown = schema.anyOf;
  if (!Array.isArray(variants) || variants.length === 0) return false;
  return variants.every(
    (variant: unknown) =>
      typeof variant === 'object' &&
      variant !== null &&
      'const' in variant &&
      typeof variant.const === typeof value,
  );
}

/**
 * Map a single TypeBox validation error onto the OCPP error code whose definition matches:
 *
 * - `OccurenceConstraintViolation`: required field missing, array too short/long
 * - `TypeConstraintViolation`: value of the wrong JSON type (e.g. string instead of integer)
 * - `PropertyConstraintViolation`: right type but invalid value (length, range, enum, pattern)
 * - `FormationViolation`: property not defined by the PDU (`additionalProperties: false`)
 */
export function errorCodeFor(error: ValueError): OcppErrorCode {
  switch (error.type) {
    case ValueErrorType.ObjectRequiredProperty:
    case ValueErrorType.ArrayMinItems:
    case ValueErrorType.ArrayMaxItems:
    case ValueErrorType.ObjectMinProperties:
    case ValueErrorType.ObjectMaxProperties:
    case ValueErrorType.TupleLength:
      return 'OccurenceConstraintViolation';
    case ValueErrorType.ObjectAdditionalProperties:
      return 'FormationViolation';
    case ValueErrorType.StringMaxLength:
    case ValueErrorType.StringMinLength:
    case ValueErrorType.StringPattern:
    case ValueErrorType.StringFormat:
    case ValueErrorType.NumberMinimum:
    case ValueErrorType.NumberMaximum:
    case ValueErrorType.NumberExclusiveMinimum:
    case ValueErrorType.NumberExclusiveMaximum:
    case ValueErrorType.NumberMultipleOf:
    case ValueErrorType.IntegerMinimum:
    case ValueErrorType.IntegerMaximum:
    case ValueErrorType.IntegerExclusiveMinimum:
    case ValueErrorType.IntegerExclusiveMaximum:
    case ValueErrorType.IntegerMultipleOf:
    case ValueErrorType.ArrayUniqueItems:
      return 'PropertyConstraintViolation';
    case ValueErrorType.Literal:
      return typeof error.schema.const === typeof error.value
        ? 'PropertyConstraintViolation'
        : 'TypeConstraintViolation';
    case ValueErrorType.Union:
      return isEnumOfSameType(error.schema, error.value)
        ? 'PropertyConstraintViolation'
        : 'TypeConstraintViolation';
    default:
      return 'TypeConstraintViolation';
  }
}

/** Collect every schema violation of `value`. Returns an empty array when the value is valid. */
export function collectIssues(schema: TSchema, value: unknown): ValidationIssue[] {
  const check = checker(schema);
  if (check.Check(value)) return [];
  return [...check.Errors(value)].map((error) => ({
    path: error.path || '/',
    message: error.message,
    code: errorCodeFor(error),
  }));
}

/**
 * Validate `value` against `schema`.
 *
 * @returns `undefined` when valid, otherwise an {@link RpcError} whose code is the most structural
 *   violation found and whose details list the individual issues.
 */
export function validatePayload(
  schema: TSchema,
  value: unknown,
  label = 'Payload',
): RpcError | undefined {
  const issues = collectIssues(schema, value);
  if (issues.length === 0) return undefined;
  const code = PRIORITY.find((candidate) => issues.some((issue) => issue.code === candidate));
  const primary = issues.find((issue) => issue.code === code) ?? issues[0];
  const resolvedCode = code ?? 'FormationViolation';
  return new RpcError(
    resolvedCode,
    `${label} is invalid: ${primary ? `${primary.path} ${primary.message}` : 'schema mismatch'}`,
    {
      errors: issues.slice(0, MAX_REPORTED_ISSUES).map(({ path, message }) => ({ path, message })),
    },
  );
}
