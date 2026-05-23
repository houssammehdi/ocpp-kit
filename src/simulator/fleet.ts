import { TypedEventEmitter } from '../util/typed-emitter.js';
import { timerDelay } from '../util/timers.js';
import { SimulatedCharger, type SimulatedChargerOptions } from './charger.js';
import type { ConnectorStatus } from './connector-state.js';
import { LatencyTracker, type LatencySummary } from './stats.js';

/** Options of {@link Fleet}. */
export interface FleetOptions {
  /** Central System endpoint without the identity. */
  readonly url: string;
  /** Number of chargers. */
  readonly count: number;
  /** Chargers started per second (ramp-up). Default: 10. */
  readonly ratePerSecond?: number;
  /** Identity prefix; chargers are named `<prefix><index>` with zero padding. Default: `SIM-`. */
  readonly identityPrefix?: string;
  /** Seed shared by the fleet; each charger derives its own stream from it. Default: 1. */
  readonly seed?: number;
  /** Options applied to every charger. */
  readonly charger?: Partial<Omit<SimulatedChargerOptions, 'identity' | 'url' | 'seed'>>;
}

/** Aggregated fleet state. */
export interface FleetStats {
  readonly chargers: number;
  readonly started: number;
  readonly connected: number;
  readonly registered: number;
  readonly activeTransactions: number;
  readonly sessionsStarted: number;
  readonly sessionsCompleted: number;
  readonly energyKWh: number;
  readonly powerKW: number;
  readonly callsSent: number;
  readonly callErrors: number;
  readonly connectorStatuses: Readonly<Partial<Record<ConnectorStatus, number>>>;
  readonly latency: LatencySummary;
}

/** Events emitted by {@link Fleet}. */
export interface FleetEvents {
  chargerStarted: (charger: SimulatedCharger) => void;
  chargerFailed: (charger: SimulatedCharger, error: Error) => void;
}

/** Spawns and supervises many {@link SimulatedCharger}s for load testing. */
export class Fleet extends TypedEventEmitter<FleetEvents> {
  readonly chargers: readonly SimulatedCharger[];
  readonly #options: FleetOptions;
  readonly #latency = new LatencyTracker();
  #started = 0;
  #stopped = false;
  #ramp: NodeJS.Timeout | undefined;
  #rampDone: (() => void) | undefined;

  constructor(options: FleetOptions) {
    super();
    if (!Number.isInteger(options.count) || options.count < 1) {
      throw new RangeError('count must be a positive integer');
    }
    this.#options = options;
    const prefix = options.identityPrefix ?? 'SIM-';
    const width = Math.max(3, String(options.count).length);
    this.chargers = Array.from({ length: options.count }, (_, index) => {
      const charger = new SimulatedCharger({
        ...options.charger,
        identity: `${prefix}${String(index + 1).padStart(width, '0')}`,
        url: options.url,
        seed: options.seed ?? 1,
      });
      charger.on('callCompleted', (event) => this.#latency.record(event.durationMs));
      return charger;
    });
  }

  /**
   * Start chargers at the configured ramp rate. Resolves once every charger has been started
   * (connection attempts continue in the background with backoff).
   */
  start(): Promise<void> {
    const rate = this.#options.ratePerSecond ?? 10;
    if (!(rate > 0)) throw new RangeError('ratePerSecond must be positive');
    const intervalMs = 1_000 / rate;
    return new Promise((resolve) => {
      this.#rampDone = resolve;
      const launch = (): void => {
        if (this.#stopped || this.#started >= this.chargers.length) {
          resolve();
          return;
        }
        const charger = this.chargers[this.#started++];
        if (charger) {
          this.emit('chargerStarted', charger);
          charger.start().catch((error: unknown) => {
            this.emit(
              'chargerFailed',
              charger,
              error instanceof Error ? error : new Error(String(error)),
            );
          });
        }
        this.#ramp = setTimeout(launch, timerDelay(intervalMs));
      };
      launch();
    });
  }

  /** Stop every charger. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#ramp) clearTimeout(this.#ramp);
    this.#rampDone?.();
    await Promise.all(this.chargers.map((charger) => charger.stop()));
  }

  /** Aggregate statistics over all chargers. */
  stats(): FleetStats {
    const statuses: Partial<Record<ConnectorStatus, number>> = {};
    let connected = 0;
    let registered = 0;
    let activeTransactions = 0;
    let sessionsStarted = 0;
    let sessionsCompleted = 0;
    let energyWh = 0;
    let powerW = 0;
    let callsSent = 0;
    let callErrors = 0;
    for (const charger of this.chargers) {
      const s = charger.stats();
      if (s.connected) connected++;
      if (s.registered) registered++;
      activeTransactions += s.activeTransactions;
      sessionsStarted += s.sessionsStarted;
      sessionsCompleted += s.sessionsCompleted;
      energyWh += s.energyWh;
      powerW += s.powerW;
      callsSent += s.callsSent;
      callErrors += s.callErrors;
      for (const connector of charger.connectors) {
        statuses[connector.status] = (statuses[connector.status] ?? 0) + 1;
      }
    }
    return {
      chargers: this.chargers.length,
      started: this.#started,
      connected,
      registered,
      activeTransactions,
      sessionsStarted,
      sessionsCompleted,
      energyKWh: energyWh / 1_000,
      powerKW: powerW / 1_000,
      callsSent,
      callErrors,
      connectorStatuses: statuses,
      latency: this.#latency.summary(),
    };
  }
}
