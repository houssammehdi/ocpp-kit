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

/** The queue is full and the new message may not displace an older one. */
export class OfflineQueueFullError extends OcppKitError {
  constructor(readonly maxSize: number) {
    super(`Offline queue is full (${maxSize} messages)`);
  }
}

/**
 * Ordered, persistent FIFO of transaction-related messages.
 *
 * When full, the oldest `MeterValues` entry is discarded to make room, because periodic samples
 * are the least valuable data; Start/StopTransaction are never discarded (the push fails instead).
 */
export class OfflineQueue {
  readonly #store: OfflineQueueStore;
  readonly #maxSize: number;
  #messages: QueuedMessage[] = [];
  #nextSeq = 1;
  #loaded = false;

  constructor(store: OfflineQueueStore = new MemoryQueueStore(), maxSize = 10_000) {
    this.#store = store;
    this.#maxSize = maxSize;
  }

  /** Number of queued messages. */
  get size(): number {
    return this.#messages.length;
  }

  /** Load persisted messages. Idempotent. */
  async init(): Promise<void> {
    if (this.#loaded) return;
    const loaded = await this.#store.load();
    this.#messages = [...loaded, ...this.#messages].sort((a, b) => a.seq - b.seq);
    this.#nextSeq = Math.max(this.#nextSeq, ...this.#messages.map((m) => m.seq + 1));
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

  /** Append a message and persist the queue. Returns the discarded message, if any. */
  async push(
    action: QueuedMessage['action'],
    payload: JsonObject,
  ): Promise<{ message: QueuedMessage; evicted?: QueuedMessage }> {
    let evicted: QueuedMessage | undefined;
    if (this.#messages.length >= this.#maxSize) {
      const index = this.#messages.findIndex((m) => m.action === 'MeterValues');
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
    await this.#store.save(this.#messages);
    return evicted ? { message, evicted } : { message };
  }

  /** Remove a delivered (or abandoned) message and persist the queue. */
  async remove(seq: number): Promise<void> {
    const before = this.#messages.length;
    this.#messages = this.#messages.filter((m) => m.seq !== seq);
    if (this.#messages.length !== before) await this.#store.save(this.#messages);
  }
}
