// app/history/page.tsx
// Enterprise Material Operations Management Dashboard

import ConversionHistory from '@/components/ConversionHistory';

export const metadata = {
  title: 'Lịch sử Operations | DUGate Studio',
  description: 'Quản lý, giám sát và kiểm soát tất cả tác vụ xử lý tài liệu.',
};

export default function HistoryPage() {
  return (
    <main className="py-8 max-w-7xl mx-auto px-4 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground mb-1">
          Lịch sử Thực thi Tác vụ (Operations)
        </h1>
        <p className="text-sm text-muted-foreground">
          Giám sát trạng thái, xem kết quả đầu ra, duyệt bước Human-in-the-Loop và quản lý vòng đời các tác vụ DU.
        </p>
      </div>
      <ConversionHistory />
    </main>
  );
}
