import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TransactionAction } from '../messages/index.js';
import type { JsonObject } from '../rpc/frames.js';
import { OcppKitError } from '../rpc/errors.js';

/** A transaction-related message waiting for delivery. */
export interface QueuedMessage {
  /** Monotonic sequence number; delivery happens in ascending order. */
  readonly seq: number;
  readonly action: TransactionAction;
  readonly payload: JsonObject;
  /** ISO timestamp of when the message was queued. */
  readonly enqueuedAt: string;
}

/** Persistence backend of an {@link OfflineQueue}. */
export interface OfflineQueueStore {
  /** Load all persisted messages (any order; the queue sorts by `seq`). */
  load(): Promise<QueuedMessage[]>;
  /** Replace the persisted contents with `messages`. */
  save(messages: readonly QueuedMessage[]): Promise<void>;
}

/** Keeps messages in memory only: they survive disconnects but not process restarts. */
export class MemoryQueueStore implements OfflineQueueStore {
  #messages: QueuedMessage[] = [];

  load(): Promise<QueuedMessage[]> {
    return Promise.resolve([...this.#messages]);
  }

  save(messages: readonly QueuedMessage[]): Promise<void> {
    this.#messages = [...messages];
    return Promise.resolve();
  }
}

/**
 * Persists messages as a JSON file so they also survive process restarts. Writes are serialised
 * and atomic (write to a temporary file, then rename).
 */
export class FileQueueStore implements OfflineQueueStore {
  readonly #path: string;
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<QueuedMessage[]> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new OcppKitError(`Corrupt offline queue file ${this.#path}`);
    return parsed as QueuedMessage[];
  }

  save(messages: readonly QueuedMessage[]): Promise<void> {
    const snapshot = JSON.stringify(messages);
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, this.#path);
    };
    this.#writing = this.#writing.then(write, write);
    return this.#writing;
  }
}

/** Result of {@link OfflineQueue.enqueue}. */
export interface QueueInsertion {
  /** The queued message. */
  readonly message: QueuedMessage;
  /** A MeterValues message discarded to make room, if any. */
  readonly evicted?: QueuedMessage;
  /** Settles once the store has saved the queue including the new message. */
  readonly persisted: Promise<void>;
}

/** The queue is full and the new message may not displace an older one. */
export class OfflineQueueFullError extends OcppKitError {
  constructor(readonly maxSize: number) {
    super(`Offline queue is full (${maxSize} messages)`);
  }
}

/**
 * Ordered, persistent FIFO of transaction-related messages.
 *
 * When full, the oldest `MeterValues` entry that is not being sent right now is discarded to make
 * room, because periodic samples are the least valuable data; Start/StopTransaction are never
 * discarded (the push fails instead).
 */
export class OfflineQueue {
  readonly #store: OfflineQueueStore;
  readonly #maxSize: number;
  #messages: QueuedMessage[] = [];
  #nextSeq = 1;
  #loading: Promise<void> | undefined;
  #loaded = false;
  #inFlight: number | undefined;

  constructor(store: OfflineQueueStore = new MemoryQueueStore(), maxSize = 10_000) {
    this.#store = store;
    this.#maxSize = maxSize;
  }

  /** Number of queued messages. */
  get size(): number {
    return this.#messages.length;
  }

  /**
   * Load persisted messages. Idempotent; {@link push} calls it too, so nothing is ever saved
   * before the persisted contents are known.
   */
  init(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<void> {
    const loaded = await this.#store.load();
    this.#messages = [...loaded].sort((a, b) => a.seq - b.seq);
    // A loop rather than Math.max(...seqs): spreading a few hundred thousand arguments throws
    // a RangeError, which would make a large persisted queue impossible to restore.
    for (const message of this.#messages) {
      if (message.seq >= this.#nextSeq) this.#nextSeq = message.seq + 1;
    }
    this.#loaded = true;
  }

  /** The next message to deliver, if any. */
  peek(): QueuedMessage | undefined {
    return this.#messages[0];
  }

  /** Snapshot of all queued messages in delivery order. */
  list(): readonly QueuedMessage[] {
    return [...this.#messages];
  }

  /**
   * Mark the message that is being sent (or `undefined` when none is). It stays queued until it
   * is removed, but it is never evicted to make room for new messages.
   */
  setInFlight(seq: number | undefined): void {
    this.#inFlight = seq;
  }

  /** Sequence number of the message marked with {@link setInFlight}, if any. */
  get inFlight(): number | undefined {
    return this.#inFlight;
  }

  /** Whether {@link init} has completed, i.e. the persisted messages are loaded. */
  get isLoaded(): boolean {
    return this.#loaded;
  }

  /**
   * Append a message synchronously (after {@link init} has completed) and start persisting the
   * queue. Use it when the caller must know the sequence number before anything else can run;
   * otherwise prefer {@link push}.
   *
   * @throws {@link OfflineQueueFullError} when full and no MeterValues can be evicted
   */
  enqueue(action: QueuedMessage['action'], payload: JsonObject): QueueInsertion {
    if (!this.#loaded) throw new OcppKitError('OfflineQueue.init() must complete before enqueue()');
    let evicted: QueuedMessage | undefined;
    if (this.#messages.length >= this.#maxSize) {
      const index = this.#messages.findIndex(
        (m) => m.action === 'MeterValues' && m.seq !== this.#inFlight,
      );
      if (index < 0) throw new OfflineQueueFullError(this.#maxSize);
      [evicted] = this.#messages.splice(index, 1);
    }
    const message: QueuedMessage = {
      seq: this.#nextSeq++,
      action,
      payload,
      enqueuedAt: new Date().toISOString(),
    };
    this.#messages.push(message);
    const persisted = this.#store.save(this.#messages);
    return evicted ? { message, evicted, persisted } : { message, persisted };
  }

  /** Append a message and persist the queue. Returns the discarded message, if any. */
  async push(
    action: QueuedMessage['action'],
    payload: JsonObject,
  ): Promise<{ message: QueuedMessage; evicted?: QueuedMessage }> {
    await this.init();
    const { persisted, ...inserted } = this.enqueue(action, payload);
    await persisted;
    return inserted;
  }

  /** Remove a delivered (or abandoned) message and persist the queue. */
  async remove(seq: number): Promise<void> {
    const before = this.#messages.length;
    this.#messages = this.#messages.filter((m) => m.seq !== seq);
    if (this.#messages.length !== before) await this.#store.save(this.#messages);
  }
}
