# CONV-05 — Admin fetcher sanitize helper — cc_2 verification receipt

- **Date:** 2026-10-02 · **Lane:** cc_2 (command-code) · **Spec:** `coordination/dispatch-specs/2026-10-02-2355-CONV05-admin-fetch.md`
- **Mode:** verification-only. **Zero source bytes changed by this lane. No gate tick. No commit.** No message to `nocobase-10`.
- **Lease honored:** only `src/app/admin/*-section-data.ts`, `src/app/admin/upstream-error-body.ts` (read), `tests/admin-upstream-error-body-offline.test.ts` (read) were inspected; `server.ts`, renderers, contracts, audit module read-only.

**TL;DR (VI):** CONV-05 đã có sẵn trong HEAD — qwen_4 triển khai lúc 13:07 và được commit trong `b088eec` (14:27). Lane cc_2 **không tái implement**; đã xác minh độc lập: 6/6 thân hàm cũ tương đương hành vi với helper mới (execution proof), matrix 401/403/404/timeout/invalid-JSON không đổi, focused tests 451/452 pass (1 fail pre-existing, A/B chứng minh), `tsc --noEmit` exit 0. Không tick gate, không commit.

## 1. Finding first: packet already delivered in HEAD

| Item | Evidence |
|---|---|
| Implemented by | qwen_4 plan-wave lane, spec `2026-10-02-1245-CONV05-admin-fetcher-helper.md`, receipt `coordination/reports/qwen-conv05-admin-fetcher-2026-10-02.md` |
| Committed | `b088eec` — `chore(du-rework): sync … admin shell split, connector and review fixes` (2026-10-02 14:27:29 +0700) = current HEAD |
| git log | `git log --oneline -3 -- …/upstream-error-body.ts` → `b088eec`; same for the test file; both **tracked** (`git ls-files` lists them) |
| This dispatch | `2026-10-02-2355` wave-3 re-dispatch (watch-state `ctx_task_conv05` — “lane moi (user added)”); arrived ~9h after the work landed |
| cc_2 action | No re-implementation (a rewrite would produce a zero diff). Independent verification against the packet’s acceptance criteria below. |

Post-verification state of the 8 CONV-05 paths vs HEAD:

```
git diff --stat HEAD -- <6 fetchers + helper + test>   → (empty)
git status --short -- …/src/app/admin                   → (empty)
```

## 2. Deliverable state found in HEAD

- `src/app/admin/upstream-error-body.ts` (+39): `export const UPSTREAM_ERROR_BODY_MAX_CHARS = 256` + `sanitizeUpstreamErrorBody(text)` = `if (!text) return ''; return text.slice(0, 256).replace(/[\u0000-\u001f\u007f]/g, ' ');`
- Six call sites, all in the `!res.ok` branch (overview: inside `asJson` non-ok branch):

| Fetcher | import | call site | removed local |
|---|---|---:|---|
| `api-key-section-data.ts` | :35 | :320 | `readErrorBody` |
| `business-section-data.ts` | :23 | :283 | `readErrorBody` (comment + `trimmed` var) |
| `connector-section-data.ts` | :30 | :373 | `readErrorBody` |
| `operation-section-data.ts` | :45 | :1166 | `sanitiseErrorBody` |
| `overview-section-data.ts` | :43 | :816 | `sanitiseErrorBody` |
| `profile-section-data.ts` | :31 | :497 | `readErrorBody` |

Exact extraction diff (`git diff --numstat b088eec~1 b088eec`):

```
2  6   api-key-section-data.ts
2  9   business-section-data.ts       (+2 −9: extra comment/var lines removed)
2  6   connector-section-data.ts
2  6   operation-section-data.ts
2  6   overview-section-data.ts
2  6   profile-section-data.ts
39 0   upstream-error-body.ts          (new)
55 0   admin-upstream-error-body-offline.test.ts (new)
```

Representative hunk (every one of the six is this shape and nothing else):

```diff
@@ -234,11 +235,6 @@ function grantToWireRow(...)
-function readErrorBody(text: string): string {
-  if (!text) return '';
-  return text.slice(0, 256).replace(/[\u0000-\u001f\u007f]/g, ' ');
-}
 ...
-      const body = readErrorBody(await res.text().catch(() => ''));
+      const body = sanitizeUpstreamErrorBody(await res.text().catch(() => ''));
```

## 3. Independent equivalence proof (six old bodies vs HEAD helper)

The packet requires the extraction to be a de-duplication, not a behaviour change. Verified by **executing** the six removed bodies (extracted from `b088eec~1` by regex) against the HEAD helper on 9 inputs each (empty, short, 1000-char cap, CRLF + ESC + NUL control injection, 200×`a`+200×NUL, all-control, secret-shaped token, 255+`\u0007` boundary, trailing DEL):

