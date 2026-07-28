import { ChargingStation, type ChargingStationOptions } from '../../client/charging-station.js';
import { MemoryQueueStore, type OfflineQueueStore } from '../../client/offline-queue.js';
import type {
  CsmsAction,
  CsmsRequest,
  CsmsResponse,
  StationAction,
  StationRequest,
  StationResponse,
  v201,
} from '../../messages/index.js';
import { RpcError } from '../../rpc/errors.js';
import type { CompletedCallEvent, MaybePromise } from '../../rpc/peer.js';
import { TypedEventEmitter } from '../../util/typed-emitter.js';
import { timerDelay } from '../../util/timers.js';
import { acceptedPowerW, ElectricVehicle, randomEvProfile, type EvProfile } from '../ev.js';
import type { SimulationScheduler } from '../firmware.js';
import {
  nextAlignedTime,
  parseMeasurandList,
  sampleValues,
  type MeasurandItem,
  type MeterSnapshot,
} from '../metering.js';
import { deriveSeed, Random } from '../random.js';
import { maxMinFairShare, type ElectricalSpec } from '../smart-charging.js';
import type { AutopilotOptions, ChargerStats } from '../charger.js';
import {
  authorizeIdToken,
  IdTokenCache,
  IdTokenLocalList,
  sameIdTokenGroup,
  type IdTokenDecision,
} from './authorization.js';
import { DeviceModel, type VariableDefinition } from './device-model.js';
import {
  FirmwareUpdater201,
  LogUploader,
  type FirmwareSimulation201Options,
  type LogSimulationOptions,
  type LogUpload,
} from './firmware.js';
import { ChargingProfileManager201, type TransactionContext201 } from './smart-charging.js';
import { evseVariable, standardDeviceModel, V, type TxPoint } from './standard-variables.js';

const DEFAULT_AUTOPILOT: Required<AutopilotOptions> = {
  idleS: [30, 300],
  plugInDelayS: [2, 10],
  swipeDelayS: [1, 5],
  dwellAfterFullS: [0, 120],
  unplugDelayS: [3, 15],
  maxSessionS: 4 * 3_600,
  reservationArrivalS: [10, 120],
};

/** Options of {@link SimulatedChargingStation}. */
export interface SimulatedChargingStationOptions {
  /** Charging station identity. */
  readonly identity: string;
  /** CSMS endpoint without the identity. */
  readonly url: string;
  /** Security Profile 1/2 password (HTTP Basic auth). */
  readonly password?: string;
  /** Number of EVSEs, each with one connector. Default: 2. */
  readonly evses?: number;
  /** Hardware power limit per EVSE, in W. Default: 22 000. */
  readonly maxPowerW?: number;
  /** Phase voltage. Default: 230 V. */
  readonly voltage?: number;
  /** Number of phases. Default: 3. */
  readonly phases?: number;
  readonly vendor?: string;
  readonly model?: string;
  /** Firmware version reported in BootNotification (a firmware update changes it). */
  readonly firmwareVersion?: string;
  /** Seed for every random decision. Default: 1. */
  readonly seed?: number;
  /** Enable the autopilot (`true` for defaults). Default: off. */
  readonly autopilot?: boolean | AutopilotOptions;
  /** idToken values (type ISO14443) presented by simulated drivers. */
  readonly idTokens?: readonly string[];
  /** Physics step. Default: 1 000 ms. */
  readonly tickMs?: number;
  /** Initial HeartbeatInterval (overridden by BootNotification). Default: 300 s. */
  readonly heartbeatIntervalS?: number;
  /** Initial SampledDataCtrlr.TxUpdatedInterval. Default: 60 s. */
  readonly txUpdatedIntervalS?: number;
  /** Initial TxCtrlr.TxStartPoint. Default: `['PowerPathClosed']`. */
  readonly txStartPoint?: readonly TxPoint[];
  /** Initial TxCtrlr.TxStopPoint. Default: `['EVConnected', 'Authorized']`. */
  readonly txStopPoint?: readonly TxPoint[];
  /** Time a reset takes before reconnecting. Default: 2 000 ms. */
  readonly rebootDelayMs?: number;
  /** Retry delay after a failed BootNotification when the CSMS gave no interval. Default: 30 s. */
  readonly bootRetryS?: number;
  /** Extra or overriding device model variables. */
  readonly variables?: readonly VariableDefinition[];
  /** Offline queue store shared across reboots. Default: in-memory. */
  readonly queueStore?: OfflineQueueStore;
  /** Options forwarded to the underlying {@link ChargingStation} client. */
  readonly client?: Partial<Omit<ChargingStationOptions, 'identity' | 'url' | 'password'>>;
  /** Capacity of the Authorization Cache. Default: 1 000. */
  readonly authorizationCacheSize?: number;
  /** Maximum number of installed charging profiles. Default: 16. */
  readonly maxProfiles?: number;
  /** Firmware update simulation. */
  readonly firmware?: FirmwareSimulation201Options;
  /** Log upload simulation. */
  readonly logs?: LogSimulationOptions;
}

/** Snapshot of one EVSE (and its single connector). */
export interface EvseSnapshot {
  readonly evseId: number;
  readonly connectorId: 1;
  readonly status: v201.ConnectorStatus;
  readonly plugged: boolean;
  /** Transaction id, while a transaction exists. */
  readonly transactionId: string | undefined;
  readonly chargingState: v201.ChargingState | undefined;
  /** Id of the reservation holding this EVSE, if any. */
  readonly reservationId: number | undefined;
  /** Energy register (Wh). */
  readonly energyWh: number;
  readonly powerW: number;
  readonly offeredW: number;
  /** EV state of charge in percent, when an EV is connected. */
  readonly soc: number | undefined;
}

/** A reservation accepted with ReserveNow. */
export interface Reservation201 {
  readonly id: number;
  /** Reserved EVSE, or `undefined` for any EVSE. */
  readonly evseId: number | undefined;
  readonly idToken: v201.IdToken;
  readonly groupIdToken: v201.IdToken | undefined;
  readonly expiry: Date;
}

/** Why the station restarts. */
export type RebootCause201 = 'RemoteReset' | 'FirmwareUpdate';

/** Events emitted by {@link SimulatedChargingStation}. */
export interface SimulatedChargingStationEvents {
  registered: () => void;
  status: (evseId: number, status: v201.ConnectorStatus) => void;
  /** A TransactionEvent was generated (it is queued; delivery may come later). */
  transactionEvent: (event: v201.TransactionEventRequest) => void;
  transactionStarted: (evseId: number, transactionId: string) => void;
  transactionEnded: (
    evseId: number,
    transactionId: string,
    reason: v201.StoppedReason,
    energyWh: number,
  ) => void;
  reboot: (cause: RebootCause201) => void;
  callCompleted: (event: CompletedCallEvent) => void;
  connection: (connected: boolean) => void;
  reservation: (
    kind: 'reserved' | 'used' | 'cancelled' | 'expired' | 'removed',
    reservation: Reservation201,
  ) => void;
  firmwareStatus: (status: v201.FirmwareStatus) => void;
  logStatus: (status: v201.UploadLogStatus) => void;
  logUploaded: (upload: LogUpload) => void;
}

interface Authorization {
  readonly token: v201.IdToken;
  readonly group: v201.IdToken | undefined;
  readonly remoteStartId: number | undefined;
  readonly reservation: Reservation201 | undefined;
  readonly profile: v201.ChargingProfile | undefined;
  /** EVConnectionTimeOut timer while the cable is not plugged in. */
  timer: NodeJS.Timeout | undefined;
}

interface Transaction {
  readonly id: string;
  readonly startedAt: Date;
  readonly meterStartWh: number;
  seqNo: number;
  chargingState: v201.ChargingState;
  /** Set once the first event (which carries the EVSE) has been generated. */
  evseSent: boolean;
  remoteStartId: number | undefined;
  remoteStartSent: boolean;
  reservationId: number | undefined;
  elapsedS: number;
  timeSpentChargingS: number;
  nextUpdateS: number;
  nextEndedSampleS: number;
  readonly endedSamples: v201.MeterValue[];
  /** Why energy stopped, when a stop point other than Authorized keeps the transaction open. */
  pendingStopReason: v201.StoppedReason | undefined;
  invalidEnergyLimitWh: number | undefined;
  suspended: boolean;
  lastOfferedW: number;
  ended: boolean;
}

interface Evse {
  readonly id: number;
  plugged: boolean;
  ev: ElectricVehicle | undefined;
  energyWh: number;
  powerW: number;
  offeredW: number;
  operative: boolean;
  pendingInoperative: boolean;
  faulted: boolean;
  authorization: Authorization | undefined;
  /** An authorization being checked (remote start with AuthorizeRemoteStart). */
  claimed: boolean;
  tx: Transaction | undefined;
  status: v201.ConnectorStatus;
  /** Status last reported to the CSMS. */
  reported: v201.ConnectorStatus | undefined;
  autoTimer: NodeJS.Timeout | undefined;
  fullSince: number | undefined;
}

const LOG_CAPACITY = 2_000;
const MEASURAND_FALLBACK: MeasurandItem[] = [{ measurand: 'Energy.Active.Import.Register' }];

