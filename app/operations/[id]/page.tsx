'use client';

// app/operations/[id]/page.tsx
// Unified result page for ALL operation types (transform, compare, generate)
// Polls GET /api/operations/{id} until done, then displays result

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, CheckCircle2, XCircle, Download, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

interface OperationData {
  name: string;
  done: boolean;
  metadata: {
    state: string;
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
  const id = params.id as string;

  const [data, setData] = useState<OperationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  const fetchOp = useCallback(async () => {
    try {
      const res = await fetch(`/api/operations/${id}`);
      if (res.ok) {
        const d = await res.json();
        setData(d);
        return d.done;
      }
    } catch {}
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
          const d = await fetchOp();
          if (d && active) clearInterval(interval);
        }, 2000);
      }
    }

    poll();
    return () => { active = false; clearInterval(interval); };
  }, [fetchOp]);

  async function handleCopy() {
    if (!data?.result?.content) return;
    await navigator.clipboard.writeText(data.result.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <main className="py-24 text-center">
        <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto mb-4" />
        <p className="text-muted-foreground font-medium">Đang tải...</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="py-24 text-center">
        <XCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
        <p className="text-foreground font-bold text-xl">Không tìm thấy Operation</p>
      </main>
    );
  }

  const { metadata, result, error: opError } = data;
  const isRunning = !data.done;
  const isSuccess = data.done && metadata.state === 'SUCCEEDED';
  const isFailed = data.done && metadata.state === 'FAILED';
  const isCancelled = data.done && metadata.state === 'CANCELLED';

  return (
    <main className="py-12 max-w-5xl mx-auto px-4">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          {isRunning && <Loader2 className="w-6 h-6 animate-spin text-primary" />}
          {isSuccess && <CheckCircle2 className="w-6 h-6 text-green-500" />}
          {isFailed && <XCircle className="w-6 h-6 text-destructive" />}
          {isCancelled && <XCircle className="w-6 h-6 text-muted-foreground" />}

          <h1 className="text-2xl font-extrabold text-foreground">
            {isRunning ? 'Đang xử lý...' : isSuccess ? 'Hoàn tất' : isFailed ? 'Thất bại' : 'Đã hủy'}
          </h1>
        </div>

        <div className="flex flex-wrap gap-2 mt-3">
          {metadata.pipeline.map((p, i) => (
            <span
              key={i}
              className={`px-3 py-1 rounded-full text-xs font-bold border ${
                isFailed && opError?.failed_step === i
                  ? 'bg-destructive/10 text-destructive border-destructive/20'
                  : metadata.current_step >= i || data.done
                  ? 'bg-primary/10 text-primary border-primary/20'
                  : 'bg-muted text-muted-foreground border-border'
              }`}
            >
              Step {i + 1}: {p}
            </span>
          ))}
        </div>
      </div>

      {/* Progress Bar */}
      {isRunning && (
        <div className="modern-card p-6 mb-8">
          <div className="flex justify-between text-sm font-bold text-foreground mb-3">
            <span>{metadata.progress_message ?? 'Xử lý...'}</span>
            <span>{metadata.progress_percent}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary to-sky-500 rounded-full transition-all duration-500"
              style={{ width: `${metadata.progress_percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {isFailed && opError && (
        <div className="modern-card p-6 mb-8 border-destructive/30 bg-destructive/5">
          <h3 className="font-bold text-destructive mb-2">Lỗi: {opError.code}</h3>
          <p className="text-sm text-foreground">{opError.message}</p>
          {opError.failed_step !== undefined && (
            <p className="text-xs text-muted-foreground mt-2">Lỗi xảy ra tại Step {opError.failed_step + 1}</p>
          )}
        </div>
      )}

      {/* Result Content */}
      {result?.content && (
        <div className="modern-card p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-foreground">Kết quả</h3>
            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border border-border bg-card hover:bg-muted transition-colors text-foreground"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Đã copy!' : 'Copy'}
              </button>
              {result.download_url && (
                <a
                  href={result.download_url}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border border-primary/20 bg-primary/10 hover:bg-primary/20 transition-colors text-primary"
                >
                  <Download className="w-3.5 h-3.5" />
                  Tải xuống
                </a>
              )}
            </div>
          </div>
          <div className="prose prose-sm dark:prose-invert max-w-none overflow-auto max-h-[600px] p-4 bg-muted/50 rounded-xl border border-border font-mono text-sm whitespace-pre-wrap">
            {result.content}
          </div>
        </div>
      )}

      {/* Extracted Data (JSON) */}
      {!!result?.extracted_data && (
        <div className="modern-card p-6 mb-8">
          <h3 className="font-bold text-foreground mb-4">Dữ liệu trích xuất</h3>
          <pre className="bg-muted/50 p-4 rounded-xl border border-border overflow-auto max-h-[400px] text-sm font-mono text-foreground">
            {JSON.stringify(result.extracted_data, null, 2)}
          </pre>
        </div>
      )}

      {/* Pipeline Steps (collapsed by default) */}
      {result?.pipeline_steps && result.pipeline_steps.length > 1 && (
        <div className="modern-card p-6 mb-8">
          <button
            onClick={() => setShowSteps(!showSteps)}
            className="flex items-center gap-2 w-full text-left font-bold text-foreground"
          >
            {showSteps ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            Pipeline Steps ({result.pipeline_steps.length} bước)
          </button>

          {showSteps && (
            <div className="mt-4 space-y-4">
              {result.pipeline_steps.map((step) => (
                <div key={step.step} className="p-4 bg-muted/50 rounded-xl border border-border">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs font-bold rounded">Step {step.step + 1}</span>
                    <span className="text-sm font-bold text-foreground">{step.processor}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{step.output_format}</span>
                  </div>
                  {step.content_preview && (
                    <pre className="text-xs text-muted-foreground overflow-auto max-h-[200px] whitespace-pre-wrap mt-2">
                      {step.content_preview}
                    </pre>
                  )}
                  {!!step.extracted_data && (
                    <pre className="text-xs text-muted-foreground overflow-auto max-h-[200px] mt-2">
                      {JSON.stringify(step.extracted_data, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Usage */}
      {result?.usage && (
        <div className="modern-card p-6">
          <h3 className="font-bold text-foreground mb-4">Chi phí & Thống kê</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="text-center p-3 bg-muted/50 rounded-xl border border-border">
              <p className="text-2xl font-extrabold text-primary">{result.usage.input_tokens.toLocaleString()}</p>
              <p className="text-xs font-medium text-muted-foreground">Input Tokens</p>
            </div>
            <div className="text-center p-3 bg-muted/50 rounded-xl border border-border">
              <p className="text-2xl font-extrabold text-primary">{result.usage.output_tokens.toLocaleString()}</p>
              <p className="text-xs font-medium text-muted-foreground">Output Tokens</p>
            </div>
            <div className="text-center p-3 bg-muted/50 rounded-xl border border-border">
              <p className="text-2xl font-extrabold text-foreground">{result.usage.model_used}</p>
              <p className="text-xs font-medium text-muted-foreground">Model</p>
            </div>
            <div className="text-center p-3 bg-muted/50 rounded-xl border border-border">
              <p className="text-2xl font-extrabold text-green-500">${result.usage.cost_usd.toFixed(4)}</p>
              <p className="text-xs font-medium text-muted-foreground">Chi phí</p>
            </div>
          </div>

          {/* Per-step breakdown */}
          {result.usage.breakdown && result.usage.breakdown.length > 1 && (
            <div className="mt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 font-bold text-muted-foreground">Processor</th>
                    <th className="text-right py-2 font-bold text-muted-foreground">Input</th>
                    <th className="text-right py-2 font-bold text-muted-foreground">Output</th>
                    <th className="text-right py-2 font-bold text-muted-foreground">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {result.usage.breakdown.map((b, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-2 font-medium text-foreground">{b.processor}</td>
                      <td className="py-2 text-right text-muted-foreground">{b.input_tokens.toLocaleString()}</td>
                      <td className="py-2 text-right text-muted-foreground">{b.output_tokens.toLocaleString()}</td>
                      <td className="py-2 text-right text-green-500">${b.cost_usd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
