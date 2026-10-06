// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/contracts/src/operations.ts (lines=403) sha256=34454DD2AB549A47D7732DDE6ED81E187EEC94C61199963B417F743EDC803817
// why: ArtifactRef, IngestionReceiptSchema, resolveIngestionSource (+private INGESTION_HANDLE_REGEX) for src/types/context.ts, src/types/actions.ts, src/validation/input-normalizer.ts

import { z } from 'zod';
import { adjudicateUrlDestination, DESTINATION_DENIED } from './ip-policy';
import { RecipientDeliveryEnvelopeSchema } from './encryption';

/**
 * Operation/task/invocation state machines (docs 04).
 * Terminal states are frozen: no transition out; resume creates a new
 * operation via `replayOf`.
 */

export const OperationStates = [
  'PENDING_INGESTION',
  'ACCEPTED',
  'QUEUED',
  'RUNNING',
  'WAITING_CHILDREN',
  'WAITING_INPUT',
  'RETRY_PENDING',
  'CANCEL_REQUESTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export type OperationState = (typeof OperationStates)[number];

export const OperationStateSchema = z.enum(OperationStates);

export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
];

export const isTerminalOperationState = (s: OperationState): boolean =>
  TERMINAL_OPERATION_STATES.includes(s);

export const TaskStates = [
  'PENDING_INGESTION',
  'READY',
  'RUNNING',
  'WAITING_CHILDREN',
  'WAITING_INPUT',
  'RETRY_PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskState = (typeof TaskStates)[number];
export const TaskStateSchema = z.enum(TaskStates);

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
export const isTerminalTaskState = (s: TaskState): boolean => TERMINAL_TASK_STATES.includes(s);

export const InvocationStates = [
  'NEW',
  'IN_FLIGHT',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED',
] as const;
export type InvocationState = (typeof InvocationStates)[number];
export const InvocationStateSchema = z.enum(InvocationStates);

/**
 * Pure transition tables. The runtime uses these as the single source of
 * truth; a transition not listed here is a contract violation (test-guarded).
 */

export const OPERATION_TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  PENDING_INGESTION: ['QUEUED', 'CANCEL_REQUESTED', 'TIMED_OUT', 'FAILED'],
  ACCEPTED: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'TIMED_OUT', 'FAILED'],
  QUEUED: ['RUNNING', 'CANCEL_REQUESTED', 'TIMED_OUT', 'FAILED'],
  RUNNING: [
    'WAITING_CHILDREN',
    'WAITING_INPUT',
    'RETRY_PENDING',
    'SUCCEEDED',
    'FAILED',
    'CANCEL_REQUESTED',
    'TIMED_OUT',
  ],
  WAITING_CHILDREN: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'TIMED_OUT', 'FAILED'],
  WAITING_INPUT: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'TIMED_OUT', 'FAILED'],
  RETRY_PENDING: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'TIMED_OUT', 'FAILED'],
  CANCEL_REQUESTED: ['CANCELLED', 'TIMED_OUT'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PENDING_INGESTION: ['READY', 'CANCELLED', 'FAILED'],
  READY: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['WAITING_CHILDREN', 'WAITING_INPUT', 'RETRY_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  WAITING_CHILDREN: ['RUNNING', 'CANCELLED', 'FAILED'],
  WAITING_INPUT: ['RUNNING', 'CANCELLED', 'FAILED'],
  RETRY_PENDING: ['RUNNING', 'CANCELLED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(
  from: OperationState,
  to: OperationState
): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------ */
/* Public operation DTOs (docs 06)                                     */
/* ------------------------------------------------------------------ */

export const ProgressSchema = z.object({
  percent: z.number().min(0).max(100),
  message: z.string().optional(),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const OperationViewSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  businessId: z.string(),
  businessVersion: z.string(),
  action: z.string(),
  state: OperationStateSchema,
  stateVersion: z.number().int().min(0),
  createdAt: z.string(), // RFC3339 UTC
  updatedAt: z.string(),
  deadlineAt: z.string().nullable(),
  replayOf: z.string().uuid().nullable().optional(),
  progress: ProgressSchema,
  links: z.object({
    self: z.string(),
    result: z.string(),
  }),
});
export type OperationView = z.infer<typeof OperationViewSchema>;

export const UsageMeasurement = ['measured', 'estimated', 'pending', 'final', 'corrected'] as const;
export const UsageMeasurementSchema = z.enum(UsageMeasurement);

export const UsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costMicrousd: z.number().int().min(0),
  measurement: UsageMeasurementSchema,
});
export type Usage = z.infer<typeof UsageSchema>;

