import { z } from 'zod';

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
