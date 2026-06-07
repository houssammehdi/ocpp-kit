/** Local Auth List Management profile PDUs, written by hand from the OCPP 1.6 specification. */
import { Type, type Static } from '@sinclair/typebox';
import { AuthorizationData } from './datatypes.js';
import { EmptyObject, StringEnum, strict } from './primitives.js';

/** Whether SendLocalList replaces the whole list or applies changes to it. */
export const UpdateType = StringEnum(['Differential', 'Full']);
/** Whether SendLocalList replaces the whole list or applies changes to it. */
export type UpdateType = Static<typeof UpdateType>;

/**
 * Outcome of SendLocalList. `VersionMismatch` answers a Differential update whose version is not
 * newer than the installed list; the Central System should then send a Full update.
 */
export const UpdateStatus = StringEnum(['Accepted', 'Failed', 'NotSupported', 'VersionMismatch']);
/** Outcome of SendLocalList. */
export type UpdateStatus = Static<typeof UpdateStatus>;

/** GetLocalListVersion.req (no fields). */
export const GetLocalListVersionRequest = EmptyObject();
/** GetLocalListVersion.req payload. */
export type GetLocalListVersionRequest = Record<string, never>;
/** GetLocalListVersion.conf: 0 means the list is empty, -1 that it is not supported. */
export const GetLocalListVersionResponse = Type.Object(
  { listVersion: Type.Integer({ minimum: -1 }) },
  strict,
);
/** GetLocalListVersion.conf payload. */
export type GetLocalListVersionResponse = Static<typeof GetLocalListVersionResponse>;

/**
 * SendLocalList.req. `listVersion` is the version of the full list (Full) or of the list after
 * the changes have been applied (Differential).
 */
export const SendLocalListRequest = Type.Object(
  {
    listVersion: Type.Integer(),
    localAuthorizationList: Type.Optional(Type.Array(AuthorizationData)),
    updateType: UpdateType,
  },
  strict,
);
/** SendLocalList.req payload. */
export type SendLocalListRequest = Static<typeof SendLocalListRequest>;
/** SendLocalList.conf. */
export const SendLocalListResponse = Type.Object({ status: UpdateStatus }, strict);
/** SendLocalList.conf payload. */
export type SendLocalListResponse = Static<typeof SendLocalListResponse>;
