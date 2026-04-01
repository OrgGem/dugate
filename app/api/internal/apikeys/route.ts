import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import crypto from 'crypto';

export async function GET(req: NextRequest) {
  try {
    const apiKeys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        keyHash: true,
      }
    });
    return NextResponse.json({ success: true, apiKeys });
  } catch (error: any) {
    console.error('[ApiKey API - GET Error]', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Tạo mới ApiKey
export async function POST(req: NextRequest) {
  try {
    const { name } = await req.json();
    if (!name || name.trim().length === 0) {
      return NextResponse.json({ success: false, error: 'Tên Client không hợp lệ' }, { status: 400 });
    }

    // Generate prefix and long hex key for the RAW password
    // Prefix 'dg_' (dugate) to easily identify keys
    const rawKey = 'dg_' + crypto.randomBytes(32).toString('base64url');

    const apiKey = await prisma.apiKey.create({
      data: {
        name: name.trim(),
        keyHash: rawKey, // Store plain text directly for Admin visibility
        prefix: 'dg_',
        status: 'active',
      },
    });

    return NextResponse.json({
      success: true,
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        status: apiKey.status,
      },
      rawKey, // NOTE: Chỉ trả về nguyên bản ở bước tạo này, Admin phải copy thủ công
    });
  } catch (error: any) {
    console.error('[ApiKey API - POST Error]', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Xóa ApiKey
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ success: false, error: 'Thiếu ID' }, { status: 400 });

    await prisma.apiKey.delete({
      where: { id }
    });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[ApiKey API - DELETE Error]', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
