import type { v201 } from '../messages/index.js';
import type { CompletedCallEvent } from '../rpc/peer.js';
import { TypedEventEmitter } from '../util/typed-emitter.js';
import { timerDelay } from '../util/timers.js';
import { SimulatedCharger, type ChargerStats, type SimulatedChargerOptions } from './charger.js';
import type { ConnectorStatus } from './connector-state.js';
import { LatencyTracker, type LatencySummary } from './stats.js';
import { SimulatedChargingStation, type SimulatedChargingStationOptions } from './v201/station.js';

/**
 * What a fleet needs from a simulated charge point: {@link SimulatedCharger} (OCPP 1.6) and
 * {@link SimulatedChargingStation} (OCPP 2.0.1) both qualify.
 */
export interface FleetMember {
  readonly identity: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  stats(): ChargerStats;
  /** One entry per connector (EVSE for 2.0.1) with its current status. */
  readonly connectors: readonly { readonly status: string }[];
  on(event: 'callCompleted', listener: (event: CompletedCallEvent) => void): unknown;
}

/** What a {@link FleetOptions.create} factory gets for each member. */
export interface FleetMemberInit {
  readonly identity: string;
  readonly url: string;
  readonly seed: number;
  /** Zero-based position in the fleet. */
  readonly index: number;
}

/** A factory of OCPP 1.6 fleet members with the given charger options. */
export function chargerFactory(
  options: Partial<Omit<SimulatedChargerOptions, 'identity' | 'url' | 'seed'>> = {},
): (init: FleetMemberInit) => SimulatedCharger {
  return ({ identity, url, seed }) => new SimulatedCharger({ ...options, identity, url, seed });
}

/** A factory of OCPP 2.0.1 fleet members with the given station options. */
export function stationFactory(
  options: Partial<Omit<SimulatedChargingStationOptions, 'identity' | 'url' | 'seed'>> = {},
): (init: FleetMemberInit) => SimulatedChargingStation {
  return ({ identity, url, seed }) =>
    new SimulatedChargingStation({ ...options, identity, url, seed });
}

/** Options of {@link Fleet}. */
export interface FleetOptions<M extends FleetMember = SimulatedCharger> {
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
  /** Options applied to every charger when no `create` factory is given. */
  readonly charger?: Partial<Omit<SimulatedChargerOptions, 'identity' | 'url' | 'seed'>>;
  /**
   * Creates each member, e.g. `stationFactory({ evses: 2 })` for an OCPP 2.0.1 fleet or a
   * function that alternates versions for a mixed one. Default: {@link SimulatedCharger}s with
   * the `charger` options.
   */
  readonly create?: (init: FleetMemberInit) => M;
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
  /** Connectors by status (OCPP 1.6 and 2.0.1 statuses). */
  readonly connectorStatuses: Readonly<
    Partial<Record<ConnectorStatus | v201.ConnectorStatus, number>>
  >;
  readonly latency: LatencySummary;
}

/** Events emitted by {@link Fleet}. */
export interface FleetEvents<M extends FleetMember = SimulatedCharger> {
  chargerStarted: (charger: M) => void;
  chargerFailed: (charger: M, error: Error) => void;
}

/**
 * Spawns and supervises many simulated charge points for load testing: {@link SimulatedCharger}s
 * by default, or whatever `create` makes.
 */
export class Fleet<M extends FleetMember = SimulatedCharger> extends TypedEventEmitter<
  FleetEvents<M>
> {
  readonly chargers: readonly M[];
  readonly #options: FleetOptions<M>;
  readonly #latency = new LatencyTracker();
  #started = 0;
  #stopped = false;
  #ramp: NodeJS.Timeout | undefined;
  #rampDone: (() => void) | undefined;

  constructor(options: FleetOptions<M>) {
    super();
    if (!Number.isInteger(options.count) || options.count < 1) {
      throw new RangeError('count must be a positive integer');
    }
    this.#options = options;
    const prefix = options.identityPrefix ?? 'SIM-';
    const width = Math.max(3, String(options.count).length);
    const create =
      options.create ??
      (chargerFactory(options.charger) as unknown as (init: FleetMemberInit) => M);
    this.chargers = Array.from({ length: options.count }, (_, index) => {
      const charger = create({
        identity: `${prefix}${String(index + 1).padStart(width, '0')}`,
        url: options.url,
        seed: options.seed ?? 1,
        index,
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
    const statuses: Partial<Record<string, number>> = {};
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
