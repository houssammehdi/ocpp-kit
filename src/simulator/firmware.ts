import type {
  DiagnosticsStatus,
  FirmwareStatus,
  GetDiagnosticsRequest,
  GetDiagnosticsResponse,
  UpdateFirmwareRequest,
} from '../messages/index.js';

/** Schedules simulation work; everything it schedules is dropped when the charger stops. */
export interface SimulationScheduler {
  /** Run `fn` after `ms`. Returns a function that cancels it. */
  later(ms: number, fn: () => void): () => void;
}

/** How the simulator plays a firmware update. Transfers are simulated; nothing is downloaded. */
export interface FirmwareSimulationOptions {
  /** Duration of one download attempt. Default: 10 000 ms. */
  readonly downloadMs?: number;
  /** Duration of the installation. Default: 5 000 ms. */
  readonly installMs?: number;
  /** Number of download attempts that fail before one succeeds. Default: 0. */
  readonly failDownloadAttempts?: number;
  /** Make the installation fail (InstallationFailed). Default: false. */
  readonly failInstallation?: boolean;
  /** Retries when UpdateFirmware.req has no `retries`. Default: 2. */
  readonly defaultRetries?: number;
  /** Seconds between attempts when UpdateFirmware.req has no `retryInterval`. Default: 30. */
  readonly defaultRetryIntervalS?: number;
  /**
   * Firmware version reported in BootNotification after a successful update. Default: the last
   * path segment of the location, e.g. `acme-2.1.bin` for `https://fw.example.com/acme-2.1.bin`.
   */
  readonly versionFor?: (location: string) => string;
}

/** What the firmware updater needs from its charger. */
export interface FirmwareHost {
  /** Send FirmwareStatusNotification. */
  notify(status: FirmwareStatus): void;
  /**
   * Resolve once installation may start: when no transaction is running. The specification
   * recommends making idle connectors Unavailable meanwhile.
   */
  prepareInstallation(): Promise<void>;
  /** The installation failed: undo what prepareInstallation did. */
  abortInstallation(): void;
  /** Reboot into the new firmware. */
  reboot(version: string): void;
}

type FirmwarePhase = 'Idle' | 'Scheduled' | 'Downloading' | 'Downloaded' | 'Installing';

function defaultVersion(location: string): string {
  const path = location.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const segment = path.slice(path.lastIndexOf('/') + 1) || 'firmware';
  return segment.slice(0, 50);
}

/**
 * Simulates the firmware update of OCPP 1.6 section 5.19: wait for `retrieveDate`, download
 * (retrying `retries` times, `retryInterval` seconds apart; `retries` counts attempts after the
 * first), wait until no transaction is running, install, reboot, and report `Installed` once the
 * rebooted charge point has been accepted. Every step is reported with
 * FirmwareStatusNotification: Downloading, Downloaded or DownloadFailed, Installing, Installed
 * or InstallationFailed.
 *
 * A new UpdateFirmware replaces a scheduled or running download. Once the image is downloaded
 * (waiting for sessions to end, or installing) further requests are ignored.
 */
export class FirmwareUpdater {
  readonly #options: FirmwareSimulationOptions;
  readonly #host: FirmwareHost;
  readonly #scheduler: SimulationScheduler;
  #phase: FirmwarePhase = 'Idle';
  #job = 0;
  #cancel: (() => void) | undefined;
  #installedPending = false;

  constructor(
    options: FirmwareSimulationOptions,
    host: FirmwareHost,
    scheduler: SimulationScheduler,
  ) {
    this.#options = options;
    this.#host = host;
    this.#scheduler = scheduler;
  }

  /**
   * Status to report when a TriggerMessage asks for FirmwareStatusNotification: the current
   * step, or `Idle` when no update is in progress.
   */
  get triggeredStatus(): FirmwareStatus {
    switch (this.#phase) {
      case 'Downloading':
      case 'Downloaded':
      case 'Installing':
        return this.#phase;
      case 'Idle':
      case 'Scheduled':
        return 'Idle';
    }
  }

  /** Whether an installation is imminent or running, so no new session may start. */
  get blocksSessions(): boolean {
    return this.#phase === 'Downloaded' || this.#phase === 'Installing';
  }

  /** Handle UpdateFirmware.req. Returns false when the request was ignored. */
  request(request: UpdateFirmwareRequest, now = new Date()): boolean {
    if (this.#phase === 'Installing' || this.#phase === 'Downloaded') return false;
    this.#cancel?.();
    const job = ++this.#job;
    const retries = request.retries ?? this.#options.defaultRetries ?? 2;
    const retryIntervalMs =
      (request.retryInterval ?? this.#options.defaultRetryIntervalS ?? 30) * 1_000;
    const failures = this.#options.failDownloadAttempts ?? 0;
    this.#phase = 'Scheduled';
    const attempt = (number: number): void => {
      if (job !== this.#job) return;
      this.#phase = 'Downloading';
      this.#host.notify('Downloading');
      this.#cancel = this.#scheduler.later(this.#options.downloadMs ?? 10_000, () => {
        if (job !== this.#job) return;
        if (number <= failures) {
          if (number <= retries) {
            this.#cancel = this.#scheduler.later(retryIntervalMs, () => {
              attempt(number + 1);
            });
          } else {
            this.#phase = 'Idle';
            this.#host.notify('DownloadFailed');
          }
          return;
        }
        this.#phase = 'Downloaded';
        this.#host.notify('Downloaded');
        void this.#install(job, request.location);
      });
    };
    const waitMs = Math.max(0, new Date(request.retrieveDate).getTime() - now.getTime());
    this.#cancel = this.#scheduler.later(waitMs, () => {
      attempt(1);
    });
    return true;
  }

  async #install(job: number, location: string): Promise<void> {
    await this.#host.prepareInstallation();
    if (job !== this.#job) return;
    this.#phase = 'Installing';
    this.#host.notify('Installing');
    this.#cancel = this.#scheduler.later(this.#options.installMs ?? 5_000, () => {
      if (job !== this.#job) return;
      this.#phase = 'Idle';
      if (this.#options.failInstallation) {
        this.#host.notify('InstallationFailed');
        this.#host.abortInstallation();
        return;
      }
      this.#installedPending = true;
      this.#host.reboot((this.#options.versionFor ?? defaultVersion)(location));
    });
  }

  /** The rebooted charge point was accepted: report `Installed` if an update just completed. */
  onBootAccepted(): void {
    if (!this.#installedPending) return;
    this.#installedPending = false;
    this.#host.notify('Installed');
  }

  /** Abandon any scheduled or running update (e.g. when the simulation stops). */
  cancel(): void {
    this.#job++;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#phase = 'Idle';
  }
}

