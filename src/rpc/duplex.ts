import { ConnectionClosedError } from './errors.js';

/** Callbacks a {@link Duplex} invokes when data arrives or the channel closes. */
export interface DuplexHandlers {
  message(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * The minimal bidirectional text channel the RPC layer needs.
 *
 * Keeping the RPC core behind this interface makes it transport-agnostic: the same peer runs over
 * a WebSocket in production and over an in-memory pair in unit tests.
 */
export interface Duplex {
  /** Whether frames can currently be sent. */
  readonly isOpen: boolean;
  /** Send one text frame. Throws {@link ConnectionClosedError} when the channel is closed. */
  send(data: string): void;
  /** Close the channel. Idempotent. */
  close(code?: number, reason?: string): void;
  /** Register the receiver. A duplex has exactly one receiver; messages are buffered until then. */
  attach(handlers: DuplexHandlers): void;
}

class MemoryDuplex implements Duplex {
  #handlers: DuplexHandlers | undefined;
  #buffer: string[] = [];
  #open = true;
  #closeInfo: { code: number; reason: string } | undefined;
  peer: MemoryDuplex | undefined;

  get isOpen(): boolean {
    return this.#open;
  }

  send(data: string): void {
    if (!this.#open || !this.peer) throw new ConnectionClosedError();
    const target = this.peer;
    queueMicrotask(() => target.deliver(data));
  }

  close(code = 1000, reason = ''): void {
    if (!this.#open) return;
    this.#shutdown(code, reason);
    if (this.peer) this.peer.#shutdown(code, reason);
  }

  attach(handlers: DuplexHandlers): void {
    if (this.#handlers) throw new Error('Duplex already has a receiver');
    this.#handlers = handlers;
    const buffered = this.#buffer;
    this.#buffer = [];
    for (const data of buffered) handlers.message(data);
    if (this.#closeInfo) {
      const { code, reason } = this.#closeInfo;
      queueMicrotask(() => handlers.close(code, reason));
    }
  }

  private deliver(data: string): void {
    if (!this.#open) return;
    if (this.#handlers) this.#handlers.message(data);
    else this.#buffer.push(data);
  }

  #shutdown(code: number, reason: string): void {
    if (!this.#open) return;
    this.#open = false;
    const handlers = this.#handlers;
    if (handlers) {
      // Deliver after any in-flight messages, which are also queued as microtasks.
      queueMicrotask(() => handlers.close(code, reason));
    } else {
      this.#closeInfo = { code, reason };
    }
  }
}

/**
 * Create two connected in-memory duplexes. Whatever one side sends, the other receives
 * asynchronously (on the microtask queue), preserving order. Closing either side closes both.
 */
export function createDuplexPair(): [Duplex, Duplex] {
  const a = new MemoryDuplex();
  const b = new MemoryDuplex();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
