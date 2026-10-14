# Admin reference inputs

Reference inputs retain manual entry and add suggestions only from an existing, scope-checked Admin API or the exact catalog page already loaded by the screen. Lists are bounded: use **Load more suggestions** when a cursor is available. A suggestion is never presented as the complete inventory when the API only returned a page.

| Screen and field | Suggestion source and scope | Manual entry |
| --- | --- | --- |
| Connectors, Secret Catalog reference ID | Active, tenant-owned `managed_value` secrets for `connector.credential` / `connector`, from the selected tenant's Secret Catalog pages. Only safe metadata (name, ID, revision) is shown; secret values are never fetched. | Kept for an opaque UUID when the catalog page has no match. Import authorization remains server-enforced. |
| Connector Inspector, Connector ID and revision | Exact selected-tenant legacy Connector rows, plus typed Recipe Catalog rows on the currently loaded tenant page. Capabilities-only names are labeled as configured IDs with unverified persisted-revision availability. Revision suggestions are limited to the exact selected ID. | Kept for direct legacy lookups and IDs outside the loaded page. Typed Recipe rows have a separate exact **Open Recipe … rev …** action; **Load legacy revision** uses the legacy inspector reader. |
| Profiles, prompt `apiKeyId` | Active API keys returned for the selected tenant, including cursor pages. | Kept for an ID not present in the loaded active-key pages. |
| Profiles, prompt `connectionId` | Legacy connection pins returned by Settings for the exact tenant, API key, and endpoint scope. | Kept for an exact legacy UUID not currently pinned in that scope. |
| Maintenance, business ID and version | Business registry pages and versions for the exact selected business ID. | Kept for IDs/versions entered directly when the registry has no match. |
| Operations, operation ID filter | IDs in the currently loaded Operations page for the selected tenant. The suggestions are explicitly partial; the query still accepts manual IDs and search text. | Always available for IDs outside the current page or for partial-text searches. |

## Fields intentionally left free-form

- Connector stable IDs on create and Profile names/slugs identify new resources. Connector revision, expected-head, and active compare-and-set values are version controls, not foreign-key selectors.
- Vault connection IDs are configured connection labels; mount, path, and field are Vault coordinates. No matching connection-list API exists in the Admin client, so these stay manual.
- OAuth client IDs, provider/model identifiers, header names, secret slots, and workflow action names are configuration values rather than references to rows in an Admin-managed table.
- Operations business, API-key, Profile, action, correlation, provider, and model filters are query filters. Only the operation-ID filter uses loaded-row suggestions. Usage operation IDs remain manual query inputs.
- Workflow advanced artifact references are JSON; the upload picker remains the normal artifact flow and there is no global artifact-list API for suggestions.
- Queue delivery IDs are scoped to an operation's delivery history, while the maintenance backup target, generation ID, and backup ID have no corresponding list API. Incident scope IDs vary by scope kind, so none use a generic ID catalog.

Existing exact selectors in tenant context, Profiles identity, Settings, Workflows, and cost-policy scope/recipient forms remain unchanged.