/** How the simulator plays a diagnostics upload. Nothing is uploaded. */
export interface DiagnosticsSimulationOptions {
  /** Duration of one upload attempt. Default: 3 000 ms. */
  readonly uploadMs?: number;
  /** Number of upload attempts that fail before one succeeds. Default: 0. */
  readonly failUploadAttempts?: number;
  /** When false, GetDiagnostics.conf carries no fileName and nothing is uploaded. Default: true. */
  readonly available?: boolean;
  /** Retries when GetDiagnostics.req has no `retries`. Default: 2. */
  readonly defaultRetries?: number;
  /** Seconds between attempts when GetDiagnostics.req has no `retryInterval`. Default: 30. */
  readonly defaultRetryIntervalS?: number;
}

/** A diagnostics file the simulator "uploaded". */
export interface DiagnosticsUpload {
  /** Upload directory from GetDiagnostics.req. */
  readonly location: string;
  readonly fileName: string;
  /** The file contents: the charger's protocol log within the requested time window. */
  readonly content: string;
  /** Number of attempts it took. */
  readonly attempts: number;
}

/** What the diagnostics uploader needs from its charger. */
export interface DiagnosticsHost {
  /** Send DiagnosticsStatusNotification. */
  notify(status: DiagnosticsStatus): void;
  /** Build the diagnostics file for the given time window. */
  collect(startTime: Date | undefined, stopTime: Date | undefined): string;
  /** The upload succeeded. */
  uploaded(upload: DiagnosticsUpload): void;
}

/**
 * Simulates GetDiagnostics (OCPP 1.6 section 5.9): answer with the name of the file that will be
 * uploaded (or without one when no diagnostics are available), then report Uploading and
 * Uploaded or UploadFailed with DiagnosticsStatusNotification, retrying `retries` times.
 * A new request replaces an upload in progress.
 */
export class DiagnosticsUploader {
  readonly #identity: string;
  readonly #options: DiagnosticsSimulationOptions;
  readonly #host: DiagnosticsHost;
  readonly #scheduler: SimulationScheduler;
  #uploading = false;
  #job = 0;
  #cancel: (() => void) | undefined;

  constructor(
    identity: string,
    options: DiagnosticsSimulationOptions,
    host: DiagnosticsHost,
    scheduler: SimulationScheduler,
  ) {
    this.#identity = identity;
    this.#options = options;
    this.#host = host;
    this.#scheduler = scheduler;
  }

  /** Status for a triggered DiagnosticsStatusNotification. */
  get triggeredStatus(): DiagnosticsStatus {
    return this.#uploading ? 'Uploading' : 'Idle';
  }

  /** Handle GetDiagnostics.req. */
  request(request: GetDiagnosticsRequest, now = new Date()): GetDiagnosticsResponse {
    this.#cancel?.();
    const job = ++this.#job;
    this.#uploading = false;
    if (this.#options.available === false) return {};
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const fileName = `${this.#identity}-diagnostics-${stamp}.log`.slice(0, 255);
    const content = this.#host.collect(
      request.startTime === undefined ? undefined : new Date(request.startTime),
      request.stopTime === undefined ? undefined : new Date(request.stopTime),
    );
    const retries = request.retries ?? this.#options.defaultRetries ?? 2;
    const retryIntervalMs =
      (request.retryInterval ?? this.#options.defaultRetryIntervalS ?? 30) * 1_000;
    const failures = this.#options.failUploadAttempts ?? 0;
    const attempt = (number: number): void => {
      if (job !== this.#job) return;
      this.#uploading = true;
      this.#host.notify('Uploading');
      this.#cancel = this.#scheduler.later(this.#options.uploadMs ?? 3_000, () => {
        if (job !== this.#job) return;
        if (number <= failures) {
          if (number <= retries) {
            this.#cancel = this.#scheduler.later(retryIntervalMs, () => {
              attempt(number + 1);
            });
            return;
          }
          this.#uploading = false;
          this.#host.notify('UploadFailed');
          return;
        }
        this.#uploading = false;
        this.#host.notify('Uploaded');
        this.#host.uploaded({ location: request.location, fileName, content, attempts: number });
      });
    };
    // The answer (with the file name) goes out before the first status notification.
    this.#cancel = this.#scheduler.later(0, () => {
      attempt(1);
    });
    return { fileName };
  }

  /** Abandon an upload in progress. */
  cancel(): void {
    this.#job++;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#uploading = false;
  }
}
