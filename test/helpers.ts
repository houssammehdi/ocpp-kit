import { CentralSystemToChargePoint, ChargePointToCentralSystem } from '../src/messages/index.js';
import { createDuplexPair, RpcPeer, type Duplex, type RpcPeerOptions } from '../src/rpc/index.js';

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
