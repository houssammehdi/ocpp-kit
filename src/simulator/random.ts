/**
 * Small, fast, seedable PRNG (mulberry32). Not cryptographically secure; it exists so a simulated
 * fleet behaves identically for the same seed.
 */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Uniform float in `[0, 1)`. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Uniform float in `[min, max)`. */
  float(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in `[min, max]` (inclusive). */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  /** `true` with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly chosen element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new RangeError('Cannot pick from an empty array');
    return item;
  }
}

/** Derive an independent 32-bit seed from a base seed and a label (FNV-1a over both). */
export function deriveSeed(seed: number, label: string | number): number {
  let hash = 0x811c9dc5 ^ (seed >>> 0);
  for (const char of `${label}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
