// app/api/internal/workflow-schemas/pipeline-mappings/route.ts
// GET  /api/internal/workflow-schemas/pipeline-mappings?slug=<slug>
// Returns connector details for each connector node in the schema,
// including current overrideConnector values from the schema itself.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { externalApiConnections } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-guard";
import { loadSchema } from "@/lib/workflow-builder/loader";
import type { WorkflowSchema, ConnectorNode } from "@/lib/workflow-builder/types";

export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (guard instanceof NextResponse) return guard;

  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "slug param required" }, { status: 400 });
  }

  try {
    const schema = await loadSchema(slug);
    if (!schema) {
      return NextResponse.json({ error: "Schema not found" }, { status: 404 });
    }

    // Collect all unique connector slugs referenced in the schema
    const connectorSlugs = new Set<string>();
    for (const node of schema.nodes) {
      if (node.type === "connector") {
        const cn = node as ConnectorNode;
        if (cn.connector) connectorSlugs.add(cn.connector);
      }
    }

    // Fetch full connector details from DB (mask authSecret)
    const allConnectors = await db
      .select()
      .from(externalApiConnections)
      .orderBy(asc(externalApiConnections.createdAt));
    const connMap = new Map<string, any>();
    for (const c of allConnectors) {
      connMap.set(c.slug, {
        ...c,
        authSecret: c.authSecret ? "••••••••" : "",
      });
    }

    // Build pipelineMappings: for each connector node, return the connector info + current overrides
    const pipelineMappings: Array<{
      nodeId: string;
      connectorSlug: string;
      connectorName: string;
      connectorDescription: string | null;
      defaultPrompt: string;
      staticFormFields: string | null;
      extraHeaders: string | null;
      responseContentPath: string;
      timeoutSec: number;
      currentOverrides: {
        prompt?: string;
        staticFormFields?: string;
        extraHeaders?: string;
        responseContentPath?: string;
        timeoutSec?: number;
      };
    }> = [];

    for (const node of schema.nodes) {
      if (node.type !== "connector") continue;
      const cn = node as ConnectorNode;
      const conn = connMap.get(cn.connector);
      if (!conn) continue;

      pipelineMappings.push({
        nodeId: cn.id,
        connectorSlug: cn.connector,
        connectorName: conn.name,
        connectorDescription: conn.description,
        defaultPrompt: conn.defaultPrompt,
        staticFormFields: conn.staticFormFields,
        extraHeaders: conn.extraHeaders,
        responseContentPath: conn.responseContentPath,
        timeoutSec: conn.timeoutSec,
        currentOverrides: {
          prompt: cn.overrideConnector?.prompt,
          staticFormFields: cn.overrideConnector?.staticFormFields,
          extraHeaders: cn.overrideConnector?.extraHeaders,
          responseContentPath: cn.overrideConnector?.responseContentPath,
          timeoutSec: cn.overrideConnector?.timeoutSec,
        },
      });
    }

    return NextResponse.json({ pipelineMappings });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
