import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import crypto from 'crypto';
import { Logger } from '@/lib/logger';

const logger = new Logger({ service: 'auth-key' });


export async function GET(req: NextRequest) {
  const passedKey = req.headers.get('x-api-key');
  if (!passedKey) {
    return NextResponse.json({ valid: false, error: 'Missing x-api-key' }, { status: 401 });
  }

  try {
    // 1. Dùng try-catch để an toàn cho mọi call
    try {
      // Đầu tiên, thử tìm trực tiếp bằng chuỗi gởi lên (Nếu Admin tạo mới, key lưu dạng dg_xxx)
      let apiKey = await prisma.apiKey.findUnique({
        where: { keyHash: passedKey }
      });
      
      // Nếu không tìm thấy, fallback về SHA256 (Tương thích ngược với các key cũ đã hash)
      if (!apiKey) {
        const computedHash = crypto.createHash('sha256').update(passedKey).digest('hex');
        apiKey = await prisma.apiKey.findUnique({
          where: { keyHash: computedHash }
        });
      }

      if (apiKey) {
        if (apiKey.status !== 'active') {
          return NextResponse.json({ valid: false, error: 'API key is deactivated or suspended.' }, { status: 403 });
        }
        return NextResponse.json({ valid: true, apiKeyId: apiKey.id });
      }
    } catch (dbError) {
      logger.error('[DB AUTH ERROR]', {}, dbError);
    }

    // Fallback cho local dev testing: so sánh với secret key trong bảng AppSetting
    // Tuy nhiên log cảnh báo nếu dùng fallback vì không map được apiKeyId
    const { getSetting } = await import('@/lib/settings');
    const secretKey = await getSetting('api_secret_key');
    
    if (secretKey && passedKey === secretKey) {
      logger.warn('[AUTH] Using fallback master secret key. apiKeyId will be null.');
      return NextResponse.json({ valid: true, apiKeyId: null });
    }

    return NextResponse.json({ valid: false, error: 'Unauthorized: Invalid x-api-key header.' }, { status: 401 });
  } catch (error) {
    logger.error('[AUTH ERROR]', {}, error);
    return NextResponse.json({ valid: false, error: 'Internal Server Error' }, { status: 500 });
  }
}
