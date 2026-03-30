'use client';

// app/generate/page.tsx
// Tạo tài liệu AI — migrated to pipeline API with prebuilt-summarize + dynamic-genai

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileText, Sparkles, AlertCircle, X, AlignLeft } from 'lucide-react';

const FORMAT_OPTIONS = [
  { value: 'md',   label: 'Markdown (.md)',          desc: 'Dạng text chuẩn, tối ưu cho AI / RAG pipeline' },
  { value: 'html', label: 'HTML (.html)',             desc: 'Định dạng web, giữ nguyên cấu trúc hiển thị' },
];

const PROMPT_EXAMPLES = [
  'Viết lại tài liệu này thành bản tóm tắt ngắn gọn, dưới 500 từ.',
  'Tạo bộ câu hỏi & câu trả lời FAQ từ nội dung tài liệu này.',
  'Chuyển nội dung này thành tutorial từng bước (step-by-step guide).',
  'Viết lại theo phong cách ngôn ngữ dễ hiểu cho người không chuyên.',
  'Trích xuất và tổng hợp các điều khoản quan trọng trong văn bản.',
];

export default function GeneratePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [inputMode, setInputMode]   = useState<'file' | 'text'>('file');
  const [files, setFiles]           = useState<File[]>([]);
  const [inputText, setInputText]   = useState('');
  
  const [dragging, setDragging]     = useState(false);
  const [outputFormat, setFormat]   = useState<'md' | 'html'>('md');
  const [userPrompt, setPrompt]     = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState('');

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length > 0) {
      validateAndAddFiles(Array.from(e.dataTransfer.files));
    }
  }, []);

  function validateAndAddFiles(newFiles: File[]) {
    const valid: File[] = [];
    let errorMsg = '';

    for (const f of newFiles) {
      const ext = f.name.split('.').pop()?.toLowerCase();
      if (!ext || !['docx', 'pdf'].includes(ext)) {
        errorMsg = 'Chỉ hỗ trợ file .docx và .pdf.';
        continue;
      }
      if (f.size > 20 * 1024 * 1024) {
        errorMsg = `File ${f.name} vượt quá 20MB.`;
        continue;
      }
      valid.push(f);
    }
    
    if (errorMsg) setError(errorMsg);
    else setError('');

    setFiles(prev => {
      const combined = [...prev, ...valid];
      const unique = combined.filter((f, i, a) => a.findIndex(x => x.name === f.name) === i);
      if (unique.length > 5) {
        setError('Tối đa 5 file.');
        return unique.slice(0, 5);
      }
      return unique;
    });
  }

  function removeFile(index: number) {
    setFiles(prev => prev.filter((_, i) => i !== index));
    if (files.length <= 1) setError('');
  }

  // Submit through pipeline API
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inputMode === 'file' && files.length === 0) { setError('Vui lòng chọn ít nhất 1 file.'); return; }
    if (inputMode === 'text' && !inputText.trim()) { setError('Vui lòng nhập nội dung văn bản.'); return; }
    if (!userPrompt.trim()) { setError('Vui lòng nhập prompt hướng dẫn.'); return; }

    setSubmitting(true);
    setError('');

    try {
      const fd = new FormData();

      // Use dynamic-genai processor for full prompt control via frontend
      // Pipeline: extract text first (if file) → then generate
      if (inputMode === 'file') {
        fd.append('file', files[0]);
        fd.append('pipeline', JSON.stringify([
          { processor: 'prebuilt-layout' },
          { processor: 'dynamic-genai', variables: { prompt: userPrompt.trim() } },
        ]));
      } else {
        // For text input, create a text file and use dynamic-genai directly
        const blob = new Blob([inputText.trim()], { type: 'text/plain' });
        const textFile = new File([blob], 'input.txt', { type: 'text/plain' });
        fd.append('file', textFile);
        fd.append('pipeline', JSON.stringify([
          { processor: 'dynamic-genai', variables: { prompt: userPrompt.trim() } },
        ]));
      }

      fd.append('output_format', outputFormat);

      const res = await fetch('/api/documents/process', { method: 'POST', body: fd });
      const data = await res.json();

      if (!res.ok) {
        setError(data.detail ?? data.title ?? 'Lỗi server khi tạo task.');
        return;
      }

      const opId = data.name.replace('operations/', '');
      router.push(`/operations/${opId}`);
    } catch {
      setError('Lỗi kết nối server.');
      setSubmitting(false);
    }
  }

  return (
    <main className="py-16">
      <div className="text-center mb-12 max-w-2xl mx-auto px-4 relative z-10">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 mb-6 text-sm font-bold text-primary shadow-sm">
          <Sparkles className="w-4 h-4" />
          Tạo tài liệu AI
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-foreground mb-6 leading-tight">
          Phát sinh tài liệu mới
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed font-medium">
          Cung cấp dữ liệu gốc và chỉ thị (prompt), AI sẽ tự động phân tích và tạo ra tài liệu theo định dạng yêu cầu.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-8 px-4 modern-card p-6 md:p-10 relative z-10 transition-colors">

        {/* Input Mode Toggle */}
        <div className="flex bg-muted p-1.5 rounded-2xl w-fit mx-auto border border-border">
          <button
            type="button"
            onClick={() => setInputMode('file')}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${
              inputMode === 'file' ? 'bg-background text-primary shadow-sm dark:shadow-none' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileText className="w-4 h-4" /> Upload Tài liệu
          </button>
          <button
            type="button"
            onClick={() => setInputMode('text')}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${
              inputMode === 'text' ? 'bg-background text-primary shadow-sm dark:shadow-none' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <AlignLeft className="w-4 h-4" /> Dán Văn bản
          </button>
        </div>

        {/* Input Control */}
        <div className="space-y-4">
          <label className="block text-sm font-bold text-foreground">
            1. Dữ liệu đầu vào
          </label>
          
          {inputMode === 'file' ? (
            <div
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onClick={() => fileInputRef.current?.click()}
              className={`dropzone ${dragging ? 'border-primary bg-primary/10' : ''} p-10 text-center`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".docx,.pdf"
                className="hidden"
                onChange={e => {
                  if (e.target.files) validateAndAddFiles(Array.from(e.target.files));
                }}
              />
              <Upload className="w-12 h-12 mx-auto mb-4 text-primary opacity-80" />
              <p className="font-bold text-foreground mb-2">Kéo thả file vào đây</p>
              <p className="text-sm font-medium text-muted-foreground">hoặc click để chọn • Tối đa 5 file • &lt; 20MB/file</p>
            </div>
          ) : (
            <textarea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              rows={8}
              placeholder="Dán nội dung JSON, Markdown, hoặc text thô vào đây..."
              className="input-field font-mono"
            />
          )}

          {/* File list */}
          {inputMode === 'file' && files.length > 0 && (
            <div className="mt-4 grid gap-3">
              {files.map((f, i) => (
                <div key={i} className="flex items-center justify-between bg-card border border-border rounded-xl p-3 shadow-sm hover:shadow-md transition-shadow group">
                  <div className="flex items-center gap-4 overflow-hidden">
                    <div className="shrink-0 p-2 rounded-lg bg-muted border border-border/50">
                      <FileText className="w-6 h-6 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-bold text-sm text-foreground truncate">{f.name}</p>
                      <p className="text-xs font-semibold text-muted-foreground">{(f.size / 1024 / 1024).toFixed(1)} MB</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Output Format */}
        <div className="space-y-4">
          <label className="block text-sm font-bold text-foreground">
            2. Định dạng đầu ra
          </label>
          <div className="grid grid-cols-2 gap-4">
            {FORMAT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFormat(opt.value as 'md' | 'html')}
                className={`text-left p-5 rounded-2xl border-2 transition-all ${
                  outputFormat === opt.value
                    ? 'border-primary bg-primary/10 shadow-md text-primary'
                    : 'bg-card border-border hover:border-primary/50 text-foreground'
                }`}
              >
                <div className="font-bold mb-1 text-foreground">{opt.label}</div>
                <div className="text-xs font-medium text-muted-foreground leading-relaxed">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Prompt */}
        <div className="space-y-4">
          <label className="block text-sm font-bold text-foreground">
            3. Hướng dẫn Prompt (Yêu cầu AI)
          </label>
          <textarea
            value={userPrompt}
            onChange={e => setPrompt(e.target.value)}
            rows={5}
            placeholder="Ví dụ: Tóm tắt nội dung tài liệu này thành bản dưới 500 từ, dùng ngôn ngữ đơn giản, dễ hiểu..."
            className="input-field"
          />
          <div className="mt-3">
            <p className="text-xs font-bold text-muted-foreground mb-3 uppercase tracking-wider">Gợi ý nhanh:</p>
            <div className="flex flex-wrap gap-2.5">
              {PROMPT_EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPrompt(ex)}
                  className="text-xs px-3 py-1.5 bg-muted text-foreground font-medium rounded-full hover:bg-primary/20 hover:text-primary transition-colors border border-border"
                >
                  {ex.length > 40 ? ex.slice(0, 38) + '…' : ex}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 text-sm font-medium text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
            <AlertCircle className="w-5 h-5 shrink-0" />
            {error}
          </div>
        )}

        {/* Submit */}
        <div className="pt-4">
          <button
            type="submit"
            disabled={submitting || (inputMode === 'file' && files.length === 0) || (inputMode === 'text' && !inputText.trim()) || !userPrompt.trim()}
            className="w-full btn-primary modern-button text-lg py-4"
          >
            <Sparkles className="w-5 h-5 mr-2" />
            {submitting ? 'Đang phân tích & Tạo tài liệu...' : 'Phát sinh Tài liệu'}
          </button>
        </div>
      </form>
    </main>
  );
}
