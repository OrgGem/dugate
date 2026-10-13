import { z } from 'zod';

const SafeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const UtcTimestamp = z.string().datetime({ offset: true });
const IncidentId = z.string().uuid();

export const IncidentSourceSchema = z.enum(['runtime', 'queue', 'connector', 'provider', 'delivery', 'deployment', 'maintenance']);
export type IncidentSource = z.infer<typeof IncidentSourceSchema>;
export const IncidentSeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;
export const IncidentStatusSchema = z.enum(['open', 'acknowledged', 'resolved']);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;
export const IncidentSourceStateSchema = z.enum(['active', 'recovered', 'reconciled']);
export type IncidentSourceState = z.infer<typeof IncidentSourceStateSchema>;

export const IncidentScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform') }).strict(),
  z.object({ kind: z.literal('tenant'), tenantId: SafeId }).strict(),
]);
export type IncidentScope = z.infer<typeof IncidentScopeSchema>;

export const IncidentResourceKindSchema = z.enum(['service', 'replica', 'queue', 'operation', 'invocation', 'connector', 'delivery', 'deployment', 'maintenance-job']);
export type IncidentResourceKind = z.infer<typeof IncidentResourceKindSchema>;
export const IncidentAffectedResourceSchema = z.object({
  kind: IncidentResourceKindSchema,
  ref: SafeId,
  label: z.string().trim().min(1).max(128),
}).strict();
export type IncidentAffectedResource = z.infer<typeof IncidentAffectedResourceSchema>;

/** Trusted owner-service signal. Payload contains only bounded labels and counts, never provider or customer payloads. */
export const IncidentSignalSchema = z.object({
  source: IncidentSourceSchema,
  sourceRef: SafeId,
  signalCode: SafeId,
  scope: IncidentScopeSchema,
  severity: IncidentSeveritySchema,
  state: IncidentSourceStateSchema,
  summary: z.string().trim().min(3).max(240),
  sampledAt: UtcTimestamp,
  thresholdRevision: z.string().trim().min(1).max(128),
  affectedResources: z.array(IncidentAffectedResourceSchema).max(32).default([]),
  evidenceRef: SafeId.optional(),
  counters: z.record(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).optional(),
}).strict().superRefine((signal, ctx) => {
  if (signal.state !== 'active' && !signal.evidenceRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceRef'], message: 'recovery signals require a source evidence reference' });
  }
});
export type IncidentSignal = z.infer<typeof IncidentSignalSchema>;

export const IncidentSchema = z.object({
  id: IncidentId,
  tenantId: SafeId.nullable(),
  scope: IncidentScopeSchema,
  source: IncidentSourceSchema,
  sourceRef: SafeId,
  signalCode: SafeId,
  severity: IncidentSeveritySchema,
  status: IncidentStatusSchema,
  sourceState: IncidentSourceStateSchema,
  summary: z.string().min(1).max(240),
  ownerId: SafeId.nullable(),
  firstSeenAt: UtcTimestamp,
  lastSeenAt: UtcTimestamp,
  lastSampledAt: UtcTimestamp,
  occurrenceCount: z.number().int().positive(),
  stateVersion: z.number().int().positive(),
  thresholdRevision: z.string().min(1).max(128),
  affectedResources: z.array(IncidentAffectedResourceSchema).max(32),
  counters: z.record(z.number().int().nonnegative()).nullable(),
  suppressed: z.boolean(),
  acknowledgedAt: UtcTimestamp.nullable(),
  resolvedAt: UtcTimestamp.nullable(),
  resolutionEvidenceRef: SafeId.nullable(),
}).strict();
export type Incident = z.infer<typeof IncidentSchema>;

export const IncidentEventKindSchema = z.enum(['detected', 'signal_repeated', 'source_recovered', 'reconciliation_confirmed', 'assigned', 'acknowledged', 'resolved']);
export type IncidentEventKind = z.infer<typeof IncidentEventKindSchema>;
export const IncidentEventSchema = z.object({
  id: IncidentId,
  kind: IncidentEventKindSchema,
  occurredAt: UtcTimestamp,
  actor: z.string().min(1).max(128),
  summary: z.string().min(1).max(240),
  evidenceRef: SafeId.nullable(),
  sourceState: IncidentSourceStateSchema.nullable(),
  details: z.record(z.unknown()).nullable(),
}).strict();
export type IncidentEvent = z.infer<typeof IncidentEventSchema>;

