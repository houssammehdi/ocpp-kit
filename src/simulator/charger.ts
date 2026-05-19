import { ChargePoint, type ChargePointOptions } from '../client/charge-point.js';
import { MemoryQueueStore, type OfflineQueueStore } from '../client/offline-queue.js';
import type {
  CentralSystemAction,
  CentralSystemRequest,
  CentralSystemResponse,
  ChargePointAction,
  ChargePointErrorCode,
  ChargePointRequest,
  ChargePointResponse,
  ChargingProfile,
  MeterValue,
  ReadingContext,
  SampledValue,
  StopReason,
} from '../messages/index.js';
import type { CompletedCallEvent } from '../rpc/peer.js';
import { TypedEventEmitter } from '../util/typed-emitter.js';
import {
  ConfigurationStore,
  defaultConfiguration,
  type ConfigKeyDefinition,
} from './configuration.js';
import { ConnectorStateMachine, type ConnectorStatus } from './connector-state.js';
import { acceptedPowerW, ElectricVehicle, randomEvProfile, type EvProfile } from './ev.js';
import { deriveSeed, Random } from './random.js';
import {
  ChargingProfileManager,
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
}

const DEFAULT_AUTOPILOT: Required<AutopilotOptions> = {
  idleS: [30, 300],
  plugInDelayS: [2, 10],
  swipeDelayS: [1, 5],
  dwellAfterFullS: [0, 120],
  unplugDelayS: [3, 15],
  maxSessionS: 4 * 3_600,
};

/** Options of {@link SimulatedCharger}. */
export interface SimulatedChargerOptions {
  /** Charge point identity. */
  readonly identity: string;
  /** Central System endpoint without the identity. */
  readonly url: string;
  /** Security Profile 1 password. */
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
  /** Extra configuration keys. */
  readonly configuration?: readonly ConfigKeyDefinition[];
  /** Offline queue store shared across reboots. Default: in-memory. */
  readonly queueStore?: OfflineQueueStore;
  /** Options forwarded to the underlying {@link ChargePoint} client. */
  readonly client?: Partial<Omit<ChargePointOptions, 'identity' | 'url' | 'password'>>;
}

/** Snapshot of one connector. */
export interface ConnectorSnapshot {
  readonly connectorId: number;
  readonly status: ConnectorStatus;
  readonly plugged: boolean;
  readonly transactionId: number | undefined;
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
  reboot: (type: 'Hard' | 'Soft') => void;
  callCompleted: (event: CompletedCallEvent) => void;
  connection: (connected: boolean) => void;
}

interface ActiveTransaction {
  readonly idTag: string;
  readonly startedAt: Date;
  readonly meterStartWh: number;
  id: number | undefined;
  idPromise: Promise<number | undefined>;
  elapsedS: number;
  nextSampleS: number;
  stopping: boolean;
  pendingProfile: ChargingProfile | undefined;
}

/** A connector reserved for an id tag that has not started a transaction yet. */
interface PendingAuthorization {
  readonly idTag: string;
  /** False while a remote start is still being authorized. */
  readonly authorized: boolean;
  readonly timer: NodeJS.Timeout | undefined;
  readonly profile: ChargingProfile | undefined;
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
  autoTimer: NodeJS.Timeout | undefined;
  fullSince: number | undefined;
}

const ENERGY_REGISTER = 'Energy.Active.Import.Register';

/** Whether a connector has (or is about to have) a transaction. */
function isBusy(c: Connector): boolean {
  return c.tx !== undefined || c.pendingAuth !== undefined;
}

function round(value: number, digits: number): string {
  return value.toFixed(digits);
}

/**
 * A virtual OCPP 1.6 charge point.
 *
 * It boots, sends heartbeats, runs a connector state machine per connector, answers every
 * Central System request of the Core, Smart Charging and Remote Trigger profiles it implements,
 * integrates energy with a CC/CV charging curve and reports MeterValues. With the autopilot on,
 * simulated drivers arrive, charge and leave on their own.
 */
