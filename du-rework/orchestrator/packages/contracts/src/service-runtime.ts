import { z } from 'zod';
import { MaintenanceScopeSchema } from './maintenance';

const SafeRuntimeId = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const ImageDigest = z.string().min(1).max(512).regex(/^.+@sha256:[a-f0-9]{64}$/i);
const Revision = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Count = z.number().int().nonnegative();
const IsoDate = z.string().datetime({ offset: true });
const ExternalEffectState = z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']);
const OrchestratorExternalEffectsSchema = z.object({
  admission: ExternalEffectState,
  dispatch: ExternalEffectState,
  providerInvocation: ExternalEffectState,
  connectorPoll: ExternalEffectState,
  usageDelivery: ExternalEffectState,
  webhookDelivery: ExternalEffectState,
  alertEmission: ExternalEffectState,
  cleanup: ExternalEffectState,
  historicalMaintenance: ExternalEffectState,
  migrations: ExternalEffectState,
}).strict();
export type OrchestratorExternalEffects = z.infer<typeof OrchestratorExternalEffectsSchema>;

export const OrchestratorServiceRuntimeIdentitySchema = z.object({
  serviceRuntimeId: SafeRuntimeId,
  runtimeIdentity: SafeRuntimeId,
  replicaId: SafeRuntimeId,
  slot: z.enum(['blue', 'green']),
  revision: Revision,
  imageDigest: ImageDigest,
}).strict();
export type OrchestratorServiceRuntimeIdentity = z.infer<typeof OrchestratorServiceRuntimeIdentitySchema>;

export const OrchestratorServiceRuntimeReadRequestSchema = OrchestratorServiceRuntimeIdentitySchema.extend({
  scope: MaintenanceScopeSchema,
}).strict();
export type OrchestratorServiceRuntimeReadRequest = z.infer<typeof OrchestratorServiceRuntimeReadRequestSchema>;

export const OrchestratorServiceRuntimeControlCommandSchema = OrchestratorServiceRuntimeIdentitySchema.extend({
  expectedControlRevision: Count,
  action: z.enum(['drain', 'resume']),
  reason: z.enum(['maintenance-rollout', 'maintenance-rollback']),
}).strict().superRefine((value, context) => {
  if (value.action === 'drain' && value.reason !== 'maintenance-rollout') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'drain requires maintenance-rollout reason' });
  }
  if (value.action === 'resume' && value.reason !== 'maintenance-rollback') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'resume requires maintenance-rollback reason' });
  }
});
export type OrchestratorServiceRuntimeControlCommand = z.infer<typeof OrchestratorServiceRuntimeControlCommandSchema>;

export const OrchestratorServiceRuntimeControlAckSchema = z.object({
  controlRevision: Count,
  requestedAt: IsoDate,
}).strict();
export type OrchestratorServiceRuntimeControlAck = z.infer<typeof OrchestratorServiceRuntimeControlAckSchema>;

export const OrchestratorServiceRuntimeObservationSchema = OrchestratorServiceRuntimeIdentitySchema.extend({
  service: z.literal('orchestrator'),
  /** Boot UUID of the process that produced this independently observed row. */
  bootId: z.string().uuid(),
  /** These target-process facts are present for the isolated restore probe. */
  clusterName: z.string().min(1).max(256).optional(),
  liveness: z.enum(['LIVE', 'NOT_LIVE', 'UNKNOWN']).optional(),
  livenessObservedAt: IsoDate.optional(),
  readiness: z.enum(['READY', 'DEGRADED', 'DRAINING', 'OFFLINE', 'UNKNOWN']),
  observedAt: IsoDate,
  workObservedAt: IsoDate,
  controlRevision: Count,
  controlState: z.enum(['OPEN', 'PAUSED', 'DRAINING']),
  controlAcknowledgedAt: IsoDate.nullable(),
  controlAcknowledgedBootId: z.string().uuid().nullable().optional(),
  /** Present only when the live Orchestrator composition can prove its effect gates. */
  externalEffects: OrchestratorExternalEffectsSchema.optional(),
  dependencies: z.array(z.object({
    dependencyId: z.enum(['postgres', 'redis']),
    state: z.enum(['HEALTHY', 'UNAVAILABLE', 'UNKNOWN']),
    observedAt: IsoDate,
  }).strict()).length(2),
  work: z.object({
    workerLeases: z.object({ applicable: z.literal(false), count: z.null() }).strict(),
    sdkActiveTasks: z.object({ applicable: z.literal(false), count: z.null() }).strict(),
    connectorInvocations: z.object({ applicable: z.literal(false), count: z.null() }).strict(),
    orchestratorRequests: z.object({ applicable: z.literal(true), count: Count.nullable() }).strict(),
    dispatches: z.object({ applicable: z.literal(true), count: Count.nullable() }).strict(),
    maintenanceExecutions: z.object({ applicable: z.literal(true), count: Count.nullable() }).strict(),
  }).strict(),
}).strict();
export type OrchestratorServiceRuntimeObservation = z.infer<typeof OrchestratorServiceRuntimeObservationSchema>;

/** Stricter target-only DTO consumed by the isolated restore rehearsal probe.
 * The separate schema makes a missing process observation fail closed without
 * requiring ordinary replica-safety callers to understand restore controls. */
export const OrchestratorIsolatedRestoreObservationSchema = OrchestratorServiceRuntimeObservationSchema.extend({
  clusterName: z.string().min(1).max(256),
  liveness: z.enum(['LIVE', 'NOT_LIVE', 'UNKNOWN']),
  livenessObservedAt: IsoDate,
  controlAcknowledgedBootId: z.string().uuid().nullable(),
  externalEffects: OrchestratorExternalEffectsSchema,
}).strict();
export type OrchestratorIsolatedRestoreObservation = z.infer<typeof OrchestratorIsolatedRestoreObservationSchema>;
