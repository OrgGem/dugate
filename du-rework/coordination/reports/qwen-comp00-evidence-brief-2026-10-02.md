# COMP00-EVIDENCE-BRIEF — receipts vs 5 COMP-00 decisions

**Task:** `task_bac7287ddcf3`  
**Mode:** synthesis only. No decision taken, no design proposed, no code.  
**Method constraint honoured:** built **only** from receipts + `tasks/` — no source was re-read to independently verify code (per self-review-plan §0).  
**Inputs read:** the COMP-00 decision block (`tasks/API-COMPAT-DUGATE-2026-09-28.md`), COMP-01 slices A–H (8 receipts), FUNCTEST-A and FUNCTEST-B, and `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` §MISMATCH.

## 1. Decision-by-decision evidence status

### #1 — Path owner for duplicated paths — **ALREADY DECIDED (principle closed)**

Corroborating evidence, recorded not reopened:

- Slice A §5 confirms the actual legacy URLs are `/api/v1/docs/{service}` (registry-derived), the six route files export only `POST` and delegate to `runEndpoint`.
- Slice D §3 fixes the list envelope as `{operations, next_page_token}` with op-id tokens; §2 fixes detail/DELETE/cancel/resume/download status codes.
- Slice C §2 confirms the rework counterparts `/api/v1/operations/{id}/result` and `/api/v1/artifacts/{id}/download` are the two paths with **no legacy twin** — exactly the carve-out decision #1 names.
- FUNCTEST-B ran `operations-list-contract-conformance.test.ts` **19/0/0 exit 0**, so the canonical list contract is exercised, not just asserted on paper.

**Still open under #1 (not the principle):** the generic new URL, `Vary`/cache policy, and the Admin/SDK migration — decision text requires these and no receipt supplies them.

### #2 — Minimum compatibility scope — **ALREADY DECIDED (scope closed)**

Corroborating evidence:

- Slice A §5: registry 31 core rows (4/6/7/5/6/3) + 3 workflow `process` entries; `/services` flattens all 34.
- Slice C §4: `lc-checker` and `doc-compare` are **ABSENT** from the rework manifest/recipe catalog; only `disbursement` is registered.
- Slice G §1/§2: schema CRUD exists in legacy; `/services`, `/billing/balance`, `/billing/usage` characterized field-level.
- Slice D §1: operation poll/list/cancel/resume/download/DELETE all characterized.

**Evidence gap for #2:** decision #2 requires `COMP-00/01` consumer inventory to decide which `/services`, billing and webhook endpoints are actually used. Slice E §Verdict concludes the workflow **webhook is unreachable through its own route** and client-poll is the consumed mechanism — so consumer inventory for webhook is *negative evidence*, not a gap. FUNCTEST-A/B give no consumer IDs. PAR-00 §Dependency register itself says it has **no consumer IDs**. **Nobody has supplied consumer IDs for any endpoint.**

### #3 — Result materialization — **EVIDENCE PRESENT, DECISION NOT READY**

Evidence gathered:

- Slice C §1 (legacy): the shared envelope has `result.{output_format, content, extracted_data, pipeline_steps, usage, download_url}`; the formatter exposes a **generic** operations download URL; the engine's success path does not set `outputFilePath`.
- Slice C §2 (rework): success returns `artifact://…` + artifact links; `/result` exposes an opaque `resultRef`; `/artifacts/{id}/download` streams bytes or an encrypted JSON body. **Legacy inlines content; rework returns a pointer** — this is the central semantic gap decision #3 names.
- Slice C §5: legacy format vocabulary `md/json/html/csv` vs rework `json/md/text`; validator header says 28 variants while the manifest says 31 (stale comment).
- Slice H §3.3: retention has **two counters**, not one (operation 24h vs FileCache 7-day TTL).
- FUNCTEST-A ran `result-wire.test.ts` **4/0/0 exit 0** and `multipart-contract.test.ts` 31/0/0 — canonical result/multipart contracts are green offline.

**Missing for #3:** `maxInlineBytes`, `MAX_DECRYPT_BYTES`/stream bounds, checkpoint source for `pipeline_steps`/progress, usage pending/final, and the MIME/Content-Disposition rule. **No receipt states any of these numeric values or an owner.** Slice C explicitly confines itself to what it read.

### #4 — Lifecycle — **EVIDENCE RICHEST, DECISION NOT READY**

Evidence gathered:

- Slice D §1: **10 transitions (T1–T10)**, 6 state literals, `done`/`state` are independent columns, and there is **no timeout state** (recover-stalled force-FAILs).
- Slice D §2: cancel/resume/download/DELETE preconditions, effects and per-source-state status codes.
- Slice D §2 F1–F7: seven fail-open points. F1 is the fake `CANCELLED` (worker overwrites to SUCCEEDED); F3 is resume with **no tenant fence**; F6 is the opt-in `x-api-key-id` fence on all five routes plus list.
- Slice D §3/§4: pagination bounds (upper-only), **9 edge cases** including three crash paths (`page_size=0/-5/abc`), and a cursor lookup selecting by id with no tenant predicate.
- Slice D §5: **8 MISMATCHs**, notably M7 (`sync=true` returns HTTP 200 even when still RUNNING) and M8 (idempotency key is globally unique with no tenant predicate — cross-tenant operation disclosure).
- FUNCTEST-B ran `operations-list-cursor-sort-binding.test.ts`, `operation-tenant-fence.test.ts` (on deny-list) and `operations-list-contract-conformance.test.ts` green.

**Missing for #4:** whether cancel-async is an intentional break vs a runtime change (decision text requires this); the `{step,extracted_data}` → wait/CAS mapping; retention/soft-delete and post-DELETE visibility rules. **Slice D records the legacy behaviour but no receipt proposes or costs the rework change.**

### #5 — Encryption — **EVIDENCE PRESENT, DEPENDS ON AN UNSIGNED ADR**

Evidence gathered:

- Slice F §1–§4: a **single** legacy crypto primitive; 2 encrypted classes (`AppSetting` 5 keys, `fileUrlAuthConfig`) + 1 plaintext credential class (`authSecret`); rotation/revocation surfaces that actually exist.
- Slice F §8: **8 open questions for ENC/ADR-18 and COMP-00 #5**, including the keyless-ciphertext migration marker, `authSecret` re-provisioning, legacy-plaintext `fileUrlAuthConfig` ambiguity, and silent key-change degradation.
- Slice H §2.4 (M1): `fileUrlFieldName` forwards raw URLs with **no SSRF validation** — MUST-NOT-REPLICATE; this is the egress half of #5's "no plaintext fallback / fail closed" posture.
- FUNCTEST-A ran `encryption.test.ts` **38/0/0**, `grant-encryption-envelope.test.ts` 13/0/0, `vault-ref.test.ts` 59/0/0, `vault-policies.test.ts` 62/0/0 — the canonical encryption contract is green offline.

**Blocking dependency:** decision #5 defers to `ENC-00/RESULT-WIRE-01`. FUNCTEST-B lists `encryption-boot-options.test.ts`, `runtime.test.ts`, `data-02-04-live-s3.test.ts` on the **deny-list (SKIPPED-live)**, so no live encryption or S3 evidence exists in this batch.

## 2. Open questions inherited from receipts — gathered, NOT answered