export const ArtifactRefSchema = z.object({
  artifactId: z.string().uuid(),
  role: z.string().default('output'),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().min(0).optional(),
  hashSha256: z.string().optional(),
  download: z.string().optional(), // relative URL
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ResultEnvelopeSchema = z.object({
  schemaVersion: z.literal('1'),
  data: z.unknown(),
  artifacts: z.array(ArtifactRefSchema).default([]),
  usage: UsageSchema,
  warnings: z.array(z.string()).default([]),
}).strict();
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

/**
 * Encrypted result response selected only by the server-side tenant policy.
 * Decrypting `delivery` yields the exact ResultEnvelope above.
 */
export const EncryptedResultEnvelopeSchema = z.object({
  schemaVersion: z.literal('1'),
  encrypted: z.literal(true),
  delivery: RecipientDeliveryEnvelopeSchema,
}).strict();
export type EncryptedResultEnvelope = z.infer<typeof EncryptedResultEnvelopeSchema>;

/** GET /operations/{id}/result: inline ResultEnvelope or recipient envelope. */
export const ResultResponseSchema = z.union([
  ResultEnvelopeSchema,
  EncryptedResultEnvelopeSchema,
]);
export type ResultResponse = z.infer<typeof ResultResponseSchema>;

/** JSON content type for the encrypted download response variant. */
export const ENCRYPTED_DELIVERY_CONTENT_TYPE = 'application/json' as const;

/** GET /artifacts/{id}/download when delivery encryption is enabled. */
export const EncryptedArtifactDownloadSchema = z.object({
  schemaVersion: z.literal('1'),
  encrypted: z.literal(true),
  delivery: RecipientDeliveryEnvelopeSchema,
  artifactId: z.string().uuid(),
  mimeType: z.string().min(1).max(255),
}).strict();
export type EncryptedArtifactDownload = z.infer<typeof EncryptedArtifactDownloadSchema>;

/**
 * Plain downloads stay byte-for-byte HTTP bodies (Buffer/Uint8Array or a
 * streaming async iterable); the response Content-Type is the artifact MIME.
 */
export type PlainArtifactDownloadBody = Uint8Array | AsyncIterable<Uint8Array>;
export const PlainArtifactDownloadBodySchema = z.custom<PlainArtifactDownloadBody>(
  (value): value is PlainArtifactDownloadBody => {
    if (value instanceof Uint8Array) return true;
    if (typeof value !== 'object' || value === null) return false;
    return typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
  },
  'plain artifact download must be bytes or an async byte stream',
);

/** GET /artifacts/{id}/download: raw bytes or the encrypted JSON wrapper. */
export const ArtifactDownloadResponseSchema = z.union([
  PlainArtifactDownloadBodySchema,
  EncryptedArtifactDownloadSchema,
]);
export type ArtifactDownloadResponse = z.infer<typeof ArtifactDownloadResponseSchema>;

export const HumanWaitViewSchema = z.object({
  waitId: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  uiSchema: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string(),
});
export type HumanWaitView = z.infer<typeof HumanWaitViewSchema>;

export const OperationDetailSchema = OperationViewSchema.extend({
  wait: HumanWaitViewSchema.nullable().optional(),
  error: z
    .object({
      code: z.string(),
      title: z.string(),
      detail: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type OperationDetail = z.infer<typeof OperationDetailSchema>;

/* ------------------------------------------------------------------ */
/* Submission DTOs (docs 06)                                           */
/* ------------------------------------------------------------------ */

/**
 * FIX-CR-01 / FR24-07: a bare url() check only proves parseability — measured 8/8 hostile
 * URLs passed it (file scheme, userinfo, 2130706433, 127.1, 0177.0.0.1, IPv6-mapped
 * loopback). Literal-IP and protocol/userinfo adjudication runs at submit time; hostname
 * answers are re-adjudicated by the webhook dispatcher at delivery (DNS may legitimately
 * change between submit and dispatch).
 */
export const CallbackConfigSchema = z.object({
  url: z
    .string()
    .url()
    .superRefine((value, ctx) => {
      const decision = adjudicateUrlDestination(value);
      if (decision.kind === 'DENIED') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'callback destination is not allowed',
          path: ['url'],
          params: { code: DESTINATION_DENIED, reason: decision.reason },
        });
      }
    }),
});
export type CallbackConfig = z.infer<typeof CallbackConfigSchema>;

export const SubmissionSchema = z
  .object({
    input: z.record(z.string(), z.unknown()),
    sourceUrl: z.string().max(2048).optional(),
    artifacts: z
      .array(z.object({ artifactId: z.string().uuid(), role: z.string().min(1) }))
      .optional(),
    output: z.record(z.string(), z.unknown()).optional(),
    callback: CallbackConfigSchema.optional(),
    clientReference: z.string().max(512).optional(),
  })
  .strict();
export type Submission = z.infer<typeof SubmissionSchema>;

/**
 * Correlation ID: client-supplied or server-generated. Length/charset
 * validated per docs 06.
 */
export const CORRELATION_ID_REGEX = /^[A-Za-z0-9._-]{8,128}$/;
export const CorrelationIdSchema = z.string().regex(CORRELATION_ID_REGEX);

/** Idempotency-Key charset (docs 06). */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
export const IdempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_REGEX);

/* ------------------------------------------------------------------ */
/* Ingestion source pin (DATA-03; packet W-DATA01-S3-FACADE-1, Δ14)    */
/* ------------------------------------------------------------------ */

/** Printable, non-empty object/version handle — never control characters. */
const INGESTION_HANDLE_REGEX = /^[\x20-\x7e]+$/;

/**
 * The durable proof a READY gate stands on: the private-storage object
 * version a URL submission was acquired into, with the digest and length
 * measured over the bytes storage actually committed.
 *
 * This is THE canonical shape: the Orchestrator's `markIngestionReady`, the
 * worker-SDK producer leg, and business consumers all resolve it through the
 * helpers below instead of each keeping a private copy. Before this contract
 * existed, `markIngestionReady` wrote the receipt under an undeclared
 * `operations.input_ref.__source` key with zero readers while the task row a
 * worker actually claims got the bare action input (Δ14) — so "where does a
 * URL-ingested source live" had three incompatible answers.
 *
 * `artifactId` is the materialization handle: the ingestion consumer sets it
 * once the pinned version also exists as a READY artifact row, so the
 * business task resolves the source through the normal artifact-access flow
 * (grant + digest-verified read). A pin WITHOUT `artifactId` proves the bytes
 * are stored but not yet readable as an artifact — consumers must fail
 * visibly on that distinction, never downgrade to a generic "no input
 * document" error.
 */
export const IngestionReceiptSchema = z
  .object({
    storageKey: z.string().min(1).regex(INGESTION_HANDLE_REGEX, 'storageKey must be a printable, non-empty object key'),
    versionId: z
      .string()
      .min(1)
      .regex(INGESTION_HANDLE_REGEX, 'versionId must be a printable, non-empty immutable version handle'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be lowercase 64-char hex'),
    sizeBytes: z.number().int().min(0).refine(Number.isSafeInteger, 'sizeBytes must be a non-negative safe integer'),
    artifactId: z.string().uuid().optional(),
  })
  .strict();
export type IngestionReceipt = z.infer<typeof IngestionReceiptSchema>;

/** Raised for any pin that cannot be trusted to carry a READY gate. */
export class IngestionReceiptError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'IngestionReceiptError';
  }
}

/** Canonical payload field carrying the pin. One key, declared once. */
export const INGESTION_SOURCE_FIELD = 'source';
/** Pre-contract writer-only key; still readable for operations admitted before the cutover. */
export const LEGACY_INGESTION_SOURCE_FIELD = '__source';

/** Validates and returns the receipt, or throws `IngestionReceiptError`. */
export function assertIngestionReceipt(value: unknown): IngestionReceipt {
  const parsed = IngestionReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new IngestionReceiptError(
      `ingestion receipt failed contract validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`
    );
  }
  return parsed.data;
}

