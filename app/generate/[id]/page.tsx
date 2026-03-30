'use client';

// app/generate/[id]/page.tsx
// Trang hiển thị kết quả generation: poll status → preview → download

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2, CheckCircle, XCircle, Download, ArrowLeft, Eye, Code } from 'lucide-react';
import MarkdownPreview from '@/components/MarkdownPreview';

interface GenerationResult {
  id: string;
  fileName: string;
  fileType: string;
  outputFormat: string;
  userPrompt: string;
  outputContent: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
}

function getBaseName(filePath: string) {
  return filePath?.split('/').pop()?.split('\\').pop()?.replace(/^input\./, '') ?? filePath;
}

export default function GenerateResultPage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData]         = useState<GenerationResult | null>(null);
  const [loading, setLoading]   = useState(true);
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');

  useEffect(() => {
    if (!id) return;
    let interval: ReturnType<typeof setInterval>;

    const poll = async () => {
      try {
        const res = await fetch(`/api/generate/${id}`);
        if (res.ok) {
          const json = await res.json();
          setData(json);
          setLoading(false);
          if (json.status === 'completed' || json.status === 'failed') {
            clearInterval(interval);
          }
        }
      } catch {
        // keep polling
      }
    };

    poll();
    interval = setInterval(poll, 2_000);
    return () => clearInterval(interval);
  }, [id]);

  // ─── Status states ─────────────────────────────────────────────────────────────
  if (loading || !data) {
    return (
      <main className="py-16 text-center">
        <Loader2 className="w-10 h-10 animate-spin text-[#00B74F] mx-auto mb-4" />
        <p className="text-slate-500 dark:text-zinc-400 font-bold">Đang tải...</p>
      </main>
    );
  }

  const isPending    = data.status === 'pending' || data.status === 'processing';
  const isCompleted  = data.status === 'completed';
  const isFailed     = data.status === 'failed';
  const fileName     = getBaseName(data.fileName);
  const downloadUrl  = `/api/generate/${id}/download`;
  const ext          = data.outputFormat === 'html' ? 'html' : 'md';

  return (
    <main className="py-8">
      <div className="max-w-5xl mx-auto px-4">

        {/* Header */}
        <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
          <div>
            <Link
              href="/generate"
              className="text-sm text-slate-500 dark:text-zinc-400 hover:text-[#00B74F] dark:hover:text-[#00B74F] font-bold flex items-center gap-1 mb-3 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Tạo tài liệu mới
            </Link>
            <h1 className="text-2xl font-bold font-heading text-[#00B74F]">
              {fileName}
            </h1>
            <p className="text-slate-500 dark:text-zinc-400 text-sm mt-1 max-w-xl line-clamp-2">
              <span className="font-bold text-slate-700 dark:text-zinc-300">Prompt:</span> {data.userPrompt}
            </p>
          </div>

          {isCompleted && (
            <a
              href={downloadUrl}
              download
              className="btn-primary flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-colors"
            >
              <Download className="w-4 h-4" />
              Tải .{ext}
            </a>
          )}
        </div>

        {/* Processing state */}
        {isPending && (
          <div className="flex flex-col items-center py-20 text-center">
            <Loader2 className="w-12 h-12 animate-spin text-[#00B74F] mb-4" />
            <p className="text-slate-700 dark:text-zinc-200 font-bold text-lg mb-2">
              {data.status === 'pending' ? 'Đang chuẩn bị...' : 'AI đang tạo tài liệu...'}
            </p>
            <p className="text-slate-400 dark:text-zinc-500 font-medium text-sm">
              Quá trình này có thể mất 30–120 giây tùy kích thước tài liệu.
            </p>
          </div>
        )}

        {/* Failed state */}
        {isFailed && (
          <div className="flex flex-col items-center py-16">
            <XCircle className="w-12 h-12 text-[#E00500] mb-4" />
            <p className="text-[#E00500] font-bold text-lg mb-2">Tạo tài liệu thất bại</p>
            {data.errorMessage && (
              <p className="text-[#E00500] text-sm bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 font-medium rounded-lg px-4 py-2 max-w-lg">
                {data.errorMessage}
              </p>
            )}
            <Link
              href="/generate"
              className="mt-6 font-bold text-[#00B74F] hover:underline text-sm"
            >
              Thử lại
            </Link>
          </div>
        )}

        {/* Completed state */}
        {isCompleted && data.outputContent && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-[#00B74F] text-sm font-bold">
              <CheckCircle className="w-4 h-4" />
              Tạo tài liệu thành công
            </div>

            {/* View mode toggle */}
            <div className="flex items-center gap-1 border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 rounded-lg p-1 w-fit">
              <button
                onClick={() => setViewMode('preview')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
                  viewMode === 'preview'
                    ? 'bg-white dark:bg-zinc-900 shadow-sm text-[#00B74F] font-bold dark:shadow-[0_0_10px_rgba(255,255,255,0.05)]'
                    : 'text-slate-500 dark:text-zinc-500 font-bold hover:text-slate-700 dark:hover:text-zinc-300'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                Preview
              </button>
              <button
                onClick={() => setViewMode('raw')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
                  viewMode === 'raw'
                    ? 'bg-white dark:bg-zinc-900 shadow-sm text-[#00B74F] font-bold dark:shadow-[0_0_10px_rgba(255,255,255,0.05)]'
                    : 'text-slate-500 dark:text-zinc-500 font-bold hover:text-slate-700 dark:hover:text-zinc-300'
                }`}
              >
                <Code className="w-3.5 h-3.5" />
                Raw
              </button>
            </div>

            {/* Content */}
            <div className="border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 transition-colors rounded-xl overflow-hidden">
              {viewMode === 'raw' ? (
                <pre className="p-6 text-sm font-mono text-slate-800 dark:text-zinc-200 whitespace-pre-wrap overflow-auto bg-slate-50 dark:bg-zinc-900/40 max-h-[70vh]">
                  {data.outputContent}
                </pre>
              ) : data.outputFormat === 'html' ? (
                <div
                  className="p-6 prose dark:prose-invert prose-sm max-w-none max-h-[70vh] overflow-auto bg-white dark:bg-zinc-900/60"
                  dangerouslySetInnerHTML={{ __html: data.outputContent }}
                />
              ) : (
                <div className="p-0 max-h-[70vh] overflow-auto bg-white dark:bg-zinc-900/60">
                  <MarkdownPreview content={data.outputContent} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
