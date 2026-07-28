/**
 * Simulated firmware updates (use cases L01 secure and L02 non-secure update) and log uploads
 * (N01) of an OCPP 2.0.1 station. Nothing is transferred; the status sequences, retries,
 * schedules and failures are played out with timers.
 */
import type { v201 } from '../../messages/index.js';
import type { SimulationScheduler } from '../firmware.js';

/** How the simulator plays a 2.0.1 firmware update. */
export interface FirmwareSimulation201Options {
  /** Duration of one download attempt. Default: 10 000 ms. */
  readonly downloadMs?: number;
  /** Duration of the installation. Default: 5 000 ms. */
  readonly installMs?: number;
  /** Number of download attempts that fail before one succeeds. Default: 0. */
  readonly failDownloadAttempts?: number;
  /** Make the signature check fail (InvalidSignature) when the request carries a signature. */
  readonly failSignature?: boolean;
  /** Make the installation fail (InstallationFailed). Default: false. */
  readonly failInstallation?: boolean;
  /** Firmware version after a successful update. Default: last path segment of the location. */
  readonly versionFor?: (location: string) => string;
}

/** What the firmware updater needs from its station. */
export interface FirmwareHost201 {
  /** Send FirmwareStatusNotification. */
  notify(status: v201.FirmwareStatus, requestId: number | undefined): void;
  /** Resolve once no transaction runs (installation must not interrupt charging). */
  prepareInstallation(): Promise<void>;
  /** The installation failed or was cancelled: undo what prepareInstallation did. */
  abortInstallation(): void;
  /** Reboot into the new firmware. */
  reboot(version: string): void;
}

type Phase =
  'Idle' | 'DownloadScheduled' | 'Downloading' | 'Downloaded' | 'InstallScheduled' | 'Installing';

function defaultVersion(location: string): string {
  const path = location.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return (path.slice(path.lastIndexOf('/') + 1) || 'firmware').slice(0, 50);
}

/**
 * Plays an UpdateFirmware request: DownloadScheduled (when `retrieveDateTime` is in the future),
 * Downloading, Downloaded or DownloadFailed (after `retries` further attempts `retryInterval`
 * seconds apart), SignatureVerified or InvalidSignature (when the request has a signature),
 * InstallScheduled (when `installDateTime` is in the future), Installing once no transaction
 * runs, InstallRebooting, and after the reboot Installed or InstallationFailed. Every
 * notification carries the request's `requestId`.
 *
 * A new request while one is downloading or scheduled cancels it and is answered
 * `AcceptedCanceled`; while installing it is `Rejected`.
 */
export class FirmwareUpdater201 {
  readonly #options: FirmwareSimulation201Options;
  readonly #host: FirmwareHost201;
  readonly #scheduler: SimulationScheduler;
  #phase: Phase = 'Idle';
  #job = 0;
  #requestId: number | undefined;
  #cancel: (() => void) | undefined;
  /** requestId of an installation that rebooted and waits for the new boot to be accepted. */
  #installedPending: number | undefined;

  constructor(
    options: FirmwareSimulation201Options,
    host: FirmwareHost201,
    scheduler: SimulationScheduler,
  ) {
    this.#options = options;
    this.#host = host;
    this.#scheduler = scheduler;
  }

  /** Status reported to a TriggerMessage for FirmwareStatusNotification, and its request. */
  get triggered(): { readonly status: v201.FirmwareStatus; readonly requestId?: number } {
    const status: v201.FirmwareStatus = this.#phase;
    return this.#phase === 'Idle' || this.#requestId === undefined
      ? { status }
      : { status, requestId: this.#requestId };
  }

  /** Whether an installation is imminent or running, so no new session should start. */
  get blocksSessions(): boolean {
    return this.#phase === 'Installing';
  }

  /** Handle UpdateFirmwareRequest. */
  request(request: v201.UpdateFirmwareRequest, now = new Date()): v201.UpdateFirmwareStatus {
    if (this.#phase === 'Installing') return 'Rejected';
    const canceled = this.#phase !== 'Idle';
    if (canceled) {
      this.#cancel?.();
      this.#host.abortInstallation();
    }
    const job = ++this.#job;
    const { firmware, requestId } = request;
    this.#requestId = requestId;
    const retries = request.retries ?? 0;
    const retryIntervalMs = (request.retryInterval ?? 30) * 1_000;
    const failures = this.#options.failDownloadAttempts ?? 0;
    const alive = (): boolean => job === this.#job;
    const later = (ms: number, fn: () => void): void => {
      this.#cancel = this.#scheduler.later(ms, () => {
        if (alive()) fn();
      });
    };
    const notify = (status: v201.FirmwareStatus): void => {
      this.#host.notify(status, requestId);
    };

    const install = (): void => {
      this.#phase = 'Installing';
      void this.#host.prepareInstallation().then(() => {
        if (!alive()) return;
        notify('Installing');
        later(this.#options.installMs ?? 5_000, () => {
          if (this.#options.failInstallation) {
            this.#phase = 'Idle';
            notify('InstallationFailed');
            this.#host.abortInstallation();
            return;
          }
          notify('InstallRebooting');
          this.#phase = 'Idle';
          this.#installedPending = requestId;
          this.#host.reboot((this.#options.versionFor ?? defaultVersion)(firmware.location));
        });
      });
    };
    const downloaded = (): void => {
      this.#phase = 'Downloaded';
      notify('Downloaded');
      if (firmware.signature !== undefined) {
        if (this.#options.failSignature) {
          this.#phase = 'Idle';
          notify('InvalidSignature');
          return;
        }
        notify('SignatureVerified');
      }
      const installAt = firmware.installDateTime ? Date.parse(firmware.installDateTime) : 0;
      const wait = installAt - Date.now();
      if (wait > 0) {
        this.#phase = 'InstallScheduled';
        notify('InstallScheduled');
        later(wait, install);
      } else {
        install();
      }
    };
    const attempt = (number: number): void => {
      this.#phase = 'Downloading';
      notify('Downloading');
      later(this.#options.downloadMs ?? 10_000, () => {
        if (number < failures) {
          if (number < retries) {
            later(retryIntervalMs, () => {
              attempt(number + 1);
            });
          } else {
            this.#phase = 'Idle';
            notify('DownloadFailed');
          }
          return;
        }
        downloaded();
      });
    };
    const startIn = Date.parse(firmware.retrieveDateTime) - now.getTime();
    if (startIn > 0) {
      this.#phase = 'DownloadScheduled';
      notify('DownloadScheduled');
      later(startIn, () => {
        attempt(0);
      });
    } else {
      // Start after the response has been sent.
      later(0, () => {
        attempt(0);
      });
    }
    return canceled ? 'AcceptedCanceled' : 'Accepted';
  }

  /** The rebooted station was accepted: report the installation as done. */
  onBootAccepted(): void {
    const requestId = this.#installedPending;
    if (requestId === undefined) return;
    this.#installedPending = undefined;
    this.#host.notify('Installed', requestId);
  }

  /** Stop everything (the station stops). */
  cancel(): void {
    this.#job++;
    this.#cancel?.();
    this.#phase = 'Idle';
  }
}

