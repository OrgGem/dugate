// app/page.tsx
// Trang chủ giới thiệu dugate

import Link from 'next/link';
import { FileText, GitCompareArrows, ArrowRight, Sparkles } from 'lucide-react';

const FEATURES = [
  {
    title: "Chuyển đổi Markdown",
    description: "Chỉ với một cú kéo thả, chuyển đổi file DOCX, PDF thành định dạng Markdown chuẩn xác. Hỗ trợ mô tả ảnh bằng AI Prompt tùy biến và trích xuất bảng biểu.",
    icon: FileText,
    color: "from-[#00B74F] to-[#008f40]",
    href: "/transform"
  },
  {
    title: "So sánh Văn bản",
    description: "Kiểm tra tự động đa biến đối với các văn bản pháp lý, quy định. Phát hiện cực nhanh các điều khoản được thêm mới, sửa đổi hoặc xóa bỏ.",
    icon: GitCompareArrows,
    color: "from-[#E00500] to-[#b30400]",
    href: "/compare"
  },
  {
    title: "Tạo tài liệu AI",
    description: "Upload tài liệu gốc và mô tả yêu cầu — AI sẽ tự động đọc hiểu toàn bộ nội dung và tạo ra tài liệu mới dạng Markdown hoặc HTML chuyên nghiệp theo đúng prompt.",
    icon: Sparkles,
    color: "from-indigo-600 to-indigo-800",
    href: "/generate"
  }
];

export default function Home() {
  return (
    <main className="flex-1 relative overflow-hidden bg-background transition-colors duration-300">
      {/* Background decorations */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-primary/20 dark:bg-primary/10 blur-[100px] opacity-70 mix-blend-multiply dark:mix-blend-screen" />
        <div className="absolute top-[20%] right-[-10%] w-[400px] h-[400px] rounded-full bg-destructive/10 dark:bg-destructive/5 blur-[100px] opacity-70 mix-blend-multiply dark:mix-blend-screen" />
        <div className="absolute bottom-[-10%] left-[20%] w-[600px] h-[600px] rounded-full bg-cyan-200/20 dark:bg-primary/10 blur-[120px] opacity-50 mix-blend-multiply dark:mix-blend-screen" />
        <div className="absolute inset-0 bg-[url('/noise.png')] opacity-[0.03] dark:opacity-[0.05] mix-blend-overlay" />
      </div>

      {/* Hero Section */}
      <div className="text-center max-w-4xl mx-auto px-6 py-24">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-card border border-border shadow-sm mb-8 text-sm font-medium text-muted-foreground">
          <Sparkles className="w-4 h-4 text-primary" />
          <span>The next generation of document AI</span>
        </div>
        <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tight text-foreground mb-6 leading-tight">
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-sky-500">dugate</span><br/>
          Document Understanding Gateway
        </h1>
        <p className="text-xl text-muted-foreground mb-10 max-w-2xl mx-auto leading-relaxed">
          Trợ lý AI chuyên dụng phân tích, chuyển đổi và tái tạo các định dạng tài liệu đặc thù (DOCX, PDF) sang cấu trúc dữ liệu tối ưu với độ chính xác cao nhất.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/generate" className="w-full sm:w-auto btn-danger modern-button flex items-center justify-center">
            <Sparkles className="w-5 h-5 mr-2" />
            Bắt đầu Tạo ngay
          </Link>
          <Link href="/transform" className="modern-button btn-outline w-full sm:w-auto">
            Chuyển đổi File
          </Link>
        </div>
      </div>

      {/* Action Cards */}
      <div className="max-w-7xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {FEATURES.map((feature, idx) => (
            <Link
              key={idx}
              href={feature.href}
              className="modern-card group relative overflow-hidden flex flex-col items-center p-8 sm:p-10 text-center cursor-pointer"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-muted/50 dark:to-muted/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              <div className="relative mb-6">
                <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br ${feature.color} dark:bg-muted shadow-inner flex items-center justify-center transform group-hover:-translate-y-2 transition-transform duration-300 ease-out`}>
                  <feature.icon className="w-8 h-8 sm:w-10 sm:h-10 text-white" />
                </div>
                <div className="absolute inset-0 bg-primary blur-xl opacity-0 group-hover:opacity-20 transition-opacity duration-300 rounded-full" />
              </div>
              <h3 className="text-xl sm:text-2xl font-bold text-foreground mb-4 group-hover:text-primary transition-colors">{feature.title}</h3>
              <p className="text-muted-foreground font-medium leading-relaxed">{feature.description}</p>
              <div className="flex items-center text-primary font-semibold mt-auto pt-6">
                Khám phá
                <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1.5 transition-transform" />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
