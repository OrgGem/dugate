// app/page.tsx
// Trang chủ DUGate Studio — Flat Material Enterprise Catalog

import Link from 'next/link';
import ChatConsultant from '@/components/ChatConsultant';
import {
  FileText, GitCompareArrows, ArrowRight, Sparkles, ShieldCheck,
  ScanText, BrainCircuit, Repeat2, Layers, Zap, Clock,
  Globe2, KeyRound, Webhook, ArrowDown, CheckCircle2,
  Building2, Scale, UserCheck, ChevronRight, Lock, BookOpen, Activity
} from 'lucide-react';

// ── 6 Core Endpoints ──────────────────────────────────────────────────────────
const ENDPOINTS = [
  {
    method: 'POST',
    path: '/docs/ingest',
    title: 'Nhập & Tiền xử lý',
    subtitle: 'Document Ingestion',
    description: 'Chuyển đổi file thô (PDF/DOCX/ảnh scan) thành text chuẩn hoá. Hỗ trợ 4 mode: parse, ocr, digitize, split.',
    icon: ScanText,
    colorClass: 'text-blue-600 dark:text-blue-400',
    bgClass: 'bg-blue-50 dark:bg-blue-950/50',
    borderClass: 'border-blue-200 dark:border-blue-800',
    modes: ['parse', 'ocr', 'digitize', 'split'],
    href: '/docs/ingest',
  },
  {
    method: 'POST',
    path: '/docs/extract',
    title: 'Trích xuất Dữ liệu',
    subtitle: 'Structured Extraction',
    description: 'Bóc tách thông tin có cấu trúc từ hóa đơn, hợp đồng, CCCD, biên lai và bảng biểu với schema JSON tùy biến.',
    icon: Layers,
    colorClass: 'text-emerald-600 dark:text-emerald-400',
    bgClass: 'bg-emerald-50 dark:bg-emerald-950/50',
    borderClass: 'border-emerald-200 dark:border-emerald-800',
    modes: ['invoice', 'contract', 'id-card', 'receipt', 'table', 'custom'],
    href: '/docs/extract',
  },
  {
    method: 'POST',
    path: '/docs/analyze',
    title: 'Phân tích & Đánh giá',
    subtitle: 'Deep Analysis',
    description: 'NLU chuyên sâu: phân loại, kiểm tra tuân thủ pháp lý, đánh giá rủi ro, xác minh dữ kiện và chấm điểm chất lượng.',
    icon: BrainCircuit,
    colorClass: 'text-purple-600 dark:text-purple-400',
    bgClass: 'bg-purple-50 dark:bg-purple-950/50',
    borderClass: 'border-purple-200 dark:border-purple-800',
    modes: ['classify', 'compliance', 'risk', 'fact-check', 'sentiment', 'quality'],
    href: '/docs/analyze',
  },
  {
    method: 'POST',
    path: '/docs/transform',
    title: 'Chuyển đổi Nội dung',
    subtitle: 'Content Transform',
    description: 'Đổi định dạng, dịch thuật đa ngôn ngữ, viết lại văn phong, bôi đen PII tự động và điền form theo template.',
    icon: Repeat2,
    colorClass: 'text-sky-600 dark:text-sky-400',
    bgClass: 'bg-sky-50 dark:bg-sky-950/50',
    borderClass: 'border-sky-200 dark:border-sky-800',
    modes: ['convert', 'translate', 'rewrite', 'redact', 'template'],
    href: '/docs/transform',
  },
  {
    method: 'POST',
    path: '/docs/generate',
    title: 'Tạo Nội dung AI',
    subtitle: 'Content Generation',
    description: 'Sinh văn bản mới hoàn toàn từ tài liệu gốc: tóm tắt, Q&A, dàn bài, báo cáo phân tích, email phản hồi, biên bản họp.',
    icon: Sparkles,
    colorClass: 'text-amber-600 dark:text-amber-400',
    bgClass: 'bg-amber-50 dark:bg-amber-950/50',
    borderClass: 'border-amber-200 dark:border-amber-800',
    modes: ['summary', 'qa', 'outline', 'report', 'email', 'minutes'],
    href: '/docs/generate',
  },
  {
    method: 'POST',
    path: '/docs/compare',
    title: 'So sánh Tài liệu',
    subtitle: 'Document Compare',
    description: 'Phát hiện sự khác biệt giữa hai phiên bản tài liệu: diff từng dòng, so sánh ngữ nghĩa pháp lý, tạo changelog.',
    icon: GitCompareArrows,
    colorClass: 'text-rose-600 dark:text-rose-400',
    bgClass: 'bg-rose-50 dark:bg-rose-950/50',
    borderClass: 'border-rose-200 dark:border-rose-800',
    modes: ['diff', 'semantic', 'version'],
    href: '/docs/compare',
  },
];

