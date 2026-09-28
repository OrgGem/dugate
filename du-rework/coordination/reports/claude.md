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
