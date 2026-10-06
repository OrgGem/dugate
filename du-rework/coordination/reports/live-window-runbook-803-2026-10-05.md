# LIVE-WINDOW-RUNBOOK-803 — refreshed operator runbook — 2026-10-05

## 0. Scope and current disposition

**Mode:** documentation only. This receipt did not start services, contact PostgreSQL, Vault, MinIO, Redis, a browser, or a provider; it did not apply migration 0032, change source/tests, commit, or tick a task.

**Disposition:** there is no executable live window yet. All eight user/window questions in §2 remain open. The current source tree has material changes after the older prep receipts, so the hashes in §1 identify the exact bytes read for this refresh; they are not a committed release pin or proof that a deployment is running them.

Snapshot: 2026-10-05 04:23 +07, repository HEAD b088eececcb5f3df0b4edbe073a29401dafda624; worktree is dirty. Do not infer service health, applied migrations, legacy-row counts, Vault policy state, or provider behavior from old live receipts.

### Source reconciliation

The requested paths coordination/reports/rcr-live-ready-prep3-2026-10-05.md and coordination/reports/encmeta-live-ready-prep-2026-10-05.md are not present in this worktree. This refresh uses the matching live-ready-prep3-2026-10-05.md and the ENCMETA backfill/kind receipts below, plus the original eight-question list. live-ready-prep3 and tick-proposal-2 remain planning evidence; their historical health results and offline passes do not authorize this window.

Sources consulted:

