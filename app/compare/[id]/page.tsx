'use client';

// app/compare/[id]/page.tsx
// Trang kết quả so sánh — poll API đến khi completed/failed
// Hiển thị bảng 3 cột: Điều/Khoản | Nội dung File 1 | Nội dung File 2 | Ghi chú

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Loader2, Download, CheckCircle2, XCircle, GitCompareArrows } from 'lucide-react';

interface ComparisonRow {
  clause: string;
  file1Content: string;
  file2Content: string;
  note: string;
}

interface ComparisonData {
  id: string;
  file1Name: string;
  file2Name: string;
  status: string;
  errorMessage?: string;
  resultJson?: string;
  createdAt: string;
}

function noteType(note: string): 'added' | 'removed' | 'changed' {
  const lower = note.toLowerCase();
  if (lower.includes('thêm mới') || lower.includes('added')) return 'added';
  if (lower.includes('đã xóa') || lower.includes('removed') || lower.includes('deleted')) return 'removed';
  return 'changed';
}

function NoteBadge({ note }: { note: string }) {
  const type = noteType(note);
  const styles = {
    added:   'bg-green-50 text-green-700 border border-green-200',
    removed: 'bg-red-50 text-red-700 border border-red-200',
    changed: 'bg-amber-50 text-amber-700 border border-amber-200',
  };
  const icons = { added: '🟢', removed: '🔴', changed: '🟡' };

  return (
    <div className={`inline-flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${styles[type]}`}>
      <span>{icons[type]}</span>
      <span>{note}</span>
    </div>
  );
}

function exportCsv(rows: ComparisonRow[], file1Name: string, file2Name: string) {
  const header = ['Điều/Khoản', `Nội dung: ${file1Name}`, `Nội dung: ${file2Name}`, 'Ghi chú'];
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [
    header.map(escape).join(','),
    ...rows.map(r => [r.clause, r.file1Content, r.file2Content, r.note].map(escape).join(',')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `comparison-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CompareResultPage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<ComparisonData | null>(null);
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/compare/${id}`);
      if (!res.ok) {
        setError('Không thể tải kết quả.');
        return;
      }
      const json: ComparisonData = await res.json();
      setData(json);

      if (json.status === 'completed' && json.resultJson) {
        try {
          setRows(JSON.parse(json.resultJson));
        } catch {
          setError('Lỗi parse kết quả JSON.');
        }
      }
    } catch {
      setError('Lỗi kết nối server.');
    }
  }, [id]);

  useEffect(() => {
    poll();
    const interval = setInterval(() => {
      if (data?.status === 'completed' || data?.status === 'failed') return;
      poll();
    }, 3000);
    return () => clearInterval(interval);
  }, [poll, data?.status]);

  // Loading state
  if (!data) {
    return (
      <main className="py-12 flex flex-col items-center gap-4 text-slate-500 dark:text-zinc-400">
        <Loader2 className="w-8 h-8 animate-spin text-[#E00500]" />
        <p className="font-bold">Đang tải...</p>
      </main>
    );
  }

  // Processing state
  if (data.status === 'processing' || data.status === 'pending') {
    return (
      <main className="py-12 flex flex-col items-center gap-4 text-slate-500 dark:text-zinc-400">
        <Loader2 className="w-8 h-8 animate-spin text-[#E00500]" />
        <p className="font-bold text-slate-700 dark:text-zinc-200">Đang so sánh tài liệu...</p>
        <p className="text-sm font-medium text-slate-400 dark:text-zinc-500">Quá trình này có thể mất 30–120 giây tuỳ độ dài tài liệu.</p>
        <div className="mt-2 p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-lg text-sm font-medium text-blue-700 dark:text-blue-400 max-w-md text-center">
          <strong>{data.file1Name}</strong> vs <strong>{data.file2Name}</strong>
        </div>
      </main>
    );
  }

  // Failed state
  if (data.status === 'failed') {
    return (
      <main className="py-12 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 text-[#E00500] mb-4">
          <XCircle className="w-7 h-7" />
          <h1 className="text-xl font-bold">So sánh thất bại</h1>
        </div>
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg p-4 text-sm font-medium text-[#E00500]">
          {data.errorMessage ?? 'Lỗi không xác định.'}
        </div>
        <a href="/compare" className="mt-4 inline-block text-sm font-bold text-[#E00500] hover:underline">
          ← Thử lại
        </a>
      </main>
    );
  }

  // Completed state
  return (
    <main className="py-8 max-w-[1400px] mx-auto px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-500" />
            <h1 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Kết quả So sánh</h1>
          </div>
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            <span className="font-bold text-slate-700 dark:text-zinc-200">{data.file1Name}</span>
            {' '}vs{' '}
            <span className="font-bold text-slate-700 dark:text-zinc-200">{data.file2Name}</span>
            {' '}•{' '}
            {rows.length} điều khoản có thay đổi
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => exportCsv(rows, data.file1Name, data.file2Name)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-bold border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-300 rounded-lg hover:border-[#E00500] hover:text-[#E00500] dark:hover:border-[#E00500] dark:hover:text-[#E00500] transition-colors"
          >
            <Download className="w-4 h-4" />
            Xuất CSV
          </button>
          <a
            href="/compare"
            className="btn-danger flex items-center gap-1.5 px-3 py-2 text-sm font-bold rounded-lg transition-colors"
          >
            <GitCompareArrows className="w-4 h-4" />
            So sánh mới
          </a>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg text-sm font-medium text-[#E00500]">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="text-center py-16 text-slate-400 dark:text-zinc-500">
          <GitCompareArrows className="w-12 h-12 mx-auto mb-3 opacity-30 text-[#E00500] dark:opacity-50" />
          <p className="text-lg font-bold text-slate-700 dark:text-zinc-300">Không tìm thấy sự khác biệt nào</p>
          <p className="text-sm mt-1 font-medium">Hai tài liệu có toàn bộ điều khoản giống nhau.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-zinc-800 shadow-sm bg-white dark:bg-zinc-900/80 transition-colors">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-[#E00500] text-white">
                <th className="px-4 py-3 text-left font-bold w-[140px] whitespace-nowrap border-b border-[#E00500]">Điều / Khoản</th>
                <th className="px-4 py-3 text-left font-bold border-b border-[#E00500]">
                  📄 {data.file1Name}
                </th>
                <th className="px-4 py-3 text-left font-bold border-b border-[#E00500]">
                  📝 {data.file2Name}
                </th>
                <th className="px-4 py-3 text-left font-bold w-[220px] border-b border-[#E00500]">Ghi chú thay đổi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  className={`border-t border-slate-100 dark:border-zinc-800 align-top ${i % 2 === 0 ? 'bg-white dark:bg-zinc-800' : 'bg-slate-50 dark:bg-zinc-800/50'}`}
                >
                  <td className="px-4 py-3 font-bold text-[#E00500] whitespace-nowrap">
                    {row.clause}
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">
                    {row.file1Content || <span className="text-slate-300 dark:text-zinc-600 italic">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">
                    {row.file2Content || <span className="text-slate-300 dark:text-zinc-600 italic">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <NoteBadge note={row.note} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
