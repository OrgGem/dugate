import { z } from 'zod';

const SafeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/);
const CountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.string().datetime({ offset: true });

export const ConnectorSignalSnapshotQuerySchema = z.object({
  tenantId: z.string().uuid(),
  from: TimestampSchema,
  to: TimestampSchema,
}).strict().superRefine((query, context) => {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (!(to > from) || to - from > 31 * 24 * 60 * 60 * 1000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'signal window must be non-empty and no longer than 31 days' });
  }
});
export type ConnectorSignalSnapshotQuery = z.infer<typeof ConnectorSignalSnapshotQuerySchema>;

export const ConnectorInvocationSignalStates = ['NEW', 'IN_FLIGHT', 'PENDING', 'POLLING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'] as const;
export const ConnectorInvocationSignalStateSchema = z.enum(ConnectorInvocationSignalStates);

export const ConnectorSignalInvocationSchema = z.object({
  tenantId: z.string().uuid(),
  operationId: z.string().uuid(),
  taskId: z.string().uuid(),
  invocationId: z.string().uuid(),
  stepKey: SafeIdSchema,
  connectorId: SafeIdSchema.nullable(),
  connectorRevision: z.number().int().min(1).nullable(),
  state: ConnectorInvocationSignalStateSchema,
  errorCode: z.string().regex(/^[A-Z0-9_-]{1,48}$/).nullable(),
  updatedAt: TimestampSchema,
}).strict().superRefine((row, context) => {
  if ((row.connectorId === null) !== (row.connectorRevision === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['connectorId'], message: 'connector identity must be fully available or fully unknown' });
  }
});
export type ConnectorSignalInvocation = z.infer<typeof ConnectorSignalInvocationSchema>;

export const ConnectorSignalOutboxEventSchema = z.object({
  eventId: z.string().min(1).max(256),
  operationId: z.string().uuid(),
  taskId: z.string().uuid(),
  invocationId: z.string().uuid(),
  state: z.enum(['PENDING', 'DELIVERED']),
  attempts: CountSchema,
  failedAttempts: CountSchema,
  createdAt: TimestampSchema,
  deliveredAt: TimestampSchema.nullable(),
}).strict().superRefine((event, context) => {
  if ((event.state === 'DELIVERED') !== (event.deliveredAt !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveredAt'], message: 'delivery state must match deliveredAt' });
  }
  if (event.failedAttempts > event.attempts) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['failedAttempts'], message: 'failed attempts cannot exceed total attempts' });
  }
});
export type ConnectorSignalOutboxEvent = z.infer<typeof ConnectorSignalOutboxEventSchema>;

export const ConnectorSignalSnapshotSchema = z.object({
  snapshotId: z.string().uuid(),
  sourceRef: z.string().min(1).max(192),
  tenantId: z.string().uuid(),
  from: TimestampSchema,
  to: TimestampSchema,
  sampledAt: TimestampSchema,
  freshness: z.enum(['fresh', 'stale', 'unavailable']),
  invocationCounts: z.object({
    NEW: CountSchema,
    IN_FLIGHT: CountSchema,
    PENDING: CountSchema,
    POLLING: CountSchema,
    SUCCEEDED: CountSchema,
    FAILED: CountSchema,
    UNKNOWN: CountSchema,
    CANCELLED: CountSchema,
  }).strict(),
  failedByCode: z.array(z.object({ errorCode: z.string().regex(/^[A-Z0-9_-]{1,48}$/), count: CountSchema }).strict()).max(64),
  affectedInvocations: z.array(ConnectorSignalInvocationSchema).max(100),
  usageOutbox: z.object({
    pending: CountSchema,
    failedDeliveryAttempts: CountSchema,
    oldestPendingAt: TimestampSchema.nullable(),
    oldestPendingLagMs: CountSchema.nullable(),
    maxAttempts: CountSchema,
    affected: z.array(ConnectorSignalOutboxEventSchema).max(100),
  }).strict(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.sourceRef !== `connector-ledger:${snapshot.tenantId}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceRef'], message: 'source reference must identify this tenant ledger' });
  }
  if (Date.parse(snapshot.to) <= Date.parse(snapshot.from)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'snapshot window must be non-empty' });
  }
  if (snapshot.affectedInvocations.some((row) => row.tenantId !== snapshot.tenantId)
    || snapshot.usageOutbox.affected.some((row) => !snapshot.affectedInvocations.some((invocation) => invocation.invocationId === row.invocationId && invocation.tenantId === snapshot.tenantId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedInvocations'], message: 'affected records must be tenant-fenced and outbox rows must reference returned invocations' });
  }
  if (snapshot.freshness !== 'fresh' && snapshot.usageOutbox.oldestPendingLagMs !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['freshness'], message: 'stale/unavailable snapshots cannot claim current pending lag' });
  }
});
export type ConnectorSignalSnapshot = z.infer<typeof ConnectorSignalSnapshotSchema>;
