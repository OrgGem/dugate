import { z } from 'zod';
import { isTenantUuid } from './tenant-identity';
import { ConnectorRevisionStateSchema } from './vault';

const UuidSchema = z.string().uuid();
const SafeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/);

/** Tenant-owned ACTIVE Connector metadata for selecting an immutable AI pin. */
export const TenantActiveConnectorCatalogQuerySchema = z.object({
  tenantId: UuidSchema,
  q: z.string().trim().min(1).max(128).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict();
export type TenantActiveConnectorCatalogQuery = z.infer<typeof TenantActiveConnectorCatalogQuerySchema>;

export const TenantActiveConnectorCatalogItemSchema = z.object({
  tenantId: UuidSchema,
  connectorId: SafeIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  adapter: SafeIdSchema,
  provider: SafeIdSchema,
  model: z.string().min(1).max(256).nullable(),
  credentialConfigured: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type TenantActiveConnectorCatalogItem = z.infer<typeof TenantActiveConnectorCatalogItemSchema>;

export const TenantActiveConnectorCatalogPageSchema = z.object({
  tenantId: UuidSchema,
  items: z.array(TenantActiveConnectorCatalogItemSchema).max(100),
  limit: z.number().int().min(1).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict().superRefine((page, context) => {
  if (page.items.some((item) => item.tenantId !== page.tenantId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'catalog items must belong to the requested tenant' });
  }
});
export type TenantActiveConnectorCatalogPage = z.infer<typeof TenantActiveConnectorCatalogPageSchema>;

/** Safe metadata for finding a persisted typed recipe in Admin. This is a
 * separate catalog from the ACTIVE-only pin picker above. */
export const TenantConnectorRecipeCatalogQuerySchema = z.object({
  tenantId: z.string().refine(isTenantUuid, 'tenantId must use canonical UUID syntax').transform((value) => value.toLowerCase()),
  q: z.string().trim().min(1).max(128).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type TenantConnectorRecipeCatalogQuery = z.infer<typeof TenantConnectorRecipeCatalogQuerySchema>;

export const TenantConnectorRecipeCatalogItemSchema = z.object({
  tenantId: z.string().refine(isTenantUuid, 'tenantId must use canonical UUID syntax').transform((value) => value.toLowerCase()),
  connectorId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: ConnectorRevisionStateSchema,
  adapter: z.enum(['json-http', 'multipart-http', 'gemini', 'openai-compatible']),
  authKind: z.enum(['none', 'api-key-header', 'bearer', 'basic', 'oauth2-client-credentials']),
  credentialConfigured: z.boolean(),
}).strict();
export type TenantConnectorRecipeCatalogItem = z.infer<typeof TenantConnectorRecipeCatalogItemSchema>;

export const TenantConnectorRecipeCatalogPageSchema = z.object({
  tenantId: z.string().refine(isTenantUuid, 'tenantId must use canonical UUID syntax').transform((value) => value.toLowerCase()),
  items: z.array(TenantConnectorRecipeCatalogItemSchema).max(100),
  limit: z.number().int().min(1).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict().superRefine((page, context) => {
  if (page.items.length > page.limit) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'catalog items must not exceed the requested limit' });
  }
  if (page.items.some((item) => item.tenantId !== page.tenantId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'catalog items must belong to the requested tenant' });
  }
});
export type TenantConnectorRecipeCatalogPage = z.infer<typeof TenantConnectorRecipeCatalogPageSchema>;
