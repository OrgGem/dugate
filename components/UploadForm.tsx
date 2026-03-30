'use client';

// components/UploadForm.tsx
// Unified upload form — uses new Pipeline API

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileText, File, X, Loader2 } from 'lucide-react';

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

export default function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalSize = files.reduce((s, f) => s + f.size, 0);

  function acceptFiles(incoming: FileList | File[]) {
    const arr = Array.from(incoming);
    const newFiles: File[] = [];
    const errs: string[] = [];

    for (const f of arr) {
      const err = validateFileClient(f);
      if (err) { errs.push(`${f.name}: ${err}`); continue; }
      if (!files.find(existing => existing.name === f.name)) {
        newFiles.push(f);
      }
    }

    if (errs.length > 0) setError(errs.join('\n'));
    else setError(null);

    if (newFiles.length > 0) setFiles(prev => [...prev, ...newFiles]);
  }

  function removeFile(name: string) {
    setFiles(prev => prev.filter(f => f.name !== name));
    setError(null);
  }

  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const onDragLeave = useCallback(() => setDragging(false), []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) acceptFiles(e.dataTransfer.files);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  async function handleConvert() {
    if (files.length === 0) return;
    setLoading(true);
    setError(null);

    try {
      // Use new Pipeline API — one file at a time, single processor
      const file = files[0]; // For now, process first file
      const form = new FormData();
      form.append('file', file);
      form.append('pipeline', JSON.stringify([{ processor: 'prebuilt-layout' }]));
      form.append('output_format', 'md');

      const res = await fetch('/api/documents/process', { method: 'POST', body: form });
      const data = await res.json();

      if (!res.ok) {
        setError(data.detail ?? data.title ?? 'Lỗi xử lý');
        setLoading(false);
        return;
      }

      // Extract operation ID from response name "operations/op-xxx"
      const opId = data.name.replace('operations/', '');
      router.push(`/operations/${opId}`);
    } catch {
      setError('Lỗi kết nối server. Vui lòng thử lại.');
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-2xl mx-auto modern-card p-6 md:p-8">
      <div
        onClick={() => files.length === 0 && inputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`dropzone relative ${
          dragging
            ? 'border-primary bg-primary/10'
            : files.length > 0
            ? 'border-border bg-muted/50'
            : ''
        } ${files.length === 0 ? 'p-12 text-center' : 'p-6'}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".docx,.pdf"
          className="sr-only"
          onChange={e => e.target.files && acceptFiles(e.target.files)}
        />

        {files.length === 0 ? (
          <>
            <Upload className="w-12 h-12 text-primary mx-auto mb-4 opacity-80" />
            <p className="text-foreground font-bold mb-2">Kéo thả file .docx hoặc .pdf vào đây</p>
            <p className="text-sm font-medium text-muted-foreground">hoặc click để chọn • Tối đa 300MB/file</p>
          </>
        ) : (
          <div className="space-y-2">
            {files.map(f => {
              const isPdf = f.name.toLowerCase().endsWith('.pdf');
              return (
                <div key={f.name} className="flex items-center gap-4 bg-card rounded-xl border border-border px-4 py-3 shadow-sm hover:shadow-md dark:shadow-none transition-shadow group">
                  <div className="shrink-0 p-2 rounded-lg bg-muted border border-border/50">
                    {isPdf
                      ? <File className="w-6 h-6 text-primary" />
                      : <FileText className="w-6 h-6 text-destructive" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-foreground truncate">{f.name}</p>
                    <p className="text-xs font-semibold text-muted-foreground">{formatBytes(f.size)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); removeFile(f.name); }}
                    className="shrink-0 p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              );
            })}
            <p className="text-xs font-semibold text-muted-foreground text-right pt-1">
              {files.length} file • tổng {formatBytes(totalSize)}
            </p>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 text-sm font-medium text-[#E00500] bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl px-4 py-3 whitespace-pre-line">
          {error}
        </div>
      )}

      <button
        onClick={handleConvert}
        disabled={files.length === 0 || loading}
        className="mt-6 w-full btn-primary modern-button text-lg"
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Đang xử lý...
          </>
        ) : (
          <>
            <Upload className="w-5 h-5" />
            Transform
          </>
        )}
      </button>
    </div>
  );
}
