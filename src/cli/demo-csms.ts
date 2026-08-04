import type { AddressInfo } from 'node:net';
import type { MessageTrigger, MeterValue, v201 } from '../messages/index.js';
import {
  CentralSystem,
  type CentralSystemTlsOptions,
  type ClientCertificateOptions,
} from '../server/central-system.js';
import type { OcppSubprotocol } from '../transport/websocket.js';

/** What the demo CSMS knows about one connector (OCPP 2.0.1: one EVSE). */
export interface ConnectorView {
  /** Latest status: an OCPP 1.6 ChargePointStatus or a 2.0.1 ConnectorStatus. */
  status: string;
  /** Transaction id: a number assigned by the demo (1.6) or the station's string (2.0.1). */
  transactionId: number | string | undefined;
  /** Energy delivered in the current transaction, Wh. */
  energyWh: number;
  powerW: number;
  soc: number | undefined;
}

/** What the demo CSMS knows about one charge point. */
export interface StationView {
  readonly identity: string;
  /** OCPP version of the latest connection, e.g. `1.6` or `2.0.1`. */
  version: string;
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
  /** Subprotocols to accept, in order of preference. Default: `['ocpp2.0.1', 'ocpp1.6']`. */
  readonly protocols?: readonly OcppSubprotocol[];
  /** Receives human-readable event lines. */
  readonly log?: (line: string) => void;
}

interface TransactionRecord {
  readonly identity: string;
  readonly connectorId: number;
  readonly meterStart: number;
}

/** A 2.0.1 transaction as the demo tracks it: its EVSE, start register and seen seqNos. */
interface Transaction201 {
  readonly identity: string;
  readonly evseId: number;
  meterStart: number | undefined;
  readonly seqNos: Set<number>;
}

/** How many StartTransaction requests (and ended 2.0.1 transactions) are remembered. */
const REMEMBERED = 10_000;

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

/** A 2.0.1 sampled value in base units (Wh, W), applying the unit and its multiplier. */
function measured201(
  meterValues: readonly v201.MeterValue[] | undefined,
  measurand: string,
): number | undefined {
  for (const meterValue of [...(meterValues ?? [])].reverse()) {
    for (const sample of meterValue.sampledValue) {
      const name =
        sample.measurand ?? (measurand === 'Energy.Active.Import.Register' ? measurand : '');
      if (name !== measurand || sample.phase !== undefined) continue;
      const unit = sample.unitOfMeasure?.unit ?? (measurand === 'SoC' ? 'Percent' : 'Wh');
      const scale =
        10 ** (sample.unitOfMeasure?.multiplier ?? 0) *
        (unit === 'kWh' || unit === 'kW' ? 1_000 : 1);
      return sample.value * scale;
    }
  }
  return undefined;
}

/**
 * A small demonstration Central System for OCPP 1.6 and 2.0.1 on the same port: it accepts
 * every charge point and id tag, hands out 1.6 transaction ids, tracks connector state and
 * energy of both versions, and can remote-control charge points of either version.
 */
export class DemoCsms {
  readonly cs: CentralSystem<OcppSubprotocol>;
  readonly stations = new Map<string, StationView>();
  readonly #transactions = new Map<number, TransactionRecord>();
  readonly #transactions201 = new Map<string, Transaction201>();
  /** Transaction ids of ended 2.0.1 transactions, to recognise replayed events. */
  readonly #ended201 = new Set<string>();
  /** StartTransaction fingerprint -> transaction id, to answer replays with the same id. */
  readonly #starts = new Map<string, number>();
  readonly #log: (line: string) => void;
  #nextTransactionId = 1;
  #nextReservationId = 1;
  #nextRequestId = 1;

