# CONV-01-PREP — `server.ts` split plan (READ-ONLY)

**Task:** CONV-01-PREP · **Date:** 2026-10-03 · **Status:** analysis only. **No file was modified**; no gate ticked; no commit; `nocogac-10` not contacted.

## 0. Baseline — measure, do not trust the plan

`services/orchestrator/src/server.ts` is **4448 lines** at the time of writing and is **` M` (actively modified)** — the dispatch's warning is accurate, there is a live writer.

For comparison, the guard's `PLAN_BASELINE_COUNTS` records `4299` and the plan snapshot said 4300. **The file has grown ~150 lines since the plan was written, so every line reference in CONV-01/02/03 is stale by roughly that much.** Re-measure before slicing, exactly as happened with the CONV plan's frozen counts.

## 1. Block inventory

| # | block | lines | count | cross-deps | proposed target |
|---|---|---|---|---|---|
| 1 | imports, module consts, `readStreamBounded`, `s3StoredObjectReader`, `isNotFoundStorageError` | 1-238 | 238 | S3 client types, `StoredObjectReader` | `src/modules/artifacts/` |
| 2 | `ServerConfig` (the ~40-field interface), `shouldSeedDevFallback` | 239-472 | 234 | every module type | `src/config/` |
| 3 | **`createApp`** + `export type App` | 473-1088 | 616 | everything; the composition root | `src/composition/` (or keep) |
| 4 | composition helpers: `resolveArtifactByStorageKey`, `buildCryptoConfigOptions`, `registerAdminCryptoConfigWiring`, `buildDeliveryEncryptionConfig` | 1089-1258 | 170 | encryption + delivery modules | `src/modules/encryption/wiring.ts` |
| 5 | `RouteContext` | 1259-1300 | 42 | every service type | **`src/http/route-context.ts` (stage 1)** |
| 6 | **`route(ctx)` — every route family in one function** | 1301-2004 | 704 | all of the above | per-family modules (last stage) |
| 7 | delivery-encryption error mapping, `encryptedDeliveryBody`, and an **unresolved tail** | 2020-2915 | 896 | delivery encryption, artifact read/decrypt | `src/modules/public-api/` — **re-measure first, see §5** |
| 8 | auth guards (`assertRuntimeAuth` … `assertAdminAuth`) + `errorNameOf` / `sanitizedInternalError` | 2916-3035 | 120 | rbac, session store | `src/http/auth.ts` |
| 9 | **operations list**: query parse, allowlist, sort allowlist, sentinel SQL, cursor encode/decode, bind order, `listOperationsPage` | 3036-3604 | 569 | `RouteContext`, db | `src/modules/operations/list-query.ts` |
| 10 | **admin read**: audit list, api-key list, businesses/versions, `keysetPage`, `sortableAdminKeysetPage` | 3605-4237 | 633 | `RouteContext`, db, contracts page helper | `src/modules/admin-read/` (3 files) |
| 11 | operation projection/mapper: `toOperationDetailWire`, `buildAdminOperationDetail` | 4238-4312 | 75 | usage service, artifacts | `src/modules/operations/mappers.ts` |
| 12 | API-key resolution: `resolveApiKey`, `hashKey` | 4313-4338 | 26 | db | `src/http/auth.ts` (with block 8) |
| 13 | grant-URL policy: `allowHostDerivedGrantUrl`, `absoluteGrantUrl`, `requestGrantUrl` | 4339-4403 | 65 | config | `src/modules/artifacts/grant-url.ts` |
| 14 | lifecycle hooks: `createMultipartSweepHook`, `multipartLimitsFromEnv` | 4404-4448 | 45 | multipart service | `src/modules/artifacts/multipart-limits.ts` |

Blocks 9+10+11 = **1277 lines of query/paging/mapping** with no route-dispatch logic — the highest-value, lowest-risk cut. Block 6 (`route()`) is the largest single function at 704 lines.

### 1a. Two findings worth carrying into the plan

