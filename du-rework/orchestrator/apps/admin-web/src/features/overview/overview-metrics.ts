import type { BusinessRow, OperationWire } from '@/lib/api';

export type MonitorTimeframe = 'minute' | 'hour' | 'day' | 'week' | 'month';

export interface TimeBucket {
  key: string;
  label: string;
  subLabel?: string;
  startTime: number;
  endTime: number;
  totalRequests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  running: number;
  durations: number[];
  avgDurationMs: number | null;
}

export interface OperationsTelemetry {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  cancelled: number;
  timedOut: number;
  successRate: string;
  avgDurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
  recentItems: OperationWire[];
}

export interface WorkerTelemetry {
  businessId: string;
  version: string;
  status: string;
  isActive: boolean;
  queue: string;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  successRate: string;
  avgDurationMs: number | null;
}

export function getOperationDurationMs(op: OperationWire): number | null {
  if (!op.completedAt) return null;
  const start = op.startedAt || op.createdAt;
  if (!start) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(op.completedAt).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function computeTimeBuckets(
  operations: OperationWire[],
  timeframe: MonitorTimeframe,
  nowMs = Date.now(),
): TimeBucket[] {
  const buckets: TimeBucket[] = [];

  if (timeframe === 'minute') {
    // 12 buckets x 5 minutes (last 60 mins)
    const bucketDuration = 5 * 60 * 1000;
    for (let i = 11; i >= 0; i--) {
      const start = nowMs - (i + 1) * bucketDuration;
      const end = nowMs - i * bucketDuration;
      const d = new Date(start);
      buckets.push({
        key: `m-${i}`,
        label: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        subLabel: `5 mins`,
        startTime: start,
        endTime: end,
        totalRequests: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        running: 0,
        durations: [],
        avgDurationMs: null,
      });
    }
  } else if (timeframe === 'hour') {
    // 24 buckets x 1 hour (last 24 hours)
    const bucketDuration = 60 * 60 * 1000;
    for (let i = 23; i >= 0; i--) {
      const start = nowMs - (i + 1) * bucketDuration;
      const end = nowMs - i * bucketDuration;
      const d = new Date(start);
      buckets.push({
        key: `h-${i}`,
        label: `${pad(d.getHours())}:00`,
        subLabel: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`,
        startTime: start,
        endTime: end,
        totalRequests: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        running: 0,
        durations: [],
        avgDurationMs: null,
      });
    }
  } else if (timeframe === 'day') {
    // 7 buckets x 24 hours (last 7 days)
    const bucketDuration = 24 * 60 * 60 * 1000;
    for (let i = 6; i >= 0; i--) {
      const start = nowMs - (i + 1) * bucketDuration;
      const end = nowMs - i * bucketDuration;
      const d = new Date(start);
      buckets.push({
        key: `d-${i}`,
        label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`,
        subLabel: ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][d.getDay()],
        startTime: start,
        endTime: end,
        totalRequests: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        running: 0,
        durations: [],
        avgDurationMs: null,
      });
    }
  } else if (timeframe === 'week') {
    // 4 buckets x 7 days (last 4 weeks)
    const bucketDuration = 7 * 24 * 60 * 60 * 1000;
    for (let i = 3; i >= 0; i--) {
      const start = nowMs - (i + 1) * bucketDuration;
      const end = nowMs - i * bucketDuration;
      const d = new Date(start);
      buckets.push({
        key: `w-${i}`,
        label: `W-${4 - i}`,
        subLabel: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`,
        startTime: start,
        endTime: end,
        totalRequests: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        running: 0,
        durations: [],
        avgDurationMs: null,
      });
    }
  } else {
    // 6 buckets x 30 days (last 6 months)
    const bucketDuration = 30 * 24 * 60 * 60 * 1000;
    for (let i = 5; i >= 0; i--) {
      const start = nowMs - (i + 1) * bucketDuration;
      const end = nowMs - i * bucketDuration;
      const d = new Date(start);
      buckets.push({
        key: `mo-${i}`,
        label: `Thg ${d.getMonth() + 1}`,
        subLabel: `${d.getFullYear()}`,
        startTime: start,
        endTime: end,
        totalRequests: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        running: 0,
        durations: [],
        avgDurationMs: null,
      });
    }
  }

  // Populate buckets with operation records
  for (const op of operations) {
    const rawTime = op.createdAt || op.startedAt;
    if (!rawTime) continue;
    const timeMs = new Date(rawTime).getTime();
    if (Number.isNaN(timeMs)) continue;

    for (const bucket of buckets) {
      if (timeMs >= bucket.startTime && timeMs < bucket.endTime) {
        bucket.totalRequests += 1;
        if (op.state === 'SUCCEEDED') bucket.succeeded += 1;
        else if (op.state === 'FAILED') bucket.failed += 1;
        else if (op.state === 'CANCELLED') bucket.cancelled += 1;
        else if (op.state === 'TIMED_OUT') bucket.timedOut += 1;
        else bucket.running += 1;

        const dur = getOperationDurationMs(op);
        if (dur !== null) bucket.durations.push(dur);
        break;
      }
    }
  }

  // Calculate average duration per bucket
  for (const bucket of buckets) {
    if (bucket.durations.length > 0) {
      const sum = bucket.durations.reduce((acc, d) => acc + d, 0);
      bucket.avgDurationMs = Math.round(sum / bucket.durations.length);
    }
  }

  return buckets;
}

export function computeOperationsTelemetry(operations: OperationWire[]): OperationsTelemetry {
  const total = operations.length;
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  let cancelled = 0;
  let timedOut = 0;
  const durations: number[] = [];

  for (const op of operations) {
    if (op.state === 'SUCCEEDED') succeeded += 1;
    else if (op.state === 'FAILED') failed += 1;
    else if (op.state === 'CANCELLED') cancelled += 1;
    else if (op.state === 'TIMED_OUT') timedOut += 1;
    else running += 1;

    const dur = getOperationDurationMs(op);
    if (dur !== null) durations.push(dur);
  }

  const successRate = total > 0 ? ((succeeded / total) * 100).toFixed(1) : '0';
  const avgDurationMs =
    durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const minDurationMs = durations.length > 0 ? Math.min(...durations) : null;
  const maxDurationMs = durations.length > 0 ? Math.max(...durations) : null;

  return {
    total,
    succeeded,
    failed,
    running,
    cancelled,
    timedOut,
    successRate,
    avgDurationMs,
    minDurationMs,
    maxDurationMs,
    recentItems: operations.slice(0, 8),
  };
}

export function computeWorkerTelemetry(
  businesses: BusinessRow[],
  operations: OperationWire[],
): WorkerTelemetry[] {
  return businesses.map((b) => {
    const businessOps = operations.filter((op) => op.businessId === b.businessId);
    const processedCount = businessOps.length;
    const succeededCount = businessOps.filter((op) => op.state === 'SUCCEEDED').length;
    const failedCount = businessOps.filter((op) => op.state === 'FAILED').length;
    const successRate =
      processedCount > 0 ? ((succeededCount / processedCount) * 100).toFixed(1) + '%' : '100%';

    const durations = businessOps
      .map(getOperationDurationMs)
      .filter((d): d is number => d !== null);
    const avgDurationMs =
      durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

    const version = b.activeVersion || b.version || '1.0.0';
    const queue = `du-business-${b.businessId}-${version}`;

    return {
      businessId: b.businessId,
      version,
      status: b.status || 'ENABLED',
      isActive: b.status === 'ENABLED',
      queue,
      processedCount,
      succeededCount,
      failedCount,
      successRate,
      avgDurationMs,
    };
  });
}
