// app/api/v1/processors/route.ts
// GET /api/v1/processors — List available processors

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * @swagger
 * /api/v1/processors:
 *   get:
 *     summary: List available processors
 *     tags: [Processors]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string, enum: [extract, generate, analyze, advanced] }
 *     responses:
 *       200:
 *         description: List of processors
 */
export async function GET(req: NextRequest) {
  const category = req.nextUrl.searchParams.get('category');
  const where: Record<string, unknown> = { state: 'ENABLED' };
  if (category) where.category = category;

  const processors = await prisma.processor.findMany({
    where,
    orderBy: { slug: 'asc' },
  });

  return NextResponse.json({
    processors: processors.map(p => ({
      name: `processors/${p.slug}`,
      display_name: p.displayName,
      type: p.type,
      category: p.category,
      state: p.state,
      accepted_mime_types: p.acceptedMimes.split(','),
      output_formats: p.outputFormats.split(','),
      can_be_first_step: p.canBeFirstStep,
      can_be_chained_step: p.canBeChainStep,
      variables_schema: p.variablesSchema ? JSON.parse(p.variablesSchema) : null,
      description: p.description,
    })),
  });
}
