import { CentralSystemToChargePoint, ChargePointToCentralSystem } from '../src/messages/index.js';
import type { ConnectRequest, Connector } from '../src/client/index.js';
import {
  createDuplexPair,
  HandlerRegistry,
  RpcPeer,
  type Duplex,
  type JsonObject,
  type RpcPeerOptions,
} from '../src/rpc/index.js';

export type CpPeer = RpcPeer<typeof CentralSystemToChargePoint, typeof ChargePointToCentralSystem>;
export type CsPeer = RpcPeer<typeof ChargePointToCentralSystem, typeof CentralSystemToChargePoint>;

type ExtraOptions = Partial<
  Omit<
    RpcPeerOptions<typeof CentralSystemToChargePoint, typeof ChargePointToCentralSystem, object>,
    'inbound' | 'outbound' | 'handlers'
  >
>;

/** A charge-point peer and a central-system peer connected in memory. */
export function peerPair(
  cpOptions: ExtraOptions = {},
  csOptions: ExtraOptions = {},
): { cp: CpPeer; cs: CsPeer } {
  const [a, b] = createDuplexPair();
  const cp: CpPeer = new RpcPeer(a, {
    inbound: CentralSystemToChargePoint,
    outbound: ChargePointToCentralSystem,
    ...cpOptions,
  });
  const cs: CsPeer = new RpcPeer(b, {
    inbound: ChargePointToCentralSystem,
    outbound: CentralSystemToChargePoint,
    ...csOptions,
  });
  return { cp, cs };
}

/** A peer whose remote end is driven by raw strings, to exercise the wire format directly. */
export function rawPair(options: ExtraOptions = {}): {
  cs: CsPeer;
  remote: Duplex;
  received: string[];
  next: () => Promise<unknown[]>;
} {
  const [a, b] = createDuplexPair();
  const received: string[] = [];
  const waiters: ((frame: unknown[]) => void)[] = [];
  a.attach({
    message: (data) => {
      const waiter = waiters.shift();
      if (waiter) waiter(JSON.parse(data) as unknown[]);
      else received.push(data);
    },
    close: () => undefined,
  });
  const cs: CsPeer = new RpcPeer(b, {
    inbound: ChargePointToCentralSystem,
    outbound: CentralSystemToChargePoint,
    ...options,
  });
  const next = (): Promise<unknown[]> => {
    const buffered = received.shift();
    if (buffered !== undefined) return Promise.resolve(JSON.parse(buffered) as unknown[]);
    return new Promise((resolve) => waiters.push(resolve));
  };
  return { cs, remote: a, received, next };
}

/** Flush pending microtasks (in-memory duplex delivery) a few times. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

export const NOW = '2026-03-01T10:00:00.000Z';

interface HasEvents {
  readonly eventTypes?: object;
}
type EventsOf<T extends HasEvents> = NonNullable<T['eventTypes']>;
type Args<F> = F extends (...args: infer A) => void ? A : never;

/** Resolve with the arguments of the next `event` emitted by a typed emitter. */
export function nextEvent<T extends HasEvents, K extends keyof EventsOf<T> & string>(
  emitter: T,
  event: K,
  timeoutMs = 5_000,
): Promise<Args<EventsOf<T>[K]>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    const target = emitter as unknown as {
      once(event: string, listener: (...args: unknown[]) => void): void;
    };
    target.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args as Args<EventsOf<T>[K]>);
    });
  });
}

/** Poll `predicate` until it holds. */
export async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** A recorded inbound call on the fake Central System. */
export interface RecordedCall {
  readonly action: string;
  readonly request: JsonObject;
  readonly response?: JsonObject;
}

/** An in-memory Central System that clients reach through an injected {@link Connector}. */
export class FakeCentralSystem {
  readonly handlers = new HandlerRegistry<typeof ChargePointToCentralSystem>();
  readonly peers: CsPeer[] = [];
  readonly requests: ConnectRequest[] = [];
  readonly calls: RecordedCall[] = [];
  available = true;

  readonly connector: Connector = (request) => {
    this.requests.push(request);
    if (!this.available) return Promise.reject(new Error('connection refused'));
    const [clientSide, serverSide] = createDuplexPair();
    const peer: CsPeer = new RpcPeer(serverSide, {
      inbound: ChargePointToCentralSystem,
      outbound: CentralSystemToChargePoint,
      handlers: this.handlers,
    });
    peer.on('callHandled', (event) => {
      this.calls.push({
        action: event.action,
        request: event.request,
        ...(event.response ? { response: event.response } : {}),
      });
    });
    this.peers.push(peer);
    return Promise.resolve(clientSide);
  };

  /** Action names received so far, in order. */
  get received(): string[] {
    return this.calls.map((call) => call.action);
  }

  /** Requests received for one action. */
  requestsOf(action: string): JsonObject[] {
    return this.calls.filter((call) => call.action === action).map((call) => call.request);
  }

  get current(): CsPeer | undefined {
    return this.peers.at(-1);
  }

  drop(): Promise<void> {
    return this.current?.close(1006, 'network down') ?? Promise.resolve();
  }
}