- [LIVE-READY-PREP3](live-ready-prep3-2026-10-05.md) — boot hazards, window questions, and cell boundaries.
- [TICK-PROPOSAL-2](tick-proposal-2-2026-10-05.md) — offline-only P763 recommendations; live PG/MinIO/provider work remains open.
- [ENCMETA-BACKFILL-PREP](encmeta-backfill-prep-2026-10-05.md), then later [ENCMETA-ENC09-KIND](encmeta-enc09-kind-2026-10-05.md) and [ENCMETA-RESULTREF-IMPL](encmeta-resultref-impl-2026-10-05.md). The later kind receipt supersedes the prep's “no PG store / no result_ref kind” statement.
- [Original live-window questions](live-test-prep-2026-10-04.md#questions-to-resolve-before-running-live) and [LIVE-TEST-PLAN §4](../../tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md).
- [LIVE-SPEC-EXT](live-spec-ext-2026-10-05.md), [VFY-ENCMETA-801](tester.md#vfy-encmeta-801--independent-encmeta-verification-2026-10-05), [R4 SDK fix](encmeta-r4-sdk-fix-2026-10-05.md), and [Admin result projection fix](encmeta-admin-projection-fix-2026-10-05.md).

## 1. Current file digests and inspected state

SHA-256 values below were computed from files on disk, not copied from earlier receipts. Admin-Web dist hashes identify the bundle currently referenced by its own dist/index.html; they do not prove that a browser deployment serves it or that it matches a fresh build from the dirty source tree.

| Current file | SHA-256 | Current observation |
|---|---|---|
| services/orchestrator/src/modules/runtime/runtime.ts | ACB476FD3079E6F3FDBF4B81BB54F5FE0B5B2F07679BB72AB47C73664BC09138 | Seals result refs on completion and opens R2/R3 values. The result-ref readers still pass allowPlaintext: true; the window cannot be closed by an operator setting. |
| services/orchestrator/src/modules/runtime/metadata-crypto.ts | C614ECDCFDA50EAC79A29EAC2098B92CB3BBA77280D90DDEC6F3A815A4A602A1 | Context-bound seal/open and readStoredText exist; legacy plaintext handling is a caller-supplied boolean, with no runtime policy switch here. |
| services/orchestrator/src/http/routes/public.ts | 422DB30E924DB063C30405B26BE73CCC867CE4E4DEDE8E344B411A169CBB057C | Public R1 result projection calls readStoredText with true; the admin route supplies metadata crypto to the detail mapper. |
| services/orchestrator/src/http/routes/runtime.ts | 8A4209F370B4BEDCA8C24C52AC5D1B08F7D5D59EE9AC72184F7C53D3A9CA5602 | Runtime GET /tasks/:id/children returns the runtime DTO unchanged, including camelCase resultRef. |
| services/orchestrator/src/modules/operations/mappers.ts | 4D58CC2377521CB21B101C7FE0745891CB5447DD18F9C678D89D65A912FFC784 | Admin operation detail now opens the result ref under the same tenant/slot/id binding as R1; it still passes true for legacy plaintext. |
| packages/worker-sdk/src/fan-out.ts | 410EA97532106511F5A968A5A25B2CEC1DA637F85FB98C5F2AC9F371F66763FA | parseChildren prioritizes the actual camelCase taskId/resultRef/errorCode and keeps snake_case aliases as compatibility fallbacks. |
| services/orchestrator/migrations/0032_checkpoint_session_ref.sql | 69A9CC6BEA5DF9A999546AB5BB98A43EE1A1A0C3835BE5D7E8C6AEE72788E55E | Adds nullable step_checkpoints.session_ref jsonb with IF NOT EXISTS; this is additive DDL, not a data backfill. |
| apps/admin-web/src/router.tsx | F3419A4C374BB94C031B216EB0ABC2F64794F50BB65A66A6504CB12875616029 | Current route source pin; browser route/build still needs Q4 approval and live confirmation. |
| apps/admin-web/dist/index.html | 3025F28E08B12B13B7D55F2443A5562327E7686D7DC40F07AF79F01D8296E236 | References the JS and CSS rows immediately below under /admin/web/assets/. |
| apps/admin-web/dist/assets/index-Bs0p8VRI.js | 8CCDBAB15D44CCA1886895475EF3A2AE4352304FA2DC235CF1B93C793348C1D7 | Current on-disk Admin-Web JS asset. |
| apps/admin-web/dist/assets/index-BffJF1YL.css | BAF331D4EA62F3274FC1AC9E83EA049787FC7F786FAC6330FBF69DE3457BF021 | Current on-disk Admin-Web CSS asset. |

Current status deltas that affect the runbook:

- The old R4 report identified the SDK's snake_case-only parser. The current parser and the later R4 receipt now cover the actual server camelCase DTO plus compatibility aliases; the offline receipt reports 21/21 three times. Do not carry R4 as an open finding, and do not treat that offline result as live runtime evidence.
- The admin detail projection now opens the sealed ref, confirmed by the current mapper source and its offline fix receipt. The live crypto/key-provider path remains untested.
- A3 remains open: current runtime, public R1, child R2/R3, and Admin mapper paths accept legacy plaintext through allowPlaintext: true. The generic bounded-window helper and ResultRefPgMigrationStore now exist, and result_ref is registered in ENC-09, but the store is not wired to a backfill entry point and the bounded window is not wired into these runtime readers. A zero count cannot close a hard-coded reader allowance.
- ARTIFACT_STORAGE_MIGRATION_WINDOW is the artifact-storage compatibility setting; it does not close the metadata allowPlaintext paths above.
- Migration 0032's SQL is present, but its applied/pending state on any PostgreSQL instance is unknown. LIVE-SPEC-EXT reports nine browser tests collected and skipped offline; its selectors have not been proven against the approved live route.

## 2. Eight questions — all OPEN

Record an explicit answer and decision owner for each item in the signed window record. A historical .env.live, old endpoint, or past health receipt is not an answer.

| # | Answer required | Decision still pending |
|---:|---|---|
| 1 | Exact start/end time and timezone, operator and stop contact, non-production stack and URLs, disposable/local status, approved boot command, target commit, and current service/build digests. | Window GO and exact target/build pin. |
| 2 | Vault auth backend; owner for scoped policy changes; named non-root KV writer/reader and Transit encrypt/decrypt/rewrap role matrix; whether historical root-token residue is excluded for a separate maintenance task. | Identity and policy GO. Root is not an acceptance identity. |
| 3 | Dedicated PostgreSQL database/schema and app/read-only roles, Redis instance/DB/prefix, MinIO bucket/prefix, Vault mount/key/path, optional Elasticsearch endpoint/index, synthetic tenants, and exact cleanup allowlist/owner. | Isolation and cleanup GO. |
| 4 | Admin auth mode (local, oidc, or both), exact React route/build, separate tenant A/B admin/reader identities, and controlled OIDC/provider test services. | Admin/browser and identity test matrix. |
| 5 | Whether recipient decryption is required; authoritative upload/result routes and provider stub; required value for ARTIFACT_STORAGE_MIGRATION_WINDOW; whether any true compatibility case is a separate synthetic-only window. | G-ENC contract. This setting does not close the metadata legacy-read window; A3 needs a code/config implementation and independent verification. |
| 6 | Approved operation states and create/cancel/resume actions, expected audit outcomes, tenant/role/CSRF matrix, and any reviewed count-only audit query. | G-ADMIN-OPS mutation and audit matrix. |
| 7 | Accepted retention/delete policy, migration source/target, restore RPO/RTO, Elasticsearch version/index/event contract, and whether Elasticsearch shares this window or gets a separate target. | G-DATA scope and acceptance. |
| 8 | One raw receipt per cell or sanitized per-cell subdirectories under a coordinator-provided run ID; exact approved evidence root, retention and cleanup owner. | Evidence path and retention. The prior runbook's subdirectory layout is a proposal, not approval. |

## 3. Global pre-flight and per-cell checklists

### Global gate before any process or live cell

- [ ] All eight answers above are recorded; the user/coordinator explicitly authorizes this bounded non-production window.
- [ ] Pin fresh commit and compiled Orchestrator, Connector, worker, and Admin-Web build digests to the record. Recompute if any source changes or a build occurs after this receipt.
- [ ] Verify each service's protected configuration maps to the approved per-run namespaces. Record variable names/configured booleans only; never display .env.live, tokens, key values, connection strings, prompts, or provider bodies.
- [ ] The current scripts/dev.cjs checks ports 3000, 3001, 8088, and 8091 and invokes stop-all.cjs if any is occupied. Do not use scripts/dev-live.ps1 until every affected process is proven to belong to this window or a separate owner-approved boot procedure is supplied. The existing Compose file has fixed service names and host ports; a different Compose project name alone is not isolation.
- [ ] Verify the exact target with status-only/read-only probes. Do not print process command lines, environment, response bodies, rows, IDs, queue keys, object keys, Vault values, or prompt text.
- [ ] Before any DB/schema/data mutation, run only the approved DD-03 count-only procedure against its explicitly mapped read-only role. Require exactly its four integer counts, zero exit, no timeout, and exact schema/target. Any non-zero candidate count, ambiguity, unexpected output, or error means STOP; do not inspect rows or retry another DB.
- [ ] Confirm a restorable backup/restore point and a named cleanup owner for every cell that mutates state. Run cells serially and retain only approved status/count/hash/exit evidence.

### Six live cells

| Cell | Pre-flight required before it starts | Abort / hold conditions |
|---|---|---|
| **Real PostgreSQL — G-ENC / result-ref R1-R3 and approved PG acceptance** | Pin the DB/schema alias privately; verify separate least-privilege app and read-only census roles; verify backup; capture read-only migration status; complete DD-03 before mutations. Use synthetic tenant/task/operation labels and the approved app/API flows to check R1 /result, R2 /children, R3 parent join, correct opaque ref round-trip, and cross-tenant/context denial. Any DB inventory is count-only through the reviewed scanner. | Wrong/ambiguous DB or role; missing backup; pending schema unexplained; DD-03 count/error mismatch; raw rows/IDs/ref values or envelope exposed; cross-tenant/context success; unplanned write. **Do not run legacy compatibility/backfill/cutover as G-ENC acceptance while A3 is open.** |
| **Real Vault — LIV-CW-01 credential workflow** | Vault owner confirms dedicated KV v2 path/mount and, if selected, Transit key; name distinct non-root machine identities for writer, connector reader, encryptor/decryptor/rewrapper and provisioner. Prove the effective policy revision and own-prefix allow/other-prefix deny using only status/version metadata. Use a synthetic secret held in memory; confirm Orchestrator, Connector, and Vault target the same run namespace. | Root-only success; unknown/unscoped auth; shared key/path/policy mutation; connector cannot read its pinned version; Vault outage produces a side effect; any secret/sentinel in response, audit, SQL, log, or evidence. If the connector-side D5 reader is absent, mark that leg BLOCKED; a human/CLI read is not a substitute and the full chain cannot PASS. |
| **Real object storage — G-DATA / MinIO-S3** | Pin the app's actual S3 endpoint, dedicated empty versioned bucket/prefix, access identity, retention policy, and exact cleanup scope. Confirm the selected live build uses that bucket, not the historical du-artifacts-live2 pilot bucket unless Q3 explicitly approves it. Define expected byte length/hash and restore path before uploading synthetic data; keep PostgreSQL copies and S3 versions until owner sign-off. | Bucket/prefix mismatch, versioning/retention/backup uncertainty, cross-run object access, byte/hash mismatch, unexpected delete/version loss, plaintext or keys in output, or no named rollback/cleanup owner. No artifact migration unless Q5 and Q7 separately approve its source, target, and rollback. |
| **Controlled provider — LIV-SS-01 / LIV-PC-01 and selected OIDC cases** | Use a capture-capable non-production provider/stub that actually accepts the synthetic non-null sessionRef; verify JSON and multipart paths. Pin provider endpoint/build, tenant labels, prompt/profile revisions, and request-count/hash-only capture. Keep captures in memory; do not persist raw prompt/body. For prompt pinning, establish A then publish B only under the approved scenario and compare in-process equality/hash. | Provider cannot capture/echo the required field; live service/cost/credential is not explicitly approved; prompt or session data reaches durable logs, queue, checkpoint, snapshot, or receipt; wrong tenant/revision/session or any unexpected request. A resolver-only/offline pass does not prove provider observation. |
| **Worker restart — checkpoint/session resume** | Require isolated Redis DB/prefix and a single identified worker process/build; ensure it can claim only this run's synthetic job. Verify PostgreSQL schema has 0032 and the runtime/worker build pair is pinned. Use the controlled idempotent provider stub. Record the exact owned PID and restart method; pause new submissions, wait for the approved checkpoint state, then stop/restart only that worker. Validate resumed sessionRef/step identity and one logical side effect using aggregate/status evidence. | Unknown PID/queue prefix or competing worker; 0032 absent; checkpoint/session mismatch, duplicate provider/business side effect, unexpected claim by another tenant/run, secret/prompt output, or no safe stop/reconcile plan. Never invoke broad stop-all to simulate a worker restart. |
| **Migration 0032 — step_checkpoints.session_ref** | Re-read the exact SQL/hash in §1 and pin all migration files/build. Against the approved isolated DB only, inspect migrate:status first. The runner applies all pending files, so proceed only if the complete pending list is understood and every pending migration is approved; for this cell, require 0032 to be the only pending migration. Verify backup/restore and application compatibility with the additive nullable JSONB column. After the owner-approved explicit migration, run migrate:verify and status-only confirmation before worker restart. | Any unexpected pending migration; wrong DB/schema; source/digest drift; backup unavailable; migration/verification nonzero; existing column/ledger state inconsistent. Do not hand-edit schema or schema_migrations, and do not use the dev-live wrapper (it may stop processes and apply migrations implicitly). Migration 0032 adds a nullable column; it does not backfill session data. |

## 4. HIGH finding gate and cells held

At window open, reconcile the current HIGH register to these paths and record finding IDs plus closure receipts. An unresolved HIGH blocks its affected cell. If ownership or blast radius cannot be bounded, hold the entire window. A user window approval does not convert an unresolved HIGH into acceptance.

| Finding / condition | Cell(s) that must not run or be accepted while open |
|---|---|
| Secret exposure, metadata plaintext/ciphertext leakage, wrong AAD/ref binding, or cross-tenant read/write HIGH | Real PG result-ref/R1-R3, metadata backfill/cutover, and worker restart/resume. |
| Vault policy/auth bypass, secret echo, unscoped key use, or credential audit HIGH | Vault credential workflow and connector credential/management mutations. |
| S3 authorization, plaintext-at-rest, version loss, retention, or restore HIGH | Real storage upload/download/migration/restore cells. |
| Provider prompt/session disclosure, wrong prompt pin, replay, or duplicate side-effect HIGH | Provider-observation and worker restart/resume cells. |
| Admin authentication, CSRF, tenant/RBAC, or audit integrity HIGH | Browser/admin mutation and G-ADMIN-OPS cells. |

**Known current hard hold:** ENCMETA A3 remains open in the inspected source: metadata readers accept plaintext indefinitely (allowPlaintext: true), no runtime-bounded close switch is wired, and the PG store has no live backfill entry point. Therefore do not run or score as accepted the legacy-row compatibility, backfill, or “window closed/fail-closed” variant of LIV-EM-01. The offline SDK R4 parser and admin projection findings have later fix receipts and should not be listed as still open; their actual live provider/key/database behavior remains unproven. The D5 connector-side reader is a separate known live gap: without that read path, report LIV-CW-01 as partial/blocked rather than substituting a manual Vault read.

## 5. Closeout and quick rollback

Before any cell, name its stop owner and rollback target in the window record. On an abort signal, unexpected side effect, leak, count drift, or ambiguous result:

1. Stop new synthetic submissions and provider calls; preserve idempotency keys and record the last safe status/count/hash. Do not replay an outcome-ambiguous mutation.
2. Stop only the recorded worker/process owned by this window. Keep other host processes and shared services untouched. Reconcile any in-flight operation through approved app/status views, not ad hoc SQL or queue-key inspection.
3. Revert only the run's application build/config to the approved prior compatible build. Keep the dedicated test namespace isolated until evidence and cleanup ownership are reconciled.
4. For S3/artifact paths, preserve object versions and PostgreSQL rollback copies; do not delete versions/blobs during the window. For Vault, leave run-only key/path/policy state until the named owner approves exact cleanup; never rotate/delete shared keys or touch historical root residue.
5. Migration 0032 has no down migration. If applied, keep the nullable column and migration ledger entry; rollback code only to a build verified to tolerate the additive column. Do not drop the column or hand-edit the ledger. If migration outcome is uncertain, stop and use the approved isolated-DB restore/forward-recovery decision.
6. For a separately approved future ENCMETA backfill, use only the implemented CAS-protected restore path while the bounded window is explicitly open, then count-only inventory and reader-context verification. That path is not live-ready until a backfill entry point and the bounded runtime reader switch are wired and independently verified; no manual row rewrite.
7. Close the window only after per-cell receipts contain literal exits, status/count/hash outcomes, deviations, and unresolved items with no secrets, IDs, prompts, response bodies, or row values. Cleanup only the explicit allowlist; an unknown residue remains isolated and blocks release.

**Rollback limit:** the prior prep and current source do not establish a one-command recovery for real PG/Vault/S3/provider state. The window owner must supply and approve the namespace-specific restore/forward-recovery commands before opening the window; this document does not authorize those commands.

---

## A8. GATE INTEGRITY CLAUSE - a shape pass is not protection

> Added 2026-10-05 by qwen_5 (task A12-AUTH-GATE-RUNBOOK, task_ddae3a53e7cb, ctx_73275dde04e8).
> DOC-ONLY: nothing here was executed or measured by this packet.

**Shape-pass is not evidence of protection.**

- The shape counter only reads the **shape** of a stored value (does it look like an envelope?). It never
  decrypts. A row can pass the shape gate and still be unreadable.
- **A sealed-but-broken row is DATA LOSS for processing**, not a neutral gap: the value is at rest, the
  operation it belongs to can no longer be delivered, retried or completed, and nothing in the UI would
  have warned the operator.
- **Never, under any circumstances, present the shape counter GATE PASSES as evidence that the A2 flip is
  safe.** Shape PASS + a broken row is the worst possible combination: it looks green and is data loss.
  The flip gate is the **two-gate** rule in A10.1, and the auth gate (A12) is the half that can actually
  catch a sealed-but-broken row.
- If the auth gate cannot run, the correct outcome is **NOT PASSED / NOT VERIFIED** - not a shape pass
  with a footnote.

---

## A10. COUNTER RUNBOOK

> Added 2026-10-05 by qwen_5 (task A10-COUNTER-RUNBOOK, task_ae2f56f8d3c3, ctx_9d663ff33a81).
> DOC-ONLY: this packet did not run the counter, did not open a DB, did not change source, commit or tick.
> **Nothing in this section was re-measured here.** The facts below come from the source receipts named
> inline (BACKFILL-LEFTOVER-COUNTER-803 by lane qwen_1, and REVIEW-807); treat them as citations to
> those receipts, not as evidence produced by this one.

### A10.1 What the number means

- **THE GATE IS TWO GATES, NOT ONE.** The flip requires **both** of these to be zero **at the same
  time**, and **both** must be exhaustive (full-table, not a sample):
  1. **Shape gate** - `actionable = 0` (no row that still needs sealing).
  2. **Auth gate** - `auth_failed_total = 0` (no row that fails to open with the production key).
  A run that reports only the shape gate has not earned the flip. See A12 for the auth gate.
- The counter is an **aggregate total across all 8 `METADATA_SLOTS` columns** -
  `operations.input_ref`, `tasks.payload_ref`, `human_waits.response_ref`,
  `step_checkpoints.output_ref`, `step_checkpoints.session_ref`,
  `operations.prompt_overrides_ref`, `tasks.result_ref`, `operations.result_ref`.
- **It was independently verified with two different seeds, so it is a total, not a sample.**
  Do not describe it as a sample and do not extrapolate from a partial read.
- `outbox.payload` is an ENC-09 kind (`outbox_payload`) but is **not** a `METADATA_SLOTS` entry and is
  **not sealed by the metadata seam** - it is a plain job envelope. It is **reported separately** and is
  **never part of the 8-slot gate**. Do not fold it into the total.
  **Update (BACKFILL-COUNTER-FIXES-807):** `outbox.payload` is now *classified* with the same shape
  predicate as the 8 slots (shape_sealed vs plaintext), with an explicit caveat that the predicate is a
  **shape test, not a decryption** - a broken AAD/tag envelope still counts as sealed, so "sealed" means
  *looks* sealed, not *opens*. Still reported separately, still outside the gate.
- `{}` rows are, per REVIEW-807, **kept unsealed and are NOT counted as plaintext-readable.** A row that
  is an empty object is a deliberate no-op, not a leak. Counting it would inflate the leftover figure and
  push the gate the wrong way.

### A10.2 Boundary between the metadata seam and the Option-C exemption

- The 8-slot gate covers **sealed-at-rest metadata columns only**.
- `human_waits.ui_schema` and `human_waits.context_ref` stay under the **Option-C exemption**: they are
  plaintext by decision, outside the 8-slot gate, and **must not be added to the counter or to
  `METADATA_SLOTS`**.
- State this boundary explicitly in every run: the seam owns the 8 slots; the exemption owns those two
  fields. A counter reading that silently included them would show a number the gate cannot act on.

### A10.3 Before the first real DB run

1. **Baseline row counts BEFORE the transaction.** Capture per-table row counts outside the transaction
   so the counter and the baseline are comparable; without it a difference between the two readings is
   indistinguishable from normal churn.
2. **`DU_ENCRYPTION_METADATA_ENABLED` must be on.** With the seam off, plaintext rows are expected and the
   counts are **meaningless** - the run proves nothing. Assert the flag first and abort if it is off.
3. **Prefer a replica.** If the deployment exposes a read replica, point the counter there; otherwise set
   an explicit `statement_timeout` so a slow scan cannot hold the window open.

### A10.4 Abort thresholds and who watches

This runbook deliberately **does not invent default numbers.** The threshold values are the window
owner's decision and must be filled in before the run starts:

| Threshold | Value (FILL IN) | Monitored by (FILL IN) |
|---|---|---|
| Lock wait / query duration | _open_ | _open_ |
| Replication lag | _open_ | _open_ |
| Statement timeout | _open_ | _open_ |

Each row needs a value and a named observer before the window opens. An unmonitored counter run is
not a safe run.

### A10.5 Scope control

- **Run `EXPLAIN` first**, or bound the scope by **partition / date range**, so the scan cannot walk the
  whole table history. A counter whose cost is unbounded is a live-window hazard, not a diagnostic.
- Read-only is **now enforced, not just claimed** (BACKFILL-COUNTER-FIXES-807): the earlier
  `SET LOCAL default_transaction_read_only = on` was a no-op because it only affects *future*
  transactions in the session, so the running transaction stayed writable. It is now
  `SET LOCAL transaction_read_only = on`, and the run reads the setting back so it **proves** it.
  Load-bearing proof: `CREATE TABLE` inside that transaction fails with "cannot execute CREATE TABLE in
  a read-only transaction". A section-0a query reads the setting back so the run cannot claim
  read-only without showing it.

### A10.6 Still live-only

- **Production DB Vault scale** is out of scope for offline verification and remains **live-only**. This
  section does not authorize a production run, and no number in it may be presented as production
  evidence.

**Gate dependency:** A10 must not be reported as satisfied while any value in A10.4 is still open.

---

## A12. AUTH GATE

> Added 2026-10-05 by qwen_5 (task A12-AUTH-GATE-RUNBOOK, task_ddae3a53e7cb, ctx_73275dde04e8).
> DOC-ONLY: nothing here was executed or measured by this packet.

### A12.1 Run the shape census FIRST

- The shape census (A10) is the **input** to the auth gate, not a substitute for it. Run it first so the
  auth gate knows exactly which rows it must open.
- Only rows that **pass** the shape gate enter the auth gate. A row that fails the shape gate is already
  actionable and is counted by the shape gate; it must not be re-tested here.

### A12.2 Verify each shape-pass row, one at a time

- For every shape-pass row, call `readStored` with **`allowPlaintext = false`**, using the **production
  key provider** and the **exact (tenant, slot, refId) of that row**.
- **Count only.** Record a per-row pass/fail count. Never print the value, the envelope, the ref, or the
  plaintext.
- The auth gate total is **`auth_failed_total`**. The flip requires `auth_failed_total = 0` **in the same
  run** as `actionable = 0` (A10.1).

### A12.3 Sealed-but-broken rows are ERROR ROWS

- A row that passes the shape gate but fails to open is **an error row that blocks the flip** - it is data
  loss for processing (see A8), not a neutral gap.
- **Each error row is a veto.** One row is enough to hold the flip.
- Required process per error row:
  1. Record the **slot** and the **error code** (never the value).
  2. Investigate the cause (AAD binding, tenant/slot/refId mismatch, key version, cross-tenant).
  3. **Backfill the row again** through the approved path.
  4. **Recount** - the auth gate must be re-run, not patched by hand.
- Do not hand-edit rows, the ledger, or the count.

### A12.4 The four remaining conditions for the A2 flip

Derived from this runbook, each with its own line. **If the coordinator holds an authoritative list of
four elsewhere, that list governs and this one is a cross-check.**

1. **The A3 window switch is open** - section 4 "Known current hard hold": readers accept plaintext
   indefinitely, no bounded close switch is wired, and the PG store has no live backfill entry point.
2. **Both gates are zero in the same run** - A10.1: `actionable = 0` AND `auth_failed_total = 0`, both
   exhaustive (full-table, not a sample).
3. **A10.4 thresholds are filled and a named observer is assigned** - the three `_open_` rows must be closed
   before the window opens.
4. **All eight section-2 answers are recorded and the window is explicitly authorized** - section 3 global
   gate, first checkbox.

### A12.5 Decision rights

- **The coordinator proposes the technical GO.**
- **The USER decides the final GO for the A2 flip.**
- A user window approval does not convert an unresolved HIGH into acceptance (section 4).

### A12.6 What still stands from REVIEW-803, and what A11 voided

- **Not verifiable from this tree.** No `REVIEW-803` or `A11` receipt exists under `coordination/` (globbed
  for `*review-803*`, `*a11*` and `*REVIEW-80*` - zero matches), so the exact mapping cannot be restated
  here without inventing it.
- What this runbook itself records about supersession (section 4): "The offline SDK R4 parser and admin
  projection findings have later fix receipts and should not be listed as still open; their actual live
  provider/key/database behavior remains unproven."
- **Action:** cite the REVIEW-803 -> A11 mapping from those receipts directly. Do not reconstruct it from
  memory.

**Gate dependency:** A12 must not be reported as satisfied while any value in A10.4 or A12.4 is still open.
