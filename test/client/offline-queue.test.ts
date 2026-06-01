import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileQueueStore,
  MemoryQueueStore,
  OfflineQueue,
  OfflineQueueFullError,
} from '../../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const meter = (n: number) => ({
  connectorId: 1,
  meterValue: [{ timestamp: 'x', sampledValue: [{ value: String(n) }] }],
});

describe('OfflineQueue', () => {
  it('delivers in FIFO order with increasing sequence numbers', async () => {
    const queue = new OfflineQueue();
    await queue.init();
    await queue.push('StartTransaction', { n: 1 });
    await queue.push('MeterValues', { n: 2 });
    await queue.push('StopTransaction', { n: 3 });
    expect(queue.list().map((m) => [m.seq, m.action])).toEqual([
      [1, 'StartTransaction'],
      [2, 'MeterValues'],
      [3, 'StopTransaction'],
    ]);
    expect(queue.peek()?.seq).toBe(1);
    await queue.remove(1);
    expect(queue.peek()?.seq).toBe(2);
    expect(queue.size).toBe(2);
  });

  it('evicts the oldest MeterValues when full, never transaction boundaries', async () => {
    const queue = new OfflineQueue(new MemoryQueueStore(), 3);
    await queue.push('StartTransaction', {});
    await queue.push('MeterValues', meter(1));
    await queue.push('MeterValues', meter(2));
    const { evicted } = await queue.push('StopTransaction', {});
    expect(evicted?.payload).toEqual(meter(1));
    expect(queue.list().map((m) => m.action)).toEqual([
      'StartTransaction',
      'MeterValues',
      'StopTransaction',
    ]);
    await queue.push('StartTransaction', {});
    await expect(queue.push('StopTransaction', {})).rejects.toBeInstanceOf(OfflineQueueFullError);
  });

  it('persists to disk atomically and resumes sequence numbers after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-kit-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'queue.json');
    const first = new OfflineQueue(new FileQueueStore(path));
    await first.init();
    await Promise.all([
      first.push('StartTransaction', { idTag: 'A' }),
      first.push('MeterValues', meter(1)),
      first.push('StopTransaction', { meterStop: 10 }),
    ]);
    await first.remove(2);
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(2);

    const second = new OfflineQueue(new FileQueueStore(path));
    await second.init();
    expect(second.list().map((m) => m.seq)).toEqual([1, 3]);
    const { message } = await second.push('MeterValues', meter(2));
    expect(message.seq).toBe(4);
  });

  it('restores very large persisted queues', async () => {
    // Regression: Math.max(...seqs) threw a RangeError for a few hundred thousand messages.
    const store = new MemoryQueueStore();
    const count = 250_000;
    await store.save(
      Array.from({ length: count }, (_, i) => ({
        seq: i + 1,
        action: 'MeterValues' as const,
        payload: {},
        enqueuedAt: 'x',
      })),
    );
    const queue = new OfflineQueue(store, count + 1);
    await queue.init();
    expect(queue.size).toBe(count);
    const { message } = await queue.push('StopTransaction', {});
    expect(message.seq).toBe(count + 1);
  });

  it('treats a missing file as empty and rejects corrupt files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-kit-'));
    dirs.push(dir);
    await expect(new FileQueueStore(join(dir, 'none.json')).load()).resolves.toEqual([]);
    const path = join(dir, 'bad.json');
    await writeFile(path, '{"not":"an array"}');
    await expect(new FileQueueStore(path).load()).rejects.toThrow(/Corrupt/);
  });
});
