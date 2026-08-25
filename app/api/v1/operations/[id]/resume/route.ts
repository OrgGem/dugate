// app/api/v1/operations/[id]/resume/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { operations, profileEndpoints } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getPipelineQueue } from '@/lib/queue/pipeline-queue';
import { Logger } from '@/lib/logger';

const logger = new Logger({ service: 'resume-operation' });

function resolveBullPriority(jobPriority?: string | null): number {
  switch (jobPriority) {
    case 'HIGH':   return 1;
    case 'LOW':    return 20;
    default:       return 10; // MEDIUM or undefined
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const operationId = params.id;
    const body = await req.json();

    const [operation] = await db.select().from(operations).where(eq(operations.id, operationId)).limit(1);

    if (!operation) {
      return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
    }

    if (operation.state !== 'WAITING_USER_INPUT') {
      return NextResponse.json({ error: `Operation is in state ${operation.state}, cannot resume. Must be WAITING_USER_INPUT.` }, { status: 400 });
    }

    // ── Parse stepsResult, handling _nodeResults wrapper ──────────────────
    // Schema-driven workflows store: { stepsResult: [...], _nodeResults: {...} }
    // Code-driven workflows store: [...] (plain array)
    let rawParsed: unknown = null;
    let stepsResult: any[] = [];
    let schemaNodeResults: Record<string, unknown> | null = null;

    if (operation.stepsResultJson) {
      try {
        rawParsed = JSON.parse(operation.stepsResultJson);
      } catch { /* ignore */ }
    }

    if (rawParsed && typeof rawParsed === 'object' && !Array.isArray(rawParsed) && (rawParsed as any)._nodeResults) {
      // Schema-driven wrapper format
      stepsResult = Array.isArray((rawParsed as any).stepsResult) ? (rawParsed as any).stepsResult : [];
      schemaNodeResults = (rawParsed as any)._nodeResults;
    } else if (Array.isArray(rawParsed)) {
      stepsResult = rawParsed;
    }

    // Update stepsResult if human edit data is provided
    if (body.step !== undefined && body.step !== null && 'extracted_data' in body) {
      const stepIndex = stepsResult.findIndex((s: any) => s.step === body.step);
      if (stepIndex >= 0) {
        stepsResult[stepIndex].extracted_data = body.extracted_data;
        stepsResult[stepIndex].is_human_edited = true;
      }
    }

    // Determine Queue Priority
    let bullPriority = 10;
    if (operation.apiKeyId && operation.endpointSlug) {
      const [profileEndpoint] = await db.select({ jobPriority: profileEndpoints.jobPriority }).from(profileEndpoints).where(
        and(eq(profileEndpoints.apiKeyId, operation.apiKeyId), eq(profileEndpoints.endpointSlug, operation.endpointSlug))
      ).limit(1);
      // @ts-ignore
      bullPriority = resolveBullPriority(profileEndpoint?.jobPriority);
    }

    // ── Re-encode stepsResultJson, preserving _nodeResults wrapper ────────
    let finalStepsResultJson: string;
    if (schemaNodeResults && Object.keys(schemaNodeResults).length > 0) {
      finalStepsResultJson = JSON.stringify({ stepsResult, _nodeResults: schemaNodeResults });
    } else {
      finalStepsResultJson = JSON.stringify(stepsResult);
    }

    // Set state back to RUNNING and update
    await db.update(operations).set({
      state: 'RUNNING',
      progressMessage: 'Đang tiếp tục luồng xử lý do người dùng xác nhận...',
      stepsResultJson: finalStepsResultJson,
    }).where(eq(operations.id, operationId));

    // Enqueue back to the worker
    const queue = getPipelineQueue();
    const jobName = `pipeline:${operation.endpointSlug ?? 'unknown'}`;
    const correlationId = crypto.randomUUID();
    
    await queue.add(jobName, { operationId, correlationId }, { priority: bullPriority });
    logger.info(`Resumed operation ${operationId} and enqueued to BullMQ.`);

    return NextResponse.json({ success: true, message: 'Resumed successfully' });
  } catch (err: any) {
    logger.error(`Failed to resume operation`, undefined, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