// ── Async Flow Steps ──────────────────────────────────────────────────────────
const ASYNC_STEPS = [
  {
    step: '01',
    icon: FileText,
    title: 'Gửi Yêu cầu (Request)',
    desc: 'POST file kèm tham số tới endpoint với x-api-key.',
    code: '202 Accepted → op-id',
  },
  {
    step: '02',
    icon: Clock,
    title: 'Xử lý Bất đồng bộ',
    desc: 'Trả về Operation ID ngay. Client polling hoặc nhận Webhook callback.',
    code: 'state: "RUNNING"',
  },
  {
    step: '03',
    icon: CheckCircle2,
    title: 'Nhận Kết quả hoàn tất',
    desc: 'Khi done=true, kết quả JSON và artifacts sẵn sàng để consume.',
    code: 'done: true → result: {...}',
  },
];

export default function Home() {
  return (
    <main className="flex-1 bg-background">
      {/* ══════════════════════════════════════════════════════════════════════
          HERO & PORTAL HEADER (Flat Material Design)
      ══════════════════════════════════════════════════════════════════════ */}
      <section className="border-b border-border bg-card py-12 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-muted text-muted-foreground text-xs font-semibold mb-3 border border-border">
                <span className="w-2 h-2 rounded-full bg-primary" />
                Enterprise Document Understanding Gateway
                <span className="font-mono text-[10px] bg-primary/10 text-primary px-1.5 py-0.2 rounded font-bold">API v1</span>
              </div>
              <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-foreground">
                Document AI Gateway & Workflow Orchestrator
              </h1>
              <p className="text-sm sm:text-base text-muted-foreground mt-2 max-w-2xl leading-relaxed">
                Nền tảng tự động hóa xử lý văn bản, trích xuất cấu trúc và phân tích nghiệp vụ.
                Tích hợp sẵn luồng Async Polling, Webhook Callback và Human-in-the-Loop review.
              </p>
            </div>

            {/* Quick Record Actions */}
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <Link
                href="/history"
                className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm rounded-md shadow-xs"
              >
                <Activity className="w-4 h-4" />
                <span>Theo dõi Operations</span>
              </Link>
              <Link
                href="/api-docs"
                className="btn-outline inline-flex items-center gap-2 px-4 py-2 text-sm rounded-md"
              >
                <BookOpen className="w-4 h-4" />
                <span>API Docs</span>
              </Link>
              <Link
                href="/workflow-builder"
                className="btn-outline inline-flex items-center gap-2 px-4 py-2 text-sm rounded-md"
              >
                <Zap className="w-4 h-4" />
                <span>Workflow Builder</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          ASYNC PATTERN ARCHITECTURE (3-Step Stepper)
      ══════════════════════════════════════════════════════════════════════ */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Cơ chế vận hành bất đồng bộ (Async Architecture)
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {ASYNC_STEPS.map((step, idx) => (
            <div key={idx} className="p-4 bg-card border border-border rounded-lg shadow-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono font-bold text-muted-foreground">
                  Bước {step.step}
                </span>
                <step.icon className="w-4 h-4 text-primary" />
              </div>
              <h3 className="text-sm font-bold text-foreground mb-1">{step.title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">{step.desc}</p>
              <code className="text-xs font-mono bg-muted px-2 py-1 rounded text-foreground block border border-border">
                {step.code}
              </code>
            </div>
          ))}
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          6 CORE DU GATEWAY ENDPOINTS (Material Service Catalog)
      ══════════════════════════════════════════════════════════════════════ */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-12">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-foreground">Thư viện Dịch vụ Document AI</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              6 API core endpoints tiêu chuẩn xử lý tài liệu đa định dạng (PDF, DOCX, scan)
            </p>
          </div>
          <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded border border-border">
            6 Endpoints Available
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {ENDPOINTS.map((ep, idx) => (
            <div
              key={idx}
              className="p-5 bg-card border border-border rounded-lg shadow-xs flex flex-col justify-between hover:border-slate-400 dark:hover:border-slate-600 transition-colors"
            >
              <div>
                {/* Header */}
                <div className="flex items-start gap-3 mb-3">
                  <div className={`p-2 rounded-md ${ep.bgClass} ${ep.colorClass} border ${ep.borderClass}`}>
                    <ep.icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] font-bold font-mono bg-muted text-foreground px-1.5 py-0.2 rounded border border-border">
                        {ep.method}
                      </span>
                      <code className="text-xs font-mono font-bold text-primary truncate">
                        {ep.path}
                      </code>
                    </div>
                    <h3 className="text-sm font-bold text-foreground leading-snug">{ep.title}</h3>
                    <p className="text-xs text-muted-foreground">{ep.subtitle}</p>
                  </div>
                </div>

                {/* Description */}
                <p className="text-xs text-muted-foreground leading-relaxed mb-4">
                  {ep.description}
                </p>

                {/* Modes */}
                <div className="flex flex-wrap gap-1 mb-4">
                  {ep.modes.map((m) => (
                    <span
                      key={m}
                      className="px-1.5 py-0.5 text-[11px] font-mono bg-muted text-muted-foreground rounded border border-border"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>

              {/* Action Bar */}
              <div className="pt-3 border-t border-border flex items-center justify-between mt-auto">
                <Link
                  href={ep.href}
                  className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1"
                >
                  <span>Mở giao diện tương tác</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Link>
                <Link
                  href="/api-docs"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Tài liệu
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          AI CONSULTANT & ASSISTANT SECTION
      ══════════════════════════════════════════════════════════════════════ */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-16">
        <ChatConsultant />
      </section>
    </main>
  );
}
