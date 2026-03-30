// app/api/operations/[id]/route.ts
// Internal: GET /api/operations/{id} — Operation detail for frontend

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { formatOperationResponse } from '@/lib/pipelines/format';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const op = await prisma.operation.findUnique({ where: { id } });

  if (!op || op.deletedAt) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(formatOperationResponse(op));
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.operation.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return new NextResponse(null, { status: 204 });
}