function uuidFrom(random: Random): string {
  const hex = Array.from({ length: 32 }, () => random.int(0, 15).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 + random.int(0, 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Whether an EVSE holds an authorization; a function so narrowing does not outlive awaits. */
function isAuthorized(e: Evse): boolean {
  return e.authorization !== undefined;
}

/** Convert a sampled value of the metering model to the 2.0.1 shape (numeric value, unit). */
function sampled201(value: ReturnType<typeof sampleValues>[number]): v201.SampledValue | undefined {
  if (value.measurand === 'Temperature' || value.measurand === 'RPM') return undefined;
  const number = Number(value.value);
  return {
    value: Number.isFinite(number) ? number : 0,
    ...(value.context === undefined ? {} : { context: value.context }),
    ...(value.measurand === undefined ? {} : { measurand: value.measurand }),
    ...(value.phase === undefined ? {} : { phase: value.phase }),
    ...(value.location === undefined ? {} : { location: value.location }),
    ...(value.unit === undefined ? {} : { unitOfMeasure: { unit: value.unit } }),
  };
}

/**
 * A virtual OCPP 2.0.1 charging station.
 *
 * It models EVSEs with one connector each, a Device Model with the standard controller
 * variables, transactions driven by TxStartPoint and TxStopPoint with TransactionEvent
 * Started/Updated/Ended (seqNo, triggerReason, chargingState, meter values), offline queueing
 * with ordered replay, authorization through the Local Authorization List, the Authorization
 * Cache and Authorize, smart charging with the 2.0.1 profile rules, availability, reservations,
 * firmware updates, log uploads and a seeded autopilot of drivers.
 */
export class SimulatedChargingStation extends TypedEventEmitter<SimulatedChargingStationEvents> {
  readonly identity: string;
  /** The Device Model (GetVariables, SetVariables, reports). */
  readonly deviceModel: DeviceModel;
  /** Installed charging profiles. */
  readonly profiles: ChargingProfileManager201;
  /** The Local Authorization List. */
  readonly localAuthList: IdTokenLocalList;
  /** The Authorization Cache. */
  readonly authorizationCache: IdTokenCache;

  readonly #options: SimulatedChargingStationOptions;
  readonly #evses: Evse[];
  readonly #random: Random;
  readonly #jitter: Random;
  readonly #autopilot: Required<AutopilotOptions> | undefined;
  readonly #spec: ElectricalSpec;
  readonly #tickS: number;
  readonly #queueStore: OfflineQueueStore;
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #reservations = new Map<number, Reservation201>();
  readonly #firmware: FirmwareUpdater201;
  readonly #logs: LogUploader;
  readonly #log: { readonly at: Date; readonly line: string; readonly security: boolean }[] = [];
  readonly #networkProfiles = new Map<number, v201.NetworkConnectionProfile>();
  #installWaiters: (() => void)[] = [];
  #firmwareVersion: string | undefined;
  #client: ChargingStation;
  #registration: v201.RegistrationStatus | undefined;
  #bootReason: v201.BootReason = 'PowerUp';
  #bootRetry: NodeJS.Timeout | undefined;
  #stopped = true;
  #rebooting = false;
  #stationOperative = true;
  #pendingStationInoperative = false;
  #pendingReset = false;
  #heartbeat: NodeJS.Timeout | undefined;
  #tick: NodeJS.Timeout | undefined;
  #nextAligned: Date | undefined;
  #alignedIntervalS = 0;
  #offlineSince: number | undefined;
  #eventSeqNo = 0;
  #callsSent = 0;
  #callErrors = 0;
  #sessionsStarted = 0;
  #sessionsCompleted = 0;

  constructor(options: SimulatedChargingStationOptions) {
    super();
    this.identity = options.identity;
    this.#options = options;
    const count = options.evses ?? 2;
    this.#random = new Random(deriveSeed(options.seed ?? 1, options.identity));
    this.#jitter = new Random(deriveSeed(options.seed ?? 1, `${options.identity}/jitter`));
    this.#autopilot =
      options.autopilot === undefined || options.autopilot === false
        ? undefined
        : { ...DEFAULT_AUTOPILOT, ...(options.autopilot === true ? {} : options.autopilot) };
    this.#spec = { voltage: options.voltage ?? 230, phases: options.phases ?? 3 };
    this.#tickS = (options.tickMs ?? 1_000) / 1_000;
    this.#queueStore = options.queueStore ?? new MemoryQueueStore();
    this.#firmwareVersion = options.firmwareVersion;
    const maxProfiles = options.maxProfiles ?? 16;
    this.deviceModel = new DeviceModel(
      [
        ...standardDeviceModel({
          identity: options.identity,
          vendor: (options.vendor ?? 'ocpp-kit').slice(0, 50),
          model: (options.model ?? 'Simulator201').slice(0, 20),
          serialNumber: options.identity.slice(0, 25),
          evses: count,
          maxPowerW: options.maxPowerW ?? 22_000,
          phases: this.#spec.phases,
          heartbeatIntervalS: options.heartbeatIntervalS ?? 300,
          txUpdatedIntervalS: options.txUpdatedIntervalS ?? 60,
          txStartPoint: options.txStartPoint ?? ['PowerPathClosed'],
          txStopPoint: options.txStopPoint ?? ['EVConnected', 'Authorized'],
          maxProfiles,
          securityProfile: options.password === undefined ? 0 : 1,
        }),
        ...(options.variables ?? []),
      ],
      { itemsPerMessage: () => undefined },
    );
    this.profiles = new ChargingProfileManager201({
      evses: count,
      maxStackLevel: () => this.deviceModel.integer(V.profileStackLevel, 8),
      maxPeriods: () => this.deviceModel.integer(V.periodsPerSchedule, 24),
      maxProfiles,
    });
    this.localAuthList = new IdTokenLocalList({
      itemsPerMessage: () => this.deviceModel.integer(V.localAuthListItemsPerMessage, 250),
    });
    this.authorizationCache = new IdTokenCache(options.authorizationCacheSize ?? 1_000);
    const scheduler: SimulationScheduler = { later: (ms, fn) => this.#later(ms, fn) };
    this.#firmware = new FirmwareUpdater201(
      options.firmware ?? {},
      {
        notify: (status, requestId) => {
          this.emit('firmwareStatus', status);
          if (status === 'InvalidSignature') this.#securityEvent('InvalidFirmwareSignature');
          void this.#call('FirmwareStatusNotification', {
            status,
            ...(requestId === undefined ? {} : { requestId }),
          });
        },
        prepareInstallation: () => this.#prepareInstallation(),
        abortInstallation: () => {
          this.#installWaiters = [];
        },
        reboot: (version) => {
          this.#firmwareVersion = version;
          this.#later(0, () => void this.#reboot('FirmwareUpdate'));
        },
      },
      scheduler,
    );
    this.#logs = new LogUploader(
      options.identity,
      options.logs ?? {},
      {
        notify: (status, requestId) => {
          this.emit('logStatus', status);
          void this.#call('LogStatusNotification', {
            status,
            ...(requestId === undefined ? {} : { requestId }),
          });
        },
        collect: (logType, oldest, latest) =>
          this.#log
            .filter(
              ({ at, security }) =>
                (logType === 'SecurityLog' ? security : true) &&
                (!oldest || at >= oldest) &&
                (!latest || at <= latest),
            )
            .map(({ at, line }) => `${at.toISOString()} ${line}`)
            .join('\n'),
        uploaded: (upload) => this.emit('logUploaded', upload),
      },
      scheduler,
    );
    this.#evses = Array.from({ length: count }, (_, index) => this.#createEvse(index + 1));
    this.#bindDeviceModel();
    this.deviceModel.onChange((ref) => {
      if (
        ref.component === V.heartbeatInterval.component &&
        ref.variable === V.heartbeatInterval.variable
      ) {
        if (this.isRegistered) this.#startHeartbeat();
      }
      if (ref.component === 'SecurityCtrlr')
        this.#securityEvent('ReconfigurationOfSecurityParameters');
    });
    this.#client = this.#createClient();
  }

  /** Whether the station has an open connection. */
  get isConnected(): boolean {
    return this.#client.isConnected;
  }

  /** Whether the last BootNotification was accepted. */
  get isRegistered(): boolean {
    return this.#registration === 'Accepted';
  }

  /** Status of the latest BootNotificationResponse since the last (re)boot, if any. */
  get registrationStatus(): v201.RegistrationStatus | undefined {
    return this.#registration;
  }

  /** Firmware version reported in BootNotification. */
  get firmwareVersion(): string | undefined {
    return this.#firmwareVersion;
  }

  /** Current reservations. */
  get reservations(): Reservation201[] {
    return [...this.#reservations.values()];
  }

  /** Network connection profiles installed with SetNetworkProfile, by configuration slot. */
  get networkProfiles(): ReadonlyMap<number, v201.NetworkConnectionProfile> {
    return this.#networkProfiles;
  }

  /** Number of TransactionEvent messages waiting for delivery. */
  get queueSize(): number {
    return this.#client.queueSize;
  }

  /** Snapshot of every EVSE. */
  get evses(): EvseSnapshot[] {
    return this.#evses.map((e) => ({
      evseId: e.id,
      connectorId: 1,
      status: e.status,
      plugged: e.plugged,
      transactionId: e.tx?.id,
      chargingState: e.tx?.chargingState,
      reservationId: this.#reservationFor(e)?.id,
      energyWh: Math.round(e.energyWh),
      powerW: Math.round(e.powerW),
      offeredW: Math.round(e.offeredW),
      soc: e.ev ? Math.round(e.ev.soc * 1_000) / 10 : undefined,
    }));
  }

  /** The EVSE snapshots under the name fleets and the CLI use for 1.6 chargers. */
  get connectors(): EvseSnapshot[] {
    return this.evses;
  }

  /** Aggregated counters. */
  stats(): ChargerStats {
    return {
      connected: this.isConnected,
      registered: this.isRegistered,
      activeTransactions: this.#evses.filter((e) => e.tx && !e.tx.ended).length,
      sessionsStarted: this.#sessionsStarted,
      sessionsCompleted: this.#sessionsCompleted,
      energyWh: this.#evses.reduce((sum, e) => sum + e.energyWh, 0),
      powerW: this.#evses.reduce((sum, e) => sum + e.powerW, 0),
      callsSent: this.#callsSent,
      callErrors: this.#callErrors,
    };
  }

  /** Connect, boot and start the simulation. Resolves once connected. */
  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#tick = setInterval(
      () => {
        this.#onTick();
      },
      timerDelay(this.#tickS * 1_000),
    );
    await this.#client.connect();
  }

  /** Stop the simulation and disconnect (like a power cut: transactions are not ended). */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#bootRetry) clearTimeout(this.#bootRetry);
    if (this.#tick) clearInterval(this.#tick);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#firmware.cancel();
    this.#logs.cancel();
    for (const e of this.#evses) {
      if (e.autoTimer) clearTimeout(e.autoTimer);
      if (e.authorization?.timer) clearTimeout(e.authorization.timer);
    }
    await this.#client.close(1000, 'Simulator stopped');
  }

  // -------------------------------------------------------------------------------------------
  // Manual control (also used by the autopilot)
  // -------------------------------------------------------------------------------------------

  /** Plug an EV into an EVSE. */
  plugIn(evseId: number, ev: EvProfile = randomEvProfile(this.#random)): void {
    const e = this.#evse(evseId);
    if (e.plugged) throw new RangeError(`EVSE ${evseId} is already plugged in`);
    e.plugged = true;
    e.ev = new ElectricVehicle(ev);
    e.fullSince = undefined;
    const auth = e.authorization;
    if (auth?.timer) {
      clearTimeout(auth.timer);
      auth.timer = undefined;
    }
    if (e.tx) {
      this.#setChargingState(e, 'EVConnected', 'CablePluggedIn');
    } else if (this.#canStart(e)) {
      this.#maybeStart(e, 'CablePluggedIn');
    }
    this.#refreshStatus(e);
    if (this.#autopilot && !e.authorization && !e.claimed) {
      this.#schedule(e, this.#autopilot.swipeDelayS, () => {
        void this.#driverSwipe(e, this.#randomToken());
      });
    }
  }

  /**
   * Unplug the EV. The transaction ends when EVConnected (or PowerPathClosed) is a stop point
   * and `StopTxOnEVSideDisconnect` is true; otherwise it is suspended until the EV returns.
   */
  unplug(evseId: number): void {
    const e = this.#evse(evseId);
    if (!e.plugged) return;
    e.plugged = false;
    e.ev = undefined;
    e.powerW = 0;
    if (e.autoTimer) clearTimeout(e.autoTimer);
    const tx = e.tx;
    if (tx && !tx.ended) {
      const stopPoints = this.#stopPoints();
      const endsHere =
        (stopPoints.has('EVConnected') || stopPoints.has('PowerPathClosed')) &&
        this.deviceModel.boolean(V.stopTxOnEvSideDisconnect, true);
      if (endsHere) {
        this.#endTransaction(e, 'EVCommunicationLost', tx.pendingStopReason ?? 'EVDisconnected');
      } else {
        this.#setChargingState(e, 'Idle', 'EVCommunicationLost');
      }
    }
    if (!e.tx && e.authorization && !this.#autopilot) {
      // An authorization without cable waits for the EV again.
      this.#armConnectionTimeout(e);
    }
    this.#refreshStatus(e);
  }

  /**
   * Present an idToken (type ISO14443 unless given) at an EVSE. With a transaction, a token of
   * the same group stops it; otherwise the token is authorized and a transaction starts per
   * TxStartPoint, subject to reservations.
   *
   * @returns whether the token was accepted
   */
  async swipe(evseId: number, idToken: string | v201.IdToken): Promise<boolean> {
    const e = this.#evse(evseId);
    const token: v201.IdToken =
      typeof idToken === 'string' ? { idToken, type: 'ISO14443' } : idToken;
    if (e.tx?.ended === false && e.authorization) return this.#presentToStop(e, token);
    if (e.authorization || e.claimed || !this.#canStart(e)) return false;
    e.claimed = true;
    let decision: IdTokenDecision;
    try {
      decision = await this.#authorize(token);
    } finally {
      e.claimed = false;
    }
    // Another start may have claimed the EVSE while the token was being checked.
    if (!decision.accepted || isAuthorized(e) || !this.#canStart(e)) return false;
    const group = decision.idTokenInfo?.groupIdToken;
    const reservation = this.#claimReservation(e, token, group);
    if (reservation === false) return false;
    this.#authorizeEvse(
      e,
      { token, group, remoteStartId: undefined, reservation, profile: undefined, timer: undefined },
      'Authorized',
    );
    return true;
  }

  /** End the transaction on an EVSE locally (as if the driver stopped it at the station). */
  stopTransaction(evseId: number, reason: v201.StoppedReason = 'Local'): void {
    const e = this.#evse(evseId);
    if (!e.tx || e.tx.ended) return;
    this.#deauthorize(e, 'StopAuthorized', reason);
  }

  /** Put an EVSE in the Faulted state, ending its transaction and removing its reservation. */
  fault(evseId: number): void {
    const e = this.#evse(evseId);
    e.faulted = true;
    if (e.tx && !e.tx.ended) this.#endTransaction(e, 'AbnormalCondition', 'Other');
    this.#dropAuthorization(e);
    this.#removeReservationOf(e);
    this.#refreshStatus(e);
  }

  /** Clear a fault. */
  clearFault(evseId: number): void {
    const e = this.#evse(evseId);
    e.faulted = false;
    this.#refreshStatus(e);
  }

  /**
   * Set (or with `undefined` release) an external limit on an EVSE (0: the station), as an energy
   * management system would. It becomes a `ChargingStationExternalConstraints` profile and the
   * CSMS is told with NotifyChargingLimit or ClearedChargingLimit.
   */
  setExternalLimit(evseId: number, watts: number | undefined): void {
    if (watts === undefined) {
      if (this.profiles.clearExternal(evseId)) {
        void this.#call('ClearedChargingLimit', { chargingLimitSource: 'EMS', evseId });
      }
      return;
    }
    const schedule: v201.ChargingSchedule = {
      id: 1,
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [{ startPeriod: 0, limit: watts }],
    };
    const result = this.profiles.setExternal(evseId, {
      id: 1_000_000 + evseId,
      stackLevel: 0,
      chargingProfilePurpose: 'ChargingStationExternalConstraints',
      chargingProfileKind: 'Relative',
      chargingSchedule: [schedule],
    });
    if (result.status === 'Accepted') {
      void this.#call('NotifyChargingLimit', {
        chargingLimit: { chargingLimitSource: 'EMS', isGridCritical: false },
        evseId,
        chargingSchedule: [schedule],
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------

  #evse(evseId: number): Evse {
    const e = this.#evses[evseId - 1];
    if (!e) throw new RangeError(`Unknown EVSE ${evseId}`);
    return e;
  }

  #createEvse(id: number): Evse {
    return {
      id,
      plugged: false,
      ev: undefined,
      energyWh: 0,
      powerW: 0,
      offeredW: 0,
      operative: true,
      pendingInoperative: false,
      faulted: false,
      authorization: undefined,
      claimed: false,
      tx: undefined,
      status: 'Available',
      reported: undefined,
      autoTimer: undefined,
      fullSince: undefined,
    };
  }

  /** Live values of the device model. */
  #bindDeviceModel(): void {
    const model = this.deviceModel;
    model.bind({ component: 'ClockCtrlr', variable: 'DateTime' }, () => new Date().toISOString());
    model.bind(V.chargingProfileEntries, () => String(this.profiles.size));
    model.bind(V.localAuthListEntries, () => String(this.localAuthList.size));
    model.bind(V.stationPower, () =>
      String(Math.round(this.#evses.reduce((sum, e) => sum + e.powerW, 0))),
    );
    model.bind(V.stationAvailabilityState, () =>
      this.#stationOperative ? 'Available' : 'Unavailable',
    );
    model.bind({ component: 'ChargingStation', variable: 'Available' }, () =>
      String(this.#stationOperative),
    );
    for (const e of this.#evses) {
      model.bind(evseVariable(e.id, 'AvailabilityState'), () => e.status);
      model.bind(evseVariable(e.id, 'Available'), () =>
        String(e.operative && this.#stationOperative),
      );
      model.bind(evseVariable(e.id, 'Power'), () => String(Math.round(e.powerW)));
      model.bind(evseVariable(e.id, 'AvailabilityState', 1), () => e.status);
      model.bind(evseVariable(e.id, 'Available', 1), () =>
        String(e.operative && this.#stationOperative),
      );
    }
  }

  #createClient(): ChargingStation {
    const model = this.deviceModel;
    const client = new ChargingStation({
      transactionMessageAttempts: () => model.integer(V.messageAttempts, 3),
      transactionMessageRetryIntervalMs: () => model.integer(V.messageAttemptInterval, 10) * 1_000,
      callTimeoutMs: model.integer(V.messageTimeout, 30) * 1_000,
      pingIntervalMs: model.integer(V.webSocketPingInterval, 0) * 1_000,
      random: () => this.#jitter.next(),
      ...this.#options.client,
      identity: this.identity,
      url: this.#options.url,
      ...(this.#options.password === undefined ? {} : { password: this.#options.password }),
      offlineQueue: { store: this.#queueStore },
    });
    client.on('open', () => {
      this.emit('connection', true);
      const offlineMs = this.#offlineSince === undefined ? 0 : Date.now() - this.#offlineSince;
      this.#offlineSince = undefined;
      if (this.isRegistered) {
        // After a long outage report every connector, otherwise only the ones that changed.
        const all = offlineMs >= model.integer(V.offlineThreshold, 60) * 1_000;
        for (const e of this.#evses) if (all || e.reported !== e.status) void this.#sendStatus(e);
      } else {
        void this.#boot();
      }
    });
    client.on('close', () => {
      this.#offlineSince ??= Date.now();
      this.emit('connection', false);
    });
    client.on('callCompleted', (event) => {
      this.#callsSent++;
      if (event.error) this.#callErrors++;
      this.emit('callCompleted', event);
    });
    client.on('message', (direction, raw) => {
      this.#record(`${direction === 'in' ? '<<' : '>>'} ${raw}`);
    });
    this.#registerHandlers(client);
    return client;
  }

  /** Send a CALL, swallowing failures (they are counted in the stats). */
  async #call<A extends StationAction>(
    action: A,
    payload: StationRequest<A>,
  ): Promise<StationResponse<A> | undefined> {
    try {
      return await this.#client.call(action, payload);
    } catch {
      return undefined;
    }
  }

  #later(ms: number, fn: () => void): () => void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#stopped) fn();
    }, timerDelay(ms));
    this.#timers.add(timer);
    return () => {
      clearTimeout(timer);
      this.#timers.delete(timer);
    };
  }

  #schedule(e: Evse, rangeS: readonly [number, number], fn: () => void): void {
    if (e.autoTimer) clearTimeout(e.autoTimer);
    const delayMs = Math.round(this.#random.float(rangeS[0], rangeS[1]) * 1_000);
    e.autoTimer = setTimeout(() => {
      e.autoTimer = undefined;
      if (!this.#stopped && !this.#rebooting) fn();
    }, timerDelay(delayMs));
  }

  #randomToken(): v201.IdToken {
    const tokens = this.#options.idTokens;
    const idToken =
      tokens && tokens.length > 0
        ? this.#random.pick(tokens)
        : `TOK${String(this.#random.int(0, 99_999)).padStart(5, '0')}`;
    return { idToken, type: 'ISO14443' };
  }

  #record(line: string, security = false): void {
    this.#log.push({ at: new Date(), line, security });
    if (this.#log.length > LOG_CAPACITY) this.#log.shift();
  }

  #securityEvent(type: string, techInfo?: string): void {
    this.#record(`security ${type}${techInfo ? `: ${techInfo}` : ''}`, true);
    if (!this.isRegistered) return;
    void this.#call('SecurityEventNotification', {
      type,
      timestamp: new Date().toISOString(),
      ...(techInfo === undefined ? {} : { techInfo }),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Registration, heartbeat and status
  // -------------------------------------------------------------------------------------------

  async #boot(): Promise<void> {
    if (this.#bootRetry) clearTimeout(this.#bootRetry);
    this.#bootRetry = undefined;
    const firmwareVersion = this.#firmwareVersion;
    const reason = this.#bootReason;
    const response = await this.#call('BootNotification', {
      chargingStation: {
        vendorName: (this.#options.vendor ?? 'ocpp-kit').slice(0, 50),
        model: (this.#options.model ?? 'Simulator201').slice(0, 20),
        serialNumber: this.identity.slice(0, 25),
        ...(firmwareVersion === undefined ? {} : { firmwareVersion: firmwareVersion.slice(0, 50) }),
      },
      reason,
    });
    if (this.#stopped || this.#rebooting) return;
    const fallbackS = this.#options.bootRetryS ?? 30;
    if (!response) {
      this.#scheduleBootRetry(fallbackS);
      return;
    }
    this.#registration = response.status;
    if (response.status === 'Accepted') {
      if (response.interval > 0)
        this.deviceModel.set(V.heartbeatInterval, String(response.interval));
      this.#startHeartbeat();
      for (const e of this.#evses) void this.#sendStatus(e);
      this.emit('registered');
      this.#securityEvent(
        reason === 'PowerUp'
          ? 'StartupOfTheDevice'
          : reason === 'FirmwareUpdate'
            ? 'FirmwareUpdated'
            : 'ResetOrReboot',
      );
      this.#firmware.onBootAccepted();
      if (this.#autopilot) for (const e of this.#evses) this.#onIdle(e);
      return;
    }
    const retryS = response.interval > 0 ? response.interval : fallbackS;
    if (response.status === 'Rejected') {
      void this.#client.reconnectAfter(timerDelay(retryS * 1_000), 'Registration rejected');
      return;
    }
    this.#scheduleBootRetry(retryS);
  }

  #scheduleBootRetry(seconds: number): void {
    if (this.#bootRetry) clearTimeout(this.#bootRetry);
    this.#bootRetry = setTimeout(
      () => {
        this.#bootRetry = undefined;
        if (!this.#stopped && this.#client.isConnected && !this.isRegistered) void this.#boot();
      },
      timerDelay(seconds * 1_000),
    );
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const intervalS = this.deviceModel.integer(V.heartbeatInterval, 300);
    if (intervalS <= 0 || this.#stopped) return;
    this.#heartbeat = setInterval(
      () => {
        if (this.#client.isConnected) void this.#call('Heartbeat', {});
      },
      timerDelay(intervalS * 1_000),
    );
  }

  /** The status an EVSE's connector should have now. */
  #statusOf(e: Evse): v201.ConnectorStatus {
    if (e.faulted) return 'Faulted';
    if (!e.operative || !this.#stationOperative) return 'Unavailable';
    if (e.plugged || (e.tx && !e.tx.ended)) return 'Occupied';
    if (this.#reservationFor(e) !== undefined) return 'Reserved';
    return 'Available';
  }

  /** Recompute the status and report a change. */
  #refreshStatus(e: Evse): void {
    const status = this.#statusOf(e);
    if (status === e.status) return;
    const previous = e.status;
    e.status = status;
    this.emit('status', e.id, status);
    void this.#sendStatus(e);
    if (status === 'Faulted' || previous === 'Faulted')
      this.#notifyEvent(e, status, previous === 'Faulted');
    if (status === 'Available') this.#onIdle(e);
  }

  /** @param triggered - requested by TriggerMessage, which is allowed even while Pending */
  async #sendStatus(e: Evse, triggered = false): Promise<void> {
    if (!this.#client.isConnected || (!triggered && !this.isRegistered)) return;
    e.reported = e.status;
    await this.#call('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: e.status,
      evseId: e.id,
      connectorId: 1,
    });
  }

  /** Report a fault (or its clearing) of a connector as a device model event. */
  #notifyEvent(e: Evse, status: v201.ConnectorStatus, cleared: boolean): void {
    if (!this.isRegistered) return;
    const now = new Date().toISOString();
    void this.#call('NotifyEvent', {
      generatedAt: now,
      seqNo: 0,
      eventData: [
        {
          eventId: ++this.#eventSeqNo,
          timestamp: now,
          trigger: 'Delta',
          actualValue: status,
          ...(cleared ? { cleared: true } : {}),
          component: { name: 'Connector', evse: { id: e.id, connectorId: 1 } },
          variable: { name: 'AvailabilityState' },
          eventNotificationType: 'HardWiredNotification',
        },
      ],
    });
  }

  // -------------------------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------------------------

  #authorize(token: v201.IdToken): Promise<IdTokenDecision> {
    const model = this.deviceModel;
    return authorizeIdToken(token, {
      online: this.#client.isConnected && this.isRegistered,
      policy: {
        authorizationEnabled: model.boolean(V.authEnabled, true),
        localListEnabled: model.boolean(V.localAuthListEnabled, true),
        cacheEnabled: model.boolean(V.authCacheEnabled, true),
        localPreAuthorize: model.boolean(V.localPreAuthorize, false),
        localAuthorizeOffline: model.boolean(V.localAuthorizeOffline, true),
        offlineTxForUnknownId: model.boolean(V.offlineTxForUnknownId, false),
        cacheLifetimeS: model.integer(V.authCacheLifeTime, 86_400),
      },
      localList: this.localAuthList,
      cache: this.authorizationCache,
      askCsms: async (candidate) => {
        try {
          const { idTokenInfo } = await this.#client.call('Authorize', { idToken: candidate });
          return { kind: 'answered', idTokenInfo };
        } catch (error) {
          return error instanceof RpcError ? { kind: 'error' } : { kind: 'unreachable' };
        }
      },
    });
  }

  /** Remember what the CSMS said about a token in a TransactionEventResponse. */
  #remember(token: v201.IdToken, info: v201.IdTokenInfo): void {
    if (!this.deviceModel.boolean(V.authCacheEnabled, true) || this.localAuthList.has(token))
      return;
    this.authorizationCache.update(
      token,
      info,
      this.deviceModel.integer(V.authCacheLifeTime, 86_400),
    );
  }

  /** A token presented at an EVSE with a transaction: stop it when it belongs to the group. */
  async #presentToStop(e: Evse, token: v201.IdToken): Promise<boolean> {
    const auth = e.authorization;
    const tx = e.tx;
    if (!auth || !tx) return false;
    if (!sameIdTokenGroup({ token }, { token: auth.token })) {
      const decision = await this.#authorize(token);
      if (!decision.accepted || e.tx !== tx || e.authorization !== auth) return false;
      if (
        !sameIdTokenGroup(
          { token, group: decision.idTokenInfo?.groupIdToken },
          { token: auth.token, group: auth.group },
        )
      ) {
        return false;
      }
    }
    this.#deauthorize(e, 'StopAuthorized', 'Local', token);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Reservations
  // -------------------------------------------------------------------------------------------

  #reservationFor(e: Evse): Reservation201 | undefined {
    for (const reservation of this.#reservations.values()) {
      if (reservation.evseId === e.id) return reservation;
    }
    return undefined;
  }

  #isFree(e: Evse): boolean {
    return this.#statusOf(e) === 'Available' && !e.authorization && !e.claimed;
  }

  /**
   * The reservation a session on `e` uses, `undefined` when it needs none, or `false` when the
   * EVSE is held for someone else (or every free EVSE is needed by reservations for any EVSE).
   */
  #claimReservation(
    e: Evse,
    token: v201.IdToken,
    group: v201.IdToken | undefined,
  ): Reservation201 | undefined | false {
    const matches = (r: Reservation201): boolean =>
      sameIdTokenGroup({ token, group }, { token: r.idToken, group: r.groupIdToken });
    const own = this.#reservationFor(e);
    if (own) return matches(own) ? own : false;
    const anyEvse = [...this.#reservations.values()].filter((r) => r.evseId === undefined);
    const mine = anyEvse.find(matches);
    if (mine) return mine;
    if (anyEvse.length === 0) return undefined;
    const freeOthers = this.#evses.filter((other) => other !== e && this.#isFree(other)).length;
    return freeOthers >= anyEvse.length ? undefined : false;
  }

  #reserveNow(request: v201.ReserveNowRequest): v201.ReserveNowResponse {
    const model = this.deviceModel;
    if (!model.boolean(V.reservationEnabled, true)) return { status: 'Rejected' };
    if (new Date(request.expiryDateTime) <= new Date()) return { status: 'Rejected' };
    if (request.connectorType !== undefined && request.connectorType !== 'cType2') {
      return { status: 'Rejected', statusInfo: { reasonCode: 'UnsupportedConnector' } };
    }
    const existing = this.#reservations.get(request.id);
    const others = [...this.#reservations.values()].filter((r) => r.id !== request.id);
    const reservedElsewhere = (e: Evse): boolean => others.some((r) => r.evseId === e.id);
    const free = (e: Evse): boolean =>
      !reservedElsewhere(e) &&
      !e.plugged &&
      !e.tx &&
      !e.authorization &&
      !e.faulted &&
      e.operative &&
      this.#stationOperative;
    if (request.evseId === undefined) {
      if (!model.boolean(V.nonEvseSpecific, true)) return { status: 'Rejected' };
      if (this.#evses.every((e) => e.faulted)) return { status: 'Faulted' };
      if (!this.#stationOperative || this.#evses.every((e) => e.faulted || !e.operative)) {
        return { status: 'Unavailable' };
      }
      const anyEvse = others.filter((r) => r.evseId === undefined).length;
      if (this.#evses.filter(free).length <= anyEvse) return { status: 'Occupied' };
    } else {
      if (request.evseId < 1 || request.evseId > this.#evses.length) return { status: 'Rejected' };
      const e = this.#evse(request.evseId);
      if (e.faulted) return { status: 'Faulted' };
      if (!e.operative || !this.#stationOperative) return { status: 'Unavailable' };
      if (!free(e)) return { status: 'Occupied' };
    }
    const reservation: Reservation201 = {
      id: request.id,
      evseId: request.evseId,
      idToken: request.idToken,
      groupIdToken: request.groupIdToken,
      expiry: new Date(request.expiryDateTime),
    };
    this.#reservations.set(reservation.id, reservation);
    if (existing?.evseId !== undefined) this.#refreshStatus(this.#evse(existing.evseId));
    if (reservation.evseId !== undefined) this.#refreshStatus(this.#evse(reservation.evseId));
    this.emit('reservation', 'reserved', reservation);
    this.#scheduleReservedDriver(reservation);
    return { status: 'Accepted' };
  }

  #endReservation(
    reservation: Reservation201,
    kind: 'used' | 'cancelled' | 'expired' | 'removed',
  ): void {
    if (this.#reservations.get(reservation.id) !== reservation) return;
    this.#reservations.delete(reservation.id);
    this.emit('reservation', kind, reservation);
    if (kind === 'expired' || kind === 'removed') {
      void this.#call('ReservationStatusUpdate', {
        reservationId: reservation.id,
        reservationUpdateStatus: kind === 'expired' ? 'Expired' : 'Removed',
      });
    }
    if (reservation.evseId !== undefined) this.#refreshStatus(this.#evse(reservation.evseId));
  }

  /** An EVSE became Faulted or Unavailable: its reservation is removed. */
  #removeReservationOf(e: Evse): void {
    const reservation = this.#reservationFor(e);
    if (reservation) this.#endReservation(reservation, 'removed');
  }

  #scheduleReservedDriver(reservation: Reservation201): void {
    const autopilot = this.#autopilot;
    if (!autopilot) return;
    const delayMs = Math.round(this.#random.float(...autopilot.reservationArrivalS) * 1_000);
    if (Date.now() + delayMs >= reservation.expiry.getTime()) return; // a no-show
    this.#later(delayMs, () => {
      if (this.#reservations.get(reservation.id) !== reservation) return;
      const e =
        reservation.evseId !== undefined
          ? this.#evse(reservation.evseId)
          : this.#evses.find((candidate) => this.#isFree(candidate));
      if (!e || e.plugged || e.tx || e.authorization) return;
      this.plugIn(e.id);
      this.#schedule(e, autopilot.swipeDelayS, () => {
        void this.#driverSwipe(e, reservation.idToken);
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------------------------

  #startPoints(): Set<string> {
    return new Set(this.deviceModel.list(V.txStartPoint));
  }

  #stopPoints(): Set<string> {
    return new Set(this.deviceModel.list(V.txStopPoint));
  }

  /** Whether a new session may start on `e`. */
  #canStart(e: Evse): boolean {
    return (
      !e.faulted &&
      e.operative &&
      this.#stationOperative &&
      !this.#rebooting &&
      !this.#pendingReset &&
      !this.#firmware.blocksSessions &&
      this.#installWaiters.length === 0 &&
      (this.isRegistered || this.#registration === undefined)
    );
  }

  /** Authorized: remember it, then start or update the transaction as TxStartPoint says. */
  #authorizeEvse(e: Evse, auth: Authorization, trigger: v201.TriggerReason): void {
    e.authorization = auth;
    if (auth.reservation) this.#endReservation(auth.reservation, 'used');
    if (e.tx && !e.tx.ended) {
      if (auth.remoteStartId !== undefined) e.tx.remoteStartId = auth.remoteStartId;
      this.#transactionEvent(e, 'Updated', trigger, { idToken: auth.token });
      this.#installPendingProfile(e);
    } else {
      this.#maybeStart(e, trigger);
    }
    if (!e.plugged) {
      this.#armConnectionTimeout(e);
      if (this.#autopilot) {
        this.#schedule(e, this.#autopilot.plugInDelayS, () => {
          if (!e.plugged && e.authorization === auth) this.plugIn(e.id);
        });
      }
    }
    this.#refreshStatus(e);
  }

  /** Authorized but no cable: wait EVConnectionTimeOut seconds for the EV. */
  #armConnectionTimeout(e: Evse): void {
    const auth = e.authorization;
    if (!auth) return;
    if (auth.timer) clearTimeout(auth.timer);
    const timeoutS = this.deviceModel.integer(V.evConnectionTimeOut, 60);
    auth.timer = setTimeout(
      () => {
        if (e.authorization !== auth || e.plugged) return;
        auth.timer = undefined;
        e.authorization = undefined;
        if (e.tx && !e.tx.ended) this.#endTransaction(e, 'EVConnectTimeout', 'Timeout');
        this.#refreshStatus(e);
      },
      timerDelay(timeoutS * 1_000),
    );
  }

  /** Start a transaction when one of the start points holds. */
  #maybeStart(e: Evse, trigger: v201.TriggerReason): void {
    if (e.tx && !e.tx.ended) return;
    const points = this.#startPoints();
    const auth = e.authorization;
    const holds =
      (points.has('EVConnected') && e.plugged) ||
      (points.has('Authorized') && auth !== undefined) ||
      (points.has('PowerPathClosed') && e.plugged && auth !== undefined);
    // EnergyTransfer starts on the first tick with energy, see #onTick.
    if (holds) this.#startTransaction(e, trigger);
  }

  #startTransaction(e: Evse, trigger: v201.TriggerReason): void {
    const auth = e.authorization;
    const interval = this.deviceModel.integer(V.txUpdatedInterval, 60);
    const endedInterval = this.deviceModel.integer(V.txEndedInterval, 0);
    const tx: Transaction = {
      id: uuidFrom(this.#random),
      startedAt: new Date(),
      meterStartWh: Math.round(e.energyWh),
      seqNo: 0,
      chargingState: e.plugged ? 'EVConnected' : 'Idle',
      evseSent: false,
      remoteStartId: auth?.remoteStartId,
      remoteStartSent: false,
      reservationId: auth?.reservation?.id,
      elapsedS: 0,
      timeSpentChargingS: 0,
      nextUpdateS: interval > 0 ? interval : Infinity,
      nextEndedSampleS: endedInterval > 0 ? endedInterval : Infinity,
      endedSamples: [],
      pendingStopReason: undefined,
      invalidEnergyLimitWh: undefined,
      suspended: false,
      lastOfferedW: 0,
      ended: false,
    };
    e.tx = tx;
    this.#sessionsStarted++;
    this.#transactionEvent(e, 'Started', trigger, {
      ...(auth ? { idToken: auth.token } : {}),
      meterValue: this.#reading(e, 'Transaction.Begin', V.txStartedMeasurands),
    });
    this.emit('transactionStarted', e.id, tx.id);
    // The charging state follows at the next physics tick, once power is offered.
    this.#installPendingProfile(e);
    this.#refreshStatus(e);
  }

  /** A TxProfile that came with RequestStartTransaction applies once the transaction exists. */
  #installPendingProfile(e: Evse): void {
    const profile = e.authorization?.profile;
    const tx = e.tx;
    if (!profile || !tx) return;
    this.profiles.set(
      e.id,
      { ...profile, transactionId: tx.id },
      { transactionId: tx.id, startedAt: tx.startedAt },
    );
  }

  /**
   * The driver (or the CSMS) withdrew the authorization. With Authorized (or PowerPathClosed)
   * as a stop point the transaction ends; otherwise energy stops and it ends with the next stop
   * point (e.g. when the cable is unplugged).
   */
  #deauthorize(
    e: Evse,
    trigger: v201.TriggerReason,
    reason: v201.StoppedReason,
    token?: v201.IdToken,
  ): void {
    const tx = e.tx;
    this.#dropAuthorization(e);
    if (!tx || tx.ended) {
      this.#refreshStatus(e);
      return;
    }
    const stopPoints = this.#stopPoints();
    if (stopPoints.has('Authorized') || stopPoints.has('PowerPathClosed') || !e.plugged) {
      this.#endTransaction(e, trigger, reason, token);
      return;
    }
    tx.pendingStopReason = reason;
    e.powerW = 0;
    this.#transactionEvent(e, 'Updated', trigger, {
      ...(token ? { idToken: token } : {}),
      chargingState: 'EVConnected',
    });
    if (this.#autopilot) {
      this.#schedule(e, this.#autopilot.unplugDelayS, () => {
        this.unplug(e.id);
      });
    }
  }

  #dropAuthorization(e: Evse): void {
    const auth = e.authorization;
    if (auth?.timer) clearTimeout(auth.timer);
    e.authorization = undefined;
  }

  #endTransaction(
    e: Evse,
    trigger: v201.TriggerReason,
    reason: v201.StoppedReason,
    token?: v201.IdToken,
  ): void {
    const tx = e.tx;
    if (!tx || tx.ended) return;
    tx.ended = true;
    e.powerW = 0;
    this.#dropAuthorization(e);
    const endReading = this.#reading(e, 'Transaction.End', V.txEndedMeasurands);
    this.#transactionEvent(e, 'Ended', trigger, {
      ...(token ? { idToken: token } : {}),
      // Energy has stopped; the EV may still be connected.
      chargingState: e.plugged ? 'EVConnected' : 'Idle',
      stoppedReason: reason,
      meterValue: [...tx.endedSamples, ...(endReading ?? [])],
    });
    this.profiles.transactionEnded(e.id);
    e.tx = undefined;
    this.#sessionsCompleted++;
    this.emit('transactionEnded', e.id, tx.id, reason, Math.round(e.energyWh) - tx.meterStartWh);
    if (e.pendingInoperative) {
      e.pendingInoperative = false;
      e.operative = false;
    }
    if (this.#pendingStationInoperative && this.#evses.every((other) => !other.tx)) {
      this.#pendingStationInoperative = false;
      this.#stationOperative = false;
      for (const other of this.#evses) this.#refreshStatus(other);
    }
    this.#onSessionEnded();
    if (this.#autopilot && e.plugged) {
      this.#schedule(e, this.#autopilot.unplugDelayS, () => {
        this.unplug(e.id);
      });
    }
    this.#refreshStatus(e);
  }

  /**
   * Generate (and queue) a TransactionEvent with the next seqNo. The first event of a
   * transaction carries the EVSE, the first after a remote start the remoteStartId.
   */
  #transactionEvent(
    e: Evse,
    eventType: v201.TransactionEventKind,
    triggerReason: v201.TriggerReason,
    extra: {
      readonly idToken?: v201.IdToken;
      readonly chargingState?: v201.ChargingState;
      readonly stoppedReason?: v201.StoppedReason;
      readonly meterValue?: v201.MeterValue[] | undefined;
    } = {},
  ): void {
    const tx = e.tx;
    if (!tx) return;
    if (extra.chargingState) tx.chargingState = extra.chargingState;
    const includeRemoteStart = tx.remoteStartId !== undefined && !tx.remoteStartSent;
    const request: v201.TransactionEventRequest = {
      eventType,
      timestamp: new Date().toISOString(),
      triggerReason,
      seqNo: tx.seqNo++,
      ...(this.#client.isConnected ? {} : { offline: true }),
      ...(eventType === 'Started' && tx.reservationId !== undefined
        ? { reservationId: tx.reservationId }
        : {}),
      transactionInfo: {
        transactionId: tx.id,
        chargingState: tx.chargingState,
        ...(eventType === 'Started'
          ? {}
          : { timeSpentCharging: Math.round(tx.timeSpentChargingS) }),
        ...(extra.stoppedReason === undefined ? {} : { stoppedReason: extra.stoppedReason }),
        ...(includeRemoteStart ? { remoteStartId: tx.remoteStartId } : {}),
      },
      ...(tx.evseSent ? {} : { evse: { id: e.id, connectorId: 1 } }),
      ...(extra.idToken === undefined ? {} : { idToken: extra.idToken }),
      ...(extra.meterValue && extra.meterValue.length > 0 ? { meterValue: extra.meterValue } : {}),
    };
    tx.evseSent = true;
    if (includeRemoteStart) tx.remoteStartSent = true;
    this.emit('transactionEvent', request);
    const token = extra.idToken;
    void this.#client.call('TransactionEvent', request).then(
      (response) => {
        const info = response.idTokenInfo;
        if (!info || !token) return;
        this.#remember(token, info);
        if (info.status !== 'Accepted' && e.tx === tx && !tx.ended) this.#onTokenRefused(e, tx);
      },
      () => undefined,
    );
  }

  /** The CSMS refused the idToken of a running transaction (e.g. one authorized offline). */
  #onTokenRefused(e: Evse, tx: Transaction): void {
    if (this.deviceModel.boolean(V.stopTxOnInvalidId, true)) {
      this.#deauthorize(e, 'Deauthorized', 'DeAuthorized');
      return;
    }
    tx.invalidEnergyLimitWh = Math.max(0, this.deviceModel.integer(V.maxEnergyOnInvalidId, 0));
  }

  #setChargingState(e: Evse, state: v201.ChargingState, trigger: v201.TriggerReason): void {
    const tx = e.tx;
    if (!tx || tx.ended || tx.chargingState === state) return;
    this.#transactionEvent(e, 'Updated', trigger, { chargingState: state });
  }

  /** Re-derive the charging state from the physics after a change. */
  #evaluateEnergy(e: Evse): void {
    const tx = e.tx;
    if (!tx || tx.ended) return;
    const state: v201.ChargingState = !e.plugged
      ? 'Idle'
      : !e.authorization || tx.suspended || tx.pendingStopReason !== undefined
        ? 'EVConnected'
        : e.offeredW <= 0
          ? 'SuspendedEVSE'
          : e.powerW <= 0
            ? 'SuspendedEV'
            : 'Charging';
    if (state === tx.chargingState) return;
    const stopPoints = this.#stopPoints();
    if (tx.chargingState === 'Charging' && stopPoints.has('EnergyTransfer')) {
      this.#endTransaction(
        e,
        'ChargingStateChanged',
        state === 'SuspendedEV' ? 'StoppedByEV' : 'Other',
      );
      return;
    }
    this.#setChargingState(e, state, 'ChargingStateChanged');
  }

  // -------------------------------------------------------------------------------------------
  // Metering
  // -------------------------------------------------------------------------------------------

  #snapshot(e: Evse): MeterSnapshot {
    const maxPowerW = this.#options.maxPowerW ?? 22_000;
    return {
      energyWh: e.energyWh,
      powerW: e.powerW,
      offeredW: e.offeredW,
      voltage: this.#spec.voltage,
      phases: this.#spec.phases,
      soc: e.ev?.soc,
      temperatureC: 25 + (15 * e.powerW) / maxPowerW,
      frequencyHz: 50,
    };
  }

  #stationSnapshot(): MeterSnapshot {
    const sum = (pick: (e: Evse) => number): number =>
      this.#evses.reduce((total, e) => total + pick(e), 0);
    return {
      energyWh: sum((e) => e.energyWh),
      powerW: sum((e) => e.powerW),
      offeredW: sum((e) => e.offeredW),
      voltage: this.#spec.voltage,
      phases: this.#spec.phases,
      temperatureC: 25,
      frequencyHz: 50,
    };
  }

  #measurands(ref: (typeof V)[keyof typeof V]): MeasurandItem[] {
    return parseMeasurandList(this.deviceModel.list(ref).join(',')) ?? [];
  }

  /** One reading of the measurands configured in `ref`, or `undefined` when there are none. */
  #reading(
    e: Evse | undefined,
    context: v201.ReadingContext,
    ref: (typeof V)[keyof typeof V],
    intervalWh?: number,
    fallback = false,
  ): v201.MeterValue[] | undefined {
    if (!this.deviceModel.boolean(V.sampledDataEnabled, true) && ref !== V.alignedDataMeasurands)
      return undefined;
    const configured = this.#measurands(ref);
    const items = configured.length === 0 && fallback ? MEASURAND_FALLBACK : configured;
    const snapshot = e ? this.#snapshot(e) : this.#stationSnapshot();
    const sampledValue = sampleValues(items, snapshot, context, intervalWh).flatMap((value) => {
      const converted = sampled201(value);
      return converted ? [converted] : [];
    });
    return sampledValue.length === 0
      ? undefined
      : [{ timestamp: new Date().toISOString(), sampledValue }];
  }

  /** Every AlignedDataCtrlr.Interval boundary (aligned to midnight UTC). */
  #sampleClockAligned(now: Date): void {
    const model = this.deviceModel;
    const intervalS = model.boolean(V.alignedDataEnabled, true)
      ? model.integer(V.alignedDataInterval, 0)
      : 0;
    if (intervalS <= 0) {
      this.#nextAligned = undefined;
      return;
    }
    if (this.#nextAligned === undefined || intervalS !== this.#alignedIntervalS) {
      this.#alignedIntervalS = intervalS;
      this.#nextAligned = nextAlignedTime(now, intervalS);
      return;
    }
    if (now < this.#nextAligned) return;
    this.#nextAligned = nextAlignedTime(now, intervalS);
    const idle = model.boolean(V.alignedDataSendDuringIdle, false);
    for (const e of this.#evses) {
      const meterValue = this.#reading(e, 'Sample.Clock', V.alignedDataMeasurands);
      if (!meterValue) continue;
      if (e.tx && !e.tx.ended)
        this.#transactionEvent(e, 'Updated', 'MeterValueClock', { meterValue });
      else if (idle) void this.#call('MeterValues', { evseId: e.id, meterValue });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Physics
  // -------------------------------------------------------------------------------------------

  /** Power offered to the charging EVSEs: EVSE caps, then the station cap shared fairly. */
  #offeredPower(active: readonly Evse[], now: Date): Map<Evse, number> {
    const model = this.deviceModel;
    const caps = active.map((e) => {
      const hardware = model.integer(
        evseVariable(e.id, 'Power'),
        this.#options.maxPowerW ?? 22_000,
        'MaxSet',
      );
      const context: TransactionContext201 | undefined = e.tx
        ? { transactionId: e.tx.id, startedAt: e.tx.startedAt }
        : undefined;
      const limit = this.profiles.evseLimitW(e.id, now, context, this.#spec);
      return { e, cap: Math.max(0, Math.min(hardware, limit ?? Infinity)) };
    });
    const result = new Map<Evse, number>(caps.map(({ e, cap }) => [e, cap]));
    const stationMax = model.integer(V.stationPower, Infinity, 'MaxSet');
    const profiled = this.profiles.stationLimitW(now, this.#spec);
    const budget = Math.min(stationMax, profiled ?? Infinity);
    if (!Number.isFinite(budget)) return result;
    const shares = maxMinFairShare(
      caps.map(({ e, cap }) => ({
        cap,
        demand: e.ev ? acceptedPowerW(e.ev.profile, e.ev.soc) : 0,
      })),
      budget,
    );
    caps.forEach(({ e }, index) => result.set(e, shares[index] ?? 0));
    return result;
  }

  #onTick(): void {
    if (this.#rebooting) return;
    const now = new Date();
    for (const reservation of [...this.#reservations.values()]) {
      if (reservation.expiry <= now) this.#endReservation(reservation, 'expired');
    }
    const active = this.#evses.filter(
      (e) =>
        e.plugged &&
        e.ev &&
        e.authorization &&
        !(e.tx && (e.tx.ended || e.tx.suspended || e.tx.pendingStopReason !== undefined)),
    );
    const offered = this.#offeredPower(active, now);
    const interval = this.deviceModel.integer(V.txUpdatedInterval, 60);
    const endedInterval = this.deviceModel.integer(V.txEndedInterval, 0);
    const significance = this.deviceModel.integer(V.limitChangeSignificance, 1);
    for (const e of this.#evses) {
      const available = offered.get(e);
      if (e.ev && available !== undefined) {
        e.offeredW = available;
        e.powerW = e.ev.charge(available, this.#tickS);
        e.energyWh += (e.powerW * this.#tickS) / 3_600;
      } else {
        e.offeredW = 0;
        e.powerW = 0;
      }
      if (!e.tx && e.powerW > 0 && this.#startPoints().has('EnergyTransfer')) {
        this.#startTransaction(e, 'ChargingStateChanged');
      }
      const tx = e.tx;
      if (!tx || tx.ended) continue;
      if (tx.chargingState === 'Charging') tx.timeSpentChargingS += this.#tickS;
      this.#evaluateEnergy(e);
      // Ending a transaction clears e.tx.
      if (e.tx !== tx) continue;
      if (
        tx.chargingState === 'Charging' &&
        tx.lastOfferedW > 0 &&
        Math.abs(e.offeredW - tx.lastOfferedW) > (tx.lastOfferedW * significance) / 100
      ) {
        this.#transactionEvent(e, 'Updated', 'ChargingRateChanged');
      }
      tx.lastOfferedW = e.offeredW;
      if (
        tx.invalidEnergyLimitWh !== undefined &&
        e.energyWh - tx.meterStartWh >= tx.invalidEnergyLimitWh
      ) {
        tx.suspended = true;
      }
      tx.elapsedS += this.#tickS;
      if (tx.elapsedS >= tx.nextUpdateS) {
        tx.nextUpdateS += interval > 0 ? interval : Infinity;
        const meterValue = this.#reading(e, 'Sample.Periodic', V.txUpdatedMeasurands);
        if (meterValue) this.#transactionEvent(e, 'Updated', 'MeterValuePeriodic', { meterValue });
      }
      if (tx.elapsedS >= tx.nextEndedSampleS) {
        tx.nextEndedSampleS += endedInterval > 0 ? endedInterval : Infinity;
        const sample = this.#reading(e, 'Sample.Periodic', V.txEndedMeasurands);
        if (sample && tx.endedSamples.length < 1_000) tx.endedSamples.push(...sample);
      }
      if (e.ev) this.#autopilotStep(e, tx, e.ev);
    }
    this.#sampleClockAligned(now);
  }

  #autopilotStep(e: Evse, tx: Transaction, ev: ElectricVehicle): void {
    const autopilot = this.#autopilot;
    if (!autopilot) return;
    if (tx.elapsedS >= autopilot.maxSessionS) {
      this.stopTransaction(e.id, 'Local');
      return;
    }
    if (ev.isFull && e.fullSince === undefined) {
      e.fullSince = tx.elapsedS;
      this.#schedule(e, autopilot.dwellAfterFullS, () => {
        const token = e.authorization?.token;
        if (token) void this.swipe(e.id, token);
        else this.unplug(e.id);
      });
    }
  }

  #onIdle(e: Evse): void {
    const autopilot = this.#autopilot;
    if (!autopilot || !this.isRegistered || e.status !== 'Available') return;
    this.#schedule(e, autopilot.idleS, () => {
      if (e.status === 'Available' && !e.plugged && !e.authorization && !e.claimed)
        this.plugIn(e.id);
    });
  }

  async #driverSwipe(e: Evse, token: v201.IdToken): Promise<void> {
    const accepted = await this.swipe(e.id, token);
    const autopilot = this.#autopilot;
    if (!accepted && autopilot && e.plugged && !e.authorization && !e.claimed) {
      this.#schedule(e, autopilot.unplugDelayS, () => {
        this.unplug(e.id);
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reboot and firmware
  // -------------------------------------------------------------------------------------------

  async #reboot(cause: RebootCause201): Promise<void> {
    this.#rebooting = true;
    this.#pendingReset = false;
    if (this.#bootRetry) clearTimeout(this.#bootRetry);
    this.#bootRetry = undefined;
    for (const e of this.#evses) {
      if (e.tx && !e.tx.ended) {
        this.#endTransaction(
          e,
          'ResetCommand',
          cause === 'RemoteReset' ? 'ImmediateReset' : 'Reboot',
        );
      }
      this.#dropAuthorization(e);
    }
    this.emit('reboot', cause);
    this.#registration = undefined;
    this.#bootReason = cause;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    await this.#client.close(1000, cause === 'FirmwareUpdate' ? 'Firmware update' : 'Reset');
    await new Promise<void>((resolve) => {
      this.#later(this.#options.rebootDelayMs ?? 2_000, resolve);
    });
    this.deviceModel.reboot();
    this.#installWaiters = [];
    this.#rebooting = false;
    if (this.#stopped) return;
    this.#client = this.#createClient();
    await this.#client.connect().catch(() => undefined);
  }

  #prepareInstallation(): Promise<void> {
    return new Promise((resolve) => {
      this.#installWaiters.push(resolve);
      this.#onSessionEnded();
    });
  }

  #onSessionEnded(): void {
    if (this.#pendingReset && this.#evses.every((e) => !e.tx)) {
      this.#pendingReset = false;
      this.#later(0, () => void this.#reboot('RemoteReset'));
    }
    if (this.#installWaiters.length === 0) return;
    if (this.#evses.some((e) => e.tx !== undefined)) return;
    const waiters = this.#installWaiters;
    this.#installWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // -------------------------------------------------------------------------------------------
  // CSMS requests
  // -------------------------------------------------------------------------------------------

  #registerHandlers(client: ChargingStation): void {
    const on = <A extends CsmsAction>(
      action: A,
      handler: (payload: CsmsRequest<A>) => MaybePromise<CsmsResponse<A>>,
    ): void => {
      client.handle(action, handler);
    };
    const count = this.#evses.length;
    const model = this.deviceModel;
    const itemsPerMessage = (ref: (typeof V)[keyof typeof V]): number => model.integer(ref, 50);
    const checkItems = (items: number, ref: (typeof V)[keyof typeof V]): void => {
      const limit = itemsPerMessage(ref);
      if (limit > 0 && items > limit) {
        throw new RpcError('OccurrenceConstraintViolation', `At most ${limit} items per message`);
      }
    };

    // Provisioning
    on('GetVariables', (request) => {
      checkItems(request.getVariableData.length, V.itemsPerMessageGetVariables);
      return model.getVariables(request);
    });
    on('SetVariables', (request) => {
      checkItems(request.setVariableData.length, V.itemsPerMessageSetVariables);
      return model.setVariables(request);
    });
    const sendReport = (requestId: number, data: v201.ReportData[]): void => {
      const size = Math.max(1, itemsPerMessage(V.itemsPerMessageGetReport));
      const generatedAt = new Date().toISOString();
      for (let seqNo = 0; seqNo * size < data.length; seqNo++) {
        const part = data.slice(seqNo * size, (seqNo + 1) * size);
        void this.#call('NotifyReport', {
          requestId,
          generatedAt,
          seqNo,
          tbc: (seqNo + 1) * size < data.length,
          reportData: part,
        });
      }
    };
    on('GetBaseReport', ({ requestId, reportBase }) => {
      const data = model.baseReport(reportBase);
      if (data.length === 0) return { status: 'EmptyResultSet' };
      this.#later(0, () => {
        sendReport(requestId, data);
      });
      return { status: 'Accepted' };
    });
    on('GetReport', ({ requestId, componentVariable, componentCriteria }) => {
      const data = model.customReport(componentVariable, componentCriteria);
      if (data.length === 0) return { status: 'EmptyResultSet' };
      this.#later(0, () => {
        sendReport(requestId, data);
      });
      return { status: 'Accepted' };
    });
    on('Reset', ({ type, evseId }) => {
      if (evseId !== undefined) {
        return {
          status: 'Rejected',
          statusInfo: {
            reasonCode: 'UnsupportedRequest',
            additionalInfo: 'EVSE resets are not simulated',
          },
        };
      }
      if (this.#rebooting) return { status: 'Rejected' };
      const busy = this.#evses.some((e) => e.tx);
      if (type === 'OnIdle' && busy) {
        this.#pendingReset = true;
        return { status: 'Scheduled' };
      }
      this.#later(0, () => void this.#reboot('RemoteReset'));
      return { status: 'Accepted' };
    });
    on('SetNetworkProfile', ({ configurationSlot, connectionData }) => {
      if (
        connectionData.securityProfile <
        model.integer({ component: 'SecurityCtrlr', variable: 'SecurityProfile' }, 0)
      ) {
        return { status: 'Rejected', statusInfo: { reasonCode: 'SecurityDowngrade' } };
      }
      this.#networkProfiles.set(configurationSlot, connectionData);
      return { status: 'Accepted' };
    });

    // Authorization and local list
    on('ClearCache', () => {
      if (!model.boolean(V.authCacheEnabled, true)) return { status: 'Rejected' };
      this.authorizationCache.clear();
      return { status: 'Accepted' };
    });
    on('GetLocalListVersion', () => ({ versionNumber: this.localAuthList.version }));
    on('SendLocalList', (request) => ({ status: this.localAuthList.apply(request) }));

    // Transactions and remote control
    on('GetTransactionStatus', ({ transactionId }) => {
      const messagesInQueue = this.#client.hasQueuedEvents(transactionId);
      if (transactionId === undefined) return { messagesInQueue };
      return {
        ongoingIndicator: this.#evses.some((e) => e.tx?.id === transactionId && !e.tx.ended),
        messagesInQueue,
      };
    });
    on(
      'RequestStartTransaction',
      ({ evseId, idToken, remoteStartId, chargingProfile, groupIdToken }) => {
        if (this.#registration === 'Pending') return { status: 'Rejected' };
        if (
          chargingProfile &&
          (chargingProfile.chargingProfilePurpose !== 'TxProfile' ||
            chargingProfile.transactionId !== undefined)
        ) {
          return { status: 'Rejected', statusInfo: { reasonCode: 'InvalidProfile' } };
        }
        if (evseId !== undefined && (evseId < 1 || evseId > count)) return { status: 'Rejected' };
        const candidates = evseId === undefined ? this.#evses : [this.#evse(evseId)];
        const reservedForMe = (e: Evse): boolean => {
          const reservation = this.#reservationFor(e);
          return (
            reservation !== undefined &&
            sameIdTokenGroup(
              { token: idToken, group: groupIdToken },
              { token: reservation.idToken, group: reservation.groupIdToken },
            )
          );
        };
        const e =
          candidates.find(
            (c) => reservedForMe(c) && !c.authorization && !c.claimed && this.#canStart(c),
          ) ??
          candidates.find(
            (c) =>
              !c.authorization &&
              !c.claimed &&
              this.#canStart(c) &&
              (this.#reservationFor(c) === undefined || evseId !== undefined) &&
              (c.status === 'Available' || (c.status === 'Occupied' && c.plugged)),
          );
        if (!e) return { status: 'Rejected' };
        const reservation = this.#claimReservation(e, idToken, groupIdToken);
        if (reservation === false) return { status: 'Rejected' };
        const existing = e.tx && !e.tx.ended ? e.tx.id : undefined;
        e.claimed = true;
        this.#later(0, () => {
          void (async () => {
            let group = groupIdToken;
            if (model.boolean(V.authorizeRemoteStart, false)) {
              const decision = await this.#authorize(idToken);
              if (!decision.accepted) {
                e.claimed = false;
                return;
              }
              group = decision.idTokenInfo?.groupIdToken ?? group;
            }
            e.claimed = false;
            if (e.authorization || !this.#canStart(e)) return;
            this.#authorizeEvse(
              e,
              {
                token: idToken,
                group,
                remoteStartId,
                reservation,
                profile: chargingProfile,
                timer: undefined,
              },
              'RemoteStart',
            );
          })();
        });
        return {
          status: 'Accepted',
          ...(existing === undefined ? {} : { transactionId: existing }),
        };
      },
    );
    on('RequestStopTransaction', ({ transactionId }) => {
      const e = this.#evses.find((c) => c.tx?.id === transactionId && !c.tx.ended);
      if (!e) return { status: 'Rejected' };
      this.#later(0, () => {
        if (e.tx?.id === transactionId) this.#deauthorize(e, 'RemoteStop', 'Remote');
      });
      return { status: 'Accepted' };
    });
    on('UnlockConnector', ({ evseId, connectorId }) => {
      if (evseId < 1 || evseId > count || connectorId !== 1) return { status: 'UnknownConnector' };
      const e = this.#evse(evseId);
      if (e.tx && !e.tx.ended && e.authorization) return { status: 'OngoingAuthorizedTransaction' };
      if (e.tx && !e.tx.ended) {
        this.#later(0, () => {
          this.#endTransaction(e, 'UnlockCommand', 'Local');
        });
      }
      return { status: 'Unlocked' };
    });
    on('TriggerMessage', ({ requestedMessage, evse }) => {
      if (
        evse !== undefined &&
        (evse.id < 0 ||
          evse.id > count ||
          (evse.connectorId !== undefined && evse.connectorId !== 1))
      ) {
        return { status: 'Rejected' };
      }
      const targets = evse === undefined || evse.id === 0 ? this.#evses : [this.#evse(evse.id)];
      switch (requestedMessage) {
        case 'BootNotification':
          this.#bootReason = 'Triggered';
          this.#later(0, () => void this.#boot());
          return { status: 'Accepted' };
        case 'Heartbeat':
          this.#later(0, () => void this.#call('Heartbeat', {}));
          return { status: 'Accepted' };
        case 'StatusNotification':
          this.#later(0, () => {
            for (const e of targets) void this.#sendStatus(e, true);
          });
          return { status: 'Accepted' };
        case 'MeterValues':
          this.#later(0, () => {
            if (evse?.id === 0) {
              const meterValue = this.#reading(
                undefined,
                'Trigger',
                V.alignedDataMeasurands,
                undefined,
                true,
              );
              if (meterValue) void this.#call('MeterValues', { evseId: 0, meterValue });
              return;
            }
            for (const e of targets) {
              const meterValue = this.#reading(
                e,
                'Trigger',
                V.alignedDataMeasurands,
                undefined,
                true,
              );
              if (meterValue) void this.#call('MeterValues', { evseId: e.id, meterValue });
            }
          });
          return { status: 'Accepted' };
        case 'TransactionEvent': {
          const running = targets.filter((e) => e.tx && !e.tx.ended);
          if (running.length === 0) return { status: 'Rejected' };
          this.#later(0, () => {
            for (const e of running) {
              this.#transactionEvent(e, 'Updated', 'Trigger', {
                meterValue: this.#reading(e, 'Trigger', V.txUpdatedMeasurands, undefined, true),
              });
            }
          });
          return { status: 'Accepted' };
        }
        case 'FirmwareStatusNotification':
          this.#later(0, () => {
            void this.#call('FirmwareStatusNotification', this.#firmware.triggered);
          });
          return { status: 'Accepted' };
        case 'LogStatusNotification':
          this.#later(0, () => {
            void this.#call('LogStatusNotification', this.#logs.triggered);
          });
          return { status: 'Accepted' };
        default:
          return { status: 'NotImplemented' };
      }
    });

    // Availability
    on('ChangeAvailability', ({ operationalStatus, evse }) => {
      const operative = operationalStatus === 'Operative';
      if (
        evse !== undefined &&
        (evse.id < 1 ||
          evse.id > count ||
          (evse.connectorId !== undefined && evse.connectorId !== 1))
      ) {
        return { status: 'Rejected' };
      }
      if (evse === undefined) {
        if (operative) {
          this.#pendingStationInoperative = false;
          this.#stationOperative = true;
        } else if (this.#evses.some((e) => e.tx)) {
          this.#pendingStationInoperative = true;
          return { status: 'Scheduled' };
        } else {
          this.#stationOperative = false;
          for (const e of this.#evses) this.#removeReservationOf(e);
          for (const reservation of [...this.#reservations.values()])
            this.#endReservation(reservation, 'removed');
        }
        this.#later(0, () => {
          for (const e of this.#evses) this.#refreshStatus(e);
        });
        return { status: 'Accepted' };
      }
      const e = this.#evse(evse.id);
      if (operative) {
        e.pendingInoperative = false;
        e.operative = true;
      } else if (e.tx) {
        e.pendingInoperative = true;
        return { status: 'Scheduled' };
      } else {
        e.operative = false;
        this.#dropAuthorization(e);
        this.#removeReservationOf(e);
      }
      this.#later(0, () => {
        this.#refreshStatus(e);
      });
      return { status: 'Accepted' };
    });

    // Reservation
    on('ReserveNow', (request) => this.#reserveNow(request));
    on('CancelReservation', ({ reservationId }) => {
      const reservation = this.#reservations.get(reservationId);
      if (!reservation) return { status: 'Rejected' };
      this.#endReservation(reservation, 'cancelled');
      return { status: 'Accepted' };
    });

    // Smart charging
    const transactionOf = (evseId: number): TransactionContext201 | undefined => {
      const tx = evseId > 0 ? this.#evses[evseId - 1]?.tx : undefined;
      return tx && !tx.ended ? { transactionId: tx.id, startedAt: tx.startedAt } : undefined;
    };
    on('SetChargingProfile', ({ evseId, chargingProfile }) => {
      if (!model.boolean(V.smartChargingEnabled, true)) {
        return { status: 'Rejected', statusInfo: { reasonCode: 'NotEnabled' } };
      }
      return this.profiles.set(evseId, chargingProfile, transactionOf(evseId));
    });
    on('ClearChargingProfile', (request) => this.profiles.clear(request));
    on('GetChargingProfiles', (request) => {
      const groups = this.profiles.select(request);
      if (groups.length === 0) return { status: 'NoProfiles' };
      this.#later(0, () => {
        groups.forEach((group, index) => {
          const [first] = group;
          if (!first) return;
          void this.#call('ReportChargingProfiles', {
            requestId: request.requestId,
            chargingLimitSource: first.source,
            evseId: first.evseId,
            chargingProfile: group.map((entry) => entry.profile),
            tbc: index < groups.length - 1,
          });
        });
      });
      return { status: 'Accepted' };
    });
    on('GetCompositeSchedule', (request) => {
      const maxPowerW = this.#options.maxPowerW ?? 22_000;
      return this.profiles.compositeSchedule(request, {
        transaction: transactionOf(request.evseId),
        hardwareMaxW: request.evseId === 0 ? maxPowerW * count : maxPowerW,
        spec: this.#spec,
      });
    });

    // Firmware, diagnostics, data transfer
    on('UpdateFirmware', (request) => ({ status: this.#firmware.request(request) }));
    on('GetLog', (request) => this.#logs.request(request));
    on('DataTransfer', () => ({ status: 'UnknownVendorId' }));
  }
}