/**
 * Builds the READY payload envelope: the action input plus the canonical pin,
 * with the legacy key dropped. Fails closed BEFORE any byte of it can be
 * persisted — the same serialized envelope is what must go to both
 * `operations.input_ref` and `tasks.payload_ref` so the claim-side choice
 * between them can never resolve to two different stories.
 */
export function withIngestionSource(
  input: Record<string, unknown>,
  receipt: IngestionReceipt
): Record<string, unknown> {
  const pin = assertIngestionReceipt(receipt);
  const envelope: Record<string, unknown> = { ...input };
  delete envelope[LEGACY_INGESTION_SOURCE_FIELD];
  envelope[INGESTION_SOURCE_FIELD] = pin;
  return envelope;
}

/**
 * Resolves the pin from a task payload. A missing pin — inline submission,
 * pre-gate row, or a payload written before the gate existed — returns null
 * and never fails. A pin that is PRESENT but malformed throws: a corrupted
 * envelope must not silently downgrade to "no source".
 */
export function resolveIngestionSource(value: unknown): IngestionReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate = record[INGESTION_SOURCE_FIELD] ?? record[LEGACY_INGESTION_SOURCE_FIELD];
  if (candidate === undefined || candidate === null) return null;
  return assertIngestionReceipt(candidate);
}
