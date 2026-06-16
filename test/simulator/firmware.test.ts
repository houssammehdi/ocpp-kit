import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DiagnosticsUploader,
  FirmwareUpdater,
  type DiagnosticsSimulationOptions,
  type DiagnosticsStatus,
  type DiagnosticsUpload,
  type FirmwareSimulationOptions,
  type FirmwareStatus,
  type SimulationScheduler,
} from '../../src/index.js';

const T0 = new Date('2026-05-01T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

const scheduler: SimulationScheduler = {
  later: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function updater(options: FirmwareSimulationOptions = {}) {
  const statuses: FirmwareStatus[] = [];
  const reboots: string[] = [];
  let releaseInstall: (() => void) | undefined;
  const host = {
    notify: (status: FirmwareStatus) => statuses.push(status),
    prepareInstallation: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseInstall = resolve;
        }),
    ),
    abortInstallation: vi.fn(),
    reboot: (version: string) => reboots.push(version),
  };
  const firmware = new FirmwareUpdater(
    { downloadMs: 1_000, installMs: 500, ...options },
    host,
    scheduler,
  );
  return { firmware, statuses, reboots, host, release: () => releaseInstall?.() };
}

const request = {
  location: 'https://fw.example.com/releases/acme-2.1.bin?token=x',
  retrieveDate: T0.toISOString(),
};

describe('FirmwareUpdater', () => {
  it('downloads, waits for sessions to end, installs, reboots and reports Installed', async () => {
    const { firmware, statuses, reboots, host, release } = updater();
    expect(firmware.triggeredStatus).toBe('Idle');
    expect(firmware.request(request)).toBe(true);
    await advance(0);
    expect(statuses).toEqual(['Downloading']);
    expect(firmware.triggeredStatus).toBe('Downloading');
    await advance(1_000);
    expect(statuses).toEqual(['Downloading', 'Downloaded']);
    expect(host.prepareInstallation).toHaveBeenCalledOnce();
    expect(firmware.blocksSessions).toBe(true);
    expect(firmware.request(request)).toBe(false); // ignored once downloaded
    await advance(5_000);
    expect(statuses).toHaveLength(2); // still waiting for the last session to end
    release();
    await advance(0);
    expect(statuses.at(-1)).toBe('Installing');
    expect(firmware.triggeredStatus).toBe('Installing');
    await advance(500);
    expect(reboots).toEqual(['acme-2.1.bin']);
    expect(firmware.triggeredStatus).toBe('Idle');
    firmware.onBootAccepted();
    firmware.onBootAccepted();
    expect(statuses).toEqual(['Downloading', 'Downloaded', 'Installing', 'Installed']);
  });

  it('starts at retrieveDate', async () => {
    const { firmware, statuses } = updater();
    firmware.request({ ...request, retrieveDate: new Date(T0.getTime() + 60_000).toISOString() });
    await advance(59_999);
    expect(statuses).toEqual([]);
    await advance(1);
    expect(statuses).toEqual(['Downloading']);
  });

  it('retries failed downloads retries times, retryInterval apart', async () => {
    const { firmware, statuses } = updater({ failDownloadAttempts: 2 });
    firmware.request({ ...request, retries: 2, retryInterval: 10 });
    await advance(0);
    await advance(1_000); // attempt 1 fails
    await advance(10_000);
    await advance(1_000); // attempt 2 fails
    expect(statuses).toEqual(['Downloading', 'Downloading']);
    await advance(10_000);
    await advance(1_000); // attempt 3 succeeds
    expect(statuses).toEqual(['Downloading', 'Downloading', 'Downloading', 'Downloaded']);
  });

  it('reports DownloadFailed once the retries are exhausted', async () => {
    const { firmware, statuses, host } = updater({ failDownloadAttempts: 5 });
    firmware.request({ ...request, retries: 1, retryInterval: 5 });
    await advance(0);
    await advance(1_000);
    await advance(5_000);
    await advance(1_000);
    expect(statuses).toEqual(['Downloading', 'Downloading', 'DownloadFailed']);
    expect(host.prepareInstallation).not.toHaveBeenCalled();
    expect(firmware.triggeredStatus).toBe('Idle');
  });

  it('reports InstallationFailed and gives the connectors back', async () => {
    const { firmware, statuses, reboots, host, release } = updater({ failInstallation: true });
    firmware.request(request);
    await advance(1_000);
    release();
    await advance(500);
    expect(statuses).toEqual(['Downloading', 'Downloaded', 'Installing', 'InstallationFailed']);
    expect(host.abortInstallation).toHaveBeenCalledOnce();
    expect(reboots).toEqual([]);
  });

  it('lets a new request replace a scheduled or running download', async () => {
    const { firmware, statuses } = updater({ versionFor: () => 'v2' });
    firmware.request({ ...request, retrieveDate: new Date(T0.getTime() + 60_000).toISOString() });
    firmware.request(request);
    await advance(500);
    firmware.request(request); // restarts the download
    await advance(999);
    expect(statuses).toEqual(['Downloading', 'Downloading']);
    await advance(1);
    expect(statuses).toEqual(['Downloading', 'Downloading', 'Downloaded']);
  });
});

