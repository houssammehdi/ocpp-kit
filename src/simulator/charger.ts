import {
  ChargePoint,
  type ChargePointOptions,
  type QueuedTransaction,
} from '../client/charge-point.js';
import { MemoryQueueStore, type OfflineQueueStore } from '../client/offline-queue.js';
import {
  ciEquals,
  FEATURE_PROFILES,
  type CentralSystemAction,
  type CentralSystemRequest,
  type CentralSystemResponse,
  type ChargePointAction,
  type ChargePointErrorCode,
  type ChargePointRequest,
  type ChargePointResponse,
  type ChargingProfile,
  type DiagnosticsStatus,
  type FeatureProfile,
  type FirmwareStatus,
  type IdTagInfo,
  type MeterValue,
  type ReadingContext,
  type RegistrationStatus,
  type ReservationStatus,
  type ReserveNowRequest,
  type StopReason,
} from '../messages/index.js';
import { RpcError } from '../rpc/errors.js';
import type { CompletedCallEvent, MaybePromise } from '../rpc/peer.js';
import { TypedEventEmitter } from '../util/typed-emitter.js';
import { timerDelay } from '../util/timers.js';
import {
  AuthorizationCache,
  authorizeIdTag,
  LocalAuthorizationList,
  sameGroup,
  type AuthorizationDecision,
  type AuthorizationPolicy,
} from './authorization.js';
import {
  ConfigurationStore,
  defaultConfiguration,
  type ConfigKeyDefinition,
} from './configuration.js';
import { ConnectorStateMachine, type ConnectorStatus } from './connector-state.js';
import { acceptedPowerW, ElectricVehicle, randomEvProfile, type EvProfile } from './ev.js';
import {
  DiagnosticsUploader,
  FirmwareUpdater,
  type DiagnosticsSimulationOptions,
  type DiagnosticsUpload,
  type FirmwareSimulationOptions,
  type SimulationScheduler,
} from './firmware.js';
import {
  alignedMeterValues,
  isIntervalMeasurand,
  nextAlignedTime,
  previousAlignedTime,
  sampleValues,
  TransactionDataBuffer,
  type MeasurandItem,
  type MeterSnapshot,
} from './metering.js';
import { deriveSeed, Random } from './random.js';
import {
  matchesReservation,
  ReservationBook,
  reservationFrom,
  type Reservation,
} from './reservations.js';
import {
  ChargingProfileManager,
  maxMinFairShare,
  type ElectricalSpec,
  type TransactionContext,
} from './smart-charging.js';

/** Timing of the autopilot, which drives realistic sessions without manual intervention. */
export interface AutopilotOptions {
  /** Idle time of an available connector before the next EV arrives, in seconds. */
  readonly idleS?: readonly [number, number];
  /** Delay between a remote start and the driver plugging in, in seconds. */
  readonly plugInDelayS?: readonly [number, number];
  /** Delay between plugging in and presenting an RFID card, in seconds. */
  readonly swipeDelayS?: readonly [number, number];
  /** How long a full EV stays plugged in before the driver ends the session, in seconds. */
  readonly dwellAfterFullS?: readonly [number, number];
  /** Delay between the end of a transaction and unplugging, in seconds. */
  readonly unplugDelayS?: readonly [number, number];
  /** Hard cap on session length (the driver leaves), in seconds. */
  readonly maxSessionS?: number;
  /**
   * Delay between an accepted reservation and the arrival of its driver, in seconds. A driver
   * who would arrive after the expiry date does not show up.
   */
  readonly reservationArrivalS?: readonly [number, number];
}

const DEFAULT_AUTOPILOT: Required<AutopilotOptions> = {
  idleS: [30, 300],
  plugInDelayS: [2, 10],
  swipeDelayS: [1, 5],
  dwellAfterFullS: [0, 120],
  unplugDelayS: [3, 15],
  maxSessionS: 4 * 3_600,
  reservationArrivalS: [10, 120],
};

/** Options of {@link SimulatedCharger}. */
export interface SimulatedChargerOptions {
  /** Charge point identity. */
  readonly identity: string;
  /** Central System endpoint without the identity. */
  readonly url: string;
  /** Security Profile 1/2 password (HTTP Basic auth). */
  readonly password?: string;
  /** Number of connectors. Default: 2. */
  readonly connectors?: number;
  /** Hardware power limit per connector, in W. Default: 22 000 (3 x 32 A). */
  readonly maxPowerW?: number;
  /** Phase voltage. Default: 230 V. */
  readonly voltage?: number;
  /** Number of phases. Default: 3. */
  readonly phases?: number;
  readonly vendor?: string;
  readonly model?: string;
  /** Firmware version reported in BootNotification (a firmware update changes it). */
  readonly firmwareVersion?: string;
  /** Seed for every random decision (EVs, idle times, id tags). Default: 1. */
  readonly seed?: number;
  /** Enable the autopilot (`true` for defaults). Default: off. */
  readonly autopilot?: boolean | AutopilotOptions;
  /** Id tags presented by simulated drivers. */
  readonly idTags?: readonly string[];
  /** Physics step. Energy is integrated with this fixed step for determinism. Default: 1 000 ms. */
  readonly tickMs?: number;
  /** Initial HeartbeatInterval (overridden by BootNotification). Default: 300 s. */
  readonly heartbeatIntervalS?: number;
  /** Initial MeterValueSampleInterval. Default: 60 s. */
  readonly meterValueSampleIntervalS?: number;
  /** Time a reset takes before reconnecting. Default: 2 000 ms. */
  readonly rebootDelayMs?: number;
  /** Retry delay after a failed BootNotification when the CSMS gave no interval. Default: 30 s. */
  readonly bootRetryS?: number;
  /** Extra or overriding configuration keys. */
  readonly configuration?: readonly ConfigKeyDefinition[];
  /** Offline queue store shared across reboots. Default: in-memory. */
  readonly queueStore?: OfflineQueueStore;
  /** Options forwarded to the underlying {@link ChargePoint} client. */
  readonly client?: Partial<Omit<ChargePointOptions, 'identity' | 'url' | 'password'>>;
  /**
   * Feature profiles the charger supports (`SupportedFeatureProfiles`). Requests of other
   * profiles are answered with a `NotSupported` CALLERROR, except GetLocalListVersion (-1) and
   * SendLocalList (`NotSupported`), whose answers the specification defines. Default: all six.
   */
  readonly featureProfiles?: readonly FeatureProfile[];
  /** Capacity of the Authorization Cache. Default: 1 000. */
  readonly authorizationCacheSize?: number;
  /** Firmware update simulation (timing and failure injection). */
  readonly firmware?: FirmwareSimulationOptions;
  /** Diagnostics upload simulation (timing and failure injection). */
  readonly diagnostics?: DiagnosticsSimulationOptions;
  /** Maximum number of entries in StopTransaction.transactionData. Default: 1 000. */
  readonly maxTransactionDataEntries?: number;
}

/** Snapshot of one connector. */
export interface ConnectorSnapshot {
  readonly connectorId: number;
  readonly status: ConnectorStatus;
  readonly plugged: boolean;
  readonly transactionId: number | undefined;
  /** Id of the reservation holding this connector, if any. */
  readonly reservationId: number | undefined;
  /** Energy register (Wh). */
  readonly energyWh: number;
  readonly powerW: number;
  readonly offeredW: number;
  /** EV state of charge in percent, when an EV is connected. */
  readonly soc: number | undefined;
}

/** Aggregated counters of a charger. */
export interface ChargerStats {
  readonly connected: boolean;
  readonly registered: boolean;
  readonly activeTransactions: number;
  readonly sessionsStarted: number;
  readonly sessionsCompleted: number;
  readonly energyWh: number;
  readonly powerW: number;
  readonly callsSent: number;
  readonly callErrors: number;
}

/** What happened to a reservation. */
export type ReservationEventKind =
  'reserved' | 'replaced' | 'used' | 'cancelled' | 'expired' | 'terminated';

/** Why the charger restarts. */
export type RebootCause = 'Hard' | 'Soft' | 'Firmware';

/** Events emitted by {@link SimulatedCharger}. */
export interface SimulatedChargerEvents {
  registered: () => void;
  status: (connectorId: number, status: ConnectorStatus) => void;
  transactionStarted: (connectorId: number, transactionId: number) => void;
  transactionStopped: (
    connectorId: number,
    transactionId: number,
    reason: StopReason,
    energyWh: number,
  ) => void;
  reboot: (cause: RebootCause) => void;
  callCompleted: (event: CompletedCallEvent) => void;
  connection: (connected: boolean) => void;
  /** A reservation was made, replaced, used, cancelled, expired or terminated by a fault. */
  reservation: (kind: ReservationEventKind, reservation: Reservation) => void;
  /** The firmware update progressed (the FirmwareStatusNotification being sent). */
  firmwareStatus: (status: FirmwareStatus) => void;
  /** The diagnostics upload progressed (the DiagnosticsStatusNotification being sent). */
  diagnosticsStatus: (status: DiagnosticsStatus) => void;
  /** A diagnostics file was "uploaded"; its content is the charger's protocol log. */
  diagnosticsUploaded: (upload: DiagnosticsUpload) => void;
}

