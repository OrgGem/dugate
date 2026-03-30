'use client';

// app/transform/[id]/page.tsx
// Trang kết quả: polling status → preview/edit/download

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Download, Pencil, Eye, ArrowLeft, RefreshCw, Loader2 } from 'lucide-react';
import StatusBadge, { type ConversionStatus } from '@/components/StatusBadge';
import MarkdownPreview from '@/components/MarkdownPreview';
import MarkdownEditor from '@/components/MarkdownEditor';

interface ConversionData {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  compressedSize: number | null;
  compressLevel: string | null;
  status: ConversionStatus;
  progressText: string | null;
  filesDeleted: boolean;
  errorMessage: string | null;
  imageCount: number;
  fullMd: string | null;
  textOnlyMd: string | null;
  createdAt: string;
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
}

const STATUS_MESSAGES: Record<string, string> = {
  pending:     'Chờ xử lý...',
  compressing: 'Đang nén file và trích xuất hình...',
  processing:  'Đang mô tả hình ảnh với AI...',
};

export default function ConvertResultPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ConversionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'full' | 'text-only'>('full');
  const [editMode, setEditMode] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/transform/${id}`);
      if (!res.ok) { setError('Không tìm thấy transformation'); return; }
      const json: ConversionData = await res.json();
      setData(json);
    } catch {
      setError('Lỗi kết nối server');
    }
  }, [id]);

  // Polling
  useEffect(() => {
    fetchData();
    const interval = setInterval(() => {
      setData(prev => {
        if (prev && (prev.status === 'completed' || prev.status === 'failed')) {
          clearInterval(interval);
          return prev;
        }
        return prev;
      });
      fetchData();
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Stop polling when done
  useEffect(() => {
    if (data?.status === 'completed' || data?.status === 'failed') return;
  }, [data]);

  if (error) {
    return (
      <div className="py-16 text-center">
        <p className="text-[#E00500] dark:text-red-400 font-bold">{error}</p>
        <Link href="/" className="mt-4 inline-block text-[#00B74F] font-bold hover:underline">← Về trang chủ</Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="py-16 flex justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#00B74F]" />
      </div>
    );
  }

  const isDocx = data.fileType === 'docx';

  // PDF: fullMd = textOnlyMd (Gemini đã mô tả hình inline)
  //       textOnly = strip các block > **[Image]:** ...
  // DOCX: fullMd = có bảng mô tả hình riêng, textOnlyMd = chỉ text
  const fullMdContent = data.fullMd ?? data.textOnlyMd ?? '';
  const textOnlyMdContent = !isDocx
    ? (data.textOnlyMd ?? '').replace(/^>\s*\*\*\[Image\]:\*\*[^\n]*(\n|$)/gm, '').replace(/^>\s*\[Image\][^\n]*(\n|$)/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    : (data.textOnlyMd ?? '');
  const activeContent = activeTab === 'full' ? fullMdContent : textOnlyMdContent;

  // ─── Processing state ──────────────────────────────────────────────────────
  if (data.status !== 'completed' && data.status !== 'failed') {
    return (
      <div className="py-16 text-center">
        <div className="inline-flex items-center gap-3 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl px-6 py-4 shadow-sm">
          <Loader2 className="w-5 h-5 animate-spin text-[#00B74F]" />
          <div className="text-left">
            <StatusBadge status={data.status} />
            <p className="text-sm font-medium text-slate-600 dark:text-zinc-400 mt-1">
              {data.progressText ?? STATUS_MESSAGES[data.status] ?? 'Đang xử lý...'}
            </p>
          </div>
        </div>
        <p className="text-xs font-semibold text-slate-400 dark:text-zinc-500 mt-4">Trang này tự cập nhật mỗi 2 giây</p>
      </div>
    );
  }

  // ─── Failed state ──────────────────────────────────────────────────────────
  if (data.status === 'failed') {
    return (
      <div className="py-12 max-w-xl mx-auto">
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl p-6">
          <StatusBadge status="failed" className="mb-3" />
          <h2 className="font-bold text-slate-900 dark:text-zinc-100 mb-2">{data.fileName}</h2>
          <p className="text-sm text-[#E00500] font-mono bg-red-100 dark:bg-red-500/20 rounded-lg p-3 mt-2 font-medium">
            {data.errorMessage ?? 'Lỗi không xác định'}
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-[#E00500] hover:underline"
          >
            <ArrowLeft className="w-4 h-4" /> Upload lại
          </Link>
        </div>
      </div>
    );
  }

  // ─── Files deleted ─────────────────────────────────────────────────────────
  if (data.filesDeleted) {
    return (
      <div className="py-12 max-w-xl mx-auto">
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl p-6">
          <h2 className="font-bold text-slate-900 dark:text-zinc-100 mb-2">{data.fileName}</h2>
          <p className="text-sm font-medium text-amber-700 dark:text-amber-500">
            File đã được xóa tự động sau 24h. Vui lòng transform lại nếu cần.
          </p>
          <Link href="/" className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-[#00B74F] hover:underline">
            <ArrowLeft className="w-4 h-4" /> Upload lại
          </Link>
        </div>
      </div>
    );
  }

  // ─── Completed ─────────────────────────────────────────────────────────────
  const zipUrl = `/api/transform/${id}/download`;

  return (
    <div className="py-8 space-y-6">
      {/* Back + title */}
      <div className="flex items-center gap-3">
        <Link href="/" className="p-2 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg transition-colors">
          <ArrowLeft className="w-4 h-4 text-slate-600 dark:text-zinc-400" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-slate-900 dark:text-zinc-100 truncate">{data.fileName}</h1>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {/* Info bar */}
      <div className="flex flex-wrap gap-3 text-sm text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/50 rounded-lg px-4 py-3 border border-slate-100 dark:border-zinc-800">
        <span className="font-bold text-slate-700 dark:text-zinc-200 uppercase text-xs">{data.fileType}</span>
        <span>•</span>
        <span>Gốc: {formatBytes(data.fileSize)}</span>
        {data.compressedSize && (
          <>
            <span>→</span>
            <span>Nén: {formatBytes(data.compressedSize)}</span>
          </>
        )}
        {data.imageCount > 0 && (
          <>
            <span>•</span>
            <span>{data.imageCount} hình</span>
          </>
        )}
      </div>

      {/* Tab switcher — hiển thị cho cả DOCX và PDF */}
      {!editMode && (
        <div className="flex gap-2 border-b border-slate-200 dark:border-zinc-800">
          {(['full', 'text-only'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-bold transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? 'border-[#00B74F] text-[#00B74F]'
                  : 'border-transparent text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300'
              }`}
            >
              {tab === 'full'
                ? (isDocx ? 'Full (có hình)' : 'Full (có mô tả hình)')
                : 'Text-only'
              }
            </button>
          ))}
        </div>
      )}

      {/* Edit/Preview toggle bar */}
      {!editMode && (
        <div className="flex justify-end">
          <button
            onClick={() => setEditMode(true)}
            className="flex items-center gap-2 px-4 py-2 border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-300 rounded-lg text-sm font-bold hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
          >
            <Pencil className="w-4 h-4" />
            Chỉnh sửa
          </button>
        </div>
      )}

      {/* Content */}
      {editMode ? (
        <MarkdownEditor
          conversionId={id}
          initialFullMd={isDocx ? data.fullMd : data.textOnlyMd}
          initialTextOnlyMd={isDocx ? (data.textOnlyMd ?? '') : textOnlyMdContent}
          activeTab={activeTab}
          onSave={(fMd, tMd) => {
            setData(prev => prev ? { ...prev, fullMd: fMd, textOnlyMd: tMd } : prev);
            setEditMode(false);
          }}
          onCancel={() => setEditMode(false)}
        />
      ) : (
        <MarkdownPreview content={activeContent ?? ''} />
      )}

      {/* Download sticky bar */}
      <div className="sticky bottom-4 flex justify-center">
        <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-lg dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)] px-6 py-3 flex items-center gap-4 transition-colors">
          <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">
            {isDocx ? 'ZIP: full.md + text-only.md + hình gốc' : 'ZIP: text-only.md'}
          </div>
          <a
            href={zipUrl}
            className="btn-primary flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-colors"
          >
            <Download className="w-4 h-4" />
            Tải ZIP
          </a>
        </div>
      </div>
    </div>
  );
}