**(a) `MAX_DECRYPT_BYTES` and `MAX_MANIFEST_BYTES` are declared twice** — `:158-159` and `:2052-2053`, both `64 MiB` / `8 MiB`. This is exactly the duplication CONV-D01 targets, and it is a drift risk rather than a current mismatch. Dedupe during stage 1, where both blocks are already being touched.

**(b) Block 7 could not be fully attributed.** Symbol grep finds `deliveryEncryptionHttpError` (`:2020`) and `encryptedDeliveryBody` (`:2061`) at column 0, with call sites at `:2155` and `:2233`, but **no further top-level declaration between 2061 and 2916** — while `:2897-2910` is indented audit-scope code that does not belong to either of those. So the 896-line region is **at least one declaration I could not separate**, possibly more. Do not slice this block from my table alone; re-measure it first (§5).

## 2. Freeze list — what must stay byte-compatible

### 2a. Route inventory (method + path + auth tier)

Every `if (method === … && pathname === …)` / regex match inside `route()` plus its auth tier: public `x-api-key`, admin bearer, tenant-admin token, worker business token, runtime bearer. **A route that silently stops matching is the worst failure mode of this refactor** — it would 404 rather than fail loudly. The 47-file test net is the only thing that catches it.

### 2b. SQL: predicate order, bind order, cursor

- `buildOperationsListPredicates` clause order and the resulting **positional bind order** (`tenant -> state -> id`), because `listOperationsPage` passes `filters.params` straight into the query.
- `bindOperationsCursor` (`:3467`) appends `createdAt, id` then `limit+1` — the boundary must be resolved **before** `final()` and share the exact ORDER BY expression (`bindOperationsListSortKey`), including the nullable-field sentinel literal.
- The six-value sort allowlist and the 422 on a cursor/sort mismatch.
- `sortableAdminKeysetPage` / `keysetPage` bind order for audit, api-key, businesses, versions.

### 2c. Wire: status, headers, body

`Operation-Location`, `no-store`, `content-length` on binary, `x-correlation-id`, the encrypted-delivery envelope shape, the artifact download stream, and the 204/empty-body responses.

### 2d. Error translation

`HttpError -> application/problem+json` via `toProblem`, `isHttpError` duck-typing (the SEC-INT-01 note: `instanceof` splits across module graphs — this matters directly if the guards move), the fixed-text rule that raw upstream messages never cross the boundary (ADM-BASE-03), and the legacy compat shapes now mounted at the top of `route()`.

### 2e. Exports that must keep resolving from `server.ts`

