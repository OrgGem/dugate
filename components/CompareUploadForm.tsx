'use client';

// components/CompareUploadForm.tsx
// Upload 2 file → pipeline API prebuilt-compare

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileText, File, X, Loader2, GitCompareArrows } from 'lucide-react';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function validateFileClient(f: File): string | null {
  const ext = f.name.split('.').pop()?.toLowerCase();
  if (ext !== 'docx' && ext !== 'pdf') return 'Chỉ hỗ trợ .docx và .pdf';
  if (f.size > 300 * 1024 * 1024) return 'File quá lớn (tối đa 300MB)';
  return null;
}

interface FileSlotProps {
  label: string;
  hint: string;
  file: File | null;
  onFile: (f: File) => void;
  onRemove: () => void;
  id: string;
}

function FileSlot({ label, hint, file, onFile, onRemove, id }: FileSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = (f: File) => {
    const err = validateFileClient(f);
    if (err) { setError(err); return; }
    setError(null);
    onFile(f);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) accept(f);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isPdf = file?.name.toLowerCase().endsWith('.pdf');

  return (
    <div className="flex-1 min-w-0">
      <p className="text-sm font-bold text-foreground mb-2">{label}</p>
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !file && inputRef.current?.click()}
        className={`dropzone p-6 min-h-[160px] flex flex-col items-center justify-center ${
          dragging
            ? 'border-destructive bg-destructive/10'
            : file
            ? 'border-border bg-muted/50'
            : ''
        }`}
      >
        <input
          id={id}
          ref={inputRef}
          type="file"
          accept=".docx,.pdf"
          className="sr-only"
          onChange={e => { const f = e.target.files?.[0]; if (f) accept(f); }}
        />

        {file ? (
          <div className="w-full flex items-center gap-3 bg-card p-3 rounded-xl border border-border shadow-sm group">
            <div className="shrink-0 p-2 rounded-lg bg-muted border border-border/50">
              {isPdf
                ? <File className="w-6 h-6 text-destructive" />
                : <FileText className="w-6 h-6 text-primary" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-foreground truncate">{file.name}</p>
              <p className="text-xs font-semibold text-muted-foreground">{formatBytes(file.size)}</p>
            </div>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onRemove(); }}
              className="shrink-0 p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <>
            <Upload className="w-10 h-10 text-destructive mb-3 opacity-80" />
            <p className="text-sm text-foreground font-bold text-center">{hint}</p>
            <p className="text-xs font-medium text-muted-foreground mt-1 text-center">Kéo thả hoặc click để chọn</p>
          </>
        )}
      </div>
      {error && (
        <p className="mt-1.5 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}

export default function CompareUploadForm() {
  const router = useRouter();
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCompare() {
    if (!file1 || !file2) {
      setError('Vui lòng chọn đủ 2 file.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const form = new FormData();
      form.append('source_file', file1);
      form.append('target_file', file2);
      form.append('pipeline', JSON.stringify([{ processor: 'prebuilt-compare' }]));
      form.append('output_format', 'json');

      const res = await fetch('/api/documents/process', { method: 'POST', body: form });
      const data = await res.json();

      if (!res.ok) {
        setError(data.detail ?? data.title ?? 'Lỗi xử lý');
        setLoading(false);
        return;
      }

      const opId = data.name.replace('operations/', '');
      router.push(`/operations/${opId}`);
    } catch {
      setError('Lỗi kết nối server. Vui lòng thử lại.');
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-4xl mx-auto modern-card p-6 md:p-10">
      <div className="flex flex-col md:flex-row gap-6">
        <FileSlot
          id="file1-input"
          label="📄 File 1 — Phiên bản gốc / cũ"
          hint=".docx hoặc .pdf"
          file={file1}
          onFile={setFile1}
          onRemove={() => setFile1(null)}
        />
        <div className="hidden md:block w-px bg-border self-stretch my-2" />
        <FileSlot
          id="file2-input"
          label="📝 File 2 — Phiên bản mới / sửa đổi"
          hint=".docx hoặc .pdf"
          file={file2}
          onFile={setFile2}
          onRemove={() => setFile2(null)}
        />
      </div>

      {error && (
        <div className="mt-4 text-sm font-medium text-[#E00500] bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <button
        onClick={handleCompare}
        disabled={!file1 || !file2 || loading}
        className="mt-8 w-full btn-danger modern-button text-lg bg-[#E00500] hover:bg-[#b30400]"
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Đang xử lý...
          </>
        ) : (
          <>
            <GitCompareArrows className="w-5 h-5 mr-2" />
            So sánh tài liệu
          </>
        )}
      </button>
    </div>
  );
}
