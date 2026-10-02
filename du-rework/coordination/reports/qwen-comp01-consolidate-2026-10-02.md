# COMP01-CONSOLIDATE — đối chiếu 8 receipts với acceptance COMP-01

**Task:** `task_6820eaad6849` · **Date:** 2026-10-02 · **Status:** synthesis only, read-only.
**No source, test, task row, gate, or other lane's file was touched.** The only file written is this receipt. No gate ticked, no commit, no message to `nocobase-10`.

**Method, and its one hard limit:** this receipt **synthesises the 8 slice receipts only**. Where a slice did not cover something, the entry below says *cần slice bổ sung* and I did **not** go read source to close it myself. Counts marked *measured* were produced by scanning the receipt files, not by re-deriving from source.

## 0. What was read

| Input | Use |
|---|---|
| `tasks/API-COMPAT-DUGATE-2026-09-28.md` lines 50, 81–83, 119 | the COMP-01 parent acceptance and the a/b/c split |
| 8 slice receipts `codex-comp01-slice-{a..h}-*.md` (1199 lines total) | the evidence being reconciled |
| `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` | existence + scope check only, see §5 note |

Receipt inventory (measured, `sha16` prefix / lines):

| Slice | Scope | Lines | sha16 |
|---|---|---:|---|
| A | legacy route shape, 31-row core matrix, operations/services/billing route shapes | 151 | `bc42131144b0` |
| B | profile / connector parameter map, 31-row | 74 | `de39cc2cc98e` |
| C | output + business-action map, 31-row, workflow output | 87 | `c5081f67e858` |
| D | lifecycle, state machine, pagination | 113 | `328b4762d1ca` |
| E | webhook / callback inventory | 104 | `dbe196705964` |
| F | legacy encryption touchpoints | 191 | `9cafb11de5d9` |
| G | workflow-schema + services/billing field-level | 257 | `ea75e6d89824` |
| H | file/url ingestion policy matrix | 222 | `77755629da96` |

## 1. Acceptance coverage — COMP-01 × covering receipt

Acceptance text is quoted from the plan at line 50; the a/b/c rows are lines 81–83.

| # | Acceptance element (plan wording) | Covered by | Completeness | Gap |
|---|---|---|---|---|
| 1 | Characterization matrix **từng route** | A §1–4, G §1–2 | **FULL** — 16 `app/api/v1` handlers, plus schema/pipeline-mappings/override routes | none |
| 2 | **31 core variants** matrix | A §2, B §2, C §3 | **FULL** — 31/31 present in all three (measured, §2 below) | none |
| 3 | **3 workflows + schema** | A §3, C §4, G §1 | **PARTIAL** — disbursement mapped; `lc-checker` and `doc-compare` recorded **absent** from the rework manifest/recipe set (C §4). Schema CRUD is deep in G | no rework registration exists for 2 of 3 legacy workflows — that is a finding, not a coverage gap |
| 4 | **status / header / body / error** | A §1, C §1, D §2, G §2 | **PARTIAL** — status codes and bodies are mapped per route (A §4, D §2, G §2.2–2.3). Two error-envelope conventions coexist and are catalogued (D-M4) | no single envelope inventory keyed by route; a consumer cannot yet resolve "which of the two shapes applies to this route" from one table |
| 5 | **binary** output/download | C §2, D §2, H §3 | **PARTIAL** — rework `GET /artifacts/{id}/download` and legacy `download` route are both mapped, including delivery-encryption branch (C §2) | legacy `download` path-traversal behaviour is mapped (D §2) but the **S3 vs local backend selection** is only in H §3.1; no slice states the two sides' binary behaviour side by side |
| 6 | **webhook** | E (whole receipt) | **FULL** — receivers, payloads, retry/timeout/signature, rework counterpart, 5-entry ledger | none. E also proves the workflow terminal webhook is unreachable through its own route |
| 7 | **MISMATCH ledger** legacy spec-vs-code | all 8 | **FULL** — 69 raw entries, consolidated in §4 | none |
| 8 | 31-row map: **discriminator** | A §2, B §2, C §3 | **FULL** — every row carries its required discriminator | none |
| 9 | 31-row map: **required/optional fields** | A §2, B §1–2, B §3 | **FULL**, with a correction of substance: **no** registry parameter is `required` and **none** sets `defaultLocked` (A §1, B §1) | none |
| 10 | 31-row map: **profile parameter/connector** | B §1–2 | **FULL** — per-row profile slug, lock semantics, `connectionsOverride`, rework slot target | B-8 leaves `ExternalApiOverride` **application unresolved**: the table exists, the permitted resolver never reads it |
| 11 | 31-row map: **file/url policy** | H §1–2 (whole receipt), A §1 common fields | **FULL** — upload bounds, `file_urls` auth shapes, SSRF present/absent, timeouts | none |
| 12 | 31-row map: **output + business action đích** | C §3, B §2 | **FULL** — per-row validator, manifest schema, artifact name, handler lines | none |
| 13 | workflow uses **`process`** | A §3, C §4, E §1 | **FULL** — required discriminator, 3 values, and the `resolution_data` field only on disbursement | none |
| 14 | MISMATCH: wrong **JSON-body claim** | A §6 | **COVERED** | none |
| 15 | MISMATCH: **catalog 28** wrong | A §6, C §5 | **COVERED** — two independent stale-28 sites (coordination doc, validator header) | none |
| 16 | MISMATCH: guide **`/api/v1/extract`** vs `/api/v1/docs/extract` | — | **NOT COVERED by any of the 8 receipts** (measured: the strings `06b`, `api-spec-overview`, `/api/v1/extract` appear **0** times across all eight) | **cần slice bổ sung** — see §5 G-1 |
| 17 | Update `P0-03` / compatibility matrix per reviewer | — | **OUT OF SCOPE of the 8 receipts** by instruction (no code, no tick) | **cần slice bổ sung** — §5 G-2 |

