import type { TenantConnectorRecipeCatalogPage } from '@/lib/api';

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECIPE_STATES = ['PENDING', 'ACTIVE', 'RETIRED'] as const;
const RECIPE_ADAPTERS = ['json-http', 'multipart-http', 'gemini', 'openai-compatible'] as const;
const AUTH_KINDS = ['none', 'api-key-header', 'bearer', 'basic', 'oauth2-client-credentials'] as const;
const PAGE_KEYS = new Set(['tenantId', 'items', 'limit', 'nextCursor']);
const ITEM_KEYS = new Set(['tenantId', 'connectorId', 'revision', 'state', 'adapter', 'authKind', 'credentialConfigured']);
const MAX_RECIPE_HEAD_PAGES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Only the latest request for the currently selected UUID may update screen state. */
export function isCurrentTenantRequest(
  activeTenantId: unknown,
  requestedTenantId: unknown,
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestGeneration === currentGeneration
    && typeof activeTenantId === 'string'
    && typeof requestedTenantId === 'string'
    && TENANT_UUID.test(activeTenantId)
    && TENANT_UUID.test(requestedTenantId)
    && activeTenantId.toLowerCase() === requestedTenantId.toLowerCase();
}

/** Mutating editor requests are scoped to both the tenant and the exact
 * selected Connector. Delayed responses must not restore another editor's
 * state after a tenant switch, a newer request, or an ID edit. */
export function isCurrentTenantConnectorRequest(
  activeTenantId: unknown,
  requestedTenantId: unknown,
  requestGeneration: number,
  currentGeneration: number,
  selectedConnectorId: unknown,
  requestedConnectorId: unknown,
): boolean {
  return isCurrentTenantRequest(activeTenantId, requestedTenantId, requestGeneration, currentGeneration)
    && typeof selectedConnectorId === 'string'
    && typeof requestedConnectorId === 'string'
    && selectedConnectorId.trim() === requestedConnectorId;
}

/** A revision read can only be write-ready when the completed catalog walk
 * confirms that the selected row is at or behind the finalized chain head. */
export function isTypedRecipeRevisionCoveredByHead(headRevision: number, requestedRevision: number): boolean {
  return Number.isSafeInteger(headRevision)
    && headRevision >= 1
    && Number.isSafeInteger(requestedRevision)
    && requestedRevision >= 1
    && headRevision >= requestedRevision;
}

/** Empty bounded pages can still have rows beyond the repository scan cap. */
export function shouldShowTypedCatalogPageControls(
  page: TenantConnectorRecipeCatalogPage,
  pageIndex = 0,
): boolean {
  return page.items.length > 0 || page.nextCursor !== null || pageIndex > 0;
}

/** Strict browser reader for the typed inventory DTO. Unknown fields fail the
 * read so a credential-bearing server response is never silently accepted. */
export function parseTypedConnectorRecipeCatalogPage(
  value: unknown,
  expectedTenantId: string,
): TenantConnectorRecipeCatalogPage | null {
  if (!isRecord(value) || !hasOnlyKeys(value, PAGE_KEYS)) return null;
  if (!TENANT_UUID.test(expectedTenantId)) return null;
  const canonicalExpectedTenantId = expectedTenantId.toLowerCase();
  if (value['tenantId'] !== canonicalExpectedTenantId) return null;
  const limit = value['limit'];
  const items = value['items'];
  const nextCursor = value['nextCursor'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  if (!Array.isArray(items) || items.length > limit || items.length > 100) return null;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length < 1 || nextCursor.length > 2048)) return null;

  for (const item of items) {
    if (!isRecord(item) || !hasOnlyKeys(item, ITEM_KEYS)) return null;
    if (item['tenantId'] !== canonicalExpectedTenantId) return null;
    const connectorId = item['connectorId'];
    const revision = item['revision'];
    const state = item['state'];
    const adapter = item['adapter'];
    const authKind = item['authKind'];
    if (typeof connectorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(connectorId)) return null;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null;
    if (typeof state !== 'string' || !(RECIPE_STATES as readonly string[]).includes(state)) return null;
    if (typeof adapter !== 'string' || !(RECIPE_ADAPTERS as readonly string[]).includes(adapter)) return null;
    if (typeof authKind !== 'string' || !(AUTH_KINDS as readonly string[]).includes(authKind)) return null;
    if (typeof item['credentialConfigured'] !== 'boolean') return null;
  }

  return value as unknown as TenantConnectorRecipeCatalogPage;
}

/** Resolve the current typed-chain head from a complete, bounded catalog walk.
 * A revision read's expectedHeadRevision is that historical row's base, not
 * the chain's current head, so it must never be used for a later CAS write. */
export async function resolveTypedRecipeChainHead(
  tenantId: string,
  connectorId: string,
  fetchPage: (cursor: string | null) => Promise<TenantConnectorRecipeCatalogPage>,
): Promise<number> {
  if (!TENANT_UUID.test(tenantId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(connectorId)) {
    throw new Error('A valid tenant and Connector ID are required to verify the recipe chain head.');
  }
  const expectedTenantId = tenantId.toLowerCase();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let headRevision = 0;

  for (let pageNumber = 0; pageNumber < MAX_RECIPE_HEAD_PAGES; pageNumber += 1) {
    const page = await fetchPage(cursor);
    if (!page || page.tenantId !== expectedTenantId || !Array.isArray(page.items)
      || page.items.length > page.limit || page.limit < 1 || page.limit > 100) {
      throw new Error('The typed recipe catalog response could not verify the selected tenant and Connector chain.');
    }
    for (const item of page.items) {
      if (!item || item.tenantId !== expectedTenantId) {
        throw new Error('The typed recipe catalog crossed the selected tenant boundary.');
      }
      if (item.connectorId === connectorId) {
        if (!Number.isSafeInteger(item.revision) || item.revision < 1) {
          throw new Error('The typed recipe catalog returned an invalid revision for the selected Connector.');
        }
        headRevision = Math.max(headRevision, item.revision);
      }
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === null) return headRevision;
    if (typeof nextCursor !== 'string' || nextCursor.length === 0
      || nextCursor === cursor || seenCursors.has(nextCursor)) {
      throw new Error('The typed recipe catalog returned a repeated or invalid cursor; refresh before saving.');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error('The typed recipe catalog exceeds the safe head-check page limit; refresh before saving.');
}
