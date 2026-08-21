// app/api/internal/workflow-schemas/route.ts
// Internal admin API to manage schema-driven workflow definitions.
//   GET  /api/internal/workflow-schemas?slug=<slug>  -> list or get one
//   POST /api/internal/workflow-schemas              -> save (validate + upsert)
//   DELETE /api/internal/workflow-schemas?slug=<s>   -> remove
import { NextRequest, NextResponse } from 'next/server';
import { saveSchema, loadSchema, listSchemas, deleteSchema } from '@/lib/workflow-builder/loader';
import { validateSchema } from '@/lib/workflow-builder/interpreter';
import { requireAdmin } from '@/lib/auth-guard';
import type { WorkflowSchema } from '@/lib/workflow-builder/types';
import { xmlToSchema } from '@/lib/workflow-builder/xml-converter';

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const slug = req.nextUrl.searchParams.get('slug');
  if (slug) {
    const schema = await loadSchema(slug);
    return schema
      ? NextResponse.json({ schema })
      : NextResponse.json({ error: 'Schema not found' }, { status: 404 });
  }
  const schemas = await listSchemas();
  return NextResponse.json({ schemas });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const body = await req.json();
    let schema: WorkflowSchema;

    if (body.xml) {
      schema = xmlToSchema(String(body.xml));
    } else if (body.schema) {
      schema = body.schema as WorkflowSchema;
    } else {
      return NextResponse.json({ error: 'Provide either "schema" (JSON) or "xml".' }, { status: 400 });
    }

    const errors = validateSchema(schema);
    if (errors.length > 0) {
      return NextResponse.json({ error: `Invalid schema: ${errors.join('; ')}` }, { status: 400 });
    }

    await saveSchema(schema);
    return NextResponse.json({ ok: true, schema }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  await deleteSchema(slug);
  return NextResponse.json({ ok: true });
}