export class SimulatedCharger extends TypedEventEmitter<SimulatedChargerEvents> {
  readonly identity: string;
  /** Configuration keys (GetConfiguration/ChangeConfiguration). */
  readonly configuration: ConfigurationStore;
  /** Installed charging profiles. */
  readonly profiles: ChargingProfileManager;

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
  #client: ChargePoint;
  #registered = false;
  #stopped = true;
  #rebooting = false;
  #stationAvailable = true;
  #heartbeat: NodeJS.Timeout | undefined;
  #tick: NodeJS.Timeout | undefined;
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
    this.configuration = new ConfigurationStore([
      ...defaultConfiguration({
        connectors: count,
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
      if (key === 'HeartbeatInterval' && this.#registered) this.#startHeartbeat();
    });
    this.profiles = new ChargingProfileManager({
      connectors: count,
      maxStackLevel: this.configuration.getInteger('ChargeProfileMaxStackLevel', 8),
      maxProfiles: this.configuration.getInteger('MaxChargingProfilesInstalled', 16),
      maxPeriods: this.configuration.getInteger('ChargingScheduleMaxPeriods', 24),
    });
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
    return this.#registered;
  }

  /** Snapshot of every connector. */
  get connectors(): ConnectorSnapshot[] {
    return this.#connectors.map((c) => ({
      connectorId: c.id,
      status: c.fsm.status,
      plugged: c.plugged,
      transactionId: c.tx?.id,
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
      registered: this.#registered,
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
    this.#tick = setInterval(() => {
      this.#onTick();
    }, this.#tickS * 1_000);
    await this.#client.connect();
  }

  /** Stop the simulation and disconnect (like a power cut: transactions are not stopped). */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#tick) clearInterval(this.#tick);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    for (const c of this.#connectors) {
      if (c.autoTimer) clearTimeout(c.autoTimer);
      if (c.pendingAuth?.timer) clearTimeout(c.pendingAuth.timer);
    }
    await this.#client.close(1000, 'Simulator stopped');
  }

  // -------------------------------------------------------------------------------------------
  // Manual control (also used by the autopilot)
  // -------------------------------------------------------------------------------------------

  /** Plug an EV into a connector. A pending authorization starts the transaction right away. */
  plugIn(connectorId: number, ev: EvProfile = randomEvProfile(this.#random)): void {
    const c = this.#connector(connectorId);
    if (c.plugged) throw new RangeError(`Connector ${connectorId} is already plugged in`);
    c.plugged = true;
    c.ev = new ElectricVehicle(ev);
    c.fullSince = undefined;
    const pending = c.pendingAuth;
    if (pending?.authorized) {
      if (pending.timer) clearTimeout(pending.timer);
      c.pendingAuth = undefined;
      this.#startTransaction(c, pending.idTag, pending.profile);
      return;
    }
    c.fsm.tryApply('plugIn');
    if (this.#autopilot && c.fsm.status === 'Preparing') {
      this.#schedule(c, this.#autopilot.swipeDelayS, () => {
        void this.swipe(connectorId, this.#randomIdTag());
      });
    }
  }

  /** Unplug the EV. A running transaction stops with reason `EVDisconnected`. */
  unplug(connectorId: number): void {
    const c = this.#connector(connectorId);
    if (!c.plugged) return;
    c.plugged = false;
    c.ev = undefined;
    c.powerW = 0;
    if (c.autoTimer) clearTimeout(c.autoTimer);
    c.fsm.tryApply('unplug');
    if (c.tx && !c.tx.stopping) void this.#stopTransaction(c, 'EVDisconnected');
  }

  /**
   * Present an id tag at a connector: stops the running transaction if the tag matches,
   * otherwise authorizes (online, or offline when `LocalAuthorizeOffline`) and starts one.
   *
   * @returns whether the tag was accepted
   */
  async swipe(connectorId: number, idTag: string): Promise<boolean> {
    const c = this.#connector(connectorId);
    if (c.tx) {
      if (c.tx.idTag !== idTag || c.tx.stopping) return false;
      await this.#stopTransaction(c, 'Local');
      return true;
    }
    const status = c.fsm.status;
    if ((status !== 'Available' && status !== 'Preparing') || c.pendingAuth) return false;
    if (!(await this.#authorize(idTag))) return false;
    // Re-check: another start may have claimed the connector while we awaited Authorize.
    if (isBusy(c)) return false;
    if (c.plugged) this.#startTransaction(c, idTag);
    else this.#awaitPlugIn(c, idTag);
    return true;
  }

  /** Stop the transaction on a connector locally. */
  async stopTransaction(connectorId: number, reason: StopReason = 'Local'): Promise<void> {
    await this.#stopTransaction(this.#connector(connectorId), reason);
  }

  /** Put a connector in the Faulted state, stopping any transaction. */
  async fault(connectorId: number, errorCode: ChargePointErrorCode = 'OtherError'): Promise<void> {
    const c = this.#connector(connectorId);
    c.errorCode = errorCode;
    const stopping = c.tx ? this.#stopTransaction(c, 'Other') : Promise.resolve();
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
  // Internals
  // -------------------------------------------------------------------------------------------

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
      autoTimer: undefined,
      fullSince: undefined,
    };
    connector.fsm.onChange((status) => {
      this.emit('status', id, status);
      void this.#sendStatus(connector);
      this.#onStatusChanged(connector, status);
    });
    return connector;
  }

  #createClient(): ChargePoint {
    const attempts = this.configuration.getInteger('TransactionMessageAttempts', 3);
    const retryS = this.configuration.getInteger('TransactionMessageRetryInterval', 10);
    const client = new ChargePoint({
      transactionMessageAttempts: attempts,
      transactionMessageRetryIntervalMs: retryS * 1_000,
      random: () => this.#jitter.next(),
      ...this.#options.client,
      identity: this.identity,
      url: this.#options.url,
      ...(this.#options.password === undefined ? {} : { password: this.#options.password }),
      offlineQueue: { store: this.#queueStore },
    });
    client.on('open', () => {
      this.emit('connection', true);
      if (this.#registered) this.#sendAllStatuses();
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

  #later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#stopped) fn();
    }, ms);
    this.#timers.add(timer);
  }

  #schedule(c: Connector, rangeS: readonly [number, number], fn: () => void): void {
    if (c.autoTimer) clearTimeout(c.autoTimer);
    const delayMs = Math.round(this.#random.float(rangeS[0], rangeS[1]) * 1_000);
    c.autoTimer = setTimeout(() => {
      c.autoTimer = undefined;
      if (!this.#stopped && !this.#rebooting) fn();
    }, delayMs);
  }

  #randomIdTag(): string {
    const tags = this.#options.idTags;
    if (tags && tags.length > 0) return this.#random.pick(tags);
    return `TAG${String(this.#random.int(0, 99_999)).padStart(5, '0')}`;
  }

  async #boot(): Promise<void> {
    const { vendor = 'ocpp-kit', model = 'Simulator', firmwareVersion } = this.#options;
    const response = await this.#call('BootNotification', {
      chargePointVendor: vendor.slice(0, 20),
      chargePointModel: model.slice(0, 20),
      chargePointSerialNumber: this.identity.slice(0, 25),
      ...(firmwareVersion === undefined ? {} : { firmwareVersion }),
    });
    if (!response || this.#stopped) return;
    if (response.status === 'Accepted') {
      this.#registered = true;
      if (response.interval > 0) {
        this.configuration.set('HeartbeatInterval', String(response.interval));
      }
      this.#startHeartbeat();
      this.#sendAllStatuses();
      this.emit('registered');
      if (this.#autopilot) {
        for (const c of this.#connectors) this.#onStatusChanged(c, c.fsm.status);
      }
      return;
    }
    const retryS = response.interval > 0 ? response.interval : (this.#options.bootRetryS ?? 30);
    this.#later(retryS * 1_000, () => {
      if (this.#client.isConnected && !this.#registered) void this.#boot();
    });
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const intervalS = this.configuration.getInteger('HeartbeatInterval', 300);
    if (intervalS <= 0 || this.#stopped) return;
    this.#heartbeat = setInterval(() => {
      if (this.#client.isConnected) void this.#call('Heartbeat', {});
    }, intervalS * 1_000);
  }

  #sendAllStatuses(): void {
    void this.#call('StatusNotification', {
      connectorId: 0,
      errorCode: 'NoError',
      status: this.#stationAvailable ? 'Available' : 'Unavailable',
      timestamp: new Date().toISOString(),
    });
    for (const c of this.#connectors) void this.#sendStatus(c);
  }

  async #sendStatus(c: Connector): Promise<void> {
    if (!this.#client.isConnected || !this.#registered) return;
    await this.#call('StatusNotification', {
      connectorId: c.id,
      errorCode: c.errorCode,
      status: c.fsm.status,
      timestamp: new Date().toISOString(),
    });
  }

  async #authorize(idTag: string): Promise<boolean> {
    if (!this.#client.isConnected) {
      return this.configuration.getBoolean('LocalAuthorizeOffline', true);
    }
    const response = await this.#call('Authorize', { idTag });
    if (!response) return this.configuration.getBoolean('LocalAuthorizeOffline', true);
    return response.idTagInfo.status === 'Accepted';
  }

  /** Authorized but not plugged in yet: wait up to ConnectionTimeOut for the cable. */
  #awaitPlugIn(c: Connector, idTag: string, profile?: ChargingProfile): void {
    const timeoutS = this.configuration.getInteger('ConnectionTimeOut', 60);
    const timer = setTimeout(() => {
      if (c.pendingAuth?.idTag !== idTag) return;
      c.pendingAuth = undefined;
      c.fsm.tryApply('timeout');
    }, timeoutS * 1_000);
    c.pendingAuth = { idTag, authorized: true, timer, profile };
    c.fsm.tryApply('authorize');
    if (this.#autopilot) {
      this.#schedule(c, this.#autopilot.plugInDelayS, () => {
        if (!c.plugged && c.pendingAuth) this.plugIn(c.id);
      });
    }
  }

  #transactionContext(c: Connector): TransactionContext | undefined {
    return c.tx?.id === undefined
      ? undefined
      : { transactionId: c.tx.id, startedAt: c.tx.startedAt };
  }

  #startTransaction(c: Connector, idTag: string, pendingProfile?: ChargingProfile): void {
    const startedAt = new Date();
    const meterStartWh = Math.round(c.energyWh);
    const interval = this.configuration.getInteger('MeterValueSampleInterval', 60);
    const tx: ActiveTransaction = {
      idTag,
      startedAt,
      meterStartWh,
      id: undefined,
      idPromise: Promise.resolve(undefined),
      elapsedS: 0,
      nextSampleS: interval,
      stopping: false,
      pendingProfile,
    };
    c.tx = tx;
    this.#sessionsStarted++;
    tx.idPromise = this.#client
      .call('StartTransaction', {
        connectorId: c.id,
        idTag,
        meterStart: meterStartWh,
        timestamp: startedAt.toISOString(),
      })
      .then((response) => {
        tx.id = response.transactionId;
        this.emit('transactionStarted', c.id, response.transactionId);
        if (tx.pendingProfile && c.tx === tx) {
          this.profiles.set(c.id, tx.pendingProfile, {
            transactionId: response.transactionId,
            startedAt,
          });
        }
        if (
          response.idTagInfo.status !== 'Accepted' &&
          this.configuration.getBoolean('StopTransactionOnInvalidId', true)
        ) {
          void this.#stopTransaction(c, 'DeAuthorized');
        }
        return response.transactionId;
      })
      .catch(() => undefined);
    c.fsm.tryApply('energyFlowing');
  }

  #sample(
    c: Connector,
    measurands: readonly string[],
    context: ReadingContext,
    energyWh = c.energyWh,
  ): MeterValue {
    const current = c.powerW / (this.#spec.voltage * this.#spec.phases);
    const offeredCurrent = c.offeredW / (this.#spec.voltage * this.#spec.phases);
    const sampled: SampledValue[] = [];
    for (const measurand of measurands) {
      switch (measurand) {
        case ENERGY_REGISTER:
          sampled.push({
            value: String(Math.round(energyWh)),
            context,
            measurand,
            unit: 'Wh',
            location: 'Outlet',
          });
          break;
        case 'Power.Active.Import':
          sampled.push({ value: round(c.powerW, 1), context, measurand, unit: 'W' });
          break;
        case 'Power.Offered':
          sampled.push({ value: round(c.offeredW, 1), context, measurand, unit: 'W' });
          break;
        case 'Current.Import':
          sampled.push({ value: round(current, 2), context, measurand, unit: 'A' });
          break;
        case 'Current.Offered':
          sampled.push({ value: round(offeredCurrent, 2), context, measurand, unit: 'A' });
          break;
        case 'Voltage':
          sampled.push({ value: round(this.#spec.voltage, 1), context, measurand, unit: 'V' });
          break;
        case 'SoC':
          if (c.ev) {
            sampled.push({
              value: String(Math.round(c.ev.soc * 100)),
              context,
              measurand,
              unit: 'Percent',
              location: 'EV',
            });
          }
          break;
        default:
          break;
      }
    }
    if (sampled.length === 0) {
      sampled.push({
        value: String(Math.round(energyWh)),
        context,
        measurand: ENERGY_REGISTER,
        unit: 'Wh',
      });
    }
    return { timestamp: new Date().toISOString(), sampledValue: sampled };
  }

  #sendMeterValues(c: Connector, context: ReadingContext): void {
    const measurands = this.configuration.getList('MeterValuesSampledData');
    const meterValue = this.#sample(c, measurands, context);
    const transactionId = c.tx?.id;
    if (c.tx && transactionId === undefined) return; // start not confirmed yet
    void this.#call('MeterValues', {
      connectorId: c.id,
      ...(transactionId === undefined ? {} : { transactionId }),
      meterValue: [meterValue],
    });
  }

  async #stopTransaction(c: Connector, reason: StopReason): Promise<void> {
    const tx = c.tx;
    if (!tx || tx.stopping) return;
    tx.stopping = true;
    c.powerW = 0;
    const stoppedAt = new Date();
    const meterStopWh = Math.round(c.energyWh);
    const stopMeasurands = this.configuration.getList('StopTxnSampledData');
    const endSample = this.#sample(c, stopMeasurands, 'Transaction.End', meterStopWh);
    c.fsm.tryApply('transactionStopped');
    const transactionId = await tx.idPromise;
    this.profiles.transactionEnded(c.id);
    if (transactionId !== undefined) {
      const beginSample: MeterValue = {
        timestamp: tx.startedAt.toISOString(),
        sampledValue: [
          {
            value: String(tx.meterStartWh),
            context: 'Transaction.Begin',
            measurand: ENERGY_REGISTER,
            unit: 'Wh',
          },
        ],
      };
      await this.#call('StopTransaction', {
        transactionId,
        idTag: tx.idTag,
        meterStop: meterStopWh,
        timestamp: stoppedAt.toISOString(),
        reason,
        transactionData: [beginSample, { ...endSample, timestamp: stoppedAt.toISOString() }],
      });
      this.emit('transactionStopped', c.id, transactionId, reason, meterStopWh - tx.meterStartWh);
    }
    if (c.tx === tx) c.tx = undefined;
    this.#sessionsCompleted++;
    if (c.pendingUnavailable) {
      c.pendingUnavailable = false;
      c.fsm.tryApply('makeUnavailable');
    }
    if (this.#autopilot && c.plugged) {
      this.#schedule(c, this.#autopilot.unplugDelayS, () => {
        this.unplug(c.id);
      });
    }
  }

  #onStatusChanged(c: Connector, status: ConnectorStatus): void {
    const autopilot = this.#autopilot;
    if (!autopilot || !this.#registered) return;
    if (status === 'Available' && !c.plugged && !c.pendingAuth) {
      this.#schedule(c, autopilot.idleS, () => {
        if (c.fsm.status === 'Available' && !c.plugged && !c.pendingAuth) this.plugIn(c.id);
      });
    }
  }

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
    const demand = (c: Connector, cap: number): number =>
      Math.min(cap, c.ev ? acceptedPowerW(c.ev.profile, c.ev.soc) : 0);
    const byDemand = caps
      .map(({ c, cap }) => ({ c, cap, demand: demand(c, cap) }))
      .sort((a, b) => a.demand - b.demand);
    let remaining = Math.max(0, station);
    // Max-min fair allocation: serve the smallest demands first; whatever they leave unused is
    // shared among the rest.
    byDemand.forEach(({ c, cap, demand: wanted }, index) => {
      const offered = Math.min(cap, remaining / (byDemand.length - index));
      result.set(c, offered);
      remaining -= Math.min(offered, wanted);
    });
    return result;
  }

  #onTick(): void {
    if (this.#rebooting) return;
    const now = new Date();
    const active = this.#connectors.filter((c) => c.tx && !c.tx.stopping && c.plugged && c.ev);
    const offered = this.#offeredPower(active, now);
    const interval = this.configuration.getInteger('MeterValueSampleInterval', 60);
    for (const c of this.#connectors) {
      const tx = c.tx;
      const ev = c.ev;
      if (!tx || tx.stopping || !ev || !offered.has(c)) {
        c.powerW = 0;
        c.offeredW = 0;
        continue;
      }
      c.offeredW = offered.get(c) ?? 0;
      c.powerW = ev.charge(c.offeredW, this.#tickS);
      c.energyWh += (c.powerW * this.#tickS) / 3_600;
      if (c.offeredW <= 0) c.fsm.tryApply('suspendByEVSE');
      else if (c.powerW <= 0) c.fsm.tryApply('suspendByEV');
      else c.fsm.tryApply('energyFlowing');

      tx.elapsedS += this.#tickS;
      if (interval > 0 && tx.elapsedS >= tx.nextSampleS) {
        tx.nextSampleS += interval;
        this.#sendMeterValues(c, 'Sample.Periodic');
      }
      this.#autopilotStep(c, tx, ev);
    }
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

  async #reboot(type: 'Hard' | 'Soft'): Promise<void> {
    this.#rebooting = true;
    const reason: StopReason = type === 'Hard' ? 'HardReset' : 'SoftReset';
    await Promise.all(this.#connectors.map((c) => this.#stopTransaction(c, reason)));
    this.emit('reboot', type);
    this.#registered = false;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    await this.#client.close(1000, `${type} reset`);
    await new Promise<void>((resolve) => {
      this.#later(this.#options.rebootDelayMs ?? 2_000, resolve);
    });
    this.#rebooting = false;
    if (this.#stopped) return;
    this.#client = this.#createClient();
    await this.#client.connect().catch(() => undefined);
  }

  #registerHandlers(client: ChargePoint): void {
    const on = <A extends CentralSystemAction>(
      action: A,
      handler: (payload: CentralSystemRequest<A>) => CentralSystemResponse<A>,
    ): void => {
      client.handle(action, handler);
    };
    const count = this.#connectors.length;

    on('RemoteStartTransaction', ({ connectorId, idTag, chargingProfile }) => {
      if (chargingProfile && chargingProfile.chargingProfilePurpose !== 'TxProfile') {
        return { status: 'Rejected' };
      }
      const candidates =
        connectorId === undefined
          ? this.#connectors
          : this.#connectors.filter((c) => c.id === connectorId);
      const c = candidates.find(
        (candidate) =>
          !candidate.tx &&
          !candidate.pendingAuth &&
          (candidate.fsm.status === 'Available' || candidate.fsm.status === 'Preparing'),
      );
      if (!c || this.#rebooting) return { status: 'Rejected' };
      // Reserve the connector synchronously so concurrent requests cannot both succeed; the
      // transaction itself starts after the response has been sent.
      const reservation: PendingAuthorization = {
        idTag,
        authorized: false,
        timer: undefined,
        profile: chargingProfile,
      };
      c.pendingAuth = reservation;
      this.#later(0, () => {
        void (async () => {
          const authorized =
            !this.configuration.getBoolean('AuthorizeRemoteTxRequests', false) ||
            (await this.#authorize(idTag));
          if (c.pendingAuth !== reservation) return;
          c.pendingAuth = undefined;
          if (!authorized) return;
          if (c.plugged) this.#startTransaction(c, idTag, chargingProfile);
          else this.#awaitPlugIn(c, idTag, chargingProfile);
        })();
      });
      return { status: 'Accepted' };
    });

    on('RemoteStopTransaction', ({ transactionId }) => {
      const c = this.#connectors.find((candidate) => candidate.tx?.id === transactionId);
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
        if (type === 'Inoperative') {
          if (c.tx) {
            c.pendingUnavailable = true;
            scheduled = true;
          } else {
            this.#later(0, () => c.fsm.tryApply('makeUnavailable'));
          }
        } else {
          c.pendingUnavailable = false;
          this.#later(0, () => {
            if (c.fsm.tryApply('makeAvailable') && c.plugged) c.fsm.tryApply('plugIn');
          });
        }
      }
      if (connectorId === 0) {
        const available = type === 'Operative';
        if (available !== this.#stationAvailable) {
          this.#stationAvailable = available;
          this.#later(0, () => {
            void this.#call('StatusNotification', {
              connectorId: 0,
              errorCode: 'NoError',
              status: available ? 'Available' : 'Unavailable',
              timestamp: new Date().toISOString(),
            });
          });
        }
      }
      return { status: scheduled ? 'Scheduled' : 'Accepted' };
    });

    on('ChangeConfiguration', ({ key, value }) => ({
      status: this.configuration.change(key, value),
    }));

    on('GetConfiguration', ({ key }) => this.configuration.getConfiguration(key));

    on('ClearCache', () => ({ status: 'Accepted' }));

    on('DataTransfer', () => ({ status: 'UnknownVendorId' }));

    on('UnlockConnector', ({ connectorId }) => {
      if (connectorId > count) return { status: 'NotSupported' };
      const c = this.#connector(connectorId);
      if (c.tx) this.#later(0, () => void this.#stopTransaction(c, 'UnlockCommand'));
      return { status: 'Unlocked' };
    });

    on('TriggerMessage', ({ requestedMessage, connectorId }) => {
      if (connectorId !== undefined && connectorId > count) return { status: 'Rejected' };
      const targets = connectorId === undefined ? this.#connectors : [this.#connector(connectorId)];
      switch (requestedMessage) {
        case 'BootNotification':
          this.#later(0, () => void this.#boot());
          return { status: 'Accepted' };
        case 'Heartbeat':
          this.#later(0, () => void this.#call('Heartbeat', {}));
          return { status: 'Accepted' };
        case 'StatusNotification':
          this.#later(0, () => {
            if (connectorId === undefined) this.#sendAllStatuses();
            else for (const c of targets) void this.#sendStatus(c);
          });
          return { status: 'Accepted' };
        case 'MeterValues':
          this.#later(0, () => {
            for (const c of targets) this.#sendMeterValues(c, 'Trigger');
          });
          return { status: 'Accepted' };
        case 'DiagnosticsStatusNotification':
        case 'FirmwareStatusNotification':
          return { status: 'NotImplemented' };
      }
    });

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