## 2. 31-variant matrix — counted from the receipts

Measured by testing each of the 31 `service:variant` strings for presence in each receipt body.

| Slice | Variants present | Carries the full 31-row table? |
|---|---|---|
| A | **31/31** | **YES** — §2 is the canonical numbered table (ingest 1–4, extract 5–10, analyze 11–17, transform 18–22, generate 23–28, compare 29–31) |
| B | **31/31** | **YES** — §2, same row numbering as A |
| C | **31/31** | **YES** — §3, same row numbering as A |
| D | 0/31 | no — lifecycle/pagination slice, per-route not per-variant |
| E | 0/31 | no — webhook/callback slice |
| F | 0/31 | no — encryption slice |
| G | 0/31 | no — field-level schema/services/billing slice |
| H | 0/31 | no — ingestion policy slice |

**No variant is missing anywhere.** All 31 `service:variant` pairs appear in each of A, B and C, and the three tables share one numbering, so the acceptance element is satisfied by three independent passes rather than one. The three carry **different columns**, which is why the split is useful rather than redundant:

| Column carried | Slice |
|---|---|
| required discriminator, per-case optional params, file/url policy, rework action target | A §2 |
| profile slug, lock semantics, `connectionsOverride`, connection chain, rework connector slot | B §2 |
| per-case `output_format`, provider validator, manifest output schema, artifact name + handler lines | C §3 |

Two cross-slice agreements are worth stating because they are load-bearing and were reached independently:

- **The 31 count is consistent** across A, B, C *and* the registry helper the catalog is derived from (A §5).
- **The rework side is 31 in the manifest and recipes** (A §6, B §7, C §5), so the legacy 28 figure is stale in *three* separate places — a coordination doc, the validator header, and not the code. The `28` in `WORKLOAD-REBALANCE-04` is a document artefact, not a code count.

## 3. Consolidated MISMATCH ledger

### 3.1 How the numbers reconcile

| Slice | Raw ledger rows | Native ids |
|---|---|---|
| A | 17 | unnumbered |
| B | 8 | `1..8` |
| C | 6 | unnumbered (Delta column) |
| D | 8 | `M1..M8` |
| E | 5 | `1..5` |
| F | 6 | `MM-1..MM-6` |
| G | 10 | `G-01..G-10` |
| H | 9 | `M1..M9` |
| **Total** | **69** | four incompatible numbering schemes |

**Numbering collision is real and had to be resolved before merging:** A, B, D and H each use `M1..Mn` for *different* facts. D-M5 (cancel is advisory only) and D's own fail-open table row `F1` are the same defect recorded twice inside one receipt. Below, every consolidated row carries its source slice, so no fact is orphaned.

