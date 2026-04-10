// app/api/cleanup/route.ts
// GET /api/cleanup — internal endpoint, trigger manual cleanup
// Gọi bởi cron hoặc monitoring

import { cleanupExpiredFiles } from '@/lib/cleanup';
import { Logger } from '@/lib/logger';

const logger = new Logger({ service: 'cleanup' });


export async function GET() {
  try {
    const result = await cleanupExpiredFiles();
    return Response.json(result);
  } catch (error) {
    logger.error('[GET] Cleanup failed', {}, error);
    return Response.json({ error: 'Lỗi server' }, { status: 500 });
  }
}
