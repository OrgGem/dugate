// VENDORED from @du/observability @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/observability/src/metrics.ts (lines=203) sha256=8E75BB7B20EB6D2812A3F71244665439622D98072430FE1BAB094B338D10CF2E
// why: createLogger for src/main.ts

/**
 * Bounded metrics interfaces (docs 12): counters/gauges/histograms with
 * low-cardinality labels only. operationId/taskId must NEVER be metric
 * labels (unbounded cardinality).
 */

export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface Counter {
  inc(labels?: MetricLabels, value?: number): void;
}

export interface Gauge {
  set(value: number, labels?: MetricLabels): void;
  inc(labels?: MetricLabels, value?: number): void;
  dec(labels?: MetricLabels, value?: number): void;
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
}

export interface MetricsRegistry {
  counter(name: string, help?: string): Counter;
  gauge(name: string, help?: string): Gauge;
  histogram(name: string, help?: string, buckets?: number[]): Histogram;
  /** Snapshot for tests/diagnostics. */
  snapshot(): MetricSnapshot[];
}

export interface MetricSnapshot {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  labels: MetricLabels;
  value: number;
  /** histogram only */
  buckets?: { le: number; count: number }[];
  count?: number;
  sum?: number;
}

const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_LABEL_KEYS = 8;

function assertLabels(labels: MetricLabels | undefined): void {
  if (!labels) return;
  const keys = Object.keys(labels);
  if (keys.length > MAX_LABEL_KEYS) {
    throw new Error(`metric labels exceed ${MAX_LABEL_KEYS} keys (bounded cardinality)`);
  }
  for (const forbidden of ['operationId', 'taskId', 'invocationId', 'artifactId', 'userId', 'apiKeyId']) {
    if (keys.includes(forbidden)) {
      throw new Error(`metric label "${forbidden}" is unbounded cardinality and forbidden`);
    }
  }
}

class InMemoryCounter implements Counter {
  constructor(
    private readonly store: Map<string, number>,
    private readonly name: string
  ) {}
  inc(labels: MetricLabels = {}, value = 1): void {
    assertLabels(labels);
    if (value < 0) throw new Error('counter inc must be >= 0');
    const key = JSON.stringify([this.name, labels]);
    this.store.set(key, (this.store.get(key) ?? 0) + value);
  }
}

class InMemoryGauge implements Gauge {
  constructor(
    private readonly store: Map<string, number>,
    private readonly name: string
  ) {}
  private key(labels: MetricLabels): string {
    return JSON.stringify([this.name, labels]);
  }
  set(value: number, labels: MetricLabels = {}): void {
    assertLabels(labels);
    this.store.set(this.key(labels), value);
  }
  inc(labels: MetricLabels = {}, value = 1): void {
    assertLabels(labels);
    const k = this.key(labels);
    this.store.set(k, (this.store.get(k) ?? 0) + value);
  }
  dec(labels: MetricLabels = {}, value = 1): void {
    this.inc(labels, -value);
  }
}

const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

class InMemoryHistogram implements Histogram {
  private readonly observations = new Map<string, { labels: MetricLabels; values: number[] }>();
  constructor(
    private readonly name: string,
    private readonly buckets: number[]
  ) {}
  observe(value: number, labels: MetricLabels = {}): void {
    assertLabels(labels);
    const key = JSON.stringify(labels);
    const entry = this.observations.get(key) ?? { labels, values: [] };
    entry.values.push(value);
    this.observations.set(key, entry);
  }
  snapshot(): MetricSnapshot[] {
    const out: MetricSnapshot[] = [];
    for (const { labels, values } of this.observations.values()) {
      const sorted = [...values].sort((a, b) => a - b);
      out.push({
        name: this.name,
        type: 'histogram',
        labels,
        value: sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0,
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        buckets: this.buckets.map((le) => ({ le, count: values.filter((v) => v <= le).length })),
      });
    }
    return out;
  }
}

export class InMemoryMetricsRegistry implements MetricsRegistry {
  private readonly counters = new Map<string, InMemoryCounter>();
  private readonly gauges = new Map<string, InMemoryGauge>();
  private readonly histograms = new Map<string, InMemoryHistogram>();
  private readonly counterStore = new Map<string, number>();
  private readonly gaugeStore = new Map<string, number>();

  counter(name: string): Counter {
    this.assertName(name);
    let c = this.counters.get(name);
    if (!c) {
      c = new InMemoryCounter(this.counterStore, name);
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string): Gauge {
    this.assertName(name);
    let g = this.gauges.get(name);
    if (!g) {
      g = new InMemoryGauge(this.gaugeStore, name);
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, _help?: string, buckets: number[] = DEFAULT_BUCKETS_MS): Histogram {
    this.assertName(name);
    let h = this.histograms.get(name);
    if (!h) {
      h = new InMemoryHistogram(name, buckets);
      this.histograms.set(name, h);
    }
    return h;
  }

  snapshot(): MetricSnapshot[] {
    const out: MetricSnapshot[] = [];
    for (const [key, value] of this.counterStore) {
      const [name, labels] = JSON.parse(key) as [string, MetricLabels];
      out.push({ name, type: 'counter', labels, value });
    }
    for (const [key, value] of this.gaugeStore) {
      const [name, labels] = JSON.parse(key) as [string, MetricLabels];
      out.push({ name, type: 'gauge', labels, value });
    }
    for (const h of this.histograms.values()) {
      out.push(...h.snapshot());
    }
    return out;
  }

  private assertName(name: string): void {
    if (!METRIC_NAME_PATTERN.test(name)) {
      throw new Error(`invalid metric name "${name}" (snake_case required)`);
    }
  }
}

/** Platform metric names (docs 12). */
export const METRIC_NAMES = {
  submissionLatency: 'du_submission_latency_ms',
  queueOldestAge: 'du_queue_oldest_age_ms',
  outboxAge: 'du_outbox_age_ms',
  activeLeases: 'du_active_leases',
  expiredLeases: 'du_expired_leases_total',
  retries: 'du_task_retries_total',
  invocationFailed: 'du_invocation_failed_total',
  invocationUnknown: 'du_invocation_unknown_total',
  providerLatency: 'du_provider_latency_ms',
  providerRateLimited: 'du_provider_rate_limited_total',
  providerInFlight: 'du_provider_in_flight',
  artifactOrphans: 'du_artifact_orphans',
  usageLag: 'du_usage_lag_ms',
  webhookLag: 'du_webhook_lag_ms',
  capacityRejected: 'du_capacity_rejected_total',
} as const;