### 3.2 Cross-slice duplicates merged (7)

| # | Same fact found independently in | Merged into |
|---|---|---|
| 1 | legacy `output_format` `md/json/html/csv` vs rework `json/md/text` — **A row 6, B-4, C-1** (3 sources) | CM-C1 |
| 2 | stale 28-vs-31 count — **A row 15, C-6** | CM-C7 |
| 3 | declared-but-unattached params (`target_language`, `redact_patterns`, `max_words`, `audience`) — **A row 12, B-3** | CM-B3 |
| 4 | `idempotencyKey` globally unique, lookup has no tenant predicate — **D-M8, H-M2**; both slices mark it MUST-NOT-REPLICATE | CM-H1 |
| 5 | workflow route file comment omits `/docs` — **A row 1, E-5** (E itself flags it as already implied by A) | CM-A1 |
| 6 | transform discriminator `action` vs rework `variant` — **A row 5**, corroborated by B §3 | CM-B1 |
| 7 | cancel writes a terminal state that the engine then overwrites — **D-M5** and **D fail-open F1** (same receipt) | CM-D1 |

**Source rows: 96.** That is the 69 designated-ledger rows above **plus 27 rows held outside those ledgers** in four MUST-NOT-REPLICATE / fail-open sets: A §7 (5 bullets), D §2 fail-open `F1..F7` (7), E §8 (6), F §6 (9). Those 27 are included because they are the entries COMP-00 most needs, and dropping them would make the register read safer than the evidence is.

**Registered entries: 82.** 7 are the cross-slice merges in §3.2. The remaining reduction comes from flag rows that merely restate a ledger entry — the clearest case is D's `F1` (cancel is advisory) being the same defect as D's `M5`; I did not decompose every such fold, so treat 96 → 82 as an approximate reconciliation and the **82 numbered rows** as the register.
### 3.3 The registered entries, grouped by theme

`!` = MUST-NOT-REPLICATE per the owning slice · `?` = left unresolved on purpose by the owning slice. Flags are carried as recorded, not re-judged here. The Sources column names the originating receipt and its native id, so no fact is orphaned by the renumbering.

