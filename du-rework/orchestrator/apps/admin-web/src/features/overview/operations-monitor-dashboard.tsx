import { useState } from 'react';
import { Link } from 'react-router';
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  RefreshCw,
  Server,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  AdminHealthSnapshot,
  OperationWire,
  WorkerInstanceList,
} from '@/lib/api';
import {
  computeOperationsTelemetry,
  computeTimeBuckets,
  computeWorkerTelemetry,
  formatDurationMs,
  type MonitorTimeframe,
  type TimeBucket,
} from './overview-metrics';
import type { OperationsMetricsSnapshot } from './state';

interface OperationsMonitorDashboardProps {
  operations: OperationWire[];
  operationMetrics: OperationsMetricsSnapshot | null;
  operationMetricsFailed: boolean;
  workerInstances: WorkerInstanceList | null;
  workerInventoryFailed: boolean;
  health: AdminHealthSnapshot | null;
  onRefresh: () => void;
  isLoading?: boolean;
}

export function OperationsMonitorDashboard({
  operations,
  operationMetrics,
  operationMetricsFailed,
  workerInstances,
  workerInventoryFailed,
  health,
  onRefresh,
  isLoading,
}: OperationsMonitorDashboardProps) {
  const [timeframe, setTimeframe] = useState<MonitorTimeframe>('hour');
  const [hoveredBucket, setHoveredBucket] = useState<TimeBucket | null>(null);

  const recentTelemetry = computeOperationsTelemetry(operations);
  const telemetry = {
    ...recentTelemetry,
    total: operationMetrics?.total ?? 0,
    succeeded: operationMetrics?.success ?? 0,
    failed: operationMetrics?.failure ?? 0,
    running: operationMetrics?.running ?? 0,
    cancelled: operationMetrics?.cancelled ?? 0,
    timedOut: operationMetrics?.timedOut ?? 0,
    successRate: operationMetrics && operationMetrics.total > 0
      ? ((operationMetrics.success / operationMetrics.total) * 100).toFixed(1)
      : '0',
  };
  const metricCount = (value: number): string => operationMetrics ? value.toLocaleString() : '—';
  const workerList = computeWorkerTelemetry(workerInstances?.items ?? []);
  const queueIntegrityState = health?.queueIntegrity?.state ?? null;
  const queueIntegrityDotClass = queueIntegrityState === 'OK'
    ? 'bg-emerald-500'
    : queueIntegrityState === 'RECONSTRUCTING'
      ? 'bg-amber-500'
      : queueIntegrityState === 'SUSPECT'
        ? 'bg-red-500'
        : 'bg-gray-400';
  const buckets = computeTimeBuckets(operations, timeframe);

  const maxRequestsInBuckets = Math.max(1, ...buckets.map((b) => b.totalRequests));

  const timeframeLabels: Record<MonitorTimeframe, { label: string; desc: string }> = {
    minute: { label: 'Minute', desc: 'Last 60 minutes (about 5 minutes per bucket)' },
    hour: { label: 'Hour', desc: 'Last 24 hours (about 1 hour per bucket)' },
    day: { label: 'Day', desc: 'Last 7 days (about 1 day per bucket)' },
    week: { label: 'Week', desc: 'Last 4 weeks (about 1 week per bucket)' },
    month: { label: 'Month', desc: 'Last 6 months (about 1 month per bucket)' },
  };

  return (
    <div className="flex flex-col gap-5">
      {/* 1. TOP METRIC CARDS (KPIs) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Operations */}
        <Card className="border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <CardContent className="p-4 flex flex-col justify-between h-full">
            <div className="flex items-center justify-between text-[var(--text-sub)]">
              <span className="text-xs font-semibold uppercase tracking-wider">Total Operations</span>
              <Activity className="w-4 h-4 text-[var(--cf-blue)]" />
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-[var(--text-main)]">{metricCount(telemetry.total)}</span>
              <Badge variant="info" className="text-xs">
                {operationMetrics
                  ? `${telemetry.running.toLocaleString()} running`
                  : operationMetricsFailed ? 'Metrics unavailable' : 'Loading metrics'}
              </Badge>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-[var(--text-sub)]">
              <span className="text-green-600 font-medium">✓ {metricCount(telemetry.succeeded)} succeeded</span>
              <span>·</span>
              <span className="text-red-600 font-medium">✗ {metricCount(telemetry.failed)} errors</span>
            </div>
          </CardContent>
        </Card>

        {/* Success Rate */}
        <Card className="border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <CardContent className="p-4 flex flex-col justify-between h-full">
            <div className="flex items-center justify-between text-[var(--text-sub)]">
              <span className="text-xs font-semibold uppercase tracking-wider">Success rate</span>
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-[var(--text-main)]">
                {operationMetrics ? `${telemetry.successRate}%` : '—'}
              </span>
              <Badge
                variant={!operationMetrics ? 'neutral' : Number(telemetry.successRate) >= 95 ? 'success' : Number(telemetry.successRate) >= 80 ? 'warning' : 'danger'}
                className="text-xs"
              >
                {!operationMetrics ? 'Unavailable' : Number(telemetry.successRate) >= 95 ? 'Good' : 'Needs attention'}
              </Badge>
            </div>
            <div className="mt-2 text-xs text-[var(--text-sub)]">
              {operationMetrics
                ? `${telemetry.cancelled.toLocaleString()} cancelled · ${telemetry.timedOut.toLocaleString()} timed out`
                : 'Waiting for server aggregation'}
            </div>
          </CardContent>
        </Card>

        {/* Processing Duration / Latency */}
        <Card className="border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <CardContent className="p-4 flex flex-col justify-between h-full">
            <div className="flex items-center justify-between text-[var(--text-sub)]">
              <span className="text-xs font-semibold uppercase tracking-wider">Processing time p50 / p95</span>
              <Clock className="w-4 h-4 text-amber-500" />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-[var(--text-sub)]">p50</div>
                <div className="text-xl font-bold text-[var(--text-main)]">
                  {formatDurationMs(operationMetrics?.p50Ms ?? null)}
                </div>
              </div>
              <div>
                <div className="text-xs text-[var(--text-sub)]">p95</div>
                <div className="text-xl font-bold text-[var(--text-main)]">
                  {formatDurationMs(operationMetrics?.p95Ms ?? null)}
                </div>
              </div>
            </div>
            <div className="mt-2 text-xs text-[var(--text-sub)]">
              {operationMetrics
                ? `${operationMetrics.durationSamples.toLocaleString()} operations with recorded execution times`
                : 'Server latency metrics unavailable'}
            </div>
          </CardContent>
        </Card>

        {/* Workers & Cluster Health */}
        <Card className="border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <CardContent className="p-4 flex flex-col justify-between h-full">
            <div className="flex items-center justify-between text-[var(--text-sub)]">
              <span className="text-xs font-semibold uppercase tracking-wider">Workers & Infrastructure</span>
              <Cpu className="w-4 h-4 text-purple-500" />
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-[var(--text-main)]">
                {workerList.length} Workers
              </span>
              <Badge variant={health?.status === 'ok' ? 'success' : 'warning'} className="text-xs">
                {health?.status === 'ok' ? 'Cluster OK' : 'Degraded'}
              </Badge>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-[var(--text-sub)]">
              <span className={health?.db ? 'text-green-600' : 'text-red-500'}>DB: {health?.db ? 'OK' : 'Error'}</span>
              <span>·</span>
              <span className={health?.redis ? 'text-green-600' : 'text-red-500'}>Redis: {health?.redis ? 'OK' : 'Error'}</span>
              <span>·</span>
              <span>Queue: {queueIntegrityState ?? 'Unavailable'}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. OPERATIONS STATUS DISTRIBUTION BAR */}
      <Card className="border border-[var(--border-subtle)]">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-semibold">Operations Status Distribution</CardTitle>
              <CardDescription className="text-xs">
                {operationMetrics
                  ? `${telemetry.total.toLocaleString()} operations in the selected UTC window; chart uses the latest ${operations.length} list rows. Sampled ${operationMetrics.sampledAt}${operationMetrics.stale || operationMetricsFailed ? ' · stale' : ''}.`
                  : 'The full-window server aggregate is unavailable; no sampled counts are shown.'}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="text-xs flex items-center gap-1.5"
                onClick={onRefresh}
                disabled={isLoading}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </Button>
              <Link to="/operations">
                <Button size="sm" variant="outline" className="text-xs">
                  View the full list →
                </Button>
              </Link>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Visual Progress Bar */}
          <div className="h-4 w-full rounded-full bg-[var(--surface-muted)] overflow-hidden flex border border-[var(--border-subtle)]">
            {operationMetrics && telemetry.total > 0 ? (
              <>
                {telemetry.succeeded > 0 && (
                  <div
                    style={{ width: `${(telemetry.succeeded / telemetry.total) * 100}%` }}
                    className="bg-emerald-500 h-full transition-all duration-300"
                    title={`Succeeded: ${telemetry.succeeded}`}
                  />
                )}
                {telemetry.running > 0 && (
                  <div
                    style={{ width: `${(telemetry.running / telemetry.total) * 100}%` }}
                    className="bg-blue-500 h-full transition-all duration-300"
                    title={`Running: ${telemetry.running}`}
                  />
                )}
                {telemetry.failed > 0 && (
                  <div
                    style={{ width: `${(telemetry.failed / telemetry.total) * 100}%` }}
                    className="bg-red-500 h-full transition-all duration-300"
                    title={`Failed: ${telemetry.failed}`}
                  />
                )}
                {telemetry.cancelled > 0 && (
                  <div
                    style={{ width: `${(telemetry.cancelled / telemetry.total) * 100}%` }}
                    className="bg-gray-400 h-full transition-all duration-300"
                    title={`Cancelled: ${telemetry.cancelled}`}
                  />
                )}
                {telemetry.timedOut > 0 && (
                  <div
                    style={{ width: `${(telemetry.timedOut / telemetry.total) * 100}%` }}
                    className="bg-amber-500 h-full transition-all duration-300"
                    title={`Timed out: ${telemetry.timedOut}`}
                  />
                )}
              </>
            ) : operationMetrics ? (
              <div className="w-full h-full bg-[var(--surface-muted)] flex items-center justify-center text-[10px] text-[var(--text-sub)]">
                No operation data yet
              </div>
            ) : (
              <div className="w-full h-full bg-[var(--surface-muted)] flex items-center justify-center text-[10px] text-[var(--text-sub)]">
                {operationMetricsFailed ? 'Server metrics unavailable' : 'Loading server metrics…'}
              </div>
            )}
          </div>

          {/* Status Breakdown Legend & Counts */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1 text-xs">
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-emerald-500 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Succeeded</span>
                <span className="text-[var(--text-sub)]">{metricCount(telemetry.succeeded)} ops ({operationMetrics && telemetry.total > 0 ? ((telemetry.succeeded / telemetry.total) * 100).toFixed(0) : '—'}%)</span>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-blue-500 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Running</span>
                <span className="text-[var(--text-sub)]">{metricCount(telemetry.running)} ops ({operationMetrics && telemetry.total > 0 ? ((telemetry.running / telemetry.total) * 100).toFixed(0) : '—'}%)</span>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-red-500 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Failed</span>
                <span className="text-[var(--text-sub)]">{metricCount(telemetry.failed)} ops ({operationMetrics && telemetry.total > 0 ? ((telemetry.failed / telemetry.total) * 100).toFixed(0) : '—'}%)</span>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-gray-400 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Cancelled</span>
                <span className="text-[var(--text-sub)]">{metricCount(telemetry.cancelled)} ops</span>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-amber-500 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Timeout</span>
                <span className="text-[var(--text-sub)]">{metricCount(telemetry.timedOut)} ops</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. INTERACTIVE REQUEST THROUGHPUT & FREQUENCY CHART */}
      <Card className="border border-[var(--border-subtle)]">
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-[var(--cf-blue)]" />
                <CardTitle className="text-sm font-semibold">Request Throughput & Processing Time</CardTitle>
              </div>
              <CardDescription className="text-xs">
                {timeframeLabels[timeframe].desc} · Track throughput and latency for reporting
              </CardDescription>
            </div>

            {/* Timeframe selector buttons */}
            <div className="flex items-center gap-1 bg-[var(--surface-muted)] p-1 rounded-md border border-[var(--border-subtle)] self-start sm:self-auto">
              {(['minute', 'hour', 'day', 'week', 'month'] as MonitorTimeframe[]).map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setTimeframe(tf)}
                  className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                    timeframe === tf
                      ? 'bg-[var(--surface-base)] text-[var(--text-main)] shadow-sm font-semibold'
                      : 'text-[var(--text-sub)] hover:text-[var(--text-main)]'
                  }`}
                >
                  {timeframeLabels[tf].label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* SVG Bar Chart */}
          <div className="relative border border-[var(--border-subtle)] bg-[var(--surface-muted)] rounded-lg p-4">
            <div className="h-44 w-full flex items-end gap-1.5 sm:gap-2 pt-6">
              {buckets.map((bucket) => {
                const heightPercent =
                  maxRequestsInBuckets > 0
                    ? Math.max(8, (bucket.totalRequests / maxRequestsInBuckets) * 100)
                    : 8;
                const isHovered = hoveredBucket?.key === bucket.key;

                return (
                  <div
                    key={bucket.key}
                    onMouseEnter={() => setHoveredBucket(bucket)}
                    onMouseLeave={() => setHoveredBucket(null)}
                    className="flex-1 flex flex-col items-center h-full justify-end group cursor-pointer"
                  >
                    {/* Bar Column */}
                    <div className="w-full relative flex items-end justify-center h-full">
                      <div
                        style={{ height: `${heightPercent}%` }}
                        className={`w-full max-w-[28px] rounded-t transition-all duration-200 flex flex-col justify-end overflow-hidden ${
                          isHovered
                            ? 'ring-2 ring-[var(--cf-blue)] brightness-110'
                            : bucket.totalRequests > 0
                            ? 'bg-gradient-to-t from-blue-600 to-blue-400 hover:from-blue-500 hover:to-blue-300'
                            : 'bg-gray-300/40 dark:bg-gray-700/40'
                        }`}
                      >
                        {bucket.failed > 0 && bucket.totalRequests > 0 && (
                          <div
                            style={{ height: `${(bucket.failed / bucket.totalRequests) * 100}%` }}
                            className="bg-red-500 w-full"
                          />
                        )}
                      </div>
                    </div>

                    {/* X-axis label */}
                    <span className="text-[10px] text-[var(--text-sub)] mt-2 truncate max-w-full font-mono text-center">
                      {bucket.label}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Hover Tooltip display at bottom */}
            <div className="mt-3 pt-2 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-sub)] min-h-[24px]">
              {hoveredBucket ? (
                <>
                  <span className="font-semibold text-[var(--text-main)]">
                    Bucket: {hoveredBucket.label} ({hoveredBucket.subLabel})
                  </span>
                  <span>Total: <strong className="text-[var(--text-main)]">{hoveredBucket.totalRequests}</strong> reqs</span>
                  <span className="text-green-600">Succeeded: <strong>{hoveredBucket.succeeded}</strong></span>
                  <span className="text-red-500">Failed: <strong>{hoveredBucket.failed}</strong></span>
                  <span>Avg processing time: <strong className="text-[var(--text-main)]">{formatDurationMs(hoveredBucket.avgDurationMs)}</strong></span>
                </>
              ) : (
                <span className="italic">
                  Hover a column to see the throughput and processing time for that time bucket.
                </span>
              )}
            </div>
          </div>

          {/* Table representation of Timeframe Buckets */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">
              Throughput & Processing Time table ({timeframeLabels[timeframe].label})
            </h4>
            <TableContainer className="border border-[var(--border-subtle)] rounded-md max-h-56 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-[var(--surface-muted)]">
                    <TableHead className="text-xs">Time bucket</TableHead>
                    <TableHead className="text-xs text-right">Total requests</TableHead>
                    <TableHead className="text-xs text-right">Succeeded</TableHead>
                    <TableHead className="text-xs text-right">Failed</TableHead>
                    <TableHead className="text-xs text-right">Cancelled / Timeout</TableHead>
                    <TableHead className="text-xs text-right">Success rate</TableHead>
                    <TableHead className="text-xs text-right">Avg processing time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buckets
                    .filter((b) => b.totalRequests > 0 || timeframe === 'day' || timeframe === 'week')
                    .slice(-10)
                    .map((bucket) => {
                      const rate =
                        bucket.totalRequests > 0
                          ? ((bucket.succeeded / bucket.totalRequests) * 100).toFixed(0) + '%'
                          : '—';
                      return (
                        <TableRow key={bucket.key}>
                          <TableCell className="text-xs font-medium font-mono">
                            {bucket.label} <span className="text-[var(--text-sub)] font-sans">({bucket.subLabel})</span>
                          </TableCell>
                          <TableCell className="text-xs text-right font-semibold">
                            {bucket.totalRequests}
                          </TableCell>
                          <TableCell className="text-xs text-right text-green-600 font-medium">
                            {bucket.succeeded}
                          </TableCell>
                          <TableCell className="text-xs text-right text-red-600 font-medium">
                            {bucket.failed}
                          </TableCell>
                          <TableCell className="text-xs text-right text-[var(--text-sub)]">
                            {bucket.cancelled + bucket.timedOut}
                          </TableCell>
                          <TableCell className="text-xs text-right">
                            <Badge
                              variant={rate.startsWith('100') || rate.startsWith('9') ? 'success' : rate === '—' ? 'neutral' : 'warning'}
                              className="text-[10px] py-0 px-1.5"
                            >
                              {rate}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-right font-mono">
                            {formatDurationMs(bucket.avgDurationMs)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </TableContainer>
          </div>
        </CardContent>
      </Card>

      {/* 4. WORKER PROCESSING & CONNECTIVITY SECTION */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Workers table (7 cols) */}
        <Card className="lg:col-span-7 border border-[var(--border-subtle)]">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Server className="w-4 h-4 text-purple-500" />
                  Worker instances
                </CardTitle>
                <CardDescription className="text-xs">
                  Platform-wide worker instances have reported a heartbeat; status is derived from heartbeat freshness.
                  {workerInstances ? ` Sampled ${new Date(workerInstances.sampledAt).toLocaleString()}.` : ''}
                </CardDescription>
              </div>
              <Link to="/businesses">
                <Button size="sm" variant="ghost" className="text-xs text-[var(--cf-blue)]">
                  Manage Businesses →
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {workerInventoryFailed ? (
              <div role="status" className="text-center p-6 border border-dashed border-[var(--border-subtle)] rounded-lg text-xs text-[var(--text-sub)]">
                Worker heartbeat inventory is unavailable for this admin scope.
              </div>
            ) : workerInstances === null ? (
              <div role="status" className="text-center p-6 border border-dashed border-[var(--border-subtle)] rounded-lg text-xs text-[var(--text-sub)]">
                Loading worker heartbeat inventory…
              </div>
            ) : workerList.length === 0 ? (
              <div className="text-center p-6 border border-dashed border-[var(--border-subtle)] rounded-lg text-xs text-[var(--text-sub)]">
                No worker heartbeat instances are currently recorded.
              </div>
            ) : (
              <TableContainer className="border border-[var(--border-subtle)] rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-[var(--surface-muted)]">
                      <TableHead className="text-xs">Worker instance</TableHead>
                      <TableHead className="text-xs">Business / version</TableHead>
                      <TableHead className="text-xs">Health status</TableHead>
                      <TableHead className="text-xs text-right">Active leases</TableHead>
                      <TableHead className="text-xs text-right">Capacity</TableHead>
                      <TableHead className="text-xs text-right">Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workerList.map((worker) => (
                      <TableRow key={JSON.stringify([worker.businessId, worker.instanceId])}>
                        <TableCell className="text-xs">
                          <span className="font-semibold text-[var(--text-main)] font-mono">{worker.instanceId}</span>
                        </TableCell>
                        <TableCell className="text-xs font-mono">
                          {worker.businessId}@{worker.version}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${worker.status === 'HEALTHY' ? 'bg-green-500' : worker.status === 'DEGRADED' ? 'bg-amber-500' : 'bg-gray-400'}`} />
                            <Badge
                              variant={worker.status === 'HEALTHY' ? 'success' : worker.status === 'DEGRADED' ? 'warning' : 'neutral'}
                              className="text-[10px] py-0 px-1.5"
                            >
                              {worker.status}
                            </Badge>
                            <span className="text-[10px] text-[var(--text-sub)]">{worker.state}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-right font-semibold">
                          {worker.activeLeases.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          {worker.capacity.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono">
                          <time dateTime={worker.lastHeartbeatAt} title={worker.lastHeartbeatAt}>
                            {new Date(worker.lastHeartbeatAt).toLocaleString()}
                          </time>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
            {workerInstances?.truncated ? (
              <p className="mt-2 text-[10px] text-[var(--text-sub)]">
                Showing the latest 500 worker instances; the inventory response is truncated.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* Infrastructure Connectivity (5 cols) */}
        <Card className="lg:col-span-5 border border-[var(--border-subtle)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-500" />
              Connectivity & Infrastructure Status
            </CardTitle>
            <CardDescription className="text-xs">
              Live connection status for PostgreSQL, Redis and BullMQ
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              {/* PostgreSQL */}
              <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] flex flex-col justify-between">
                <span className="text-[var(--text-sub)]">PostgreSQL DB</span>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className={`w-2 h-2 rounded-full ${health?.db ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="font-semibold text-[var(--text-main)]">
                    {health?.db ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
              </div>

              {/* Redis Cache/Queue */}
              <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] flex flex-col justify-between">
                <span className="text-[var(--text-sub)]">Redis Queue</span>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className={`w-2 h-2 rounded-full ${health?.redis ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="font-semibold text-[var(--text-main)]">
                    {health?.redis ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
              </div>

              {/* Queue Integrity */}
              <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] flex flex-col justify-between">
                <span className="text-[var(--text-sub)]">Queue integrity</span>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className={`w-2 h-2 rounded-full ${queueIntegrityDotClass}`} />
                  <span className="font-semibold text-[var(--text-main)]">
                    {queueIntegrityState ?? 'Unavailable'}
                  </span>
                </div>
              </div>

              {/* Active Leases */}
              <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] flex flex-col justify-between">
                <span className="text-[var(--text-sub)]">Active Leases</span>
                <div className="flex items-center gap-1.5 mt-2">
                  <Zap className="w-3.5 h-3.5 text-amber-500" />
                  <span className="font-semibold text-[var(--text-main)]">
                    {health?.activeLeases ?? 0} leases
                  </span>
                </div>
              </div>
            </div>

            <div className="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-base)] text-[11px] text-[var(--text-sub)] space-y-1">
              <div className="flex justify-between">
                <span>Orphan tasks checked:</span>
                <strong className="text-[var(--text-main)]">{health?.queueIntegrity?.orphansLast ?? 0}</strong>
              </div>
              <div className="flex justify-between">
                <span>Stalled Jobs:</span>
                <strong className="text-[var(--text-main)]">{health?.queueIntegrity?.stalled ?? 0}</strong>
              </div>
              <div className="flex justify-between">
                <span>Outbox Backlog:</span>
                <strong className="text-[var(--text-main)]">{health?.outboxBacklog ?? 0}</strong>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 5. RECENT OPERATIONS TABLE */}
      <Card className="border border-[var(--border-subtle)]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Clock className="w-4 h-4 text-[var(--cf-blue)]" />
                Recent Operations
              </CardTitle>
              <CardDescription className="text-xs">
                The most recently processed document tasks
              </CardDescription>
            </div>
            <Link to="/operations">
              <Button size="sm" variant="outline" className="text-xs">
                Open the Operations screen →
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {telemetry.recentItems.length === 0 ? (
            <div className="text-center p-6 border border-dashed border-[var(--border-subtle)] rounded-lg text-xs text-[var(--text-sub)]">
              No operations have been executed in the system yet.
            </div>
          ) : (
            <TableContainer className="border border-[var(--border-subtle)] rounded-md">
              <Table>
                <TableHeader>
                  <TableRow className="bg-[var(--surface-muted)]">
                    <TableHead className="text-xs">ID</TableHead>
                    <TableHead className="text-xs">Action</TableHead>
                    <TableHead className="text-xs">Worker</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Created</TableHead>
                    <TableHead className="text-xs text-right">Processing time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {telemetry.recentItems.map((op) => {
                    const dur = formatDurationMs(
                      op.completedAt && (op.startedAt || op.createdAt)
                        ? new Date(op.completedAt).getTime() - new Date((op.startedAt || op.createdAt)!).getTime()
                        : null,
                    );
                    return (
                      <TableRow key={op.id}>
                        <TableCell className="text-xs font-mono">
                          <Link
                            to={`/operations`}
                            className="text-[var(--cf-blue)] hover:underline font-semibold"
                            title={op.id}
                          >
                            {op.id.slice(0, 8)}…
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs font-medium">{op.action ?? '—'}</TableCell>
                        <TableCell className="text-xs font-mono text-[var(--text-sub)]">
                          {op.businessId ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs">
                          <Badge
                            variant={
                              op.state === 'SUCCEEDED'
                                ? 'success'
                                : op.state === 'FAILED'
                                ? 'danger'
                                : op.state === 'CANCELLED'
                                ? 'neutral'
                                : 'info'
                            }
                            className="text-[10px] py-0 px-1.5"
                          >
                            {op.state}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-[var(--text-sub)]">
                          {op.createdAt ? new Date(op.createdAt).toLocaleTimeString() : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono font-medium">
                          {dur}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
