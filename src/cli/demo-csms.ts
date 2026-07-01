import type { AddressInfo } from 'node:net';
import type { ChargePointStatus, MessageTrigger, MeterValue } from '../messages/index.js';
import {
  CentralSystem,
  type CentralSystemTlsOptions,
  type ClientCertificateOptions,
} from '../server/central-system.js';

/** What the demo CSMS knows about one connector. */
export interface ConnectorView {
  status: ChargePointStatus;
  transactionId: number | undefined;
  /** Energy delivered in the current transaction, Wh. */
  energyWh: number;
  powerW: number;
  soc: number | undefined;
}

/** What the demo CSMS knows about one charge point. */
export interface StationView {
  readonly identity: string;
  connected: boolean;
  vendor: string | undefined;
  model: string | undefined;
  lastSeen: Date;
  messages: number;
  readonly connectors: Map<number, ConnectorView>;
}

/** Options of {@link DemoCsms}. */
export interface DemoCsmsOptions {
  /** Heartbeat interval handed out in BootNotification responses. Default: 60 s. */
  readonly heartbeatIntervalS?: number;
  /** Require this Basic auth password from every charge point. */
  readonly password?: string;
  readonly basePath?: string;
  readonly pingIntervalMs?: number;
  /** Serve wss:// (Security Profiles 2 and 3). */
  readonly tls?: CentralSystemTlsOptions;
  /** Require client certificates (Security Profile 3). */
  readonly clientCertificates?: ClientCertificateOptions;
  /** Receives human-readable event lines. */
  readonly log?: (line: string) => void;
}

interface TransactionRecord {
  readonly identity: string;
  readonly connectorId: number;
  readonly meterStart: number;
}

/** How many StartTransaction requests are remembered for de-duplication. */
const REMEMBERED_STARTS = 10_000;

function registerWh(meterValues: readonly MeterValue[]): number | undefined {
  for (const meterValue of [...meterValues].reverse()) {
    for (const sample of meterValue.sampledValue) {
      const measurand = sample.measurand ?? 'Energy.Active.Import.Register';
      if (measurand !== 'Energy.Active.Import.Register') continue;
      const value = Number(sample.value);
      if (Number.isFinite(value)) return sample.unit === 'kWh' ? value * 1_000 : value;
    }
  }
  return undefined;
}

function measured(meterValues: readonly MeterValue[], measurand: string): number | undefined {
  for (const meterValue of [...meterValues].reverse()) {
    for (const sample of meterValue.sampledValue) {
      if (sample.measurand !== measurand) continue;
      const value = Number(sample.value);
      if (!Number.isFinite(value)) continue;
      return sample.unit === 'kW' ? value * 1_000 : value;
    }
  }
  return undefined;
}

/**
 * A small demonstration Central System: it accepts every charge point and id tag, hands out
 * transaction ids, tracks connector state and energy, and can remote-control charge points.
 */
export class DemoCsms {
  readonly cs: CentralSystem;
  readonly stations = new Map<string, StationView>();
  readonly #transactions = new Map<number, TransactionRecord>();
  /** StartTransaction fingerprint -> transaction id, to answer replays with the same id. */
  readonly #starts = new Map<string, number>();
  readonly #log: (line: string) => void;
  #nextTransactionId = 1;
  #nextReservationId = 1;