- **Command:** `node <scratchpad>\conv05-equivalence.js` · **cwd:** `D:\Git\dugate` · **exit:** 0
- **Result:** `RESULT: all six old bodies behave IDENTICALLY to the HEAD helper on all inputs` — 0 mismatches.
- Normalized hashes: 5/6 byte-identical (`b2a5c2ef366f`); `business` differs only by its intermediate variable (`9027b9d8f722`) — 0 behavioural mismatches.

## 4. Before / after matrix — 401/403/404/timeout/invalid-JSON (required table)

**Before** = `b088eec~1` (six copies present), **After** = HEAD (shared helper). The diff for these six files contains **only** the sanitizer hunks — no status branch, JSON-parse branch, catch block or result shape was touched. So every row below is identical before/after; the single changed call line is marked in “other !ok”.

| Fetcher (`file`) | 401/403 | 404 | other `!ok` | timeout (abort) | invalid JSON |
|---|---|---|---|---|---|
| api-key | `{kind:'unauthorized', message:'Platform rejected the admin token (HTTP n).'}` — **no** `keyId` | `{kind:'not-found', keyId, message:"API key '<id>' is not on the server."}` | `{kind:'error', message:'Platform returned HTTP n[: <san>]'}` ← **only changed line (call rename)** | `{kind:'error', 'Timed out after Nms waiting for the platform.'}` | `{kind:'error', 'Platform returned non-JSON for the api-keys endpoint.'}` |
| business | `{kind:'unauthorized', businessId, message}` | `{kind:'not-found', businessId, message: businessId ? "Business '<id>' is not registered…" : 'Platform does not expose a business list endpoint …'}` (ternary) | `{kind:'error', businessId, message:'…HTTP n[: <san>]'}` | same timeout text | `{kind:'error', businessId, '…non-JSON for the business-versions endpoint.'}` |
| connector | `{kind:'unauthorized', connectorId, message}` | `{kind:'not-found', connectorId, message:"Connector '<id>' revision '<latest\|n>' is not on the server."}` | `{kind:'error', connectorId, message}` | same | `{kind:'error', connectorId, '…non-JSON for the connector-revisions endpoint.'}` |
| operation | `{kind:'unauthorized', message}` — **no** `operationId` | `{kind:'not-found', operationId, message: operationId ? "Operation '<id>' is not on the server." : 'Platform returned 404 for the operations list.'}` | `{kind:'error', message}` — **no** id | same | `{kind:'error', '…non-JSON for the operation detail endpoint.'}` |
| profile | `{kind:'unauthorized', businessId, message}` | `{kind:'not-found', businessId, message:"No manifest is available for '<id>' on the platform (HTTP 404)."}` | `{kind:'error', businessId, message}` | same | `{kind:'error', businessId, '…non-JSON for the profile endpoint.'}` |
| overview | per-request `{__status:401\|403}` → aggregated `{kind:'unauthorized', message:'Platform rejected the admin token (HTTP 401/403).', tenantId, from, to, triage}` | **no 404 branch** — non-ok → `{__err: sanitize(body) \|\| 'HTTP n'}` (usage/audit/health ⇒ top-level `kind:'error'`; 3 count legs ⇒ triage) | `{__err: sanitize(body) \|\| 'HTTP n'}` → `kind:'error'` with redacted text | per-request `{__err:'aborted'}` → `{kind:'error','Timed out after Nms…'}` | `{__err:'Non-JSON payload.'}` → same aggregation |

Verdict: **no behaviour change in any of the 30 cells** — diff-proven (only sanitizer hunks) + execution-proven (§3).

Also verified: **no remaining copy** of the body-sanitizer anywhere under `src/app/admin/` (grep for the 256-slice/control-strip body matches only `upstream-error-body.ts`); `audit-section-data.ts` has its own *filter* sanitizers but never had the error-body copy (0 matches), so it was correctly left alone.

## 5. CONV-D02 parser decision — re-verified, exception stands

`parseFetchPayload` / `buildOkFromCatalog` were **not** unified in HEAD. I re-checked the “not uniform” claim directly against the code and it holds:

1. **Result unions differ** (id presence is not uniform): api-key (`:187`) / operation (`:299`) omit `keyId`/`operationId` on `unauthorized` and `error`; business (`:112`) / connector (`:169`) / profile (`:162`) carry their id on every non-ok kind; overview (`:219`) has **no `not-found` kind at all** and optional `tenantId/from/to/triage` on every kind.
2. **Parser signatures differ**: `parseFetchPayload(raw, keyId)` / `(raw, fallbackBusinessId)` / `(raw, connectorId, revision)` / `(raw, operationId, serverNow)` + a separate `parseListPayload(raw, listLimit, listCursor, serverNow, input)` / `(raw, promptCatalog)`; overview has no `parseFetchPayload` — it parses per endpoint and aggregates `__err` / `__status` marker objects.
3. **`buildOkFromCatalog` signatures differ**: `(catalog, keyId)` / `(entry)` / `(catalog, operationId)`+`buildListFromCatalog` / `(entry, promptCatalog?, originalWidgetBySlot?)` / `(catalog, tenantId, fromIso, toIso, serverNow)`.

