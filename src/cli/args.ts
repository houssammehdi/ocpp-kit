/** Error raised for invalid command line input; the CLI prints it without a stack trace. */
export class UsageError extends Error {
  override name = 'UsageError';
}

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a duration such as `250ms`, `30s`, `5m`, `1h` or a bare number of seconds.
 *
 * @returns milliseconds
 */
export function parseDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(input.trim());
  if (!match?.[1]) throw new UsageError(`Invalid duration "${input}" (try 30s, 5m, 1h)`);
  const unit = (match[2] ?? 's').toLowerCase();
  return Math.round(Number(match[1]) * (DURATION_UNITS[unit] ?? 1_000));
}

/**
 * Parse a rate such as `5/s`, `120/m`, `1000/h` or a bare number (per second).
 *
 * @returns events per second
 */
export function parseRate(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(?:\/\s*(s|sec|m|min|h))?$/i.exec(input.trim());
  if (!match?.[1]) throw new UsageError(`Invalid rate "${input}" (try 5/s or 300/m)`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const perSecond = unit.startsWith('m') ? value / 60 : unit === 'h' ? value / 3_600 : value;
  if (!(perSecond > 0)) throw new UsageError(`Rate must be positive, got "${input}"`);
  return perSecond;
}

/** Parse a range such as `30-300` or `30s-5m`. @returns `[min, max]` in seconds. */
export function parseRangeSeconds(input: string): [number, number] {
  const parts = input.split('-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UsageError(`Invalid range "${input}" (try 30-300 or 30s-5m)`);
  }
  const min = parseDuration(parts[0]) / 1_000;
  const max = parseDuration(parts[1]) / 1_000;
  if (min > max) throw new UsageError(`Range "${input}" has min > max`);
  return [min, max];
}

/** Parse a positive integer option. */
export function parseInteger(input: string, name: string, min = 1): number {
  if (!/^\d+$/.test(input.trim()))
    throw new UsageError(`--${name} must be an integer, got "${input}"`);
  const value = Number(input);
  if (value < min) throw new UsageError(`--${name} must be at least ${min}`);
  return value;
}

/** Parse a WebSocket URL. */
export function parseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UsageError(`Invalid URL "${input}"`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new UsageError(`URL must use ws:// or wss://, got "${input}"`);
  }
  return input;
}
