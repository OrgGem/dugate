// app/api/v1/docs/workflows/schema/route.ts
// Trigger a schema-driven workflow by slug (imported via /workflow-builder).
// POST /api/v1/docs/workflows/schema
//   FormData: schemaSlug (string), input (JSON string, optional), files (optional)
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { normalizeFiles, apiError } from '@/lib/endpoints/runner';
import { submitPipelineJob } from '@/lib/pipelines/submit';
import { loadSchema } from '@/lib/workflow-builder/loader';
import { validateSchema } from '@/lib/workflow-builder/interpreter';
import { db } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { eq, asc } from 'drizzle-orm';

export async function POST(req: NextRequest) {
  const correlationId = req.headers.get('x-correlation-id') || crypto.randomUUID();
  try {
    const form = await req.formData();
    const schemaSlug = (form.get('schemaSlug') as string | null)?.trim();
    if (!schemaSlug) {
      return apiError(400, 'Missing Parameter', "Form field 'schemaSlug' is required.");
    }

    // Load schema from DB (appSettings key wb_schema:<slug>)
    const schema = await loadSchema(schemaSlug);
    if (!schema) {
      return apiError(404, 'Schema Not Found', `Workflow schema '${schemaSlug}' is not imported. Import it via /workflow-builder first.`);
    }

    // Structural validation before enqueue
    const errors = validateSchema(schema);
    if (errors.length > 0) {
      return apiError(400, 'Invalid Schema', `Schema '${schemaSlug}' is invalid: ${errors.join('; ')}`);
    }

    // Files are optional — some schemas work text-only (file_url_download, callback, ...)
    const files = normalizeFiles(form);

    // Business variables from form field "input" (JSON string)
    const inputRaw = form.get('input') as string | null;
    let input: Record<string, unknown> = {};
    if (inputRaw) {
      try {
        input = JSON.parse(inputRaw);
      } catch {
        return apiError(400, 'Invalid Input', 'Form field "input" must be a valid JSON object string.');
      }
    }

    // Placeholder processor: submitPipelineJob validates that each processor
    // exists in externalApiConnections. The worker never runs this step for
    // workflow jobs (runWorkflow ignores the pipeline and dispatches by schemaSlug).
    const pipeline = [{ processor: 'ext-classifier', variables: { schemaSlug, ...input } }];

    // endpointSlug contains "workflows:" so worker.ts routes this job to runWorkflow
    const endpointSlug = `workflows:schema:${schemaSlug}`;

    // Resolve API key (validates raw key or internal id; falls back to admin key)
    let apiKeyId = form.get('apiKeyId') as string | null;
    if (apiKeyId) {
      let existingKey = null;
      try {
        [existingKey] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId)).limit(1);
      } catch { /* not found */ }
      if (!existingKey) {
        const computedHash = crypto.createHash('sha256').update(apiKeyId).digest('hex');
        try {
          [existingKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, computedHash)).limit(1);
        } catch { /* not found */ }
      }
      if (!existingKey) {
        return apiError(400, 'Invalid Profile API Key', "The provided Profile API Key does not exist. Use a valid API Key string or ID.");
      }
      apiKeyId = existingKey.id;
    }
    if (!apiKeyId) {
      const [adminKey] = await db.select().from(apiKeys).where(eq(apiKeys.role, 'ADMIN')).orderBy(asc(apiKeys.createdAt)).limit(1);
      apiKeyId = adminKey?.id || null;
    }

    const result = await submitPipelineJob({
      pipeline,
      files,
      endpointSlug,
      correlationId,
      apiKeyId: apiKeyId || undefined,
      disableHistory: false, // Workflows MUST stay visible for GET polling
      // The pipeline entry is only a placeholder; the worker dispatches by
      // schemaSlug so its processor does not need to exist in DB.
      skipConnectorValidation: true,
    });

    if (!result.ok) return result.errorResponse;

    return NextResponse.json(
      {
        name: `operations/${result.operation.id}`,
        done: false,
        metadata: {
          state: 'RUNNING',
          workflow: schemaSlug,
          progress_percent: 0,
          progress_message: 'Initializing schema workflow...',
        },
      },
      {
        status: 202,
        headers: { 'Operation-Location': `/api/v1/operations/${result.operation.id}` },
      },
    );
  } catch (err: any) {
    return apiError(500, 'Internal Workflow Error', err.message);
  }
}
