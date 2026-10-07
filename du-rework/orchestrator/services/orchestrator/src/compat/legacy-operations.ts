/**
 * COMP-06: isolated projection between the canonical operations API and the
 * legacy operations wire shape. This module deliberately imports neither the
 * HTTP server nor @du/contracts: a caller can adopt it without changing the
 * canonical contracts or coupling it to route selection.
 *
 * Legacy page tokens are operation IDs. A route using this mapper must resolve
 * `afterOperationId` only inside its already-authorized tenant scope, then use
 * that row's (created_at, id) tuple for canonical keyset pagination. The
 * canonical cursor itself is never returned to a legacy client.
 */

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

export type LegacyOperationState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface CanonicalOperationError {
  code: string;
  title: string;
  detail?: string;
}

export interface CanonicalOperation {
  id: string;
  name?: string;
  state: CanonicalOperationState;
  action?: string;
  createdAt?: string;
  updatedAt?: string;
  progress?: {
    percent?: number;
    message?: string;
  };
  error?: CanonicalOperationError | null;
}

export interface LegacyOperationError {
  code: string;
  message: string;
}

export interface LegacyOperation {
  name: string;
  done: boolean;
  metadata: {
    state: LegacyOperationState;
    canonical_state: CanonicalOperationState;
    endpoint_slug?: string;
    progress_percent?: number;
    progress_message?: string;
    create_time?: string;
    update_time?: string;
  };
  response: unknown | null;
  error: LegacyOperationError | null;
}

export interface LegacyOperationsQueryInput {
  page_size?: string | null;
  page_token?: string | null;
  filter?: string | null;
}

export interface LegacyOperationsListQuery {
  /** Canonical page size, bounded to the public API's 1..100 range. */
  limit: number;
  /** Legacy op-id cursor, to be resolved inside the authenticated tenant. */
  afterOperationId: string | null;
  filters: {
    /** Canonical states corresponding to the requested legacy state group. */
    states: readonly CanonicalOperationState[] | null;
    /** Legacy processor selector, preserved for the backend's processor index. */
    processor: string | null;
  };
}

export interface CanonicalOperationsPage {
  items: readonly CanonicalOperation[];
  nextCursor: string | null;
}

export interface LegacyOperationsPage {
  operations: LegacyOperation[];
  next_page_token: string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const LEGACY_STATE_FILTERS: Readonly<
  Record<LegacyOperationState, readonly CanonicalOperationState[]>
> = {
  PENDING: ['PENDING_INGESTION', 'ACCEPTED', 'QUEUED'],
  RUNNING: ['RUNNING', 'WAITING_CHILDREN', 'WAITING_INPUT', 'RETRY_PENDING', 'CANCEL_REQUESTED'],
  SUCCEEDED: ['SUCCEEDED'],
  FAILED: ['FAILED', 'CANCELLED', 'TIMED_OUT'],
};

const TERMINAL_STATES: readonly CanonicalOperationState[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
];

/** Error that lets an HTTP adapter preserve the legacy 400 filter behavior. */
export class LegacyOperationFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyOperationFilterError';
  }
}

/** Map canonical lifecycle states to the smaller legacy state vocabulary. */
export function toLegacyOperationState(state: CanonicalOperationState): LegacyOperationState {
  switch (state) {
    case 'PENDING_INGESTION':
    case 'ACCEPTED':
    case 'QUEUED':
      return 'PENDING';
    case 'RUNNING':
    case 'WAITING_CHILDREN':
    case 'WAITING_INPUT':
    case 'RETRY_PENDING':
    case 'CANCEL_REQUESTED':
      return 'RUNNING';
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
    case 'CANCELLED':
    case 'TIMED_OUT':
      return 'FAILED';
  }
}

/**
 * Project one canonical operation. `response` is supplied by the caller when
 * the canonical result has already been loaded; pending operations always
 * remain `done: false`, including WAITING_INPUT and CANCEL_REQUESTED.
 */
export function mapCanonicalOperationToLegacy(
  operation: CanonicalOperation,
  response?: unknown,
): LegacyOperation {
  const { state } = operation;
  const done = TERMINAL_STATES.includes(state);
  const error = toLegacyOperationError(state, operation.error);
  const metadata: LegacyOperation['metadata'] = {
    state: toLegacyOperationState(state),
    canonical_state: state,
  };

  if (operation.action !== undefined) metadata.endpoint_slug = operation.action;
  if (operation.progress?.percent !== undefined) {
    metadata.progress_percent = operation.progress.percent;
  }
  if (operation.progress?.message !== undefined) {
    metadata.progress_message = operation.progress.message;
  }
  if (operation.createdAt !== undefined) metadata.create_time = operation.createdAt;
  if (operation.updatedAt !== undefined) metadata.update_time = operation.updatedAt;

  return {
    name: operation.name ?? `operations/${operation.id}`,
    done,
    metadata,
    response: state === 'SUCCEEDED' ? response ?? null : null,
    error,
  };
}

/** Normalize legacy page_size/page_token/filter into a route-neutral query. */
export function mapLegacyOperationsQuery(
  input: LegacyOperationsQueryInput,
): LegacyOperationsListQuery {
  const pageSize = parsePageSize(input.page_size);
  const pageToken = input.page_token?.trim() || null;
  let states: readonly CanonicalOperationState[] | null = null;
  let processor: string | null = null;

  for (const clause of input.filter?.split(',') ?? []) {
    const separator = clause.indexOf('=');
    if (separator < 0) continue;

    const key = clause.slice(0, separator).trim();
    const value = clause.slice(separator + 1).trim();
    if (key === 'state') {
      if (!isLegacyOperationState(value)) {
        throw new LegacyOperationFilterError(
          `Invalid state filter. Must be one of: ${Object.keys(LEGACY_STATE_FILTERS).join(', ')}`,
        );
      }
      states = LEGACY_STATE_FILTERS[value];
    } else if (key === 'processor') {
      processor = value;
    }
  }

  return {
    limit: pageSize,
    afterOperationId: pageToken,
    filters: { states, processor },
  };
}

/**
 * Project a canonical keyset page while keeping the legacy continuation token
 * in its original operation-ID dialect.
 */
export function mapCanonicalOperationsPageToLegacy(
  page: CanonicalOperationsPage,
): LegacyOperationsPage {
  const hasNextPage = page.nextCursor !== null;
  const lastItem = page.items.at(-1);
  if (hasNextPage && !lastItem) {
    throw new Error('canonical operations page has a next cursor but no item for a legacy page token');
  }

  return {
    operations: page.items.map((operation) => mapCanonicalOperationToLegacy(operation)),
    next_page_token: hasNextPage ? lastItem?.id ?? null : null,
  };
}

function parsePageSize(value: string | null | undefined): number {
  if (value == null || value.trim() === '') return DEFAULT_PAGE_SIZE;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, parsed));
}

function isLegacyOperationState(value: string): value is LegacyOperationState {
  return Object.prototype.hasOwnProperty.call(LEGACY_STATE_FILTERS, value);
}

function toLegacyOperationError(
  state: CanonicalOperationState,
  error: CanonicalOperationError | null | undefined,
): LegacyOperationError | null {
  if (!TERMINAL_STATES.includes(state) || state === 'SUCCEEDED') return null;
  if (error) {
    return {
      code: error.code,
      message: error.detail ?? error.title,
    };
  }
  if (state === 'TIMED_OUT') return { code: 'TIMED_OUT', message: 'Operation timed out' };
  if (state === 'CANCELLED') return { code: 'CANCELLED', message: 'Operation was cancelled' };
  return { code: 'FAILED', message: 'Operation failed' };
}
