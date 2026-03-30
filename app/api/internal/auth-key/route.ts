import { NextRequest, NextResponse } from 'next/server';
import { getSetting } from '@/lib/settings';

export async function GET(req: NextRequest) {
  const passedKey = req.headers.get('x-api-key');
  if (!passedKey) {
    return NextResponse.json({ valid: false, error: 'Missing x-api-key' }, { status: 401 });
  }

  try {
    // Đọc API Secret Key từ chung cấu hình Settings
    const secretKey = await getSetting('api_secret_key');
    
    if (!secretKey) {
       return NextResponse.json({ valid: false, error: 'Server misconfiguration: API_SECRET_KEY is missing in settings.' }, { status: 500 });
    }

    if (passedKey === secretKey) {
      return NextResponse.json({ valid: true });
    } else {
      return NextResponse.json({ valid: false, error: 'Unauthorized: Invalid x-api-key header.' }, { status: 401 });
    }
  } catch (error) {
    return NextResponse.json({ valid: false, error: 'Internal Server Error' }, { status: 500 });
  }
}