A generic builder would have to encode these differences as parameters rather than remove them. **Decision: keep the exception; parser unification needs its own packet + equivalence matrix** — consistent with the plan and qwen’s §3.

## 6. Focused tests + typecheck (literal command / cwd / exit)

All runs: **cwd `D:\Git\dugate\du-rework\services\orchestrator`** (Windows cmd). `NODE_ENV=test` is set explicitly: this shell has ambient `NODE_ENV=production`, which makes the logger emit `environment:"prod"` and fails one boundary assertion for an unrelated reason (re-run with `NODE_ENV=test` is the fair baseline).

| # | Command | Result |
|---|---|---|
| 1 | `npx jest --runInBand tests/admin-upstream-error-body-offline.test.ts tests/admin-error-boundary-offline.test.ts` | **exit 0** — 2 suites, **42/42 pass**. Includes all 8 `*-section-data.ts` structural pins (no raw-error echo) |
| 2 | `npx jest --runInBand tests/admin-api-key-render.test.ts tests/admin-business-render.test.ts tests/admin-connector-render.test.ts tests/admin-operation-render.test.ts tests/admin-overview-render.test.ts tests/admin-profile-render.test.ts tests/admin-overview-triage.test.ts` | **exit 0** — 7 suites, **275/275 pass** |
| 3 | `npx jest --runInBand tests/admin-operations-query.test.ts tests/admin-operations-sort.test.ts tests/admin-operations-view.test.ts tests/admin-operations-sql.test.ts tests/admin-operation-cockpit.test.ts tests/admin-config-cockpit.test.ts tests/adm-base-03-safe-error-offline.functional.test.ts` | **exit 1** — 6 suites pass; `adm-base-03` 1 failed / 18 passed (**pre-existing**, A/B below). Totals: 134 passed / 1 failed |
| 4 | `npx tsc --noEmit -p tsconfig.json` | **EXIT=0** |

**Focused-set totals:** 15 suites (14 pass), **451/452 tests pass**; the 1 failure is A/B-proven pre-existing.

### Pre-existing failures — A/B by byte-exact swap (proven, not asserted)

Method: save the 8 CONV-05 paths → overwrite the six fetchers with `git show b088eec~1:<path>` bytes → run → restore → `git diff --stat HEAD -- <8 paths>` empty, `git status` clean.

| Suite(s) | At HEAD | At parent bytes (`b088eec~1`) | Verdict |
|---|---|---|---|
| `adm-base-03-safe-error-offline.functional.test.ts` | 1 failed / 18 passed | **1 failed / 18 passed — same test** (`logText` empty; the suite patches `console.error`, while `shell-server.ts:196` logs via `logger.error` → structured stdout, visible in run output) | pre-existing, NOT CONV-05 |
| `admin-shell-platform-mount.test.ts` + `admin-shell-render.test.ts` | 4 failed / 56 passed / 60 | **4 failed / 56 passed / 60 — same tests** (role gates expecting `operator`/200-pane vs `admin`/403 — shell RBAC area, other lane) | pre-existing, NOT CONV-05 |

## 7. Security / safety boundary (honest)

- The helper **bounds** (256) and **de-controls** (C0+DEL → space); it does **not redact**. That matches all six originals byte-for-byte in behaviour (§3), and the new suite pins the no-redaction limit explicitly (`does NOT redact…`).
- No new echo surface: structural-pin suite scans every `*-section-data.ts` + `server.ts`/`errors.ts`/`ingress.ts`/`shell-server.ts`/`oidc-*` for executable `String(err)` / `err.message` / interpolation of error objects → **all pass**.
- Redaction of upstream text would be a behaviour *change* (and per-fetcher policy) — out of this packet’s scope, must not land silently; the pin test guards it.

## 8. Unresolved gaps / not done

- **No code change by cc_2** — deliverable pre-existed in HEAD (`b088eec`); re-writing would have produced a zero diff.
- **Parser unification not done** — deliberate CONV-D02 exception, §5; needs its own packet.
- **No live/E2E/browser run** — this is an offline/unit-seam verification (pure helper + fetch mocks); no platform, DB or browser was exercised.
- **Pre-existing red remains in the area** (5 tests: `adm-base-03` ×1, `admin-shell-platform-mount` ×2, `admin-shell-render` ×2), A/B-proven not attributable to CONV-05; listed as baseline for the next lane.
- Gate **not ticked**; **no commit** created; `nocobase-10` not contacted.

## 9. Verdict

**VERIFIED at the offline/unit seam (mocked fetch):** CONV-05 acceptance criteria are met in HEAD — the six exact-body duplicates are single-sourced into `sanitizeUpstreamErrorBody` (256-char bound preserved, behaviour execution-proven identical), discriminated results and safe-text composition unchanged, 401/403/404/timeout/invalid-JSON matrix unchanged, focused suites green apart from A/B-proven pre-existing failures, orchestrator `tsc --noEmit` exit 0. Live/browser path not exercised (not applicable to this pure seam).
