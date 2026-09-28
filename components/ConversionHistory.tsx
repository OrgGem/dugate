'use client';

// components/ConversionHistory.tsx
// Enterprise Material Operations Table with Filter Toolbar and Record Action Bars

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import {
  Loader2, CheckCircle2, XCircle, Clock, Ban, Trash2,
  Search, RefreshCw, Eye, Play, Copy, Check, Filter, ArrowUpDown
} from 'lucide-react';
import { toast } from 'sonner';

interface OperationItem {
  name: string;
  done: boolean;
  metadata: {
    state: string;
    pipeline: string[];
    current_step?: number;
    progress_percent: number;
    create_time: string;
    update_time: string;
  };
}

function OperationStatusBadge({ state, percent }: { state: string; percent?: number }) {
  switch (state) {
    case 'RUNNING':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-semibold bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
          <Loader2 className="w-3 h-3 animate-spin" /> Đang chạy {percent !== undefined ? `(${percent}%)` : ''}
        </span>
      );
    case 'WAITING_USER_INPUT':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-semibold bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <Clock className="w-3 h-3" /> Chờ duyệt (HITL)
        </span>
      );
    case 'SUCCEEDED':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-semibold bg-green-50 dark:bg-green-950/50 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800">
          <CheckCircle2 className="w-3 h-3 text-green-600" /> Hoàn tất
        </span>
      );
    case 'FAILED':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-semibold bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
          <XCircle className="w-3 h-3 text-red-600" /> Thất bại
        </span>
      );
    case 'CANCELLED':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
          <Ban className="w-3 h-3" /> Đã hủy
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground border border-border">
          {state}
        </span>
      );
  }
}