  constructor(options: DemoCsmsOptions = {}) {
    this.#log = options.log ?? (() => undefined);
    const { password } = options;
    this.cs = new CentralSystem<OcppSubprotocol>({
      protocols: options.protocols ?? ['ocpp2.0.1', 'ocpp1.6'],
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
      station.version = connection.version;
      station.lastSeen = new Date();
      this.#log(
        `+ ${connection.identity} connected from ${connection.remoteAddress ?? 'unknown'} (OCPP ${connection.version})`,
      );
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
    this.#handle16(heartbeat);
    this.#handle201(heartbeat);
  }

  /** The OCPP 1.6 handlers. */
  #handle16(heartbeat: number): void {
    const cs = this.cs;
    cs.handle('BootNotification', (payload, { connection }) => {
      const station = this.#station(connection.identity);
      station.vendor = payload.chargePointVendor;
      station.model = payload.chargePointModel;
      return { status: 'Accepted', currentTime: new Date().toISOString(), interval: heartbeat };
    });
    cs.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
    cs.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
    // OCPP 1.6 section 4.3: without an implementation for the vendorId the answer SHALL be
    // UnknownVendorId. The demo has no vendor extensions.
    cs.handle('DataTransfer', () => ({ status: 'UnknownVendorId' }));
    cs.handle('StatusNotification', ({ connectorId, status }, { connection }) => {
      if (connectorId > 0) this.#connector(connection.identity, connectorId).status = status;
      return {};
    });
    cs.handle('StartTransaction', (request, { connection }) => {
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
      if (this.#starts.size > REMEMBERED) {
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
    cs.handle('MeterValues', ({ connectorId, transactionId, meterValue }, { connection }) => {
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
    cs.handle('FirmwareStatusNotification', ({ status }, { connection }) => {
      this.#log(`~ ${connection.identity} firmware: ${status}`);
      return {};
    });
    cs.handle('DiagnosticsStatusNotification', ({ status }, { connection }) => {
      this.#log(`~ ${connection.identity} diagnostics: ${status}`);
      return {};
    });
    cs.handle('StopTransaction', ({ transactionId, meterStop, reason }, { connection }) => {
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

  /** The OCPP 2.0.1 handlers. */
  #handle201(heartbeat: number): void {
    const v201 = this.cs.v201;
    v201.handle('BootNotification', ({ chargingStation }, { connection }) => {
      const station = this.#station(connection.identity);
      station.vendor = chargingStation.vendorName;
      station.model = chargingStation.model;
      return { status: 'Accepted', currentTime: new Date().toISOString(), interval: heartbeat };
    });
    v201.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
    v201.handle('Authorize', () => ({ idTokenInfo: { status: 'Accepted' } }));
    v201.handle('DataTransfer', () => ({ status: 'UnknownVendorId' }));
    v201.handle('StatusNotification', ({ evseId, connectorStatus }, { connection }) => {
      if (evseId > 0) this.#connector(connection.identity, evseId).status = connectorStatus;
      return {};
    });
    v201.handle('TransactionEvent', (request, { connection }) => {
      this.#transactionEvent(connection.identity, request);
      return request.idToken ? { idTokenInfo: { status: 'Accepted' } } : {};
    });
    v201.handle('MeterValues', ({ evseId, meterValue }, { connection }) => {
      if (evseId === 0) return {};
      const view = this.#connector(connection.identity, evseId);
      if (view.transactionId === undefined) {
        view.powerW = measured201(meterValue, 'Power.Active.Import') ?? view.powerW;
      }
      return {};
    });
    const logged =
      <P>(describe: (payload: P) => string) =>
      (payload: P, { connection }: { readonly connection: { readonly identity: string } }) => {
        this.#log(`~ ${connection.identity} ${describe(payload)}`);
        return {};
      };
    v201.handle(
      'FirmwareStatusNotification',
      logged((p: v201.FirmwareStatusNotificationRequest) => `firmware: ${p.status}`),
    );
    v201.handle(
      'LogStatusNotification',
      logged((p: v201.LogStatusNotificationRequest) => `log upload: ${p.status}`),
    );
    v201.handle(
      'SecurityEventNotification',
      logged((p: v201.SecurityEventNotificationRequest) => `security event: ${p.type}`),
    );
    v201.handle(
      'ReservationStatusUpdate',
      logged(
        (p: v201.ReservationStatusUpdateRequest) =>
          `reservation ${p.reservationId}: ${p.reservationUpdateStatus}`,
      ),
    );
    v201.handle(
      'NotifyReport',
      logged(
        (p: v201.NotifyReportRequest) =>
          `report ${p.requestId} part ${p.seqNo}: ${p.reportData?.length ?? 0} variables`,
      ),
    );
    v201.handle(
      'NotifyEvent',
      logged((p: v201.NotifyEventRequest) =>
        p.eventData
          .map((e) => `${e.component.name}.${e.variable.name}=${e.actualValue}`)
          .join(', '),
      ),
    );
    v201.handle(
      'ReportChargingProfiles',
      logged(
        (p: v201.ReportChargingProfilesRequest) =>
          `charging profiles of EVSE ${p.evseId}: ${p.chargingProfile.map((c) => c.id).join(', ')}`,
      ),
    );
    v201.handle(
      'NotifyChargingLimit',
      logged(
        (p: v201.NotifyChargingLimitRequest) =>
          `external limit by ${p.chargingLimit.chargingLimitSource}`,
      ),
    );
    v201.handle(
      'ClearedChargingLimit',
      logged((p: v201.ClearedChargingLimitRequest) => `limit by ${p.chargingLimitSource} released`),
    );
    v201.handle('NotifyEVChargingNeeds', (_request, { connection }) => {
      this.#log(`~ ${connection.identity} EV charging needs (no schedules offered)`);
      return { status: 'Rejected' };
    });
  }

  /** Track a 2.0.1 transaction; a replayed event (seen seqNo) changes nothing. */
  #transactionEvent(identity: string, request: v201.TransactionEventRequest): void {
    const { transactionId } = request.transactionInfo;
    if (this.#ended201.has(transactionId)) return;
    let tx = this.#transactions201.get(transactionId);
    if (!tx) {
      const evseId = request.evse?.id;
      if (evseId === undefined) return; // an event of a transaction whose start we never saw
      tx = { identity, evseId, meterStart: undefined, seqNos: new Set() };
      this.#transactions201.set(transactionId, tx);
      Object.assign(this.#connector(identity, evseId), { transactionId, energyWh: 0, powerW: 0 });
      this.#log(
        `> ${identity}#${evseId} started tx ${transactionId}${request.idToken ? ` for ${request.idToken.idToken}` : ''}`,
      );
    }
    if (tx.seqNos.has(request.seqNo)) {
      this.#log(`= ${identity} replayed event ${request.seqNo} of tx ${transactionId}`);
      return;
    }
    tx.seqNos.add(request.seqNo);
    const view = this.#connector(identity, tx.evseId);
    const register = measured201(request.meterValue, 'Energy.Active.Import.Register');
    if (register !== undefined) {
      tx.meterStart ??= register;
      view.energyWh = register - tx.meterStart;
    }
    view.powerW = measured201(request.meterValue, 'Power.Active.Import') ?? view.powerW;
    view.soc = measured201(request.meterValue, 'SoC') ?? view.soc;
    if (request.transactionInfo.chargingState !== 'Charging') view.powerW = 0;
    if (request.eventType === 'Ended') {
      this.#transactions201.delete(transactionId);
      this.#ended201.add(transactionId);
      if (this.#ended201.size > REMEMBERED) {
        const oldest = this.#ended201.values().next().value;
        if (oldest !== undefined) this.#ended201.delete(oldest);
      }
      Object.assign(view, { transactionId: undefined, powerW: 0 });
      this.#log(
        `< ${identity} ended tx ${transactionId} (${request.transactionInfo.stoppedReason ?? request.triggerReason}, ${(view.energyWh / 1_000).toFixed(2)} kWh)`,
      );
    }
  }

  /** Start listening. */
  listen(port: number, host?: string): Promise<AddressInfo> {
    return this.cs.listen(port, host);
  }

  /** Shut down gracefully. */
  close(): Promise<void> {
    return this.cs.close();
  }

  /** OCPP version of a connected charge point (`undefined` when it is not connected). */
  #versionOf(identity: string): string | undefined {
    return this.cs.connections.get(identity)?.version;
  }

  /** Remote-start a session; picks the first idle connector when none is given. */
  async remoteStart(identity: string, connectorId?: number, idTag = 'DEMO'): Promise<string> {
    const target = connectorId ?? this.#idleConnector(identity);
    const where = `${identity}${target === undefined ? '' : `#${target}`}`;
    if (this.#versionOf(identity) === '2.0.1') {
      const response = await this.cs.v201.call(identity, 'RequestStartTransaction', {
        idToken: { idToken: idTag, type: 'Central' },
        remoteStartId: this.#nextRequestId++,
        ...(target === undefined ? {} : { evseId: target }),
      });
      return `RequestStartTransaction ${where}: ${response.status}`;
    }
    const response = await this.cs.call(identity, 'RemoteStartTransaction', {
      idTag,
      ...(target === undefined ? {} : { connectorId: target }),
    });
    return `RemoteStartTransaction ${where}: ${response.status}`;
  }

  /**
   * Remote-stop by transaction id or connector (2.0.1: EVSE) id; defaults to the first active
   * transaction.
   */
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
    if (typeof transactionId === 'string') {
      const response = await this.cs.v201.call(identity, 'RequestStopTransaction', {
        transactionId,
      });
      return `RequestStopTransaction ${identity} tx ${transactionId}: ${response.status}`;
    }
    const response = await this.cs.call(identity, 'RemoteStopTransaction', { transactionId });
    return `RemoteStopTransaction ${identity} tx ${transactionId}: ${response.status}`;
  }

  /** Cap every connector of a charge point at `kW` (TxDefaultProfile), or clear the cap. */
  async setLimit(identity: string, kW: number | undefined): Promise<string> {
    if (this.#versionOf(identity) === '2.0.1') {
      if (kW === undefined) {
        const response = await this.cs.v201.call(identity, 'ClearChargingProfile', {
          chargingProfileCriteria: { chargingProfilePurpose: 'TxDefaultProfile' },
        });
        return `ClearChargingProfile ${identity}: ${response.status}`;
      }
      const response = await this.cs.v201.call(identity, 'SetChargingProfile', {
        evseId: 0,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Relative',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: Math.round(kW * 1_000) }],
            },
          ],
        },
      });
      return `SetChargingProfile ${identity} ${kW} kW: ${response.status}`;
    }
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

  /** Reset a charge point (2.0.1: Hard is Immediate, Soft is OnIdle). */
  async reset(identity: string, type: 'Hard' | 'Soft' = 'Soft'): Promise<string> {
    if (this.#versionOf(identity) === '2.0.1') {
      const kind = type === 'Hard' ? 'Immediate' : 'OnIdle';
      const response = await this.cs.v201.call(identity, 'Reset', { type: kind });
      return `Reset ${identity} (${kind}): ${response.status}`;
    }
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
    if (this.#versionOf(identity) === '2.0.1') {
      const response = await this.cs.v201.call(identity, 'ReserveNow', {
        id: reservationId,
        expiryDateTime: expiryDate,
        idToken: { idToken: idTag, type: 'Central' },
        ...(connectorId === 0 ? {} : { evseId: connectorId }),
      });
      return `ReserveNow ${identity}#${connectorId} for ${idTag} (reservation ${reservationId}): ${response.status}`;
    }
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
    const response =
      this.#versionOf(identity) === '2.0.1'
        ? await this.cs.v201.call(identity, 'CancelReservation', { reservationId })
        : await this.cs.call(identity, 'CancelReservation', { reservationId });
    return `CancelReservation ${identity} ${reservationId}: ${response.status}`;
  }

  /** Ask a charge point to install the firmware at `location` now. */
  async updateFirmware(identity: string, location: string): Promise<string> {
    const retrieveDate = new Date().toISOString();
    if (this.#versionOf(identity) === '2.0.1') {
      const { status } = await this.cs.v201.call(identity, 'UpdateFirmware', {
        requestId: this.#nextRequestId++,
        firmware: { location, retrieveDateTime: retrieveDate },
      });
      return `UpdateFirmware ${identity}: ${status} ${location}`;
    }
    await this.cs.call(identity, 'UpdateFirmware', { location, retrieveDate });
    return `UpdateFirmware ${identity}: requested ${location}`;
  }

  /** Ask a charge point to upload diagnostics (2.0.1: its diagnostics log) to `location`. */
  async getDiagnostics(identity: string, location: string): Promise<string> {
    if (this.#versionOf(identity) === '2.0.1') {
      const { status, filename } = await this.cs.v201.call(identity, 'GetLog', {
        requestId: this.#nextRequestId++,
        logType: 'DiagnosticsLog',
        log: { remoteLocation: location },
      });
      return `GetLog ${identity}: ${status}${filename ? ` ${filename}` : ''}`;
    }
    const { fileName } = await this.cs.call(identity, 'GetDiagnostics', { location });
    return `GetDiagnostics ${identity}: ${fileName ?? 'no diagnostics available'}`;
  }

  /** TriggerMessage (with the message names of the charge point's version). */
  async trigger(identity: string, requestedMessage: string, connectorId?: number): Promise<string> {
    if (this.#versionOf(identity) === '2.0.1') {
      const response = await this.cs.v201.call(identity, 'TriggerMessage', {
        requestedMessage: requestedMessage as v201.MessageTrigger,
        ...(connectorId === undefined ? {} : { evse: { id: connectorId } }),
      });
      return `TriggerMessage ${identity} ${requestedMessage}: ${response.status}`;
    }
    const response = await this.cs.call(identity, 'TriggerMessage', {
      requestedMessage: requestedMessage as MessageTrigger,
      ...(connectorId === undefined ? {} : { connectorId }),
    });
    return `TriggerMessage ${identity} ${requestedMessage}: ${response.status}`;
  }

  /**
   * Read a configuration key, or change it when a value is given. For OCPP 2.0.1 the key is
   * `Component.Variable` (e.g. `OCPPCommCtrlr.HeartbeatInterval`) and GetVariables or
   * SetVariables is used.
   */
  async configure(identity: string, key: string, value?: string): Promise<string> {
    if (this.#versionOf(identity) === '2.0.1') {
      const dot = key.indexOf('.');
      if (dot <= 0)
        return `${identity}: use Component.Variable, e.g. OCPPCommCtrlr.HeartbeatInterval`;
      const component = { name: key.slice(0, dot) };
      const variable = { name: key.slice(dot + 1) };
      if (value !== undefined) {
        const { setVariableResult } = await this.cs.v201.call(identity, 'SetVariables', {
          setVariableData: [{ component, variable, attributeValue: value }],
        });
        return `SetVariables ${identity} ${key}=${value}: ${setVariableResult[0]?.attributeStatus ?? '?'}`;
      }
      const { getVariableResult } = await this.cs.v201.call(identity, 'GetVariables', {
        getVariableData: [{ component, variable }],
      });
      const [result] = getVariableResult;
      return result?.attributeStatus === 'Accepted'
        ? `${identity} ${key} = ${result.attributeValue ?? ''}`
        : `${identity} ${key}: ${result?.attributeStatus ?? '?'}`;
    }
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
            const outcome = await this.remoteStart(station.identity, connectorId, 'AUTO');
            if (outcome.endsWith(': Accepted')) started++;
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
      transactions: this.#transactions.size + this.#transactions201.size,
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
        version: '?',
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