| ID | Sources | Claim (one line) | Flags |
|---|---|---|---|
| `CM-A1` | A r1, E-5 | Route-file comments omit the `/docs` segment; README / design tables publish the short path | — |
| `CM-A2` | A r2 | System sequence diagram shows a JSON body for extract; the runner reads multipart form data | — |
| `CM-A3` | A r3 | OpenAPI marks `file` as the only file property and required; the normalizer accepts four names | — |
| `CM-A4` | A r4 | README / API_DESIGN_PROPOSAL route paths are stale against the registry | — |
| `CM-A5` | A r10 | API_DESIGN_PROPOSAL names `/processors` and `/health`, which do not exist | — |
| `CM-A6` | A r14 | Compare doc says two files required; the adapter only collects and forwards | — |
| `CM-A7` | A r16 | Fix-plan says there is no API to trigger a schema workflow; the route exists | — |
| `CM-B1` | A r5, B §3 | Transform discriminator: legacy `action`, rework `variant` with an `action` alias | — |
| `CM-B2` | A r7, B §3 | Rework custom-extract / fact-check use different field names and types than legacy | — |
| `CM-B3` | A r12, B-3 | Six `PARAMS` entries attach to no case, so client values are dropped | — |
| `CM-B4` | A r8, B §3 | Rework compare requires structured `source` / `target`; legacy selects `mode` + files | — |
| `CM-B5` | A r18 | Core and workflow wire discriminators are not uniform (core per-registry, workflow `process`) | — |
| `CM-B6` | B-1 | Extract preset coverage is partial and keyed differently from the six-case registry | — |
| `CM-B7` | B-2 | Profile resolver does not connect presets to profile values | — |
| `CM-B8` | B-5 | Legacy connection slugs do not map one-to-one onto rework capability slots | — |
| `CM-B9` | B-6 | Local-vs-connector execution differs for several named chains | — |
| `CM-B10` | B-8 | `ExternalApiOverride` application unresolved — table exists, permitted resolver never reads it | ? |
| `CM-B11` | A r13 | Registry `language` options `vi/en/ja/zh` vs the OCR description example `vie,eng` | — |
| `CM-C1` | A r6, B-4, C-1 | `output_format` vocabulary: legacy `md/json/html/csv`, rework `json/md/text` | — |
| `CM-C2` | C-2 | Legacy inlines content/data + generic download URL; rework returns a result ref + artifact links | — |
| `CM-C3` | C-3 | Legacy core persistence is generic; rework defines variant-level provider-output checks | — |
| `CM-C4` | C-4 | Rework manifest schema and raw provider validation describe different layers | — |
| `CM-C5` | C-5 | Workflow output breadth differs; rework registers only disbursement of the three | — |
| `CM-C6` | C-6 | Validator header says 28 variants while the manifest describes 31 | — |
| `CM-D1` | D-M5 + D F1 | Cancel is advisory: it writes a terminal state the engine then overwrites | ! |
| `CM-D2` | D-M2 | `PENDING` filterable but never written; `CANCELLED` / `WAITING_USER_INPUT` written but not filterable | — |
| `CM-D3` | D-M3 | Detail and list envelopes differ; a client cannot treat one as the other | — |
| `CM-D4` | D-M4 | Lifecycle errors mix problem+json and bare `{error}` envelopes | ! |
| `CM-D5` | D-M6 | 404 detail is not uniform: GET carries `detail`+`requested_id`, the others carry neither | — |
| `CM-D6` | D-M7 | `sync=true` swallows timeout/failure and returns 200 regardless of terminal state | ! |
| `CM-D7` | D-M8 | Idempotency key lookup has no tenant predicate — see CM-H1 for the same defect | ! |
| `CM-D8` | D-M1 | `page_size` documented 20/100 but has no minimum and no type validation | — |
| `CM-D9` | D F2 | Cancel UPDATE has no CAS or state predicate — concurrent race | — |
| `CM-D10` | D F3 | Resume has no tenant fence at all | ! |
| `CM-D11` | D F4 | Resume has no CAS and no idempotency; two resumes double-enqueue | — |
| `CM-D12` | D F5 | Resume 500 leaks `err.message` verbatim | — |
| `CM-D13` | D F6 | Lifecycle fence is opt-in; an absent header means no check at all | ! |
| `CM-D14` | D F7 | Resume accepts `{step}` with no `extracted_data`, no-ops, yet still re-enqueues | — |
| `CM-D15` | D §6 | Rework splits one legacy non-terminal bucket into 8 states; filter is set-membership vs exact | ! |
| `CM-D16` | D §6 | Two `next_page_token` dialects already exist: op-id (legacy + COMP-06) vs 4-slot cursor | ! |
| `CM-E1` | E-1 | Workflow README documents `webhookUrl`; the handler reads no webhook field at all | — |
| `CM-E2` | E-2 | README payload shape matches none of the four real shapes | — |
| `CM-E3` | E-3 | API_PROFILES_SPEC claims a 3-retry blanket contract; the workflow path has zero | — |
| `CM-E4` | E-4 | Guide lists `payload` unconditionally; a GET callback silently sends none | — |
| `CM-E5` | E §2 | Workflow webhook path is single-shot: no timeout, no status check, any response marks sent | ! |
| `CM-E6` | E §3 | Callback node: no retry, no timeout, no signature | ! |
| `CM-E7` | E §8 | Unsigned callbacks; client-supplied destination fetched with no host policy | ! |
| `CM-E8` | E §8 | Secrets embeddable inline in a stored schema row | ! |
| `CM-F1` | F MM-1 | `ENCRYPTION_KEY` documented as a 32-char random string; any non-empty string is accepted | — |
| `CM-F2` | F MM-2 | `crypto.ts` header scopes the primitive to one key; it protects two data classes | — |
| `CM-F3` | F MM-3 | `middleware.ts` header describes `/api/v1/docs/*`; the bypass list is wider | — |
| `CM-F4` | F MM-4 | AGENTS.md prescribes structured logging; the logger has no redaction helper | — |
| `CM-F5` | F MM-5 | Rework docs present Vault envelopes as available; legacy has no Vault / rotation | ? |
| `CM-F6` | F MM-6 | No doc under `du-rework/docs/**` describes legacy encryption at all | ? |
| `CM-F7` | F §6 | Plaintext credential at rest (`authSecret`), masked only on list endpoints | ! |
| `CM-F8` | F §6 | Decrypt path falls back to plain JSON on any failure | ! |
| `CM-F9` | F §6 | Silent decrypt failure returns an empty string with no log line | ! |
| `CM-F10` | F §6 | Raw API-key prefix used as a Redis key | ! |
| `CM-F11` | F §6 | Credential written into the URL for the `query` auth type | ! |
| `CM-F12` | F §6 | Unauthenticated route spends a stored credential | ! |
| `CM-F13` | F §6 | Mask handling enforced only client-side; the server would store a masked literal | ! |
| `CM-F14` | F §6 | `NEXTAUTH_SECRET` doubles as the AES key when `ENCRYPTION_KEY` is unset | ! |
| `CM-F15` | F §6 | No TLS enforcement on credential-bearing outbound calls | ! |
| `CM-G1` | G-01 | Guide sends `files`; the normalizer reads `files[]` + three others, and the UI sends `files[]` | — |
| `CM-G2` | G-02 | `slug` documented lowercase / no spaces; only truthiness is checked | — |
| `CM-G3` | G-03 | `name` documented REQUIRED; `validateSchema` never inspects it | — |
| `CM-G4` | G-04 | `version` documented default 1; true on the XML path only | — |
| `CM-G5` | G-05 | `join.combine = merge` documented to merge objects; the runner returns the raw array | — |
| `CM-G6` | G-06 | `connector` slug documented to exist in the system; only truthiness is checked | — |
| `CM-G7` | G-07 | `$binding` documented to resolve to a real target; `validateSchema` reads no binding | — |
| `CM-G8` | G-08 | `required` documented to make an input mandatory; enforced only in the browser | — |
| `CM-G9` | G-09 | UI reads `schema.useDuAdapter`; absent from `WorkflowSchema` and unvalidated | — |
| `CM-G10` | G-10 | Dispatch spec cites a pipeline-mappings path that does not exist (nested under `workflow-schemas/`) | — |
| `CM-H1` | H-M2, D-M8 | `idempotencyKey` globally unique, lookup not tenant-scoped — cross-tenant leak | ! |
| `CM-H2` | H-M1 | `fileUrlFieldName` forwards raw URLs: no SSRF check, no size/ext/MIME bound, no audit | ! |
| `CM-H3` | H-M3 | `http-client.ts` comment claims DNS-rebinding protection; it is TOCTOU | ! |
| `CM-H4` | H-M4 | Spec 7-day auto-delete conflates two independent clocks (24h operation, 7d cache) | ! |
| `CM-H5` | H-M5 | Spec attributes the path-traversal guard to `upload.ts`; it lives in `upload-helper.ts` | ! |
| `CM-H6` | H-M6 | `file_urls` cap of 20 enforced only in the runner — verified NOT bypassable | ! |
| `CM-H7` | H-M7 | Two validators disagree on MIME outside `MIME_MAP`: upload rejects, `file_urls` accepts | ! |
| `CM-H8` | H-M8 | `file_urls` capped at 20 but the `files[]` count is uncapped | ! |
| `CM-H9` | H-M9 | `ALLOWED_PRIVATE_HOSTS` + Docker `UPLOAD_DIR` escape hatch bypass both SSRF checks | ! |

