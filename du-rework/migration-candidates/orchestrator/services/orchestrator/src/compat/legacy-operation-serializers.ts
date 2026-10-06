/**
 * COMP-03b-adjacent: legacy operation RESPONSE serializer.
 *
 * UNMOUNTED, UNFROZEN. Evidence-ready module code for a contract that
 * COMP-00/COMP-02 has not decided. Not the frozen contract.
 *
 * ## What this refuses to do: fabricate a terminal state
 *
 * The legacy formatter (`lib/pipelines/format.ts`) derives `done` from the
 * operation row and gates `result` / `error` on `done && state`. The legacy
 * CANCEL route wrote `done: true, state: 'CANCELLED'` while the worker kept
 * running and then overwrote the row with `SUCCEEDED` (`engine.ts:399-414`),
 * so a legacy client can observe a terminal state that is not true.
 *
 * This module has NO inference path. `done` is true if and only if the caller
 * passed one of the four terminal states. A cancel REQUEST is not a cancel:
 * `CANCEL_REQUESTED` serializes as legacy `RUNNING` with `done: false` and no
 * error block. An `error` block is emitted only when a real error was supplied
 * - this module never invents a code or a message.
 *
 * ## Relationship to the COMP-06 module
 *
 * `legacy-operations.ts` (COMP-06) is a sibling, not a dependency: it is a
 * different shape (`response`/`error` pair rather than `result`) and it
 * SYNTHESISES an error when none was supplied (`toLegacyOperationError`
 * returns `{code:'CANCELLED', message:'Operation was cancelled'}`). That is the
 * fabrication this module is forbidden to repeat, so it is imported nowhere
 * here. Divergence is deliberate and raised for adjudication.
 */

import {
  decodeAdminResourceListSortCursor,
  encodeAdminResourceListSortCursor,
  type AdminResourceListSortCursor,
} from '@du/contracts';

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export const LEGACY_OPERATION_STATES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type LegacyOperationState = (typeof LEGACY_OPERATION_STATES)[number];

export type CanonicalOperationState =
  | 'PENDING_INGESTION'
  | 'ACCEPTED'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_CHILDREN'
  | 'WAITING_INPUT'
  | 'RETRY_PENDING'
  | 'CANCEL_REQUESTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

/** The only states for which `done` may be true. */
export const LEGACY_TERMINAL_STATES: ReadonlySet<CanonicalOperationState> = new Set<CanonicalOperationState>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

const LEGACY_STATE_BY_CANONICAL: Readonly<Record<CanonicalOperationState, LegacyOperationState>> = {
  PENDING_INGESTION: 'PENDING',
  ACCEPTED: 'PENDING',
  QUEUED: 'PENDING',
  RUNNING: 'RUNNING',
  WAITING_CHILDREN: 'RUNNING',
  WAITING_INPUT: 'RUNNING',
  RETRY_PENDING: 'RUNNING',
  CANCEL_REQUESTED: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'FAILED',
  TIMED_OUT: 'FAILED',
};

/* ------------------------------------------------------------------ */
/* Input / output shapes                                               */
/* ------------------------------------------------------------------ */

export interface LegacyOperationError {
  readonly code: string;
  readonly message: string;
  readonly failedStep?: number | null;
}

export interface LegacyUsageProjection {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly pagesProcessed?: number;
  readonly modelUsed?: string | null;
  readonly costUsd?: number;
  readonly breakdown?: unknown;
}

/** Everything the serializer is allowed to know about one operation. */
export interface LegacyOperationProjection {
  readonly id: string;
  readonly state: CanonicalOperationState;
  readonly action?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly progressPercent?: number;
  readonly progressMessage?: string | null;
  readonly currentStep?: number;
  readonly pipeline?: readonly string[];
  readonly pipelineSteps?: unknown;
  readonly outputFormat?: string;
  readonly outputContent?: string | null;
  readonly extractedData?: unknown;
  readonly usage?: LegacyUsageProjection;
  /** Supplied ONLY when the operation really failed. Never synthesized. */
  readonly error?: LegacyOperationError | null;
}

export interface LegacyOperationMetadata {
  readonly state: LegacyOperationState;
  readonly canonical_state: CanonicalOperationState;
  readonly endpoint_slug?: string;
  readonly current_step?: number;
  readonly progress_percent?: number;
  readonly progress_message?: string | null;
  readonly create_time?: string;
  readonly update_time?: string;
  readonly pipeline?: readonly string[];
  readonly pipeline_steps?: unknown;
}

