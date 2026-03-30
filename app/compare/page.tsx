// app/compare/page.tsx
// Trang so sánh 2 tài liệu

import CompareUploadForm from '@/components/CompareUploadForm';

export default function ComparePage() {
  return (
    <main className="py-16">
      <div className="text-center mb-12 max-w-2xl mx-auto px-4 relative z-10">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-destructive/10 border border-destructive/20 mb-6 text-sm font-bold text-destructive shadow-sm">
          So sánh tài liệu
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-foreground mb-6 leading-tight">
          So sánh Phiên bản
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed font-medium">
          Upload 2 phiên bản tài liệu (pháp lý / quy định), AI sẽ tự động phân tích và đối chiếu từng điều khoản để tìm ra điểm khác biệt.
        </p>
      </div>
      <CompareUploadForm />
    </main>
  );
}
