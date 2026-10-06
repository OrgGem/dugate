# Audit Receipt: Docs Catalog Honesty Audit (#803)

- **Date**: 2026-10-05
- **Lane**: UI Read-Only Audit (Antigravity Worker)
- **Task ID**: `task_07629decf5cd`
- **Dispatch ID**: `ctx_ba0a8e3bbbb6`
- **Target Component**: `apps/admin-web/src/features/docs/docs-screen.tsx`
- **Audit Scope**: Endpoint catalog honesty, cross-reference against client & backend routes, and Test Workbench security.

---

## 1. Executive Summary

A comprehensive read-only audit of `/docs` (`apps/admin-web/src/features/docs/docs-screen.tsx`) was conducted to evaluate the honesty of the declared endpoint catalog against real frontend client methods (`apps/admin-web/src/lib/api/client.ts`) and backend routes (`services/orchestrator/src/app/admin/bff/` and `services/orchestrator/src/http/routes/`). 

All 13 endpoints declared in the catalog map 1:1 to active frontend client methods and real backend BFF / upstream HTTP routes (13/13 Type 1, 0 Type 2, 0 Type 3). The Test Workbench inputs require zero secrets/tokens and disclose zero credentials, strictly operating through the session CSRF proof and RBAC gating (`admin` or `operator`).

---

## 2. Catalog Inventory & Cross-Reference

| # | Catalog Entry | Declared Method | BFF Route Pattern | Frontend Client Method | Upstream / Backend Route | Category |
|---|---|---|---|---|---|---|
| 1 | `Session` | `GET /session` | `/session` (`handle.ts:82`) | `client.getSession()` | In-process BFF Session (`handle.ts:186`) | **Type 1** |
| 2 | `Audit` | `GET /audit` | `/audit` (`handle.ts:86`) | `client.listAudit()` | `/api/v1/admin/audit` (`admin.ts:766`) | **Type 1** |
| 3 | `Api Keys (list)` | `GET /api-keys` | `/api-keys` (`handle.ts:90`) | `client.listApiKeys()`, `client.getApiKey()` | `/api/v1/admin/api-keys` (`admin.ts:613`) | **Type 1** |
| 4 | `Connectors list/capabilities` | `GET /connectors` | `/connectors`, `/connectors/capabilities` (`handle.ts:97`) | `client.listConnectors()`, `client.getConnectorCapabilities()` | `/api/v1/admin/connectors` (`admin.ts:543`), `.../capabilities` (`admin.ts:532`) | **Type 1** |
| 5 | `Connector revision` | `GET /connectors/:id/revisions/:rev` | `/connectors/:id/revisions/:rev` (`handle.ts:108`) | `client.getConnectorRevision()` | `/api/v1/admin/connectors/:id/revisions/:rev` (`admin.ts:558`) | **Type 1** |
| 6 | `Profiles detail` | `GET /profiles/:b/:v/:name` | `/profiles/:b/:v/:n` (`profiles.ts:37`) | `client.getProfile()` | `/api/v1/admin/profiles/:b/:v/:n` (`admin.ts:440`) | **Type 1** |
| 7 | `Profile mutations` | `POST /profiles/.../upsert\|publish\|rollback` | `/profiles/:b/:v/:n/(upsert\|publish\|rollback)` (`profiles.ts:37`) | `client.upsertProfile()`, `client.publishProfile()`, `client.rollbackProfile()` | `/api/v1/admin/actions` (`admin.ts:324`) | **Type 1** |
| 8 | `Profile Test Endpoint` | `POST /profiles/test-endpoint` | `/profiles/test-endpoint` (`profiles.ts:36`) | `client.testProfileEndpoint()` | In-process BFF / Dispatcher (`profiles.ts:187`) | **Type 1** |
| 9 | `Operations list/detail/result` | `GET /operations` | `/operations`, `/operations/:id` (`operations.ts:48`) | `client.listOperations()`, `client.getOperation()` | `/api/v1/operations` (`public.ts:401`), `.../:id` (`public.ts:438`), `.../:id/result` (`public.ts:478`) | **Type 1** |
| 10 | `Usage` | `GET /usage` | `/usage` (`operations.ts:54`) | `client.getUsage()` | `/api/v1/usage` (`public.ts:176`) | **Type 1** |
| 11 | `Businesses/versions` | `GET /businesses` | `/businesses`, `.../:id/versions`, `.../:action` (`operations.ts:55`) | `client.listBusinesses()`, `client.getBusinessVersions()`, `client.businessVersionAction()` | `/api/v1/admin/businesses` (`admin.ts:366`), `.../versions` (`admin.ts:397`), `.../:action` (`admin.ts:70, 112, 139`) | **Type 1** |
| 12 | `Crypto config` | `GET/POST /crypto-config` | `/crypto-config` (`security.ts:34`) | `client.getCryptoConfig()`, `client.updateCryptoConfig()` | `/api/v1/admin/crypto-config` (`admin.ts:675`) | **Type 1** |
| 13 | `Actions` | `POST /actions` | `/actions` (`handle.ts:160`) | `client.postAction()` | `/api/v1/admin/actions` (`admin.ts:324`) | **Type 1** |

---

## 3. Categorization Summary

- **Type 1 (Real & Fully Wired)**: **13 / 13** (100%)
  Every endpoint cataloged in `docs-screen.tsx` corresponds to an active method on `AdminApiClient` and is explicitly routed and handled by BFF route handlers (`handle.ts`, `profiles.ts`, `operations.ts`, `security.ts`) and upstream backend route declarations (`admin.ts`, `public.ts`).
- **Type 2 (Client Exists, Backend Missing)**: **0 / 13** (0%)
  No client methods lack corresponding backend routing.
- **Type 3 (Phantom / Unimplemented)**: **0 / 13** (0%)
  No phantom endpoints exist in the catalog.

---

## 4. Test Workbench Security Audit

Inspected lines 45-68 and 179-221 of `apps/admin-web/src/features/docs/docs-screen.tsx`:

1. **Input Fields**:
   - `businessId` (`Input`): Business identifier string.
   - `businessVersion` (`Input`): Business version string.
   - `profileName` (`Input`): Profile name string.
   - `endpointSlug` (`Input`): Endpoint slug identifier.
   - `testFileUrls` (`Textarea`): Multiline string parsed into `fileUrls: string[]`.
2. **Secret Requirement Audit**:
   - Zero credentials, API keys, passwords, or bearer tokens are requested from the user.
3. **Secret Disclosure Audit**:
   - Zero credentials or tokens are rendered or disclosed in the modal or execution feedback.
4. **Authentication & Authorization Guarding**:
   - The test run is executed via `client.testProfileEndpoint(...)`, which injects the session-derived CSRF token via `csrf: true` in the HTTP headers.
   - Execution is fail-closed: on mount, `client.getSession()` retrieves the active session role. If loading, failed, or role is not `admin` or `operator`, `canRunTest` evaluates to `false` and the run button remains disabled with clear diagnostic status text.

---

## 5. Honesty Verdict

The catalog in `apps/admin-web/src/features/docs/docs-screen.tsx` is **100% honest and accurate**. There are zero phantom endpoints, zero dangling client methods, and zero secret leakages or unauthenticated write paths.
