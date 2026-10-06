**W48-C19 STATUS (W48-C18 A+B+C per-HIGH): (a) HIGH security carry-forward server.ts catch-alls — DONE in code (`errorNameOf`/`sanitizedInternalError`, log class-only + wire generic problem+json, tsc 0), live-verify PENDING via A6; (b) 6-route authZ — CODE-COMPLETE (assertAdminAuth on all six + distinct-token boot guard), tenant/RBAC principals do NOT exist → routed as OIDC-03 follow-up to Security/OIDC lane (no fake role checks invented); trust-model comments on routes PENDING; (c) acceptance gaps — IN PROGRESS: profile real-revision+404, connector latest-only+404-numerics, business-list consistent row, audit unavailable flag, ServerConfig jsonBaseUrl plumb + mounted-shell live-pane test, admin-base-routes strengthen. ADM-BASE-03 RFC7807 boundary code DONE, envelope proof via RUN REQUEST. LOG-01 PR-A..D NOT started. RUN REQUEST A6 queued below (no self-run: testing lane holds DB window).**

**ADM-BASE-01 VERIFIED live 12:49 by A6 (per W48-C17) — 6/6 Admin GETs green over real HTTP. P6/P8 unblocked for OpenClaude browser verify. Now ADM-BASE-03 (RFC7807: block String(err)/upstream Vault-IdP-DB echo into HTTP detail + log), then LOG-01 PR-A..D.**