export default function ConversionHistory() {
  const { data: session } = useSession();
  const canDelete = session?.user?.role !== 'VIEWER';

  const [ops, setOps] = useState<OperationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchOperations = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetch('/api/operations?page_size=100');
      if (res.ok) {
        const data = await res.json();
        setOps(data.operations ?? []);
      }
    } catch {
      toast.error('Không thể tải lịch sử operations');
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchOperations();
  }, [fetchOperations]);

  const handleCopyId = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(id);
    setCopiedId(id);
    toast.success('Đã sao chép ID');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCancel = async (opId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Bạn có chắc muốn hủy operation ${opId}?`)) return;
    try {
      const res = await fetch(`/api/v1/operations/${opId}/cancel`, { method: 'POST' });
      if (res.ok) {
        toast.success('Đã hủy operation');
        fetchOperations(true);
      } else {
        toast.error('Không thể hủy operation');
      }
    } catch {
      toast.error('Lỗi khi hủy operation');
    }
  };

  const handleDelete = async (opId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Xóa vĩnh viễn bản ghi operation ${opId}?`)) return;
    try {
      const res = await fetch(`/api/operations/${opId}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Đã xóa operation');
        setOps(prev => prev.filter(op => op.name !== `operations/${opId}`));
      } else {
        toast.error('Lỗi khi xóa operation');
      }
    } catch {
      toast.error('Lỗi kết nối khi xóa operation');
    }
  };

  const filteredOps = useMemo(() => {
    return ops.filter(op => {
      const opId = op.name.replace('operations/', '').toLowerCase();
      const pipelineStr = op.metadata.pipeline?.join(' ').toLowerCase() || '';
      const state = op.metadata.state || '';

      const matchesSearch = searchQuery === '' ||
        opId.includes(searchQuery.toLowerCase()) ||
        pipelineStr.includes(searchQuery.toLowerCase());

      const matchesStatus = statusFilter === 'ALL' || state === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [ops, searchQuery, statusFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: ops.length };
    ops.forEach(op => {
      const s = op.metadata.state;
      counts[s] = (counts[s] || 0) + 1;
    });
    return counts;
  }, [ops]);

  if (loading) {
    return (
      <div className="modern-card p-12 text-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-3" />
        <p className="text-sm font-medium text-muted-foreground">Đang truy vấn lịch sử thực thi...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── TOOLBAR: FILTER & SEARCH ───────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 bg-card border border-border rounded-lg shadow-xs">
        {/* Search Field */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm theo Operation ID hoặc Pipeline..."
            className="input-field pl-9 py-1.5 text-xs"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchOperations(true)}
            disabled={refreshing}
            className="btn-outline inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md"
            title="Làm mới danh sách"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Làm mới</span>
          </button>
        </div>
      </div>

      {/* ── STATUS TABS ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-border">
        {[
          { key: 'ALL', label: 'Tất cả' },
          { key: 'RUNNING', label: 'Đang chạy' },
          { key: 'WAITING_USER_INPUT', label: 'Chờ duyệt' },
          { key: 'SUCCEEDED', label: 'Hoàn tất' },
          { key: 'FAILED', label: 'Thất bại' },
          { key: 'CANCELLED', label: 'Đã hủy' },
        ].map(tab => {
          const count = statusCounts[tab.key] || 0;
          const isActive = statusFilter === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                isActive
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <span>{tab.label}</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                isActive ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── DATA TABLE / RECORD LIST ───────────────────────────────────────── */}
      {filteredOps.length === 0 ? (
        <div className="modern-card p-12 text-center">
          <p className="text-sm font-semibold text-foreground mb-1">Không có Operation nào phù hợp</p>
          <p className="text-xs text-muted-foreground">
            {searchQuery || statusFilter !== 'ALL'
              ? 'Thử thay đổi từ khóa tìm kiếm hoặc bộ lọc trạng thái.'
              : 'Chưa có tác vụ nào được ghi nhận.'}
          </p>
        </div>
      ) : (
        <div className="data-table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Operation ID</th>
                <th>Trạng thái</th>
                <th>Quy trình Pipeline</th>
                <th>Tiến độ</th>
                <th>Thời điểm tạo</th>
                <th className="text-right">Action Bar</th>
              </tr>
            </thead>
            <tbody>
              {filteredOps.map(op => {
                const opId = op.name.replace('operations/', '');
                const createdAt = new Date(op.metadata.create_time).toLocaleString('vi-VN');
                const isRunning = op.metadata.state === 'RUNNING';
                const isWaiting = op.metadata.state === 'WAITING_USER_INPUT';

                return (
                  <tr key={op.name}>
                    {/* Operation ID */}
                    <td className="font-mono text-xs">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/operations/${opId}`}
                          className="font-bold text-primary hover:underline"
                        >
                          {opId.slice(0, 8)}...{opId.slice(-6)}
                        </Link>
                        <button
                          onClick={(e) => handleCopyId(opId, e)}
                          title="Sao chép ID"
                          className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
                        >
                          {copiedId === opId ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    </td>

                    {/* Status Badge */}
                    <td>
                      <OperationStatusBadge state={op.metadata.state} percent={op.metadata.progress_percent} />
                    </td>

                    {/* Pipeline Steps */}
                    <td>
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {op.metadata.pipeline?.map((p, idx) => (
                          <span
                            key={idx}
                            className="px-1.5 py-0.5 text-[11px] bg-muted text-muted-foreground font-mono rounded border border-border"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>

                    {/* Progress */}
                    <td className="w-28">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-muted rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              op.metadata.state === 'FAILED'
                                ? 'bg-destructive'
                                : op.metadata.state === 'WAITING_USER_INPUT'
                                ? 'bg-amber-500'
                                : 'bg-primary'
                            }`}
                            style={{ width: `${op.metadata.progress_percent}%` }}
                          />
                        </div>
                        <span className="text-[11px] font-mono text-muted-foreground">
                          {op.metadata.progress_percent}%
                        </span>
                      </div>
                    </td>

                    {/* Created Time */}
                    <td className="text-xs text-muted-foreground whitespace-nowrap">
                      {createdAt}
                    </td>

                    {/* Record Action Bar (Actions Column) */}
                    <td className="text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5 justify-end">
                        {/* View Detail Link */}
                        <Link
                          href={`/operations/${opId}`}
                          className="btn-outline p-1.5 rounded hover:bg-muted text-foreground"
                          title="Xem chi tiết bản ghi"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </Link>

                        {/* Resume Shortcut */}
                        {isWaiting && (
                          <Link
                            href={`/operations/${opId}`}
                            className="btn-primary p-1.5 rounded bg-amber-600 hover:bg-amber-700 text-white"
                            title="Mở form duyệt / tiếp tục"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </Link>
                        )}

                        {/* Cancel Button */}
                        {(isRunning || isWaiting) && (
                          <button
                            onClick={(e) => handleCancel(opId, e)}
                            className="btn-danger p-1.5 rounded"
                            title="Hủy tác vụ này"
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {/* Delete Button */}
                        {canDelete && (
                          <button
                            onClick={(e) => handleDelete(opId, e)}
                            className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            title="Xóa bản ghi"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
