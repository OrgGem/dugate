// app/settings/page.tsx
// Trang cài đặt AI provider

import SettingsForm from '@/components/SettingsForm';

export default function SettingsPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-zinc-100 mb-2">Cài đặt Hệ thống</h1>
        <p className="text-slate-500 dark:text-zinc-400 text-base font-medium">
          Cấu hình API key, Model AI và tùy chỉnh các tham số hướng dẫn (Prompt) mặc định cho AI.
        </p>
      </div>
      <SettingsForm />
    </main>
  );
}