interface ActiveTransaction {
  readonly idTag: string;
  /** Group of the idTag that started the transaction, for stopping by another card. */
  parentIdTag: string | undefined;
  readonly startedAt: Date;
  readonly meterStartWh: number;
  /** Queued StartTransaction; MeterValues and StopTransaction go through it too. */
  readonly handle: QueuedTransaction;
  elapsedS: number;
  nextSampleS: number;
  /** Register at the previous periodic sample, for Energy.*.Interval. */
  lastSampleWh: number;
  stopping: boolean;
  pendingProfile: ChargingProfile | undefined;
  readonly data: TransactionDataBuffer;
  /** Energy (Wh since the start) still allowed after the Central System refused the idTag. */
  invalidEnergyLimitWh: number | undefined;
  /** Energy delivery stopped because the idTag was refused. */
  suspended: boolean;
}

/** An authorization waiting for the transaction to start (or, remote, still being checked). */
interface PendingAuthorization {
  readonly idTag: string;
  readonly parentIdTag: string | undefined;
  /** False while a remote start is still being authorized. */
  readonly authorized: boolean;
  readonly timer: NodeJS.Timeout | undefined;
  readonly profile: ChargingProfile | undefined;
  /** The reservation this start will use. */
  readonly reservation: Reservation | undefined;
}

interface Connector {
  readonly id: number;
  readonly fsm: ConnectorStateMachine;
  plugged: boolean;
  ev: ElectricVehicle | undefined;
  energyWh: number;
  powerW: number;
  offeredW: number;
  errorCode: ChargePointErrorCode;
  tx: ActiveTransaction | undefined;
  /** Authorized, waiting for the cable (ConnectionTimeOut), possibly with a remote TxProfile. */
  pendingAuth: PendingAuthorization | undefined;
  pendingUnavailable: boolean;
  /** Made Unavailable while a firmware installation waits for sessions to end. */
  firmwareBlocked: boolean;
  autoTimer: NodeJS.Timeout | undefined;
  fullSince: number | undefined;
  /** Register at the previous clock-aligned boundary. */
  alignedFromWh: number;
}

const ENERGY_REGISTER = 'Energy.Active.Import.Register';
const LOG_CAPACITY = 2_000;

/** Whether a connector has (or is about to have) a transaction. */
function isBusy(c: Connector): boolean {
  return c.tx !== undefined || c.pendingAuth !== undefined;
}

/**
 * A virtual OCPP 1.6 charge point supporting all six feature profiles.
 *
 * It boots, sends heartbeats, runs a connector state machine per connector, authorizes with an
 * Authorization Cache and a Local Authorization List, honours reservations, integrates energy
 * with a CC/CV charging curve, reports sampled and clock-aligned meter values, simulates firmware
 * updates and diagnostics uploads, and answers every Central System request of the profiles it
 * is configured with. With the autopilot on, simulated drivers arrive, charge and leave on their
 * own.
 */
export class SimulatedCharger extends TypedEventEmitter<SimulatedChargerEvents> {
  readonly identity: string;
  /** Configuration keys (GetConfiguration/ChangeConfiguration). */
  readonly configuration: ConfigurationStore;
  /** Installed charging profiles. */
  readonly profiles: ChargingProfileManager;
  /** The Local Authorization List, maintained by the Central System with SendLocalList. */
  readonly localAuthList: LocalAuthorizationList;
  /** The Authorization Cache, emptied by ClearCache. */
  readonly authorizationCache: AuthorizationCache;

  readonly #options: SimulatedChargerOptions;
  readonly #connectors: Connector[];
  readonly #random: Random;
  /** Separate stream for reconnect jitter so network timing cannot perturb the scenario. */
  readonly #jitter: Random;
  readonly #autopilot: Required<AutopilotOptions> | undefined;
  readonly #spec: ElectricalSpec;
  readonly #maxPowerW: number;
  readonly #tickS: number;
  readonly #queueStore: OfflineQueueStore;
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #supported: ReadonlySet<FeatureProfile>;
  readonly #reservations = new ReservationBook();
  readonly #firmware: FirmwareUpdater;
  readonly #diagnostics: DiagnosticsUploader;
  readonly #log: { readonly at: Date; readonly line: string }[] = [];
  #installWaiters: (() => void)[] = [];
  #firmwareVersion: string | undefined;
  #client: ChargePoint;
  /** Status of the latest BootNotification answer in the current boot cycle. */
  #registration: RegistrationStatus | undefined;
  #bootRetry: NodeJS.Timeout | undefined;
  #stopped = true;
  #rebooting = false;
  #stationAvailable = true;
  #heartbeat: NodeJS.Timeout | undefined;
  #tick: NodeJS.Timeout | undefined;
  #nextAligned: Date | undefined;
  #alignedFrom: Date | undefined;
  #alignedIntervalS = 0;
  #callsSent = 0;
  #callErrors = 0;
  #sessionsStarted = 0;
  #sessionsCompleted = 0;

  constructor(options: SimulatedChargerOptions) {
    super();
    this.identity = options.identity;
    this.#options = options;
    const count = options.connectors ?? 2;
    this.#random = new Random(deriveSeed(options.seed ?? 1, options.identity));
    this.#jitter = new Random(deriveSeed(options.seed ?? 1, `${options.identity}/jitter`));
    this.#autopilot =
      options.autopilot === undefined || options.autopilot === false
        ? undefined
        : { ...DEFAULT_AUTOPILOT, ...(options.autopilot === true ? {} : options.autopilot) };
    this.#spec = { voltage: options.voltage ?? 230, phases: options.phases ?? 3 };
    this.#maxPowerW = options.maxPowerW ?? 22_000;
    this.#tickS = (options.tickMs ?? 1_000) / 1_000;
    this.#queueStore = options.queueStore ?? new MemoryQueueStore();
    this.#supported = new Set(options.featureProfiles ?? FEATURE_PROFILES);
    if (!this.#supported.has('Core')) throw new RangeError('The Core profile is always supported');
    this.#firmwareVersion = options.firmwareVersion;
    this.configuration = new ConfigurationStore([
      ...defaultConfiguration({
        connectors: count,
        phases: this.#spec.phases,
        profiles: FEATURE_PROFILES.filter((profile) => this.#supported.has(profile)),
        ...(options.heartbeatIntervalS === undefined
          ? {}
          : { heartbeatIntervalS: options.heartbeatIntervalS }),
        ...(options.meterValueSampleIntervalS === undefined
          ? {}
          : { meterValueSampleIntervalS: options.meterValueSampleIntervalS }),
      }),
      ...(options.configuration ?? []),
    ]);
    this.configuration.onChange((key) => {
      if (key === 'HeartbeatInterval' && this.isRegistered) this.#startHeartbeat();
    });
    this.profiles = new ChargingProfileManager({
      connectors: count,
      maxStackLevel: this.configuration.getInteger('ChargeProfileMaxStackLevel', 8),
      maxProfiles: this.configuration.getInteger('MaxChargingProfilesInstalled', 16),
      maxPeriods: this.configuration.getInteger('ChargingScheduleMaxPeriods', 24),
    });
    this.localAuthList = new LocalAuthorizationList({
      maxLength: this.configuration.getInteger('LocalAuthListMaxLength', 1_000),
      maxUpdateLength: this.configuration.getInteger('SendLocalListMaxLength', 250),
    });
    this.authorizationCache = new AuthorizationCache({
      capacity: options.authorizationCacheSize ?? 1_000,
    });
    const scheduler: SimulationScheduler = { later: (ms, fn) => this.#later(ms, fn) };
    this.#firmware = new FirmwareUpdater(
      options.firmware ?? {},
      {
        notify: (status) => {
          this.emit('firmwareStatus', status);
          void this.#call('FirmwareStatusNotification', { status });
        },
        prepareInstallation: () => this.#prepareInstallation(),
        abortInstallation: () => {
          this.#releaseFirmwareBlock();
        },
        reboot: (version) => {
          this.#firmwareVersion = version;
          this.#later(0, () => void this.#reboot('Firmware'));
        },
      },
      scheduler,
    );
    this.#diagnostics = new DiagnosticsUploader(
      options.identity,
      options.diagnostics ?? {},
      {
        notify: (status) => {
          this.emit('diagnosticsStatus', status);
          void this.#call('DiagnosticsStatusNotification', { status });
        },
        collect: (startTime, stopTime) => this.#collectLog(startTime, stopTime),
        uploaded: (upload) => this.emit('diagnosticsUploaded', upload),
      },
      scheduler,
    );
    this.#connectors = Array.from({ length: count }, (_, index) =>
      this.#createConnector(index + 1),
    );
    this.#client = this.#createClient();
  }