  constructor(options: DemoCsmsOptions = {}) {
    this.#log = options.log ?? (() => undefined);
    const { password } = options;
    this.cs = new CentralSystem({
      ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
      ...(options.pingIntervalMs === undefined ? {} : { pingIntervalMs: options.pingIntervalMs }),
      ...(options.tls === undefined ? {} : { tls: options.tls }),
      ...(options.clientCertificates === undefined
        ? {}
        : { clientCertificates: options.clientCertificates }),
      ...(password === undefined
        ? {}
        : { authenticate: (request) => request.password === password }),
    });
    const heartbeat = options.heartbeatIntervalS ?? 60;

    this.cs.on('connect', (connection) => {
      const station = this.#station(connection.identity);
      station.connected = true;
      station.lastSeen = new Date();
      this.#log(`+ ${connection.identity} connected from ${connection.remoteAddress ?? 'unknown'}`);
    });
    this.cs.on('disconnect', (connection, code) => {
      const station = this.stations.get(connection.identity);
      if (station && this.cs.connections.get(connection.identity) === undefined)
        station.connected = false;
      this.#log(`- ${connection.identity} disconnected (${code})`);
    });
    this.cs.on('call', ({ connection }) => {
      const station = this.#station(connection.identity);
      station.messages++;
      station.lastSeen = new Date();
    });
    this.cs.on('rejected', ({ reason, identity }) => {
      this.#log(`! rejected ${identity ?? 'connection'}: ${reason}`);
    });

    this.cs.handle('BootNotification', (payload, { connection }) => {
      const station = this.#station(connection.identity);
      station.vendor = payload.chargePointVendor;
      station.model = payload.chargePointModel;
      return { status: 'Accepted', currentTime: new Date().toISOString(), interval: heartbeat };
    });
    this.cs.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
    this.cs.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
    // OCPP 1.6 section 4.3: without an implementation for the vendorId the answer SHALL be
    // UnknownVendorId. The demo has no vendor extensions.
    this.cs.handle('DataTransfer', () => ({ status: 'UnknownVendorId' }));
    this.cs.handle('StatusNotification', ({ connectorId, status }, { connection }) => {
      if (connectorId > 0) this.#connector(connection.identity, connectorId).status = status;
      return {};
    });
    this.cs.handle('StartTransaction', (request, { connection }) => {
      const { connectorId, idTag, meterStart } = request;
      // A charge point re-sends StartTransaction when the connection dropped before the answer
      // arrived (transaction messages are delivered at least once): answer with the same id.
      const fingerprint = [
        connection.identity,
        connectorId,
        idTag,
        meterStart,
        request.timestamp,
        request.reservationId ?? '',
      ].join('|');
      const known = this.#starts.get(fingerprint);
      if (known !== undefined) {
        this.#log(`= ${connection.identity}#${connectorId} replayed start of tx ${known}`);
        return { idTagInfo: { status: 'Accepted' }, transactionId: known };
      }
      const transactionId = this.#nextTransactionId++;
      this.#starts.set(fingerprint, transactionId);
      if (this.#starts.size > REMEMBERED_STARTS) {
        const oldest = this.#starts.keys().next().value;
        if (oldest !== undefined) this.#starts.delete(oldest);
      }
      this.#transactions.set(transactionId, {
        identity: connection.identity,
        connectorId,
        meterStart,
      });
      Object.assign(this.#connector(connection.identity, connectorId), {
        transactionId,
        energyWh: 0,
        powerW: 0,
      });
      this.#log(`> ${connection.identity}#${connectorId} started tx ${transactionId} for ${idTag}`);
      return { idTagInfo: { status: 'Accepted' }, transactionId };
    });
    this.cs.handle('MeterValues', ({ connectorId, transactionId, meterValue }, { connection }) => {
      // Connector 0 is the main meter of the whole charge point, not a connector to track.
      if (connectorId === 0) return {};
      const view = this.#connector(connection.identity, connectorId);
      const tx = transactionId === undefined ? undefined : this.#transactions.get(transactionId);
      const register = registerWh(meterValue);
      if (tx && register !== undefined) view.energyWh = register - tx.meterStart;
      view.powerW = measured(meterValue, 'Power.Active.Import') ?? view.powerW;
      view.soc = measured(meterValue, 'SoC') ?? view.soc;
      return {};
    });
    this.cs.handle('FirmwareStatusNotification', ({ status }, { connection }) => {
      this.#log(`~ ${connection.identity} firmware: ${status}`);
      return {};
    });
    this.cs.handle('DiagnosticsStatusNotification', ({ status }, { connection }) => {
      this.#log(`~ ${connection.identity} diagnostics: ${status}`);
      return {};
    });
    this.cs.handle('StopTransaction', ({ transactionId, meterStop, reason }, { connection }) => {
      const tx = this.#transactions.get(transactionId);
      this.#transactions.delete(transactionId);
      if (tx) {
        Object.assign(this.#connector(tx.identity, tx.connectorId), {
          transactionId: undefined,
          powerW: 0,
          energyWh: meterStop - tx.meterStart,
        });
      }
      const kWh = tx ? ((meterStop - tx.meterStart) / 1_000).toFixed(2) : '?';
      this.#log(
        `< ${connection.identity} stopped tx ${transactionId} (${reason ?? 'Local'}, ${kWh} kWh)`,
      );
      return { idTagInfo: { status: 'Accepted' } };
    });
  }

  /** Start listening. */
  listen(port: number, host?: string): Promise<AddressInfo> {
    return this.cs.listen(port, host);
  }

  /** Shut down gracefully. */
  close(): Promise<void> {
    return this.cs.close();
  }

  /** Remote-start a session; picks the first idle connector when none is given. */
  async remoteStart(identity: string, connectorId?: number, idTag = 'DEMO'): Promise<string> {
    const target = connectorId ?? this.#idleConnector(identity);
    const response = await this.cs.call(identity, 'RemoteStartTransaction', {
      idTag,
      ...(target === undefined ? {} : { connectorId: target }),
    });
    return `RemoteStartTransaction ${identity}${target === undefined ? '' : `#${target}`}: ${response.status}`;
  }

  /** Remote-stop by transaction id or connector id; defaults to the first active transaction. */
  async remoteStop(identity: string, target?: number): Promise<string> {
    const station = this.stations.get(identity);
    const views = [...(station?.connectors.entries() ?? [])];
    const byConnector = views.find(([id]) => id === target)?.[1].transactionId;
    const transactionId =
      target !== undefined && this.#transactions.has(target)
        ? target
        : (byConnector ??
          views.find(([, view]) => view.transactionId !== undefined)?.[1].transactionId);
    if (transactionId === undefined) return `No active transaction on ${identity}`;
    const response = await this.cs.call(identity, 'RemoteStopTransaction', { transactionId });
    return `RemoteStopTransaction ${identity} tx ${transactionId}: ${response.status}`;
  }

  /** Cap every connector of a charge point at `kW` (TxDefaultProfile), or clear the cap. */
  async setLimit(identity: string, kW: number | undefined): Promise<string> {
    if (kW === undefined) {
      const response = await this.cs.call(identity, 'ClearChargingProfile', {
        chargingProfilePurpose: 'TxDefaultProfile',
      });
      return `ClearChargingProfile ${identity}: ${response.status}`;
    }
    const response = await this.cs.call(identity, 'SetChargingProfile', {
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: Math.round(kW * 1_000) }],
        },
      },
    });
    return `SetChargingProfile ${identity} ${kW} kW: ${response.status}`;
  }

  /** Reset a charge point. */
  async reset(identity: string, type: 'Hard' | 'Soft' = 'Soft'): Promise<string> {
    const response = await this.cs.call(identity, 'Reset', { type });
    return `Reset ${identity} (${type}): ${response.status}`;
  }

  /** Reserve a connector (0: any) for `idTag` during `minutes`. */
  async reserve(
    identity: string,
    connectorId: number,
    idTag: string,
    minutes = 15,
  ): Promise<string> {
    const reservationId = this.#nextReservationId++;
    const expiryDate = new Date(Date.now() + minutes * 60_000).toISOString();
    const response = await this.cs.call(identity, 'ReserveNow', {
      connectorId,
      idTag,
      reservationId,
      expiryDate,
    });
    return `ReserveNow ${identity}#${connectorId} for ${idTag} (reservation ${reservationId}): ${response.status}`;
  }

  /** Cancel a reservation. */
  async cancelReservation(identity: string, reservationId: number): Promise<string> {
    const response = await this.cs.call(identity, 'CancelReservation', { reservationId });
    return `CancelReservation ${identity} ${reservationId}: ${response.status}`;
  }

  /** Ask a charge point to install the firmware at `location` now. */
  async updateFirmware(identity: string, location: string): Promise<string> {
    await this.cs.call(identity, 'UpdateFirmware', {
      location,
      retrieveDate: new Date().toISOString(),
    });
    return `UpdateFirmware ${identity}: requested ${location}`;
  }

  /** Ask a charge point to upload diagnostics to `location`. */
  async getDiagnostics(identity: string, location: string): Promise<string> {
    const { fileName } = await this.cs.call(identity, 'GetDiagnostics', { location });
    return `GetDiagnostics ${identity}: ${fileName ?? 'no diagnostics available'}`;
  }

  /** TriggerMessage. */
  async trigger(
    identity: string,
    requestedMessage: MessageTrigger,
    connectorId?: number,
  ): Promise<string> {
    const response = await this.cs.call(identity, 'TriggerMessage', {
      requestedMessage,
      ...(connectorId === undefined ? {} : { connectorId }),
    });
    return `TriggerMessage ${identity} ${requestedMessage}: ${response.status}`;
  }

  /** GetConfiguration for one key, or ChangeConfiguration when a value is given. */
  async configure(identity: string, key: string, value?: string): Promise<string> {
    if (value !== undefined) {
      const { status } = await this.cs.call(identity, 'ChangeConfiguration', { key, value });
      return `ChangeConfiguration ${identity} ${key}=${value}: ${status}`;
    }
    const { configurationKey = [], unknownKey = [] } = await this.cs.call(
      identity,
      'GetConfiguration',
      { key: [key] },
    );
    const [entry] = configurationKey;
    if (!entry) return `${identity} ${key}: ${unknownKey.length > 0 ? 'unknown key' : '-'}`;
    return `${identity} ${entry.key} = ${entry.value ?? ''}${entry.readonly ? ' (read-only)' : ''}`;
  }

  /** Remote-start one idle connector on every connected charge point. */
  async autoStart(): Promise<number> {
    let started = 0;
    await Promise.all(
      [...this.stations.values()]
        .filter((station) => station.connected)
        .map(async (station) => {
          const connectorId = this.#idleConnector(station.identity);
          if (connectorId === undefined) return;
          try {
            const response = await this.cs.call(station.identity, 'RemoteStartTransaction', {
              idTag: 'AUTO',
              connectorId,
            });
            if (response.status === 'Accepted') started++;
          } catch {
            // The charge point went away or timed out; try again next round.
          }
        }),
    );
    return started;
  }

  /** Fleet-wide totals. */
  totals(): {
    stations: number;
    connected: number;
    transactions: number;
    powerKW: number;
    energyKWh: number;
  } {
    let powerW = 0;
    let energyWh = 0;
    let connected = 0;
    for (const station of this.stations.values()) {
      if (station.connected) connected++;
      for (const view of station.connectors.values()) {
        if (view.transactionId !== undefined) {
          powerW += view.powerW;
          energyWh += view.energyWh;
        }
      }
    }
    return {
      stations: this.stations.size,
      connected,
      transactions: this.#transactions.size,
      powerKW: powerW / 1_000,
      energyKWh: energyWh / 1_000,
    };
  }

  #idleConnector(identity: string): number | undefined {
    const station = this.stations.get(identity);
    if (!station) return undefined;
    for (const [id, view] of [...station.connectors.entries()].sort(([a], [b]) => a - b)) {
      if (view.status === 'Available' && view.transactionId === undefined) return id;
    }
    return undefined;
  }

  #station(identity: string): StationView {
    let station = this.stations.get(identity);
    if (!station) {
      station = {
        identity,
        connected: false,
        vendor: undefined,
        model: undefined,
        lastSeen: new Date(),
        messages: 0,
        connectors: new Map(),
      };
      this.stations.set(identity, station);
    }
    return station;
  }

  #connector(identity: string, connectorId: number): ConnectorView {
    const station = this.#station(identity);
    let view = station.connectors.get(connectorId);
    if (!view) {
      view = {
        status: 'Available',
        transactionId: undefined,
        energyWh: 0,
        powerW: 0,
        soc: undefined,
      };
      station.connectors.set(connectorId, view);
    }
    return view;
  }
}