**82 entries: 30 flagged `!` MUST-NOT-REPLICATE, 3 flagged `?` unresolved-by-design.** Theme sizes: A 7 · B 11 · C 6 · D 16 · E 8 · F 15 · G 10 · H 9. CM-D7 is a pointer to CM-H1, not a second claim.

## 4. Gaps — slices that would be needed (described, not performed)

Per the spec I did **not** go read source to close any of these. Each is stated as a gap against the acceptance text, with what a supplementary slice would have to cover.

| # | Gap | Why it is a gap | What a supplementary slice must cover |
|---|---|---|---|
| **G-1** | The guide mismatch **COMP-01 explicitly names** — guide `/api/v1/extract` not matching `/api/v1/docs/extract` — is **absent from all 8 receipts** | Measured: the strings `06b`, `api-spec-overview` and `/api/v1/extract` occur **0 times** across all eight files. The two named mismatches that *are* covered are the JSON-body claim (CM-A2) and the catalog-28 count (CM-C6) | Locate which guide carries the wrong path, pin `file:line` for both the claim and the real route, and decide whether it is the same defect as CM-A1 (route comments) or a separate doc |
| **G-2** | `P0-03` / compatibility matrix is **not updated by any receipt** | Correctly out of scope — the spec forbids code and ticks. But it means acceptance item 17 is open by instruction, not by oversight | A reviewer pass folding the 82 registered entries into `P0-03` and the compatibility matrix. Blocked on reviewer/user authority, not on evidence |
| **G-3** | **Binary/output sides are never compared to each other** | C maps the rework artifact download and D maps the legacy download route, but no receipt puts the two binary contracts side by side (content type, filename, encryption envelope) | One row per binary surface: legacy `download` vs rework `/artifacts/{id}/download`, including the delivery-encryption branch C found in §2 |
| **G-4** | **No single error-envelope inventory keyed by route** | Two conventions coexist (CM-D4) and each receipt lists which routes use which, but no table answers "for route X, which shape and which fields" in one place | A per-route error-shape matrix. Cheap to build from citations already in hand; needed before a consumer can write one error parser |
| **G-5** | **`lc-checker` and `doc-compare` have no rework counterpart**, and no receipt covers the domain criteria a parity target would need | C §4 records the absence; A §3 records the legacy shape. What is missing is any statement of what parity would require — and per P9-02 that needs a domain owner, not a characterization slice | Not a read-only slice. Needs a domain-owner decision packet first, then a criteria-bearing implementation packet |
| **G-6** | **Pagination edge cases (D §4, E1–E9) are code-read, never executed** | D states this explicitly. E2 (`LIMIT -4`), E3 (`LIMIT NaN`) and E1 (`items[-1]` deref) are runtime claims only a live call confirms | An executed pagination probe against a legacy instance. D is the right shape for it; the gap is execution, not analysis |
| **G-7** | **Schema CRUD is field-level, but the run path is not traced** | G §1.4 maps the UI caller; A §3 and C §4 map the run routes. No receipt follows one schema from import through trigger to result artifact | One end-to-end schema lifecycle trace. Characterization only — P9-04 owns the schema-workflow product decision |
| **G-8** | **Two independent `next_page_token` dialects (CM-D16) remain unresolved** | D §6 raises it and explicitly declines to decide. A, B and C do not touch it | A COMP-00 decision, not a slice. Listed so it is not lost between receipts |