  /** Whether the charger has an open connection. */
  get isConnected(): boolean {
    return this.#client.isConnected;
  }

  /** Whether the last BootNotification was accepted. */
  get isRegistered(): boolean {
    return this.#registration === 'Accepted';
  }

  /** Status of the latest BootNotification answer since the last (re)boot, if any. */
  get registrationStatus(): RegistrationStatus | undefined {
    return this.#registration;
  }

  /** Firmware version reported in BootNotification. */
  get firmwareVersion(): string | undefined {
    return this.#firmwareVersion;
  }

  /** Current reservations. */
  get reservations(): Reservation[] {
    return this.#reservations.all();
  }

  /** Snapshot of every connector. */
  get connectors(): ConnectorSnapshot[] {
    return this.#connectors.map((c) => ({
      connectorId: c.id,
      status: c.fsm.status,
      plugged: c.plugged,
      transactionId: c.tx?.handle.transactionId,
      reservationId: this.#reservations.forConnector(c.id)?.reservationId,
      energyWh: Math.round(c.energyWh),
      powerW: Math.round(c.powerW),
      offeredW: Math.round(c.offeredW),
      soc: c.ev ? Math.round(c.ev.soc * 1_000) / 10 : undefined,
    }));
  }

  /** Aggregated counters. */
  stats(): ChargerStats {
    return {
      connected: this.isConnected,
      registered: this.isRegistered,
      activeTransactions: this.#connectors.filter((c) => c.tx && !c.tx.stopping).length,
      sessionsStarted: this.#sessionsStarted,
      sessionsCompleted: this.#sessionsCompleted,
      energyWh: this.#connectors.reduce((sum, c) => sum + c.energyWh, 0),
      powerW: this.#connectors.reduce((sum, c) => sum + c.powerW, 0),
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

  /** Stop the simulation and disconnect (like a power cut: transactions are not stopped). */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#bootRetry) clearTimeout(this.#bootRetry);
    if (this.#tick) clearInterval(this.#tick);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#firmware.cancel();
    this.#diagnostics.cancel();
    for (const c of this.#connectors) {
      if (c.autoTimer) clearTimeout(c.autoTimer);
      if (c.pendingAuth?.timer) clearTimeout(c.pendingAuth.timer);
    }
    await this.#client.close(1000, 'Simulator stopped');
  }

  // -------------------------------------------------------------------------------------------
  // Manual control (also used by the autopilot)
  // -------------------------------------------------------------------------------------------

  /**
   * Plug an EV into a connector. A pending authorization starts the transaction right away; an
   * EV plugged back into a transaction kept after an EV-side disconnect resumes charging.
   */
  plugIn(connectorId: number, ev: EvProfile = randomEvProfile(this.#random)): void {
    const c = this.#connector(connectorId);
    if (c.plugged) throw new RangeError(`Connector ${connectorId} is already plugged in`);
    c.plugged = true;
    c.ev = new ElectricVehicle(ev);
    c.fullSince = undefined;
    if (c.tx && !c.tx.stopping) return;
    const pending = c.pendingAuth;
    if (pending?.authorized) {
      if (pending.timer) clearTimeout(pending.timer);
      c.pendingAuth = undefined;
      this.#startTransaction(c, pending);
      return;
    }
    // On a reserved connector the status stays Reserved until the reserved idTag shows up.
    c.fsm.tryApply('plugIn');
    if (this.#autopilot && c.fsm.status === 'Preparing') {
      this.#schedule(c, this.#autopilot.swipeDelayS, () => {
        void this.#driverSwipe(c, this.#randomIdTag());
      });
    }
  }

  /**
   * Unplug the EV. A running transaction stops with reason `EVDisconnected`, unless
   * `StopTransactionOnEVSideDisconnect` is false: then it continues (SuspendedEV) until the EV
   * is plugged in again or the transaction is stopped.
   */
  unplug(connectorId: number): void {
    const c = this.#connector(connectorId);
    if (!c.plugged) return;
    c.plugged = false;
    c.ev = undefined;
    c.powerW = 0;
    if (c.autoTimer) clearTimeout(c.autoTimer);
    const tx = c.tx;
    if (
      tx &&
      !tx.stopping &&
      !this.configuration.getBoolean('StopTransactionOnEVSideDisconnect', true)
    ) {
      c.fsm.tryApply('evDisconnected');
      return;
    }
    c.fsm.tryApply('unplug');
    if (tx && !tx.stopping) void this.#stopTransaction(c, 'EVDisconnected');
  }

  /**
   * Present an id tag at a connector. With a running transaction, the tag that started it (or,
   * after authorization, any tag of the same parentIdTag group) stops it. Otherwise the tag is
   * authorized (Local Authorization List, Authorization Cache, Authorize.req or the offline
   * rules) and a transaction starts, subject to reservations.
   *
   * @returns whether the tag was accepted
   */
  async swipe(connectorId: number, idTag: string): Promise<boolean> {
    const c = this.#connector(connectorId);
    if (c.tx) return this.#presentToStop(c, c.tx, idTag);
    if (!this.#canStart(c) || c.pendingAuth) return false;
    const decision = await this.#authorize(idTag);
    if (!decision.accepted) return false;
    // Re-check: another start may have claimed the connector while we awaited Authorize.
    if (isBusy(c) || !this.#canStart(c)) return false;
    const parentIdTag = decision.idTagInfo?.parentIdTag;
    const reservation = this.#claimReservation(c, idTag, parentIdTag);
    if (reservation === false) return false;
    const start: PendingAuthorization = {
      idTag,
      parentIdTag,
      authorized: true,
      timer: undefined,
      profile: undefined,
      reservation,
    };
    if (c.plugged) this.#startTransaction(c, start);
    else this.#awaitPlugIn(c, start);
    return true;
  }

  /** Stop the transaction on a connector locally. */
  async stopTransaction(connectorId: number, reason: StopReason = 'Local'): Promise<void> {
    await this.#stopTransaction(this.#connector(connectorId), reason);
  }

  /** Put a connector in the Faulted state, stopping any transaction and ending its reservation. */
  async fault(connectorId: number, errorCode: ChargePointErrorCode = 'OtherError'): Promise<void> {
    const c = this.#connector(connectorId);
    c.errorCode = errorCode;
    const stopping = c.tx ? this.#stopTransaction(c, 'Other') : Promise.resolve();
    this.#terminateReservationOf(c);
    c.fsm.tryApply('fault');
    await stopping;
  }

  /** Clear a fault. */
  clearFault(connectorId: number): void {
    const c = this.#connector(connectorId);
    c.errorCode = 'NoError';
    if (c.fsm.tryApply('faultCleared') && c.plugged) c.fsm.tryApply('plugIn');
  }

  // -------------------------------------------------------------------------------------------
  // Internals: plumbing
  // -------------------------------------------------------------------------------------------

  #supports(profile: FeatureProfile): boolean {
    return this.#supported.has(profile);
  }

  #connector(connectorId: number): Connector {
    const c = this.#connectors[connectorId - 1];
    if (!c) throw new RangeError(`Unknown connector ${connectorId}`);
    return c;
  }

  #createConnector(id: number): Connector {
    const connector: Connector = {
      id,
      fsm: new ConnectorStateMachine(),
      plugged: false,
      ev: undefined,
      energyWh: 0,
      powerW: 0,
      offeredW: 0,
      errorCode: 'NoError',
      tx: undefined,
      pendingAuth: undefined,
      pendingUnavailable: false,
      firmwareBlocked: false,
      autoTimer: undefined,
      fullSince: undefined,
      alignedFromWh: 0,
    };
    connector.fsm.onChange((status) => {
      this.emit('status', id, status);
      void this.#sendStatus(connector);
      this.#onStatusChanged(connector, status);
    });
    return connector;
  }

  #createClient(): ChargePoint {
    const client = new ChargePoint({
      transactionMessageAttempts: () =>
        this.configuration.getInteger('TransactionMessageAttempts', 3),
      transactionMessageRetryIntervalMs: () =>
        this.configuration.getInteger('TransactionMessageRetryInterval', 10) * 1_000,
      pingIntervalMs: this.configuration.getInteger('WebSocketPingInterval', 0) * 1_000,
      random: () => this.#jitter.next(),
      ...this.#options.client,
      identity: this.identity,
      url: this.#options.url,
      ...(this.#options.password === undefined ? {} : { password: this.#options.password }),
      offlineQueue: { store: this.#queueStore },
    });
    client.on('open', () => {
      this.emit('connection', true);
      if (this.isRegistered) this.#sendAllStatuses();
      else void this.#boot();
    });
    client.on('close', () => {
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
  async #call<A extends ChargePointAction>(
    action: A,
    payload: ChargePointRequest<A>,
  ): Promise<ChargePointResponse<A> | undefined> {
    try {
      return await this.#client.call(action, payload);
    } catch {
      return undefined;
    }
  }

  /** Run `fn` after `ms` unless the simulation stops first. Returns a cancel function. */
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

  #schedule(c: Connector, rangeS: readonly [number, number], fn: () => void): void {
    if (c.autoTimer) clearTimeout(c.autoTimer);
    const delayMs = Math.round(this.#random.float(rangeS[0], rangeS[1]) * 1_000);
    c.autoTimer = setTimeout(() => {
      c.autoTimer = undefined;
      if (!this.#stopped && !this.#rebooting) fn();
    }, timerDelay(delayMs));
  }

  #randomIdTag(): string {
    const tags = this.#options.idTags;
    if (tags && tags.length > 0) return this.#random.pick(tags);
    return `TAG${String(this.#random.int(0, 99_999)).padStart(5, '0')}`;
  }

  /** Keep a bounded protocol log, which GetDiagnostics "uploads". */
  #record(line: string): void {
    this.#log.push({ at: new Date(), line });
    if (this.#log.length > LOG_CAPACITY) this.#log.shift();
  }

  #collectLog(startTime: Date | undefined, stopTime: Date | undefined): string {
    return this.#log
      .filter(({ at }) => (!startTime || at >= startTime) && (!stopTime || at <= stopTime))
      .map(({ at, line }) => `${at.toISOString()} ${line}`)
      .join('\n');
  }

  // -------------------------------------------------------------------------------------------
  // Internals: registration and status
  // -------------------------------------------------------------------------------------------

  async #boot(): Promise<void> {
    if (this.#bootRetry) clearTimeout(this.#bootRetry);
    this.#bootRetry = undefined;
    const { vendor = 'ocpp-kit', model = 'Simulator' } = this.#options;
    const firmwareVersion = this.#firmwareVersion;
    const response = await this.#call('BootNotification', {
      chargePointVendor: vendor.slice(0, 20),
      chargePointModel: model.slice(0, 20),
      chargePointSerialNumber: this.identity.slice(0, 25),
      ...(firmwareVersion === undefined ? {} : { firmwareVersion: firmwareVersion.slice(0, 50) }),
    });
    if (this.#stopped || this.#rebooting) return;
    const fallbackS = this.#options.bootRetryS ?? 30;
    if (!response) {
      // Timeout or CALLERROR: try again later. (A lost connection boots again on reconnect.)
      this.#scheduleBootRetry(fallbackS);
      return;
    }
    this.#registration = response.status;
    if (response.status === 'Accepted') {
      if (response.interval > 0) {
        this.configuration.set('HeartbeatInterval', String(response.interval));
      }
      this.#startHeartbeat();
      this.#sendAllStatuses();
      this.emit('registered');
      this.#firmware.onBootAccepted();
      if (this.#autopilot) {
        for (const c of this.#connectors) this.#onStatusChanged(c, c.fsm.status);
      }
      return;
    }
    // OCPP 1.6 section 4.2: the interval is the minimum wait before the next BootNotification;
    // for 0 the charge point picks its own.
    const retryS = response.interval > 0 ? response.interval : fallbackS;
    if (response.status === 'Rejected') {
      // "While Rejected, the Charge Point SHALL NOT respond to any Central System initiated
      // message" and it "MAY for instance close its communication channel": stay offline until
      // the retry interval has passed, then connect and boot again.
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
    const intervalS = this.configuration.getInteger('HeartbeatInterval', 300);
    if (intervalS <= 0 || this.#stopped) return;
    this.#heartbeat = setInterval(
      () => {
        if (this.#client.isConnected) void this.#call('Heartbeat', {});
      },
      timerDelay(intervalS * 1_000),
    );
  }

  /** @param triggered - requested by TriggerMessage, which is allowed even while Pending */
  #sendAllStatuses(triggered = false): void {
    this.#sendStationStatus();
    for (const c of this.#connectors) void this.#sendStatus(c, triggered);
  }

  #sendStationStatus(errorCode: ChargePointErrorCode = 'NoError'): void {
    void this.#call('StatusNotification', {
      connectorId: 0,
      errorCode,
      status: this.#stationAvailable ? 'Available' : 'Unavailable',
      timestamp: new Date().toISOString(),
    });
  }

  /** @param triggered - requested by TriggerMessage, which is allowed even while Pending */
  async #sendStatus(c: Connector, triggered = false): Promise<void> {
    if (!this.#client.isConnected || (!triggered && !this.isRegistered)) return;
    await this.#call('StatusNotification', {
      connectorId: c.id,
      errorCode: c.errorCode,
      status: c.fsm.status,
      timestamp: new Date().toISOString(),
    });
  }

  #onStatusChanged(c: Connector, status: ConnectorStatus): void {
    if (status === 'Available' && this.#installWaiters.length > 0) {
      // A firmware installation is waiting: keep freed connectors out of service.
      this.#blockForFirmware(c);
      return;
    }
    const autopilot = this.#autopilot;
    if (!autopilot || !this.isRegistered) return;
    if (status === 'Available' && !c.plugged && !c.pendingAuth) {
      this.#schedule(c, autopilot.idleS, () => {
        if (c.fsm.status === 'Available' && !c.plugged && !c.pendingAuth) this.plugIn(c.id);
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: authorization
  // -------------------------------------------------------------------------------------------

  #authorizationPolicy(): AuthorizationPolicy {
    const config = this.configuration;
    return {
      localAuthListEnabled:
        this.#supports('LocalAuthListManagement') &&
        config.getBoolean('LocalAuthListEnabled', true),
      authorizationCacheEnabled: config.getBoolean('AuthorizationCacheEnabled', true),
      localPreAuthorize: config.getBoolean('LocalPreAuthorize', false),
      localAuthorizeOffline: config.getBoolean('LocalAuthorizeOffline', true),
      allowOfflineTxForUnknownId: config.getBoolean('AllowOfflineTxForUnknownId', false),
    };
  }

  async #authorize(idTag: string): Promise<AuthorizationDecision> {
    const decision = await authorizeIdTag(idTag, {
      // Without an accepted registration the charge point may not send Authorize (section 4.2).
      online: this.#client.isConnected && this.isRegistered,
      policy: this.#authorizationPolicy(),
      localList: this.localAuthList,
      cache: this.authorizationCache,
      askCentralSystem: async (tag) => {
        try {
          const { idTagInfo } = await this.#client.call('Authorize', { idTag: tag });
          return { kind: 'answered', idTagInfo };
        } catch (error) {
          // A CALLERROR (or an invalid answer) is a refusal; anything else means unreachable.
          return error instanceof RpcError ? { kind: 'error' } : { kind: 'unreachable' };
        }
      },
    });
    if (decision.localListConflict) this.#sendStationStatus('LocalListConflict');
    return decision;
  }

  /** Update the Authorization Cache with info the Central System sent for `idTag`. */
  #rememberIdTagInfo(idTag: string, idTagInfo: IdTagInfo): void {
    if (!this.configuration.getBoolean('AuthorizationCacheEnabled', true)) return;
    if (this.localAuthList.has(idTag)) return;
    this.authorizationCache.update(idTag, idTagInfo);
  }

  /** The parent of an idTag as far as it is known locally (list first, then cache). */
  #localParent(idTag: string): string | undefined {
    return (
      this.localAuthList.get(idTag)?.parentIdTag ?? this.authorizationCache.get(idTag)?.parentIdTag
    );
  }

  /**
   * Handle an idTag presented at a connector with a running transaction. The starting tag stops
   * it at once; for a different tag the charge point must first authorize it (section 4.1) and
   * then accepts it when it belongs to the same parentIdTag group.
   */
  async #presentToStop(c: Connector, tx: ActiveTransaction, idTag: string): Promise<boolean> {
    if (tx.stopping) return false;
    if (!ciEquals(tx.idTag, idTag)) {
      const decision = await this.#authorize(idTag);
      // Stopping clears c.tx synchronously, so this also catches a stop that began meanwhile.
      if (!decision.accepted || c.tx !== tx) return false;
      const presented = { idTag, parentIdTag: decision.idTagInfo?.parentIdTag };
      if (!sameGroup(presented, { idTag: tx.idTag, parentIdTag: tx.parentIdTag })) return false;
    }
    await this.#stopTransaction(c, 'Local', idTag);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Internals: reservations
  // -------------------------------------------------------------------------------------------

  /** Whether a connector could take a new session (or reservation) right now. */
  #isFree(c: Connector, ignoring?: Reservation): boolean {
    const own = this.#reservations.forConnector(c.id);
    if (own && own.reservationId !== ignoring?.reservationId) return false;
    const status = c.fsm.status;
    return (status === 'Available' || (own !== undefined && status === 'Reserved')) && !isBusy(c);
  }

  /**
   * The reservation a new session on `c` uses, `undefined` when it needs none, or `false` when
   * the connector is held for someone else: a reserved connector only takes its reservation's
   * idTag group, and every station-wide (connector 0) reservation needs a free connector.
   */
  #claimReservation(
    c: Connector,
    idTag: string,
    parentIdTag: string | undefined,
  ): Reservation | undefined | false {
    const own = this.#reservations.forConnector(c.id);
    if (own) return matchesReservation(own, idTag, parentIdTag) ? own : false;
    const stationWide = this.#reservations.stationWide();
    const mine = stationWide.find((r) => matchesReservation(r, idTag, parentIdTag));
    if (mine) return mine;
    if (stationWide.length === 0) return undefined;
    const freeOthers = this.#connectors.filter((other) => other !== c && this.#isFree(other));
    return freeOthers.length >= stationWide.length ? undefined : false;
  }

  /** OCPP 1.6 section 5.13 Reserve Now. */
  #reserveNow(request: ReserveNowRequest): ReservationStatus {
    if (request.connectorId > this.#connectors.length) return 'Rejected';
    if (new Date(request.expiryDate) <= new Date()) return 'Rejected';
    const existing = this.#reservations.get(request.reservationId);
    const status = this.#reservationStatus(request, existing);
    if (status !== 'Accepted') return status;
    const reservation = reservationFrom(request);
    if (existing) {
      this.#reservations.remove(existing.reservationId);
      if (existing.connectorId !== reservation.connectorId && existing.connectorId > 0) {
        this.#connector(existing.connectorId).fsm.tryApply('reservationEnded');
      }
      this.emit('reservation', 'replaced', existing);
    }
    this.#reservations.add(reservation);
    if (reservation.connectorId > 0)
      this.#connector(reservation.connectorId).fsm.tryApply('reserve');
    this.emit('reservation', 'reserved', reservation);
    this.#scheduleReservedDriver(reservation);
    return 'Accepted';
  }

  #reservationStatus(
    request: ReserveNowRequest,
    existing: Reservation | undefined,
  ): ReservationStatus {
    if (request.connectorId === 0) {
      if (!this.configuration.getBoolean('ReserveConnectorZeroSupported', false)) return 'Rejected';
      if (!this.#stationAvailable) return 'Unavailable';
      const statuses = this.#connectors.map((c) => c.fsm.status);
      if (statuses.every((status) => status === 'Faulted')) return 'Faulted';
      if (statuses.every((status) => status === 'Faulted' || status === 'Unavailable')) {
        return 'Unavailable';
      }
      // "Occupied ... when the Charge Point or connector has been reserved for the same or
      // another idTag."
      const others = this.#reservations
        .stationWide()
        .filter((r) => r.reservationId !== existing?.reservationId);
      if (others.length > 0) return 'Occupied';
      return this.#connectors.some((c) => this.#isFree(c, existing)) ? 'Accepted' : 'Occupied';
    }
    const c = this.#connector(request.connectorId);
    const status = c.fsm.status;
    if (status === 'Faulted') return 'Faulted';
    if (status === 'Unavailable' || !this.#stationAvailable) return 'Unavailable';
    if (!this.#isFree(c, existing)) return 'Occupied';
    // A station-wide reservation must still find a free connector.
    const stationWide = this.#reservations
      .stationWide()
      .filter((r) => r.reservationId !== existing?.reservationId).length;
    if (stationWide > 0) {
      const freeOthers = this.#connectors.filter(
        (o) => o !== c && this.#isFree(o, existing),
      ).length;
      if (freeOthers < stationWide) return 'Occupied';
    }
    return 'Accepted';
  }

  /** A reservation ended without being used: free its connector. */
  #releaseReservation(reservation: Reservation, kind: 'cancelled' | 'expired'): void {
    this.emit('reservation', kind, reservation);
    if (reservation.connectorId === 0) return;
    const c = this.#connector(reservation.connectorId);
    if (c.fsm.tryApply('reservationEnded') && c.plugged) c.fsm.tryApply('plugIn');
  }

  /** A connector went Faulted or Unavailable: its reservation ends (section 5.13). */
  #terminateReservationOf(c: Connector): void {
    const reservation = this.#reservations.forConnector(c.id);
    if (!reservation) return;
    this.#reservations.remove(reservation.reservationId);
    this.emit('reservation', 'terminated', reservation);
  }

  #expireReservations(now: Date): void {
    for (const reservation of this.#reservations.takeExpired(now)) {
      this.#releaseReservation(reservation, 'expired');
    }
  }

  /** Autopilot: the driver who reserved shows up, plugs in and presents the reserved idTag. */
  #scheduleReservedDriver(reservation: Reservation): void {
    const autopilot = this.#autopilot;
    if (!autopilot) return;
    const delayMs = Math.round(this.#random.float(...autopilot.reservationArrivalS) * 1_000);
    if (Date.now() + delayMs >= reservation.expiryDate.getTime()) return; // a no-show
    this.#later(delayMs, () => {
      if (this.#reservations.get(reservation.reservationId) !== reservation) return;
      const c =
        reservation.connectorId > 0
          ? this.#connector(reservation.connectorId)
          : this.#connectors.find((candidate) => this.#isFree(candidate));
      if (!c || c.plugged || isBusy(c)) return;
      this.plugIn(c.id);
      this.#schedule(c, autopilot.swipeDelayS, () => {
        void this.#driverSwipe(c, reservation.idTag);
      });
    });
  }

  /** Autopilot swipe: a driver whose card is refused unplugs and leaves. */
  async #driverSwipe(c: Connector, idTag: string): Promise<void> {
    const accepted = await this.swipe(c.id, idTag);
    const autopilot = this.#autopilot;
    if (!accepted && autopilot && c.plugged && !c.tx) {
      this.#schedule(c, autopilot.unplugDelayS, () => {
        this.unplug(c.id);
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: transactions
  // -------------------------------------------------------------------------------------------

  /** Whether a new session may start on `c`. */
  #canStart(c: Connector): boolean {
    const status = c.fsm.status;
    return (
      (status === 'Available' || status === 'Preparing' || status === 'Reserved') &&
      !this.#rebooting &&
      !this.#firmware.blocksSessions
    );
  }

  /** Authorized but not plugged in yet: wait up to ConnectionTimeOut for the cable. */
  #awaitPlugIn(c: Connector, start: PendingAuthorization): void {
    const timeoutS = this.configuration.getInteger('ConnectionTimeOut', 60);
    const pending: PendingAuthorization = {
      ...start,
      authorized: true,
      timer: setTimeout(
        () => {
          if (c.pendingAuth !== pending) return;
          c.pendingAuth = undefined;
          c.fsm.tryApply('timeout');
          // An unused reservation still holds the connector.
          if (this.#reservations.forConnector(c.id)) c.fsm.tryApply('reserve');
        },
        timerDelay(timeoutS * 1_000),
      ),
    };
    c.pendingAuth = pending;
    c.fsm.tryApply('authorize');
    if (this.#autopilot) {
      this.#schedule(c, this.#autopilot.plugInDelayS, () => {
        if (!c.plugged && c.pendingAuth) this.plugIn(c.id);
      });
    }
  }

  #transactionContext(c: Connector): TransactionContext | undefined {
    const transactionId = c.tx?.handle.transactionId;
    return transactionId === undefined || !c.tx
      ? undefined
      : { transactionId, startedAt: c.tx.startedAt };
  }

  /** Measurands for the Transaction.Begin and Transaction.End readings of transactionData. */
  #boundaryItems(): MeasurandItem[] {
    const seen = new Set<string>();
    const items: MeasurandItem[] = [];
    for (const item of [
      ...this.configuration.getMeasurands('StopTxnSampledData'),
      ...this.configuration.getMeasurands('StopTxnAlignedData'),
    ]) {
      const key = `${item.measurand}/${item.phase ?? ''}`;
      if (isIntervalMeasurand(item.measurand) || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
    return items;
  }

  #boundaryReading(c: Connector, context: ReadingContext, at: Date): MeterValue | undefined {
    const items = this.#boundaryItems();
    if (items.length === 0) return undefined;
    const sampledValue = sampleValues(items, this.#snapshot(c), context);
    return sampledValue.length === 0 ? undefined : { timestamp: at.toISOString(), sampledValue };
  }

  #startTransaction(c: Connector, start: PendingAuthorization): void {
    const startedAt = new Date();
    const meterStartWh = Math.round(c.energyWh);
    const claimed = start.reservation;
    // The reservation may have expired or been cancelled while we waited for the cable.
    const reservation =
      claimed && this.#reservations.get(claimed.reservationId) === claimed ? claimed : undefined;
    const handle = this.#client.startTransaction({
      connectorId: c.id,
      idTag: start.idTag,
      meterStart: meterStartWh,
      timestamp: startedAt.toISOString(),
      ...(reservation ? { reservationId: reservation.reservationId } : {}),
    });
    if (reservation) {
      this.#reservations.remove(reservation.reservationId);
      this.emit('reservation', 'used', reservation);
    }
    const tx: ActiveTransaction = {
      idTag: start.idTag,
      parentIdTag: start.parentIdTag,
      startedAt,
      meterStartWh,
      handle,
      elapsedS: 0,
      nextSampleS: this.configuration.getInteger('MeterValueSampleInterval', 60),
      lastSampleWh: c.energyWh,
      stopping: false,
      pendingProfile: start.profile,
      data: new TransactionDataBuffer(this.#options.maxTransactionDataEntries ?? 1_000),
      invalidEnergyLimitWh: undefined,
      suspended: false,
    };
    const begin = this.#boundaryReading(c, 'Transaction.Begin', startedAt);
    if (begin) tx.data.begin(begin);
    c.tx = tx;
    this.#sessionsStarted++;
    handle.started.then(
      (response) => {
        this.emit('transactionStarted', c.id, response.transactionId);
        this.#rememberIdTagInfo(tx.idTag, response.idTagInfo);
        tx.parentIdTag = response.idTagInfo.parentIdTag ?? tx.parentIdTag;
        if (tx.pendingProfile && c.tx === tx) {
          this.profiles.set(c.id, tx.pendingProfile, {
            transactionId: response.transactionId,
            startedAt,
          });
        }
        if (response.idTagInfo.status !== 'Accepted' && c.tx === tx && !tx.stopping) {
          this.#onIdTagRefused(c, tx);
        }
      },
      () => undefined,
    );
    c.fsm.tryApply('authorize'); // Reserved -> Preparing; a no-op when already Preparing
    c.fsm.tryApply('energyFlowing');
  }

  /**
   * StartTransaction.conf did not accept the idTag (e.g. it was authorized offline). With
   * StopTransactionOnInvalidId the transaction stops (DeAuthorized); otherwise the charge point
   * "SHALL only stop energy delivery", after at most MaxEnergyOnInvalidId Wh.
   */
  #onIdTagRefused(c: Connector, tx: ActiveTransaction): void {
    if (this.configuration.getBoolean('StopTransactionOnInvalidId', true)) {
      void this.#stopTransaction(c, 'DeAuthorized');
      return;
    }
    tx.invalidEnergyLimitWh = Math.max(0, this.configuration.getInteger('MaxEnergyOnInvalidId', 0));
  }

  async #stopTransaction(c: Connector, reason: StopReason, idTag?: string): Promise<void> {
    const tx = c.tx;
    if (!tx || tx.stopping) return;
    tx.stopping = true;
    c.powerW = 0;
    const stoppedAt = new Date();
    const meterStopWh = Math.round(c.energyWh);
    const end = this.#boundaryReading(c, 'Transaction.End', stoppedAt);
    const transactionData = tx.data.toArray(end);
    c.fsm.tryApply('transactionStopped');
    if (!c.plugged) c.fsm.tryApply('unplug'); // cable gone already (EV-side disconnect)
    this.profiles.transactionEnded(c.id);
    const stopIdTag = idTag ?? tx.idTag;
    // Queued at once: offline, the connector is free again although delivery comes later.
    const stopped = tx.handle.stop({
      idTag: stopIdTag,
      meterStop: meterStopWh,
      timestamp: stoppedAt.toISOString(),
      reason,
      ...(transactionData.length > 0 ? { transactionData } : {}),
    });
    if (c.tx === tx) c.tx = undefined;
    if (c.pendingUnavailable) {
      c.pendingUnavailable = false;
      c.fsm.tryApply('makeUnavailable');
    }
    this.#onSessionEnded();
    if (this.#autopilot && c.plugged) {
      this.#schedule(c, this.#autopilot.unplugDelayS, () => {
        this.unplug(c.id);
      });
    }
    const response = await stopped.catch(() => undefined);
    this.#sessionsCompleted++;
    if (response?.idTagInfo) this.#rememberIdTagInfo(stopIdTag, response.idTagInfo);
    const transactionId = tx.handle.transactionId;
    if (response && transactionId !== undefined) {
      this.emit('transactionStopped', c.id, transactionId, reason, meterStopWh - tx.meterStartWh);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: metering
  // -------------------------------------------------------------------------------------------

  #snapshot(c: Connector): MeterSnapshot {
    return {
      energyWh: c.energyWh,
      powerW: c.powerW,
      offeredW: c.offeredW,
      voltage: this.#spec.voltage,
      phases: this.#spec.phases,
      soc: c.ev?.soc,
      temperatureC: 25 + (15 * c.powerW) / this.#maxPowerW,
      frequencyHz: 50,
    };
  }

  /** The main meter (connector 0): all connectors together. */
  #stationSnapshot(): MeterSnapshot {
    const sum = (pick: (c: Connector) => number): number =>
      this.#connectors.reduce((total, c) => total + pick(c), 0);
    const powerW = sum((c) => c.powerW);
    return {
      energyWh: sum((c) => c.energyWh),
      powerW,
      offeredW: sum((c) => c.offeredW),
      voltage: this.#spec.voltage,
      phases: this.#spec.phases,
      temperatureC: 25 + (15 * powerW) / (this.#maxPowerW * this.#connectors.length),
      frequencyHz: 50,
    };
  }

  /**
   * The readings a TriggerMessage asks for: "the most recent measurements for all measurands
   * configured in configuration key MeterValuesSampledData" (the energy register when that list
   * yields nothing).
   */
  #triggeredReading(snapshot: MeterSnapshot, context: ReadingContext): MeterValue {
    const items = this.configuration.getMeasurands('MeterValuesSampledData');
    const sampled = sampleValues(items, snapshot, context);
    return {
      timestamp: new Date().toISOString(),
      sampledValue:
        sampled.length > 0
          ? sampled
          : sampleValues([{ measurand: ENERGY_REGISTER }], snapshot, context),
    };
  }

  #sendMeterValues(c: Connector, context: ReadingContext): void {
    const meterValue = this.#triggeredReading(this.#snapshot(c), context);
    const tx = c.tx && !c.tx.stopping ? c.tx : undefined;
    if (tx) void tx.handle.meterValues([meterValue]).catch(() => undefined);
    else void this.#call('MeterValues', { connectorId: c.id, meterValue: [meterValue] });
  }

  /** MeterValues for connector 0: the charge point's main meter. */
  #sendStationMeterValues(context: ReadingContext): void {
    void this.#call('MeterValues', {
      connectorId: 0,
      meterValue: [this.#triggeredReading(this.#stationSnapshot(), context)],
    });
  }

  /** Every MeterValueSampleInterval of a transaction: MeterValues plus transactionData. */
  #samplePeriodic(c: Connector, tx: ActiveTransaction, now: Date): void {
    const snapshot = this.#snapshot(c);
    const intervalWh = c.energyWh - tx.lastSampleWh;
    tx.lastSampleWh = c.energyWh;
    const timestamp = now.toISOString();
    const sampled = sampleValues(
      this.configuration.getMeasurands('MeterValuesSampledData'),
      snapshot,
      'Sample.Periodic',
      intervalWh,
    );
    if (sampled.length > 0) {
      void tx.handle.meterValues([{ timestamp, sampledValue: sampled }]).catch(() => undefined);
    }
    const forStop = sampleValues(
      this.configuration.getMeasurands('StopTxnSampledData'),
      snapshot,
      'Sample.Periodic',
      intervalWh,
    );
    if (forStop.length > 0) tx.data.add({ timestamp, sampledValue: forStop });
  }

  /**
   * Every ClockAlignedDataInterval boundary (aligned to midnight UTC): MeterValues for every
   * connector with MeterValuesAlignedData, plus StopTxnAlignedData in the transactionData of
   * running transactions. Readings are taken at the first physics tick at or after a boundary.
   */
  #sampleClockAligned(now: Date): void {
    const intervalS = this.configuration.getInteger('ClockAlignedDataInterval', 0);
    if (intervalS <= 0) {
      this.#nextAligned = undefined;
      return;
    }
    if (this.#nextAligned === undefined || intervalS !== this.#alignedIntervalS) {
      this.#alignedIntervalS = intervalS;
      this.#alignedFrom = previousAlignedTime(now, intervalS);
      this.#nextAligned = nextAlignedTime(now, intervalS);
      for (const c of this.#connectors) c.alignedFromWh = c.energyWh;
      return;
    }
    if (now < this.#nextAligned) return;
    const boundary = this.#nextAligned;
    const intervalStart = this.#alignedFrom ?? boundary;
    const items = this.configuration.getMeasurands('MeterValuesAlignedData');
    const forStop = this.configuration.getMeasurands('StopTxnAlignedData');
    for (const c of this.#connectors) {
      const snapshot = this.#snapshot(c);
      const intervalWh = c.energyWh - c.alignedFromWh;
      c.alignedFromWh = c.energyWh;
      const meterValue = alignedMeterValues(items, snapshot, boundary, intervalStart, intervalWh);
      const tx = c.tx && !c.tx.stopping ? c.tx : undefined;
      if (meterValue.length > 0) {
        if (tx) void tx.handle.meterValues(meterValue).catch(() => undefined);
        else void this.#call('MeterValues', { connectorId: c.id, meterValue });
      }
      if (tx) {
        for (const entry of alignedMeterValues(
          forStop,
          snapshot,
          boundary,
          intervalStart,
          intervalWh,
        )) {
          tx.data.add(entry);
        }
      }
    }
    this.#alignedFrom = boundary;
    this.#nextAligned = nextAlignedTime(now, intervalS);
  }

  // -------------------------------------------------------------------------------------------
  // Internals: physics
  // -------------------------------------------------------------------------------------------

  /**
   * Power offered to each active connector: the hardware limit, capped by Tx(Default)Profiles,
   * with any ChargePointMaxProfile shared out by water-filling so that capacity one connector
   * cannot use (profile limit or EV acceptance) goes to the others.
   */
  #offeredPower(active: readonly Connector[], now: Date): Map<Connector, number> {
    const caps = active.map((c) => {
      const limit = this.profiles.connectorLimitW(
        c.id,
        now,
        this.#transactionContext(c),
        this.#spec,
      );
      return { c, cap: Math.max(0, Math.min(this.#maxPowerW, limit ?? Infinity)) };
    });
    const result = new Map<Connector, number>(caps.map(({ c, cap }) => [c, cap]));
    const station = this.profiles.stationLimitW(now, this.#spec);
    if (station === undefined) return result;
    const shares = maxMinFairShare(
      caps.map(({ c, cap }) => ({
        cap,
        demand: c.ev ? acceptedPowerW(c.ev.profile, c.ev.soc) : 0,
      })),
      station,
    );
    caps.forEach(({ c }, index) => result.set(c, shares[index] ?? 0));
    return result;
  }

  #onTick(): void {
    if (this.#rebooting) return;
    const now = new Date();
    this.#expireReservations(now);
    const active = this.#connectors.filter(
      (c) => c.tx && !c.tx.stopping && !c.tx.suspended && c.plugged && c.ev,
    );
    const offered = this.#offeredPower(active, now);
    const interval = this.configuration.getInteger('MeterValueSampleInterval', 60);
    for (const c of this.#connectors) {
      const tx = c.tx;
      if (!tx || tx.stopping) {
        c.powerW = 0;
        c.offeredW = 0;
        continue;
      }
      const ev = c.ev;
      const available = offered.get(c);
      if (ev && available !== undefined) {
        c.offeredW = available;
        c.powerW = ev.charge(available, this.#tickS);
        c.energyWh += (c.powerW * this.#tickS) / 3_600;
      } else {
        c.offeredW = 0;
        c.powerW = 0;
      }
      if (!c.plugged) c.fsm.tryApply('evDisconnected');
      else if (c.offeredW <= 0) c.fsm.tryApply('suspendByEVSE');
      else if (c.powerW <= 0) c.fsm.tryApply('suspendByEV');
      else c.fsm.tryApply('energyFlowing');
      if (
        tx.invalidEnergyLimitWh !== undefined &&
        c.energyWh - tx.meterStartWh >= tx.invalidEnergyLimitWh
      ) {
        tx.suspended = true;
      }
      tx.elapsedS += this.#tickS;
      if (interval > 0 && tx.elapsedS >= tx.nextSampleS) {
        tx.nextSampleS += interval;
        this.#samplePeriodic(c, tx, now);
      }
      if (ev) this.#autopilotStep(c, tx, ev);
    }
    this.#sampleClockAligned(now);
  }

  #autopilotStep(c: Connector, tx: ActiveTransaction, ev: ElectricVehicle): void {
    const autopilot = this.#autopilot;
    if (!autopilot) return;
    if (tx.elapsedS >= autopilot.maxSessionS) {
      void this.#stopTransaction(c, 'Local');
      return;
    }
    if (ev.isFull && c.fullSince === undefined) {
      c.fullSince = tx.elapsedS;
      this.#schedule(c, autopilot.dwellAfterFullS, () => {
        void this.#stopTransaction(c, 'Local');
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: reboot and firmware
  // -------------------------------------------------------------------------------------------

  async #reboot(cause: RebootCause): Promise<void> {
    this.#rebooting = true;
    if (this.#bootRetry) clearTimeout(this.#bootRetry);
    this.#bootRetry = undefined;
    const reason: StopReason =
      cause === 'Hard' ? 'HardReset' : cause === 'Soft' ? 'SoftReset' : 'Reboot';
    await Promise.all(this.#connectors.map((c) => this.#stopTransaction(c, reason)));
    this.emit('reboot', cause);
    this.#registration = undefined;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    await this.#client.close(1000, cause === 'Firmware' ? 'Firmware update' : `${cause} reset`);
    await new Promise<void>((resolve) => {
      this.#later(this.#options.rebootDelayMs ?? 2_000, resolve);
    });
    if (cause === 'Firmware') this.#releaseFirmwareBlock();
    this.#rebooting = false;
    if (this.#stopped) return;
    this.#client = this.#createClient();
    await this.#client.connect().catch(() => undefined);
  }

  /**
   * Firmware downloaded: resolve once no transaction runs. Meanwhile connectors that are not in
   * use are made Unavailable, as section 5.19 recommends.
   */
  #prepareInstallation(): Promise<void> {
    return new Promise((resolve) => {
      this.#installWaiters.push(resolve);
      for (const c of this.#connectors) this.#blockForFirmware(c);
      this.#onSessionEnded();
    });
  }

  #blockForFirmware(c: Connector): void {
    if (c.fsm.status === 'Available' && !isBusy(c) && c.fsm.tryApply('makeUnavailable')) {
      c.firmwareBlocked = true;
    }
  }

  #releaseFirmwareBlock(): void {
    this.#installWaiters = [];
    for (const c of this.#connectors) {
      if (!c.firmwareBlocked) continue;
      c.firmwareBlocked = false;
      if (c.fsm.tryApply('makeAvailable') && c.plugged) c.fsm.tryApply('plugIn');
    }
  }

  /** A session ended: let a waiting firmware installation proceed when none is left. */
  #onSessionEnded(): void {
    if (this.#installWaiters.length === 0) return;
    if (this.#connectors.some((c) => c.tx !== undefined)) return;
    const waiters = this.#installWaiters;
    this.#installWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // -------------------------------------------------------------------------------------------
  // Internals: Central System requests
  // -------------------------------------------------------------------------------------------

  #registerHandlers(client: ChargePoint): void {
    const on = <A extends CentralSystemAction>(
      action: A,
      handler: (payload: CentralSystemRequest<A>) => MaybePromise<CentralSystemResponse<A>>,
    ): void => {
      client.handle(action, handler);
    };
    const count = this.#connectors.length;

    on('RemoteStartTransaction', ({ connectorId, idTag, chargingProfile }) => {
      // OCPP 1.6 section 4.2: RemoteStart/StopTransaction are not allowed while Pending.
      if (this.#registration === 'Pending') return { status: 'Rejected' };
      const profile = this.#supports('SmartCharging') ? chargingProfile : undefined;
      if (profile && profile.chargingProfilePurpose !== 'TxProfile') return { status: 'Rejected' };
      if (this.#rebooting || this.#firmware.blocksSessions) return { status: 'Rejected' };
      const parentIdTag = this.#localParent(idTag);
      const candidates =
        connectorId === undefined
          ? this.#connectors
          : this.#connectors.filter((c) => c.id === connectorId);
      // Prefer a connector reserved for this idTag, then any free, unreserved one.
      const reservedForMe = candidates.find((c) => {
        const reservation = this.#reservations.forConnector(c.id);
        return (
          reservation !== undefined &&
          matchesReservation(reservation, idTag, parentIdTag) &&
          !isBusy(c) &&
          c.fsm.status === 'Reserved'
        );
      });
      const c =
        reservedForMe ??
        candidates.find(
          (candidate) =>
            !isBusy(candidate) &&
            (candidate.fsm.status === 'Available' || candidate.fsm.status === 'Preparing') &&
            !this.#reservations.forConnector(candidate.id),
        );
      if (!c) return { status: 'Rejected' };
      const reservation = this.#claimReservation(c, idTag, parentIdTag);
      if (reservation === false) return { status: 'Rejected' };
      // Hold the connector synchronously so concurrent requests cannot both succeed; the
      // transaction itself starts after the response has been sent.
      const hold: PendingAuthorization = {
        idTag,
        parentIdTag,
        authorized: false,
        timer: undefined,
        profile,
        reservation,
      };
      c.pendingAuth = hold;
      this.#later(0, () => {
        void (async () => {
          let parent = parentIdTag;
          if (this.configuration.getBoolean('AuthorizeRemoteTxRequests', false)) {
            const decision = await this.#authorize(idTag);
            if (c.pendingAuth !== hold) return;
            if (!decision.accepted) {
              c.pendingAuth = undefined;
              return;
            }
            parent = decision.idTagInfo?.parentIdTag ?? parent;
          }
          if (c.pendingAuth !== hold) return;
          c.pendingAuth = undefined;
          const start: PendingAuthorization = { ...hold, parentIdTag: parent, authorized: true };
          if (c.plugged) this.#startTransaction(c, start);
          else this.#awaitPlugIn(c, start);
        })();
      });
      return { status: 'Accepted' };
    });

    on('RemoteStopTransaction', ({ transactionId }) => {
      if (this.#registration === 'Pending') return { status: 'Rejected' };
      const c = this.#connectors.find(
        (candidate) =>
          candidate.tx?.handle.transactionId === transactionId && !candidate.tx.stopping,
      );
      if (!c) return { status: 'Rejected' };
      this.#later(0, () => void this.#stopTransaction(c, 'Remote'));
      return { status: 'Accepted' };
    });

    on('Reset', ({ type }) => {
      if (this.#rebooting) return { status: 'Rejected' };
      this.#later(0, () => void this.#reboot(type));
      return { status: 'Accepted' };
    });

    on('ChangeAvailability', ({ connectorId, type }) => {
      if (connectorId > count) return { status: 'Rejected' };
      const targets = connectorId === 0 ? this.#connectors : [this.#connector(connectorId)];
      let scheduled = false;
      for (const c of targets) {
        // The Central System's decision overrides a temporary firmware block.
        c.firmwareBlocked = false;
        if (type === 'Inoperative') {
          if (c.tx) {
            c.pendingUnavailable = true;
            scheduled = true;
            continue;
          }
          if (c.pendingAuth) {
            if (c.pendingAuth.timer) clearTimeout(c.pendingAuth.timer);
            c.pendingAuth = undefined;
          }
          this.#terminateReservationOf(c);
          this.#later(0, () => c.fsm.tryApply('makeUnavailable'));
        } else {
          c.pendingUnavailable = false;
          this.#later(0, () => {
            if (c.fsm.tryApply('makeAvailable') && c.plugged) c.fsm.tryApply('plugIn');
          });
        }
      }
      if (connectorId === 0) {
        const available = type === 'Operative';
        if (!available) {
          for (const reservation of this.#reservations.stationWide()) {
            this.#reservations.remove(reservation.reservationId);
            this.emit('reservation', 'terminated', reservation);
          }
        }
        if (available !== this.#stationAvailable) {
          this.#stationAvailable = available;
          this.#later(0, () => {
            this.#sendStationStatus();
          });
        }
      }
      return { status: scheduled ? 'Scheduled' : 'Accepted' };
    });

    on('ChangeConfiguration', ({ key, value }) => ({
      status: this.configuration.change(key, value),
    }));

    on('GetConfiguration', ({ key }) => this.configuration.getConfiguration(key));

    on('ClearCache', () => {
      this.authorizationCache.clear();
      return { status: 'Accepted' };
    });

    on('DataTransfer', () => ({ status: 'UnknownVendorId' }));

    on('UnlockConnector', ({ connectorId }) => {
      if (connectorId > count) return { status: 'NotSupported' };
      const c = this.#connector(connectorId);
      if (c.tx) this.#later(0, () => void this.#stopTransaction(c, 'UnlockCommand'));
      return { status: 'Unlocked' };
    });

    // Local Auth List Management: the specification defines the answers of a charge point
    // without the feature (-1 and NotSupported), so they are served even when it is disabled.
    const hasLocalList = this.#supports('LocalAuthListManagement');
    on('GetLocalListVersion', () => ({
      listVersion: hasLocalList ? this.localAuthList.version : -1,
    }));
    on('SendLocalList', (request) => ({
      status: hasLocalList ? this.localAuthList.apply(request) : 'NotSupported',
    }));

    if (this.#supports('Reservation')) {
      on('ReserveNow', (request) => ({ status: this.#reserveNow(request) }));
      on('CancelReservation', ({ reservationId }) => {
        const reservation = this.#reservations.remove(reservationId);
        if (!reservation) return { status: 'Rejected' };
        this.#releaseReservation(reservation, 'cancelled');
        return { status: 'Accepted' };
      });
    }

    if (this.#supports('FirmwareManagement')) {
      on('UpdateFirmware', (request) => {
        this.#firmware.request(request);
        return {};
      });
      on('GetDiagnostics', (request) => this.#diagnostics.request(request));
    }

    if (this.#supports('RemoteTrigger')) {
      on('TriggerMessage', ({ requestedMessage, connectorId }) => {
        if (connectorId !== undefined && connectorId > count) return { status: 'Rejected' };
        // Connector 0 addresses the charge point itself (its status, its main meter).
        const targets =
          connectorId === undefined
            ? this.#connectors
            : connectorId === 0
              ? []
              : [this.#connector(connectorId)];
        switch (requestedMessage) {
          case 'BootNotification':
            this.#later(0, () => void this.#boot());
            return { status: 'Accepted' };
          case 'Heartbeat':
            this.#later(0, () => void this.#call('Heartbeat', {}));
            return { status: 'Accepted' };
          case 'StatusNotification':
            this.#later(0, () => {
              if (connectorId === undefined) this.#sendAllStatuses(true);
              else if (connectorId === 0) this.#sendStationStatus();
              else for (const c of targets) void this.#sendStatus(c, true);
            });
            return { status: 'Accepted' };
          case 'MeterValues':
            this.#later(0, () => {
              if (connectorId === 0) this.#sendStationMeterValues('Trigger');
              for (const c of targets) this.#sendMeterValues(c, 'Trigger');
            });
            return { status: 'Accepted' };
          case 'DiagnosticsStatusNotification':
            if (!this.#supports('FirmwareManagement')) return { status: 'NotImplemented' };
            this.#later(0, () => {
              void this.#call('DiagnosticsStatusNotification', {
                status: this.#diagnostics.triggeredStatus,
              });
            });
            return { status: 'Accepted' };
          case 'FirmwareStatusNotification':
            if (!this.#supports('FirmwareManagement')) return { status: 'NotImplemented' };
            this.#later(0, () => {
              void this.#call('FirmwareStatusNotification', {
                status: this.#firmware.triggeredStatus,
              });
            });
            return { status: 'Accepted' };
        }
      });
    }

    if (this.#supports('SmartCharging')) {
      on('SetChargingProfile', ({ connectorId, csChargingProfiles }) => {
        if (connectorId > count) return { status: 'Rejected' };
        const tx =
          connectorId === 0 ? undefined : this.#transactionContext(this.#connector(connectorId));
        return { status: this.profiles.set(connectorId, csChargingProfiles, tx) };
      });

      on('ClearChargingProfile', (criteria) => ({ status: this.profiles.clear(criteria) }));

      on('GetCompositeSchedule', ({ connectorId, duration, chargingRateUnit }) => {
        if (connectorId > count) return { status: 'Rejected' };
        const tx =
          connectorId === 0 ? undefined : this.#transactionContext(this.#connector(connectorId));
        return this.profiles.compositeSchedule(connectorId, duration, {
          unit: chargingRateUnit,
          transaction: tx,
          hardwareMaxW: connectorId === 0 ? this.#maxPowerW * count : this.#maxPowerW,
          spec: this.#spec,
        });
      });
    }
  }
}
