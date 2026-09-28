'use client';

// app/operations/[id]/page.tsx
// Enterprise Material Record Detail View for DU Gate Operations
// Features: Sticky Record Action Bar, Key-Value Metadata Grid, Pipeline Stepper,
// Tabbed Output Viewer, HITL Resume Dialog, and Usage Breakdown Table.

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Loader2, CheckCircle2, XCircle, Download, Copy, Check,
  ArrowLeft, Ban, Play, RefreshCw, Layers, Database,
  DollarSign, Clock, Cpu, FileText, AlertTriangle, ChevronDown, ChevronUp, Code
} from 'lucide-react';
import { toast } from 'sonner';

interface OperationData {
  name: string;
  done: boolean;
  metadata: {
    state: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'WAITING_USER_INPUT' | string;
    pipeline: string[];
    current_step: number;
    progress_percent: number;
    progress_message?: string;
    create_time: string;
    update_time: string;
  };
  result?: {
    output_format?: string;
    content?: string;
    extracted_data?: unknown;
    pipeline_steps?: Array<{
      step: number;
      processor: string;
      output_format: string;
      content_preview?: string;
      extracted_data?: unknown;
    }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      pages_processed: number;
      model_used: string;
      cost_usd: number;
      breakdown?: Array<{ processor: string; input_tokens: number; output_tokens: number; cost_usd: number }>;
    };
    download_url?: string;
  };
  error?: {
    code: string;
    message: string;
    failed_step?: number;
  };
}

