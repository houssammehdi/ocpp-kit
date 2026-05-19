import { describe, expect, it, vi } from 'vitest';
import { ConnectionClosedError, createDuplexPair } from '../../src/rpc/index.js';
import { flush } from '../helpers.js';

describe('in-memory duplex pair', () => {
  it('delivers asynchronously and in order, buffering until a receiver attaches', async () => {
    const [a, b] = createDuplexPair();
    a.send('one');
    a.send('two');
    await flush();
    const message = vi.fn();
    b.attach({ message, close: vi.fn() });
    expect(message.mock.calls).toEqual([['one'], ['two']]);
    a.send('three');
    expect(message).toHaveBeenCalledTimes(2);
    await flush();
    expect(message).toHaveBeenLastCalledWith('three');
  });

  it('closes both ends, reports the close even to late receivers and refuses sends', async () => {
    const [a, b] = createDuplexPair();
    const closeA = vi.fn();
    a.attach({ message: vi.fn(), close: closeA });
    a.close(4001, 'bye');
    a.close(1000, 'ignored');
    expect(a.isOpen).toBe(false);
    expect(b.isOpen).toBe(false);
    await flush();
    expect(closeA).toHaveBeenCalledExactlyOnceWith(4001, 'bye');
    const closeB = vi.fn();
    b.attach({ message: vi.fn(), close: closeB });
    await flush();
    expect(closeB).toHaveBeenCalledWith(4001, 'bye');
    expect(() => a.send('x')).toThrow(ConnectionClosedError);
  });

  it('allows exactly one receiver', () => {
    const [a] = createDuplexPair();
    a.attach({ message: vi.fn(), close: vi.fn() });
    expect(() => a.attach({ message: vi.fn(), close: vi.fn() })).toThrow(/receiver/);
  });
});