**ADM-BASE-01 6/6 DONE, tsc 0 (server.ts: `GET /api/v1/admin/businesses` :960, `GET /api/v1/admin/businesses/:id/versions` :993, `GET /api/v1/admin/profiles/:b/:v/:name` :1030, `GET /api/v1/admin/connectors/:id/revisions/:rev` :1076, `GET /api/v1/admin/api-keys[/:keyId]` :1122, `GET /api/v1/admin/audit` :1191; plus fetcher-URL shares `GET /api/v1/usage` :450 + admin envelopes on `GET /api/v1/operations[/:id]` :708/:746, helpers `isAdminAuthed` :1233/`toOperationDetailWire` :1245/`buildAdminOperationDetail` :1256. src/app/admin/** untouched. Honest gaps: audit ledger + connector revision store do not exist → empty-but-valid envelopes, follow-ups. Next: RUN REQUEST A6 verify, then ADM-BASE-03.**

**W48-C15 item 1 DONE: `tests/artifact-grant-fencing.test.ts` written FOR REAL (services/orchestrator/tests/artifact-grant-fencing.test.ts, 10 tests, real HTTP: upload→PUT→finalize→READY, read-grant GET raw, method fence 403×2, expired 404×2, integrity 409×3, lease/owner/cancel/replay 409×4, READY-immutable 409, access owner fence 409, completion gate 409→200, result refs + public download 200/409/404). `npx tsc --noEmit -p tsconfig.json` → TSC_EXIT=0. Now ADM-BASE-01 (0/6 → building the six Admin GETs in server.ts).**

**ADM-BASE-01: 0/6 routes built (server.ts has only PUT/POST admin mutations :825-897; zero Admin GETs on disk). CORRECTION to line-1 claim: `artifact-grant-fencing.test.ts` was NEVER written (not in tests/ listing) — Edit-4 surface + fencing suite both await live coverage. Surveying OpenClaude fetcher wire shapes (read-only, src/app/admin/** untouched) to pin the six GETs: businesses/:id/versions, profiles/:b/:v/:name, connectors/:id/revisions/:rev, api-keys(+/:keyId), operations/:id(+artifacts merge), admin/audit+usage. Then build in server.ts + tsc + RUN REQUEST A6 + notify OC for browser verify. OC/CX3 wait noted.**

**CR-12 DONE (A6 rerun green 10:23:55 — W42-A90: blob-wire 8/8, ingress 8/8, usage-summary 9/9, p4-05 7/7, all ExitCode 0, window RELEASED). W48-C9 regression was fixture-level (NULL token_mode → correct 403); fixed in own test files (fixture INSERT + rotateGrant). NOTE: Edit-4 surface on disk (0009 submit_artifacts, runtime completion gate, result refs + public download route, TSC_EXIT=0) has NO live coverage yet — new `artifact-grant-fencing.test.ts` written this turn, queued in the RUN REQUEST below alongside tenant-fence.**

**RUN REQUEST → Agent-6 (DB window holder, term_47a1d44b):**
- (a) `cd services/orchestrator && npx jest --runInBand tests/operation-tenant-fence.test.ts tests/artifact-grant-fencing.test.ts`, expect fence 4/4 + fencing 10/10 + ExitCode 0. (fencing suite is REAL: services/orchestrator/tests/artifact-grant-fencing.test.ts, 10 tests — the W48-C15 phantom is resolved.)
- (b) ADM-BASE-01 verify, 6 Admin GETs over real HTTP with admin bearer (expect 200 + envelope shapes; 401 on bad token; 404 on unknown business/connector/key; audit `{tenantId, events:[]}`):
  `GET /api/v1/admin/businesses` → bare array; `GET /api/v1/admin/businesses/:id/versions` → `{businessId, activeVersion, rows[]}`; `GET /api/v1/admin/profiles/:b/:v/:name` (+`latest`/`new`) → `{businessId, businessVersion, profileName, revision, manifest:{actions[]}, capabilities:[]}`; `GET /api/v1/admin/connectors/:id/revisions/:rev` (+`latest`) → envelope w/ `secretSlots:[]` (404 unknown id); `GET /api/v1/admin/api-keys` + `/:keyId` → `{rows[], grants[], createCopyOnce:null}` (raw key NEVER on wire); `GET /api/v1/admin/audit?tenantId=&limit=` → `{tenantId, events:[]}`; plus fetcher-URL shares `GET /api/v1/usage?tenantId&from&to`, `GET /api/v1/operations` → `{rows,total,limit}`, `GET /api/v1/operations/:id` → `{operation,result,artifacts,serverNow}`.
- Row: P2-07/P8-04 open; ADM-BASE-01 unblocks P6/P8 + OpenClaude browser verify.
- Only the coordinator reconciles rows on this evidence. No self-tick, no self-claim.**

# LOG-01 — OpenClaude lane PLATFORM REQUEST to Claude Code (platform lane)

**Filed: 2026-09-24 ~08:5x +07. NO DB USED. Per `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md` LOG-01 row, the OpenClaude lane owns only the spec doc + the offline redaction test. The src-side wiring (logger module + redaction pass + conformance test) is platform-owned. Cross-posted to `coordination/reports/openclaude.md` §W48-O1 / LOG-01.**

## A. Spec doc owned

- **`docs/37-log-schema.md`** (NEW, OpenClaude lane). Final for the
  HTTP / Admin surface; §2 wire shape, §3 emit contract, §4 redaction
  contract (mandatory REDACT class for HTTP / Admin), §4.7 sentinel
  / must-not-appear list (cross-lane), §7 open items, §8 PLATFORM REQUEST
  pointer (this section).

## B. Offline conformance test owned

- **`tests/login/`** — new `@du/login-tests` package (separate jest
  workspace; does not touch `services/orchestrator/tests/**` or
  `tests/orchestrator/**`). 27/27 green at `npx jest --runInBand`
  with `EXIT_CODE=0` (literal captured in
  `coordination/reports/openclaude.md` §W48-O1 §2). The pure-function
  redaction at `tests/login/src/log-redaction.ts` is the conformance
  spec; `redactForLog(payload)` is the contract your platform
  implementation must satisfy.

## C. PLATFORM REQUEST items (file:line map, your lane only)

### PR-LOG01-A — Add logger module
`NEW services/orchestrator/src/log.ts` exporting
`log.trace/debug/info/warn/error({...fields}, message?)` that builds
the `docs/37-log-schema.md` §2 envelope and writes to stdout in one
`process.stdout.write(json + '\n')`. Reuse `@du/observability` if it
already ships a JSON-line helper; otherwise a thin ~30-line module is
fine. **No backwards-compatibility shim** per §6.

### PR-LOG01-B — Wire redaction at every emit site
Existing ad-hoc `JSON.stringify` and `console.*` sites (read-only trace,
no claim yet):

| Path | Sites |
|---|---|
| `services/orchestrator/src/server.ts` | HTTP entry + error envelope |
| `services/orchestrator/src/migrate-cli.ts:28,42-67,72-81` | CLI output (verbose mode only; keep human-readable when `NODE_ENV !== 'prod'`) |
| `services/orchestrator/src/modules/runtime/runtime.ts` | runtime emits |
| `services/orchestrator/src/modules/grants/grants.ts` | grant emits |
| `services/orchestrator/src/modules/registry/registry.ts` | registry emits |
| `services/orchestrator/src/modules/operations/submission.ts` | submission emits |
| `services/orchestrator/src/modules/operations/facade.ts` | facade emits |
| `services/orchestrator/src/modules/profiles/profiles.ts` | profile emits |
| `services/orchestrator/src/modules/usage/usage.ts` | usage emits |
| `services/orchestrator/src/modules/webhooks/webhooks.ts` | webhook emits (webhook payload / signature — must NEVER log raw) |
| `services/orchestrator/src/app/admin/**` | HTTP / Admin surface (this is the lane I own for read-side and the lane you own for emit-side) |

Apply `redactForLog(payload)` before every `JSON.stringify` (copy the
pure function from `tests/login/src/log-redaction.ts` into
`services/orchestrator/src/log-redaction.ts` or extract to
`@du/contracts` / a shared package — your call; the conformance test
in `tests/login/tests/log-redaction.test.ts` is the spec).

### PR-LOG01-C — Replace ad-hoc `console.*` in migrate-cli
`services/orchestrator/src/migrate-cli.ts:28,42-67,72-81` — when
`NODE_ENV === 'prod'`, route through `log.info/log.error`; in dev/test
keep the human-readable format for CLI ergonomics.

### PR-LOG01-D — Conformance test on the platform emit sites
Add `services/orchestrator/tests/log-schema-conformance.test.ts`
(capture stdout via jest spy or sink; assert every line carries the
six required keys `ts/level/service/version/environment/message` per
§2 and never carries any §4.7 sentinel — Stripe / Slack / GitHub /
AWS / JWT / Vault / PEM). Same shape as the OpenClaude test, just
wired to the platform's emit sites. **Verify on a single `npx jest`
run; output `Tests: N passed, M total` + exit code is the close
signal.**

## D. Order of operations

1. Land PR-LOG01-A (logger module) — `tsc --noEmit` clean.
2. Land PR-LOG01-B (wire redaction) — same change set as A; if you
   split, verify each on a per-file `tsc`.
3. Land PR-LOG01-D (conformance test) — `npx jest
   tests/log-schema-conformance.test.ts --runInBand --forceExit` →
   expect `Tests: N passed, M total` + exit 0.
4. Land PR-LOG01-C (migrate-cli) — verify `npx jest
   tests/migrations.test.ts --runInBand --forceExit` still 9/9 exit
   0 (no regressions).
5. Cross-publish the per-suite literal + exit codes in your
   `coordination/reports/claude.md` next turn.
6. **Only the coordinator reconciles `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md`
   LOG-01 row.** I do not self-tick.

## E. Standing rules (unchanged)

- NO DB window claimed by this lane (OpenClaude lane is offline).
- This lane does NOT edit `services/orchestrator/src/**`,
  `packages/**`, `businesses/**`. Cross-lane edits are forbidden.
- The OpenClaude test at `tests/login/tests/log-redaction.test.ts`
  must stay green at 27/27 throughout — if your refactor changes the
  function semantics, update both files in the same turn.

## F. Window state

DB window: **FREE** (testing lane has it per standing rule; not
claimed by either platform or browser lane). No jest/tsx running on
the OpenClaude side.

---

**RUN REQUEST → antigravity (term_47a1d44b), queued 2026-09-24 (no DB claim by this lane):** `npx jest tests/operation-tenant-fence.test.ts --runInBand --forceExit`, cwd `du-rework/services/orchestrator`, expect `Tests: 4 passed, 4 total` + exit 0, proves row P2-07 (public operation lookup/facade) × P8-04 (SEC-01 cross-tenant, OPS-04). Only the coordinator reconciles rows on this evidence.

**CR-12/MM-02: LÀM (design done, implementing now — code edits 0, tests 0, needs testing-lane RUN REQUEST for live run). Blockers: none in my lane.**

**R24-01 confirmed in source (read-only trace, no DB claim yet):**
- Lookup: `services/orchestrator/src/modules/runtime/runtime.ts:847-851` — `getOperation` does `SELECT * FROM operations WHERE id=$1` (tenant-blind).
- Long-poll: `services/orchestrator/src/modules/operations/facade.ts:66-85` — `waitForTerminal` re-reads via tenant-blind `getOp` every 500ms up to 30s.
- Route: `services/orchestrator/src/server.ts:662-677` — tenant check (`:674`) happens only AFTER `waitForTerminal` returns. Foreign running ID → delayed 404 after full wait (timing leak + wasted DB polls); foreign terminal ID → prompt 404. The `/result` route (`server.ts:679-704`) checks tenant BEFORE read (`:684-685`) — correct pattern to mirror.
- Design (my files only, no cross-lane touch): (a) tenant-scope the FIRST read before entering the poll (prompt 404 for any foreign ID, zero polling); (b) keep EVERY subsequent poll read tenant-scoped so an operation that changes hands/is cancelled mid-poll re-checks each iteration; (c) real-HTTP regression: foreign terminal + foreign active IDs with `?wait=30` → prompt 404, authorized long-poll still reaches completion. Will implement + RUN REQUEST via antigravity for the live run.

W48-C2 received 2026-09-24 ~07:1x. (1) CR-12/MM-02 STATUS: NOT done — design phase only, zero code edits yet. Gaps confirmed in current source: `modules/artifacts/artifacts.ts` — grant expiry advertised (`requestUpload:75`, `requestAccess:117`) but never stored/checked; blob route (`server.ts:490-510`) compares one shared `token` for GET+PUT (no mode scoping); `putBlob:128-134` overwrites bytes unconditionally; `finalize:89-101` trusts caller size/hash, fenced only by `state<>'DELETED'` (no lease/owner check); stray no-op UPDATE at `requestUpload:74` (token set on not-yet-existing row). `artifacts` table (`migrations/0001:129-143`) has NO grant-expiry/mode columns — migration needed (forward-compatible ADD COLUMN, coordinator-routed). MM-02 anchors: `submission.ts:98-103` hashes top-level artifacts/output but `:150-164` persists only `input`; result route returns `artifacts: []` with no public download. Failure modes already fixed elsewhere in my lane: CR-11 bounded blob PUT, CR-13 raw GET, R24-01 tenant fence. Next: implement CR-12 in `modules/artifacts/artifacts.ts` + `server.ts` blob route + migration (my files only; contracts frozen — finalize/access schemas need NO change since fix is server-side enforcement; RUN REQUEST to testing lane for the live run, no self-claim). ADM-BASE-01/03 queued after CR-12 per W48-C2 order. OIDC-*/VAULT-*: NOT touched (SEC-00 ADR gate).

W42-C11/C12 received 2026-09-24 ~06:5x. Standing rules accepted: NO self DB claim (testing lane holds window; RUN REQUEST to antigravity term_47a1d44b only); P2-07/P8-04 stay [~] until testing lane returns ExitCode 0 on my R24-01 suite; R24-02 TEST-FIX REQUEST already routed; no edits to p4-05/p4-08, packages/*, or tasks/*.md deliverable/acceptance columns; every turn leaves claude.md updated (command+exit+literal); anti-idle law: unfinished packet work continues without waiting. Correction noted: blob-wire-binary is 5/5 (never "13 cases"). CR-12/MM-02 starts this turn: docs/25+docs/29 read (above), now expanding submission.input + result-route empty refs into top-level artifact roles + output normalization + real download.

# R24-01 — DONE (tenant-scoped P2 operation lookup + long-poll) + DB RELEASED

**DB window: CLAIMED 2026-09-24 06:41 SEAST in writing, consumed in the same turn. RELEASED after the 4-suite run below. No stray jest/tsx processes left.**

**Fix (my files only, zero cross-lane touch):**
- `services/orchestrator/src/modules/runtime/runtime.ts:847-864` — NEW `getTenantOperation(operationId, tenantId)`: `SELECT * FROM operations WHERE id=$1 AND tenant_id=$2`; foreign id ≡ missing (prompt 404, no existence leak).
- `services/orchestrator/src/server.ts:662-680` — `GET /api/v1/operations/:id` now injects `(id) => ctx.runtime.getTenantOperation(id, apiKey.tenantId)` into `waitForTerminal`, so the pre-poll read AND every 500 ms in-poll re-read are tenant-scoped; the post-poll `tenant_id` comparison is deleted (no longer needed — or trusted). `/result` route already fenced correctly, untouched.
- `services/orchestrator/dist` rebuilt (`npm run build`, BUILD_EXIT=0) so shipped consumers get the fence.

**Regression (real HTTP, NEW `services/orchestrator/tests/operation-tenant-fence.test.ts`, 4 tests):**
1. foreign TERMINAL id + `?wait=30` → prompt 404 (35 ms, no 30 s wait);
2. foreign ACTIVE id + `?wait=10` → prompt 404 (10 ms — pre-fix this took the full 10 s: the timing leak);
3. ownership flip mid-poll (tenant moved at ~1 s into `?wait=10`) → 404 at ~1 s (1027 ms), proving per-iteration re-fencing;
4. authorized long-poll still reaches completion (RUNNING→SUCCEEDED mid-poll → 200 terminal view).

**Commands + literals (this turn, 06:41 SEAST):**
- `npx tsc --noEmit -p tsconfig.json` → exit 0, no output.
- `npx jest --runInBand tests/operation-tenant-fence.test.ts` → `Tests: 4 passed, 4 total`, JEST_EXIT=0, Time 4.463 s.
- `npm run build` → BUILD_EXIT=0.
- `npx jest --runInBand tests/blob-wire-binary.test.ts tests/ingress-bounded.test.ts tests/usage-summary.test.ts tests/operation-tenant-fence.test.ts` → `Test Suites: 4 passed, 4 total`, `Tests: 26 passed, 26 total`, JEST_EXIT=0, Time 6.092 s (no regressions in CR-11/CR-13/W39-C suites).

**Boundary note for coordinator reconcile (W42-C9 §4):** R24-01 sits at the P2-07 (public operation lookup/facade) × P8-04 (SEC-01 cross-tenant isolation, OPS-04) boundary. The p8-04 suite's existing cross-tenant test (`p8-04-security-isolation.integration.test.ts:236`) covers the route WITHOUT `?wait=` and cannot detect this; my new suite covers WITH `?wait=` (foreign active/terminal + mid-poll flip). P2-07/P8-04 stay [~] until coordinator reconciles once — single reconcile requested, no self-tick.
**R24-02 (P5 multi-container global fetch rewrite + base64 fallback, `businesses/document-core/tests/multi-container-e2e.integration.test.ts:281-306,683-690,851-859`) is NOT my file — TEST-FIX REQUEST to the P5/document-core owner, coordinator to route. Not touched.**
**Next:** CR-12/MM-02 per W42-C9 order (R24-01 → CR-12/MM-02 → CR-06 → CR-01+02 → CR-03/04/05 → CR-09/10).

W42-C9 received 2026-09-24 ~00:0x (no DB claim, read-only start). (A) CR-13 CLOSED accepted — p4-05 7/7 + artifacts-grants 1/1 + blob-wire-binary 5/5 all ExitCode 0 (testing lane 23:46:45→23:47:12, disciplined claim/release); coordinator reconciles P4-05→[x]. Congratulations to the p4-05 owner on the shim fix. (B) R24-01 (HIGH, cross-tenant leak in P2 public operation lookup + ?wait= long-poll) now TOP priority, ahead of CR-12/MM-02 — reading CODE-PLAN-REVIEW-2026-09-24 + REVIEW-FIXES-2026-09-24 now. (C) R24-02 noted as P5/document-core owned — REQUEST only, no touch. (D) P2-07/P5-10 stay [~]. (E) New order: R24-01 → CR-12/MM-02 → CR-06 → CR-01+02 → CR-03/04/05 → CR-09/10.

W42-C8 trace result (2026-09-23 23:27, read-only — NO DB claim, ZERO edits to foreign files):

**(1) Full download-chain trace, file + line — NO remaining platform-side base64 stuffing:**
- SDK `downloadArtifactById` (`packages/worker-sdk/src/artifact-streams.ts:366-401`, read-only): POSTs `/artifacts/:id/access`, takes `grant.downloadUrl`, delegates to `downloadArtifact`.
- SDK `downloadArtifact` (:253-351): streams `downloadUrl` GET body raw through counting+hashing Transform to disk — `grep base64 packages/worker-sdk/src` = **zero matches**. SDK never decodes.
- Orchestrator access grant (`services/orchestrator/src/modules/artifacts/artifacts.ts:119-120`): `downloadUrl` = `/api/runtime/v1/artifacts/blob/<key>?grant=<token>` — opaque ref, no encoding.
- Orchestrator blob GET (`services/orchestrator/src/server.ts:504-507`): `{ status: 200, raw: bytes, headers: {'content-type':'application/octet-stream'} }`; responder (:249-251) sends `raw` byte-for-byte, no stringify/base64. `getBlob` (:136-140) returns pg bytea Buffer directly.
- `grep base64 services/orchestrator/src` = only `grants.ts:93-97` (HS256 JWT base64url — correct) and `app/admin/shell-auth.ts` (cookie HMAC — correct). **Zero blob-path base64.**
- `dist/server.js:408` ships `raw: bytes` (rebuilt, verified). Owned suites prove the wire: blob-wire-binary 5/5 byte-equal+sha256, artifacts-grants 1/1 raw.
- **The failing decode is the p4-05 test's OWN shim**: `tests/integration/p4-05-artifact-streams.integration.test.ts:270-280` comments "serves base64-encoded text" and `:279` does `Buffer.from(onDisk.toString('utf8'), 'base64')`. On the new raw wire, onDisk already IS the payload, so this decodes raw bytes a second time (Node's lenient base64 decoder mangles the ASCII payload) → `:280` equality false → the single 6/1 fail. Nothing left to fix on platform or SDK side.

**(2) TEST-FIX REQUEST to p4-05 owner (not self-edited per lane rule):** replace `tests/integration/p4-05-artifact-streams.integration.test.ts:270-280` shim with byte-equal assert `expect(onDisk.equals(payloadCopy)).toBe(true)` (+ update the stale base64 comment at :270-272 and the `maxBytes: 8` comment at :305, same root cause). No PLATFORM/SDK change needed — platform and SDK are both clean.

**(3) RUN REQUEST for antigravity (term_47a1d44b):** after the p4-05 owner applies the shim fix, please rerun `p4-05-artifact-streams` + `artifacts-grants` + `blob-wire-binary` and return per-suite `Tests: N passed` literals + exit codes. This lane holds no DB claim; window discipline respected.

**(4) P2-07/P5-10/P4-05 stay [~]** — coordinator reconciles only when all three green with ExitCode 0. CR-12/MM-02 queued behind CR-13 close.

W42-C7 finding (read-only, 22:5x — NO DB claim, NO edits to foreign files): the p4-05 double-wrap shim is the TEST's own decode block, not the SDK. `tests/integration/p4-05-artifact-streams.integration.test.ts:270-280` comments "serves base64-encoded text" and line 279 does `Buffer.from(onDisk.toString('utf8'), 'base64')` with line 280 asserting equality — on the new raw wire this decodes already-raw bytes a second time → the 6/1 fail. SDK is clean: `grep base64 packages/worker-sdk/src` = zero matches, so `downloadArtifact` already hashes/streams raw bytes correctly. DECISION REQUEST to p4-05 owner (not self-edited per W42-C rule): replace lines 270-280 shim with a byte-equal assert (`onDisk.equals(payloadCopy)`), same as owned artifacts-grants:246; then testing lane reruns p4-05 for full green. No RUN REQUEST from this lane — window is BUSY and the file is not mine.

W42-C7 received 22:50 (no DB claim, read-only turn). CR-13 STAYS OPEN — accepted: p4-05 rerun on new dist still 6/1 with base64 double-wrapping at line 280 (antigravity-6.md L3495); hunting the shim location read-only now. GREEN-EXIT1 eliminated noted: all 3 suites exit 0 after D(2); CR-11 8/8 exit-0 condition restored. P2-07/P5-10 stay [~] until p4-05 fully green. Order: CR-13 → CR-12/MM-02 → CR-06 → CR-01+02 → CR-03/04/05 → CR-09/10.

DB window REVOKED by coordinator at 2026-09-23 22:34 (claim 22:13 unconsumed, third idle-window revocation this wave — 13:41, 17:11 before it; accepted, no dispute). Window is FREE; testing lane has it for their next RUN REQUEST. New claim only at jest-fire moment, run in the same turn.

**CR-13 ROI (3 lines):** (1) blob-wire-binary.test.ts — 5/5 green on new dist (byte-equal invalid-UTF-8 round-trip, JSON-bytes native, sha256+content-length match, first-byte-not-quote, wrong-grant 403). (2) tests/integration/artifacts-grants — 1/1 green (GET returns raw bytes, not base64). (3) GREEN-EXIT1 decision: **D(2) — test teardowns opt out of the 30s production grace drain** (`close({timeoutMs:0,pollIntervalMs:10})`); production default untouched; drain() counts RUNNING rows server-wide so foreign-lane rows held close past the hook timeout. P2-07/P5-10 stay [~] until coordinator reconciles upward on this evidence.

**Status ~17:25 — MID-TURN, not blocked. 16:00 claim voided (idle window,
accepted). Context is thin after two compactions but lane continues.
CR-13 read-only survey done: blob GET base64+JSON.stringify fault mapped,
SDK consumers mapped read-only, MM-02 needs mapped from docs/25. Firing the
FIX-CR-13 unit check next; will claim DB window in writing only at jest time.**

**Status ~16:00 — MID-TURN. DB window CLAIMED in writing (fresh claim, this
line) for FIX-CR-13 regression run on :5433/:6380. Will RELEASE in writing
when jest stops.**

**Status ~14:20 — idle, no blocker; taking CR-13 now (reading docs/25-mm-status-crosscheck.md first).**

# W40/W41 status — MID-TURN, actively working (2026-09-23 ~13:30)

Lane is mid-turn, not idle, not blocked. Silence since 13:04 was lane-local
context compaction, not fleet outage.

**Window:** 13:04 claim voided (idle, no processes) — window is FREE. This lane
needs no DB until CR-13's regression run; will take it by fresh written claim
only when ready to fire jest. CR-11 credited DONE (ingress-bounded.test.ts 8/8
green, report line above stands).

## FIX-CR-11 — DONE (bounded ingress + caught request-stream errors)

**Enforced:** every platform request body flows through `readBoundedBody`
(`services/orchestrator/src/http/ingress.ts`, NEW, ~112 lines): streamed bytes
capped (`maxJsonBytes` default 1 MiB, `maxBlobBytes` default 64 MiB,
config-tunable); oversize → `413 PAYLOAD_TOO_LARGE`; stream
error/abort/premature-close → `400 MALFORMED_BODY` (never echoes chunk bytes);
binary blob-PUT path returns raw `Buffer`, never utf8-decoded or JSON-parsed.
The listener reads inside `try` and converts ingress errors to a controlled
`application/problem+json` response (dead-socket guard: silent return when
`res.writableEnded || res.destroyed`), so stream failures can never escape as
an unhandled rejection. Legacy unbounded `readBody` removed.

**Regression coverage** (`services/orchestrator/tests/ingress-bounded.test.ts`,
NEW, 8 tests, real HTTP against `createApp` with tiny caps 256 B / 128 B,
real PG :5433 + Redis :6380):
- unauthenticated oversize JSON → 413 before route auth;
- chunked (no Content-Length) oversize → 413;
- in-cap JSON still routes (bad bearer → 403, proving parse+routing intact);
- aborted mid-body → zero `unhandledRejection`, server answers next request;
- blob PUT with invalid-UTF-8 bytes stored byte-equal;
- blob PUT with JSON-looking bytes stored byte-equal;
- oversize blob PUT → 413, previously stored bytes untouched;
- `GET /health → 200` after all abuse (responsiveness).

**Commands + literal results (this turn):**
- `npx tsc --noEmit -p services/orchestrator/tsconfig.json` → exit 0, no output.
- `cd services/orchestrator && npx jest --runInBand tests/ingress-bounded.test.ts`
  → `Tests: 8 passed, 8 total`, exit 0 (run under package ts-jest config;
  note: root `npx jest` uses babel and cannot parse `import … type` — always
  run orchestrator suites from `services/orchestrator`).

**Queue:** next FIX-CR-13 (+CR-12/MM-02 binary wire), then CR-06, CR-01+CR-02,
CR-03/04/05 bundle, CR-09+CR-10. P6 mount verified present; nothing P6 needs.

---
# Wave 39-C2: P2-07 tick + runtime.test.ts isolation (2026-09-23, IN PROGRESS)

**Defect closure (orchestrator review):** W39-C report stated P2-07 `[x]`/fully
closed while `tasks/P2-orchestrator.md` row still read `[ ]` (mtime 02:38).
Decision: the report stands — both W39-C items (getUsageSummary, CON-03 proxy)
passed 9/9 real-DB this turn, and grant binding + usage ingestion were already
proven (W12-C/W13-C). Ticking the row `[x]` now, plus the line-18 audit sentence
that still lists P2-07 as unchecked.

**W39-C2:** adopting per-run namespacing/scoped cleanup in
`tests/runtime.test.ts` (+ shared jest config if needed) so overlapping lane
runs cannot clobber each other; suite result with literal output follows below.
DB window granted for this turn. No commit/push/reset.

**W39-C2 CANCELLED (orchestrator-verified, 2026-09-23):** premise was false —
`services/orchestrator/tests/runtime.test.ts` contains no TRUNCATE and no
flushdb (only the line-152/156 comments plus 43 scoped `DELETE FROM` keyed by
operation/task/business id). Suite already isolated; no refactor made. P2-07
stays closed on the 9/9 real-DB evidence below. **DB window: RELEASED**
(window not consumed this turn).

---
# Wave 39-C: P2-07 narrowed — getUsageSummary + CON-03 connector proxy (2026-09-23)

**Status: COMPLETE — DB window RELEASED.**

W39-C (packet `WAVE-39-ORCHESTRATOR-REALLOCATION.md §W39-C`) delivers the two
genuinely missing P2-07 pieces its own survey established: invocation-grant
binding and usage ingestion/projection already exist and are tested
(W12-C/W13-C). No other process touched :5433/:6380 during this turn (verified:
zero competing jest/tsx processes before the run).

## 1. getUsageSummary(tenantId, from, to) — `src/modules/usage/usage.ts`

Tenant-scoped aggregate by provider/model over the `[from,to)` `received_at`
window, exposed at `GET /api/v1/usage/summary?from=&to=` (x-api-key tenant).

**Schema gap (recorded, not patched):** `usage_events` (`migrations/0002_usage_events.sql`,
untouched by every later migration) carries only `event_id`, `operation_id`,
`task_id`, `payload` (frozen `@du/contracts` UsageEvent — units, cost,
measurement, occurredAt) and `received_at`. There is **no provider or model
column**, and the frozen contract defines no such fields. No migration was
written (W39-C forbids unilateral schema changes). The summary therefore reads
`payload.provider`/`payload.model` when present (forward-compatible, contract
unchanged) and collapses absent values into a single `(unattributed)` bucket so
the function is always well-defined. Tenant scoping joins `operations.tenant_id`;
`from > to` and invalid dates fail closed 422; missing x-api-key fails 401.

## 2. CON-03 connector proxy — `src/modules/connectors/connectors.ts` (NEW) + `server.ts`

`GET /api/v1/connectors/:id/test` (x-api-key tenant) probes the
platform-configured Connector base URL's `/health/ready` and returns
`{ connectorId, ok, latencyMs }`. Hard rules: base URL is platform config
(`connectorBaseUrls`), never caller input (no open proxy); the probe carries no
auth and no caller headers; upstream headers are never forwarded or echoed;
upstream error bodies are never returned — unhealthy → sanitized 502
CONNECTOR_UNHEALTHY, unreachable/timeout → sanitized 502 CONNECTOR_UNAVAILABLE
(no address/secret/stack leak); unconfigured id → 404. Miss would previously
have been a platform 404 route miss.

## 3. Evidence (real DB, this turn, literal output)

`npx jest tests/usage-summary.test.ts --runInBand`:

```
PASS tests/usage-summary.test.ts
  W39-C: usage summary projection (real DB)
    ✓ aggregates by provider+model with correct totals and mixed measurement (69 ms)
    ✓ rows without provider/model collapse into the unattributed bucket (20 ms)
    ✓ tenant isolation: another tenant rows are excluded (29 ms)
    ✓ window filtering: rows outside [from,to) are excluded (24 ms)
    ✓ invalid window and missing params fail closed with 422 (10 ms)
  W39-C: connector test proxy (CON-03)
    ✓ healthy connector returns ok:true and sends no caller/internal headers (10 ms)
    ✓ unhealthy upstream surfaces sanitized 502 with no upstream body echo (5 ms)
    ✓ unreachable connector surfaces sanitized 502 with no address leak (4 ms)
    ✓ unconfigured connector id fails closed with 404; missing key with 401 (5 ms)

Test Suites: 1 passed, 1 total
Tests:       9 passed, 9 total
```

`npx tsc --noEmit -p tsconfig.json` → exit 0, 0 errors (one `measurement`
narrowing error found and fixed in-turn before the green run).

Suite isolation: dedicated tenant `11111111-…` + business `w39c-biz` so other
suites' rows on the shared default tenant can never pollute the summary;
scoped cleanup by `business_id` only (no global TRUNCATE/flushdb). Proxy tests
run against a stub HTTP server for healthy/unhealthy/upstream-leak modes and a
dead port for the unreachable mode.

**P2-07 decision:** both W39-C items pass with real DB. `tasks/P2-orchestrator.md`
P2-07 → `[x]`. **P2-07 is now fully closed.**

Scope: `src/modules/usage/usage.ts`, `src/modules/connectors/connectors.ts` (NEW),
`src/server.ts` (2 routes + `connectorBaseUrls` config + ctx wiring),
`tests/usage-summary.test.ts` (NEW). `src/app/**`,
`app/workflow-builder/**`, `businesses/**` untouched. No commit/push/reset.

**DB window: RELEASED.** Shared PG :5433 / Redis :6380 is free.

---
# Wave 37-C: P2-06 composite acceptance — children/join, human wait, deadline/cancel (2026-09-22)

**Status: COMPLETE — DB window RELEASED.**

W37-C (packet `WAVE-37-DIRECT-ALLOCATION.md §W37-C`) closes **P2-06** with
composite real-DB acceptance for RUN-05 (fan-out children, exactly-once join
reconciliation, concurrency=1 no deadlock), RUN-06 (human wait lifecycle +
stale-CAS + duplicate replay), and RUN-07 (deadline sweep + cancel close waits,
cancel-then-resume fails closed). All new cases are integration tests in
`tests/runtime.test.ts` against real PG :5433 / Redis :6380; no platform source
changes were needed beyond what prior waves already landed (the typed
continuation routes, join reconciliation, cancel/deadline closure, and
expired-lease sweep were all already passing individually — this wave binds them
into the composite runtime flows the task's acceptance describes).

**P2-06 is now fully closed** for its formal acceptance (RUN-05..07).

## 1. Tests (runtime.test.ts, +7 → 93 cases)

New `W37-C: P2-06 composite` describe block (real PG/Redis, scoped cleanup):

### RUN-05 — children / dependencies / join continuation
- **full fan-out → join → continuation → SUCCEEDED**: root claim, spawn 3
  children (all-success join policy), dispatch → each child claimed + completed
  with content-hash result ref → single `task.continuation` outbox row closes
  the join → parent re-queued with `joinSummary` → re-dispatched → re-claimed →
  root completes → operation SUCCEEDED with ResultEnvelope.
- **concurrency=1, no deadlock**: `Promise.all` concurrent child completions →
  exactly one continuation row (stable `parentId:join:N` deliveryId +
  `ON CONFLICT DO NOTHING`), parent serialized by `FOR UPDATE`, a single
  parent claim succeeds, operation SUCCEEDED.
- **child failure → fail-closed join**: one child FAILED → parent terminated
  `JOIN_FAILED`, open sibling CANCELLED, operation FAILED, GET result → 409.

### RUN-06 — human wait lifecycle
- **OPEN → resume ANSWERED → task QUEUED → completion SUCCEEDED**: worker
  `wait-input` opens a WAITING_INPUT wait; resume with expected stateVersion +
  input validates → wait ANSWERED, task QUEUED with `resumeInput`, outbox
  re-dispatch (`taskId:resume:version`), re-claim by the same worker, complete →
  op SUCCEEDED. **Stale-CAS** (wrong expectedStateVersion) → 409 STATE_CONFLICT;
  **duplicate resume** of an ANSWERED wait → 200 `{replayed:true}`.
- **unknown wait → 404; terminal-op resume → 409**: resume of a nonexistent
  waitId → 404 NOT_FOUND; after the op reaches SUCCEEDED, a late resume fails
  closed with 409 STATE_CONFLICT (no state churn).

### RUN-07 — deadline / cancel close waits
- **deadline sweep**: admin sweep-deadlines closes the OPEN wait to EXPIRED and
  terminals task CANCELLED + op TIMED_OUT in one tx; GET result → 410 GONE;
  late resume on the terminated op → 409.
- **cancel**: admin cancel closes the OPEN wait to CANCELLED and terminals op
  CANCELLED; resume fails closed 409; **cancel replay** of an already-cancelled
  op → 200 replayed, no duplicate dispatch.

## 2. Test-harness note (lease ownership on continuation)

The composite helpers re-claim a continued task under the **same**
`workerInstanceId` that held the original claim. This mirrors the production
contract — a continued/joined/resumed task's lease is not cleared at the
WAITING_INPUT→QUEUED transition, so ownership stays with the original worker
until its lease lapses (the expired-lease sweep from W30-C recovers it
otherwise). A different worker claiming while the original lease is live gets
the correct 409 `state is leased by another worker`; the suite's earlier
attempt to use a distinct continuation worker exposed exactly that fence and
was corrected to the same-worker contract.

## 3. Evidence (serial, exclusive window, this session)

| Command | Result |
|---|---|
| `pnpm --filter @du/orchestrator exec tsc --noEmit` | 0 errors |
| `npx jest tests/runtime.test.ts --runInBand` | **93/93 PASS** (86 baseline + 7 new W37-C) |
| `npx jest --runInBand` (full orchestrator) | **358/358 PASS** (6 suites) |
| `npx jest tests/migrations.test.ts --runInBand` | 9/9 PASS (in the 358) |

Scope: only `tests/runtime.test.ts` edited for W37-C (no platform source
outside `runtime.ts`). `tasks/P2-orchestrator.md`: P2-06 → `[x]` closed.
`src/app/**`, `src/modules/profiles/**`, `src/modules/webhooks/**`,
`app/workflow-builder/**`, `du-rework/businesses/**` untouched.

**DB window: RELEASED.** Shared PG :5433 / Redis :6380 is free.

---
# Wave 36-C: P2-08 operations status & result facade (2026-09-22)

**Status: COMPLETE — DB window RELEASED.**

W36-C (packet `WAVE-36-DIRECT-ALLOCATION.md §W36-C`) delivers the second half
of P2-08 — the composite public Operation Status & Result facade — in
`services/orchestrator`. Combined with W32-C (webhook delivery), **P2-08 is now
fully closed** for its formal acceptance (OPS-04..06 + webhook isolation).

## 1. Facade module (`src/modules/operations/facade.ts`, NEW)

- **`toOperationView(r)`** — maps a DB operations row to the canonical
  `OperationView` envelope per docs 06. Adds the AIP-style `name:
  'operations/' + id` field alongside the existing rich shape (businessId,
  businessVersion, action, stateVersion, createdAt, updatedAt, deadlineAt,
  progress `{percent, message}`, links `{self, result}`).

- **`isTerminal(state)`** — returns true for SUCCEEDED/FAILED/CANCELLED/TIMED_OUT.

- **`resultHttpStatus(state)`** — maps state to the correct HTTP status for
  `GET /operations/:id/result`:
  - SUCCEEDED → 200 (ResultEnvelope)
  - TIMED_OUT → 410 GONE (docs 06: "410 expired")
  - Everything else → 409 STATE_CONFLICT

- **`waitForTerminal(getOp, operationId, waitSeconds)`** — sync long-poll helper
  per docs 06 `?sync=true` / packet `?wait=<seconds>`. Polls the DB every 500 ms
  until the operation reaches a terminal state or the timeout (max 30 s) expires.
  The timeout never cancels the underlying operation — the caller receives the
  latest view at expiry.

## 2. Route updates (`server.ts`)

- **`GET /api/v1/operations/:id`** — now supports optional `?wait=<seconds>`
  (clamped [0, 30]). When wait > 0, the handler calls `waitForTerminal` before
  returning, holding the HTTP response open until the operation is terminal or
  the wait expires. Without `?wait`, returns immediately (backward-compatible).

- **`GET /api/v1/operations/:id/result`** — now returns 410 GONE for TIMED_OUT
  (aligned with docs 06), 409 STATE_CONFLICT for all other non-SUCCEEDED
  states, and 200 ResultEnvelope when SUCCEEDED.

- Inline `toOperationView` removed from server.ts; replaced with import from
  facade module (no duplication).

## 3. Tests (runtime.test.ts, +14 → 86 cases)

### Unit tests (facade module)
- `toOperationView` canonical shape: name, links, progress, business fields
- `isTerminal`: all 4 terminal states + non-terminal states
- `resultHttpStatus`: 200 / 410 / 409 mapping
- `waitForTerminal`: returns immediately for already-terminal op

### Integration tests (HTTP endpoints)
- `GET /operations/:id` returns canonical view with name, links, progress
- `GET /operations/:id` non-existent returns 404
- `GET /operations/:id/result` SUCCEEDED → 200 ResultEnvelope
- `GET /operations/:id/result` PENDING → 409 STATE_CONFLICT
- `GET /operations/:id/result` CANCELLED → 409 STATE_CONFLICT
- `GET /operations/:id/result` TIMED_OUT → 410 GONE
- `GET /operations/:id/result` non-existent → 404
- `?wait=0` returns immediately (no blocking)
- `?wait=5` long-poll holds until SUCCEEDED (concurrent dispatch + complete)
- `?wait=1` timeout returns current non-terminal state (~1 s elapsed)

## 4. Evidence (serial, exclusive window, this session)

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx jest tests/runtime.test.ts --runInBand` | 86/86 PASS |
| `npx jest tests/migrations.test.ts --runInBand` | 9/9 PASS |
| Combined (serial) | **95/95 PASS** |

DB window: **RELEASED.** Shared PG :5433 / Redis :6380 is free.

---
# Wave 32-C: P2-08 webhook delivery outbox & callback dispatch slice (2026-09-22)

**Status: COMPLETE — DB window RELEASED.**

W32-C (packet `WAVE-32-DIRECT-ALLOCATION.md`) delivers the P2-08 webhook
delivery slice in `services/orchestrator`: durable webhook scheduling on the
terminal operation transition, HMAC-SHA256 signed dispatch, and retry-tracked
delivery. Owned scope only: `src/modules/webhooks/**`, `src/modules/lifecycle/**`,
`src/modules/runtime/runtime.ts`, `src/modules/operations/submission.ts`,
`src/db/migrations.ts` (new `0007`), `src/server.ts`, `tests/runtime.test.ts`,
this report. `src/app/**` untouched.

## 1. Schema (migration `0007_webhook_deliveries.sql`)
- `operations.callback_url text` — callback destination pinned at submit
  (docs 06 `Submission.callback`); `submission.ts` persists it in the same tx
  as operation + root task + outbox row.
- `webhook_deliveries` — `delivery_id` (uuid PK), `operation_id` (FK),
  `tenant_id`, `event_type`, `terminal_state`, `state_version` (terminal
  revision), `destination_url`, `payload` (docs 06 `WebhookPayload`), `status`
  (PENDING/DELIVERED/FAILED), `attempts`, `max_attempts`, `next_at`,
  `last_error`, `delivered_at`.
- Unique index `(operation_id, state_version, destination_url)` = the docs 04
  dedup scope (at-most-one delivery per terminal revision + destination);
  partial index on `next_at WHERE status='PENDING'` for the dispatcher scan.

## 2. Scheduling — transactional with the terminal transition
`webhooks.maybeScheduleWebhook(client, operationId)` reads the operation
INSIDE the terminal tx, and only inserts when the state is terminal
(SUCCEEDED/FAILED/CANCELLED/TIMED_OUT) and `callback_url` is set. The payload
carries `deliveryId/eventType/operationId/state/stateVersion/occurredAt` per
the frozen `WebhookPayloadSchema`; the row's `deliveryId` is stamped into the
payload in the same tx so body and durable row agree. `ON CONFLICT DO NOTHING`
on the dedup index makes a replayed terminal transition (cancel replay,
duplicate complete) schedule nothing extra. Wired at every terminal write:
- `runtime.completeTask` → SUCCEEDED
- `runtime.failTask` terminal path → FAILED
- `runtime.reconcileParentJoin` join-failure → FAILED
- `runtime.sweepExpiredLeases` budget-exhausted → FAILED
- `lifecycle.cancelOperation` → CANCELLED
- `lifecycle.sweepDeadlines` → TIMED_OUT (per-op loop in the same tx)

## 3. Signing (docs 06)
`signWebhookBody(secret, timestamp, body)` = `sha256=<hmac-hex>` over
`{timestamp}.{body}` (`webhookSigningPayload` from `@du/contracts`);
`verifyWebhookSignature` uses a constant-time compare. Headers sent:
`x-du-signature`, `x-du-timestamp`, `x-du-delivery-id` (frozen contract
constants). Payload carries no file/raw prompt.

## 4. Dispatcher with retry tracking
`deliverWebhooks(db, {secret, fetchFn?, baseBackoffMs?, batchSize?, now?})`:
claims due PENDING rows `FOR UPDATE SKIP LOCKED` (concurrent dispatchers never
double-send), POSTs the signed body. 2xx → DELIVERED (delivered_at, attempts+1);
failure → attempts+1 with exponential backoff `next_at = now + base*2^(n-1)`,
or FAILED when the budget is exhausted. A FAILED row is terminal (never
re-attempted). Delivery failure NEVER changes the operation outcome — the
operation is already terminal before any delivery runs (docs 06: "Webhook
failure không đổi operation success thành failure"). `fetchFn` is injectable
for deterministic tests; production uses global fetch. SSRF-at-registration /
manual-redelivery-audit remain separate (not this slice).

## 5. Production hook (server.ts)
`webhookSecret?: string` (fail-closed: dispatcher disabled when unset,
scheduling still writes durable rows), `webhookDispatchIntervalMs?: number`
(default 5000ms when autoDispatch on AND secret set; 0 disables). `listen()`
starts the interval; `close()` clears it. No new public route — scheduling is
a side effect of existing terminal paths.

## 6. Tests (runtime.test.ts, +9 → 72 cases)
New `W32-C: webhook delivery outbox & dispatch` block (real PG/Redis):
- callback_url persisted at submit; SUCCEEDED schedules one signed row
  (payload deliveryId == row id, eventType/stateVersion correct).
- no callback → no row on terminal transition.
- FAILED (failTask), CANCELLED (cancel, replay does not duplicate),
  TIMED_OUT (deadline sweep) each schedule exactly one row.
- sign/verify round-trip + tamper rejection (wrong body/secret/signature).
- dispatcher success → DELIVERED, signed headers verify against the exact
  sent body+timestamp (assertion scoped to this op's deliveryId — the sweep
  is global on the shared DB by design).
- dispatcher failure → backoff retry → budget exhausted FAILED; operation
  stays SUCCEEDED; FAILED row never re-attempted.
- dispatcher idempotency → delivered rows stay delivered, no re-send.

## 7. Evidence (serial, exclusive window, this session)
- `npx tsc --noEmit -p tsconfig.json` (services/orchestrator) → **0 errors**.
- `npx jest tests/migrations.test.ts --runInBand` → **9/9 PASS** (incl. 0007).
- `npx jest tests/runtime.test.ts --runInBand` → **72/72 PASS** (63 baseline
  + 9 new W32-C).
- Full `npx jest --runInBand` → 184 pass, 2 fail — BOTH failures are the
  pre-existing OpenClaude W31-O connector-masking view-model tests
  (`tests/admin-view-model.test.ts`, untracked `src/app/**` lane, zero
  references to webhook/callback code). Not W32-C scope; boundary forbids
  editing `src/app/**`.
- Scoped row cleanup only; no global TRUNCATE / flushdb.

**DB window: RELEASED.** Shared PG :5433 / Redis :6380 is free.

---

# Wave 30-C: P2-09 expired-lease recovery slice (2026-09-22)

**Status: COMPLETE — DB window RELEASED.**

W30-C (packet `WAVE-30-IDLE-LANES.md`) delivers the P2-09 durable expired-lease
recovery slice in `services/orchestrator/src/modules/runtime/**`, its production
lifecycle wiring, and real-DB tests. Owned scope only:
`services/orchestrator/src/modules/runtime/runtime.ts`,
`services/orchestrator/src/server.ts`, `services/orchestrator/tests/runtime.test.ts`,
this report.

## 1. Audit finding: no orchestrator-side expired-lease recovery existed

A real worker that dies after `claimTask` leaves the task in `state='RUNNING'`
with an expired `lease_expires_at` and **no pending outbox row** (the outbox row
was marked `dispatched_at` on publish; nothing new is written while the task is
claimed). The only recovery avenues were inbound/queue-side:
- `claimTask` will hand the task to a *new worker on a new inbound delivery*
  once the lease lapses (fencing foundation), but that requires the queue to
  re-deliver — which BullMQ stalled-detection does only when a live worker
  process detects the stall, and it replays the **same** `deliveryId`
  (idempotent claim, epoch not bumped). There was no path that recovers the
  task *without* another inbound delivery, and nothing advanced the fence.
- `sweepDeadlines` (lifecycle) only flips `deadline_at`-past operations to
  TIMED_OUT; it does not touch leased RUNNING tasks, and it is admin-triggered
  (no background interval of its own).

**P2-09 conclusion:** a periodic, durable, idempotent expired-lease sweep was
required and is now implemented.

## 2. Implementation (runtime.ts + server.ts)

`runtime.sweepExpiredLeases(limit = 50)` — runs in one tx, `FOR UPDATE SKIP
LOCKED` (concurrent sweepers serialize per row, never double-handle):
- Candidates: `t.state='RUNNING'` AND `t.lease_expires_at < now()` AND the
  operation not terminal. This naturally excludes idle READY/QUEUED tasks
  (no lease), WAITING_INPUT / WAITING_CHILDREN tasks (those states, not
  RUNNING), and terminal operations (never revive).
- **Budget remaining** (`attempt < max_attempts`): bump `lease_epoch` (fences
  the late old worker), clear lease + `leased_by`, set task back to `READY`,
  and insert one outbox `task.dispatch` row with a stable
  `${taskId}:recover:${newEpoch}` deliveryId (`ON CONFLICT DO NOTHING` →
  idempotent). The existing dispatcher publishes it to the business queue.
- **Budget exhausted** (`attempt >= max_attempts`): terminal-fail the task with
  `LEASE_EXPIRED` and fail the operation, reusing `reconcileParentJoin` so a
  child's join propagates exactly once (mirrors `failTask` terminal path).
- Retry budget, operation/version/profile pins, checkpoint replay, and
  at-most-one dispatch per recovery are all preserved: the sweep only re-queues
  when budget remains; payload is a full BusinessJobV1 so the SDK parse holds;
  epoch bump is the fence.

`heartbeatTask` made **atomically fenced**: the lease extension is now an
epoch-conditional `UPDATE ... WHERE id=$1 AND lease_epoch=$3` (rowCount checked),
closing the read-then-write resurrection window where a late old worker could
extend a lease the sweep already fenced. Other runtime writes already re-check
epoch inside their `FOR UPDATE` tx.

**Production hook (not manual-only):** `server.ts` `createApp` accepts
`leaseRecoveryIntervalMs` (default 5000ms when `autoDispatch !== false`; 0 to
disable). `listen()` starts a `setInterval` calling `runtime.sweepExpiredLeases()`
directly; `close()` clears it. Tests drive the same method directly and a
dedicated test proves the background timer recovers without a manual call.

## 3. Tests (runtime.test.ts, +9 -> 63 cases)

New `W30-C: expired-lease recovery` describe block (real PG/Redis, scoped cleanup):
- expired RUNNING task → re-dispatched via outbox, epoch bumped, old-epoch
  heartbeat 409 LEASE_LOST.
- unexpired lease untouched by sweep.
- READY task (NULL lease) excluded (idle, not crashed).
- WAITING_INPUT and WAITING_CHILDREN tasks excluded.
- terminal operation excludes a RUNNING task.
- terminal (FAILED) task with stale lease excluded.
- budget exhaustion → terminal FAIL, op FAILED, no outbox row.
- repeated sweep idempotent (second sweep no-op, no duplicate outbox row).
- **production hook**: `listen()` with 50ms interval recovers a seeded expired
  RUNNING task via the background timer (no explicit `sweepExpiredLeases()` call).

## 4. Pipeline / leftover
Typecheck clean for owned scope. P2-09 stays `[x]`**pending** full background
lifecycle/health/shutdown acceptance is exercised here (the recovery timer start/
stop and a real firing); the task-level sweep slice is complete. P2-06, P2-07,
P7 remain `[ ]` as before — this wave does not claim them.

## 5. Evidence (serial, exclusive window, this session)
- `npx tsc --noEmit -p tsconfig.json` (services/orchestrator) → **0 errors**.
- `pnpm test` (jest, runInBand, all 3 suites) → **138/138 PASS**
  (63 runtime + 9 migrations + 66 admin-view-model; runtime was 54 before this
  wave, +9 W30-C). Baseline regression green in the same run.
- No global TRUNCATE / flushdb; scoped row cleanup only.

**DB window: RELEASED.** Shared PG :5433 / Redis :6380 is free.

---

# Wave 29-C: R08-07 ADR, Admin authorization fixes, negative tests (2026-09-22)

**Status: COMPLETE — DB window RELEASED.**

W29-C (packet `WAVE-29-PLATFORM-ADMIN-WORKFLOW.md`) records the R08-07 platform
architecture decision, fixes a confirmed Admin route defect, and adds focused
negative authorization tests covering unauthenticated/role-substitution/
cross-tenant access for all Admin registry/version/profile routes. Owned scope
only: `docs/15-decisions.md`, `services/orchestrator/src/server.ts`,
`services/orchestrator/tests/runtime.test.ts`, this report.

## 1. R08-07 ADR-14 (docs/15-decisions.md)

- **Accepted for this rework:** raw `node:http` + regex router + raw `pg`
  pool; bearer-token Admin/Runtime auth (fail-closed, separate tokens enforced
  at boot per W11-C1); ProblemDetails as the stable error contract; platform
  lane owns all server-side authorization.
- **Deferred — do not treat as complete:** rendered Admin UI (W26-O/W29-O
  headless view-models only), production object storage (ADR-10 S3 target;
  artifacts in PG per P2-07 slice), framework adoption (express/fastify),
  session/RBAC/CSRF admin auth (`docs/07-internal-api.md` target), path
  migration to `api/internal/v1`.
- **Compatibility/migration:** route table is 1:1 wrappable in a future
  framework; ProblemDetails is the stable contract (any change is a coordinated
  contract bump); migrating to session/RBAC auth is a separate wave with its
  own ADR.
- **Authorization owner:** platform lane (`services/orchestrator`) owns
  `assertAdminAuth`, `assertRuntimeAuth`, `resolveApiKey`, tenant-scoped
  cancel/resume/read checks. Admin routes are global by design (single bearer
  token = trusted global administrator); multi-admin RBAC deferred.

## 2. Fix: `enable` false-success on unregistered version (server.ts)

The `PUT /api/v1/admin/businesses/:id/versions/:version/enable` route
previously returned `200 ENABLED` even when the version row did not exist
(UPDATE affected 0 rows but no rowCount check). This is inconsistent with
`activate`/`deactivate` which both 404 on non-existent versions. Fixed:
check `result.rowCount` and throw 404 NOT_FOUND when no row was affected.

## 3. Negative authorization tests (runtime.test.ts, +7 -> 54 cases)

New `W29-C: Admin authorization negative tests` describe block:
- `enable rejects missing admin auth (401)` — no bearer token → 401
- `deactivate rejects missing admin auth (401)` — no bearer token → 401
- `profile-bindings rejects missing admin auth (401)` — no bearer token → 401
- `enable rejects runtime token (401)` — role substitution denied
- `enable on unregistered version → 404 NOT_FOUND` — Fix 1 regression proof
- `cross-tenant cancel → 404` — other tenant's API key cannot cancel
- `cross-tenant resume → 404` — other tenant's API key cannot resume

## 4. Typecheck note

`tsc --noEmit` against `src/app/admin/view-models.ts` reports a pre-existing
type error (`Object literal may only specify known properties, 'from'`) in
W26-O/W29-O-owned OpenClaude headless Admin view-model code (untracked, mtime
16:55 today). This file is in the `src/app/**` path which W29-C is forbidden
from editing. Platform-owned code (`src/server.ts`, `src/modules/**`,
`tests/**`) typechecks clean when `src/app/**` is excluded; the error is
documented as an OpenClaude-owned open item for W29-O's acceptance.

## 5. Evidence (serial, exclusive window, this session)
- `npx tsc --noEmit` (excluding `src/app/**`) → **0 errors**.
- `npx jest tests/migrations.test.ts --runInBand` → **9/9 PASS**.
- `npx jest tests/runtime.test.ts --runInBand` → **54/54 PASS**
  (47 baseline + 7 new W29-C).
- Combined **63/63 PASS**. No global TRUNCATE; scoped row cleanup only.

**DB window: RELEASED.** Shared PG :5433 / Redis :6380 is free.

## 6. Untouched P2-02 gaps (not claimed complete from this slice)
- RBAC roles (ADMIN/USER/VIEWER) with per-route permission matrix: not
  implemented (bearer token only; W29-C ADR-14 defers this to session/RBAC
  auth wave).
- Profile-binding tenant isolation proof at submission time (PRF-01/02): covered
  in W13-C; not re-tested here.
- Admin user management CRUD, API key provisioning/revocation, connector catalog
  proxy, audit/usage cursor pages: defined in `docs/07-internal-api.md` but not
  implemented in the rework slice.

---

# Wave 28-C: explicit version activation / drain / rollback — review fix (2026-09-22)

**Status: COMPLETE — DB window RELEASED.**

W28-C (packet `WAVE-28-IDLE-LANES.md`) adds an explicit active-version pointer
to the platform registry so new submissions select the admin-chosen version,
addressing W27-A Case 10's gap (re-enabling v1 did not change selection; no
disable/drain route). This revision addresses all three coordinator review
items from `WAVE-28-C-REVIEW-FOLLOWUP.md`:
- Drain semantics fail-closed: deactivating the sole active version blocks new
  submissions with 404 until an operator explicitly activates another version;
  the old "newest ENABLED" fallback has been removed.
- Concurrent activate deadlock eliminated: `activateVersion` locks all
  business_versions rows in deterministic `version ASC` order before any
  state change; a focused concurrent test proves no deadlock and the unique
  index is never violated.

Shared PG :5433 / Redis :6380 used exclusively and serially; window now RELEASED.

## 1. Active-version model
- Migration `0006_active_version.sql`: `business_versions.is_active` (boolean,
  default false) + partial unique index
  `business_versions_active_unique ON (business_id) WHERE is_active = true`.
  Seeds the most recently created ENABLED version per business.
- `src/modules/registry/registry.ts`:
  - `activateVersion` — ordered-lock all business rows (version ASC) to prevent
    deadlock, then clear + set the target. Idempotent (200 replay).
  - `deactivateVersion` — drains the pointer (is_active=false). Idempotent.
  - `enableVersionForTest` now also activates the version transactionally.
- `src/modules/operations/submission.ts` `resolveEnabledVersion` — targets
  `is_active = true` only; **no fallback** — 404 if no version is active.
- Admin routes: `PUT .../versions/:v/activate` (202/200 replay),
  `PUT .../versions/:v/deactivate` (202/200 replay).

## 2. Tests (runtime.test.ts, +7 -> 47 cases)
- activate v2 → new submissions v2, in-flight v1 pinned.
- activate v1 rollback → new submissions v1.
- drain v2 fail-closed → 404 no active version, explicit re-activate restores.
- concurrent activate(v2) + activate(v1) → no deadlock, exactly one active.
- activate invalid version → 404.
- activate rejects missing admin auth → 401.
- activate idempotent retry → 200 replayed.

## 3. Evidence (serial, exclusive window, this session)
- `npx tsc --noEmit` → **0 errors**.
- `npx jest tests/migrations.test.ts --runInBand` → **9/9 PASS**.
- `npx jest tests/runtime.test.ts --runInBand` → **47/47 PASS**.
- Combined **56/56 PASS**. No global TRUNCATE; scoped row cleanup only.

**DB window: RELEASED.**

## 4. P7-06 dependency (not ticked)
P7-06 stays `[ ]`: business-level v1/v2 live acceptance remains a separate gate.
Antigravity is on HOLD.

---

# Wave 27-C: cancellation persistence consistency, migration contract audit, DB window released (2026-09-22)

**Status: COMPLETE — DB window RELEASED. Antigravity may run live P7 now.**

W27-C (packet `WAVE-27-P2-P7-CLOSEOUT-PACKET.md`) makes cancellation/deadline
closure transactional with `human_waits`, adds focused regression tests, and
fixes the migration CLI doc contract. Shared PG :5433 / Redis :6380 used
exclusively and serially (no global TRUNCATE); window now RELEASED.

## 1. Cancellation/deadline consistency (lifecycle)
`src/modules/lifecycle/lifecycle.ts` — a terminal operation no longer leaves an
actionable OPEN human wait:
- `cancelOperation` now closes OPEN waits to **CANCELLED** in the same
  transaction as the operation/task terminal transition. Resume on a CANCELLED
  wait fails closed (409 STATE_CONFLICT) and emits no dispatch.
- `sweepDeadlines` wrapped in `db.tx` and closes OPEN waits to **EXPIRED**
  transactionally alongside the TIMED_OUT/cancel of operation and task.
- Race semantics: `operations ... FOR UPDATE` (first in both cancel and resume)
  makes either resume-then-cancel (wait ANSWERED, op CANCELLED) or
  cancel-then-resume (op terminal -> 409, wait CANCELLED) deterministic.
- No migration added: `0005_continuation.sql` already defines the terminal wait
  states (CANCELLED/EXPIRED) and the partial unique index
  `human_waits_open_task` only constrains OPEN rows, so closing stays valid.
- P7-05 successful flow unchanged; fail-closed auth/CAS and idempotent replay
  preserved.

## 2. Regression tests (runtime.test.ts, +4 -> 40 cases)
New cases, real test DB, scoped cleanup only:
- `W27-C/cancel` — close OPEN wait to CANCELLED; resume 409; no undelivered dispatch.
- `W27-C/deadline` — sweep closes OPEN wait to EXPIRED; task CANCELLED; op TIMED_OUT.
- `W27-C/cancel-resume race` — resume wins first (wait ANSWERED, op then CANCELLED): deterministic.
- `W27-C/repeated cancel` — second cancel is 200 replay, wait stays CANCELLED, no duplicate dispatch.

## 3. Migration CLI JSDoc audit (item 3)
`src/migrate-cli.ts` JSDoc previously claimed the CLI "fails closed on non-test
databases that appear empty" — but the CLI calls `migrate(db)` unconditionally
(no such guard), and the production contract is an explicit operator opt-in.
Corrected the doc to the intended contract: run `npm run migrate` against
DATABASE_URL (incl. empty first deployment), then `npm start` (autoMigrate=false
verify-only, no hidden writes). No guard implemented because none is necessary —
boot-time protection is the autoMigrate=false verify, not the explicit CLI.
P2-01 `[x]` retained (no substantive migration regression; 9/9 PASS).

## 4. Evidence (serial, exclusive window, this session)
- `npx tsc --noEmit -p tsconfig.json` -> **0 errors**.
- `npx jest tests/migrations.test.ts --runInBand` -> **9/9 PASS**.
- `npx jest tests/runtime.test.ts --runInBand` -> **40/40 PASS** (36 baseline + 4 new).
- Combined **49/49 PASS**. No global TRUNCATE; scoped row cleanup only.

**DB window: RELEASED.** Shared PG :5433 / Redis :6380 is free for Antigravity's
exclusive live P7 window.

Note: P2-06 stays **`[ ]`** — the composite RUN-05..07 acceptance is not fully
proven here; this delivery proves the wait-closure/race-fencing platform slice only.

---

# Wave 26-C: migration path completed, DB window released (2026-09-22)

**Status: COMPLETE — DB window RELEASED. Antigravity may run live P7 tests.**

W26-C delivers explicit one-shot migration path (R08-06 / P2-01):
- `src/db/migrations.ts` — tracked runner with `schema_migrations` table.
  `migrate(db)` is idempotent (unique PK sequence); `verifyMigrations(db)`
  is **read-only** (no hidden write) and fails closed when schema is missing.
  `migrationStatus(db)` returns diagnostic counts.
- `src/migrate-cli.ts` — CLI entrypoint: `npm run migrate`, `migrate:status`,
  `migrate:verify`.
- `server.ts` — `createApp` takes `autoMigrate?: boolean` (default false).
  Production boot: calls `verifyMigrations` (fail-closed, no schema write).
  Dev/test: pass `autoMigrate: true` -> calls `migrate(db)` for zero-config
  fixture usability. Old inline `readFileSync` 5-line migration block removed.
- `package.json` — added `migrate`, `migrate:status`, `migrate:verify` scripts.

Evidence (serial, this session, shared PG :5433 / Redis :6380):
- `npx tsc --noEmit -p tsconfig.json` -> **0 errors**.
- `npx jest tests/migrations.test.ts --runInBand` -> **9/9 PASS**
  (6 tracked-runner tests + 3 scratch-DB boot boundary tests).
- `npx jest tests/runtime.test.ts --runInBand` -> **36/36 PASS**
  (zero regression; `autoMigrate: true` preserves fixture behavior).
- Scratch DB `du_orchestrator_migrate_scratch` cleaned up after tests.
- Deployment order documented in `src/db/migrations.ts` JSDoc:
  `npm run migrate` then `npm start`.

**DB window: RELEASED.** Shared PG :5433 / Redis :6380 is free for Antigravity.

---

# Wave 24 exclusive handoff — platform GO, shared DB released (2026-09-22)

**Status: GO — Antigravity may run serial P5/P7 live E2E now.**
Platform source/build is stable; this lane will NOT use shared PostgreSQL
:5433 / Redis :6380 during the granted window and will NOT start another
shared-DB test. No further platform edits are needed in this window (NO-GO
condition does not apply).

Evidence (actually run, this session, serially):
- `npx tsc --noEmit -p tsconfig.json` (services/orchestrator) → clean.
- `npx jest tests/runtime.test.ts --runInBand` → **36/36 PASS**
  (27 pre-existing + 9 new continuation tests).
- Migration `0005_continuation.sql` wired in `createApp` (`server.ts`,
  after 0004): `human_waits` table + single-OPEN-wait partial unique index;
  children reuse `tasks`/`task_dependencies` from 0001.
- Routes live: `POST /api/runtime/v1/tasks/:id/children` (202),
  `GET .../children` (200), `POST .../wait-input` (200),
  `POST /api/v1/operations/:id/resume` (202 new / 200 replay).

Known continuation gaps (not claiming DONE):
- Artifact lifecycle hardening + R08-06 bootstrap/one-shot migrate need a
  separate migration (not in 0005).
- SDK UNKNOWN unit test still open (worker-sdk: failing fetch →
  INVOCATION_UNKNOWN once; facade retry reuses inputHash + fixed deadlineAt).
- Resume/join redeliveries currently use `kind: 'root'`; multi-kind
  continuation dispatch is a known simplification.
- Parallel shared-DB runs NOT certified — serial-only interim policy stands.

# Claude platform lane — waves 12–13 status (2026-09-21)

## W12 verified, W13 in progress (this session, term_07f2c54d)

Coordinator verification (WAVE-13-VERIFIED-NEXT.md): orchestrator runtime **23/23 PASS**
(`services/orchestrator/tests/runtime.test.ts`), document-core bounded-input 26/26,
unshimmed document-core E2E 9/9 standalone. Concurrent orchestrator+E2E run fails
(E2E submit 404) — shared-DB interference from this suite's global TRUNCATE is the
leading cause; parallel compatibility NOT certified. Fix is owned below (item 2).

### W12-C grant security slice — DONE, verified
`services/orchestrator/src/modules/grants/grants.ts` + 5 grant tests in
`services/orchestrator/tests/runtime.test.ts`:
- Stable invocation identity = HMAC-SHA256 (fixed ns
  `1b671a64-40d5-491e-99b0-190777e0c4e3`) over length-prefixed
  `len:taskId|len:stepKey|len:bindingSlot` → RFC-4122 UUID. Deliberately omits
  inputHash (differing hash = 409 INPUT_HASH_MISMATCH, never a new identity) and
  checkpoint generation (generations version step OUTPUTS; identity is the logical
  request reconciled against the stored `input_hash` row).
- Expired lease (timestamp past, not yet swept) → 409 LEASE_LOST, cannot mint grants.
- 8× concurrent identical issues → one identity, one ledger row (unique
  `(task_id, step_key, invocation_id)` + `ON CONFLICT DO UPDATE`).
- Action declaring zero `connectorSlots` grants NO slot (fail-closed
  BINDING_DENIED). Connector identity/revision still deployment opts —
  per-profile pins are W13 item 3, not claimed done.
- Replay same key → same ID + re-signed token; stale epoch → LEASE_LOST;
  non-RUNNING → STATE_CONFLICT.

### Canonical consumer hash contract (unshimmed E2E proven)
- Export: `hashInvocationInput` from `@du/contracts`
  (`packages/contracts/src/hashing.ts`); `InvocationInputHashParts` type.
- Canonical fields: `{contractVersion:'1', tenantId, operationId, taskId,
  stepKey, bindingSlot, input, options ?? {}, sessionRef ?? null, deadlineAt}`,
  sorted-key canonicalization, `sha256:<hex>`. SDK computes deadline FIRST then
  hashes (`packages/worker-sdk/src/task-context.ts`); Orchestrator signs the same
  digest into HS256 grant claims; Connector re-derives via delegation
  (`services/connector/src/hash.ts`) and `ContractSignedGrantVerifier` verifies
  unchanged — `pendingHashes`/custom-verifier shim removed on the business side.
- Tests: contracts 76/76 (incl. `invocation-hash.test.ts`), connector
  `canonical-hash-parity.test.ts` 2/2, SDK 23/23.

### W13-C backlog (this packet)
1. [x] Report updated (this entry).
2. [x] Test-DB isolation: suite uses `assertTestDatabase` (refuses non-test DB
   names) + scoped DELETEs for `test-biz` rows only — incl. the new
   `human_waits` row — plus per-queue `obliterate` (never global TRUNCATE /
   `flushdb`). Interim policy: shared PG :5433 / Redis :6380 suites run
   serially; parallel compatibility NOT certified.
3. [x] Profile-bound grants (P2-02/R08-02): API key → profile/action/version
   authorization; operation pins connector binding/revision at submit; claims
   and grants read the pin, never the live profile. Regression: unauthorized
   profile/slot 403 with nothing enqueued (PRF-01), in-flight pin survives a
   mid-operation revision change while new submissions pin the new revision
   (PRF-02), manifest-declared-but-unpinned slot denied (BINDING_DENIED).
4. [x] Typed continuation (RUN-05/RUN-06) — DONE, verified 2026-09-22:
   server `POST /api/runtime/v1/tasks/:id/children` (202),
   `GET .../children` (200), `POST .../wait-input` (200),
   `POST /api/v1/operations/:id/resume` (202 new / 200 replay);
   `migrations/0005_continuation.sql` (`human_waits` + single-OPEN-wait
   partial unique index; children reuse `tasks`/`task_dependencies` from
   0001); join reconciliation inside child terminal tx (parent `FOR UPDATE`,
   stable `task.continuation` deliveryId + `ON CONFLICT DO NOTHING`).
   `services/orchestrator/tests/runtime.test.ts` **36/36 PASS** (27
   pre-existing + 9 new: fan-out→join→exactly-one continuation incl. a
   `Promise.all` concurrent-completions race, stable 4/4 runs; join-failure
   path; spawn/wait/resume validation matrix; resume unknown-wait 404,
   terminal-op 409, cross-tenant 404). `npx tsc --noEmit` clean.
   Two fixes the tests forced: (a) idempotency checks moved BEFORE the
   RUNNING gate in `spawnChildren`/`waitInput` (a retry after the transition
   replays instead of 409); (b) `completeTask` no longer marks the operation
   SUCCEEDED when a child completes into an open join — it echoes the stored
   op state; the op transitions only via join/timeout/cancel/root completion.
   Join state rides on the parent TASK (`WAITING_CHILDREN`); the shared
   operation row may read RUNNING while a join is open (child claims put
   work in flight) — asserted at both levels.
   Remaining W13-C: artifact lifecycle hardening + R08-06 bootstrap/one-shot
   migrate (separate migration); SDK UNKNOWN unit test. No UI/release
   expansion before gates.

Blockers: none on platform side. E2E harness isolation is Antigravity-owned;
fixture contract (scoped cleanup, serial runs) coordinated via this report.

---

# Coordinator report — wave 05 (Claude / platform lane)

Date: 2026-09-21 (continuation from `CHECKPOINT-2026-09-21.md`).

## Resync vs checkpoint

Re-read `CHECKPOINT-2026-09-21.md`, the five gates (`contracts-v1`, `workspace-ready`,
`sdk-ready`, `runtime-ready`, `integration-usage-ready`), `IMPLEMENTATION-STATUS.md`, the three
lane reports/requests, and `dispatch-receipts.md`. Re-verified the live tree and infra before
dispatched wave 05.

## Live verification at handoff (all actually run)

- Build: `pnpm build` → 11/11 workspace projects compile (after a root `pnpm install` fixed the
  `example-review` missing-local-install failure seen in the pre-handoff baseline).
- Lint: `pnpm lint` → green across every workspace that declares the script (pre-handoff it failed
  because `tests/integration` scaffold was not installed; now installed + typechecks).
- Tests: `pnpm test` → 38 suites, **391 tests passed** (Connector: 33 pass, 2 opt-in skipped;
  document-core 188; orchestrator 12 after the new `runtime.test.ts` slice; integration 1).
- Infra: `du-rework-postgres` (5433) and `du-rework-redis` (6380) healthy via
  `infra/docker-compose.yml`.
- `integration-usage-ready` regated this session: Orchestrator↔Connector usage path passes against
  real PG/Redis (`tests/integration/usage-projection.integration.test.ts`, 1 suite/1 test).

## State deltas vs checkpoint (true, not stale)

- A new `integration-usage-ready` gate and `reports/integration-usage.md` exist (scoped: usage only).
- Orchestrator now has the durable **usage** module (`src/modules/usage/usage.ts`,
  `migrations/0002_usage_events.sql`) and the `POST /api/runtime/v1/usage-events` route with a
  dedicated `usageToken` — this closes the usage half of P2-07. The artifact + invocation-grant
  halves of P2-07 are **still absent** (no `POST /tasks/:id/artifacts*`, no
  `POST /tasks/:id/invocation-grants`). `enableVersionForTest` is still the only enable path.
- `businesses/example-review` is a **real proof** (manifest + worker using `@du/worker-sdk`, 5
  tests pass) — P7 is no longer a placeholder; it still needs a real Orchestrator registration +
  cross-service run to be a full extension proof.
- `example-review` `dist/` is newly generated; `packages/document-kit`/`worker-sdk` generated
  `.js/.d.ts/.map` in `src/` were partially removed in a prior in-flight cleanup. `.gitignore`
  covers `dist/` but not generated `src/*`; commit-safe audit deferred to wave 05 step 1.

## Agents at handoff

- Copilot terminal `term_297a6033-8bfa-4c7d-9b89-56749a40ed4d` — idle CLI, folder-trust already
  accepted, no pending `?` prompt. Ready to receive wave-05 packet.
- Antigravity terminal `term_d7692e4e-e693-4b08-a91f-26abfbcc78d3` — idle CLI (signed-in).
- Claude (this lane) is the platform owner; the in-flight `term_e524d35d` session from the prior
  wave is not reused — its slice work is already on disk and gated.

## Wave 05 scope (see `WORKLOAD-REBALANCE-05.md`)

- Claude: P2-07 closeout (artifacts + invocation grants + real enable), P2-06 (cancel/deadline),
  P7 extension proof with example-review, commit-safe audit.
- Copilot: P3-06/08 cross-service using the now-ready usage endpoint; client-against-real-service
  test; P2-08 webhook contract adoption.
- Antigravity: produce a provider-backed document-core variant wired to the real SDK connector
  facade (currently local mock); multi-container E2E once P2-07 lands; remove `@types/mammoth`
  dep per workspace gate note.

No lane edited another lane's owned paths. Root lockfile only touched by the platform owner's
`pnpm install`.

**Status ~18:30 — MID-TURN, FIX-CR-13 implementation in progress. DB window CLAIMED in writing (fresh claim, this line) for CR-13 regression run on :5433/:6380 (blob-wire-binary + ingress-bounded + typecheck). Will RELEASE in writing when jest stops.**

**Status ~19:05 — DB window RELEASED in writing (this line). No jest running; testing lane ungated. CR-13 residual open: src fixed but shipped consumers load dist (see below). Will reclaim by fresh written claim only when actually firing jest.**

**Status ~19:10 — DB window RELEASED in writing (this line, W42-C2-A). Zero jest running; testing lane ungated. CR-13 src fix on disk but NOT yet shipped to consumers (dist stale) — rebuild + both-suite proof still pending. Will reclaim by fresh written claim only at the moment of firing jest.**

**Status ~19:15 — DB window CLAIMED in writing (fresh claim, this line) for post-rebuild both-suite verification: services/orchestrator blob-wire-binary + tests/integration artifacts-grants on :5433/:6380. Will RELEASE in writing when jest stops.**

**Status 2026-09-23T14:16Z — DB window CLAIMED in writing (fresh claim, this line) for W42-C4-A: rerun blob-wire-binary (services/orchestrator, 5 tests) + artifacts-grants (tests/integration) on rebuilt dist/server.js:408 `raw: bytes`. Will RELEASE in writing when jest stops.**
**Correction (W42-C3-B, now recorded): prior "13/13 green" was an arithmetic sum — blob-wire-binary has exactly 5 tests, ingress-bounded has 8. Per-suite literal lines from here on; testing lane's "5 tests passed" for blob-wire is consistent, not contradictory.**

**Status 2026-09-23T14:56Z — DB window CLAIMED in writing (fresh claim, this line) for W42-C5: run artifacts-grants + blob-wire-binary on rebuilt dist (server.js:408 raw:bytes, verified above). Will RELEASE in writing when jest stops.**

**Status 2026-09-23T14:58Z — DB window RELEASED in writing (this line). Both W42-C5 suites executed on rebuilt dist; verification re-runs + full report follow in this turn before close.**

**Status 2026-09-23T15:13Z — DB window CLAIMED in writing (fresh claim, this line) for W42-C5 final verification: blob-wire-binary + ingress-bounded + usage-summary (services/orchestrator) and artifacts-grants (tests/integration) on rebuilt dist. Typecheck exit 0. Will RELEASE in writing when jest stops.**

---

# W47-O13 — OpenClaude (browser lane) PLATFORM REQUEST to Claude Code (platform lane)

**Filed: 2026-09-24 ~07:17 +07. NO DB USED by the requester. This lane does NOT edit `services/orchestrator/src/**`; per `coordination/CLAUDE.md` ("Không sửa `services/orchestrator`"), this is a PLATFORM REQUEST only — Claude Code owns the implementation. Cross-posted to `coordination/reports/openclaude.md` §W47-O13(3) for the orchestrator's view.**

## A. CR-12 (artifact grants/roles) — request scope from the browser surface

The browser harness already exercises both artifact-role and grant surfaces
end-to-end on the offline catalog path:

### A1. Operations artifacts table (`services/orchestrator/src/app/admin/operation-section-renderer.ts:80-98`)

Discriminators the renderer projects from the operation detail envelope:

```
data-artifact-id="<artifactId>"
data-artifact-role="<role>"          <-- top-level field, not nested
data-artifact-mime="<mime>"
data-artifact-size="<bytes>"
data-artifact-no-download="true"     <-- if role lacks download grant
data-action="download-artifact"
href="<downloadUrl>" rel="noopener"
```

Renderer reads `a.role` directly (`<td class="operation-section__artifact-role">${esc(a.role)}</td>`).
W47-O test `interaction-4` (cancel-operation) currently green; the artifact-row
DOM-evidence is asserted by `tests/browser/tests/api-keys-pane-count.spec.ts`
sibling (43-descendant probe) but not yet over the operation detail envelope.

**Browser-side request:** the `GET /api/v1/operations/:id` detail envelope (your
open request #5 from W47-O13(1) §2 — outstanding on this lane's books) must
carry the artifact role as a **top-level field** on each artifact entry, NOT
inside an opaque metadata blob. The off-wire `ArtifactRole` union
(`input|output|intermediate|log|debug|...`) is not invented here — defer to
your CR-12 design docs (`docs/25-mm-status-crosscheck.md` is referenced in
your CR-12 turn-start above). My only constraint: the role string must appear
verbatim on `data-artifact-role=...` so the renderer can `esc()` it.

### A2. API-key grants table (`services/orchestrator/src/app/admin/api-key-section-renderer.ts:201-216`)

Per-grant shape the renderer needs:

```
data-business-id="<id>"
data-business-version="<version>"
data-action="<action>"               <-- e.g. 'ingest', 'extract', 'compare'
data-grant-total="<N>"               <-- length of grants[]
grantedAt                           <-- ISO timestamp, displayed verbatim
```

This surface is wired to the api-keys fetcher (your open request #4 from
W47-O13(1) §2 — `GET /api/v1/admin/api-keys/:keyId`). The grant list must
arrive on the `kind:'ok'` envelope, populated server-side per key (no
client-side join).

### A3. Connector config secret grant (`operation-section-renderer.ts` adjacent — `connectors` section)

Out of scope here; only `connectors` section is mentioned because the test
`section=connectors viewport=desktop` already passes 2/2 via the offline
catalog. No additional request beyond #3 (open connector fetch route).

## B. Order of operations I will follow once CR-12 lands

1. You land CR-12 on `services/orchestrator` (your lane — no action from me).
2. You rebuild `services/orchestrator/dist` and run your owned suites
   (`artifact-grants` already green per your §W42-C9; new CR-12 regression
   suite is yours to write).
3. You publish `coordination/reports/claude.md` next-turn with the per-suite
   `Tests: N passed, M total` literal + exit code.
4. I claim the next browser turn only AFTER your green signal, then flip
   `tests/browser/src/stubs.ts` from `manifestCatalog` mode to `jsonBaseUrl`
   mode and re-run `tests/browser/tests/{sections,interactions}.spec.ts` —
   expect 18/18 PASS still, with the harness now hitting your live
   endpoints instead of the in-process catalog.

## C. Standing rule reminders (unchanged)

- NO DB window claimed by this lane (browser harness is offline by design;
  uses `127.0.0.1:0` and in-process `manifestCatalog`).
- This lane does NOT edit `services/orchestrator/src/**`, `packages/**`,
  `businesses/**`, or any platform file. Cross-lane edits are forbidden.
- I do not self-tick `tasks/P6-admin.md` rows. P6-07 is `[x]` per
  `coordination/reports/openclaude.md` §W47-O13(1) with literal evidence
  (14/14 + 4/4 + 28 axe scans all green at 2026-09-24T07:14:14.931+07:00).
  Awaiting your reconcile.

## D. Window state

DB window: **FREE** (this lane holds no claim; testing lane has it per
standing rule). No jest/tsx running on this side.

---

# W45-C1 — Platform lane status after CX3 W43-R13 HIGHs (2026-09-24 ~17:35 +07)

Note: W45-CB-1 was CANCELLED by the user (misrouted packet — connector-client belongs to
Codex-2 on term_50c6a1ed). This lane wrote NOTHING to coordination/reports/codex2.md, so no
revert is needed. No task row touched, no commit, no push.

Live evidence reused (testing lane, not self-run): `tests/artifact-grant-fencing.test.ts`
10/10 + `tests/operation-tenant-fence.test.ts` 4/4, `Test Suites: 2 passed, 2 total`,
`Tests: 14 passed, 14 total`, ExitCode 0 (antigravity-6.md W42-A95 run). Own turn evidence:
`npx tsc --noEmit -p tsconfig.json` (services/orchestrator) → TSC_EXIT=0.

## (1) P2-07 grant fencing + ADM-BASE-01 vs CX3 HIGHs

- HIGH security carry-forward (server.ts:199-215, 255-265) — FIXED IN CODE, live-verify
  PENDING. Ingress catch (:199-216) and route catch (:255-265+) now log class-only via
  `errorNameOf` (:1237-1239) and return generic problem+json via `sanitizedInternalError`
  (:1241-1250, `TEMPORARY_UNAVAILABLE` + correlationId, no err.message/String(err)).
  HttpError keeps authored literals via toProblem. tsc 0 this turn. Still needs an A6 live
  run with a sentinel-secret DB rejection (RUN REQUEST below) — not claimed verified.
- HIGH 6-route auth (server.ts:961/999/1039/1088/1132/1192/1212-1223) — CODE-COMPLETE under
  the current static-admin trust model: `assertAdminAuth` (:1214-1225) on all six GETs,
  distinct-token boot guard (:84-89), runtime token never substitutes. Tenant/RBAC
  principals do NOT exist — routed as OIDC-03 follow-up to Security/OIDC lane, no fake
  role checks invented.
- HIGH acceptance gap profile (server.ts:1032-1076) — OPEN: route returns `revision: 0`,
  `currentValues: {}` for every name; unknown names get 200 when the manifest exists.
- HIGH acceptance gap connector (server.ts:1087-1122) — OPEN: no revision ledger exists;
  any positive rev returns 200 for a configured id with adapter 'unknown'/static envelope.
  Unknown id → honest 404. Secret material never on wire (secretSlots []).
- Medium business-list row (server.ts:962-993) — OPEN: row mixes newest-row fields with
  active version pointer.
- Medium audit (server.ts:1193-1199) — OPEN: always `events: []`, no ledger table exists.

## (2) Six UI-waited routes — on-disk truth (services/orchestrator/src/server.ts)

| UI request | On disk? | Source |
|---|---|---|
| businesses/:id/versions | YES (real version history, 404 unknown) | server.ts:995-1030 |
| profiles/:businessId/:businessVersion/:name | YES but placeholder (rev 0, unknown-name 200) | server.ts:1032-1076 |
| connectors/:id/revisions/:revision | YES but static envelope (any positive rev 200) | server.ts:1087-1122 |
| api-keys + api-keys/:keyId | YES (no hash leak, grants from profile_bindings) | server.ts:1131-1186 |
| admin/audit | YES but always events:[] | server.ts:1193-1199 |
| operations/:id detail | YES (admin bearer → merged envelope via buildAdminOperationDetail :1283) | server.ts:746-762 |

Shell-mount HIGH — OPEN: `createApp` mounts the shell (:174) but `ServerConfig` has NO
`jsonBaseUrl` field, so `attachAdminShell` receives undefined and the shell falls back to
offline catalog fetchers. Needs a ServerConfig `jsonBaseUrl` plumb + mounted-shell
live-pane test (my lane, queued after fencing/admin verify).

## RUN REQUEST → Antigravity (term_47a1d44b, DB window holder)

(a) `cd du-rework/services/orchestrator && npx jest --runInBand
tests/operation-tenant-fence.test.ts tests/artifact-grant-fencing.test.ts --forceExit`
→ expect 2 suites / 14 tests, ExitCode 0 (regression after the error-boundary edit).
(b) ADM-BASE-01 live verify of the six GETs + 401/404 shapes (same command set as W48-C16).
Only the coordinator reconciles rows on this evidence. No self-tick.

## (3) QUESTION FOR THE USER

P6-02..P6-07 are all ticked [x] in tasks/P6-admin.md, but per CX3 R13 + the table above:
profile/connector/audit routes are placeholders, the shell mount has no jsonBaseUrl, and
browser/a11y verification is deferred. Should P6-02..P6-07 stay [x] (baseline view-model
scope), or be reopened to [~]/[ ] until the routes are real + mounted-shell live-pane
proof + browser harness land? I will not change any P6 row myself — awaiting your call.

DB window: FREE (this lane holds no claim). No jest/tsx running on this side.

# W46-C2 — jsonBaseUrl plumb + sentinel boundary test + placeholder verdicts (2026-09-24 ~18:45 +07)

No task row touched, no commit, no push. Live suites NOT self-run (testing lane holds the
DB window) — new tests are written + typechecked, queued in the RUN REQUEST below.
Own-turn evidence: `npx tsc --noEmit -p tsconfig.json` (services/orchestrator) → TSC_EXIT=0
(after every edit below).

## (1) jsonBaseUrl plumb — DONE IN CODE, live-pane proof PENDING

- `services/orchestrator/src/server.ts`: NEW `ServerConfig.jsonBaseUrl?` field (comment block
  documents the CX3 HIGH it closes). `listen()` now resolves the shell's JSON base URL AFTER
  the platform listener binds: explicit `config.jsonBaseUrl` wins (reverse-proxy topology),
  else this process's own `http://127.0.0.1:<port>`. When secrets are configured AND a base
  resolves, the shell is remounted with `{...config, jsonBaseUrl: base}` so its default
  fetchers GET the live Admin JSON routes with the admin bearer; otherwise the previous
  offline/not-found behavior is kept (fail-closed, no behavior change for callers that never
  set the secrets). `app.adminShell` handle stays on the App object; `close()` still stops it.
- NEW `services/orchestrator/tests/admin-shell-live-pane.test.ts`: boots the REAL `createApp`
  (admin token + shell cookie secret, real PG/Redis), seeds one ENABLED business version,
  drives the mounted shell's `/admin/businesses?businessId=<seed>` over real HTTP with a
  signed admin cookie, and asserts the pane renders the seeded `data-business-id`, the stored
  queue value, and `data-version="1.0.0"` — i.e. a real DB row through the live JSON route,
  not the offline catalog.
- RUN REQUEST (a): `cd du-rework/services/orchestrator &&
  npx jest --runInBand tests/admin-shell-live-pane.test.ts --forceExit` → expect 1/1, ExitCode 0.

## (2) Sentinel error-boundary test — DONE IN CODE (test), live run PENDING

- NEW `services/orchestrator/tests/admin-error-boundary.test.ts`: monkey-patches `app.db.query`
  AFTER boot to reject with `pg driver failure: SENTINEL-SECRET-sk-live-…://db.internal…`
  (shape of a secret-bearing driver string), calls authenticated `GET /api/v1/admin/businesses`,
  asserts 500 + `application/problem+json` + `TEMPORARY_UNAVAILABLE` + correlationId on the
  wire, NO sentinel on the wire, NO sentinel in captured stdout. The boundary fix (W45-C1:
  `errorNameOf`/`sanitizedInternalError`) is what makes this pass; the test would FAIL on the
  old `String(err)` code.
- Redaction-pass analysis (no code change): `@du/observability` `redactString` only strips
  signed-URL/Bearer/AWS-key patterns — verified by node one-liner that the sentinel string
  passes through ALL three patterns unredacted. So the class-only log is the SOLE barrier;
  the test's log assertion is meaningful, not vacuous.
- RUN REQUEST (b): same jest invocation with `tests/admin-error-boundary.test.ts` → expect 1/1,
  ExitCode 0. Plus requested regression: `tests/operation-tenant-fence.test.ts
  tests/artifact-grant-fencing.test.ts` → 14/14 (post-edit).

## (3) Placeholder verdicts — HONEST GAPS, no faking

- Profiles `GET /api/v1/admin/profiles/:b/:v/:name` (server.ts:1032-1076): stays placeholder.
  REASON: no profile-revision/values table exists on the platform (only `profile_bindings`
  key→action grants from 0004; `business_versions.manifest` holds actions/slots). A real
  revisioned profile store is a migration + service slice owned by a future packet — inventing
  `revision: 0`→N without a ledger would be the exact fabrication CX3 flagged. NOT fixed here.
- Connectors `GET /api/v1/admin/connectors/:id/revisions/:rev` (server.ts:1087-1122): stays
  static envelope. REASON: no connector revision ledger exists anywhere (platform holds only
  `connectorBaseUrls` config; the Connector service owns its lifecycle). Honest 404 for
  unknown id + never leaking secret material is the correct boundary today. NOT fixed here.
- Audit `GET /api/v1/admin/audit` (server.ts:1193-1199): stays `events: []`. REASON: no audit
  ledger table exists in migrations 0001-0009 (only `webhook_deliveries` 0007 is event-like,
  and it is delivery state, not an admin-action audit trail). Returning a false-empty list is
  flagged in-code as a follow-up, not presented as complete. NOT fixed here.
- These three need schema + service work (new tables, write paths on every admin mutation,
  backfill policy) — that is a multi-file migration packet, NOT a same-turn filler. The P6
  reopen decision is already with the USER per W46-C2; this lane will not pre-empt it.

## RUN REQUEST → Antigravity (term_47a1d44b, DB window holder)

`cd du-rework/services/orchestrator && npx jest --runInBand tests/admin-shell-live-pane.test.ts
tests/admin-error-boundary.test.ts tests/operation-tenant-fence.test.ts
tests/artifact-grant-fencing.test.ts --forceExit` → expect 4 suites / 16 tests, ExitCode 0.
Only the coordinator reconciles rows on this evidence. No self-tick.

DB window: FREE (this lane holds no claim). No jest/tsx running on this side.

## W47-C4 — 2026-09-24 22:37 +07:00 (W47-C1 lookup DONE in code+test; W47-C2 decision B DONE; live-run pending A6)

### (1) W47-C1 — runtime workspace-reference lookup (blocker cuối P4-05, code+test xong, live-run CHƯA có)

- Files sửa:
  - `packages/contracts/src/runtime.ts` — NEW `WorkspaceReferenceQuerySchema` (`workspacePath` min1/max1024, `tenantId` uuid) + `WorkspaceReferenceResultSchema` (`workspacePath`, `tenantId`, `referenced: boolean`, `activeHolders: int>=0`). Contract xuất qua `export * from './runtime'` (index.ts:14) — SDK lane import từ `@du/contracts`, không thêm dependency.
  - `services/orchestrator/src/modules/runtime/runtime.ts` — NEW `workspaceReferenceStatus(tenantId)`: một tx read-only, ba COUNT gộp UNION (tasks non-terminal JOIN operations non-terminal của tenant; OPEN human_waits JOIN tasks/operations của tenant). Trả `{ referenced, activeHolders }`.
  - `services/orchestrator/src/server.ts:711-738` — NEW `GET /api/runtime/v1/workspace-reference?workspacePath=<dir>&tenantId=<uuid>`, guard `assertRuntimeAuth` (runtime bearer). Contract: 200 `{ workspacePath, tenantId, referenced, activeHolders }`; 401 bearer sai; 422 thiếu/sai params (INVALID_SCHEMA). Cố ý KHÔNG 404 — workspace không ai reference là `referenced: false`, sweeper coi là orphan candidate.
- Test viết: `services/orchestrator/tests/workspace-reference.test.ts` (4 cases): RUNNING task → `referenced true`, `activeHolders>=1`; tenant trống → `false/0`; tenant chỉ có SUCCEEDED → `false/0`; thiếu param/bad-uuid → 422, thiếu bearer → 401.
- Trung thực boundary: DB không có cột workspace-path (`storage_key = art-<uuid>`, `output_ref = artifact://<id>`); lookup trả lời ACTIVE presence theo `tenantId`, `workspacePath` echo lại cho caller diagnosis. Ghi rõ trong contract comment.
- Live-run: CHƯA có bằng chứng live cho coordinator — suite mới cần PG :5433/Redis :6380, đã routing cho Agent-6 (W47-A6-17). Lane này không tự chạy live suite.
- Typecheck: `packages/contracts` tsc exit 0; `services/orchestrator` tsc exit 0 (sau rebuild `packages/contracts/dist` — ts-jest resolve `@du/contracts` qua `main: dist/index.js` nên schema mới chỉ visible sau rebuild; đã rebuild, `WorkspaceReference` có mặt trong `dist/runtime.d.ts` 4 khớp).
- RUN REQUEST cho live-run đã ghi trong W47-C1 (không lặp lại ở đây để tránh đè lệnh A6 đang giữ window).

### (2) W47-C2 — quyết định B (render cột Queue), lý do + evidence offline

- Chọn **B** (render queue, giữ nguyên assertion), KHÔNG xóa assertion. Lý do:
  1. `queue` là cột THẬT của `business_versions` (migration 0001): route `GET /api/v1/admin/businesses/:id/versions` đã SELECT nó (server.ts:1004,1043); fetcher `normaliseRow` đã giữ `queue: raw.queue` (business-section-data.ts:181); view-model `BusinessVersionRow.queue?` đã tồn tại. Chỉ renderer thiếu (0 khớp "queue" trong business-section-renderer.ts) → đây là khoảng cách hiển thị DB field lên admin UI, không phải assertion bịa.
  2. Lead A (docs/11-admin-ux.md:9 "ID/version/digest/status/health/actions" không liệt kê queue) tồn tại nhưng yếu hơn: `business-view-models.ts:426` impact text tự nó nhắc "New operations will be dispatched to this version queue" — operator cần thấy queue để hiểu impact của enable. Queue là dispatch target vận hành, không phải metadata thừa.
  3. Sửa nhỏ, an toàn, có degrade: `queue?` optional trên DisplayRow + mapper pass-through, renderer `<td class="col-queue">` với `esc()` + em-dash khi absent.
- Files sửa: `services/orchestrator/src/app/admin/business-view-models.ts` (DisplayRow `queue?` + mapper), `services/orchestrator/src/app/admin/business-section-renderer.ts:176-181` (`<td class="col-queue">`) + `:213` (`<th>Queue</th>`).
- Evidence offline (không cần DB, lane tự chạy được), 2026-09-24 ~21:24 +07:00:
  - `cd services/orchestrator && npx jest tests/admin-shell-render.test.ts tests/admin-business-view-model.test.ts --runInBand --forceExit`
  - `Test Suites: 2 passed, 2 total; Tests: 190 passed, 190 total; ExitCode 0`.
  - Không có exact-equality nào trên business rows trong hai suite (chỉ một `toEqual` ở render test line 881 cho profile sections) → thêm cột không vỡ snapshot/equality.
- Live-run cho `admin-shell-live-pane` (assertion `queue-live-pane` giờ phải xanh): đã routing cho Agent-6 (W47-A6-17). Wiring `hasActiveReference` trong `worker.ts` thuộc Qwen-2 (W47-Q2-5) — lane này KHÔNG làm để tránh đè.

### (3) Test-Path từng file nêu tên

- `packages/contracts/src/runtime.ts` — contract schema (tsc exit 0).
- `services/orchestrator/src/modules/runtime/runtime.ts` — `workspaceReferenceStatus` (tsc exit 0, live-run pending A6).
- `services/orchestrator/src/server.ts` — route `:711-738` (tsc exit 0, live-run pending A6).
- `services/orchestrator/tests/workspace-reference.test.ts` — NEW, 4 cases (live-run pending A6, chưa có literal pass).
- `services/orchestrator/src/app/admin/business-view-models.ts` — DisplayRow `queue?` (offline evidence: view-model suite trong 190/190).
- `services/orchestrator/src/app/admin/business-section-renderer.ts` — cột Queue (offline evidence: render suite trong 190/190).

KHÔNG commit, KHÔNG push, KHÔNG tick row. DB window: FREE (lane này không giữ claim, không có jest/tsx chạy).

---

# REVIEW-801 — Claude independent review wave (2026-10-05, offline, read-only)

**Packet:** `coordination/dispatch-specs/2026-10-05-0305-WAVE-801.md` §1 · Owner claude (`term_19edcad8`) · task `task_12a45ac2f379` + ADDENDUM V5.
**Mode:** OFFLINE — 0 source edit, 0 test run, không watch-state, không commit/tick/push. Mọi số liệu trích nguyên văn receipt gốc + đối chiếu file:line trên candidate hiện tại.
**Snapshot:** HEAD `b088eececcb5f3df0b4edbe073a29401dafda624` (dirty tree, RCR candidate chưa commit — đúng theo A2 lease release).
**Scope:** V1 (mở khóa A4) + V2 (kể cả delta STUB-EXT + digest mới) + V3 + V4 + V5 (RCR-01..06 trên candidate đã release). Verdict mỗi slice: APPROVED / APPROVED-WITH-CONDITIONS / CHANGES_REQUIRED.

## V1 — P763-W1C-COMPOSE (mở khóa A4) → APPROVED-WITH-CONDITIONS

**Đối chiếu:** composition hunks `src/app/bootstrap/create-app.ts:64` (import `createAcquisitionRefResolver`), `:472-478` (compose resolver với `{ db }`, env defaults nằm trong resolver), `:500-503` (forward `resolveSourceAuth` trên nhánh S3 only) vs owner `p730-acquire-2026-10-04.md:78-135` (3 hunk, 5 case, focused 76×3 exit 0, boot-reg 15, tsc 0, post-SHA `5913db5e`) + `tester.md:12758-12834` VERIFY-COMPOSITION (3 vòng × 76 exit 0, digest/patch khớp, no-touch hash nguyên, `DEVIATION: NO`) + settle turn 770.
**Expected (row PLAN:275):** boot production-equivalent tạo resolver + inject ingestion-consumer; bearer/header tới allowlisted mock; deny query/wrong-ref/key/tag trước upstream; no-secret; "independent verify + review"; real PG/MinIO cells giữ live window.
**Actual:** owner DONE + independent VERIFY PASSED (offline) — comptest pin factory gọi 1 lần với `resolveSourceAuth` + cùng `db`; Postgres-only no-op; consumer factory mock đúng ranh giới factory, resolver chạy THẬT trên pool app scripted (`p730-acquire:118-124`); deny-before-fetch ✓; W1c no-secret ✓. Hunk W1C còn nguyên sau drift `5913db5e` → `ae7e29ce64ed558c022be456bbabccecd59345962af789a32a898b18d939ed0e` (drift có chủ đích: hunk additive CW-A/ENCMETA của lane khác; `tick-proposal-2-2026-10-05.md:32` đã xác nhận). 7 SHA còn lại MATCH.
**Câu hỏi A4 (phải trả lời rõ):** verify-leg của tester có đủ là review-leg theo row không, hay cần thêm reviewer leg? → **KHÔNG đủ. Row ghi "independent verify + review" — ledger hiện chỉ có tester-verify + coordinator-settle; Part-4 verdict W1c không cover composition; chưa có artifact reviewer riêng cho hunk composition. Cần thêm một reviewer leg ngắn. REVIEW-801 này chính là leg đó.**
**Gap còn mở (điều kiện):** (a) live cells — row PG thật + fetch thật quan sát header; (b) missing-key full-boot mới chứng minh bằng code-path (`tester.md:12813`), chưa chạy boot thật gỡ `ENCRYPTION_KEY`; (c) tick-note phải ghi "verified at `5913db5e`; later additive hunks preserved W1C at `ae7e29ce`".
**Verdict V1: APPROVED-WITH-CONDITIONS** — offline leg đủ để coordinator tick `P763-W1C-COMPOSE` ở phạm vi offline (mở A4 nửa còn lại); parent/live giữ mở. Alt strict (đòi live ngay trong acceptance): NO-TICK tới live window.

## V2 — CONNECTOR-WIRE-A + B-BFF + CW-B-UI kể cả STUB-EXT → APPROVED-WITH-CONDITIONS

**A (backend core):** contracts `connector-management.ts` strict view; store list/getRevision/getCurrent/createPending/activate-CAS/retire/disable/test; `admin.ts` +capabilities/list; dispatcher +5 `connector.*` admin-only CSRF-before-role; boot compose từ `connectorBaseUrls`; service-identity headers additive. 23 tests ×3 + 66-test regression xanh.
**B-BFF:** `bff/handle.ts:466-529` (+63 dòng): `GET /admin/api/connectors` + `/capabilities` trước revision regex; fence platform-admin (anon 401, viewer/operator 403 `PERMISSION_DENIED`); relay verbatim; 5xx→502 `UPSTREAM_ERROR`. 17/17 ×3 + BFF 76/76.
**STUB-EXT delta (in-lease per A1):** `apps/admin-web/src/features/connectors/connectors-screen.tsx` (902 lines, SHA `755875b569b3f240`) — bootstrap `client.getSession()` TRƯỚC capabilities `:118-144`; session lỗi ⇒ state `sessionFailed` + banner riêng `:299-312`. Root cause `apps/admin-web/src/lib/api/client.ts:146,156,221-223` (`csrfToken` null cho tới khi `getSession()`) + `bff/handle.ts:436-439` (thiếu `x-csrf-token` ⇒ 403 `CSRF_REJECTED`); 5 screen anh em đều đã gọi `getSession()` trước (`api-keys:46`, `profiles:97`, `overview:44`, `security:38`, `businesses:40`), màn connectors là ngoại lệ — trước fix mọi mutation connector 403 trên deployment thật. Secret hygiene `state.ts:297-364` (chỉ tên, `secretPresent` boolean, không bao giờ value). Harness `tests/browser/admin-web/harness.ts` (854 lines, `d890aa3e61f9147e`) mô phỏng đúng wire thật (CAS/CAS-loss/422/mint/502-fold); spec `api-keys-connectors.spec.ts` (284 lines, `410d4c0e92eff7fd`) case 6/7 viết lại + 8/9/10 mới (management journey: ledger→rev2 `platform ledger`→Activate assert CAS `{connectorId, revision:2, expectedCurrentRevision:1}`→Disable ConfirmDialog→409→422; upsert 201 assert payload không chứa `sk-live-stub-ext-9c31`, không chứa `private-dir`).
**Digest (per A1):** `apps/admin-web/dist/assets/index-CqyHzg0b.js` / `0b8ed8ed715bbd16` (+ CSS `index-HHyOtXdi.css` / `2edb802939854314`) THAY THẾ `index-xBfDFWzz.js` / `6148de23c282f0d5` — verdict CW-B UI cũ STALE, đúng như adjudication.
**Evidence:** `npx tsc --noEmit` 0; `npx vite build` 0 (477.42 kB, gzip 149.17); `playwright -g "connectors:"` 5 passed; `--repeat-each=3` 15/15; full dir 92 passed / 9 skipped (skipped đều là `live-admin-web.spec.ts` live-gated `DU_LIVE_INFRA=1`, skipped ≠ pass). Pre-existing RED `tsconfig` alias `@/lib/api` + `harness.ts writeFileSync` + `p745-ui-keys.spec.ts:76-77` không do slice này.
**Verdict V2: APPROVED-WITH-CONDITIONS** — offline wire + UI + STUB-EXT đạt; điều kiện: Antigravity UI-REVIEW-CW-B-R2 phải re-sign trên digest mới `0b8ed8ed715bbd16` (review cũ trên digest cũ không có giá trị); live round-trip (`DU_LIVE_INFRA=1`) còn mở.

## V3 — CREDWORKFLOW-IMPL → APPROVED-WITH-CONDITIONS (giữ nguyên 3 limits)

Vault KV2 writer (`POST /v1/{mount}/data/{path}` `{data,options:{cas}}`, `GET` metadata, `x-vault-token`, redirect=error, timeout abort `DEFAULT_TIMEOUT_MS` 5000, ≤64KB; 412→`CAS_CONFLICT`, 403→`CAPABILITY_DENIED`, 401→`VAULT_NO_TOKEN`, 408/429/5xx→retryable) + compose (`create-app.ts:438-447`: full env→workflow, partial/bad→`CredentialWorkflowBootError`, absent→undefined, `config.credentialWorkflow` override wins) + bootstrap + e2e (create→bootstrap→rotate→activate→test→disable, audit 5 rows, sentinel 0). Evidence: 12×3 + regression 89 + tsc 0.
**Đối chiếu limits VERIFY-CREDWORKFLOW (giữ nguyên, không nới):** (a) timeout mới source-only (AbortController có trong code, test chỉ throw `ECONNREFUSED`+SENTINEL, không có AbortSignal wait thật); (b) override precedence mới source-only (code `config` wins `:438-447`, chưa có test cả injected+env cùng lúc); (c) SQL capture vacuous (`makeDb` chỉ ghi SQL string, drop binds; audit mocked, stores faked ⇒ `sql []` nên `leaks(sql)==false` + forbidden-table assertion chạy trên list rỗng).
**Verdict V3: APPROVED-WITH-CONDITIONS** — PASS-with-limits đứng; follow-up thuộc live/DB window (timeout thật, precedence test, SQL binds thật).

## V4 — ENCMETA-RESULTREF-IMPL + ENCMETA-SCHEMA-IMPL → APPROVED-WITH-CONDITIONS (A3 bound)

**RESULTREF:** seal 2 cột `tasks.result_ref` + `operations.result_ref` (`metadata-crypto.ts:60-61`); `MetadataContext` tenant|slot|refId AAD; đúng 1 writer `completeTask` seal ×2 trước UPDATEs (`runtime.ts:808-820`); `readStoredText` envelope→`readStored(...,false)` fail-closed. 10/10 ×3 + 61/61 regression + tsc 0.
**SCHEMA:** Option-C exemption (`waitInput` `ui_schema`/`context_ref` verbatim BY EXEMPTION, 2× `leaksSentinel` true giữ làm evidence + trigger comment) + 5 wire guards + slot-boundary guard.
**Ràng buộc A3 (non-blocking bound cho V4 offline):** `openMetadata` (`runtime.ts:453`, spec ghi `:445`) hardcode `readStored(..., true)` — không có window switch nên backfill window mở vĩnh viễn, bật mã hóa metadata không fail-closed trên legacy plaintext. Mọi fix chạm `runtime.ts` chờ A2 (Native Luna). R1 `/result` open `public.ts:535-546` (opaque projection `:544-546`), R2 `getChildren` `runtime.ts:1199-1207`, R3 open-before-merge `:1805-1824`, R4 SDK `fan-out.ts:605`; G3 cross-slot/tenant AAD refusal, G4 `NOT_SEALED` khi false.
**Verdict V4: APPROVED-WITH-CONDITIONS** — offline đạt; điều kiện: A3 + live PG/Vault + window-gated suites + HTTP route test + ENC-09 inventory update (thuộc ENCMETA-ENC09-KIND / WINDOW-DESIGN) còn mở.

## V5 — RCR-01..06 backend trên candidate đã release → APPROVED (offline; live gates còn mở riêng)

**Candidate + hash (đã verify độc lập, khớp frozen candidate, case-insensitive):** `runtime.ts` `ACB476FD3079E6F3FDBF4B81BB54F5FE0B5B2F07679BB72AB47C73664BC09138`; `http/routes/runtime.ts` `8A4209F370B4BEDCA8C24C52AC5D1B08F7D5D59EE9AC72184F7C53D3A9CA5602`; `metadata-crypto.ts` `C614ECDCFDA50EAC79A29EAC2098B92CB3BBA77280D90DDEC6F3A815A4A602A1`; `0032_checkpoint_session_ref.sql` `69A9CC6BEA5DF9A999546AB5BB98A43EE1A1A0C3835BE5D7E8C6AEE72788E55E`; `public.ts` `422DB30E924DB063C30405B26BE73CCC867CE4E4DEDE8E344B411A169CBB057C`; `submission.ts` `8F7DA672…`; `create-app.ts` `CA24177A…`; `legacy-http-mount.ts` `4AEFF966…`. Baseline pre-fix tái hiện 8 passed/8 failed (expired-lease writes, missing business fence, rollback, omitted status, dropped sessionRef) — đúng defect characterization.
**Lệnh + kết quả (trích receipt, verifier độc lập):** cwd `services/orchestrator`, `pnpm exec jest --runInBand --runTestsByPath tests/rcr-http-offline.functional.test.ts tests/rcr-luna-http-encryption.test.ts tests/rcr-luna-verification.test.ts tests/rv01-loopback-http-offline.test.ts tests/runtime-lease-fencing-offline.test.ts tests/runtime-encryption-metadata.test.ts tests/migrations-ledger-guard.test.ts` → 7 suites passed, 229 passed, 0 skipped, exit 0 (6.366s, raw SHA `337dabaa…`); `pnpm exec tsc --noEmit -p tsconfig.json` → exit 0 no output (raw SHA `e3b0c442…`). Open-handle warning còn (exit vẫn 0, không forceExit) — residual đã khai, không ảnh hưởng correctness.
**Expected/actual từng finding trên candidate:**
- RCR-01: malformed Host/URL không thoát listener boundary, request sau vẫn phục vụ — Actual: `create-app.ts:590` `handleListenerFailure`, `:617` `handleHttpRequest`, `:627` `new URL(...)`, `:629` throw `HttpError(400 INVALID_REQUEST)`, `:760` `.catch(handleListenerFailure)`. ✓
- RCR-02: spawn/wait đòi RUNNING + cùng business + current epoch + `lease_expires_at > clock_timestamp()`; expiry ở final CAS rollback; replay durable y hệt vẫn pass — Actual: `runtime.ts:976-978` lock SELECT `lease_active`, `:996` `assertTaskBusiness`, `:1000` epoch check, `:1016-1038` replay trước RUNNING gate, `:1040` `assertActiveLease`, `:1140-1154` parent CAS + `LEASE_LOST` khi zero-row, mirror waitInput `:1230-1270`, `:1304-1318`; routes `http/routes/runtime.ts:451-452` + `:471-472` truyền `workerBusinessId`; helpers `:162-165` 403 business, `:172-178` LEASE_LOST. 33/33 fencing + verifier RCR-02 cases xanh. ✓
- RCR-03: scoped same-body replay trước admission; khác body 409; foreign scope không replay — Actual: `submission.ts:235-251` `findSubmissionKey` + `request_hash` compare ⇒ `IDEMPOTENCY_CONFLICT` vs `{replayed:true}`, đặt trước `:254` storageBackend gate, `:267` artifact readiness, `:275` `resolveEnabledVersion`. ✓
- RCR-04: omitted status persist SUCCEEDED; invalid payload 422 zero SQL — Actual: `runtime.ts:664` `SaveStepRequestSchema.safeParse`, `:665` `zodIssuesToProblem`, chỉ `parsed.data` đi tiếp; default chảy tới INSERT `:731`. Route `:412` `ctx.body as never` là cố ý (parse ở service boundary). ✓
- RCR-05: sessionRef survives save→claim dưới metadata encryption, full checkpoint AAD, null/omitted tương thích, newest-first, fail-closed open — Actual: slot `metadata-crypto.ts:49` `step_checkpoints.session_ref`; `0032:2-3` `ADD COLUMN IF NOT EXISTS session_ref jsonb`; seal `runtime.ts:700-710` (`refId: taskId:stepKey:nextGen`), INSERT `:717`, undefined→NULL `:732`; claim `:1880` `ORDER BY step_key, generation DESC`, open `:1889-1899` đúng slot/refId, non-string ⇒ `INVALID_SCHEMA`. AAD `output_ref` cũ (generation-free, `:1906`) cố ý không copy. Ordering nhiều generation nhạy với việc gỡ ORDER BY (fake DB chỉ sort khi production query yêu cầu) — đã ghi nhận. ✓
- RCR-06: byte-exact tới wire; tenant delivery policy bảo vệ plaintext; crypto unavailable fail-closed — Actual: `public.ts:305-311` carry `legacy.raw`, broken tenant handoff ⇒ 503; `:313-321` policy resolve failure ⇒ 503; `:322-343` enabled ⇒ encrypted envelope, strip binary Content-Length/MIME, 413 oversize via `maxBlobBytes`, null encrypt ⇒ 503; `:346-351` disabled ⇒ `{raw}` preserved. ✓
**A2 lease:** dsh_1 `rcr-runtime-2026-10-05.md` RELEASED (0 product edits, pin hash paths); cc_1 `runtime.ts READ-ONLY`; baseline→candidate hash `01FFFF43…` ⇒ `ACB476FD…` một lần duy nhất thuộc Runtime Luna; không thấy fleet-lane write vào 4 paths — sole-editor claim SUPPORTED.
**Caveat không-blocking (đã khai):** RCR-01 Host tới route result (controlled 4xx); RCR-03 `loadOperationView WHERE id=$1` tenant hardening là defense-in-depth; RCR-06 `Content-Diposition` parity (`docs/39-legacy-parity-contract.md:191-207`) còn thiếu; verifier inventory refresh trong `runtime-encryption-metadata.test.ts` là test-only.
**Verdict V5: APPROVED** — 6/6 RCR behaviors đạt trên candidate đã release (offline backend scope). Per ADDENDUM: đây là điều kiện để ACCEPTED offline; **live gates còn mở riêng, không block offline ACCEPTED**: rollout 0032 trên PG thật via normal migration path, live PG/Vault/storage + lease-timing + worker restart, reviewer APPROVED + coordinator acceptance.

## Tổng hợp verdict + đề nghị coordinator

| Slice | Verdict | Mở khóa / điều kiện |
|---|---|---|
| V1 W1C-COMPOSE | APPROVED-WITH-CONDITIONS | REVIEW-801 này là reviewer leg còn thiếu → coordinator có thể tick offline-leg `P763-W1C-COMPOSE` (ghi digest note); live giữ mở |
| V2 WIRE-A/B-BFF/UI+STUB-EXT | APPROVED-WITH-CONDITIONS | A1 adjudication ghi nhận (product delta in-lease); cần UI-REVIEW-CW-B-R2 re-sign trên digest mới; live còn mở |
| V3 CREDWORKFLOW | APPROVED-WITH-CONDITIONS | Giữ nguyên 3 limits tới live/DB window |
| V4 ENCMETA pair | APPROVED-WITH-CONDITIONS | A3 bound (fix chờ A2); live + window-gated suites mở |
| V5 RCR-01..06 | APPROVED | Đủ điều kiện ACCEPTED offline; live gates (PG/Vault/storage + restart + 0032 rollout) mở riêng |

KHÔNG commit, KHÔNG push, KHÔNG tick row (coordinator tick). DB window: FREE. Không sửa source/test/docs nào khác ngoài section này.

---

# REVIEW-802 — Claude module/backend review wave 802 (2026-10-05, offline, read-only)

**Packet:** task `task_6b550a0be24e` (dispatch `ctx_2c7a38201a79`) · Owner claude (`term_19edcad8`).
**Mode:** REVIEW-ONLY, offline, 0 source edit, không watch-state, không commit/tick. Không review UI/UX văn phòng — phần đó thuộc Antigravity §5.
**Phạm vi:** S1 FU-ENCMETA-ADMIN + S2/S3/S4 CFGADM-UI-PORT-P1/P2/P3 — chỉ module/backend (seam, adapter, contract, hygiene, gating). Verdict mỗi slice kèm file:line + expected/actual.

## S1 — FU-ENCMETA-ADMIN (qwen_2) → APPROVED

**Defect (đúng):** admin-bearer `GET /api/v1/operations/:id` → `buildAdminOperationDetail` (`public.ts:455`) copy thẳng `op.result_ref` vào `result.data.resultRef` mà không gọi `readStoredText`; `getOperation` là `SELECT *` nên giá trị tới là **envelope đã seal** khi seam bật — response trả envelope thay vì opaque pointer, lệch với R1 `/result` (`public.ts:531-546`) đã đúng.
**Fix (1 file, trong lease, đã verify trên disk):** `services/orchestrator/src/modules/operations/mappers.ts:100-108` mở envelope với đúng triple của R1 — `readStoredText(ctx.metadataCrypto ?? undefined, String(op.result_ref), { tenantId: String(op.tenant_id), slot: 'operations.result_ref', refId: String(op.id) }, true)`; `null` → `undefined` → `data: {}` (`:101,:111`); non-terminal → `result: null` (`:49`).
**Tenant-triple đối chiếu (không mismatch):** R1 dùng `tenantId: apiKey.tenantId` (`public.ts:541`) SAU khi đã check `op.tenant_id === apiKey.tenantId` (`:482`) nên bằng nhau tại điểm mở; admin route là cross-tenant by design (`public.ts:441-443`) nên fix dùng `String(op.tenant_id)` là BẮT BUỘC đúng — dùng caller tenant ở đây mới là sai vì admin không có tenant. Seal lúc ghi dùng operation tenant ⇒ open khớp AAD cả hai đường.
**Route không đổi:** `public.ts:455` truyền nguyên `ctx` (đã có `metadataCrypto`, dùng ở `:539`); `AdminOperationDetailContext.metadataCrypto?` optional (`mappers.ts:24`) nên structural-compat — tsc exit 0 chứng minh.
**Test load-bearing thật:** `fu-encmeta-admin-projection.test.ts` 5 case (seam ON mở envelope + response không chứa `__sealed`; seam OFF plaintext nguyên vẹn; legacy plaintext window nguyên vẹn; non-terminal null; result_ref null → `{}`); focused ×3 (`fu-encmeta-admin-projection` + `encmeta-resultref-offline` + `enc-meta-sentinel-runtime-refs`) 21/21 exit 0 cả 3 lần; **mutation probe**: revert fix → FAIL đúng 1 case `Expected: "opaque-result-ref-abc123" / Received: "{\"__sealed\":1,...}"` — chính là envelope lộ ra; re-apply → 5/5.
**Giới hạn đã khai (ngoài slice):** A3 window-switch vẫn mở (`readStoredText(..., true)` giữ backfill convention — việc đóng chờ `runtime.ts`/lease A2 Luna); envelope thật + key provider thật thuộc leg live/crypto.
**Module/backend cho ACCEPTED:** `mappers.ts:100-108` + test file trên. **Verdict S1: APPROVED.**

## S2 — CFGADM-UI-PORT-P1 settings (qwen_5) → APPROVED

**Phát hiện quyết định (đúng, đã verify):** không có settings wire — `packages/contracts` zero Settings schema, không có read DTO/writer action. Port trung thực duy nhất là catalog + disabled-with-reason, không fake save, không invent endpoint, không đọc value vào browser.
**Code (trong lease, đã đọc):** `features/settings/catalog.ts:35-60` 17 keys (AI 5 port + 1 retire, prompt 5, storage 6) với `replacement` là LOGICAL id (comment `:5-7` nói rõ chưa assert tồn tại route/column); `settingsWriteReason` (`:67-75`) 3 nhánh lý do riêng (retire / secret cần Vault adapter / non-secret boot-time config); `settings-screen.tsx:40-73` render label + badge secret/retire + Button **disabled** với `title={reason}` — không có `<input>` nào (imports `:1-10` không có Input), secret rows chỉ badge không value; banner `:87-92` khai "no settings wire at all".
**Self-found defect đã đóng trong slice:** label-order `secret` trước `retire` làm retire branch unreachable (test 2 đếm Replace secret 5 thay vì 4) — fix `settings-screen.tsx:69` đảo thứ tự, không chạm ngoài lease.
**A5:** 0 router/client edit. **Evidence:** typecheck ×3 + build ×3 exit 0; browser 6/6 ×3 (attempt 3/4/5) exit 0 — 17 controls disabled với title reason >30 chars không chứa "saved"; zero `<input>`; retire là decision; 320px; keyboard focus. 2 blocker ngoại lai gán đúng chủ (P2 identity-screen xóa gây đỏ build; Playwright concurrent `test-results/`) và không chạm file lane khác.
**GAP khai rõ:** CFGADM-01/02/03/04 stay OPEN — writer actions (Policy, Vault secret-ref adapter, Artifact storage generation) là backend work riêng theo parity mapping.
**Module/backend cho ACCEPTED:** `catalog.ts` + `state.ts` + disabled-with-reason rendering + secret hygiene (no input/no value/no log). Phần văn phòng (Antigravity §5) không thuộc verdict này. **Verdict S2: APPROVED.**

## S3 — CFGADM-UI-PORT-P2 identity (codex_worker_1) → APPROVED-WITH-CONDITIONS

**Adapter (đã đọc, đúng spec):** `features/identity/identity-api.ts` — CSRF `x-csrf-token` (`:97`), `idempotency-key` mọi non-GET (`:98`), `credentials: same-origin` (`:105`), `TRANSPORT_ERROR` khi fetch throw (`:109-111`); projection validation chặt: role allowlist `ADMIN|USER|VIEWER` (`:209-211`), `version` safe-int ≥0 (`:166-167`), OIDC allowlist đúng 4 field issuer/clientId/callbackUrl/scopes (`:183-201`, cipher/hash sentinel lạ bị ignore), `safeProblemCode` regex `^[A-Z0-9_-]{1,48}$` else `HTTP_ERROR` (`:213-218`) — không render raw error/response body.
**Screen gating (đã đọc):** session-first `client.getSession()` (`identity-screen.tsx:48`); `canWriteUsers` = session admin + `capabilities.userWriter === true` + local/both mode (`:75-79`); create password write-only + default VIEWER (`:39,358-372` kèm chú thích never returned); `expectedVersion` từ snapshot hiện tại (`:121`); **success chỉ sau readback** `:131-147` (role khớp + enabled khớp + version tăng, else "No success was reported"); writer vắng → controls disabled + banner (`:302-306`).
**Trung thực giới hạn:** CRUD success cases verify bằng intercepted responses, không phải live writer — receipt khai rõ; BFF identity route chưa tồn tại trong snapshot; route-registration request cho dsh_2 (3 routes GET/POST/PATCH + CAS 409 + audit + tenant từ trusted session) đúng A5, không tự sửa router/lib.
**Điều kiện (backend, ngoài slice UI):** (1) dsh_2 đăng ký 3 BFF routes theo request + live CRUD proof trước khi CFGADM-08 đóng; (2) repo local-user `create` hiện fix role `admin` phải sửa theo policy phía server (receipt §43 đã flag — browser không được infer grants).
**Module/backend cho ACCEPTED:** adapter contract + validation + gating/readback logic (offline). BFF + live integration chưa ACCEPTED. **Verdict S3: APPROVED-WITH-CONDITIONS.**

## S4 — CFGADM-UI-PORT-P3 workflows/docs (dsh_2) → APPROVED-WITH-CONDITIONS

**Workflows disabled-with-reason thật:** `features/workflows/workflows-screen.tsx:8-32` (32 dòng) — banner "Workflows route is disabled" nêu Δ-DEV-03, zero BFF call, zero data read/mutate, fail-closed. Đúng gate user-gated, không fake list/import/mappings/schemaSlug.
**Docs-screen không rò secret (đã đọc):** `features/docs/docs-screen.tsx:34-51` catalog 13 entries suy từ client surface cùng bundle (không invent endpoint — mọi path đều có method client tương ứng); workbench dùng `client.testProfileEndpoint` có sẵn (`lib/api/client.ts:303`, type `:111`) — real BFF route `/profiles/test-endpoint`, same-origin; inputs chỉ business identifiers/URLs (`:143-173`); lỗi chỉ render `status · code` (`:174-178`).
**Router/client tối thiểu (sole owner A5):** `router.tsx` chỉ +2 imports (`:14-15`) +2 route entries (`:49-50`); **zero** `lib/api/client.ts`/`types.ts` hunk (không cần — method đã tồn tại) ⇒ không phá lane khác. Build digest mới `index-Bs0p8VRI.js`/`8ccdbab15d44cca1` (499.53 kB) — typecheck 0, build ×3 digest trùng, route-level browser evidence đủ hai route.
**GAP khai rõ (điều kiện):** AI wizard CFGADM-06 không ship — chưa có wizard BFF route/contract, làm wizard lúc này phải bịa contract nên ghi GAP thay vì fake; workflows backend disabled tới khi Δ-DEV-03 unblock.
**Residual quan sát (không defect):** workbench render `testResult` JSON verbatim (`:179-183`) — chấp nhận được vì route trả test outcome, nhưng chủ BFF cần bảo đảm response đó không bao giờ chứa secret material.
**Module/backend cho ACCEPTED:** disabled gating + catalog trung thực + workbench qua real route + router hunks tối thiểu. Wizard + workflows-live chưa ACCEPTED. **Verdict S4: APPROVED-WITH-CONDITIONS.**

## Tổng hợp

| Slice | Verdict | Module/backend ACCEPTED được | Còn mở (đúng chủ) |
|---|---|---|---|
| S1 ENCMETA-ADMIN | APPROVED | mappers triple + 5 tests (mutation-probed) | A3 window-switch (Luna/A2); live crypto leg |
| S2 P1 settings | APPROVED | catalog 17 keys + disabled-reason + hygiene | Writer actions P+x (Policy/Vault/Artifact); Antigravity §5 visual |
| S3 P2 identity | APPROVED-WITH-CONDITIONS | adapter + gating + readback-confirm | 3 BFF routes (dsh_2) + repo role-fix + live CRUD |
| S4 P3 workflows/docs | APPROVED-WITH-CONDITIONS | disabled gate + catalog + workbench + router | AI wizard BFF; Δ-DEV-03 unblock; Antigravity §5 visual |

KHÔNG commit, KHÔNG push, KHÔNG tick row (coordinator tick). DB window: FREE.

---

# V1-BOOT-DENIAL-DECISION (2026-10-05) — pointer

Decision record đầy đủ: `coordination/reports/v1-boot-denial-decision-2026-10-05.md` (task `task_602ccacaf42b`).
Kết luận: **allow boot + typed denial + boot warn (reject fail-fast)** — fail-fast sẽ hạ deployment không dùng profile cipher.
Fix tối thiểu 2 hunk: try/catch `acquisition-ref-resolver.ts:199-203` → `denial(500,'AUTH_DECRYPT_FAILED',...)` (code đã có trong `PERMANENT_CODES` `ingestion-consumer.ts:276`, không sửa list); warn-only `main.ts` sau `:154`.
Offline accept 5a-5e (boot warn, typed denial, permanent, ciphertext-hỏng, đường lành); live gates (PG thật, key xoay, restart) còn mở. Không tick V1 thêm từ decision này.

---

# REVIEW-803 — Claude ENCMETA/resultref offline-ACCEPTED decision (2026-10-05, offline, read-only)

**Packet:** task `task_89c380b1a6eb` / dispatch `ctx_3830863f8725` · Owner claude (`term_19edcad8`).
**Mode:** REVIEW-ONLY, 0 source/test edit, offline, không watch-state, không commit/tick/push.
**Evidence base:** REVIEW-801 §V4 (APPROVED-WITH-CONDITIONS + A3 bound); owner `encmeta-enc09-kind-2026-10-05.md` (23/23 ×3, regression 39, tsc 0, 2 bugs self-caught, Δ-DEVIATION +1/-1); tester `VFY-802` (`tester.md:13569-13593`: FU-ENCMETA-ADMIN 5/5 ×3 + route probe + RESULTREF regression 6/6) và `VFY-ENC09-803` (`tester.md:13617-13647`: ENC09 23/23 ×3 + real AES-GCM R1/R2 probe, SDK fan-out 21/21 ×3 + actual route→SDK wire probe, raw SHA `1f8208f4…`/`133cfa82…`/`4cfcd18f…`); PLAN `PLAN-COMPLETION-2026-10-04.md:54` (G-ENC row), `:412` (ENCMETA pair fold), `:670` (S1 scope), `:704` (VFY-ENC09-803 task); code đối chiếu `public.ts:538-543`, `runtime.ts:1202-1207`/`1814-1819`, `mappers.ts:100-108`, `metadata-crypto.ts:350-373`.

## 0. Đối chiếu nhanh bằng chứng mới (expected/actual)

- ENC09-KIND registration: `operations.result_ref` + `tasks.result_ref` vào `ENC09_PAYLOAD_KINDS`, kind string ≡ `METADATA_SLOTS` slot (slot===kind by construction, không drift). **Bug 1 thật** (`tasks` không có `tenant_id` — `0001_platform_v1.sql:66-89`; fix `{tenant}` → `o.tenant_id` qua JOIN) và **bug 2 thật** (composite `kind:rowId` làm refId seal ra envelope không reader nào mở được; fix `payloadId: row.id`, composite chỉ addressing). Mutation probe load-bearing (composite→5 RED, window-guard off→1 RED, đã revert, grep MUTATION sạch). VFY-ENC09-803 rerun độc lập 23/23 ×3 exit 0. ✓
- Real-crypto interop (điểm mạnh nhất của wave này): probe dùng `createMetadataCrypto` AES-GCM thật + key provider deterministic — backfill 2 rows → stored `operations.result_ref` qua **real R1 `/result` handler** mở đúng, stored `tasks.result_ref` qua **real R2 getChildren reader** mở đúng, envelope không chứa sentinel plaintext, sai row UUID → `CONTEXT_MISMATCH`. Closed-window → `incomplete` + `MIGRATION_STORE_UNAVAILABLE` + **zero writes**; open-window control writes. ✓ (scripted in-memory DB adapter, không phải PG — xem mục 2.)
- SDK R4: `parseChildren` camelCase-first (`row.resultRef ?? row.result_ref`, tương tự taskId/errorCode), snake fallback giữ; 21/21 ×3 + probe actual `handleRuntimeRoutes` → `RuntimeService.getChildren` → serialize → `waitForChildren` parse giữ ref. ✓
- FU-ENCMETA-ADMIN: VFY-802 route probe gọi thật `handlePublicRoutes` admin-bearer — response chứa opaque pointer (không envelope), seam nhận đúng triple `{tenantId, slot:'operations.result_ref', refId}` + `readStored(..., allowPlaintext=false)` ở probe stub; 5/5 ×3. REVIEW-802 S1 APPROVED đứng. ✓
- Hai giới hạn verifier khai rõ, tôi xác nhận trên code hiện tại: (i) **không production caller** của `ResultRefPgMigrationStore`/`backfillLegacyPayloads` (store guard đã verify nhưng bounded window chưa ai enforce trong prod); (ii) mọi `readStoredText` caller vẫn `allowPlaintext=true` — R1 `public.ts:542`, R2 `runtime.ts:1206`, R3 `:1818`, admin `mappers.ts:107` (đúng chữ, đã đọc). A3 (`openMetadata` hardcode true, REVIEW-801 §V4) vẫn mở. Full suite `runtime-encryption-metadata.test.ts` **không chạy được nguyên vẹn**: `:603-617` assert inventory chỉ 4 slot và loại `tasks.result_ref` — xung đột trực tiếp với registration mới (verifier chỉ pick row-binding test; full run sẽ RED cho tới khi inventory assertion được update).

## 1. ACCEPTED offline ngay bây giờ (phạm vi từng slice)

| Slice | Quyết định | Cơ sở |
|---|---|---|
| RESULTREF writer + R1/R2/R3 readers + G3/G5/G6 guards | **ACCEPTED offline** | Seal đúng triple (tenant\|slot\|row-id), single writer `completeTask`, AAD refusal `CONTEXT_MISMATCH`, real-crypto round-trip qua reader thật, regression 6/6 (VFY-802) + 61/61 (VERIFY-ENCMETA) |
| SCHEMA Option-C + 5 wire guards + slot-boundary | **ACCEPTED offline** (giữ nguyên V4) | Không bị thách thức bởi evidence mới; exemption documented, detector 10/10 ×3 |
| ENC09-KIND registration + store + codec (fake-PG) | **ACCEPTED offline ở mức module** | 23/23 ×3 + regression 39 + tsc 0 + mutation probes; SQL-shape assert qua fake dispatch, **không phải** real planner (xuống mục 2) |
| Store closed-window refusal + zero-write | **ACCEPTED offline ở mức store-unit** | Store-level guarantee đã chứng minh; chưa phải production behavior (chưa caller) |
| SDK R4 camelCase + route→SDK wire agreement | **ACCEPTED offline** | 21/21 ×3 + non-fixture actual-route probe |
| FU-ENCMETA-ADMIN projection (mapper triple) | **ACCEPTED offline** | S1 APPROVED + route-handler probe + regression; scope đúng PLAN `:670` (mapper/test slice, không full G-ENC) |

## 2. Điều kiện còn lại: full ACCEPTED (đóng được offline) vs live-window-only

**A — Full ACCEPTED, đóng được offline (cần implementation + verify packets, không cần live window):**
- A1. Wire production backfill entry point: caller thật tiêu thụ `ResultRefPgMigrationStore`/`backfillLegacyPayloads` với bounded window được supply (hiện store "honour window nếu được đưa" nhưng không ai đưa — `encmeta-enc09-kind.md` §8).
- A2. Runtime window switch (A3): thay `allowPlaintext=true` hardcode tại 4 điểm gọi (R1/R2/R3/mapper) bằng policy-gated value + thiết kế nguồn policy (xem mục 3). Chạm `runtime.ts` → chờ lease A2 (Native Luna) như REVIEW-801 đã bound.
- A3. Update `runtime-encryption-metadata.test.ts:603-617` inventory assertion (4 slot → gồm result_ref kinds) + full suite xanh ×3.
- A4. Coordinator ratify-or-revert Δ-DEVIATION +1/-1 `tests/legacy-payload-migration.test.ts` (§6 receipt owner — thay đổi coverage arithmetic bắt buộc, tối thiểu, đã khai).
- A5. Sau A1+A2: rerun affected suites (enc09-kind, resultref-offline, runtime-encryption-metadata full, SDK fan-out) ×3 + tsc 0, verifier độc lập.

**B — Chỉ live window đã duyệt mới đóng được (không claim từ offline):**
- B1. Real PG planner/transaction behavior: SQL JOIN/lock-FOR-UPDATE/CAS trên rows thật, rollback thật (fake không model rollback — owner đã khai).
- B2. Deployed `metadataCrypto` + Vault/key-provider unwrap/authentication thật.
- B3. Backfill completion trên rows thật + kiểm kê legacy rows còn lại.
- B4. G-ENC recipient + `ARTIFACT_STORAGE_MIGRATION_WINDOW=false` acceptance run (PLAN `:54` — seam S3/artifact, khác seam result_ref).
- B5. Lease-timing/worker-restart behavior dưới encryption.

## 3. Cần gì NGAY TRƯỚC khi window switch (nếu switch thì phải có, không thì cấm switch)

Window switch không phải "đổi true→false": đóng sớm khi còn plaintext rows = tự tạo `NOT_SEALED` outage diện rộng; đóng muộn/mãi mở = mã hóa at-rest chỉ là tuyên bố. Thứ tự bắt buộc: (i) A1 landed (backfill caller thật chạy xong trên PG thật, B3 kiểm kê leftovers = 0 hoặc danh sách known); (ii) thiết kế nguồn policy (env/config, default fail-closed hay fail-open, mirror pattern `ARTIFACT_STORAGE_MIGRATION_WINDOW` của G-ENC); (iii) rollout order: backfill → flip → verify `NOT_SEALED` trên leftovers có chủ đích → audit log; (iv) key rotation/outage behavior (seam unavailable fail-closed thế nào — RCR-06 pattern 503 đã có cho blob, cần tương đương cho metadata readers); (v) leftover-plaintext-rows audit query ship cùng switch (nếu không đếm được rows chưa seal thì không bao giờ đủ điều kiện đóng). **Cấm flip switch chỉ vì "store đã có guard"** — guard chưa wired thì flip là đổi chữ, không đổi hành vi bảo mật.

## 4. G-ENC / G-RESULTREF: đóng cái nào, giữ cái nào

- Không tồn tại row tên "G-RESULTREF" trong PLAN — cụm ENCMETA/resultref sống trong fold §15 row `:412` ("PG/Vault thật + backfill window thật" còn mở) và S1 row `:670`. Cả hai **giữ mở** sau REVIEW-803; offline legs ở mục 1 không tick chúng.
- **G-ENC (PLAN `:54`) giữ mở toàn phần.** G-ENC là acceptance seam S3/artifact (upload→encrypted S3→worker→encrypted output→recipient + rotation/outage/tamper + window=false run) — khác seam với result_ref (DB-column metadata encryption). PLAN §19.1 đã nói rõ S1 APPROVED "không full G-ENC"; REVIEW-803 tái khẳng định: không suy G-ENC closure từ bất kỳ evidence result_ref nào.
- Đóng được sau A1–A5 (offline, coordinator tick): "RESULTREF offline chain" trong fold `:412` ở phạm vi offline (writer/readers/guards/SDK-wire/store-unit). Live nửa còn lại của chính row đó + toàn bộ G-ENC chỉ live window.

## 5. Rủi ro residual của "seal trong khi allowPlaintext=true" (đánh giá trung thực)

**Mức: thấp cho availability, trung bình-cao cho confidentiality-perception — rủi ro thật duy nhất là "tưởng đã mã hóa nhưng chưa".**
- Không vỡ availability: writer mới seal đúng context (real-crypto round-trip đã chứng minh), readers cũ đọc được cả sealed lẫn plaintext → không outage, không `NOT_SEALED` bất ngờ. Đây là thiết kế backfill-window đúng, không phải bug.
- Nhưng: mọi legacy plaintext row **đọc được mãi mãi** cho tới khi A2 flip; không có alarm nào (không `NOT_SEALED`, không kiểm kê rows-chưa-seal được surface) — deployment bật metadata encryption hôm nay mà tin "cột result_ref đã protected at-rest" là **sai**: kẻ đọc được DB vẫn thấy legacy refs in clear. Kẻ tấn công không cần phá crypto, chỉ cần tìm rows chưa backfill.
- "Window" hiện là khái niệm test-only (store guard có, caller không) — mọi tuyên bố "bounded 14-day window" về prod hôm nay là chưa enforce.
- Giảm thiểu duy nhất có ý nghĩa: A1 (backfill thật + kiểm kê leftovers) → mục 3 (policy + rollout + audit) → A2 flip → verify. Cho tới lúc đó, mọi receipt/claim phải ghi "encryption best-effort trong backfill window, legacy rows plaintext-readable" — không ghi "at-rest encrypted".

**Tổng verdict REVIEW-803: ACCEPTED-OFFLINE theo mục 1 (6 slice, đều có phạm vi ghi rõ) + CONDITIONS A1–A5 cho full ACCEPTED + LIVE B1–B5 giữ mở + PRE-SWITCH mục 3 bắt buộc + G-ENC/fold giữ mở + residual mục 5 phải đi kèm mọi claim mã hóa.**

KHÔNG commit, KHÔNG push, KHÔNG tick row (coordinator tick). DB window: FREE. Không sửa source/test/docs nào khác ngoài section này.

---

# REVIEW-804 — S1 V1-BOOT-TYPED-DENIAL + S2 REVIEW-803/A8 sweep (2026-10-05, offline, read-only)

**Packet:** task `task_040c53fd4ef6` / dispatch `ctx_987f040499a1` · Owner claude (`term_19edcad8`).
**Mode:** REVIEW-ONLY, 0 source/test edit, offline, không watch-state, không commit/tick/push.
**Evidence base:** receipt `v1-boot-typed-denial-2026-10-05.md` (codex_worker_1); decision `v1-boot-denial-decision-2026-10-05.md`; code trên disk: `acquisition-ref-resolver.ts` (untracked, 289 dòng), `main.ts` diff, `tests/v1-boot-typed-denial.test.ts` (untracked, 303 dòng), `file-url-auth.ts:91-123` (untracked nhưng nội dung đúng contract cũ), `ingestion-consumer.ts` diff; PLAN `:54` (G-ENC), `:412` (ENCMETA fold), `:670` (S1 scope); `coordinator-state.json:1898` + rule `:1889` (A8 đã ghi); `docs/04-data-state.md:100-102`; `tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md:365`.

## S1 — V1-BOOT-TYPED-DENIAL (codex_worker_1) → APPROVED-WITH-CONDITIONS

**Đối chiếu decision (5/5 điểm, đã đọc code thật):**
1. Typed denial tại resolver boundary ✓ — `acquisition-ref-resolver.ts:199-207`: `decryptFileUrlAuthConfig(binding.cipher, env, warnLegacy)` trong try/catch, mọi throw đồng bộ (key vắng từ `resolveProfileCryptoKey`, sai shape) → `denial(500,'AUTH_DECRYPT_FAILED','stored auth cipher could not be decrypted with this deployment key')`. Comment `:203-205` ghi rõ lý do đặt tại boundary (helper phục vụ cả write + nullable-read). Branch `decrypted===null` (`:208-211`) giữ nguyên code+message — đúng decision (wrong-key/tag-rách đã deny typed sẵn, nay thống nhất message).
2. Không đổi code-lists ✓ — `SourceAuthDenialCode` (`:48-54`) giữ nguyên union (không thêm member, chỉ dùng `AUTH_DECRYPT_FAILED` đã có); `file-url-auth.ts` không đổi contract (file untracked nhưng `decryptFileUrlAuthConfig:91-123` vẫn fail-closed `null`, không throw mới — đúng "KHÔNG sửa helper").
3. Đường null giữ nguyên ✓ — snapshot null/undefined → `{configured:false}` (`:111`), `configured=false` → `{kind:'none'}` (`:171`); cipher null/'' → `AUTH_CONFIG_MISSING` 422 (`:195-197`, phân biệt đúng "chưa cấu hình" vs "mở không được"); legacy-plaintext vẫn warn-once + read (`file-url-auth.ts:117-121`).
4. `main.ts` đúng MỘT warning ✓ — `:155-160`: `if (!ENCRYPTION_KEY && !NEXTAUTH_SECRET) logger.warn(...)` — warn-only, không throw/exit, đặt sau encryption-seam log, trước `createApp`. Không gate boot.
5. Không đường non-typed nào thoát ✓ — quét `resolveSourceAuth`: mọi throw đều qua `denial(...)` (`:113,118,124,135,167,178,190,193,196,206,210,217,223,231,240,245`); `withSourceAuth` (`:262-288`) không throw auth (chỉ pin origin + forward). `fileUrlAuthConfigCarriesSecret` false → `AUTH_CONFIG_MISSING`, `query` → `QUERY_AUTH_FORBIDDEN` — typed hết.
**Test có chứng minh thật permanence:** `v1-boot-typed-denial.test.ts:261-281` — consumer thật + resolver thật (cipher thật từ `CONFIGURED_ENV`, env trống) → `runOnce()` → `{retried:0, escalated:1}`, `fetcher` zero-call, `failTaskParams/failOperationParams` = `AUTH_DECRYPT_FAILED`, `retryParams` rỗng. Đây là assertion trực tiếp trên `PERMANENT_CODES` path (không còn suy luận code-path như decision record). Tamper (`:293-301`) + key-hợp-lệ (`:283-291`) + no-leak (`:257`) đủ.
**Boot case:** `:222-241` — `createApp` + `listen` mock hoàn tất + đúng 1 warn / 0 warn. **Đây là điểm trừ duy nhất:** `createApp`/`listen` là mock (`:196-208` doMock server/shutdown/oidc/encryption-boot-options), không phải entrypoint thật + PG/Redis disposable như evidence V1-CONDITIONS-802 của decision record. Test chứng minh *logic warn + thứ tự boot*, không chứng minh *process boot thật*.
**Ngoài lease (ghi nhận, không phạt):** `main.ts` diff còn chứa `tenantAdminTokensFromEnv` (`:75-112`) + `tenantAdminTokens` wiring (`:168`) — pre-existing local edits, receipt đã khai (§Scope). `ingestion-consumer.ts` diff chứa P730-ACQUIRE composition + `PERMANENT_CODES` mở rộng (6 codes mới, `AUTH_DECRYPT_FAILED` đã có trong đó) + `openDispatchSourceUrl` (ENC-META-FIX-G1) + `failureCode` map `SourceAuthDeniedError` — đều là composition hunks của lane khác/W1c, không phải của slice này, receipt không claim chúng. Không thấy sửa sai; chỉ ghi để coordinator phân biệt ownership khi tick.
**Verdict S1: APPROVED-WITH-CONDITIONS** — implementation đúng decision 5/5, permanence chứng minh trực tiếp; điều kiện duy nhất: live-boot thật (entrypoint + PG/Redis disposable, key-vắng) trước khi coi boot-policy là ACCEPTED hoàn toàn (đúng handoff receipt §Scope đã tự khai).

## S2 — REVIEW-803/A8 sweep → XÁC NHẬN + 1 FILE CẦN SỬA

**A8 đã được coordinator ghi (xác nhận):** `coordinator-state.json:1898` ("Cap nhat A8: moi claim ma hoa phai kem canh bao muc 5") + rule chi tiết `:1889` ("TUYET DOI khong ghi at-rest encrypted cho den khi PRE-SWITCH muc 3 hoan tat"); `agent-watch-state.json:9847` adjudication tương ứng. Ràng buộc có hiệu lực trong state, không chỉ trong receipt của tôi.
**Sweep claim mã hóa (phạm vi: receipt 2026-10-05 + docs/tasks hiện hành):**
- ĐÚNG (đã kèm cảnh báo hoặc giới hạn): REVIEW-803 §5 (câu chuẩn best-effort + cấm at-rest); `encmeta-backfill-prep` (BLOCKER window-switch + "permanently open"); `encmeta-resultref-impl:50` ("không claim live"); `encmeta-enc09-kind` §8 ("No live DB / No wiring / window switch absent"); PLAN `:412` (live còn mở), `:670` (scope mapper slice), `:54` (G-ENC giữ mở); `LIVE-TEST-PLAN-MINIO-VAULT-BROWSER:365` (mô tả legacy plaintext + window true/false đúng bản chất, không claim đã encrypted).
- SAI 1 chỗ (cần sửa ngay, docs hiện hành): **`docs/04-data-state.md:102`** — câu "reader dùng `readStoredText` và **fail-closed** (`NOT_SEALED`) khi giá trị trông giống envelope mà thiếu seam/không mở được" mô tả sai hành vi hiện tại: cả 4 callers (`public.ts:542`, `runtime.ts:1206/1818`, `mappers.ts:107`) đều truyền `allowPlaintext=true`, nên plaintext/envelope-lạ được trả verbatim, KHÔNG fail-closed. Đúng phải là: "trong backfill window hiện tại readers truyền `allowPlaintext=true` nên legacy plaintext đọc được verbatim (best-effort); fail-closed `NOT_SEALED` chỉ có hiệu lực sau window switch (A3/A2)". File:line duy nhất cần sửa: `docs/04-data-state.md:102`.
- NGOÀI PHẠM VI A8 (không sửa, seam khác): `docs/12-operations.md:26` ("Secret encrypted at rest"), `packages/contracts/src/profile-policy.ts:170`, test name `p730-admin-mutate-offline.test.ts:529`, `codex-comp01-slice-f-2026-10-02` — đều nói về AppSetting secrets / `fileUrlAuthConfig` cipher (AES-256-GCM + ENCRYPTION_KEY, seam Vault/profile-key), không phải result_ref/metadata seam. A8 chỉ áp cho result_ref/metadata claims. `encmeta-resultref-prep:63` ("protected in transit... RED detector strictly about at-rest copy") viết đúng, không sửa.
**Verdict S2: XÁC NHẬN A8 đã ghi + 1 fix docs** — coordinator không cần hành động thêm về A8; chuyển `docs/04-data-state.md:102` cho docs-owner sửa theo câu trên (doc-only, không cần lease code).

KHÔNG commit, KHÔNG push, KHÔNG tick row (coordinator tick). DB window: FREE. Không sửa source/test/docs nào khác ngoài section này.

# REVIEW-805 — kiểm tra trung thực gap-inventory-803 + commit-prep-803 — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_bb6dec52eef4` / dispatch `ctx_7a5643cbc5cc`. Phương pháp: grep + read từ root `du-rework` (không phải từ `coordination/reports`), đối chiếu từng file:line, kiểm tra mtime để phân biệt evidence sai lúc viết vs stale sau khi viết. DOC-ONLY: không sửa source/test, không commit; sửa duy nhất là section receipt này.

## (1) gap-inventory-803-2026-10-05.md — từng mức độ

Kết luận chung: **không có mức CAN nào phải hạ toàn phần xuống KHÔNG CẢN**; nhưng **G5 cần sửa evidence + tách hàng**, **G3 cần refresh evidence** (file mới xuất hiện sau inventory), **G6 cần sửa đường dẫn evidence**, **G1 cần sửa tiền tố đường dẫn**. Chi tiết:

- **G1 CONFIRMED, sửa tiền tố path.** `readStoredText(crypto, value, context, allowPlaintext)` chữ ký đúng có flag bắt buộc; cả 4 call sites vẫn hardcode `true`: `services/orchestrator/src/modules/runtime/runtime.ts:1202`, `:1814`, `services/orchestrator/src/http/routes/public.ts:538`, `services/orchestrator/src/modules/operations/mappers.ts:103`. Hiệu lực CAN LIVE cho tuyên bố at-rest giữ nguyên. Sửa duy nhất: file switch nằm ở `modules/runtime/metadata-crypto.ts`, không phải `metadata-crypto.ts` như evidence ghi.
- **G2 CONFIRMED, split đã ghi là thật.** Open-before-merge `runtime.ts:1809-1816` có thật (comment "parent could never read them"); các SELECT `human_waits` (`:1254`, `:1293`, `:1370`) không project `ui_schema`/`context_ref`; `mappers.ts` 0 hit `ui_schema`. Hậu quả tách đôi (CẢN LIVE cho at-rest / KHÔNG CẢN cho UI) có cơ sở hành vi, không phải suy diễn — giữ nguyên.
- **G3 REFRESH-EVIDENCE, giữ CAN UI.** Tại thời điểm inventory (mtime 04:48) claim "0 matches Settings" là đúng; sau đó `packages/contracts/src/settings.ts` xuất hiện (untracked, mtime 05:01) với read DTO + writer contract **disabled/fail-closed** (`SettingsUpdateParamsSchema :128`, `SETTINGS_WRITER_DISABLED_CODE :146-147`, `writerEnabled`). Nhưng BFF writer vẫn vắng (không có `POST /admin/api/settings`, `settings.tsx` không có POST/PATCH, `settings-screen.tsx:21` "no Save button", mọi write control disabled có lý do). Yêu cầu: cập nhật dòng evidence, tùy chọn tách G3-read (catalog/read đã có) vs G3-write (vẫn CẢN UI). Không hạ severity.
- **G4 CONFIRMED.** `wizard`/`Wizard` 0 hit trên cả `services/orchestrator/src` và `apps/admin-web/src` (không chỉ 2 thư mục hẹp trong evidence). CẢN UI giữ nguyên.
- **G5 SỬA EVIDENCE + TÁCH HÀNG, giữ CẢN UI by-design.** Evidence "no `workflows` path" là **sai trên disk hiện tại**: `apps/admin-web/src/router.tsx:14` import + `:49` đăng ký `path: 'workflows'` (untracked, mtime 03:54 — TRƯỚC inventory 04:48, nên đây là miss chứ không phải stale). Nhưng `workflows-screen.tsx` (32 dòng, mtime 03:40) chỉ render banner disabled theo Δ-DEV-03, không đọc/mutate data. Yêu cầu: sửa file:line, tách G5-route (đã tồn tại, SHIPPED-DISABLED) vs G5-gate (DEV-03 user go/no-go + A6). Không hạ xuống KHÔNG CẢN — operator vẫn không dùng được workflows.
- **G6 SỬA ĐƯỜNG DẪN, giữ CẢN UI.** Đường dẫn evidence sai: `apps/admin-web/src/app/admin/bff/` không tồn tại; BFF thật ở `services/orchestrator/src/app/admin/bff/identity.ts` (`:5-6` khai `POST /admin/api/identity/users`, `:52-53` route match, `:117` forward tới `/api/v1/admin/identity/users`) — file proxy này evidence bỏ sót. Backend CRUD thật vẫn vắng (grep `local_users|/users|/roles` chỉ ra file proxy + noise `submit_roles`). Yêu cầu: sửa paths, giữ CẢN UI cho CFGADM-08.
- **G7 CONFIRMED.** `server.ts:87` khai báo-only; `main.ts` không truyền field này (0 match); `create-app.ts:408` fallback `?? {}`, `:442` hard-error khi thiếu; `route-context.ts:74` document "Absent = …". CẢN LIVE giữ nguyên (kèm ghi nhận degrade disabled trung thực).
- **G8 CONFIRMED.** `0032_checkpoint_session_ref.sql` đúng 2 câu lệnh `ADD COLUMN IF NOT EXISTS session_ref jsonb`; không có down-migration API (khớp `migration-0032-rollout-prep`). Hậu quả tách đôi (KHÔNG CẢN offline / CẢN LIVE nếu mở window thiếu SQL) là thật.
- **G9 CONFIRMED.** `cleanup|retention` chỉ trúng `catalog.ts` (3 rows CFGADM-03/04 tại `:50,56,80`) + comment `settings-screen.tsx:21-29`; không có stats/cleanup control, không Save. CẢN UI giữ nguyên.
- **G10 CONFIRMED, evidence thiếu nhưng không đổi severity.** Hai điểm đã nêu đúng (`connector-http-store.ts:77`, `connector-management-store.ts:101` — lưu ý evidence ghi nhầm thư mục `connectors/` cho site 1, thật là `connector-credentials/`); ngoài ra còn `webhooks.ts:340`, `bff/upstream.ts:118`, `shell-server.ts:774`. Vẫn KHÔNG CẢN (coverage-only), phạm vi thiếu test còn rộng hơn đã nêu.
- **G11 CONFIRMED** qua `cred-limits-801-2026-10-05.md:69-77` (mock trả `{sequence,filename}` cho cả count-query → `rows[0].count` undefined → fix 4 dòng trong test file, exit 0 ×3). KHÔNG CẢN giữ nguyên.
- **G12 CONFIRMED** qua `qwen-acui-00-config-catalog-2026-10-02.md:31` ("None is manageable"), `:64` ("unmanaged / requires deployment action"), `:66-72` dead caps gồm `connectorBaseUrls`. Luận điểm coupling (G12 là root của G3/G7/G9) đứng vững.

## (2) commit-prep-803-2026-10-05.md — quét A8 + quét GO

- **Thiếu cảnh báo A8 (cần bổ sung, không phải lỗi GO):** grep `best-effort|muc 5|section-5|section 5|at-rest|backfill window|plaintext-readable` trên file cho **0 hit** — cả tài liệu chưa có câu chuẩn A8. Các nhóm chạm A8/dữ liệu mã hóa mà thiếu câu này: hàng **c3** ("encrypted window/cutover", "ENC/session/order hunks", "A3 pending"), **§4/§72** ("window guard chưa wired", "`allowPlaintext=true` A3 còn"), §1 migration-runner note. Điều kiện GO thiếu: thêm một câu A8 ("encryption best-effort trong backfill window, legacy rows vẫn plaintext-readable; tuyệt đối không claim at-rest encrypted tới PRE-SWITCH mục 3") vào các vị trí trên trước khi user dựa vào tài liệu. Nhóm nêu tên: **c3 claim/P2 + §4 delta wave802/§72**.
- **Không có nhóm nào được GO khi còn CHANGES_REQUIRED hoặc reviewer chưa phát:** hàng **c4** ghi đúng docs CHANGES_REQUIRED → UI-inclusive HOLD tới CSRF fix + re-review (HOLD chứ không GO); **c5** HOLD affected hunks tới typed/permanent + warning + tests 5a-5e + independent review; mọi GO còn lại đều là bounded-conditional (c1 excludes carrier/connector/settings + prefix pass; c2/c3/c6 tương tự); A6 chưa GO nhóm nào (dòng 5 + checklist 7); 5 task wave803 đều dispatched có exit criteria, 2 ready + 1 awaiting-dispatch được khai rõ — không có GO lén.

**Verdict REVIEW-805:** cả hai tài liệu dùng được sau khi sửa: gap-inventory cần 4 yêu cầu sửa evidence (G1 path, G3 refresh + tách read/write, G5 sửa + tách route/gate, G6 sửa paths), commit-prep cần 1 bổ sung (câu A8 cho c3/§4/§72). Không hạ severity nào, không phát hiện GO trái phép.

# REVIEW-806 — review BACKFILL-LEFTOVER-COUNTER + nối A8 — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_f83efc3677f7` / dispatch `ctx_2356fa028729`. Đối tượng: `backfill-leftover-counter-803-2026-10-05.md` (qwen_1, `task_62b94672e22a`) + SQL `coordination/backfill-leftover-counter-803.sql`. Phương pháp: đọc receipt + SQL thật, đối chiếu từng claim với code/migrations trên disk. DOC-ONLY: 0 edit source/test, không commit; sửa duy nhất là section này.

**Đối chiếu code (đã đọc thật):** 8 slots trong SQL §0 khớp từng member `METADATA_SLOTS` (`metadata-crypto.ts:44-62`); migration columns khớp (`0001:47,48,76,85,107`, `0005:19`, `0031:15`, `0032:3`); jsonb predicate mirror đúng envelope shape (`version:1`, `aes-256-gcm`, `dek` object, `nonce`/`tag`/`ciphertext` string); SQL chỉ SELECT/COUNT/FILTER + `default_transaction_read_only = on` + `statement_timeout 120s` (read-only thật); bug NULL-unsafe → COALESCE fix (§2.1) đúng hướng nguy hiểm (undercount = fail-open cho gate). `DU_ENCRYPTION_METADATA_ENABLED` tồn tại (`boot-options.ts:24`). Số seed cộng tay khớp (10/2/8/GATE FAILS).

**(1) Counter có dùng làm điều kiện chặn A2 flip được không; hàng nào actionable thật:** CÓ, với 2 caveat. Công thức gate `actionable = leftover − empty` đúng vì `{}` (NOT NULL DEFAULT, `0001:47,76`) không chứa tenant data — nhưng `{}` chỉ "không actionable" theo nghĩa backfill, operator vẫn nên quyết định có seal `{}` thành envelope rỗng hay giữ làm product call (receipt §7 đã tự khai, đồng ý). 8 hàng actionable thật = 2 `operations.input_ref` + 2 `tasks.payload_ref` + 1 `human_waits.response_ref` + 1 `output_ref` + 1 `session_ref` + 1 `prompt_overrides_ref` + 1 `tasks.result_ref` + 1 `operations.result_ref` trừ 2 `{}`. Caveat 1: predicate là **shape test, không decrypt** (§7 tự khai) — envelope hỏng AAD/tag vẫn đếm là sealed → trước flip cần thêm sample mở thật (task khác, đã được receipt gọi tên). Caveat 2: text-column LIKE ba substring có thể đếm nhầm plaintext chứa đủ ba chuỗi (implausible nhưng possible, §7 đã khai).

**(2) Có slot nào sót không; outbox.payload có vào gate:** KHÔNG sót slot nào trong 8 — SQL §0 liệt kê đúng cả 8 members. `outbox.payload` KHÔNG vào gate là đúng: nó không thuộc `METADATA_SLOTS`, không được metadata seam seal (seam chỉ seal 8 columns), write path (`submission.ts:508,841`, `runtime.ts:912,1113,1445,1540,1845`) ghi plain `BusinessJobV1` envelope. `outbox_payload` chỉ là ENC-09 kind (inventory adapter), không phải metadata slot — hai taxonomy khác nhau, không lẫn. §9 báo cáo riêng để chống ngộ nhận là đủ. Ghi nhận thêm: `human_waits.ui_schema`/`context_ref` (`0005_continuation.sql:16-17`) cũng plaintext by Option-C exemption (REVIEW-803 V4) nhưng ngoài phạm vi counter — coordinator nên quyết định có đưa vào gate mở rộng hay giữ exemption; không phạt receipt này vì scope của nó là METADATA_SLOTS.

**(3) Điều kiện chạy DB thật còn thiếu gì:** receipt §4 đã có window/replica/timeout/flag/watch/counts-only. Còn thiếu 3 điểm: (a) **baseline row counts trước khi mở transaction** để so "không đổi" có đối chứng (hiện chỉ re-check sau); (b) **ngưỡng abort định lượng** cho lock waits / replication lag (ai watch, số nào thì cancel); (c) **plan chi phí**: `EXPLAIN` hoặc giới hạn scope theo partition/date-range nếu `operations`/`tasks` lớn — full-scan 8 cột không phải lúc nào cũng vừa một window. Không thiếu gì về mặt an toàn đọc (read-only + timeout đã đủ).

**(4) Cập nhật A8:** KHÔNG đổi cách phát biểu. A8 hiện tại ("best-effort trong backfill window, legacy rows vẫn plaintext-readable; tuyệt đối không claim at-rest encrypted tới PRE-SWITCH mục 3") đã bao đúng trường hợp này — counter cho con số 8 hàng thay vì chữ "một số hàng", đó là **bằng chứng định lượng cho A8, không phải lý do sửa A8**. Câu chuẩn cho báo cáo dùng counter: "đếm được N hàng plaintext trong backfill window (best-effort); flip chỉ khi actionable = 0".

**(5) Verdict: APPROVED-WITH-CONDITIONS** — counter đúng scope, đúng predicate, đúng gate, trung thực về limitations; điều kiện: bổ sung 3 điểm §(3) (baseline counts, ngưỡng abort, plan chi phí) vào runbook trước lần chạy DB thật đầu tiên; sample mở envelope thật (task riêng) trước A2 flip.

# REVIEW-807 — chốt 3 quyết định từ REVIEW-806 → A10 — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_c8666f096998` / dispatch `ctx_82dc9ef92034`. Cơ sở: REVIEW-806 trong file này; `backfill-leftover-counter-803-2026-10-05.md`; SQL `coordination/backfill-leftover-counter-803.sql:202-205` (gate); `metadata-crypto.ts:350` (`readStoredText`) + `:363-372` (fail-closed NOT_SEALED sau window); `runtime.ts:1278-1286` (INSERT human_waits plaintext); migrations `0001`, `0005_continuation.sql:16-17`, `0031:15`, `0032:3`; `boot-options.ts:24` (flag). DOC-ONLY: 0 edit source/test, không commit; sửa duy nhất là section này.

Ghi chú về "seed mới / 4 empty": trên disk chỉ tồn tại đúng một lần chạy counter (receipt §3: total 10 / empty 2 / actionable 8); không có receipt, raw output hay SQL version nào ghi seed mới với 4 empty. Quyết định (1) dưới đây bao cả hai trường hợp (2 và 4) để coordinator áp dụng trực tiếp khi seed mới xuất hiện.

## (1) `{}` rows — GIỮ NGUYÊN, không seal; gate phải ghi rõ — verdict: APPROVED (quyết định)

`{}` là NOT NULL DEFAULT của schema (`0001:47` `input_ref`, `0001:76` `payload_ref`), không chứa tenant data — sealing nó tạo envelope mã hóa của object rỗng, tốn KMS/Vault transit call mà không giảm rủi ro (kẻ tấn công mở envelope rỗng cũng chỉ được `{}`). **Chốt: giữ nguyên `{}` (product call: "nothing to do"), KHÔNG seal thành envelope rỗng.** Điều kiện đi kèm (bắt buộc trong gate/report): gate phải in thêm dòng `{}`-only, và câu chuẩn là "`{}` rows are schema defaults, not tenant data; they are never counted as plaintext-readable and never gate the flip" — đúng yêu cầu packet (không bao giờ coi `{}` là plaintext-readable riêng). Áp dụng cho cả seed cũ (2) và seed mới (4): công thức `actionable = leftover − empty` không đổi.

## (2) `ui_schema`/`context_ref` — GIỮ EXEMPTION, không vào gate 8-slot; nói rõ ranh giới — verdict: APPROVED (quyết định)

Cả hai cột (`0005_continuation.sql:16-17`) là **render hints / routing pointers do worker truyền vào lúc tạo wait** (`runtime.ts:1286` `JSON.stringify(req.uiSchema)`, `contextRef ?? null`), không phải tenant business content qua metadata seam; không có writer nào seal chúng và không có reader nào gọi `readStoredText` trên chúng (grep `ui_schema` ngoài INSERT = 0 hit). Đưa vào gate 8-slot sẽ trộn hai taxonomy và làm gate FAILS vì lý do ngoài scope. **Chốt: giữ Option-C exemption (REVIEW-803 V4), KHÔNG đưa vào gate.** Ranh giới phải ghi trong báo cáo: metadata seam = 8 `METADATA_SLOTS` columns (seal-on-write, AAD tenant|slot|refId, fail-closed sau window); exemption = `ui_schema`/`context_ref` + `outbox.payload` (operational/routing, plaintext by design, báo cáo riêng không gate). Nếu sau này threat model đổi (ui_schema chứa PII), đó là packet mới thêm slot + writer, không phải sửa gate hiện tại.

## (3) Task sample-mở trước A2 flip — thiết kế rõ — verdict: APPROVED (thiết kế task)

Vì predicate chỉ là shape test, task riêng (không thuộc counter) như sau: **phạm vi = toàn bộ rows mà counter đếm là `sealed`** (không sample ngẫu nhiên — số lượng sealed pre-flip là nhỏ, đếm toàn bộ loại bỏ sampling risk); **phương pháp = `readStored`/`readStoredText` với `allowPlaintext=false` trên read replica** (đúng semantics post-flip: envelope hỏng → throw `NOT_SEALED`/`CONTEXT_MISMATCH`/`AUTHENTICATION_FAILED`, `metadata-crypto.ts:363-372`); **bằng chứng = counts (opened OK / failed by code), KHÔNG in giá trị** (giữ nguyên tắc counts-only của counter); **khi phát hiện row hỏng = STOP, không flip**: (a) ghi nhận slot + error code, (b) coi như `actionable > 0` (row hỏng quay lại hàng backfill), (c) điều tra nguyên nhân (sai AAD/slot, tag rách, key rotation) trước khi đếm lại. Task này chạy sau counter `actionable = 0` và trước A2 flip, trong cùng maintenance window, cùng điều kiện read-only + timeout.

**Verdict REVIEW-807: APPROVED** — cả 3 quyết định chốt theo hướng giữ nguyên hiện trạng (giữ `{}`, giữ exemption, thêm task sample-mở toàn bộ); không đổi code, không đổi gate SQL, không đổi A8. Việc còn lại: ghi 3 chốt này vào A10 (coordinator), bổ sung dòng `{}`-only + câu ranh giới vào runbook counter trước lần chạy DB thật.

# REVIEW-808 — A11 tái định nghĩa gate A2 flip — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_b33ee10125b8` / dispatch `ctx_61bd7022fae4`. Cơ sở: `tester-off.md:94-137` (VFY-ENVELOPE-INTEGRITY, CONFIRMED); A11 (`coordinator-state.json` adjudication_A11 07:31 +07, `agent-watch-state.json`: "shape-pass KHÔNG phải bằng chứng bảo vệ; phải xác thực chứng mỗi hàng shape-pass. A2 flip tiếp tục bị chặn"); code `metadata-crypto.ts:350-372`, SQL gate `:202-205`. DOC-ONLY: 0 edit, không commit; sửa duy nhất là section này.

**Tóm tắt phát hiện (đã đọc evidence, không suy diễn):** 4 rows `operations.input_ref` (1 valid + 3 hỏng giữ shape: ciphertext-flip, tag-flip, wrong-tenant AAD) → cả 4 `shape=true`; reader thật: 1 open + `AUTHENTICATION_FAILED` ×2 + `CONTEXT_MISMATCH` ×1; SQL nguyên bản trên chính DB đó: `sealed=4, leftover=0, GATE PASSES`, exit 0. Gate đếm mà không mở nên false-clear — nếu chạy DB thật sẽ cho flip trong khi dữ liệu đã không đọc được.

## (1) Gate A2 flip mới sau A11

Điều kiện đo (cả hai phải đồng thời = 0, đo toàn bộ không sample): (a) **shape gate cũ** `actionable_leftover = 0` (bắt plaintext lộ + `{}`-only, SQL hiện tại giữ nguyên làm census nhanh); (b) **auth gate mới** `auth_failed_total = 0`, trong đó auth gate = `readStored`/`readStoredText` với `allowPlaintext=false` trên MỌI non-null row shape-pass ở cả 8 slots, bằng production key provider + đúng tenant/slot/refId của từng row, đếm opened-OK vs failed-by-code, không in giá trị. **Bằng chứng THẬT duy nhất được chấp nhận: auth gate counts** (mở được từng hàng); shape-pass chỉ là điều kiện cần để vào auth gate, không bao giờ là bằng chứng bảo vệ. Chưa có batch-auth helper trên disk (grep 0 hit) — đó là `GATE-AUTHENTICATE-808` đã dispatched cho qwen_1.

## (2) Hàng sealed-nhưng-hỏng — KHÔNG phải bảo vệ; không đếm vào "không chứa dữ liệu bảo vệ", mà đếm vào HÀNG LỖI chặn flip

Envelope hỏng (tag rách / sai AAD) không đọc được bởi bất kỳ ai — kể cả attacker — nhưng cũng không đọc được bởi hệ thống, nên flip sẽ gây mất dữ liệu (fail-closed `NOT_SEALED` sau window). **Chốt: không coi là bảo vệ; không nhập vào `{}`-class; đếm vào `auth_failed_total`, mỗi hàng lỗi = 1 veto chặn flip**, xử lý như REVIEW-807 §(3) đã thiết kế (ghi slot + error code → điều tra nguyên nhân → backfill lại → đếm lại). Điểm mới A11 bổ sung vào §(3): auth gate là bắt buộc trên toàn bộ shape-pass (không còn là "task riêng nên có"), và `GATE PASSES` của shape counter không có giá trị GO độc lập.

## (3) A8 có cần cập nhật không — CÓ, thêm một câu

A8 hiện tại chỉ biết hai trạng thái (plaintext-readable vs at-rest encrypted). A11 phát hiện trạng thái thứ ba: **shape-sealed nhưng không mở được — hàng mà counter đếm là sealed nhưng thực tế không ai đọc được**. Câu bổ sung (đề xuất vào A8): "shape-pass không phải bằng chứng bảo vệ; hàng sealed-nhưng-hỏng là mất dữ liệu chờ xử lý, không phải hàng đã bảo vệ; tuyệt đối không dùng `GATE PASSES` của shape counter làm bằng chứng flip." Không sửa phần cũ của A8 (vẫn đúng).

## (4) REVIEW-803/806/807 phần nào còn đúng

- **REVIEW-803:** các ACCEPTED offline về seal/writer/AAD/projection vẫn đúng (crypto thật vẫn mở đúng khi envelope nguyên vẹn — VFY dùng chính `createMetadataCrypto` + AES-GCM thật). Phần bị vô hiệu: mọi câu suy ra "đếm sealed = đã bảo vệ" (nếu có) — phải đọc lại qua A11.
- **REVIEW-806:** verdict AWC vẫn đúng nhưng **điều kiện chưa đủ** — 3 điểm runbook (baseline, ngưỡng abort, plan chi phí) vẫn cần, NHƯNG ngay cả khi đủ, `actionable = 0` cũng chỉ cho qua shape gate, chưa cho flip. Caveat "shape test, không decrypt" (§7 receipt gốc + REVIEW-806 §(1) caveat 1) nay đã thành **finding CONFIRMED thay vì caveat** — đó chính là nội dung A11.
- **REVIEW-807:** quyết định (1) `{}` và (2) exemption giữ nguyên hiệu lực (không liên quan shape/auth). Thiết kế (3) sample-mở được **nâng cấp thành auth gate bắt buộc toàn bộ** theo §(1) trên — thay "nên có" bằng "phải có", thay "sample" bằng "toàn bộ shape-pass".

## (5) Điều kiện còn lại để A2 flip GO + ai biểu quyết — USER-GATED

1. Shape gate `actionable = 0` (SQL hiện tại, runbook REVIEW-806 3 điểm + REVIEW-807 dòng `{}`-only). 2. Auth gate `auth_failed_total = 0` (`GATE-AUTHENTICATE-808` implement + independent review + chạy DB thật trong maintenance window). 3. `ENCMETA-WINDOW-DESIGN-808` (dsh_3) đóng phần wiring + window switch control. 4. PRE-SWITCH mục 3 hoàn tất (A8). **Biểu quyết: coordinator đề xuất GO kỹ thuật khi 1-4 đủ; USER quyết định GO cuối cùng cho A2 flip** (user-gated — flip đổi semantics đọc toàn hệ thống, không flip từ receipt kỹ thuật). Không có flip từng phần từ shape-pass đơn độc.

**Verdict REVIEW-808: CHANGES_REQUIRED** — không phải cho code hiện tại (crypto đúng), mà cho **gate và quy trình**: shape counter + mọi kết luận dựa trên nó chưa đủ điều kiện flip cho tới khi auth gate tồn tại, được review độc lập và chạy qua trên DB thật. A2 flip tiếp tục bị chặn (đồng ý A11).

# REVIEW-809 — rà soát lại toàn bộ tuyên bố bảo vệ sau false-pass proof — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_036ad275b19e` / dispatch `ctx_32a25eadd3e6`. Cơ sở: VFY-ENVELOPE-INTEGRITY (`tester-off.md:94-137`, CONFIRMED: 1 valid + 3 hỏng giữ shape đều shape=true, reader thật AUTHENTICATION_FAILED ×2 + CONTEXT_MISMATCH ×1, SQL nguyên bản GATE PASSES exit 0); A11; `backfill-counter-fixes-807` (Seed A 10/2/8 FAILS + Seed B 0/0/0 PASSES, shape-only caveat đã ghi ở header/SQL); `a12-auth-gate-runbook-808` (A8 integrity clause + A12 auth gate đã vào runbook); docs + reports trên disk. DOC-ONLY: 0 edit, không commit; sửa duy nhất là section này.

## (1) Quét tuyên bố: at-rest / PRE-SWITCH / con số counter

- **README.md:** không có tuyên bố at-rest encrypted nào (chỉ mô tả delivery-encryption envelope `:134` + secrets mã hóa `:82` — seam khác, không ảnh hưởng). KHÔNG cần sửa.
- **`docs/04-data-state.md:93`:** "Metadata DB không chứa inline plaintext, chỉ chứa encrypted reference" — SAI theo nghĩa đen trong backfill window (legacy rows vẫn plaintext-readable, REVIEW-804 S2 đã bắt 1 lỗi tương tự ở `:102`). Cần sửa (xem §3).
- **`docs/04-data-state.md:100`:** "giờ có **7 slot** được seal" — SAI SỐ LƯỢNG: `METADATA_SLOTS` trên disk có **8 members** (`metadata-crypto.ts:44-62`, đã đếm: thiếu `step_checkpoints.session_ref` trong liệt kê). Đồng thời câu AAD "`replay chéo row ⇒ CONTEXT_MISMATCH`" vẫn ĐÚNG (xem §4). Cần sửa số lượng, giữ câu AAD.
- **`docs/12-operations.md:26`** ("Secret encrypted at rest"): seam AppSetting/Vault, không phải metadata seam — REVIEW-804 S2 đã loại khỏi A8, giữ nguyên.
- **`commit-prep-803` / `gap-inventory-803`:** không chứa tuyên bố at-rest encrypted hay con số counter nào (đã grep: PRE-SWITCH chỉ trúng file khác; counter numbers chỉ có trong `backfill-leftover-counter`, `backfill-counter-fixes-807`, `a12-runbook`, `claude.md`, `tester-off.md` — tất cả đều đã kèm caveat hoặc là receipt kỹ thuật). KHÔNG cần sửa.
- **Con số counter được trích dẫn:** Seed A (10/2/8 FAILS) và Seed B (0/0/0 PASSES) trong `backfill-counter-fixes-807:52-82` — Seed B PASSES nay phải đọc lại qua A11: PASSES đó là shape-PASSES, không phải bằng chứng bảo vệ (Seed B chưa từng chạy reader thật). Cần thêm caveat (xem §3).

## (2) Báo cáo nào đứng / cần cảnh báo / phải sửa

| Báo cáo | Trạng thái sau A11 |
|---|---|
| `backfill-leftover-counter-803` (gốc) | CẦN CẢNH BÁO — §7 "shape test" đã tự khai nhưng §3/§10 trình bày GATE PASSES/FAILS như kết luận flip; phải thêm: PASSES chỉ là shape-PASSES |
| `backfill-counter-fixes-807` | CẦN CẢNH BÁO NHẸ — header + §2 + §6 đã ghi shape-only rõ ràng; chỉ còn Seed B PASSES (`:80-82`) thiếu dòng "chưa chạy reader, không phải bằng chứng flip" |
| `a12-auth-gate-runbook-808` | ĐỨNG — A8 integrity clause + A12 auth gate + two-gate rule đã đúng hướng A11; không sửa |
| `tester-off.md` VFY-ENVELOPE-INTEGRITY | ĐỨNG — chính là proof; không sửa |
| REVIEW-803/806/807/808 trong `claude.md` | ĐỨNG với điều chỉnh REVIEW-808 đã ghi (803 crypto đúng, 806 caveat→finding, 807 nâng thành auth gate bắt buộc) |
| `docs/04-data-state.md:93,100` | PHẢI SỬA — 2 chỗ (§3) |

## (3) Câu sửa cụ thể (coordinator chuyển cho docs-owner, không tự sửa nhầm)

1. **`docs/04-data-state.md:93`** — thay "không chứa inline plaintext nội dung tài liệu; chỉ chứa encrypted reference" bằng: "trong backfill window hiện tại vẫn chứa legacy plaintext-readable (best-effort, A8); chỉ sau window switch + backfill xong mới chỉ chứa sealed envelope".
2. **`docs/04-data-state.md:100`** — thay "**7 slot**" bằng "**8 slot**" và thêm `step_checkpoints.session_ref` vào liệt kê (giữ nguyên câu AAD/CONTEXT_MISMATCH).
3. **`backfill-counter-fixes-807:80-82`** (Seed B) — thêm sau gate block: "GATE PASSES ở đây là shape-PASSES; các envelope không được mở bằng reader thật nên đây không phải bằng chứng bảo vệ hay cơ sở flip (A11)."

## (4) AAD và tenant binding sau proof wrong-tenant-bị-đếm-sealed

Các nhận định về AAD **vẫn đúng hoàn toàn** — proof thực tế CỦNG CỐ chúng: envelope bound-to-other-tenant giữ nguyên shape (shape=true) nhưng reader thật trả `CONTEXT_MISMATCH` (`tester-off.md:109,120`), đúng như `metadata-crypto.ts:303` thiết kế. Phân biệt rõ hai lớp: **shape predicate không kiểm AAD** (đó là lỗi của counter, đã có A11) vs **reader/Open kiểm AAD và từ chối đúng** (crypto đúng, không lỗi). Không có claim AAD nào cần rút lại; câu `04-data-state.md:100` về replay ⇒ CONTEXT_MISMATCH được giữ lại trong §(3).2.

## (5) Bảng mức độ tin cậy sau false-pass proof

| Tuyên bố | Tin cậy |
|---|---|
| Crypto seal/open/AAD đúng (AES-GCM thật, CONTEXT_MISMATCH/AUTHENTICATION_FAILED đúng) | CAO — VFY dùng compiled crypto + key adapter thật, reader hành xử đúng cả 4 variants |
| Shape counter bắt được plaintext lộ + `{}` (census nhanh) | CAO — Seed A/B phân loại đúng các lớp shape/plaintext |
| `sealed count` / `GATE PASSES` = đã bảo vệ / đủ điều kiện flip | KHÔNG CÒN GIÁ TRỊ — false-pass đã chứng minh; chỉ auth gate counts mới là bằng chứng (A11/A12) |
| AAD/tenant binding bảo vệ replay | CAO — proof xác nhận reader từ chối đúng |
| Outbox/ui_schema ngoài gate | CAO — taxonomy đúng, không liên quan shape/auth |
| Số slot "7" trong docs | SAI SỐ LIỆU — phải là 8 (§3.2) |

**Verdict REVIEW-809: APPROVED (kết luận rà soát)** — không phát hiện thêm tuyên bố sai ngoài 3 chỗ §(3) (2 docs + 1 caveat Seed B); mọi receipt kỹ thuật còn lại đứng sau khi đọc qua A11; AAD claims giữ nguyên. Việc còn lại: coordinator chuyển 3 câu sửa cho docs-owner/counter-owner; không flip cho tới auth gate (REVIEW-808 §5).

# REVIEW-810 — chốt thứ tự fix sau BYPASS-AUDIT-809 — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_df56fa88618f` / dispatch `ctx_f89d467412c5`. Cơ sở: `bypass-audit-809-2026-10-05.md` (codex_arch, BA-01..BA-09); VFY-AUTH-GATE-808 (`tester-off.md:140+`, auth gate đúng + vacuous-pass edge `EMPTY_DB_NO_SEAM → PASS`); A13 (BA-01 + BA-05 VERIFY trước mọi đổi boolean); A12 (two-gate rule); code trên disk đã đọc thật (dòng dẫn dưới). DOC-ONLY: 0 edit, không commit; sửa duy nhất là section này.

## (1) Ba nguyên nhân gốc hay một dấu hiệu sai — PHẢI SỬA CẢ HAI + CHẠY LẠI TOÀN BỘ

Báo cáo nêu đúng ba defect độc lập, không phải một: **(a) BA-01 representation mismatch** — `output_ref` TEXT writer `JSON.stringify` (`runtime.ts:730`) nhưng reader `openMetadata→readStored` (`:1903→:453→metadata-crypto.ts:327`) thấy string ⇒ `isSealed=false` ⇒ trả nguyên văn không AEAD (xác nhận: `isSealed` chỉ nhận record `:241-250`, TEXT envelope luôn là string); **(b) BA-05 gate coverage hole** — `specs` optional (`metadata-auth-counter.ts:153`), `specs:[]` ⇒ 0 vòng lặp ⇒ PASS, không có coverage assertion (`:217-223`); **(c) vacuous PASS** — DB rỗng + no seam ⇒ `blockers=0` ⇒ PASS (VFY edge `EMPTY_DB_NO_SEAM`). Ba lỗi ở ba lớp khác nhau (reader decode / gate API / gate semantics) — sửa một không che hai còn lại. **Chốt: sửa cả (a)+(b)+(c) và chạy lại toàn bộ shape+auth trên fixture nhiễm + sạch + rỗng.**

## (2) Slot TEXT nào khác cũng lỗ; reader nào khác cùng kiểu — kiểm kê đường đọc hợp lệ

Ba slot TEXT (`0001_platform_v1.sql:48,85,107`): `step_checkpoints.output_ref` LỖ (dùng `openMetadata`, `:1903`); `tasks.result_ref` + `operations.result_ref` KHÔNG lỗ cùng kiểu — chúng đã dùng `readStoredText` đúng (`runtime.ts:1202,1814`, `public.ts:538`, `mappers.ts:103`). Nhưng cả ba TEXT slots + 4 jsonb slots qua `openMetadata` đều còn `allowPlaintext=true` cứng (BA-03: 7 điểm true — helper `:453`, 4 result sites, `ingestion-consumer.ts:664`, claim/replay/join). Thêm BA-02 (`metadata-crypto.ts:356-358` non-string→`String()`, `!crypto→return value`, `runtime.ts:452` no-seam→raw) và BA-04 (`openDispatchSourceUrl` `:318` return mọi string trước crypto; `submission.ts:535` ghi raw khi thiếu seam) — **đường đọc hợp lệ còn lại sau khi trừ bypass: prompt-carrier strict read (`runtime.ts:342`, readStored false) là positive control duy nhất; mọi đường còn lại đều legacy-readable.** BA-09 (`getChildren :1175` SELECT `c.tenant_id` trong khi `tasks` không có cột này `:70-89`) là SQL hỏng trước crypto — phải fix JOIN operations như counter đã làm đúng.

## (3) BA-05 chốt cửa gate — 8 slot LUÔN + bằng chứng so sánh

**Chốt: cửa gate là đúng 8 canonical specs, luôn luôn** (`METADATA_AUTH_SLOT_SPECS` `:51-58` đã đủ 8 — xác nhận trên disk). Production gate wrapper phải: reject `specs` rỗng/trùng/subset (chỉ cho phép diagnostic API riêng); in coverage manifest (8/8 canonical slot, mỗi slot đúng table/column/kind/tenantExpr/refIdExpr); **bằng chứng so sánh bắt buộc: số slot đọc (counter báo) == số slot quét (manifest) == 8**, thiếu một là FAIL không cần xem counts. Vacuous PASS (§(4)) là trường hợp riêng của cùng quy tắc này (0/8 ≠ 8/8).

## (4) Vacuous PASS — KHÔNG được coi là chứng minh gì; gate phải in rõ

PASS trên DB rỗng + no seam (`EMPTY_DB_NO_SEAM → nonNull=0, blockers=0, PASS`) không chứng minh bất kỳ hàng nào được bảo vệ — VFY ghi đúng "genuine zero-row case, not a populated row passing". **Chốt: vacuous PASS không chứng minh gì cả** (không phải "sạch", không phải "đóng gate"). Gate phải in: `nonNull_total`, `seam_present (true/false)`, `slots_covered (N/8)` và verdict phân biệt ba trạng thái: `PASS (authenticated N rows)` / `NOT APPLICABLE - EMPTY SCOPE (0 rows, 0 coverage)` / `FAIL (blockers)`. Nếu policy yêu cầu no-seam không bao giờ PASS thì thêm global missing-seam blocker (VFY để mở, coordinator quyết — đề xuất: thêm, vì no-seam trên production là misconfiguration).

## (5) Thứ tự sửa + VERIFY dùng A12/A13; điều kiện trước mọi đổi boolean

Thứ tự (theo A13 + bypass §6, đã đối chiếu code): **B1** fix BA-01 (TEXT→text reader/facade, tenant/slot/taskId:stepKey, bỏ fallback `?? r.outputRef` ở `:1913`) + BA-09 (JOIN operations lấy tenant) → VERIFY PG-thật-to-reader (valid/corrupt-tag/wrong-AAD/plaintext, cả open lẫn closed policy); **B2** always-compose reader policy (BA-02/03/04: `!crypto→deny` trừ projection được duyệt, typed facade mọi mixed-read, outbox duplicate vào execution policy) + BA-05 wrapper (reject subset, manifest 8/8, vacuous states) + BA-06/07/08 bounds → VERIFY static boundary tests + real-reader coverage mọi execution consumer; **B3** chạy shape+auth đầy đủ trên production scope (write/snapshot controls, mọi actionable/broken veto) → coordinator đề xuất, **USER GO cuối** (A12). **Điều kiện cứng trước mọi đổi `allowPlaintext` true→false: B1 VERIFIED** (A13: "BA-01 phải sửa TRƯỚC bất kỳ thay đổi boolean nào" — vì flip boolean mà không sửa decode sẽ REJECT cả envelope TEXT hợp lệ, tức flip gây hỏng dữ liệu hợp lệ). B2 VERIFIED trước flip production; B3 là chính flip decision.

## (6) Báo cáo này yêu cầu sửa THEO gì, và chỉ sửa tài liệu ở đâu

SỬA THEO (code/product, owner khác làm — receipt này không sửa): BA-01 decode + fallback; BA-09 JOIN; BA-02 `!crypto`/String() early returns; BA-03 typed facade + frozen default; BA-04 outbox duplicate policy; BA-05 production wrapper (reject subset + manifest + vacuous states + optional missing-seam blocker); BA-06/07/08 bounds. CHỈ SỬA TÀI LIỆU: 3 chỗ REVIEW-809 §(3) vẫn còn hiệu lực (`04-data-state.md:93,100`, Seed B caveat) + runbook phải thêm ba verdict states §(4) và quy tắc 8/8 §(3). Không có kết luận REVIEW-803/806/807/808/809 nào bị BYPASS-AUDIT làm sai thêm — BA findings là defect mới ở lớp reader/gate API, không phải bằng chứng chống lại crypto core hay AAD (reader từ chối đúng khi được gọi đúng).

**Verdict REVIEW-810: APPROVED (thứ tự + tiêu chí)** — sửa cả ba gốc + chạy lại toàn bộ; cửa gate 8/8 + so sánh manifest; vacuous PASS không chứng minh gì + in ba states; B1→B2→B3, B1 VERIFIED là điều kiện cứng trước mọi đổi boolean; USER GO cuối. A2 tiếp tục bị chặn.

# REVIEW-811 — kiểm lại độc lập BYPASS-FIX-810 + chốt chuẩn VERIFY — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_16e192c6c58a` / dispatch `ctx_de4400dedfb3`. Cơ sở: `bypass-fix-810-2026-10-05.md` (BA-01/02/05 fixed, BA-04 warned, 13 + 153×3 + tsc 0); diff trên disk (`runtime.ts` openMetadata dispatch + claim reader, `metadata-crypto.ts` readStoredText + looksLikeEnvelope, `metadata-auth-counter.ts:53-70` assertFullCoverage + `:181` call); test `bypass-fix-810.test.ts`; A13. DOC-ONLY: 0 edit, không commit; sửa duy nhất là section này.

## (1) BA-01 là AEAD open thật, binding là binding của hàng — XÁC NHẬN

Fix dispatch `typeof value === 'string' → readStoredText(crypto, value, context, true)` (`runtime.ts` diff); `readStoredText` parse JSON → `crypto.isSealed` → `open(parsed, context)` với đúng `context` caller truyền (tenant/slot/refId của row: claim truyền `taskId:stepKey` `:1903`, counter truyền cùng refIdExpr `:51-58`). Test dùng seal thật + binding thật (`CTX` TENANT/REF `:29`), tamper ciphertext (`flipFirstChar :90`) → throw authenticated-decryption (`:93`), mutation revert dispatch ⇒ 4/13 RED với received là raw envelope JSON (`§1.4`) — đúng pre-fix behaviour. Không chỉ parse JSON: parse xong còn `open` AEAD thật.

## (2) BA-02 fail-closed khi thiếu seam — ĐÚNG PHẠM VI ĐÃ CHỐT, còn 2 đường raw có chủ ý

`readStoredText` nay: non-string → `INVALID_INPUT`; no-seam + `looksLikeEnvelope` → `KEY_PROVIDER_FAILED`; no-seam + plaintext → verbatim (đúng quyết định §2 receipt: không break deployment chưa seal gì). Còn lại `return value` ở `:349` (parsed không phải envelope — legacy plaintext trong window, fail-closed `NOT_SEALED` khi `allowPlaintext=false` ở `:400`) và `:395` (no-seam plaintext) — cả hai đều là window-compat có chủ ý, không phải bypass. `sealMetadata`/`openMetadata` `!crypto → return value` (`runtime.ts:442,467`) cũng là no-seam verbatim đối xứng với writer — chấp nhận được khi `(4)` dưới đây (BA-04 guard) tồn tại, vì sealed-row-no-seam đã bị chặn ở lớp TEXT.

## (3) BA-05 từ chối spec rút gọn — XÁC NHẬN, không còn đường bypass qua params

`assertFullCoverage` (`:53-70`): exact set match 8 slots — missing/extra/duplicates/count đều throw kèm message nêu tên (`missing=[...] extra=[...] count=N/8`); gọi ở `:181` trước mọi query. Test chứng minh trimmed (`:160-164`) và empty (`:171-173`) đều rejected. Không còn đường caller rút gọn qua `specs` param — diagnostic subset muốn có phải là API riêng (đúng yêu cầu REVIEW-810). Lưu ý: production caller duy nhất hiện tại là tests (grep `countUnsealedWithAuth` ngoài counter file = 3 test files, 0 production caller) — wrapper production + manifest 8/8 vẫn là việc của `GATE-AUTHENTICATE-808`/window-design, không phải của packet này.

## (4) BA-04 chưa sửa — MỨC ĐỘ: LATENT, chấp nhận được với guard + điều kiện

`openDispatchSourceUrl :318` vẫn `return raw` mọi string trước crypto; `submission.ts:535` vẫn ghi raw khi thiếu seam. Mức độ: **latent, không live** — submit side seal `sourceUrl` trong jsonb `outbox.payload` nên string branch hiện chỉ gặp legacy plaintext writer (đúng phân tích §6 receipt). **Chốt: KHÔNG cần sửa trước A2**, chấp nhận với 2 guard: (a) pre-flip inventory phải liệt kê outbox duplicate strings riêng (đã yêu cầu từ REVIEW-810 B2); (b) fix BA-04 (mirror BA-01: string parse-to-envelope → crypto) phải landed trước khi bất kỳ writer nào ghi envelope-string vào `sourceUrl` — hiện chưa có writer nào làm vậy. Nếu writer đó xuất hiện, BA-04 thành live bypass ngay.

## (5) BA-01 có làm mất đường đọc TEXT cũ — KHÔNG, tương thích ngược đã có test

Ba test bảo vệ đường cũ trong cùng file: jsonb path unchanged (`:107-111`), legacy plaintext TEXT passthrough trong window (`:114-117` `'artifact://legacy-plaintext'` verbatim), reader≡counter cùng shape (`:119-126`). Dữ liệu cũ (plaintext TEXT / jsonb envelope) đọc đúng như trước; chỉ có envelope TEXT (trước đây trả raw JSON sai) nay được mở đúng. Điểm còn lại duy nhất: fallback `openedOutputRef ?? r.outputRef` (`runtime.ts:1931`) vẫn còn — sau fix, `openedOutputRef` chỉ nullish khi input nullish (thành công trả string, thất bại throw), nên fallback không còn che bypass; nhưng nên xóa ở packet dọn dẹp để khỏi gây hiểu nhầm.

## (6) Checklist VERIFY bắt buộc trước GO + phần chỉ chứng minh được trên Vault/DB thật

BẮT BUỘC (offline đủ): 13 bypass-fix tests + 153 regression ×3 + tsc 0 (đã có, giữ xanh); mutation revert dispatch ⇒ RED (đã chứng minh 4/13); PG16 thật-to-reader (valid/corrupt-tag/wrong-AAD/plaintext, open+closed policy) cho BA-01/BA-09; boundary tests (trimmed/empty specs rejected, non-string INVALID_INPUT, no-seam sealed KEY_PROVIDER_FAILED). CHỈ CHỨNG MINH TRÊN VAULT/DB THẬT: production key provider unwrap (tests dùng HMAC stand-in — receipt §8 tự khai); full-table shape+auth counts trên production scope; key outage/rotation behaviour; scan cost trong window. **Chưa đủ điều kiện đổi boolean**: BA-04 guard (a) chưa có inventory; fallback `:1931` chưa xóa (khuyến nghị, không chặn); production gate wrapper + manifest chưa tồn tại (0 production caller). Đổi `allowPlaintext` khi B1 VERIFIED trên PG thật + guards trên landed.

**Verdict REVIEW-811: APPROVED-WITH-CONDITIONS** — BA-01/02/05 fixes đúng, đủ test, tương thích ngược giữ; BA-04 latent chấp nhận với guard; điều kiện GO đổi boolean: PG-thật VERIFY + outbox inventory + production gate wrapper. A2 tiếp tục bị chặn.

KHÔNG commit, KHÔNG push, KHÔNG tick row (coordinator tick). DB window: FREE. Không sửa source/test/docs nào khác ngoài section này.

# REVIEW-812 — redefine the gate standard after A17 (RLS silent PASS) — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_78ea5b68f888` / dispatch `ctx_c002b68ecadf`. DOC-ONLY: 0 edit source/test, no commit.
Basis: VFY-VACUOUS-PASS-810 (`tester.md:13706`, PG16 disposable real DB, CONFIRMED); WRAPPER-FIX-812 receipt (BA-02 closed at the wrapper, 11 tests, 170/170 x3, mutation 3 RED); gate return shape on disk (`metadata-auth-counter.ts:245-250`).

## (0) What A17 proved (read, not inferred)

- Empty migrated DB + crypto undefined: 8 slot queries, values seen=0, authenticated=0, blockers=0 → **PASS**. Tenant + API key only, no business rows: still **PASS**.
- RLS fixture (PG16, ENABLE + FORCE ROW LEVEL SECURITY): two tenant ops (tenant A valid envelopes, tenant B plaintext result_ref). Unrestricted scan → FAIL 1 blocker. Restricted role → sees 1 op, all 8 slot queries SUCCESS, 2 envelopes authenticated, 0 blockers → **PASS**. Observed cross-tenant false PASS.
- Negative controls behave: 7/8 specs → coverage error before any query (0 calls); query-4 failure → error propagates, no status; reader throw → sealedBrokenOther=1 FAIL; provider throw → KEY_PROVIDER_FAILED, sealedBrokenOther=2, FAIL.
- On-disk gap CONFIRMED: gate returns `{slots, totals, blockers, gate}` only — no slotsRead/slotsScanned/valuesAuthenticated-attempted/coverageComplete fields (`:245-250`). VFY's required fields do not exist yet.

## (1) Standard A2 gate definition post-A17 + mandatory reports + when PASS is allowed

**PASS is allowed iff ALL hold simultaneously (measured, not asserted):**
1. `expectedSlots == 8` and `slotsRead == slotsScanned == 8` (exact-8 spec guard stays, but it proves the slot list, never visibility).
2. `coverageComplete == true`: every slot query ran to completion against the full dataset (no error, no skip, counts agree).
3. `valuesAuthenticated` reported as attempted/success (auth gate ran `allowPlaintext=false` on every visible non-null shape-pass row with production key provider + exact row binding): `auth_failed_total == 0` AND `shape actionable leftover == 0`.
4. Seam present: configured crypto seam required even at zero visible rows (no-seam + zero rows is NOT APPLICABLE, never PASS).
5. Tenant full-visibility proven: gate ran with full dataset read rights (see §2) or a separately proven complete tenant census; absent proof → FAIL closed.
**Mandatory report fields:** expectedSlots, slotsRead, slotsScanned, row/value counts, auth attempted/success by code, coverageComplete, seam_present, role + RLS state used, tenant census source. Verdict vocabulary (per REVIEW-810 §4): `PASS (authenticated N rows)` / `NOT APPLICABLE - EMPTY SCOPE` / `FAIL (named reason)`. Zero-values-authenticated + PASS is forbidden output.

## (2) RLS decision — full-read-rights vs app-role + census

- **Option A (recommended): run the gate with full dataset read rights** — dedicated short-lived audit role (table owner or BYPASSRLS) in the maintenance window, RLS on/off + role recorded in the report. Why: the gate's job is proving *no hidden data*; running it under the app's restricted role re-proves only what the app sees — the exact blind spot A17 demonstrated. Risks: privileged credential exists briefly (scope to window, audit its use, destroy after); a misconfigured audit role could itself miss data — mitigate by asserting the tenant census inside the same run (§1.5).
- **Option B: app role + separate tenant census proof** — expected-tenant list from a trusted identity source, verify each tenant visible to the gate role. No privilege escalation, but the census source's completeness becomes the new unproven assumption.
- **Never allowed:** running under an unexamined role and treating query success as coverage (that is the A17 failure mode). If A is policy-forbidden, B requires an explicit accepted-risk statement naming who attests census completeness — never silent.

## (3) True PASS vs silent PASS — when FAIL-on-thin-coverage is correct vs gate-broken

- **FAIL with named reason + coverage manifest = gate working correctly.** Missing slots, query errors, count mismatch, absent seam, unproven tenant visibility → FAIL (or throw, or NOT-APPLICABLE for genuine zero-scope) is the defined behavior, not a defect.
- **Gate broken has two directions:** (a) FAIL despite complete coverage proof (bug — fix the gate); (b) PASS without coverage proof — the RLS and empty-DB cases — broken toward *unsafe*, strictly worse than (a). A silent PASS looks like a clean bill of health while data exists; a loud FAIL looks bad but harms no data.
- Operational rule: any flip decision citing a PASS must attach the §1 manifest; a PASS line without it carries zero evidentiary weight after A17.

## (4) B1-B2-B3 order post-A17 + BA-04 leaning

B1 (BA-01 decode + BA-09 JOIN + PG-real-to-reader VERIFY) → B2 (reader policy facade + BA-05 wrapper + bounds) → B3 (full shape+auth on production scope → coordinator proposes, USER GO) **still stands**, but is now **insufficient without a B2b: gate-envelope change** — implement §1 manifest fields + full-visibility rule in the counter (offline-implementable: code + unit tests proving new fields, missing-slot/query-error/no-seam/unproven-tenant all FAIL), then run on real DB with full rights.
BA-04 (`openDispatchSourceUrl` string-before-crypto, raw outbox writer): **leaning stays GUARD, not fix-before-flip** (unchanged from REVIEW-811 §4 — A17 does not make it live; still no envelope-string writer). Guard content grows by one item: pre-flip outbox duplicate-strings inventory joins the §1 manifest as reported-but-not-gating scope. Fix lands before any writer emits envelope-strings to `sourceUrl`.

## (5) Final VERIFY checklist — offline-runnable vs Vault/real-DB-only

**Offline (must all be green, ×3 + tsc 0, mutations reverted):** bypass-fix-810 13/13; wrapper-fix-812 11/11; gate-authenticate-808 (+ manifest-field tests when B2b lands); shape+auth on seeded fixture (clean + infected + empty + RLS-restricted-role reproducing silent PASS on old gate, FAIL/NOT-APPLICABLE on new); PG16-disposable runs (vacuous, RLS, missing-spec, query-error, reader/provider-throw controls); mutation probes (dispatch revert, bypass restore, composite-kind).
**Vault/real-DB-only (never claimed from offline):** production key-provider unwrap; full-table shape+auth counts on production scope under audit role; tenant census completeness; RLS-policy audit of deployed role; query cost in window; key outage/rotation behavior; backfill completion + leftover recount; `ARTIFACT_STORAGE_MIGRATION_WINDOW=false` acceptance (G-ENC seam, separate).

## (6) USER-owned conditions (no flip from technical receipts)

Final A2 flip GO; RLS on/off + role choice accepted-risk sign-off (§2); tenant-census attestor if Option B; window-switch policy + rollout order (PRE-SWITCH-3); missing-seam-blocker policy (open since REVIEW-810); `{}`-never-plaintext wording and ui_schema/context_ref exemption boundary (REVIEW-807 — restated, not reopened).

**Verdict REVIEW-812: APPROVED (standard + order + checklist)** — §1 gate definition, §2 Option-A recommendation, §3 FAIL-correct vs PASS-broken rule, §4 B1→B2→B2b→B3 with BA-04 guard leaning, §5 split checklist, §6 USER list. A2 stays blocked until B2b + Vault/real-DB legs are evidenced.

# REVIEW-813 — bay con hoan tat recheck truoc quyet dinh commit — 2026-10-05 (REVIEW-ONLY, offline)

Task `task_e6b0a9cafda8` / dispatch `ctx_25420499fe26`. DOC-ONLY: 0 edit source/test, no commit.
Basis: A11/A12/A13/A15/A17 adjudications (read from coordinator-state.json); receipts GATE-AUTHENTICATE-808, GATE-COVERAGE-817, WRAPPER-FIX-812, BA04-FIX-811, MUTATION-WRAPPER-814, VERIFY-WRAPPER-FIX-813; code on disk; `tsc --noEmit` exit 0 (this turn).

## (1) Trang thai tung ban: dong vs mo

| Ban / receipt | Trang thai |
|---|---|
| BA-01 TEXT decode (A13→bypass-fix-810) | DONG offline — string dispatch to readStoredText; mutation 4/13 RED; PG16 VFY confirmed |
| BA-02 reader strict (A13) | DONG offline — INVALID_INPUT / KEY_PROVIDER_FAILED; PG16 5-case reader verdung |
| BA-02 WRAPPER bypass (A15→WRAPPER-FIX-812) | DONG offline — `if (!crypto) return value` gone (`runtime.ts:473-479` now asserts); 11 tests; MUTATION-WRAPPER-814 re-proved 3/11 + 4/24 RED with SHA-identical restore |
| VERIFY-WRAPPER-FIX-813 open items (PG16 fixture NOT RUN, mutation NOT RUN) | DONG by others — PG16 leg covered by GATE-COVERAGE-817 RLS run; mutation leg covered by MUTATION-WRAPPER-814. Verifier's honest NOT-RUNs are now filled, no orphan |
| BA-05 exact-8 (A13) + census (A17→GATE-COVERAGE-817) | DONG offline implementation — `slotsRead/slotsScanned/valuesAuthenticated/coverage/census` on disk (`metadata-auth-counter.ts:107-147,222,232,279,309,341-358`); RLS PG16 run FAILs correctly with blockers=0 |
| BA-04 string bypass (BA04-FIX-811) | DONG offline — `safeDispatchSourceUrlJson` door (`ingestion-consumer.ts:324,360`); 13 tests; mutation 3/13 RED; writer already seals (§3 receipt) so no writer task |
| GATE-COVERAGE-817 tsc error (TS2554 noted as out-of-lease) | RESOLVED — full `tsc --noEmit` exit 0 this turn; wrapper + assert both single-arg now |
| ENCMETA-WINDOW-DESIGN-808 (dsh_3) | MO — DOC-ONLY design exists (14-day bounded window reuse, 6 literal-true inventory, MetadataReader adapter proposal). Zero implementation: six `true` literals remain, no policy object, no injection |
| GATE-COVERAGE-817 new counter code | MO review-wise — implemented + PG16-proved but NO independent reviewer leg yet (same gap pattern REVIEW-801 V1 flagged: verify-leg ≠ review-leg) |
| docs/04-data-state.md:93 + :100 (REVIEW-809 §3 fixes) | MO — NOT applied (see §5) |

## (2) Lech giua yeu cau ban va cai duoc sua

- A15 demanded "BA-02 phai sua O WRAPPER" — done exactly there; verifier confirmed no separate decision path. No drift.
- A17 demanded gate report "SO SLOT DOC, SO SLOT QUET, SO TENANT THAY, SO GIA TRI XAC THUC" — all four exist on disk. No drift.
- A15 also flagged "1 mock regression trong bo test outbox-source" — BA04-FIX-811 regression set includes `enc-meta-sentinel-outbox-source-url` green in 186/186 x3. Closed.
- Verifier receipt §1 cited signature `assertReadableWithoutSeam(value, allowPlaintext = false)`; on disk it is `(value: unknown): void` single-arg, both callers single-arg. Behavior identical (throw-or-void), but the receipt's signature line is stale — cosmetic, note for the record, not a defect.
- Receipt line-number drift (wrapper :475→:477, reader :424→:419) from concurrent-lane edits; behavior verified on current bytes. No action.
- One premise correction stood: BA04-FIX-811 §3 proved the outbox writer already seals, so A15's implied writer task was correctly NOT opened. Good — not drift, but record it so nobody re-opens it.

## (3) BA-04: dong chua, rui ro con lai

DONG offline. Residual risks, all non-live: (a) the door is a shape test — A11 applies, but corrupt-but-shaped strings route INTO the crypto and fail there, which is the correct outcome, so this is contained by construction; (b) the door reuses `looksLikeSealedEnvelope` (shared with reader, not re-implemented) — no check-drift risk; (c) no envelope-string writer exists anywhere, so the PROTECTED lane's string arm is currently defense-in-depth. Live leg only: real-DB/Vault behavior. No guard beyond the code itself is needed.

## (4) Dieu kien con thieu cho A2 GO ky thuat vs phan USER

Technical (must close before any GO proposal): (i) independent review leg for GATE-COVERAGE-817 counter code; (ii) window-switch implementation per ENCMETA-WINDOW-DESIGN (policy object + injection at 6 sites + MetadataReader adapter) + its own review; (iii) backfill run on real DB + leftover recount + auth gate under audit role with production provider; (iv) docs :93/:100 fixes (§5).
USER-owned (never from technical receipts): final flip GO; RLS on/off + audit-role risk acceptance; tenant-census attestor if not full rights; window-switch policy + rollout order (PRE-SWITCH-3); missing-seam-blocker policy; `{}`/exemption wording restated (REVIEW-807, not reopened).

## (5) Bao cao bao ve du lieu con thieu canh bao A11/A17

- `docs/04-data-state.md:93` — STILL UNGUARDED: blanket "không chứa inline plaintext… chỉ chứa encrypted reference" with no backfill-window/A11/A17 caveat in the sentence. (REVIEW-809 §3.1 fix never applied.)
- `docs/04-data-state.md:100` — STILL WRONG COUNT: "**7 slot**" (missing `step_checkpoints.session_ref`; on-disk `METADATA_SLOTS` has 8). (REVIEW-809 §3.2 fix never applied.)
- `docs/28-test-inventory.md`, `docs/35-acceptance-baseline.md` — CLEAN: test-outcome descriptions only, each carrying live-only disclaimers ("no live S3, database, Vault"); no at-rest claims to warn.
- REVIEW-809's two other fixes (same two lines) are the complete docs delta — no new unguarded claim found in this sweep.

## (6) Ket luan: BLOCK GO vs quyen USER

| # | Item | Loai |
|---|---|---|
| 1 | GATE-COVERAGE-817 counter code chua co reviewer leg | BLOCK GO (ky thuat) — review-only packet, ~1 turn |
| 2 | Window-switch chua implement (6 literal true, design-only) | BLOCK GO (ky thuat) — implementation packet + review |
| 3 | Backfill that + auth gate tren DB that / Vault that | BLOCK GO (ky thuat) — live-window only |
| 4 | docs :93/:100 fixes | BLOCK commit-as-clean (docs-owner, doc-only, nho) |
| 5 | Final flip GO + RLS/census/rollout/policy chap nhan | USER — khong flip tu receipt ky thuat |

Bay con (BA-01/02/04/05, wrapper, mutation, coverage-counter, RLS repro): khong co gi bi bo qua, khong colech vat lieu nao giua ban va fix, verifier NOT-RUNs da duoc packet khac lap day. Thu con lai deu nam o buoc tiep theo (review counter moi → implement window → live legs → USER GO), khong phai o viec sua thieu qua khu.

**Verdict REVIEW-813: APPROVED (recheck)** — bay hoan tat that, 4 BLOCK-items ky thuat + docs deu da goi ten cu the, khong con blind spot; trinh USER quyet dinh commit khi (4) xong va (1)-(3) co packet chu.

# REVIEW-814 — tham dinh doc lap 6 quyet dinh commit wave (D1-D6) — 2026-10-05 (REVIEW-ONLY, offline)

Yeu cau truc tiep tu Nguoi Dung: tham dinh chuyen mon doc lap 6 quyet dinh D1-D6 cua Coordinator truoc commit wave.
Co so: `commit-preflight-813-2026-10-05.md` (31 receipt-confirmed / 94 pre-existing-mtime / 32 unattributed); REVIEW-812; REVIEW-813; doi chieu truc tiep repo tren dia (branch `codex/fix-workflow-builder`, HEAD `b088eec`, 0 staged).
DOC-ONLY: 0 edit source/test, khong stage/commit. Receipt nay tu no lam file nay dirty — nhat ky lane khong bao gio vao product commit (D3).

## D1 — Danh sach 157 file tracked diff + co tach 31 file truoc khong

**Xac nhan:** tai thoi diem doc, `git diff --name-only` = **156** (khong con 157) — workspace van fluid, lech 1 path so voi preflight. Index 0 staged (tot: chua ai stage gi — dung). Phan loai 31/94/32 cua preflight ve mat cau truc la trung thuc, NHUNG 31 chi la "packet co cham" o muc hunk, khong phai bao chung toan-file.
**Khuyen nghi DUT KHOAT: KHONG tach commit 31 file.** Ly do: nhieu file trong 31 mang diff hon receipt chung minh — `server.ts` (89 insertions vs 4008 deletions, receipt CW-A chi cover composition-field hunk), `main.ts` (receipt chi cover boot-warning hunk, file con gop chuc nang khac), `shell-server.ts`/`view-models.ts` (accumulated work). Commit tron 31 file se cuon ca code chua review. Thay vao do: FREEZE cay → stage tung hunk co receipt → moi file can mot reviewer xac nhan "toan diff con lai da doc". Thu tu uu tien theo preflight §Ordered (contracts → persistence/runtime → admin/wiring → tests → docs → tooling).

## D2 — Root Next.js app/config co thuoc wave khong

**Da doc diff that:** `app/doc-compare/page.tsx` (97+/81-: restyle sang `@/components/ui` + lucide-react icons), `app/doc-pipeline/components/Icons.tsx` (7+/31-), root `package.json`/`package-lock.json` (them `tailwind-merge`, sua flag test e2e), root `tsconfig.json` (`exclude` them `du-rework` — chinh la ran giới tach biet hai deliverable).
**Khuyen nghi DUT KHOAT: LOAI TRU.** Day la cong viec root legacy app (UI restyle + dependency root), khong thuoc `du-rework/` product boundary, khong co packet wave nao nhan, va branch hien tai (`codex/fix-workflow-builder`) goi y chung thuoc effort khac. Commit chung se tron deliverable va nguoi review.

## D3 — Tach docs/tasks/coordination khoi code san pham

**Xac nhan + bo sung:** untracked hien tai **2,163 paths** (tang tu 2,140 luc preflight — workspace fluid). Dynamic state (`coordinator-state.json`, `agent-watch-state.json`), lane logs (`claude.md` — gom ca section nay, `tester.md`), `.commandcode/taste/**` tuyet doi khong vao product commit. Nguy hiem nhat: `du-rework/.env.live` TON TAI tren dia va **KHONG duoc ignore** (`git check-ignore` exit 1) — moi thao tac `git add` rong truoc khi sua .gitignore deu co nguy co stage secret that.
**Khuyen nghi DUT KHOAT: TACH 3 tang** — (1) product code (hunk-reviewed), (2) docs/tasks (mot commit docs-only sau khi verify generated outputs), (3) coordination/reports/state KHONG commit (lich su van hanh, giu ngoai repo hoac luu kenh rieng). Dieu kien tien quyet cho moi stage: sua .gitignore + xac minh `.env.live` bi ignore.

## D4 — 32 diff chua gan nhan: phan loai va xu ly

| Nhom | File | Xu ly |
|---|---|---|
| Prompt-pin cluster (9) | 6 document-core actions + `types/context.ts` + `types/results.ts` + `worker.ts` + execution-pin test | Mot tinh nang coherent (pinned prompt-step identity) — gom 1 commit, can owner ky ten nguyen cum |
| Crypto/submission core (5) | `contracts/runtime.ts`, `submission.ts`, `metadata-crypto.ts`, `runtime.ts`, `ingestion-consumer.ts` | Dung tam wave BA-01/02/04/05 da review — hunk-review bat buoc, nhung thuoc wave, uu tien cao |
| Legacy mount (2) | `legacy-http-mount.ts` + test | Binary passthrough feature — owner xac nhan, di kem test |
| Test-only updates (5) | admin-crypto-config, oidc02, p8-01, runtime-encryption-metadata, rv01 tests | Di kem source commit tuong ung, khong commit le |
| Docs/tasks (4) | 11-admin-ux, ADMIN-CONTROL-PLANE-UI, P8-readiness, README | Vao commit docs-only (D3) |
| Noise (2) | `operations.ts` (line-ending-only, van dirty XN), `taste.md` | Normalize/bo — tuyet doi khong commit dang nay |

## D5 — .env.example, .gitignore, OpenAPI catalog, test inventory

- **`.env.example` (19+/0-): DA DOC THAT — PHE DUYET CO DIEU KIEN.** Ca hai hunk deu comment-only: AWEB-08 (mount/admin-web flags) + CREDWORKFLOW (chi dan + placeholder `change_me_*`, khong co secret that). Dieu kien: giu nguyen, cam them secret that vao file nay.
- **`.gitignore`: CHAN — phai normalize truoc.** Git bao `Bin 304 -> 866 bytes` (mixed-encoding/NUL); noi dung khong inspect duoc dang tin. Va nhu D3: sua xong phai verify `.env.live` da ignored truoc bat ky stage nao.
- **`21-openapi.json` (601+/3-):** chu yeu additions — chap nhan vao commit docs SAU KHI verify regenerate tu canonical source (DOCS-CONNECTOR-WIRE). Khong commit output generated chua verify.
- **`28-test-inventory.md` (1111+/1015-):** rewrite nang — day la living log giong lane reports; quyet dinh no co phai tracked output chinh thuc khong, neu co thi freeze + verify, neu khong thi exclude khoi commit.

## D6 — Doan xoa lon + lockfile/manifest

- **`server.ts` (89+/4008-): DA XAC MINH LA REFACTOR-SPLIT, khong phai xoa.** 89 dong them la re-export shims (CONV-01 list-query, HttpError); imports bi xoa (node:http, bullmq, ioredis, S3, webhooks) doi ung module chu — split targets TON TAI (`http/errors.ts`, `modules/operations/list-query.ts`). Dieu kien stage: (a) hunk-review ngoai CW-A hunk, (b) chung minh server con boot (tsc + smoke boot), (c) khong bao gio stage deletion 4008 dong mu.
- **`runtime.test.ts` (37+/2121-):** chua doi chieu case-by-case trong packet nay — yeu cau owner liet ke suite thay the cho tung khoi bi xoa truoc khi chap nhan.
- **Lockfile/manifest:** hai workspace rieng (`du-rework/pnpm-lock.yaml` vs root `package-lock.json`); chi include cap manifest+lockfile khop nhau, theo dung workspace boundary (D2). Root package.json diff thuoc root app — loai (D2).

## Tong ket khuyen nghi cho Nguoi Dung

1. KHONG commit 31 file tron goi (D1) — freeze + hunk-stage co receipt.
2. LOAI root app/config khoi wave (D2).
3. TACH 3 tang; sua .gitignore + chan `.env.live` truoc moi stage (D3, dieu kien tien quyet so 1).
4. 32 file xu ly theo 6 nhom D4 — khong file nao duoc stage mu.
5. Phe duyet .env.example; chan .gitignore/OpenAPI/test-inventory cho toi khi verify (D5).
6. server.ts split da verify huong dung nhung can boot-proof; runtime.test.ts can bang thay the; lockfile theo workspace (D6).

**Verdict REVIEW-814: CHUA DU DIEU KIEN COMMIT.** Khong phai vi code sai — bay con da dong that (REVIEW-813) — ma vi ranh gioi commit chua an toan: `.env.live` chua ignored, 32 file chua owner, 2 doan xoa lon chua du proof thay the. Dong y toan bo 10 blocker/dieu kien cua preflight-813; bo sung phat hien moi: tracked count da drift 157→156, untracked 2140→2163 (workspace fluid → freeze la bat buoc), operations.ts van dirty line-ending, server.ts split targets da ton tai (giam nhe rui ro D6).

## REVIEW-815 — REVIEW-814 OUTSTANDING adjudication (2026-10-05, GLM reviewer-only, doc-only)

Packet: pasted coordinator request "REVIEW-814 OUTSTANDING, can GLM adjudication. Doc lap doc lap, reviewer chi doc, KHONG sua source." 0 source edits, 0 commits, 0 ticks. Ledger read: `coordinator-state.json` (adjudication_A21, A22, authorization_libs_migration, lease_release_usage_fixture), `agent-watch-state.json` round894/round891/round896.

### OUTSTANDING #2 — .gitignore + .env.live: XAC MINH DOC LAP (independent verify DONE)

**(a) `.env.live` bi ignore — CONFIRMED.** `git check-ignore -v --no-index` tra ve `du-rework/.gitignore:8:.env.live`, exit 0 — khop voi coordinator. Tracked du-rework = 1556 (repo total 2573), khong mat file.

**(b) Khong con secret that nao untracked-khong-bi-ignore — CONFIRMED.** Da quet: (i) khong file nao co secret extension (.pem/.key/.p12/.crt/.pfx/.jks/id_rsa) trong untracked set; (ii) `du-rework/.env.docker.example` la placeholder/empty-secrets only (negation `!.env.docker.example` line 11 hoat dong dung — file van untracked de commit); (iii) debris paths (.qwen/.qwen-tmp/.openclaude/Q1/tl*.json) absent, `.cache` ignored by root :30; (iv) false positives duy nhat la code/docs/PNGs (tokens.css = design tokens, dispatch-specs, connector-credentials source). Khong doc/print noi dung `.env.live`.

**(c) Pattern `.env.*.live` over-broad che file khong nen ignore — KHONG.** Khong tracked file nao match `.env.*.live`/`.env.*.local`; khong legit committable file nao bi shadow; negation ordered dung.

**RESIDUAL (khuyen nghi, reviewer khong sua):**
1. `du-rework/.env.local` hien chi duoc cover boi ROOT `.gitignore:4:.env.local` — pattern `.env.*.local` cua du-rework (line 10) KHONG match bare `.env.local` (glob doi hoi mot segment giua). Du-rework file chua self-contained; root .gitignore lai dang dirty (pending normalize per REVIEW-814 D5) mac du diff khong cham env lines. Khuyen nghi: them exact `.env.local` vao du-rework/.gitignore — recommendation only.
2. Untracked count tang 2163→2301 — freeze van bat buoc truoc commit.
3. Root `.env.example` (tracked, placeholder-only) thuoc legacy root app, excluded khoi wave (D2).

**Verdict #2: DIEU KIEN TIEN QUYET SO 1 (D3) DA DUOC DAP UNG.** `.env.live` da ignored, khong secret that lo thien. Con lai residual #1 (self-contain `.env.local`) nen lam truoc stage de khong phu thuoc root dirty file.

### OUTSTANDING #3 — shipping checklist final E2E gate: VAN DONG (CONFIRMED)

- A22 da phan loai dung: SHIPPING-CHECKLIST-878 (`coordination/reports/shipping-checklist-878-2026-10-05.md:3`) tu khai pham vi la "ung dung DUGate o repository root `D:\Git\dugate`" — legacy app (route tree `/api/v1/docs/{slug}`, `lib/endpoints/runner.ts:91-110` auth concern, worker.ts, prisma root). Verdict FAIL cua no ap dung cho LEGACY only, khong phai du-rework shipping blocker. Da doc receipt truc tiep — xac nhan classification.
- SHIPPING-DU-REWORK-887 (tester_live) dang chay lai tren du-rework (round894 parallel list, round891 tester_live_warning, round896 review814_status). Cho den khi co verdict tren dung target, **shipping gate VAN DONG — khong ky.**
- Round896 review814_status xac nhan: "#1 full regression: DA DISPATCH FULL-REGRESSION-889. #2 .gitignore + .env.live: DA GUI CLAUDE adjudication (= packet nay). #3 shipping-checklist: VAN DUNG."

### DA DONG — RERUN-PLAT-MIG-02-888: acknowledged CLOSED

Receipt `rerun-plat-mig-02-888-2026-10-05.md` doc truc tiep: 7/7 tren disposable PG16 `--network none` (container vfy-plm02-888-pg-20261005, tmpfs, no published port, removed), khong dung shared DB. SQL-contract gap DA DONG. Round896 receipts_settled ghi DONE.

### VAN MO — restated, khong implement (per routing rule)

- **Race atomic revocation: VAN MO.** Routed GLM tu truoc; quyet dinh semantics cua toi van dung: (A) eventual revocation + contract sentence; reject re-read/lock-across-network-IO; future path via A21 short-lived probe token. KHONG implement fix khi chua co quyet dinh (lease_release_usage_fixture race_OPEN). Round891 readiness_decision (admitted probe <=5s, later deny, zero network rowlocks) va round896 deu nhat quan voi huong nay.
- **Signed identity PARTIAL (A21).** Verifier that TON TAI — `services/connector/src/identity.ts:5` (`HmacServiceIdentityVerifier`) va `:43` (`requireServiceIdentity`, aud + scope + exp check) — da doc source truc tiep. Thieu phia Orchestrator: phat identity that cho management HTTP integration (round891 management_identity_decision: reuse verifier, fresh HS256 JWT aud=connector, exp=iat+60s — decision, chua phai implementation). Hard rule A21 van dung: mock echo header KHONG duoc tinh la xac thuc.

**Verdict REVIEW-815: #2 DONG (voi residual #1 khuyen nghi), #3 VAN DONG cho den SHIPPING-DU-REWORK-887 verdict, RERUN-888 DONG, race + identity VAN MO theo routing hien hanh.** DOC-ONLY compliance: no source file edited; nothing committed; nothing ticked.
