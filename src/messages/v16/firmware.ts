/** Firmware Management profile PDUs, written by hand from the OCPP 1.6 specification. */
import { Type, type Static } from '@sinclair/typebox';
import {
  AnyUri,
  CiString,
  DateTime,
  EmptyObject,
  NonNegativeInteger,
  StringEnum,
  strict,
} from './primitives.js';

/**
 * Progress of a diagnostics upload. `Idle` is only sent in answer to a TriggerMessage, when no
 * upload is in progress.
 */
export const DiagnosticsStatus = StringEnum(['Idle', 'Uploaded', 'UploadFailed', 'Uploading']);
/** Progress of a diagnostics upload. */
export type DiagnosticsStatus = Static<typeof DiagnosticsStatus>;

/**
 * Progress of a firmware update. `Idle` is only sent in answer to a TriggerMessage, when no
 * update is in progress.
 */
export const FirmwareStatus = StringEnum([
  'Downloaded',
  'DownloadFailed',
  'Downloading',
  'Idle',
  'InstallationFailed',
  'Installing',
  'Installed',
]);
/** Progress of a firmware update. */
export type FirmwareStatus = Static<typeof FirmwareStatus>;

/**
 * GetDiagnostics.req: upload a diagnostics file to `location`, optionally limited to log
 * entries between `startTime` and `stopTime`.
 */
export const GetDiagnosticsRequest = Type.Object(
  {
    location: AnyUri('Directory the diagnostics file is uploaded to'),
    retries: Type.Optional(NonNegativeInteger('How often to retry a failed upload')),
    retryInterval: Type.Optional(NonNegativeInteger('Seconds between upload attempts')),
    startTime: Type.Optional(DateTime()),
    stopTime: Type.Optional(DateTime()),
  },
  strict,
);
/** GetDiagnostics.req payload. */
export type GetDiagnosticsRequest = Static<typeof GetDiagnosticsRequest>;
/** GetDiagnostics.conf: the name of the file that will be uploaded; absent when none exists. */
export const GetDiagnosticsResponse = Type.Object(
  { fileName: Type.Optional(CiString(255)) },
  strict,
);
/** GetDiagnostics.conf payload. */
export type GetDiagnosticsResponse = Static<typeof GetDiagnosticsResponse>;

/** DiagnosticsStatusNotification.req. */
export const DiagnosticsStatusNotificationRequest = Type.Object(
  { status: DiagnosticsStatus },
  strict,
);
/** DiagnosticsStatusNotification.req payload. */
export type DiagnosticsStatusNotificationRequest = Static<
  typeof DiagnosticsStatusNotificationRequest
>;
/** DiagnosticsStatusNotification.conf (no fields). */
export const DiagnosticsStatusNotificationResponse = EmptyObject();
/** DiagnosticsStatusNotification.conf payload. */
export type DiagnosticsStatusNotificationResponse = Record<string, never>;

/** FirmwareStatusNotification.req. */
export const FirmwareStatusNotificationRequest = Type.Object({ status: FirmwareStatus }, strict);
/** FirmwareStatusNotification.req payload. */
export type FirmwareStatusNotificationRequest = Static<typeof FirmwareStatusNotificationRequest>;
/** FirmwareStatusNotification.conf (no fields). */
export const FirmwareStatusNotificationResponse = EmptyObject();
/** FirmwareStatusNotification.conf payload. */
export type FirmwareStatusNotificationResponse = Record<string, never>;

/**
 * UpdateFirmware.req: download the firmware at `location` from `retrieveDate` on and install it.
 * Progress is reported with FirmwareStatusNotification.
 */
export const UpdateFirmwareRequest = Type.Object(
  {
    location: AnyUri('Where to download the firmware from'),
    retries: Type.Optional(NonNegativeInteger('How often to retry a failed download')),
    retrieveDate: DateTime(),
    retryInterval: Type.Optional(NonNegativeInteger('Seconds between download attempts')),
  },
  strict,
);
/** UpdateFirmware.req payload. */
export type UpdateFirmwareRequest = Static<typeof UpdateFirmwareRequest>;
/** UpdateFirmware.conf (no fields). */
export const UpdateFirmwareResponse = EmptyObject();
/** UpdateFirmware.conf payload. */
export type UpdateFirmwareResponse = Record<string, never>;
