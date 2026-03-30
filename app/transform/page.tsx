// app/transform/page.tsx
// Trang transform chính (Chuyển đổi PDF/DOCX sang MD)

import UploadForm from '@/components/UploadForm';

export default function ConvertPage() {
  return (
    <main className="py-16">
      <div className="text-center mb-12 max-w-2xl mx-auto px-4 relative z-10">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 mb-6 text-sm font-bold text-primary shadow-sm">
          Chuyển đổi văn bản
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-foreground mb-6 leading-tight">
          Chuyển đổi tài liệu sang Markdown
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed font-medium">
          Upload file Word hoặc PDF, nhận markdown có cấu trúc tối ưu cho quá trình Data Ingestion của AI.
        </p>
      </div>
      <UploadForm />
    </main>
  );
}
