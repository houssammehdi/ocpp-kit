import { EventEmitter } from 'node:events';

/**
 * Map of event name to listener signature, e.g. `{ open: () => void; close: (code: number) => void }`.
 */
export type EventMap<T> = { [K in keyof T]: (...args: never[]) => void };

type Listener = (...args: unknown[]) => void;

/**
 * A minimal, strongly typed facade over Node's {@link EventEmitter}.
 *
 * Composition (rather than inheritance) keeps the public surface small: consumers can only
 * subscribe, while `emit` stays available to subclasses.
 */
export class TypedEventEmitter<Events extends EventMap<Events>> {
  readonly #emitter = new EventEmitter();

  /**
   * Type-level only (never set at runtime): exposes the event map so helpers can infer event
   * signatures, e.g. `Parameters<NonNullable<T['eventTypes']>['close']>`.
   */
  declare readonly eventTypes?: Events;

  constructor() {
    // Load tests attach one listener per simulated charger; do not warn about "leaks".
    this.#emitter.setMaxListeners(0);
  }

  /** Subscribe to an event. */
  on<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.#emitter.on(event, listener as unknown as Listener);
    return this;
  }

  /** Subscribe to the next occurrence of an event only. */
  once<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.#emitter.once(event, listener as unknown as Listener);
    return this;
  }

  /** Remove a previously registered listener. */
  off<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    this.#emitter.off(event, listener as unknown as Listener);
    return this;
  }

  /** Number of listeners currently registered for `event`. */
  listenerCount(event: keyof Events & string): number {
    return this.#emitter.listenerCount(event);
  }

  /** Emit an event to all listeners. Returns `true` when at least one listener was invoked. */
  protected emit<K extends keyof Events & string>(
    event: K,
    ...args: Parameters<Events[K]>
  ): boolean {
    return this.#emitter.emit(event, ...args);
  }
}