/** How the simulator plays log uploads. */
export interface LogSimulationOptions {
  /** Duration of one upload attempt. Default: 3 000 ms. */
  readonly uploadMs?: number;
  /** Number of upload attempts that fail before one succeeds. Default: 0. */
  readonly failUploadAttempts?: number;
}

/** A log file the simulator "uploaded". */
export interface LogUpload {
  readonly requestId: number;
  readonly logType: v201.LogKind;
  readonly remoteLocation: string;
  readonly filename: string;
  readonly content: string;
}

/** What the log uploader needs from its station. */
export interface LogHost {
  notify(status: v201.UploadLogStatus, requestId: number | undefined): void;
  /** The log lines of a kind within a time window. */
  collect(logType: v201.LogKind, oldest: Date | undefined, latest: Date | undefined): string;
  uploaded(upload: LogUpload): void;
}

/**
 * Plays GetLog: Uploading, then Uploaded, or UploadFailure after `retries` further attempts.
 * A new request while an upload runs cancels it (its requestId gets `AcceptedCanceled`) and is
 * answered `AcceptedCanceled`.
 */
export class LogUploader {
  readonly #identity: string;
  readonly #options: LogSimulationOptions;
  readonly #host: LogHost;
  readonly #scheduler: SimulationScheduler;
  #job = 0;
  #active: number | undefined;
  #cancel: (() => void) | undefined;

  constructor(
    identity: string,
    options: LogSimulationOptions,
    host: LogHost,
    scheduler: SimulationScheduler,
  ) {
    this.#identity = identity;
    this.#options = options;
    this.#host = host;
    this.#scheduler = scheduler;
  }

  /** Status reported to a TriggerMessage for LogStatusNotification. */
  get triggered(): { readonly status: v201.UploadLogStatus; readonly requestId?: number } {
    return this.#active === undefined
      ? { status: 'Idle' }
      : { status: 'Uploading', requestId: this.#active };
  }

  /** Handle GetLogRequest. */
  request(request: v201.GetLogRequest, now = new Date()): v201.GetLogResponse {
    const canceled = this.#active;
    if (canceled !== undefined) {
      this.#cancel?.();
      this.#host.notify('AcceptedCanceled', canceled);
    }
    const job = ++this.#job;
    const { requestId, logType, log } = request;
    this.#active = requestId;
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const kind = logType === 'SecurityLog' ? 'security' : 'diagnostics';
    const filename = `${this.#identity}-${kind}-${stamp}.log`.slice(0, 255);
    const retries = request.retries ?? 0;
    const retryIntervalMs = (request.retryInterval ?? 30) * 1_000;
    const failures = this.#options.failUploadAttempts ?? 0;
    const attempt = (number: number): void => {
      if (job !== this.#job) return;
      this.#host.notify('Uploading', requestId);
      this.#cancel = this.#scheduler.later(this.#options.uploadMs ?? 3_000, () => {
        if (job !== this.#job) return;
        if (number < failures) {
          if (number < retries) {
            this.#cancel = this.#scheduler.later(retryIntervalMs, () => {
              attempt(number + 1);
            });
          } else {
            this.#active = undefined;
            this.#host.notify('UploadFailure', requestId);
          }
          return;
        }
        this.#active = undefined;
        const oldest =
          log.oldestTimestamp === undefined ? undefined : new Date(log.oldestTimestamp);
        const latest =
          log.latestTimestamp === undefined ? undefined : new Date(log.latestTimestamp);
        this.#host.uploaded({
          requestId,
          logType,
          remoteLocation: log.remoteLocation,
          filename,
          content: this.#host.collect(logType, oldest, latest),
        });
        this.#host.notify('Uploaded', requestId);
      });
    };
    this.#cancel = this.#scheduler.later(0, () => {
      attempt(0);
    });
    return { status: canceled === undefined ? 'Accepted' : 'AcceptedCanceled', filename };
  }

  /** Stop everything (the station stops). */
  cancel(): void {
    this.#job++;
    this.#cancel?.();
    this.#active = undefined;
  }
}
