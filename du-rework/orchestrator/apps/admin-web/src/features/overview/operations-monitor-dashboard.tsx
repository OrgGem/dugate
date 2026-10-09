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
  BusinessRow,
  OperationWire,
} from '@/lib/api';
import {
  computeOperationsTelemetry,
  computeTimeBuckets,
  computeWorkerTelemetry,
  formatDurationMs,
  type MonitorTimeframe,
  type TimeBucket,
} from './overview-metrics';

interface OperationsMonitorDashboardProps {
  operations: OperationWire[];
  businesses: BusinessRow[];
  health: AdminHealthSnapshot | null;
  onRefresh: () => void;
  isLoading?: boolean;
}

export function OperationsMonitorDashboard({
  operations,
  businesses,
  health,
  onRefresh,
  isLoading,
}: OperationsMonitorDashboardProps) {
  const [timeframe, setTimeframe] = useState<MonitorTimeframe>('hour');
  const [hoveredBucket, setHoveredBucket] = useState<TimeBucket | null>(null);

  const telemetry = computeOperationsTelemetry(operations);
  const workerList = computeWorkerTelemetry(businesses, operations);
  const buckets = computeTimeBuckets(operations, timeframe);

  const maxRequestsInBuckets = Math.max(1, ...buckets.map((b) => b.totalRequests));

  const timeframeLabels: Record<MonitorTimeframe, { label: string; desc: string }> = {
    minute: { label: 'Phút', desc: '60 phút gần nhất (khoảng 5 phút)' },
    hour: { label: 'Giờ', desc: '24 giờ gần nhất (khoảng 1 giờ)' },
    day: { label: 'Ngày', desc: '7 ngày gần nhất (khoảng 1 ngày)' },
    week: { label: 'Tuần', desc: '4 tuần gần nhất (khoảng 1 tuần)' },
    month: { label: 'Tháng', desc: '6 tháng gần nhất (khoảng 1 tháng)' },
  };

  return (
    <div className="flex flex-col gap-5">
      {/* 1. TOP METRIC CARDS (KPIs) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Operations */}
        <Card className="border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <CardContent className="p-4 flex flex-col justify-between h-full">
            <div className="flex items-center justify-between text-[var(--text-sub)]">
              <span className="text-xs font-semibold uppercase tracking-wider">Tổng Operations</span>
              <Activity className="w-4 h-4 text-[var(--cf-blue)]" />
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-[var(--text-main)]">{telemetry.total}</span>
              <Badge variant="info" className="text-xs">
                {telemetry.running > 0 ? `${telemetry.running} đang chạy` : 'Sẵn sàng'}
              </Badge>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-[var(--text-sub)]">
              <span className="text-green-600 font-medium">✓ {telemetry.succeeded} thành công</span>
              <span>·</span>
              <span className="text-red-600 font-medium">✗ {telemetry.failed} lỗi</span>
            </div>
          </CardContent>
        </Card>

        {/* Success Rate */}
        <Card className="border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <CardContent className="p-4 flex flex-col justify-between h-full">
            <div className="flex items-center justify-between text-[var(--text-sub)]">
              <span className="text-xs font-semibold uppercase tracking-wider">Tỷ lệ Thành công</span>
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-[var(--text-main)]">{telemetry.successRate}%</span>
              <Badge
                variant={Number(telemetry.successRate) >= 95 ? 'success' : Number(telemetry.successRate) >= 80 ? 'warning' : 'danger'}
                className="text-xs"
              >
                {Number(telemetry.successRate) >= 95 ? 'Tốt' : 'Cần chú ý'}
              </Badge>
            </div>
            <div className="mt-2 text-xs text-[var(--text-sub)]">
              {telemetry.cancelled > 0 ? `${telemetry.cancelled} đã hủy · ` : ''}
              {telemetry.timedOut > 0 ? `${telemetry.timedOut} quá hạn` : 'Không có timeout'}
            </div>
          </CardContent>
        </Card>

        {/* Processing Duration / Latency */}
        <Card className="border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <CardContent className="p-4 flex flex-col justify-between h-full">
            <div className="flex items-center justify-between text-[var(--text-sub)]">
              <span className="text-xs font-semibold uppercase tracking-wider">Thời gian Xử lý TB</span>
              <Clock className="w-4 h-4 text-amber-500" />
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-2xl font-bold text-[var(--text-main)]">
                {formatDurationMs(telemetry.avgDurationMs)}
              </span>
              <Badge variant="neutral" className="text-xs">
                Latency
              </Badge>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-[var(--text-sub)]">
              <span>Nhanh nhất: {formatDurationMs(telemetry.minDurationMs)}</span>
              <span>Lâu nhất: {formatDurationMs(telemetry.maxDurationMs)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Workers & Cluster Health */}
        <Card className="border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <CardContent className="p-4 flex flex-col justify-between h-full">
            <div className="flex items-center justify-between text-[var(--text-sub)]">
              <span className="text-xs font-semibold uppercase tracking-wider">Workers & Hạ tầng</span>
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
              <span>Queue: {health?.queueIntegrity?.state ?? 'OK'}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. OPERATIONS STATUS DISTRIBUTION BAR */}
      <Card className="border border-[var(--border-subtle)]">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-semibold">Phân bổ Trạng thái Operations</CardTitle>
              <CardDescription className="text-xs">
                Tổng quan {telemetry.total} requests được ghi nhận trong phiên làm việc
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
                <span>Làm mới</span>
              </Button>
              <Link to="/operations">
                <Button size="sm" variant="outline" className="text-xs">
                  Xem toàn bộ danh sách →
                </Button>
              </Link>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Visual Progress Bar */}
          <div className="h-4 w-full rounded-full bg-[var(--surface-muted)] overflow-hidden flex border border-[var(--border-subtle)]">
            {telemetry.total > 0 ? (
              <>
                {telemetry.succeeded > 0 && (
                  <div
                    style={{ width: `${(telemetry.succeeded / telemetry.total) * 100}%` }}
                    className="bg-emerald-500 h-full transition-all duration-300"
                    title={`Thành công: ${telemetry.succeeded}`}
                  />
                )}
                {telemetry.running > 0 && (
                  <div
                    style={{ width: `${(telemetry.running / telemetry.total) * 100}%` }}
                    className="bg-blue-500 h-full transition-all duration-300"
                    title={`Đang chạy: ${telemetry.running}`}
                  />
                )}
                {telemetry.failed > 0 && (
                  <div
                    style={{ width: `${(telemetry.failed / telemetry.total) * 100}%` }}
                    className="bg-red-500 h-full transition-all duration-300"
                    title={`Lỗi: ${telemetry.failed}`}
                  />
                )}
                {telemetry.cancelled > 0 && (
                  <div
                    style={{ width: `${(telemetry.cancelled / telemetry.total) * 100}%` }}
                    className="bg-gray-400 h-full transition-all duration-300"
                    title={`Đã hủy: ${telemetry.cancelled}`}
                  />
                )}
                {telemetry.timedOut > 0 && (
                  <div
                    style={{ width: `${(telemetry.timedOut / telemetry.total) * 100}%` }}
                    className="bg-amber-500 h-full transition-all duration-300"
                    title={`Quá hạn: ${telemetry.timedOut}`}
                  />
                )}
              </>
            ) : (
              <div className="w-full h-full bg-[var(--surface-muted)] flex items-center justify-center text-[10px] text-[var(--text-sub)]">
                Chưa có dữ liệu operation
              </div>
            )}
          </div>

          {/* Status Breakdown Legend & Counts */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1 text-xs">
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-emerald-500 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Thành công</span>
                <span className="text-[var(--text-sub)]">{telemetry.succeeded} ops ({telemetry.total > 0 ? ((telemetry.succeeded / telemetry.total) * 100).toFixed(0) : 0}%)</span>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-blue-500 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Đang chạy</span>
                <span className="text-[var(--text-sub)]">{telemetry.running} ops ({telemetry.total > 0 ? ((telemetry.running / telemetry.total) * 100).toFixed(0) : 0}%)</span>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-red-500 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Thất bại</span>
                <span className="text-[var(--text-sub)]">{telemetry.failed} ops ({telemetry.total > 0 ? ((telemetry.failed / telemetry.total) * 100).toFixed(0) : 0}%)</span>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-gray-400 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Đã hủy</span>
                <span className="text-[var(--text-sub)]">{telemetry.cancelled} ops</span>
              </div>
            </div>
            <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)]">
              <span className="w-3 h-3 rounded-full bg-amber-500 shrink-0" />
              <div className="flex flex-col">
                <span className="font-semibold text-[var(--text-main)]">Timeout</span>
                <span className="text-[var(--text-sub)]">{telemetry.timedOut} ops</span>
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
                <CardTitle className="text-sm font-semibold">Tần suất Xử lý Request & Thời gian</CardTitle>
              </div>
              <CardDescription className="text-xs">
                {timeframeLabels[timeframe].desc} · Theo dõi lưu lượng và độ trễ phục vụ báo cáo
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
                    Khoảng: {hoveredBucket.label} ({hoveredBucket.subLabel})
                  </span>
                  <span>Tổng: <strong className="text-[var(--text-main)]">{hoveredBucket.totalRequests}</strong> reqs</span>
                  <span className="text-green-600">Thành công: <strong>{hoveredBucket.succeeded}</strong></span>
                  <span className="text-red-500">Lỗi: <strong>{hoveredBucket.failed}</strong></span>
                  <span>Thời gian xử lý TB: <strong className="text-[var(--text-main)]">{formatDurationMs(hoveredBucket.avgDurationMs)}</strong></span>
                </>
              ) : (
                <span className="italic">
                  Di chuột lên từng cột để xem chi tiết lưu lượng và thời gian xử lý cho mốc thời gian tương ứng.
                </span>
              )}
            </div>
          </div>

          {/* Table representation of Timeframe Buckets */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">
              Bảng Tần suất & Thời gian xử lý ({timeframeLabels[timeframe].label})
            </h4>
            <TableContainer className="border border-[var(--border-subtle)] rounded-md max-h-56 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-[var(--surface-muted)]">
                    <TableHead className="text-xs">Mốc thời gian</TableHead>
                    <TableHead className="text-xs text-right">Tổng Request</TableHead>
                    <TableHead className="text-xs text-right">Thành công</TableHead>
                    <TableHead className="text-xs text-right">Thất bại</TableHead>
                    <TableHead className="text-xs text-right">Hủy / Timeout</TableHead>
                    <TableHead className="text-xs text-right">Tỷ lệ Thành công</TableHead>
                    <TableHead className="text-xs text-right">Thời gian xử lý TB</TableHead>
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
                  Worker xử lý & Hàng đợi
                </CardTitle>
                <CardDescription className="text-xs">
                  Danh sách worker services đã kết nối và đăng ký lắng nghe BullMQ
                </CardDescription>
              </div>
              <Link to="/businesses">
                <Button size="sm" variant="ghost" className="text-xs text-[var(--cf-blue)]">
                  Quản lý Businesses →
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {workerList.length === 0 ? (
              <div className="text-center p-6 border border-dashed border-[var(--border-subtle)] rounded-lg text-xs text-[var(--text-sub)]">
                Chưa có worker nào được đăng ký.
              </div>
            ) : (
              <TableContainer className="border border-[var(--border-subtle)] rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-[var(--surface-muted)]">
                      <TableHead className="text-xs">Worker Service</TableHead>
                      <TableHead className="text-xs">Trạng thái</TableHead>
                      <TableHead className="text-xs text-right">Đã xử lý</TableHead>
                      <TableHead className="text-xs text-right">Tỷ lệ thành công</TableHead>
                      <TableHead className="text-xs text-right">Thời gian TB</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workerList.map((worker) => (
                      <TableRow key={worker.businessId}>
                        <TableCell className="text-xs">
                          <div className="flex flex-col">
                            <span className="font-semibold text-[var(--text-main)] font-mono">
                              {worker.businessId}
                            </span>
                            <span className="text-[10px] text-[var(--text-sub)] font-mono truncate max-w-[180px]">
                              {worker.queue}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            <Badge variant="success" className="text-[10px] py-0 px-1.5">
                              {worker.status}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-right font-semibold">
                          {worker.processedCount} ops
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          <Badge variant="info" className="text-[10px] py-0 px-1.5">
                            {worker.successRate}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono">
                          {formatDurationMs(worker.avgDurationMs)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </CardContent>
        </Card>

        {/* Infrastructure Connectivity (5 cols) */}
        <Card className="lg:col-span-5 border border-[var(--border-subtle)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-500" />
              Kết nối & Trạng thái Hạ tầng
            </CardTitle>
            <CardDescription className="text-xs">
              Trạng thái kết nối trực tiếp đến PostgreSQL, Redis và BullMQ
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
                <span className="text-[var(--text-sub)]">Hàng đợi Integrity</span>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span className="font-semibold text-[var(--text-main)]">
                    {health?.queueIntegrity?.state ?? 'OK'}
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
                <span>Orphans Tasks kiểm tra:</span>
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
                Operations Gần Đây
              </CardTitle>
              <CardDescription className="text-xs">
                Danh sách các tác vụ tài liệu được xử lý mới nhất
              </CardDescription>
            </div>
            <Link to="/operations">
              <Button size="sm" variant="outline" className="text-xs">
                Mở màn hình Operations →
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {telemetry.recentItems.length === 0 ? (
            <div className="text-center p-6 border border-dashed border-[var(--border-subtle)] rounded-lg text-xs text-[var(--text-sub)]">
              Chưa có operation nào được thực hiện trong hệ thống.
            </div>
          ) : (
            <TableContainer className="border border-[var(--border-subtle)] rounded-md">
              <Table>
                <TableHeader>
                  <TableRow className="bg-[var(--surface-muted)]">
                    <TableHead className="text-xs">ID</TableHead>
                    <TableHead className="text-xs">Action</TableHead>
                    <TableHead className="text-xs">Worker</TableHead>
                    <TableHead className="text-xs">Trạng thái</TableHead>
                    <TableHead className="text-xs">Thời điểm tạo</TableHead>
                    <TableHead className="text-xs text-right">Thời gian xử lý</TableHead>
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
