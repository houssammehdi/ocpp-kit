/**
 * A small, dependency-free metrics registry with counters, gauges and histograms, rendered in the
 * Prometheus text exposition format (version 0.0.4). Use it on its own, or through
 * {@link instrumentCentralSystem}.
 */

/** Label values of one time series, keyed by label name. */
export type Labels = Readonly<Record<string, string>>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Upper bounds (seconds) of the default latency histogram buckets. */
export const DEFAULT_LATENCY_BUCKETS: readonly number[] = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** A sample value as Prometheus writes it. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function formatLabels(names: readonly string[], values: readonly string[], extra = ''): string {
  const pairs = names.map((name, i) => `${name}="${escapeLabelValue(values[i] ?? '')}"`);
  if (extra) pairs.push(extra);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

/** Split `(value)` / `(labels, value)` style arguments. */
function labelsAndValue(
  first: Labels | number | undefined,
  second: number | undefined,
): [Labels | undefined, number | undefined] {
  return typeof first === 'number' || first === undefined ? [undefined, first] : [first, second];
}

/** Common behaviour: a name, help text, label names and one series per label combination. */
abstract class Metric<Series> {
  readonly #series = new Map<string, { readonly values: readonly string[]; series: Series }>();

  constructor(
    /** Metric name, e.g. `ocpp_connections_total`. */
    readonly name: string,
    /** One-line description, written as `# HELP`. */
    readonly help: string,
    /** Names of the labels every series of this metric carries. */
    readonly labelNames: readonly string[] = [],
  ) {
    if (!METRIC_NAME.test(name)) throw new TypeError(`Invalid metric name "${name}"`);
    for (const label of labelNames) {
      if (!LABEL_NAME.test(label) || label.startsWith('__') || label === 'le') {
        throw new TypeError(`Invalid label name "${label}" for metric ${name}`);
      }
    }
  }

  /** The Prometheus metric type. */
  abstract readonly type: 'counter' | 'gauge' | 'histogram';

  protected abstract create(): Series;

  protected abstract lines(labels: readonly string[], series: Series): string[];

  protected series(labels: Labels = {}): Series {
    const extra = Object.keys(labels).filter((name) => !this.labelNames.includes(name));
    if (extra.length > 0) {
      throw new TypeError(`Unknown label(s) ${extra.join(', ')} for metric ${this.name}`);
    }
    const values = this.labelNames.map((name) => labels[name] ?? '');
    const key = JSON.stringify(values);
    let entry = this.#series.get(key);
    if (!entry) {
      entry = { values, series: this.create() };
      this.#series.set(key, entry);
    }
    return entry.series;
  }

  /** Remove every series. */
  reset(): void {
    this.#series.clear();
  }

  /** This metric in the text exposition format. */
  render(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.type}`,
    ];
    for (const { values, series } of this.#series.values())
      lines.push(...this.lines(values, series));
    return lines.join('\n');
  }
}

/** A value that only goes up, such as the number of calls answered. */
export class Counter extends Metric<{ value: number }> {
  readonly type = 'counter';

  protected create(): { value: number } {
    return { value: 0 };
  }

  protected lines(labels: readonly string[], series: { value: number }): string[] {
    return [`${this.name}${formatLabels(this.labelNames, labels)} ${formatValue(series.value)}`];
  }

  /** Add `amount` (default 1, never negative) to the series with `labels`. */
  inc(amount?: number): void;
  inc(labels: Labels, amount?: number): void;
  inc(first?: Labels | number, second?: number): void {
    const [labels, amount = 1] = labelsAndValue(first, second);
    if (!(amount >= 0)) throw new RangeError(`Counter ${this.name} cannot decrease`);
    this.series(labels).value += amount;
  }

  /** Current value of the series with these labels. */
  get(labels?: Labels): number {
    return this.series(labels).value;
  }
}

/** A value that goes up and down, such as the number of open connections. */
export class Gauge extends Metric<{ value: number }> {
  readonly type = 'gauge';

  protected create(): { value: number } {
    return { value: 0 };
  }

  protected lines(labels: readonly string[], series: { value: number }): string[] {
    return [`${this.name}${formatLabels(this.labelNames, labels)} ${formatValue(series.value)}`];
  }

  /** Set the series with `labels` to `value`. */
  set(value: number): void;
  set(labels: Labels, value: number): void;
  set(first: Labels | number, second?: number): void {
    const [labels, value = 0] = labelsAndValue(first, second);
    this.series(labels).value = value;
  }

  /** Add `amount` (default 1) to the series with `labels`. */
  inc(amount?: number): void;
  inc(labels: Labels, amount?: number): void;
  inc(first?: Labels | number, second?: number): void {
    const [labels, amount = 1] = labelsAndValue(first, second);
    this.series(labels).value += amount;
  }

  /** Subtract `amount` (default 1) from the series with `labels`. */
  dec(amount?: number): void;
  dec(labels: Labels, amount?: number): void;
  dec(first?: Labels | number, second?: number): void {
    const [labels, amount = 1] = labelsAndValue(first, second);
    this.series(labels).value -= amount;
  }

  /** Current value of the series with these labels. */
  get(labels?: Labels): number {
    return this.series(labels).value;
  }
}

interface HistogramSeries {
  readonly counts: number[];
  sum: number;
  count: number;
}

/** Observations sorted into cumulative buckets, such as call latencies. */
export class Histogram extends Metric<HistogramSeries> {
  readonly type = 'histogram';
  /** Bucket upper bounds, ascending; `+Inf` is implicit. */
  readonly buckets: readonly number[];

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_LATENCY_BUCKETS,
  ) {
    super(name, help, labelNames);
    const sorted = [...buckets].sort((a, b) => a - b);
    if (
      sorted.length === 0 ||
      sorted.some((bound, i) => !Number.isFinite(bound) || bound === sorted[i - 1])
    ) {
      throw new TypeError(`Histogram ${name} needs distinct, finite bucket bounds`);
    }
    this.buckets = sorted;
  }

  protected create(): HistogramSeries {
    return { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
  }

  protected lines(labels: readonly string[], series: HistogramSeries): string[] {
    const lines = this.buckets.map(
      (bound, i) =>
        `${this.name}_bucket${formatLabels(this.labelNames, labels, `le="${formatValue(bound)}"`)} ${series.counts[i] ?? 0}`,
    );
    lines.push(
      `${this.name}_bucket${formatLabels(this.labelNames, labels, 'le="+Inf"')} ${series.count}`,
      `${this.name}_sum${formatLabels(this.labelNames, labels)} ${formatValue(series.sum)}`,
      `${this.name}_count${formatLabels(this.labelNames, labels)} ${series.count}`,
    );
    return lines;
  }

  /** Record one observation in the series with `labels`. */
  observe(value: number): void;
  observe(labels: Labels, value: number): void;
  observe(first: Labels | number, second?: number): void {
    const [labels, value = 0] = labelsAndValue(first, second);
    const series = this.series(labels);
    series.count++;
    series.sum += value;
    // Buckets are cumulative: every bound at or above the value counts it.
    for (let i = this.buckets.length - 1; i >= 0 && value <= (this.buckets[i] ?? 0); i--) {
      series.counts[i] = (series.counts[i] ?? 0) + 1;
    }
  }

  /** Count, sum and cumulative bucket counts of the series with these labels. */
  get(labels?: Labels): {
    readonly count: number;
    readonly sum: number;
    readonly buckets: readonly number[];
  } {
    const { count, sum, counts } = this.series(labels);
    return { count, sum, buckets: [...counts] };
  }
}

/** A set of metrics rendered together, e.g. behind a `/metrics` endpoint. */
export class MetricsRegistry {
  readonly #metrics = new Map<string, Counter | Gauge | Histogram>();

  /** Create (or return the existing) counter `name`. */
  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.#register(name, Counter, () => new Counter(name, help, labelNames));
  }

  /** Create (or return the existing) gauge `name`. */
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.#register(name, Gauge, () => new Gauge(name, help, labelNames));
  }

  /** Create (or return the existing) histogram `name`. */
  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets?: readonly number[],
  ): Histogram {
    return this.#register(name, Histogram, () => new Histogram(name, help, labelNames, buckets));
  }

  /** The metric registered as `name`, if any. */
  get(name: string): Counter | Gauge | Histogram | undefined {
    return this.#metrics.get(name);
  }

  /**
   * Every metric in the Prometheus text exposition format (serve it with the content type
   * {@link PROMETHEUS_CONTENT_TYPE}).
   */
  render(): string {
    return `${[...this.#metrics.values()].map((metric) => metric.render()).join('\n')}\n`;
  }

  #register<M extends Counter | Gauge | Histogram>(
    name: string,
    kind: abstract new (...args: never[]) => M,
    create: () => M,
  ): M {
    const existing = this.#metrics.get(name);
    if (existing) {
      if (!(existing instanceof kind)) {
        throw new TypeError(`Metric ${name} is already registered as a ${existing.type}`);
      }
      return existing;
    }
    const metric = create();
    this.#metrics.set(name, metric);
    return metric;
  }
}

/** Content type of the Prometheus text exposition format. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