export const IncidentListQuerySchema = z.object({
  tenantId: SafeId.optional(),
  status: IncidentStatusSchema.optional(),
  severity: IncidentSeveritySchema.optional(),
  source: IncidentSourceSchema.optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export type IncidentListQuery = z.infer<typeof IncidentListQuerySchema>;
export const IncidentConnectorSourceSnapshotSchema = z.object({
  status: z.enum(['fresh', 'stale', 'unavailable', 'not-selected']),
  tenantId: SafeId.nullable(),
  sampledAt: UtcTimestamp.nullable(),
  invocationCounts: z.object({
    NEW: z.number().int().nonnegative(),
    IN_FLIGHT: z.number().int().nonnegative(),
    PENDING: z.number().int().nonnegative(),
    POLLING: z.number().int().nonnegative(),
    SUCCEEDED: z.number().int().nonnegative(),
    FAILED: z.number().int().nonnegative(),
    UNKNOWN: z.number().int().nonnegative(),
    CANCELLED: z.number().int().nonnegative(),
  }).strict().nullable(),
  failedDeliveryAttempts: z.number().int().nonnegative().nullable(),
  pendingOutbox: z.number().int().nonnegative().nullable(),
  oldestPendingLagMs: z.number().int().nonnegative().nullable(),
}).strict();
export type IncidentConnectorSourceSnapshot = z.infer<typeof IncidentConnectorSourceSnapshotSchema>;
export const IncidentListPageSchema = z.object({
  items: z.array(IncidentSchema).max(100),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).optional(),
  sampledAt: UtcTimestamp,
  tenantId: SafeId.nullable(),
  /** Latest tenant-bound Connector ledger reading; absent only for legacy callers. */
  connectorSignals: IncidentConnectorSourceSnapshotSchema.optional(),
}).strict().superRefine((page, ctx) => {
  if (page.hasMore !== (page.nextCursor !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nextCursor'], message: 'nextCursor must exist exactly when hasMore is true' });
  if (page.items.length > page.limit) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'items exceed the requested limit' });
});
export type IncidentListPage = z.infer<typeof IncidentListPageSchema>;
export const IncidentDetailSchema = z.object({ incident: IncidentSchema, history: z.array(IncidentEventSchema).max(500), sampledAt: UtcTimestamp }).strict();
export type IncidentDetail = z.infer<typeof IncidentDetailSchema>;

export const IncidentAssignRequestSchema = z.object({ ownerId: SafeId, expectedVersion: z.number().int().positive(), reason: z.string().trim().max(500).optional() }).strict();
export type IncidentAssignRequest = z.infer<typeof IncidentAssignRequestSchema>;
export const IncidentAcknowledgeRequestSchema = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().max(500).optional() }).strict();
export type IncidentAcknowledgeRequest = z.infer<typeof IncidentAcknowledgeRequestSchema>;
export const IncidentResolveRequestSchema = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(3).max(500), evidenceEventId: IncidentId }).strict();
export type IncidentResolveRequest = z.infer<typeof IncidentResolveRequestSchema>;

export const MaintenanceSuppressionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform') }).strict(),
  z.object({ kind: z.enum(['tenant', 'service', 'queue', 'connector', 'operation']), ref: SafeId }).strict(),
]);
export type MaintenanceSuppressionScope = z.infer<typeof MaintenanceSuppressionScopeSchema>;
export const MaintenanceSuppressionCreateSchema = z.object({
  scope: MaintenanceSuppressionScopeSchema,
  startsAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((input, ctx) => {
  const starts = Date.parse(input.startsAt); const expires = Date.parse(input.expiresAt);
  if (expires <= starts || expires - starts > 24 * 60 * 60 * 1000) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'suppression TTL must be positive and no longer than 24 hours' });
});
export type MaintenanceSuppressionCreate = z.infer<typeof MaintenanceSuppressionCreateSchema>;
export const MaintenanceSuppressionSchema = z.object({
  id: IncidentId,
  scope: MaintenanceSuppressionScopeSchema,
  startsAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  reason: z.string().min(3).max(500),
  createdAt: UtcTimestamp,
  createdBy: z.string().min(1).max(128),
  active: z.boolean(),
}).strict();
export type MaintenanceSuppression = z.infer<typeof MaintenanceSuppressionSchema>;
export const MaintenanceSuppressionListSchema = z.object({ items: z.array(MaintenanceSuppressionSchema).max(100), sampledAt: UtcTimestamp }).strict();
export type MaintenanceSuppressionList = z.infer<typeof MaintenanceSuppressionListSchema>;