export interface LegacySerializedOperation {
  readonly name: string;
  readonly done: boolean;
  readonly metadata: LegacyOperationMetadata;
  readonly result?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Serializer                                                          */
/* ------------------------------------------------------------------ */

export function toLegacyOperationState(state: CanonicalOperationState): LegacyOperationState {
  const mapped = LEGACY_STATE_BY_CANONICAL[state];
  if (mapped === undefined) {
    throw new Error(`unknown canonical operation state: ${String(state)}`);
  }
  return mapped;
}

/**
 * Project one canonical operation onto the legacy wire shape.
 *
 * `done` is computed from the supplied state alone. There is no branch that
 * sets it from a flag, a timestamp or a caller request, so a caller cannot ask
 * for a terminal body it has not earned.
 */
export function serializeLegacyOperation(
  operation: LegacyOperationProjection,
): LegacySerializedOperation {
  const { state } = operation;
  const done = LEGACY_TERMINAL_STATES.has(state);

  const metadata: Record<string, unknown> = {
    state: toLegacyOperationState(state),
    canonical_state: state,
  };
  if (operation.action !== undefined) metadata.endpoint_slug = operation.action;
  if (operation.currentStep !== undefined) metadata.current_step = operation.currentStep;
  if (operation.progressPercent !== undefined) metadata.progress_percent = operation.progressPercent;
  if (operation.progressMessage !== undefined) metadata.progress_message = operation.progressMessage;
  if (operation.createdAt !== undefined) metadata.create_time = operation.createdAt;
  if (operation.updatedAt !== undefined) metadata.update_time = operation.updatedAt;
  if (operation.pipeline !== undefined) metadata.pipeline = [...operation.pipeline];
  if (operation.pipelineSteps !== undefined) metadata.pipeline_steps = operation.pipelineSteps;

  const body: Record<string, unknown> = {
    name: `operations/${operation.id}`,
    done,
    metadata,
  };

  // SUCCEEDED carries the legacy result block.
  if (done && state === 'SUCCEEDED') {
    const usage = operation.usage ?? {};
    body.result = {
      output_format: operation.outputFormat ?? 'json',
      content: operation.outputContent ?? null,
      extracted_data: operation.extractedData ?? null,
      pipeline_steps: operation.pipelineSteps ?? [],
      usage: {
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        pages_processed: usage.pagesProcessed ?? 0,
        model_used: usage.modelUsed ?? null,
        cost_usd: usage.costUsd ?? 0,
        breakdown: usage.breakdown ?? [],
      },
      download_url: `/api/v1/operations/${operation.id}/download`,
    };
  }

  // FAILED carries the error block ONLY when a real error was supplied. A
  // terminal operation with no error still serializes as done with no error
  // block - inventing one would fabricate the failure reason.
  if (done && state === 'FAILED' && operation.error) {
    body.error = {
      code: operation.error.code,
      message: operation.error.message,
      failed_step: operation.error.failedStep ?? null,
    };
  }

  // CANCELLED and TIMED_OUT: done, with neither result nor error. This matches
  // the legacy formatter, which gated both blocks on SUCCEEDED/FAILED only.

  return body as unknown as LegacySerializedOperation;
}

/* ------------------------------------------------------------------ */
/* Page + 4-slot cursor                                                */
/* ------------------------------------------------------------------ */

export interface LegacySerializedPage {
  readonly operations: LegacySerializedOperation[];
  readonly next_page_token: string | null;
}

/** Sort values the 4-slot cursor dialect accepts (contracts: AdminResourceListSort). */
export const LEGACY_CURSOR_SORTS = ['createdAt:asc', 'createdAt:desc'] as const;
export type LegacyCursorSort = (typeof LEGACY_CURSOR_SORTS)[number];

export const DEFAULT_LEGACY_CURSOR_SORT: LegacyCursorSort = 'createdAt:desc';

/**
 * Serialize a page and mint the continuation token in the shared 4-slot
 * cursor dialect (micros | encodedId | sortCode | direction), so a legacy
 * token and a canonical token stay structurally comparable.
 *
 * A token is emitted only when there IS a next page; the final page returns
 * null so a client stops instead of looping on a dead cursor.
 */
export function serializeLegacyOperationsPage(input: {
  items: readonly LegacyOperationProjection[];
  hasMore: boolean;
  sort?: LegacyCursorSort;
}): LegacySerializedPage {
  const sort = input.sort ?? DEFAULT_LEGACY_CURSOR_SORT;
  const operations = input.items.map((item) => serializeLegacyOperation(item));
  if (!input.hasMore) return { operations, next_page_token: null };

  const last = input.items[input.items.length - 1];
  if (last === undefined) {
    throw new Error('cannot mint a next_page_token: page claims more rows but carries no last item');
  }
  const timestamp = last.updatedAt ?? last.createdAt;
  if (timestamp === undefined) {
    throw new Error('cannot mint a next_page_token: last item has no updatedAt or createdAt');
  }

  return {
    operations,
    next_page_token: encodeLegacyPageToken({
      timestamp,
      id: last.id,
      sort,
      direction: 'next',
    }),
  };
}

/** Mint a token directly, e.g. when the host already holds the boundary row. */
export function encodeLegacyPageToken(cursor: AdminResourceListSortCursor): string {
  return encodeAdminResourceListSortCursor(cursor);
}

/**
 * Decode a token back to its cursor. Returns null for anything the dialect
 * does not define, so a tampered or truncated token fails closed instead of
 * being coerced into a position.
 */
export function decodeLegacyPageToken(
  token: string,
): AdminResourceListSortCursor | null {
  return decodeAdminResourceListSortCursor(token);
}
