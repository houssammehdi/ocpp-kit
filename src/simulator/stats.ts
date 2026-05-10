/** Percentile summary of recorded latencies, in milliseconds. */
export interface LatencySummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/**
 * Records call round-trip times in a bounded ring buffer and reports percentiles over the most
 * recent `capacity` samples.
 */
export class LatencyTracker {
  readonly #samples: Float64Array;
  #next = 0;
  #size = 0;
  #total = 0;

  constructor(readonly capacity = 10_000) {
    this.#samples = new Float64Array(capacity);
  }

  /** Total number of samples ever recorded. */
  get total(): number {
    return this.#total;
  }

  /** Record one latency sample. */
  record(ms: number): void {
    this.#samples[this.#next] = ms;
    this.#next = (this.#next + 1) % this.capacity;
    this.#size = Math.min(this.#size + 1, this.capacity);
    this.#total++;
  }

  /** Nearest-rank percentiles over the retained samples. */
  summary(): LatencySummary {
    if (this.#size === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = this.#samples.slice(0, this.#size).sort();
    const rank = (p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
    return {
      count: this.#size,
      p50: rank(0.5),
      p95: rank(0.95),
      p99: rank(0.99),
      max: sorted[sorted.length - 1] ?? 0,
    };
  }
}
