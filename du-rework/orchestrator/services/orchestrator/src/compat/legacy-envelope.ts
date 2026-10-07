/**
 * STRICT legacy operation envelope — a field-for-field reproduction of
 * `lib/pipelines/format.ts` (`formatOperationResponse`) in the legacy repo.
 *
 * ## Why this exists next to `legacy-operation-serializers.ts`
 *
 * That module is a *deliberate* divergence, documented in its own header: it
 * refuses to fabricate terminal states and it flattens the state vocabulary.
 * Those are defensible product decisions, but they are NOT wire parity, and
 * the user requirement for this surface is byte-level compatibility with the
 * old system. Concretely it differs from the legacy formatter in five ways:
 *
 * | # | `format.ts` (legacy truth) | `legacy-operation-serializers.ts` |
 * |---|---|---|
 * | 1 | `metadata.state` is the row's own state, verbatim | mapped through `LEGACY_STATE_BY_CANONICAL`, so `CANCELLED` and `TIMED_OUT` both become `FAILED` |
 * | 2 | no `canonical_state` key | adds `metadata.canonical_state` |
 * | 3 | a FAILED operation also carries `result` (short usage) when `stepsResultJson` is set | emits no `result` for FAILED at all |
 * | 4 | `next_page_token` is the plain uuid of the last row | a 4-slot encoded cursor token |
 * | 5 | `metadata.pipeline` comes from parsing `pipelineJson` | supplied by the caller as an array |
 *
 * Item 4 is the one that breaks a client outright: the legacy `page_token` is
 * an operation id, and the old list route feeds it straight back into an
 * `eq(operations.id, pageToken)` lookup. A base64 dialect token matches no
 * row and silently collapses pagination to page 1 forever.
 *
 * This module therefore implements the legacy shape only. It is the compat
 * surface; the canonical surface in `packages/contracts` is untouched.
 */

export interface LegacyOperationRow {
  readonly id: string;
  readonly done: boolean;
  /** The row's own state string, passed through verbatim (defect 1 above). */
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
  const body: Record<string, unknown> = {
    name: `operations/${row.id}`,
    done: row.done,
    metadata: {
      state: row.state,
      pipeline: processorsOf(row.pipelineJson),
      current_step: row.currentStep ?? null,
      progress_percent: row.progressPercent ?? null,
      progress_message: row.progressMessage ?? null,
      create_time: timeOf(row.createdAt),
      update_time: timeOf(row.updatedAt),
      pipeline_steps: steps,
    },
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
  const item: Record<string, unknown> = {
    name: `operations/${row.id}`,
    done: row.done,
    metadata: {
      state: row.state,
      endpoint_slug: row.endpointSlug,
      current_step: row.currentStep,
      progress_percent: row.progressPercent,
      progress_message: row.progressMessage,
      create_time: row.createdAt,
      update_time: row.updatedAt,
    },
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
