import { z } from 'zod';

/**
 * Operation/task/invocation state machines (docs 04).
 * Terminal states are frozen: no transition out; resume creates a new
 * operation via `replayOf`.
 */

export const OperationStates = [
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
});
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

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

export const CallbackConfigSchema = z.object({
  url: z.string().url(),
});
export type CallbackConfig = z.infer<typeof CallbackConfigSchema>;

export const SubmissionSchema = z
  .object({
    input: z.record(z.string(), z.unknown()),
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