function uploader(options: DiagnosticsSimulationOptions = {}) {
  const statuses: DiagnosticsStatus[] = [];
  const uploads: DiagnosticsUpload[] = [];
  const collect = vi.fn(() => 'log line 1\nlog line 2');
  const diagnostics = new DiagnosticsUploader(
    'CP-7',
    { uploadMs: 2_000, ...options },
    {
      notify: (status) => statuses.push(status),
      collect,
      uploaded: (upload) => uploads.push(upload),
    },
    scheduler,
  );
  return { diagnostics, statuses, uploads, collect };
}

describe('DiagnosticsUploader', () => {
  const diagnosticsRequest = {
    location: 'ftp://logs.example.com/incoming/',
    startTime: '2026-05-01T11:00:00Z',
    stopTime: '2026-05-01T11:59:59Z',
  };

  it('names the file, then reports Uploading and Uploaded', async () => {
    const { diagnostics, statuses, uploads, collect } = uploader();
    expect(diagnostics.request(diagnosticsRequest)).toEqual({
      fileName: 'CP-7-diagnostics-20260501T120000Z.log',
    });
    expect(collect).toHaveBeenCalledWith(
      new Date(diagnosticsRequest.startTime),
      new Date(diagnosticsRequest.stopTime),
    );
    expect(statuses).toEqual([]); // the answer goes out first
    await advance(0);
    expect(statuses).toEqual(['Uploading']);
    expect(diagnostics.triggeredStatus).toBe('Uploading');
    await advance(2_000);
    expect(statuses).toEqual(['Uploading', 'Uploaded']);
    expect(uploads).toEqual([
      {
        location: diagnosticsRequest.location,
        fileName: 'CP-7-diagnostics-20260501T120000Z.log',
        content: 'log line 1\nlog line 2',
        attempts: 1,
      },
    ]);
    expect(diagnostics.triggeredStatus).toBe('Idle');
  });

  it('retries and finally reports UploadFailed', async () => {
    const { diagnostics, statuses, uploads } = uploader({ failUploadAttempts: 9 });
    diagnostics.request({ ...diagnosticsRequest, retries: 1, retryInterval: 3 });
    await advance(0);
    await advance(2_000);
    await advance(3_000);
    await advance(2_000);
    expect(statuses).toEqual(['Uploading', 'Uploading', 'UploadFailed']);
    expect(uploads).toEqual([]);
  });

  it('answers without a file name when no diagnostics are available', async () => {
    const { diagnostics, statuses } = uploader({ available: false });
    expect(diagnostics.request(diagnosticsRequest)).toEqual({});
    await advance(10_000);
    expect(statuses).toEqual([]);
  });
});