20+ names consumed by `shell-server.ts`, `main.ts`, `index.ts` and the test net — including `ServerConfig`, `createApp`, `App`, `RouteContext`, `multipartLimitsFromEnv`, `absoluteGrantUrl`, `parseOperationsListQuery`, `registerCryptoConfigWiring`. Every one stays a re-export from `server.ts` even after extraction, or `server.ts`/`shell-server.ts` change (which is outside this wave's intent).

## 3. Safety net — 47 test files reference `src/server`

Full list is long; the load-bearing ones per block:

| block | must-stay-green tests |
|---|---|
| 6 route() | `admin-base-routes`, `admin-sort-allowlist`, `rfx11-12-route-hardening`, `br12-isolation-offline`, `artifact-grant-fencing`, `blob-wire-binary`, `multipart-routes-offline`, `webhook-error-boundaries.boundary`, `ingress-bounded`, `operation-tenant-fence`, `delivery-encryption`, `enc08-wire-enc07` |
| 9 operations list | `operations-list-contract-conformance`, `operations-list-cursor-sort-binding`, `admin-operations-{query,sql,sort,sort-wiring,sort-http-offline,view,list-pagination}` |
| 10 admin read | `admin-audit`, `admin-audit-list-page`, `admin-audit-scope`, `admin-list-contract-conformance`, `admin-base-routes` |
| 8/12 auth | `admin-action-rbac-live`, `admin-error-boundary`, `operation-tenant-fence` |
| 3/4 composition | `crx01-creatapp-metadata-seam`, `crx01-metadata-wiring`, `rfx10-seed-gate`, `connector-credentials-offline.functional` |
| 7 delivery | `delivery-encryption`, `enc08-wire-enc07`, `webhook-delivery-encryption`, `artifact-read-download-route` |
| whole file | **`rv01-loopback-http-offline`** — real socket through the real listener |

Note `crx01-*` and `crx02-*` in the list are the **active writer's** tests. They are part of the net, which means the net itself moves while CONV-01 runs.

## 4. Staged order, file-surface estimate, risk

No time estimates. One owner at a time; each stage leaves the file green.

| stage | move | files touched | net files | lines out | main risk |
|---|---|---|---|---|---|
| **1** | `RouteContext` + blocks 8 & 12 (auth) | 3 | +1 | ~190 | `RouteContext` must move **first** or everything else cycles; `isHttpError` duck-typing must survive |
| **2** | block 9 (operations list) | 2 | +1 | ~569 | bind/cursor order; needs `RouteContext` from stage 1 |
| **3** | block 10 (admin read) | 4 | +3 | ~633 | two keyset pagers with different bind shapes |
| **4** | block 11 (operation mappers) | 2 | +1 | ~75 | low; do it with stage 3 |
| **5** | block 4 (composition wiring) | 2 | +1 | ~170 | `registerCryptoConfigWiring` is called by boot; re-export must stay |
| **6** | blocks 13 & 14 (grant URL, multipart limits) | 3 | +2 | ~110 | `absoluteGrantUrl` is exported and RFX-11 touches its policy |
| **7** | block 7 (delivery body) | 2 | +1 | ~250-896 | **re-measure first** (§1a); RFX lane owns this file |
| **8** | block 6 `route()` by family | 2 + n | +3..4 | ~704 | highest risk; only after 1-7 make it a thin dispatcher |
| **9** | blocks 1-3 (storage helpers, `ServerConfig`, `createApp`) | 2 | +2 | ~1088 | `createApp` is the composition root — moving it is a different concern, arguably CONV-02 |

**Cycle rule that makes this work:** extracted modules import from `src/http/` and their own module — **never from `server.ts`**. `server.ts` re-exports outward. That is the same leaf-module pattern CONV-12 needed for `shell-router-shared.ts`, and it is why `RouteContext` is stage 1 rather than stage 8.

**Shared-writer risk (immediate):** `server.ts` is ` M` right now. Stage 1 cannot start until the current writer lands and the file is clean. The guard's `PLAN_BASELINE_COUNTS` for `server.ts` is also stale and will need re-baselining once this wave completes.

## 5. Not mine to decide (CONV-01/02/03 executor)

1. **Whether `route()` splits by route family or by auth tier.** Family grouping keeps URL knowledge together; auth-tier grouping keeps the security argument auditable in one place. I have laid out blocks, not chosen.
2. **Whether `ServerConfig` / `createApp` move at all.** Blocks 2+3 are 850 lines and are the composition root, not routing. Moving them is a different concern from splitting routes and may belong to CONV-02.
3. **Stage 9 in particular** — I would not touch blocks 1-3 in this wave without an explicit decision.
4. **Whether block 7 is one function or several** (§1a). Needs a direct read, not grep.
5. **Crypto dedup (CONV-D01 Option A shared package vs Option B)** — untouched here. Note the two duplicate const pairs in this file are a separate, smaller duplication that should not be bundled into that decision.
6. **Whether any part is better exempted than split.** Nothing measured here argues for exemption: blocks 9-11 are genuinely separable, self-contained logic.

## 6. Method limits

- **Read-only and no tests run**, per the lease. All counts come from `Get-Content .Count` and two symbol greps against the working tree.
- **Line numbers will drift again** — the file grew ~150 lines since the plan snapshot and has a live writer. Every figure here is timestamped to this pass.
- I did not read `route()` line by line; its internal route-family boundaries come from grep of matchers plus earlier reading of specific regions in this session. **Before slicing, the executor should derive the route inventory from the source rather than from §2a** — that list is a freeze *contract*, not an enumeration I verified exhaustively.
- `47` is the count of test files whose text references `src/server`; it includes a fixture (`operations-page-fixture.ts`), so **46 test files + 1 fixture**.

**No gate is ticked by this receipt.**