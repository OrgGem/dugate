/**
 * STRICT legacy operation envelope — a field-for-field reproduction of
 * `lib/pipelines/format.ts` (`formatOperationResponse`) in the legacy repo.
 *
 * The host adapter normalizes canonical lifecycle states and projects result
 * artifacts before constructing this stable old-client response shape. This
 * module intentionally contains no database or worker dependencies.
 */

export interface LegacyOperationRow {
  readonly id: string;
  readonly done: boolean;
  /** The host-normalized lifecycle token exposed to legacy pollers. */
  readonly state: string;
  /** Raw `pipelineJson`; parsed to a processor-name list. */
  readonly pipelineJson?: string | null;
  /** Raw `stepsResultJson`. A non-empty value is what adds `result` on FAILED. */
  readonly stepsResultJson?: string | null;
  readonly currentStep?: number | null;
  readonly progressPercent?: number | null;
  readonly progressMessage?: string | null;
  readonly createdAt?: string | Date | null;
  readonly updatedAt?: string | Date | null;
  readonly outputFormat?: string | null;
  readonly outputContent?: string | null;
  /** File-backend output reference (legacy local OUTPUT_DIR path or S3 key). */
  readonly outputFilePath?: string | null;
  /** Internal download name from the first operation-owned submitted artifact. */
  readonly sourceFileName?: string | null;
  readonly extractedData?: string | null;
  readonly totalInputTokens?: number | null;
  readonly totalOutputTokens?: number | null;
  readonly pagesProcessed?: number | null;
  readonly modelUsed?: string | null;
  readonly totalCostUsd?: number | null;
  readonly usageBreakdown?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly failedAtStep?: number | null;
  /** Present only on the list projection, never on submit or by-id reads. */
  readonly endpointSlug?: string | null;
  /** Additive identity marker for workflow polls; absent on ordinary actions. */
  readonly workflow?: string | null;
  readonly schemaRevision?: number | null;
  readonly schemaDigest?: string | null;
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * `pipeline` is a list of `{processor}` in the legacy row; anything else
 * degrades to an empty list exactly as `safeParse` did.
 */
function processorsOf(pipelineJson: string | null | undefined): string[] {
  const parsed = safeParse<unknown>(pipelineJson, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((step) => {
      const processor = (step as { processor?: unknown } | null)?.processor;
      return typeof processor === 'string' ? processor : '';
    })
    .filter((name) => name.length > 0);
}

function timeOf(value: string | Date | null | undefined): unknown {
  if (value === null || value === undefined) return value;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Project one operation row onto the exact body `formatOperationResponse`
 * returns. Every key is present on every call — the legacy formatter wrote
 * `metadata` unconditionally and simply let a missing column serialise as
 * null, so a client reading `metadata.progress_percent` never had to guard.
 */
export function toLegacyEnvelope(row: LegacyOperationRow): Record<string, unknown> {
  const steps = safeParse<unknown>(row.stepsResultJson, []);
  const metadata: Record<string, unknown> = {
    state: row.state,
    pipeline: processorsOf(row.pipelineJson),
    current_step: row.currentStep ?? null,
    progress_percent: row.progressPercent ?? null,
    progress_message: row.progressMessage ?? null,
    create_time: timeOf(row.createdAt),
    update_time: timeOf(row.updatedAt),
    pipeline_steps: steps,
  };
  if (row.workflow) metadata.workflow = row.workflow;
  if (row.schemaRevision !== null && row.schemaRevision !== undefined) metadata.schema_revision = row.schemaRevision;
  if (row.schemaDigest) metadata.schema_digest = row.schemaDigest;
  const body: Record<string, unknown> = {
    name: `operations/${row.id}`,
    done: row.done,
    metadata,
  };

  if (row.done && row.state === 'SUCCEEDED') {
    body.result = {
      output_format: row.outputFormat,
      content: row.outputContent,
      extracted_data: safeParse<unknown>(row.extractedData, null),
      pipeline_steps: steps,
      usage: {
        input_tokens: row.totalInputTokens,
        output_tokens: row.totalOutputTokens,
        pages_processed: row.pagesProcessed,
        model_used: row.modelUsed,
        cost_usd: row.totalCostUsd,
        breakdown: safeParse<unknown>(row.usageBreakdown, []),
      },
      download_url: `/api/v1/operations/${row.id}/download`,
    };
  }

  if (row.done && row.state === 'FAILED') {
    body.error = {
      code: row.errorCode,
      message: row.errorMessage,
      failed_step: row.failedAtStep,
    };
    // The legacy guard is a truthiness test on the RAW json string, so a
    // FAILED operation that never recorded steps has no result block at all.
    if (row.stepsResultJson) {
      body.result = {
        pipeline_steps: steps,
        usage: {
          input_tokens: row.totalInputTokens,
          output_tokens: row.totalOutputTokens,
          cost_usd: row.totalCostUsd,
          breakdown: safeParse<unknown>(row.usageBreakdown, []),
        },
      };
    }
  }

  // CANCELLED / TIMED_OUT: done, with neither block. That is what the legacy
  // formatter did, and inventing an error for a cancellation is a wire change.
  return body;
}

/**
 * The lighter projection the legacy LIST route returned.
 *
 * It is not `formatOperationResponse`: no `pipeline`, no `pipeline_steps`, no
 * `create_time`-shaped extras beyond the seven fields below, and the `result`
 * block carries only three usage counters. Reusing the full envelope here
 * would make a list response heavier than the one clients parse today.
 */
export function toLegacyListItem(row: LegacyOperationRow): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    state: row.state,
    endpoint_slug: row.endpointSlug,
    current_step: row.currentStep,
    progress_percent: row.progressPercent,
    progress_message: row.progressMessage,
    create_time: row.createdAt,
    update_time: row.updatedAt,
  };
  if (row.workflow) metadata.workflow = row.workflow;
  if (row.schemaRevision !== null && row.schemaRevision !== undefined) metadata.schema_revision = row.schemaRevision;
  if (row.schemaDigest) metadata.schema_digest = row.schemaDigest;
  const item: Record<string, unknown> = {
    name: `operations/${row.id}`,
    done: row.done,
    metadata,
  };

  if (row.done && row.state === 'FAILED') {
    item.error = {
      code: row.errorCode,
      message: row.errorMessage,
      failed_step: row.failedAtStep,
    };
  }

  if (row.done && row.state === 'SUCCEEDED') {
    item.result = {
      usage: {
        input_tokens: row.totalInputTokens,
        output_tokens: row.totalOutputTokens,
        cost_usd: row.totalCostUsd,
      },
    };
  }

  return item;
}

export interface LegacyListPage {
  readonly operations: Record<string, unknown>[];
  readonly next_page_token: string | null;
}

/**
 * Build one list page. `next_page_token` is the plain operation id of the
 * LAST row on the page — the legacy route read it back with an
 * `eq(operations.id, pageToken)` lookup, so anything richer breaks paging.
 */
export function toLegacyListPage(
  rows: readonly LegacyOperationRow[],
  hasMore: boolean,
): LegacyListPage {
  const operations = rows.map((row) => toLegacyListItem(row));
  if (!hasMore) return { operations, next_page_token: null };
  const last = rows[rows.length - 1];
  return { operations, next_page_token: last === undefined ? null : last.id };
}