| # | Question | Source | Bears on |
|---|---|---|---|
| Q1 | `next_page_token` dialect: operation-id (legacy + COMP-06 `legacy-operations.ts`) vs 4-slot cursor (`legacy-operation-serializers.ts`) — two dialects already exist for one field | slice D §6 | #1, #4 |
| Q2 | May COMP-06 **set** filter semantics replace legacy **exact** semantics on the legacy path? Today `state=RUNNING` returns only literal rows; set semantics would also return `WAITING_INPUT`/`CANCEL_REQUESTED` — a wire behaviour change | slice D §6 | #1 |
| Q3 | Global idempotency key (no tenant predicate, M8) — hardening fix vs parity behaviour? | slice D M8, slice H M2 | #4 |
| Q4 | `sync=true` returning 200 for a non-terminal op (M7) — intentional or corrected? | slice D M7 | #4 |
| Q5 | Generic new URL, `Vary`/cache policy, Admin/SDK migration path | decision #1 text; no receipt | #1 |
| Q6 | `maxInlineBytes`, decrypt bounds, checkpoint source for `pipeline_steps`/progress, usage pending/final, MIME + Content-Disposition | decision #3 text; no receipt supplies values | #3 |
| Q7 | Cancel: intentional break vs safe runtime change to reach terminal-immediate; and `{step,extracted_data}` → wait/CAS mapping | decision #4 text; slice D F1–F7 | #4 |
| Q8 | Retention/soft-delete and post-DELETE visibility (two counters, slice H M4) | decision #4 text | #4 |
| Q9 | `output_format` union: legacy `md/json/html/csv` vs rework `json/md/text` — and the stale "28 variants" validator comment | slice C §5 | #3 |
| Q10 | Which legacy secrets need a Vault key at parity; keyless-ciphertext migration marker owner; `authSecret` rotate-vs-encrypt-in-place | slice F §8 Q1–Q3 | #5 |
| Q11 | Legacy-plaintext `fileUrlAuthConfig` read fallback — resolve, or remove at cutover? | slice F §8 Q4 | #5 |
| Q12 | Silent key-change degradation (`""` / `undefined`) — require explicit failure signal? | slice F §8 Q5 | #5 |
| Q13 | ApiKey `SHA-256(raw)` unsalted + `slice(0,16)` Redis index — keep at parity or change? | slice F §8 Q6 | #5 |
| Q14 | TLS: `http:` still permitted — https-only a COMP-00 requirement or out of scope? | slice F §8 Q8 | #5 |
| Q15 | Consumer inventory: which `/services`, billing, webhook endpoints have real external consumers (decision #2 prerequisite) | slice E verdict (webhook unreachable), PAR-00 §Dependency register (no consumer IDs) | #2 |
| Q16 | Balance semantics — no receipt characterizes `/billing/balance` computation against a ledger | slice G §2.2 (fields/units only) | #2 |

## 3. Cross-cutting health from FUNCTEST

| Receipt | Result | Relevance |
|---|---|---|
| FUNCTEST-A (contracts/worker-sdk/connector-client/document-kit/observability) | contracts **464/464**, worker-sdk **621/621**, exit 0 across all five packages | canonical contracts including `result-wire`, `encryption`, `vault-*`, `operations-list-contract`, `admin-resource-list-contract` are green offline |
| FUNCTEST-B (orchestrator offline) | **102/104 suites green**; 2 failed, both log-capture assertions | the 2 reds are unrelated admin-shell/log-capture suites, not COMP-01 surfaces |

FUNCTEST-B's two reds, verbatim from the receipt: `adm-base-03-safe-error-offline.functional.test.ts:210` expected `"deferred section render error"`, received `""`; and `admin-shell-session-lifecycle.test.ts:790` expected length 1, received 0. **30 required suites were SKIPPED-live (deny-list, 0/0/0 executed)** — including `runtime.test.ts`, `operation-tenant-fence.test.ts`, `data-02-04-live-s3.test.ts`, `encryption-boot-options.test.ts`, `migrations.test.ts`, `artifact-grant-fencing.test.ts`.

**Reading for COMP-00:** the canonical contract layer is well evidenced offline; every **live** boundary relevant to #3 (S3), #4 (lease/fence) and #5 (encryption at runtime) is unexecuted and classified SKIPPED-live, not passing.

## 4. Suggested evidence-provisioning order (sequencing only, no decisions)

Ordered by how many open questions each unblocks, cheapest-first. This is a work order, not a decision.

1. **Consumer inventory IDs** (Q15) — unblocks #2 and is a stated prerequisite in decision text. Cheapest: an external-consumer list per endpoint. PAR-00 and FUNCTEST already flag its absence.
2. **Live-window evidence for the SKIPPED-live deny-list** — runtime + tenant-fence + encryption boot + S3. This is the single largest evidence gap for #3/#4/#5 simultaneously, and it needs infra, not analysis.
3. **`next_page_token` dialect decision + fixture** (Q1) — one field, two existing implementations; needs a golden fixture before any contract can reference it. Blocks #1 and #4.
4. **Set-vs-exact filter decision** (Q2) — same route, directly changes legacy wire behaviour. Cheap decision, but needs the Q1 fixture to land with it.
5. **Cancel/resume lifecycle decision + replay fixture** (Q7, Q3, Q4) — Slice D already supplies the exact transition table; what is missing is the chosen rework behaviour and a test pinning it.
6. **Result materialization numbers** (Q6, Q9) — needs `maxInlineBytes`/bounds and a checkpoint source; Slice C supplies the current shape but no values.
7. **Encryption key-parity answers** (Q10–Q14) — eight questions already enumerated in Slice F §8; these depend on `ENC-00/RESULT-WIRE-01`, so schedule after that decision rather than before.
8. **Schema/doc-fidelity deltas** (Slice G G-01, G-05, G-08, G-09) — guide-vs-code drift that changes caller/operator behaviour; lowest cutover urgency but cheap to record as intentional breaks.

## 5. Boundaries held

- **No COMP-00 decision made, changed, or ticked.** #1 and #2 are reported as already-closed with corroboration only, per the acceptance.
- **No wire/schema design proposed** — that is COMP-02 and stays BLOCKED-COMP-00.
- **No source re-read to self-verify**; every claim traces to a receipt or `tasks/` line.
- **Only this receipt was written.** No `tasks/*.md`, `AGENTS.md`, execution overlay, lockfile, `server.ts` or `contracts/src` touched.
- **No gate ticked**, no commit, no message to nocobase-10.
- Legacy security defects are quoted **factually** from receipts as evidence (F1/F3/F6, M8, Slice H M1/M2); none is reproduced or acted on.