export default function OperationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [data, setData] = useState<OperationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedContent, setCopiedContent] = useState(false);
  const [activeTab, setActiveTab] = useState<'content' | 'extracted' | 'steps'>('content');

  // HITL Resume Dialog State
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [resumeDataJson, setResumeDataJson] = useState('');
  const [isSubmittingResume, setIsSubmittingResume] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const fetchOp = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetch(`/api/operations/${id}`);
      if (res.ok) {
        const d = await res.json();
        setData(d);
        if (d.metadata?.state === 'WAITING_USER_INPUT' && d.result?.extracted_data) {
          setResumeDataJson(JSON.stringify(d.result.extracted_data, null, 2));
        }
        return d.done;
      }
    } catch (err) {
      console.error('Failed to fetch operation', err);
    } finally {
      if (isManual) setRefreshing(false);
    }
    return false;
  }, [id]);

  useEffect(() => {
    let active = true;
    let interval: ReturnType<typeof setInterval>;

    async function poll() {
      const done = await fetchOp();
      setLoading(false);
      if (!done && active) {
        interval = setInterval(async () => {
          const isDone = await fetchOp();
          if (isDone && active) clearInterval(interval);
        }, 2000);
      }
    }

    poll();
    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [fetchOp]);

  // Record Actions
  const handleCopyId = async () => {
    await navigator.clipboard.writeText(id);
    setCopiedId(true);
    toast.success('Đã sao chép Operation ID');
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleCopyContent = async () => {
    const textToCopy = activeTab === 'extracted' && data?.result?.extracted_data
      ? JSON.stringify(data.result.extracted_data, null, 2)
      : data?.result?.content || JSON.stringify(data, null, 2);

    await navigator.clipboard.writeText(textToCopy);
    setCopiedContent(true);
    toast.success('Đã sao chép nội dung vào bộ nhớ tạm');
    setTimeout(() => setCopiedContent(false), 2000);
  };

  const handleDownload = () => {
    if (data?.result?.download_url) {
      window.open(data.result.download_url, '_blank');
      return;
    }
    if (data?.result?.content) {
      const blob = new Blob([data.result.content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `operation-${id}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleCancelOperation = async () => {
    if (!confirm('Bạn có chắc chắn muốn hủy tác vụ này không?')) return;
    setIsCancelling(true);
    try {
      const res = await fetch(`/api/v1/operations/${id}/cancel`, { method: 'POST' });
      if (res.ok) {
        toast.success('Đã hủy tác vụ thành công');
        await fetchOp(true);
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.detail || body.title || 'Không thể hủy tác vụ');
      }
    } catch {
      toast.error('Lỗi khi gọi API hủy tác vụ');
    } finally {
      setIsCancelling(false);
    }
  };

  const handleSubmitResume = async () => {
    setIsSubmittingResume(true);
    try {
      let parsedPayload: unknown = {};
      if (resumeDataJson.trim()) {
        try {
          parsedPayload = JSON.parse(resumeDataJson);
        } catch {
          toast.error('JSON không hợp lệ. Vui lòng kiểm tra lại cú pháp.');
          setIsSubmittingResume(false);
          return;
        }
      }

      const res = await fetch(`/api/v1/operations/${id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step: data?.metadata?.current_step ?? 0,
          extracted_data: parsedPayload
        })
      });

      if (res.ok) {
        toast.success('Đã gửi dữ liệu tiếp tục thành công!');
        setShowResumeModal(false);
        await fetchOp(true);
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || 'Lỗi khi resume operation');
      }
    } catch {
      toast.error('Lỗi kết nối khi gửi resume');
    } finally {
      setIsSubmittingResume(false);
    }
  };

  if (loading) {
    return (
      <main className="py-20 max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex flex-col items-center justify-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm font-medium text-muted-foreground">Đang truy vấn bản ghi Operation...</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="py-20 max-w-7xl mx-auto px-4 sm:px-6">
        <div className="modern-card p-12 text-center max-w-lg mx-auto">
          <XCircle className="w-12 h-12 text-destructive mx-auto mb-3" />
          <h2 className="text-lg font-bold text-foreground mb-1">Không tìm thấy Operation</h2>
          <p className="text-sm text-muted-foreground mb-6">Mã định danh không tồn tại hoặc bạn không có quyền truy cập.</p>
          <Link href="/history" className="btn-outline inline-flex items-center gap-2 px-4 py-2 text-sm rounded-md">
            <ArrowLeft className="w-4 h-4" /> Quay lại danh sách
          </Link>
        </div>
      </main>
    );
  }

  const { metadata, result, error: opError } = data;
  const state = metadata.state;
  const isRunning = state === 'RUNNING';
  const isWaitingInput = state === 'WAITING_USER_INPUT';
  const isSuccess = state === 'SUCCEEDED';
  const isFailed = state === 'FAILED';
  const isCancelled = state === 'CANCELLED';

  return (
    <main className="py-8 max-w-7xl mx-auto px-4 sm:px-6">
      {/* ── BREADCRUMB / BACK LINK ────────────────────────────────────────── */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-4 font-medium">
        <Link href="/history" className="hover:text-foreground flex items-center gap-1 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Lịch sử Operations
        </Link>
        <span>/</span>
        <span className="text-foreground font-mono truncate max-w-[200px]">{id}</span>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          RECORD ACTION BAR (Sticky Enterprise Top Bar)
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="record-action-bar">
        {/* Left Side: Record Identity & Status Badge */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase font-semibold text-muted-foreground tracking-wider">Record</span>
            <span className="font-mono text-sm font-bold text-foreground bg-muted px-2 py-0.5 rounded border border-border">
              {id.slice(0, 8)}...{id.slice(-6)}
            </span>
            <button
              onClick={handleCopyId}
              title="Sao chép ID"
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
            >
              {copiedId ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>

          {/* Status Badge */}
          {isRunning && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang xử lý ({metadata.progress_percent}%)
            </span>
          )}
          {isWaitingInput && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              <Clock className="w-3.5 h-3.5" /> Chờ duyệt dữ liệu (HITL)
            </span>
          )}
          {isSuccess && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-green-50 dark:bg-green-950/50 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400" /> Hoàn tất
            </span>
          )}
          {isFailed && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
              <XCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" /> Thất bại
            </span>
          )}
          {isCancelled && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
              <Ban className="w-3.5 h-3.5" /> Đã hủy
            </span>
          )}
        </div>

        {/* Right Side: Primary & Secondary Actions */}
        <div className="record-action-group">
          {/* Manual Refresh */}
          <button
            onClick={() => fetchOp(true)}
            disabled={refreshing}
            className="btn-outline inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md"
            title="Làm mới trạng thái"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Làm mới</span>
          </button>

          {/* HITL Resume Action */}
          {isWaitingInput && (
            <button
              onClick={() => setShowResumeModal(true)}
              className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md bg-amber-600 hover:bg-amber-700 text-white"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Tiếp tục / Nhập liệu</span>
            </button>
          )}

          {/* Cancel Action */}
          {(isRunning || isWaitingInput) && (
            <button
              onClick={handleCancelOperation}
              disabled={isCancelling}
              className="btn-danger inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md"
            >
              <Ban className="w-3.5 h-3.5" />
              <span>{isCancelling ? 'Đang hủy...' : 'Hủy tác vụ'}</span>
            </button>
          )}

          {/* Download Action */}
          {(result?.download_url || result?.content) && (
            <button
              onClick={handleDownload}
              className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Tải kết quả</span>
            </button>
          )}

          {/* Copy Output Action */}
          <button
            onClick={handleCopyContent}
            className="btn-outline inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md"
          >
            {copiedContent ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{copiedContent ? 'Đã sao chép' : 'Sao chép JSON'}</span>
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          HITL WAITING NOTICE
      ══════════════════════════════════════════════════════════════════════ */}
      {isWaitingInput && (
        <div className="mb-6 p-4 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-bold text-amber-900 dark:text-amber-200">
                Tác vụ đang tạm dừng để người dùng duyệt (Human-in-the-Loop)
              </h3>
              <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                Bước hiện tại ({metadata.pipeline[metadata.current_step] || `Step ${metadata.current_step + 1}`}) yêu cầu xác thực hoặc bổ sung tham số trước khi chuyển tiếp pipeline.
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowResumeModal(true)}
            className="btn-primary shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold rounded-md bg-amber-600 hover:bg-amber-700 text-white shadow-xs"
          >
            <Play className="w-4 h-4" />
            Mở bảng nhập liệu & Resume
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ERROR NOTICE
      ══════════════════════════════════════════════════════════════════════ */}
      {isFailed && opError && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-bold text-red-900 dark:text-red-200">
                Lỗi thực thi: {opError.code}
              </h3>
              <p className="text-xs text-red-800 dark:text-red-300 mt-1 font-mono">
                {opError.message}
              </p>
              {opError.failed_step !== undefined && (
                <p className="text-xs text-red-700 dark:text-red-400 mt-2">
                  Bước gặp sự cố: <strong>Step {opError.failed_step + 1}</strong> ({metadata.pipeline[opError.failed_step] || 'Unknown'})
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          METADATA FIELD GRID (Key-Value Detail Cards)
      ══════════════════════════════════════════════════════════════════════ */}
      <section className="mb-6">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
          Thông tin tổng quan bản ghi
        </h2>
        <div className="detail-field-grid">
          <div className="field-card">
            <span className="field-label">Trạng thái</span>
            <div className="flex items-center justify-between">
              <span className="field-value font-bold">{state}</span>
              <span className="text-xs font-semibold text-muted-foreground">{metadata.progress_percent}%</span>
            </div>
          </div>

          <div className="field-card">
            <span className="field-label">Thời điểm tạo</span>
            <span className="field-value">
              {new Date(metadata.create_time).toLocaleString('vi-VN')}
            </span>
          </div>

          <div className="field-card">
            <span className="field-label">Thời điểm cập nhật</span>
            <span className="field-value">
              {new Date(metadata.update_time).toLocaleString('vi-VN')}
            </span>
          </div>

          <div className="field-card">
            <span className="field-label">Số bước Pipeline</span>
            <span className="field-value">
              {metadata.pipeline?.length ?? 1} Bước
            </span>
          </div>

          <div className="field-card">
            <span className="field-label">Mô hình AI</span>
            <span className="field-value">
              {result?.usage?.model_used || 'Standard'}
            </span>
          </div>

          <div className="field-card">
            <span className="field-label">Tổng Tokens</span>
            <span className="field-value font-mono">
              {result?.usage ? (result.usage.input_tokens + result.usage.output_tokens).toLocaleString() : '—'}
            </span>
          </div>

          <div className="field-card">
            <span className="field-label">Số trang xử lý</span>
            <span className="field-value font-mono">
              {result?.usage?.pages_processed ?? 1} trang
            </span>
          </div>

          <div className="field-card">
            <span className="field-label">Chi phí ước tính</span>
            <span className="field-value font-mono font-semibold text-primary">
              {result?.usage?.cost_usd !== undefined ? `$${result.usage.cost_usd.toFixed(4)}` : '—'}
            </span>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          PIPELINE STEPPER / EXECUTION TIMELINE (Flat Linear Design)
      ══════════════════════════════════════════════════════════════════════ */}
      <section className="mb-6 modern-card p-5">
        <div className="flex items-center justify-between mb-4 border-b border-border pb-3">
          <div>
            <h3 className="text-sm font-bold text-foreground">Tiến trình Pipeline</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {metadata.progress_message || 'Các processor được xâu chuỗi tuần tự'}
            </p>
          </div>
          <span className="text-xs font-mono font-semibold bg-muted px-2 py-0.5 rounded text-foreground border border-border">
            Bước {Math.min(metadata.current_step + 1, metadata.pipeline.length)} / {metadata.pipeline.length}
          </span>
        </div>

        {/* Progress Bar (Solid, no gradient) */}
        {isRunning && (
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden mb-6">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${metadata.progress_percent}%` }}
            />
          </div>
        )}

        {/* Linear Step Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {metadata.pipeline.map((p, idx) => {
            const isCurrent = metadata.current_step === idx && isRunning;
            const isWaitingThis = metadata.current_step === idx && isWaitingInput;
            const isPassed = data.done || metadata.current_step > idx;
            const isFailedThis = isFailed && opError?.failed_step === idx;

            return (
              <div
                key={idx}
                className={`p-3 rounded-md border text-sm transition-colors ${
                  isFailedThis
                    ? 'border-red-400 bg-red-50 dark:bg-red-950/20'
                    : isWaitingThis
                    ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/20'
                    : isCurrent
                    ? 'border-primary bg-primary/5'
                    : isPassed
                    ? 'border-border bg-card'
                    : 'border-border/60 bg-muted/30 opacity-70'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-muted-foreground uppercase">
                    Step {idx + 1}
                  </span>
                  {isFailedThis && <XCircle className="w-4 h-4 text-destructive" />}
                  {isWaitingThis && <Clock className="w-4 h-4 text-amber-600 animate-pulse" />}
                  {isCurrent && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
                  {isPassed && !isFailedThis && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                </div>
                <p className="font-semibold text-foreground truncate">{p}</p>
                <span className="text-[11px] text-muted-foreground block mt-1">
                  {isFailedThis ? 'Gặp sự cố' : isWaitingThis ? 'Chờ nhập liệu' : isCurrent ? 'Đang thực thi...' : isPassed ? 'Hoàn tất' : 'Chờ thực hiện'}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          CONTENT / RESULT TABS (Detail View)
      ══════════════════════════════════════════════════════════════════════ */}
      <section className="mb-6 modern-card overflow-hidden">
        {/* Tab Headers */}
        <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveTab('content')}
              className={`px-3 py-3 text-xs font-semibold border-b-2 transition-colors ${
                activeTab === 'content'
                  ? 'border-primary text-primary bg-card'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" />
                Văn bản hoàn chỉnh
              </span>
            </button>

            {result?.extracted_data !== undefined && (
              <button
                onClick={() => setActiveTab('extracted')}
                className={`px-3 py-3 text-xs font-semibold border-b-2 transition-colors ${
                  activeTab === 'extracted'
                    ? 'border-primary text-primary bg-card'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5" />
                  Dữ liệu trích xuất (JSON)
                </span>
              </button>
            )}

            {result?.pipeline_steps && result.pipeline_steps.length > 0 && (
              <button
                onClick={() => setActiveTab('steps')}
                className={`px-3 py-3 text-xs font-semibold border-b-2 transition-colors ${
                  activeTab === 'steps'
                    ? 'border-primary text-primary bg-card'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5" />
                  Chi tiết từng bước ({result.pipeline_steps.length})
                </span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 py-2">
            <button
              onClick={handleCopyContent}
              className="btn-outline inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded"
              title="Sao chép nội dung tab hiện tại"
            >
              {copiedContent ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
              <span>{copiedContent ? 'Đã chép' : 'Sao chép'}</span>
            </button>
          </div>
        </div>

        {/* Tab Body */}
        <div className="p-5">
          {activeTab === 'content' && (
            <div>
              {result?.content ? (
                <div className="bg-muted/30 p-4 rounded-md border border-border font-mono text-sm leading-relaxed whitespace-pre-wrap max-h-[600px] overflow-auto text-foreground select-text">
                  {result.content}
                </div>
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {isRunning ? 'Nội dung đang được sinh...' : 'Không có nội dung văn bản trả về.'}
                </div>
              )}
            </div>
          )}

          {activeTab === 'extracted' && (
            <div>
              {result?.extracted_data !== undefined ? (
                <pre className="bg-muted/30 p-4 rounded-md border border-border font-mono text-xs leading-relaxed max-h-[600px] overflow-auto text-foreground select-text">
                  {JSON.stringify(result.extracted_data, null, 2)}
                </pre>
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  Không có dữ liệu trích xuất cấu trúc.
                </div>
              )}
            </div>
          )}

          {activeTab === 'steps' && (
            <div className="space-y-4">
              {result?.pipeline_steps?.map((stepItem) => (
                <div key={stepItem.step} className="border border-border rounded-md p-4 bg-muted/20">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold px-2 py-0.5 bg-primary/10 text-primary rounded">
                        Step {stepItem.step + 1}
                      </span>
                      <span className="text-sm font-semibold text-foreground">{stepItem.processor}</span>
                    </div>
                    <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                      {stepItem.output_format}
                    </span>
                  </div>

                  {stepItem.content_preview && (
                    <div className="mt-2">
                      <span className="text-xs font-semibold text-muted-foreground block mb-1">Preview:</span>
                      <pre className="text-xs bg-muted/50 p-2.5 rounded border border-border overflow-auto max-h-[160px] text-foreground">
                        {stepItem.content_preview}
                      </pre>
                    </div>
                  )}

                  {stepItem.extracted_data !== undefined && (
                    <div className="mt-2">
                      <span className="text-xs font-semibold text-muted-foreground block mb-1">Dữ liệu trích xuất:</span>
                      <pre className="text-xs bg-muted/50 p-2.5 rounded border border-border overflow-auto max-h-[160px] text-foreground font-mono">
                        {JSON.stringify(stepItem.extracted_data, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          USAGE & COST BREAKDOWN TABLE (Data Table)
      ══════════════════════════════════════════════════════════════════════ */}
      {result?.usage?.breakdown && result.usage.breakdown.length > 0 && (
        <section className="mb-8">
          <div className="mb-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Bảng kê phân bổ chi phí & tài nguyên (Resource Accounting)
            </h2>
          </div>

          <div className="data-table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Processor / Thành phần</th>
                  <th className="text-right">Input Tokens</th>
                  <th className="text-right">Output Tokens</th>
                  <th className="text-right">Tổng Tokens</th>
                  <th className="text-right">Chi phí ước tính (USD)</th>
                </tr>
              </thead>
              <tbody>
                {result.usage.breakdown.map((row, i) => (
                  <tr key={i}>
                    <td className="font-semibold">{row.processor}</td>
                    <td className="text-right font-mono text-muted-foreground">{row.input_tokens.toLocaleString()}</td>
                    <td className="text-right font-mono text-muted-foreground">{row.output_tokens.toLocaleString()}</td>
                    <td className="text-right font-mono font-medium">{(row.input_tokens + row.output_tokens).toLocaleString()}</td>
                    <td className="text-right font-mono font-semibold text-primary">${row.cost_usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/50 font-bold border-t border-border">
                  <td className="px-4 py-3">Tổng cộng</td>
                  <td className="px-4 py-3 text-right font-mono">{result.usage.input_tokens.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-mono">{result.usage.output_tokens.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-mono">{(result.usage.input_tokens + result.usage.output_tokens).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-mono text-primary">${result.usage.cost_usd.toFixed(4)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          HITL RESUME MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {showResumeModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between bg-muted/40">
              <div className="flex items-center gap-2">
                <Play className="w-4 h-4 text-amber-600" />
                <h3 className="text-base font-bold text-foreground">Xác nhận dữ liệu & Tiếp tục Pipeline</h3>
              </div>
              <button
                onClick={() => setShowResumeModal(false)}
                className="text-muted-foreground hover:text-foreground text-sm font-semibold p-1"
              >
                ✕
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              <p className="text-xs text-muted-foreground">
                Vui lòng kiểm tra hoặc chỉnh sửa payload JSON trước khi tiếp tục. Hệ thống sẽ lưu dữ liệu cập nhật và kích hoạt worker bước kế tiếp.
              </p>

              <div>
                <label className="text-xs font-semibold uppercase text-muted-foreground block mb-1">
                  Payload trích xuất (JSON):
                </label>
                <textarea
                  value={resumeDataJson}
                  onChange={(e) => setResumeDataJson(e.target.value)}
                  rows={14}
                  className="input-field font-mono text-xs w-full resize-y"
                  placeholder="{}"
                />
              </div>
            </div>

            <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-3 bg-muted/20">
              <button
                onClick={() => setShowResumeModal(false)}
                className="btn-outline px-4 py-2 text-xs font-semibold rounded-md"
              >
                Đóng
              </button>
              <button
                onClick={handleSubmitResume}
                disabled={isSubmittingResume}
                className="btn-primary px-4 py-2 text-xs font-bold rounded-md bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1.5"
              >
                {isSubmittingResume && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Gửi và Resume Pipeline</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
