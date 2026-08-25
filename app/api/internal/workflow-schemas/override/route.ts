// app/api/internal/workflow-schemas/override/route.ts
// PUT  /api/internal/workflow-schemas/override
// Updates overrideConnector for a specific node in a schema
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { loadSchema, saveSchema } from "@/lib/workflow-builder/loader";
import type { WorkflowSchema, ConnectorNode } from "@/lib/workflow-builder/types";

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const body = await req.json();
    const { slug, nodeId, overrides } = body;
    if (!slug || !nodeId || !overrides) {
      return NextResponse.json({ error: "slug, nodeId, overrides required" }, { status: 400 });
    }

    const schema = await loadSchema(slug);
    if (!schema) {
      return NextResponse.json({ error: "Schema not found" }, { status: 404 });
    }

    const node = schema.nodes.find((n) => n.id === nodeId && n.type === "connector");
    if (!node) {
      return NextResponse.json({ error: `Connector node '${nodeId}' not found in schema` }, { status: 404 });
    }

    const cn = node as ConnectorNode;
    // Merge overrides (only provided fields)
    cn.overrideConnector = {
      ...cn.overrideConnector,
      ...(overrides.prompt !== undefined ? { prompt: overrides.prompt } : {}),
      ...(overrides.staticFormFields !== undefined ? { staticFormFields: overrides.staticFormFields } : {}),
      ...(overrides.extraHeaders !== undefined ? { extraHeaders: overrides.extraHeaders } : {}),
      ...(overrides.responseContentPath !== undefined ? { responseContentPath: overrides.responseContentPath } : {}),
      ...(overrides.timeoutSec !== undefined ? { timeoutSec: overrides.timeoutSec } : {}),
    };

    // Remove empty overrideConnector if all fields are empty
    if (Object.keys(cn.overrideConnector).length === 0) {
      delete cn.overrideConnector;
    }

    await saveSchema(schema);
    return NextResponse.json({ ok: true, schema });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