## 5. Cross-references and boundaries

**`ORCH-PAR-00` was checked for scope, not merged.** The file exists (`tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md`, 69 lines) and is a **journey/control-plane survey**. **None of the 8 receipts references it** (measured: 0 occurrences of `ORCH-PAR-00`, `COMP-08` or `COMP-09` across all eight). That is consistent with the spec's own boundary — PAR-00 is journey-layer, these slices are code-layer — but it means **nothing here should be read as folding PAR-00 in**, and a reader looking for cutover journey evidence will not find it in this register.

**Layer separation held across all 8 receipts.** Every one is scoped to legacy code plus a read-only rework comparison; none proposes replacement behaviour; the `!` flags are recorded as touchpoints rather than reproduced exploits. The MUST-NOT-REPLICATE set is consistent where slices overlap — the idempotency defect is flagged independently by D (CM-D7) and H (CM-H1), and A §7, D §2, E §8 and F §6 all label rather than demonstrate.

## 6. Limits of this receipt

- **Synthesis only.** Every claim traces to a slice receipt. I opened no source file to establish or close a finding, per the spec.
- **No test, build or lint command was run**, so there is no command output to record. The spec does not require any.
- **No gate ticked, nothing committed**, and no other lane's file touched. `COMP-01` and `COMP-01a/b/c` statuses are unchanged and remain the reviewer's to move.
- **No mismatch re-adjudicated.** Flags, severities and the `?` open items are carried exactly as their owning slice recorded them. Where two slices disagreed I would have had to surface it; none did.
- **The 96 → 82 reconciliation is approximate** and labelled as such in §3.2. The 82 numbered rows and the 7 named cross-slice merges are the reliable part.
- **Duplicate detection is not claimed as exhaustive.** I merged the 7 I could evidence; two slices may have recorded the same fact in wording I did not match.