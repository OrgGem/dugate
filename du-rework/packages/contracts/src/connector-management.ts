import { z } from 'zod';
import { ConnectorRevisionStateSchema } from './vault';

/**
 * CONNECTOR-WIRE (Δ-PC-1 packet CONNECTOR-WIRE-A): the platform-side connector
 * management DTOs.
 *
 * These shapes describe what the ORCHESTRATOR exposes to admin callers (admin
 * routes + action dispatcher) — never what the Connector service stores. Two
 * invariants carried over from the prep:
 *
 *  - REDACTION IS THE WIRE CONTRACT: the connector returns header VALUES as
 *    `[REDACTED]`; these schemas describe the redacted view, and no platform
 *    response may widen it. Credential material (raw values, Vault payloads)
 *    is write-only and never appears in any of these shapes.
 *  - `credentialRef` / `credentialSource` are opaque COORDINATES (labels,
 *    mount/path/account metadata) — they identify a secret, they are not one.
 */

/**
 * One connector revision as the platform reports it: the connector's redacted
 * view narrowed to the fields the platform is willing to republish. `.strict()`
 * on purpose — a connector field we did not model is dropped here, not leaked.
 */
export const ConnectorManagementRevisionSchema = z
  .object({
    connectorId: z.string().min(1),
    revision: z.number().int().min(1),
    adapter: z.string().min(1),
    state: ConnectorRevisionStateSchema,
    /** Adapter config passthrough; header values arrive `[REDACTED]`. */
    config: z.record(z.string(), z.unknown()),
    /** Opaque label for the credential's storage slot — never the value. */
    credentialRef: z.string().optional(),
    /** Coordinates only (kind/mount/path/account/version…), never a secret. */
    credentialSource: z.record(z.string(), z.unknown()).optional(),
    tenantId: z.string().optional(),
    accountId: z.string().optional(),
  })
  .strict();
export type ConnectorManagementRevision = z.infer<typeof ConnectorManagementRevisionSchema>;

export const ConnectorListResponseSchema = z
  .object({ items: z.array(ConnectorManagementRevisionSchema) })
  .strict();
export type ConnectorListResponse = z.infer<typeof ConnectorListResponseSchema>;

/** Composition-derived advertisement — booleans only, no configuration. */
export const ConnectorCapabilitiesSchema = z
  .object({
    management: z.boolean(),
    credentialWorkflow: z.boolean(),
    test: z.boolean(),
  })
  .strict();
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilitiesSchema>;

/**
 * `connector.upsert` params, discriminated so the two connector-service write
 * shapes cannot be confused: `create` mints a NEW connector row, `revision`
 * clones the current chain head into a PENDING revision bound to a credential
 * source. Secrets never ride here — the rotate action owns the write-only
 * value path.
 */
export const ConnectorCreateParamsSchema = z
  .object({
    mode: z.literal('create'),
    connectorId: z.string().min(1),
    adapter: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    /** Opaque label for the credential slot (value written via rotate). */
    credentialRef: z.string().min(1),
    state: z.enum(['ACTIVE', 'PENDING']).optional(),
  })
  .strict();
export type ConnectorCreateParams = z.infer<typeof ConnectorCreateParamsSchema>;

export const ConnectorRevisionParamsSchema = z
  .object({
    mode: z.literal('revision'),
    connectorId: z.string().min(1),
    credentialSource: z.record(z.string(), z.unknown()),
    tenantId: z.string().min(1),
    accountId: z.string().min(1),
  })
  .strict();
export type ConnectorRevisionParams = z.infer<typeof ConnectorRevisionParamsSchema>;

export const ConnectorUpsertParamsSchema = z.discriminatedUnion('mode', [
  ConnectorCreateParamsSchema,
  ConnectorRevisionParamsSchema,
]);
export type ConnectorUpsertParams = z.infer<typeof ConnectorUpsertParamsSchema>;

/**
 * `connector.bootstrap` params (D2 adjudication): first-BOUND-chain creation
 * for a connector whose stored revision is still the legacy unbound row. Same
 * fields as the clone mode; the connector refuses the route unless a legacy
 * revision actually exists to transition (it can never mint a chain).
 */
export const ConnectorBootstrapParamsSchema = z
  .object({
    connectorId: z.string().min(1),
    credentialSource: z.record(z.string(), z.unknown()),
    tenantId: z.string().min(1),
    accountId: z.string().min(1),
  })
  .strict();
export type ConnectorBootstrapParams = z.infer<typeof ConnectorBootstrapParamsSchema>;

export const ConnectorActivateParamsSchema = z
  .object({
    connectorId: z.string().min(1),
    revision: z.number().int().min(1),
    /** CAS guard: activation succeeds only while the ACTIVE head still matches. */
    expectedCurrentRevision: z.number().int().min(1),
  })
  .strict();
export type ConnectorActivateParams = z.infer<typeof ConnectorActivateParamsSchema>;

export const ConnectorRevisionTargetParamsSchema = z
  .object({
    connectorId: z.string().min(1),
    revision: z.number().int().min(1),
  })
  .strict();
export type ConnectorRevisionTargetParams = z.infer<typeof ConnectorRevisionTargetParamsSchema>;

export const ConnectorTargetParamsSchema = z.object({ connectorId: z.string().min(1) }).strict();
export type ConnectorTargetParams = z.infer<typeof ConnectorTargetParamsSchema>;

/**
 * The connector's own masked test result. NOT `.strict()`: the store already
 * REBUILDS the response from exactly these two keys, so an upstream that added
 * a field cannot widen this shape — it is silently narrowed, not rejected.
 */
export const ConnectorTestResultSchema = z.object({
  ok: z.boolean(),
  errorCode: z.string().optional(),
});
export type ConnectorTestResult = z.infer<typeof ConnectorTestResultSchema>;
