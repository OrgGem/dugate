import { z } from 'zod';

/** Version admission reason. It is separate from maintenance/control state. */
export const VersionAdmissionReasonSchema = z.enum([
  'ELIGIBLE',
  'BUSINESS_DISABLED',
  'NO_ACTIVE_VERSION',
  'VERSION_NOT_ACTIVE',
  'VERSION_NOT_ENABLED',
]);
export type VersionAdmissionReason = z.infer<typeof VersionAdmissionReasonSchema>;

export const VersionActivationRequestSchema = z.object({
  expectedActivationRevision: z.number().int().positive(),
}).strict();
export type VersionActivationRequest = z.infer<typeof VersionActivationRequestSchema>;

export const VersionActivationResultSchema = z.object({
  businessId: z.string().min(1),
  version: z.string().min(1),
  active: z.boolean(),
  activationRevision: z.number().int().positive(),
  previousVersion: z.string().nullable(),
  replayed: z.boolean(),
}).strict();
export type VersionActivationResult = z.infer<typeof VersionActivationResultSchema>;

export const VersionEnableResultSchema = z.object({
  businessId: z.string().min(1),
  version: z.string().min(1),
  status: z.literal('ENABLED'),
  activationRevision: z.number().int().positive(),
  replayed: z.boolean(),
}).strict();
export type VersionEnableResult = z.infer<typeof VersionEnableResultSchema>;

export const VersionPreDrainResultSchema = z.object({
  businessId: z.string().min(1),
  version: z.string().min(1),
  submissionsPaused: z.literal(true),
  activationRevision: z.number().int().positive(),
  remainingOperations: z.number().int().min(0),
  replayed: z.boolean(),
}).strict();
export type VersionPreDrainResult = z.infer<typeof VersionPreDrainResultSchema>;

export const VersionPreDrainCancellationResultSchema = z.object({
  businessId: z.string().min(1),
  version: z.string().min(1),
  submissionsPaused: z.literal(false),
  activationRevision: z.number().int().positive(),
  replayed: z.boolean(),
}).strict();
export type VersionPreDrainCancellationResult = z.infer<typeof VersionPreDrainCancellationResultSchema>;
