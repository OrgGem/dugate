// lib/cleanup-scheduler.ts
// Singleton: chạy cleanup 1 lần khi server khởi động + mỗi 6 tiếng
// Import từ layout.tsx để đảm bảo chạy khi app start

import { cleanupExpiredFiles } from './cleanup';
import { Logger } from './logger';

const logger = new Logger({ service: 'cleanup-scheduler' });


const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

let scheduled = false;

export function ensureCleanupScheduled(): void {
  if (scheduled) return;
  scheduled = true;

  // Chạy lần đầu sau 10s (đợi server fully ready)
  setTimeout(() => {
    cleanupExpiredFiles().catch(err =>
      logger.error('[Initial] Cleanup run failed', {}, err)
    );
  }, 10_000);

  // Lặp mỗi 6 tiếng
  setInterval(() => {
    cleanupExpiredFiles().catch(err =>
      logger.error('[Scheduled] Cleanup run failed', {}, err)
    );
  }, SIX_HOURS_MS);
}
