# INDEX — coordination/receipts (du-rework)

> **Day la INDEX chi dan, khong phai ban goc.** File receipt goc van nguyen ven, append-only:
> khong cat, khong viet lai, khong doi anchor/link nao. INDEX chi them con tro de tra cuu.

- **Pham vi:** `reports/*.md` — **182** file, **83483** dong.
- **Sinh luc:** 2026-10-03, quy tac tuyet dinh; cot trang thai lay nguyen van tu receipt, khong suy dien.
- **Le ghi:** khong sua file nao khac trong `coordination/`, khong tick gate, khong commit.
- **Xem them:** [INDEX-REVIEWS.md](../reviews/INDEX-REVIEWS.md).

## 0. Quy tac doc INDEX nay

| Cot | Y nghia | Nguon |
|---|---|---|
| Task ID | ID task ma receipt khai bao | `**Task:**` trong header truoc, roi tieu de, roi ten file. Khong co thi `—` |
| Chu de | tieu de cua file | tieu de cap 1–3 dau file; bo tien to ID khi ID nam o dau tieu de, giu nguyen tieu de khi ID lay tu giua |
| Receipt | link tuong doi, click thang vao file goc | ten file |
| Trang thai | **nguyen van** chu receipt khai bao | chi doc `**Status:**` / `Status:` trong 25 dong dau. Khong suy dien, khong bo qua |
| Ngay | ngay nhan ban/dung | `Date:` trong header, roi `-YYYY-MM-DD` trong ten file, roi ngay bat ky trong header |
| Dong | so dong vat ly | dem bang `split(/CRLF|LF/).length - 1` (khong ghi literal CRLF trong bang) |

## 1. Index theo Task ID

| Task ID | Chu de | Receipt | Trang thai | Ngay | Dong |
|---|---|---|---|---|---:|
| ACUI-00 | Catalog cấu hình vận hành Orchestrator | [qwen-acui-00-config-catalog-2026-10-02.md](qwen-acui-00-config-catalog-2026-10-02.md) | inventory + classification, read-only. No sou… | 2026-10-02 | 253 |
| ACUI-01 | PREP (read-only) — Admin BFF read/mutation foundation | [qwen-acui01-prep-2026-10-02.md](qwen-acui01-prep-2026-10-02.md) | — | 2026-10-02 | 199 |
| CODEX-3 | REVIEW lane, W43-R7 | [codex3.md](codex3.md) | — | 2026-09-24 | 293 |
| COMP-00 | input: legacy auth and tenant-fence inventory | [codex-legacy-auth-fence-inventory-2026-10-01.md](codex-legacy-auth-fence-inventory-2026-10-01.md) | — | 2026-10-01 | 42 |
| COMP-01 | Slice B — profile / connector parameter map | [codex-comp01-slice-b-profile-connector-matrix-2026-10-02.md](codex-comp01-slice-b-profile-connector-matrix-2026-10-02.md) | — | 2026-10-02 | 73 |
| COMP-01 | Slice C — output + business-action map (READ-ONLY) | [codex-comp01-slice-c-output-action-map-2026-10-02.md](codex-comp01-slice-c-output-action-map-2026-10-02.md) | characterization only; no source/gate edits; … | 2026-10-02 | 86 |
| COMP-01 | Slice E — Legacy webhook/callback contracts inventory (READ-ONLY) | [codex-comp01-slice-e-webhook-callback-inventory-2026-10-02.md](codex-comp01-slice-e-webhook-callback-inventory-2026-10-02.md) | characterization only; no source, test, task-… | 2026-10-02 | 103 |
| COMP-01 | Slice F — Legacy encryption touchpoints inventory (READ-ONLY) | [codex-comp01-slice-f-legacy-encryption-touchpoints-2026-10-02.md](codex-comp01-slice-f-legacy-encryption-touchpoints-2026-10-02.md) | characterization only. No source, test, task-… | 2026-10-02 | 190 |
| COMP-01 | slice H — file/url ingestion policy matrix (READ-ONLY) | [codex-comp01-slice-h-2026-10-02.md](codex-comp01-slice-h-2026-10-02.md) | — | 2026-10-02 | 221 |
| COMP-01 | Characterization matrix: legacy app/api/v1 + lib/ (read-only) | [comp-01-characterization-matrix.md](comp-01-characterization-matrix.md) | — | 2026-10-01 | 543 |
| COMP-02 | input — legacy API error namespace inventory | [codex-legacy-error-inventory-2026-10-01.md](codex-legacy-error-inventory-2026-10-01.md) | — | 2026-10-01 | 69 |
| COMP-02 | INPUT — legacy connector invocation wire vs rework connector wire | [codex-rework-legacy-connector-wire-2026-10-01.md](codex-rework-legacy-connector-wire-2026-10-01.md) | — | 2026-10-01 | 84 |
| COMP-03 | Legacy Input Bridge Characterization — READ ONLY | [codex-comp03-input-bridge-characterization-2026-10-01.md](codex-comp03-input-bridge-characterization-2026-10-01.md) | — | 2026-10-01 | 56 |
| COMP-03 | legacy profile and prompt-override characterization | [codex-comp03-legacy-profile-override-characterization.md](codex-comp03-legacy-profile-override-characterization.md) | — | — | 68 |
| COMP-05 | Executable legacy projection fixture spec | [codex-comp05-executable-fixture-spec-2026-10-01.md](codex-comp05-executable-fixture-spec-2026-10-01.md) | — | 2026-10-01 | 248 |
| COMP-05 | Legacy result and metadata projection gap | [codex-comp05-result-projection-gap-2026-10-01.md](codex-comp05-result-projection-gap-2026-10-01.md) | — | 2026-10-01 | 72 |
| COMP01-G1 | guide /api/v1/extract mismatch (read-only supplement) | [qwen-comp01-g1-guide-mismatch-2026-10-02.md](qwen-comp01-g1-guide-mismatch-2026-10-02.md) | — | 2026-10-02 | 200 |
| COMP01-G7 | schema lifecycle trace end-to-end (read-only characterization) | [qwen-comp01-g7-schema-lifecycle-2026-10-02.md](qwen-comp01-g7-schema-lifecycle-2026-10-02.md) | — | 2026-10-02 | 223 |
| COMP01-G7b | HITL resume path trace (read-only characterization) | [qwen-comp01-g7b-hitl-resume-2026-10-02.md](qwen-comp01-g7b-hitl-resume-2026-10-02.md) | — | 2026-10-02 | 275 |
| COMP01-Q15 | FOLLOWUP 1-HOP — decoded callback.url trên mounted route (READ-ON… | [cmdcomp01-q15-1hop-2026-10-02.md](cmdcomp01-q15-1hop-2026-10-02.md) | characterization read-only. Chỉ ghi đúng file… | 2026-10-02 | 62 |
| COMP01-Q15 | CLOSE 1-HOP — decoded callback.url tới delivery path (READ-ONLY) | [cmdcomp01-q15-close-1hop-2026-10-02.md](cmdcomp01-q15-close-1hop-2026-10-02.md) | characterization read-only. Chỉ ghi file rece… | 2026-10-02 | 107 |
| COMP09-WORKFLOW-BRIEF | workflow evidence brief cho COMP-09 / PAR00-J05 (READ-ONLY) | [cmdcomp09-workflow-brief-2026-10-02.md](cmdcomp09-workflow-brief-2026-10-02.md) | brief tổng hợp read-only. KHÔNG tự map proces… | 2026-10-02 | 90 |
| CONN-2C-FIX | retryable signal carried on the wire (A-1) + policy written once | [qwen-conn2cfix-retryable-2026-10-02.md](qwen-conn2cfix-retryable-2026-10-02.md) | — | 2026-10-02 | 137 |
| CONN-2CFIX | Independent verification | [tester-conn2cfix-verify-2026-10-02.md](tester-conn2cfix-verify-2026-10-02.md) | — | 2026-10-02 | 29 |
| CONV-00 | tracked file-size guard receipt | [codex-conv00-file-size-guard-2026-10-02.md](codex-conv00-file-size-guard-2026-10-02.md) | — | 2026-10-02 | 36 |
| CONV-05 | Admin fetcher sanitize helper — cc2 verification receipt | [cc-conv05-admin-fetch-2026-10-02.md](cc-conv05-admin-fetch-2026-10-02.md) | — | 2026-10-02 | 139 |
| CONV-05 | Admin fetcher upstream-error sanitiser (one shared helper) | [qwen-conv05-admin-fetcher-2026-10-02.md](qwen-conv05-admin-fetcher-2026-10-02.md) | — | 2026-10-02 | 94 |
| CONV-06 | implementation receipt | [codex-conv06-impl-2026-10-02.md](codex-conv06-impl-2026-10-02.md) | — | 2026-10-02 | 35 |
| CONV-06 | PREP — bounded-fanout primitive decision evidence | [codex-conv06-prep-2026-10-02.md](codex-conv06-prep-2026-10-02.md) | — | 2026-10-02 | 76 |
| CONV-06 | independent verification | [tester-conv06-verify-2026-10-02.md](tester-conv06-verify-2026-10-02.md) | — | 2026-10-02 | 29 |
| CONV-08 | Chia admin-shell-render.test.ts theo pane (lane Qwen-5R, verify-o… | [qwen-conv08-render-split-2026-10-02.md](qwen-conv08-render-split-2026-10-02.md) | — | 2026-10-02 | 148 |
| CONV-08 | independent split receipt — admin shell render tests | [tester-conv08-admin-render-split-2026-10-02.md](tester-conv08-admin-render-split-2026-10-02.md) | — | 2026-10-02 | 53 |
| CONV-10 | Admin operations pagination test split | [tester-conv10-operations-pagination-split-2026-10-02.md](tester-conv10-operations-pagination-split-2026-10-02.md) | — | 2026-10-02 | 26 |
| CONV-11 | Index/summary cho receipts & history (khong cat lich su) | [qwen-conv11-index-2026-10-02.md](qwen-conv11-index-2026-10-02.md) | — | 2026-10-02 | 130 |
| CONV-12 | shell-router.ts split | [qwen-conv12-shell-router-split-2026-10-02.md](qwen-conv12-shell-router-split-2026-10-02.md) | implemented and verified. No gate ticked, no … | 2026-10-02 | 107 |
| CONV-12 | independent verification | [tester-conv12-verify-2026-10-02.md](tester-conv12-verify-2026-10-02.md) | — | 2026-10-02 | 40 |
| COST-01 | Receipt lane Qwen-Cost (COST-01..04 / token ledger / LOG-01..02) | [qwen-cost.md](qwen-cost.md) | — | — | 334 |
| CRX-03 | Slice 1 — blocked on missing config seam | [codex-crx03-worker-seam-2026-10-02.md](codex-crx03-worker-seam-2026-10-02.md) | — | 2026-10-02 | 25 |
| CRX-05 | Recipe catalog smoke | [codex-crx05-recipe-catalog-smoke-2026-10-02.md](codex-crx05-recipe-catalog-smoke-2026-10-02.md) | — | 2026-10-02 | 53 |
| D-LINT-ORCH-1 | Codex lint probe | [codex-lint-probe.md](codex-lint-probe.md) | — | 2026-09-25 | 35 |
| D2 | COMP-03b D2 — Strict input decoder hardening | [codex-comp03b-d2-decoder-hardening-2026-10-01.md](codex-comp03b-d2-decoder-hardening-2026-10-01.md) | — | 2026-10-01 | 42 |
| D4 | doc-compare production chunk runner (runChunk) | [codex-p9-03-doc-compare-runner-2026-10-01.md](codex-p9-03-doc-compare-runner-2026-10-01.md) | runChunk implemented and offline-verified. No… | 2026-10-01 | 67 |
| D5 | doc-compare registration (handler kind + action) | [qwen-d5-doc-compare-registration-2026-10-02.md](qwen-d5-doc-compare-registration-2026-10-02.md) | — | 2026-10-02 | 97 |
| D5 | + D5B independent verification — 2026-10-02 | [tester-d5-verify-2026-10-02.md](tester-d5-verify-2026-10-02.md) | — | 2026-10-02 | 48 |
| D5-scope-probe | doc-compare registration mapping (READ-ONLY) | [codex-d5-scope-probe-doc-compare-registration-2026-10-01.md](codex-d5-scope-probe-doc-compare-registration-2026-10-01.md) | — | 2026-10-01 | 70 |
| D5b | doc-compare follow-up: Δ4 alignment fix, P9-01 stale comment, Δ2 … | [qwen-d5b-doc-compare-followup-2026-10-02.md](qwen-d5b-doc-compare-followup-2026-10-02.md) | — | 2026-10-02 | 90 |
| D5C | doc-compare fan-out concurrency honours the caller's maxConcurren… | [qwen-d5c-concurrency-2026-10-02.md](qwen-d5c-concurrency-2026-10-02.md) | — | 2026-10-02 | 67 |
| FENCE-ALIGN-VERIFY | admin-operations-sql after FENCE-TEST-ALIGN | [tester-fence-align-verify-2026-10-02.md](tester-fence-align-verify-2026-10-02.md) | verification only. Read-only: no source, test… | 2026-10-02 | 93 |
| J01 | J03 legacy/rework auth, API-key, and profile-policy characterizat… | [codex-j01-j03-auth-apikey-characterization.md](codex-j01-j03-auth-apikey-characterization.md) | — | — | 79 |
| J03 | ProfileEndpoint lock and override field inventory | [codex-profileendpoint-lock-override-field-inventory-2026-10-01.md](codex-profileendpoint-lock-override-field-inventory-2026-10-01.md) | — | 2026-10-01 | 134 |
| J04 | External-Connection Capability Inventory | [codex-j04-connector-capability-inventory.md](codex-j04-connector-capability-inventory.md) | — | — | 60 |
| LOCAL-01 | Admin local-user primitives | [codex-local01-admin-local-users-2026-10-01.md](codex-local01-admin-local-users-2026-10-01.md) | — | 2026-10-01 | 100 |
| LOCAL-02 | local auth primitives | [codex-local02-auth-primitives-2026-10-01.md](codex-local02-auth-primitives-2026-10-01.md) | isolated primitives implemented and focused o… | 2026-10-01 | 34 |
| OPT-PERF-01 | request-path latency baseline and proposals | [codex-opt-perf-01-request-path-2026-10-02.md](codex-opt-perf-01-request-path-2026-10-02.md) | — | 2026-10-02 | 145 |
| P6-06 | Wave 36-A: P6-06 Pure Operation Detail, Result, Artifacts, Cancel… | [antigravity.md](antigravity.md) | WAVE36ACOMPLETED / WINDOWRELEASED | 2026-09-22 | 288 |
| P8-03 | Connector P8-03 offline skip guard | [tester-connector-p8-03-guard-2026-10-02.md](tester-connector-p8-03-guard-2026-10-02.md) | — | 2026-10-02 | 19 |
| P8-03 | offline skip guard — 2026-10-02 | [tester-p8-03-guard-2026-10-02.md](tester-p8-03-guard-2026-10-02.md) | — | 2026-10-02 | 27 |
| P9 | integration patch draft (READ-ONLY) | [codex-p9-integration-patch-draft-2026-10-02.md](codex-p9-integration-patch-draft-2026-10-02.md) | — | 2026-10-02 | 341 |
| P9 | Connector task-name / slot bindings inventory — 3 workflow P9 (RE… | [qwen-connector-bindings-inventory-2026-10-02.md](qwen-connector-bindings-inventory-2026-10-02.md) | — | 2026-10-02 | 233 |
| P9-01 | disbursement business workflow (implementation receipt) | [codex-p9-01-disbursement-2026-10-01.md](codex-p9-01-disbursement-2026-10-01.md) | business logic implemented and green offline.… | 2026-10-01 | 196 |
| P9-01 | independent verification — 2026-10-02 | [tester-p9-01-verify-2026-10-02.md](tester-p9-01-verify-2026-10-02.md) | — | 2026-10-02 | 83 |
| P9-02 | LC checker business workflow (implementation receipt) | [qwen-p9-02-lc-checker-2026-10-02.md](qwen-p9-02-lc-checker-2026-10-02.md) | business logic, rule base, worker adapter, ma… | 2026-10-02 | 270 |
| P9-02 | independent verification — 2026-10-02 | [tester-p9-02-verify-2026-10-02.md](tester-p9-02-verify-2026-10-02.md) | — | 2026-10-02 | 65 |
| P9-03 | doc-compare advanced (bounded multi-step comparison workflow) | [codex-p9-03-doc-compare-2026-10-01.md](codex-p9-03-doc-compare-2026-10-01.md) | module implemented and offline-verified. NOT … | 2026-10-01 | 89 |
| P9-03 | independent verification — 2026-10-02 | [tester-p9-03-verify-2026-10-02.md](tester-p9-03-verify-2026-10-02.md) | — | 2026-10-02 | 40 |
| PAR00-MAP | evidence map: PAR-00 journeys / mismatches ↔ existing receipts (R… | [qwen-par00-evidence-map-2026-10-02.md](qwen-par00-evidence-map-2026-10-02.md) | aggregation only. No classification is signed… | 2026-10-02 | 141 |
| PERF-01B | bounded ingress concat micro-change | [codex-opt-perf-01b-ingress-concat-2026-10-02.md](codex-opt-perf-01b-ingress-concat-2026-10-02.md) | — | 2026-10-02 | 38 |
| QWEN-1 | Backend/Platform lane (R2-A: Admin audit atomicity + tenant autho… | [qwen1.md](qwen1.md) | — | 2026-09-25 | 1755 |
| QWEN-3 | BUGFIX lane (W43-B1 → W49-Q3-2) | [qwen3.md](qwen3.md) | — | 2026-09-25 | 2902 |
| QWEN-4 | HANDOFF — 2026-09-25 ~10:00Z | [qwen4-handoff.md](qwen4-handoff.md) | — | 2026-09-25 | 110 |
| QWEN-4 | DATA-01..04 S3 Streaming lane (review + offline verify) | [qwen4.md](qwen4.md) | — | 2026-09-25 | 754 |
| QWEN-4R | lane đo RSS DATA-04 + memo parseFile (thay lane Qwen-4, kẹt kênh … | [qwen4r.md](qwen4r.md) | — | 2026-09-25 | 183 |
| RFX-01 | RFX-DELIVERY — RFX-01 (AAD) + RFX-02 (policy.suite) delivered | [qwen-rfx-delivery-2026-10-02.md](qwen-rfx-delivery-2026-10-02.md) | implemented and verified offline. No gate tic… | 2026-10-02 | 103 |
| RFX-03 | RFX-MULTIPART — RFX-03 (public multipart plaintext bypass) + RFX-… | [qwen-rfx-multipart-2026-10-02.md](qwen-rfx-multipart-2026-10-02.md) | — | 2026-10-02 | 103 |
| RFX-04 | RFX-GATEWAY — RFX-04/05/06 inspection receipt | [codex-rfx-gateway-2026-10-02.md](codex-rfx-gateway-2026-10-02.md) | — | 2026-10-02 | 38 |
| RFX-05-FULL | scope blocker (read-only inspection) | [codex-rfx05-full-2026-10-02.md](codex-rfx05-full-2026-10-02.md) | — | 2026-10-03 | 22 |
| RFX-09 | RFX-STORAGE — RFX-09 + RFX-13 | [codex-rfx-storage-2026-10-02.md](codex-rfx-storage-2026-10-02.md) | — | 2026-10-02 | 27 |
| RFX-14 | integrity scanner deadline cancellation | [codex-rfx-scanner-2026-10-02.md](codex-rfx-scanner-2026-10-02.md) | — | 2026-10-02 | 40 |
| RV01 | F1/F4 fix patch draft (READ-ONLY) | [qwen-rv01-fix-draft-2026-10-02.md](qwen-rv01-fix-draft-2026-10-02.md) | draft only. No source, test, config or gate w… | 2026-10-02 | 256 |
| RV01 | loopback HTTP proof for the legacy compat facade | [qwen-rv01-loopback-http-2026-10-02.md](qwen-rv01-loopback-http-2026-10-02.md) | delivered, one new test file. No source chang… | 2026-10-02 | 192 |
| RV01 | loopback HTTP findings — independent verification | [tester-rv01-verify-2026-10-02.md](tester-rv01-verify-2026-10-02.md) | — | 2026-10-02 | 87 |
| RV01-01 | / RV01-03 Acceptance Verification Matrix | [codex-rv01-acceptance-matrix-2026-10-01.md](codex-rv01-acceptance-matrix-2026-10-01.md) | — | 2026-10-01 | 32 |
| RV01-08 | Independent Verification Receipt — 2026-10-01 | [codex-rv0108-independent-verification-2026-10-01.md](codex-rv0108-independent-verification-2026-10-01.md) | — | 2026-10-01 | 68 |
| SEC-00 | Codex-6 Receipt — SEC-00 / VAULT-05, Reviewer Finding 1 (Cycle 12… | [codex6.md](codex6.md) | — | 2026-09-25 | 425 |
| V2 | RFX Gateway V2 — implementation and offline verification | [codex-rfx-gateway-v2-2026-10-02.md](codex-rfx-gateway-v2-2026-10-02.md) | — | 2026-10-02 | 52 |
| VAULT-01 | W-VAULT01-BIND-1 — implementation receipt | [W-VAULT01-BIND-1-receipt.md](W-VAULT01-BIND-1-receipt.md) | IMPLEMENTED; offline VERIFIED at the listed t… | 2026-09-25 | 16 |
| VFY-REG-FLAKE-CHECK | parser-budgets.test.ts re-run in isolation | [tester-vfy-reg-flake-check-2026-10-02.md](tester-vfy-reg-flake-check-2026-10-02.md) | verification only. Read-only: no test, code o… | 2026-10-02 | 84 |
| VFY-REG-FLAKE-FIX | de-flake parser-budgets.test.ts (TEST-ONLY) | [qwen-vfy-reg-flake-fix-2026-10-02.md](qwen-vfy-reg-flake-fix-2026-10-02.md) | applied and verified. No gate ticked; no comm… | 2026-10-02 | 71 |
| W26-CC | Wave 26 — Command Code lane (W26-CC) report | [command-code.md](command-code.md) | — | 2026-09-22 | 2207 |
| W37-A6 | Antigravity-6 Report — Wave 37 (W37-A6) | [antigravity-6.md](antigravity-6.md) | — | 2026-09-23 | 10371 |
| W39-CX | Codex Lane Report â€” P0-01 then P0-03 | [codex.md](codex.md) | — | — | 183 |
| W40-O | OpenClaude report — W40-O (2026-09-23, IN PROGRESS) | [openclaude.md](openclaude.md) | — | 2026-09-23 | 3049 |
| W43-Q2 | Qwen-2 — Functional Testing Lane (W43-Q2) | [qwen2.md](qwen2.md) | — | — | 1365 |
| W47-C2X2 | declaration-line citation correction | [codex2.md](codex2.md) | — | 2026-09-24 | 814 |
| W48-A6fb2 | Tester report ??? W48-A6fb2 | [tester.md](tester.md) | — | 2026-09-25 | 12419 |
| W48-C1 | Claude lane report — W48-C1 admin audit ledger (REAL, không place… | [claude2.md](claude2.md) | — | 2026-09-25 | 181 |
| W48-C19 | STATUS (W48-C18 A+B+C per-HIGH): (a) HIGH security carry-forward … | [claude.md](claude.md) | — | 2026-09-24 | 1386 |
| W48-CX4 | P8-06 OPS-08 | [codex4.md](codex4.md) | — | 2026-09-24 | 544 |
| W48-CX5 | P8-07 progress | [codex5.md](codex5.md) | — | — | 260 |
| W48-CXNEW | Coder 5 status | [codex-new.md](codex-new.md) | — | 2026-09-24 | 801 |
| WORKER-SPLIT-PREP | evidence for the worker.ts decision (READ-ONLY) | [qwen-worker-split-prep-2026-10-02.md](qwen-worker-split-prep-2026-10-02.md) | analysis only. No source, test or guard was m… | 2026-10-02 | 113 |
| — | ACUI-DEC-PREP — admin-surface decision pack | [codex-acui-decision-pack-2026-10-02.md](codex-acui-decision-pack-2026-10-02.md) | — | 2026-10-02 | 90 |
| — | Scope and finding | [codex-billing-spending-wire-contract-2026-10-01.md](codex-billing-spending-wire-contract-2026-10-01.md) | — | 2026-10-01 | 119 |
| — | CANCELREQUESTED — rework code-path characterization | [codex-cancel-requested-state-characterization-2026-10-01.md](codex-cancel-requested-state-characterization-2026-10-01.md) | — | 2026-10-01 | 74 |
| — | COMP-01 Slice A — Legacy Route Shape Matrix (READ-ONLY) | [codex-comp01-slice-a-legacy-route-matrix-2026-10-02.md](codex-comp01-slice-a-legacy-route-matrix-2026-10-02.md) | characterization only; no source, gate, or ta… | 2026-10-02 | 150 |
| — | COMP-01 Slice D — Legacy Lifecycle & List/Pagination Semantics (R… | [codex-comp01-slice-d-lifecycle-pagination-2026-10-02.md](codex-comp01-slice-d-lifecycle-pagination-2026-10-02.md) | characterization only. No source, gate, or ta… | 2026-10-02 | 112 |
| — | COMP-01 Slice G — workflow-schema + services/billing deep matrix … | [codex-comp01-slice-g-workflow-schema-services-billing-2026-10-02.md](codex-comp01-slice-g-workflow-schema-services-billing-2026-10-02.md) | characterization only. | 2026-10-02 | 256 |
| — | Connector capability / task-name enforcement — options memo (READ… | [codex-connector-enforcement-options-2026-10-02.md](codex-connector-enforcement-options-2026-10-02.md) | — | 2026-10-02 | 223 |
| — | Discovery Surface Inventory: Legacy GET /api/v1/services vs Rework | [codex-discovery-surface-inventory-2026-10-01.md](codex-discovery-surface-inventory-2026-10-01.md) | — | 2026-10-01 | 149 |
| — | Document-core missing variants (COMP-04b) | [codex-document-core-missing-variants-2026-10-01.md](codex-document-core-missing-variants-2026-10-01.md) | — | 2026-10-01 | 135 |
| — | Rework URL-fetch guard inventory — 2026-10-01 | [codex-egress-url-guard-inventory-2026-10-01.md](codex-egress-url-guard-inventory-2026-10-01.md) | — | 2026-10-01 | 57 |
| — | Scope and finding | [codex-error-envelope-wire-contract-2026-10-01.md](codex-error-envelope-wire-contract-2026-10-01.md) | — | 2026-10-01 | 88 |
| — | Added fixture cases | [codex-f8-missing-variant-fixtures-2026-10-02.md](codex-f8-missing-variant-fixtures-2026-10-02.md) | — | 2026-10-02 | 52 |
| — | FUNCTEST-A — offline functional test receipt | [codex-functest-a-contracts-sdk-2026-10-02.md](codex-functest-a-contracts-sdk-2026-10-02.md) | — | 2026-10-02 | 180 |
| — | FUNCTEST-B Orchestrator Offline Receipt — 2026-10-02 | [codex-functest-b-orchestrator-offline-2026-10-02.md](codex-functest-b-orchestrator-offline-2026-10-02.md) | — | 2026-10-02 | 171 |
| — | FUNCTEST-C — connector offline functional test receipt | [codex-functest-c-connector-offline-2026-10-02.md](codex-functest-c-connector-offline-2026-10-02.md) | — | 2026-10-02 | 57 |
| — | Legacy API-key and user-management journeys | [codex-legacy-apikey-user-admin-journeys-2026-10-01.md](codex-legacy-apikey-user-admin-journeys-2026-10-01.md) | — | 2026-10-01 | 111 |
| — | Legacy connector, profile, override, and schema-builder admin jou… | [codex-legacy-connector-profile-admin-journeys-2026-10-01.md](codex-legacy-connector-profile-admin-journeys-2026-10-01.md) | — | 2026-10-01 | 85 |
| — | Legacy demo/orphan surface reachability inventory | [codex-legacy-demo-orphan-reachability-2026-10-01.md](codex-legacy-demo-orphan-reachability-2026-10-01.md) | — | 2026-10-01 | 49 |
| — | Legacy Demo and Orphan-Surface Characterization | [codex-legacy-demo-orphan-surfaces-2026-10-01.md](codex-legacy-demo-orphan-surfaces-2026-10-01.md) | — | 2026-10-01 | 54 |
| — | Legacy External-API Step Call Wire | [codex-legacy-external-api-call-wire-2026-10-01.md](codex-legacy-external-api-call-wire-2026-10-01.md) | — | 2026-10-01 | 83 |
| — | Legacy Ops-Admin, Settings, and Observability Journeys | [codex-legacy-opsadmin-settings-journeys-2026-10-01.md](codex-legacy-opsadmin-settings-journeys-2026-10-01.md) | — | 2026-10-01 | 96 |
| — | Legacy Parser and Ingest/Extract Routing Characterization — 2026-… | [codex-legacy-parsers-ingest-parse-wire-2026-10-01.md](codex-legacy-parsers-ingest-parse-wire-2026-10-01.md) | — | 2026-10-01 | 128 |
| — | Legacy Pipeline Step-Chain and Session Chaining (2026-10-01) | [codex-legacy-pipeline-session-chain-2026-10-01.md](codex-legacy-pipeline-session-chain-2026-10-01.md) | — | 2026-10-01 | 92 |
| — | Legacy workflow process names - evidence memo | [codex-legacy-process-name-evidence-2026-10-02.md](codex-legacy-process-name-evidence-2026-10-02.md) | — | 2026-10-02 | 52 |
| — | Legacy Progress and Step-Timeline Wire (2026-10-01) | [codex-legacy-progress-step-timeline-wire-2026-10-01.md](codex-legacy-progress-step-timeline-wire-2026-10-01.md) | — | 2026-10-01 | 66 |
| — | Legacy rate limiting and operations list query surface | [codex-legacy-ratelimit-list-query-surface-2026-10-01.md](codex-legacy-ratelimit-list-query-surface-2026-10-01.md) | — | 2026-10-01 | 68 |
| — | Legacy Storage Engine, FileCache, and Rework Artifact Model | [codex-legacy-storage-engine-filecache-2026-10-01.md](codex-legacy-storage-engine-filecache-2026-10-01.md) | — | 2026-10-01 | 82 |
| — | Legacy Submit Idempotency and Sync Wire Contract (2026-10-01) | [codex-legacy-submit-idempotency-sync-wire-2026-10-01.md](codex-legacy-submit-idempotency-sync-wire-2026-10-01.md) | — | 2026-10-01 | 77 |
| — | Legacy Worker Runtime: Retry, Pause, Shutdown, and Lease Recovery | [codex-legacy-worker-runtime-lifecycle-2026-10-01.md](codex-legacy-worker-runtime-lifecycle-2026-10-01.md) | — | 2026-10-01 | 53 |
| — | Legacy workflow run wire and HITL pause/resume characterization | [codex-legacy-workflow-hitl-run-wire-2026-10-01.md](codex-legacy-workflow-hitl-run-wire-2026-10-01.md) | — | 2026-10-01 | 58 |
| — | Local Admin authentication cutover characterization (read-only) | [codex-local-auth-cutover-characterization-2026-10-01.md](codex-local-auth-cutover-characterization-2026-10-01.md) | — | 2026-10-01 | 72 |
| — | Operation surface cache and conditional-request semantics — 2026-… | [codex-operation-surface-cache-semantics-2026-10-01.md](codex-operation-surface-cache-semantics-2026-10-01.md) | — | 2026-10-01 | 53 |
| — | Operations lifecycle + list — golden-fixture assertion spec | [codex-operations-lifecycle-golden-fixture-assertions-2026-10-01.md](codex-operations-lifecycle-golden-fixture-assertions-2026-10-01.md) | — | 2026-10-01 | 60 |
| — | OPT-ADMIN-API — Admin UI affordance × handler inventory | [codex-opt-admin-api-gaps-2026-10-02.md](codex-opt-admin-api-gaps-2026-10-02.md) | — | 2026-10-02 | 103 |
| — | Progress / method | [codex-opt-perf-02-crypto-bench-2026-10-02.md](codex-opt-perf-02-crypto-bench-2026-10-02.md) | — | 2026-10-02 | 36 |
| — | ORCH-PAR-00 Admin/operator journey inventory | [codex-orch-par-00-admin-operator-journeys-2026-10-02.md](codex-orch-par-00-admin-operator-journeys-2026-10-02.md) | — | 2026-10-02 | 46 |
| — | Result | [codex-p9-01-disbursement-handler-registration-2026-10-01.md](codex-p9-01-disbursement-handler-registration-2026-10-01.md) | — | 2026-10-01 | 61 |
| — | 1. Workflow route trace and exact 503 condition | [codex-p9-workflow-integration-spec-2026-10-02.md](codex-p9-workflow-integration-spec-2026-10-02.md) | — | 2026-10-02 | 90 |
| — | FUNCTEST-B RED-EVIDENCE — isolated reruns and production trace | [codex-red-evidence-functest-b-2026-10-02.md](codex-red-evidence-functest-b-2026-10-02.md) | — | 2026-10-02 | 111 |
| — | Result-Delivery Encryption Wire Characterization (2026-10-01) | [codex-result-delivery-encryption-wire-2026-10-01.md](codex-result-delivery-encryption-wire-2026-10-01.md) | — | 2026-10-01 | 54 |
| — | Retention, soft-delete, and post-delete visibility characterizati… | [codex-retention-softdelete-visibility-2026-10-01.md](codex-retention-softdelete-visibility-2026-10-01.md) | — | 2026-10-01 | 61 |
| — | COMP-03b-adjacent — strict legacy input decoder + legacy operatio… | [codex-rework-compat-decoders-2026-10-01.md](codex-rework-compat-decoders-2026-10-01.md) | PURE, UNMOUNTED, UNFROZEN. No route mount, no… | 2026-10-01 | 94 |
| — | Secret provenance review - offline | [codex-secret-provenance-2026-10-02.md](codex-secret-provenance-2026-10-02.md) | — | 2026-10-02 | 19 |
| — | Independent verification: COMP-03b compatibility decoders | [codex-verify-compat-decoders-2026-10-01.md](codex-verify-compat-decoders-2026-10-01.md) | — | 2026-10-01 | 72 |
| — | Webhook URL wire contract — legacy vs rework (2026-10-01) | [codex-webhook-wire-contract-2026-10-01.md](codex-webhook-wire-contract-2026-10-01.md) | — | 2026-10-01 | 104 |
| — | Coordinator Antigravity — Coordination Ledger & Roster | [coordinator-antigravity.md](coordinator-antigravity.md) | — | 2026-09-26 | 5856 |
| — | Coordinator Claude Code — Coordination Ledger & Roster | [coordinator-claude.md](coordinator-claude.md) | — | 2026-09-26 | 777 |
| — | Coordinator Qwen (phiên mới) — lane report & resume point | [coordinator-qwen.md](coordinator-qwen.md) | — | 2026-09-25 | 139 |
| — | Coordination Report — Copilot Connector lane (wave-05 takeover) | [copilot.md](copilot.md) | COMPLETE (P3-01..08 + P2-08 adoption) | 2026-09-21 | 114 |
| — | Integration usage report | [integration-usage.md](integration-usage.md) | — | — | 48 |
| — | Open-task register - 2026-10-03 | [plan-open-task-register-2026-10-03.md](plan-open-task-register-2026-10-03.md) | — | 2026-10-03 | 483 |
| — | Báo cáo lane Qwen-Admin — Admin Ops UI Implementer | [qwen-admin.md](qwen-admin.md) | — | — | 6614 |
| — | COMP00-EVIDENCE-BRIEF — receipts vs 5 COMP-00 decisions | [qwen-comp00-evidence-brief-2026-10-02.md](qwen-comp00-evidence-brief-2026-10-02.md) | — | 2026-10-02 | 119 |
| — | COMP01-CONSOLIDATE — đối chiếu 8 receipts với acceptance COMP-01 | [qwen-comp01-consolidate-2026-10-02.md](qwen-comp01-consolidate-2026-10-02.md) | synthesis only, read-only. | 2026-10-02 | 232 |
| — | COMP01-G34 — binary side-by-side + per-route error matrix | [qwen-comp01-g34-binary-error-matrix-2026-10-02.md](qwen-comp01-g34-binary-error-matrix-2026-10-02.md) | receipts-first synthesis, read-only. No gate … | 2026-10-02 | 160 |
| — | COMP01-Q15 — consumer inventory scan (read-only) | [qwen-comp01-q15-consumer-inventory-2026-10-02.md](qwen-comp01-q15-consumer-inventory-2026-10-02.md) | read-only scan. No gate ticked, no commit, no… | 2026-10-02 | 207 |
| — | 2c implemented — provider rejection separated from malformed prov… | [qwen-connector-enforcement-2c-2026-10-02.md](qwen-connector-enforcement-2c-2026-10-02.md) | — | 2026-10-02 | 125 |
| — | Audit — consumer so sánh INVALIDPROVIDERRESPONSE sau 2c | [qwen-connector-error-code-consumer-audit-2026-10-02.md](qwen-connector-error-code-consumer-audit-2026-10-02.md) | — | 2026-10-02 | 149 |
| — | Lane Qwen-DATA — receipt ledger (du-rework) | [qwen-data.md](qwen-data.md) | — | 2026-09-26 | 720 |
| — | qwen-docs — lane docs/evidence (Qwen-Docs) — receipt log | [qwen-docs.md](qwen-docs.md) | — | — | 4733 |
| — | FENCE-TEST-ALIGN — x-api-key fence assertion was stale, not the f… | [qwen-fence-test-align-2026-10-02.md](qwen-fence-test-align-2026-10-02.md) | — | 2026-10-02 | 82 |
| — | qwen-new — lane docs/evidence (kế thừa Codex-4) — receipt log | [qwen-new.md](qwen-new.md) | — | 2026-09-25 | 102 |
| — | Qwen-Platform lane — receipts | [qwen-platform.md](qwen-platform.md) | — | 2026-09-28 | 5773 |
| — | Báo cáo lane Qwen-SEC (OIDC / session store) | [qwen-sec.md](qwen-sec.md) | — | 2026-09-26 | 584 |
| — | Báo cáo lane Qwen-Vault (Security & Vault Implementer) | [qwen-vault.md](qwen-vault.md) | — | 2026-09-26 | 204 |
| — | Qwen-5 (Implement) — lane report | [qwen5.md](qwen5.md) | — | 2026-09-24 | 236 |
| — | Qwen-5R (Implement) — lane report (kế thừa termf24ec5cb / Qwen-5) | [qwen5r.md](qwen5r.md) | — | 2026-09-25 | 88 |
| — | Báo cáo review full luồng core request — du-rework | [review-core-flow-2026-10-02.md](review-core-flow-2026-10-02.md) | — | 2026-10-02 | 113 |
| — | Turn 201 appendix — do not commit standalone; appended into revie… | [review-ORCH-0019-append.md](review-ORCH-0019-append.md) | — | 2026-09-27 | 54 |
| — | (khong co tieu de) | [review-security-compat-2026-10-02.md](review-security-compat-2026-10-02.md) | — | 2026-10-02 | 333 |
| — | Reviewer Codex-3 — periodic review 6/6 | [review.md](review.md) | — | 2026-09-26 | 1183 |
| — | Admin operations-list fence red — independent verification | [tester-admin-fence-red-verify-2026-10-02.md](tester-admin-fence-red-verify-2026-10-02.md) | — | 2026-10-02 | 64 |
| — | Antigravity Tester — Status & Test Execution Log | [tester-antigravity.md](tester-antigravity.md) | — | 2026-09-25 | 160 |
| — | FENCE-RED re-verify — current-source result | [tester-fence-red-reverify-2026-10-02.md](tester-fence-red-reverify-2026-10-02.md) | — | 2026-10-02 | 93 |
| — | Post-commit offline regression baseline — 2026-10-02 | [tester-postcommit-offline-2026-10-02.md](tester-postcommit-offline-2026-10-02.md) | — | 2026-10-02 | 38 |
| — | Secret-hygiene sweep — 2026-10-02 | [tester-secret-sweep-2026-10-02.md](tester-secret-sweep-2026-10-02.md) | — | 2026-10-02 | 149 |
| — | VFY-REG offline verification — document-core + Worker SDK | [tester-vfy-reg-offline-2026-10-02.md](tester-vfy-reg-offline-2026-10-02.md) | — | 2026-10-02 | 114 |
| — | VFY-REG offline refresh — current working tree | [tester-vfy-reg-refresh-2026-10-02.md](tester-vfy-reg-refresh-2026-10-02.md) | — | 2026-10-02 | 74 |
| — | WSD-SYNCPOST-VERIFY — independent offline receipt | [tester-wsd-syncpost-verify-2026-10-02.md](tester-wsd-syncpost-verify-2026-10-02.md) | — | 2026-10-02 | 69 |
| — | Tester-2 Test Receipt - Cycle 102 | [tester2.md](tester2.md) | — | 2026-09-25 | 254 |
| — | Tester-3 Offline Package Receipt | [tester3.md](tester3.md) | — | 2026-09-25 | 85 |

## 2. Lane ledger (file ten don, append-only theo chu ky)

| File | Chu de | Ngay | Dong |
|---|---|---|---:|
| [tester.md](tester.md) | Tester report ??? W48-A6fb2 | 2026-09-25 | 12419 |
| [antigravity-6.md](antigravity-6.md) | Antigravity-6 Report — Wave 37 (W37-A6) | 2026-09-23 | 10371 |
| [qwen-admin.md](qwen-admin.md) | Báo cáo lane Qwen-Admin — Admin Ops UI Implementer | — | 6614 |
| [coordinator-antigravity.md](coordinator-antigravity.md) | Coordinator Antigravity — Coordination Ledger & Roster | 2026-09-26 | 5856 |
| [qwen-platform.md](qwen-platform.md) | Qwen-Platform lane — receipts | 2026-09-28 | 5773 |
| [qwen-docs.md](qwen-docs.md) | qwen-docs — lane docs/evidence (Qwen-Docs) — receipt log | — | 4733 |
| [openclaude.md](openclaude.md) | OpenClaude report — W40-O (2026-09-23, IN PROGRESS) | 2026-09-23 | 3049 |
| [qwen3.md](qwen3.md) | QWEN-3 — BUGFIX lane (W43-B1 → W49-Q3-2) | 2026-09-25 | 2902 |
| [command-code.md](command-code.md) | Wave 26 — Command Code lane (W26-CC) report | 2026-09-22 | 2207 |
| [qwen1.md](qwen1.md) | QWEN-1 — Backend/Platform lane (R2-A: Admin audit atomicity + tenant auth… | 2026-09-25 | 1755 |
| [claude.md](claude.md) | W48-C19 STATUS (W48-C18 A+B+C per-HIGH): (a) HIGH security carry-forward … | 2026-09-24 | 1386 |
| [qwen2.md](qwen2.md) | Qwen-2 — Functional Testing Lane (W43-Q2) | — | 1365 |
| [review.md](review.md) | Reviewer Codex-3 — periodic review 6/6 | 2026-09-26 | 1183 |
| [codex2.md](codex2.md) | W47-C2X2 - declaration-line citation correction | 2026-09-24 | 814 |
| [codex-new.md](codex-new.md) | W48-CXNEW — Coder 5 status | 2026-09-24 | 801 |
| [coordinator-claude.md](coordinator-claude.md) | Coordinator Claude Code — Coordination Ledger & Roster | 2026-09-26 | 777 |
| [qwen4.md](qwen4.md) | QWEN-4 — DATA-01..04 S3 Streaming lane (review + offline verify) | 2026-09-25 | 754 |
| [qwen-data.md](qwen-data.md) | Lane Qwen-DATA — receipt ledger (du-rework) | 2026-09-26 | 720 |
| [qwen-sec.md](qwen-sec.md) | Báo cáo lane Qwen-SEC (OIDC / session store) | 2026-09-26 | 584 |
| [codex4.md](codex4.md) | W48-CX4 — P8-06 OPS-08 | 2026-09-24 | 544 |
| [codex6.md](codex6.md) | Codex-6 Receipt — SEC-00 / VAULT-05, Reviewer Finding 1 (Cycle 126+) | 2026-09-25 | 425 |
| [qwen-cost.md](qwen-cost.md) | Receipt lane Qwen-Cost (COST-01..04 / token ledger / LOG-01..02) | — | 334 |
| [codex3.md](codex3.md) | CODEX-3 — REVIEW lane, W43-R7 | 2026-09-24 | 293 |
| [antigravity.md](antigravity.md) | Wave 36-A: P6-06 Pure Operation Detail, Result, Artifacts, Cancel, Resume… | 2026-09-22 | 288 |
| [codex5.md](codex5.md) | W48-CX5 — P8-07 progress | — | 260 |
| [tester2.md](tester2.md) | Tester-2 Test Receipt - Cycle 102 | 2026-09-25 | 254 |
| [qwen5.md](qwen5.md) | Qwen-5 (Implement) — lane report | 2026-09-24 | 236 |
| [qwen-vault.md](qwen-vault.md) | Báo cáo lane Qwen-Vault (Security & Vault Implementer) | 2026-09-26 | 204 |
| [codex.md](codex.md) | W39-CX Codex Lane Report â€” P0-01 then P0-03 | — | 183 |
| [qwen4r.md](qwen4r.md) | QWEN-4R — lane đo RSS DATA-04 + memo parseFile (thay lane Qwen-4, kẹt kên… | 2026-09-25 | 183 |
| [claude2.md](claude2.md) | Claude lane report — W48-C1 admin audit ledger (REAL, không placeholder) | 2026-09-25 | 181 |
| [tester-antigravity.md](tester-antigravity.md) | Antigravity Tester — Status & Test Execution Log | 2026-09-25 | 160 |
| [coordinator-qwen.md](coordinator-qwen.md) | Coordinator Qwen (phiên mới) — lane report & resume point | 2026-09-25 | 139 |
| [copilot.md](copilot.md) | Coordination Report — Copilot Connector lane (wave-05 takeover) | 2026-09-21 | 114 |
| [qwen4-handoff.md](qwen4-handoff.md) | QWEN-4 HANDOFF — 2026-09-25 ~10:00Z | 2026-09-25 | 110 |
| [qwen-new.md](qwen-new.md) | qwen-new — lane docs/evidence (kế thừa Codex-4) — receipt log | 2026-09-25 | 102 |
| [qwen5r.md](qwen5r.md) | Qwen-5R (Implement) — lane report (kế thừa termf24ec5cb / Qwen-5) | 2026-09-25 | 88 |
| [tester3.md](tester3.md) | Tester-3 Offline Package Receipt | 2026-09-25 | 85 |
| [integration-usage.md](integration-usage.md) | Integration usage report | — | 48 |
| [codex-lint-probe.md](codex-lint-probe.md) | D-LINT-ORCH-1 — Codex lint probe | 2026-09-25 | 35 |

## 3. File > 2.000 dong — CHI LIET KE, KHONG CAT

| File | Dong | Ghi chu |
|---|---:|---|
| [tester.md](tester.md) | 12419 | receipt/history append-only — giu nguyen ban goc |
| [antigravity-6.md](antigravity-6.md) | 10371 | receipt/history append-only — giu nguyen ban goc |
| [qwen-admin.md](qwen-admin.md) | 6614 | receipt/history append-only — giu nguyen ban goc |
| [coordinator-antigravity.md](coordinator-antigravity.md) | 5856 | receipt/history append-only — giu nguyen ban goc |
| [qwen-platform.md](qwen-platform.md) | 5773 | receipt/history append-only — giu nguyen ban goc |
| [qwen-docs.md](qwen-docs.md) | 4733 | receipt/history append-only — giu nguyen ban goc |
| [openclaude.md](openclaude.md) | 3049 | receipt/history append-only — giu nguyen ban goc |
| [qwen3.md](qwen3.md) | 2902 | receipt/history append-only — giu nguyen ban goc |
| [command-code.md](command-code.md) | 2207 | receipt/history append-only — giu nguyen ban goc |

_Ly do khong cat:_ receipt la bang chung hien trang; cat se pha lien ket muc, receipt ID va anchor dang tro. Muon giam dong thi tach bang **index/summary moi** (task rieng, owner rieng), khong sua file goc.

## 4. Khoang trong du lieu (khong bia gia tri cho phan thieu)

| Tieu chi | Co | Khong co |
|---|---:|---:|
| Task ID | 101 | 81 |
| Trang thai khai bao | 31 | 151 |
| Ngay | 172 | 10 |

**81 file khong co Task ID** (khong tu dien ID de tranh gia):

- `qwen-admin.md` — Báo cáo lane Qwen-Admin — Admin Ops UI Implementer
- `coordinator-antigravity.md` — Coordinator Antigravity — Coordination Ledger & Roster
- `qwen-platform.md` — Qwen-Platform lane — receipts
- `qwen-docs.md` — qwen-docs — lane docs/evidence (Qwen-Docs) — receipt log
- `review.md` — Reviewer Codex-3 — periodic review 6/6
- `coordinator-claude.md` — Coordinator Claude Code — Coordination Ledger & Roster
- `qwen-data.md` — Lane Qwen-DATA — receipt ledger (du-rework)
- `qwen-sec.md` — Báo cáo lane Qwen-SEC (OIDC / session store)
- `plan-open-task-register-2026-10-03.md` — Open-task register - 2026-10-03
- `review-security-compat-2026-10-02.md` — (khong co tieu de)
- `codex-comp01-slice-g-workflow-schema-services-billing-2026-10-02.md` — COMP-01 Slice G — workflow-schema + services/billing deep matrix (fie…
- `tester2.md` — Tester-2 Test Receipt - Cycle 102
- `qwen5.md` — Qwen-5 (Implement) — lane report
- `qwen-comp01-consolidate-2026-10-02.md` — COMP01-CONSOLIDATE — đối chiếu 8 receipts với acceptance COMP-01
- `codex-connector-enforcement-options-2026-10-02.md` — Connector capability / task-name enforcement — options memo (READ-ONL…
- `qwen-comp01-q15-consumer-inventory-2026-10-02.md` — COMP01-Q15 — consumer inventory scan (read-only)
- `qwen-vault.md` — Báo cáo lane Qwen-Vault (Security & Vault Implementer)
- `codex-functest-a-contracts-sdk-2026-10-02.md` — FUNCTEST-A — offline functional test receipt
- `codex-functest-b-orchestrator-offline-2026-10-02.md` — FUNCTEST-B Orchestrator Offline Receipt — 2026-10-02
- `qwen-comp01-g34-binary-error-matrix-2026-10-02.md` — COMP01-G34 — binary side-by-side + per-route error matrix
- `tester-antigravity.md` — Antigravity Tester — Status & Test Execution Log
- `codex-comp01-slice-a-legacy-route-matrix-2026-10-02.md` — COMP-01 Slice A — Legacy Route Shape Matrix (READ-ONLY)
- `codex-discovery-surface-inventory-2026-10-01.md` — Discovery Surface Inventory: Legacy GET /api/v1/services vs Rework
- `qwen-connector-error-code-consumer-audit-2026-10-02.md` — Audit — consumer so sánh INVALIDPROVIDERRESPONSE sau 2c
- `tester-secret-sweep-2026-10-02.md` — Secret-hygiene sweep — 2026-10-02
- `coordinator-qwen.md` — Coordinator Qwen (phiên mới) — lane report & resume point
- `codex-document-core-missing-variants-2026-10-01.md` — Document-core missing variants (COMP-04b)
- `codex-legacy-parsers-ingest-parse-wire-2026-10-01.md` — Legacy Parser and Ingest/Extract Routing Characterization — 2026-10-01
- `qwen-connector-enforcement-2c-2026-10-02.md` — 2c implemented — provider rejection separated from malformed provider…
- `codex-billing-spending-wire-contract-2026-10-01.md` — Scope and finding
- `qwen-comp00-evidence-brief-2026-10-02.md` — COMP00-EVIDENCE-BRIEF — receipts vs 5 COMP-00 decisions
- `copilot.md` — Coordination Report — Copilot Connector lane (wave-05 takeover)
- `tester-vfy-reg-offline-2026-10-02.md` — VFY-REG offline verification — document-core + Worker SDK
- `review-core-flow-2026-10-02.md` — Báo cáo review full luồng core request — du-rework
- `codex-comp01-slice-d-lifecycle-pagination-2026-10-02.md` — COMP-01 Slice D — Legacy Lifecycle & List/Pagination Semantics (READ-…
- `codex-legacy-apikey-user-admin-journeys-2026-10-01.md` — Legacy API-key and user-management journeys
- `codex-red-evidence-functest-b-2026-10-02.md` — FUNCTEST-B RED-EVIDENCE — isolated reruns and production trace
- `codex-webhook-wire-contract-2026-10-01.md` — Webhook URL wire contract — legacy vs rework (2026-10-01)
- `codex-opt-admin-api-gaps-2026-10-02.md` — OPT-ADMIN-API — Admin UI affordance × handler inventory
- `qwen-new.md` — qwen-new — lane docs/evidence (kế thừa Codex-4) — receipt log
- `codex-legacy-opsadmin-settings-journeys-2026-10-01.md` — Legacy Ops-Admin, Settings, and Observability Journeys
- `codex-rework-compat-decoders-2026-10-01.md` — COMP-03b-adjacent — strict legacy input decoder + legacy operation se…
- `tester-fence-red-reverify-2026-10-02.md` — FENCE-RED re-verify — current-source result
- `codex-legacy-pipeline-session-chain-2026-10-01.md` — Legacy Pipeline Step-Chain and Session Chaining (2026-10-01)
- `codex-acui-decision-pack-2026-10-02.md` — ACUI-DEC-PREP — admin-surface decision pack
- `codex-p9-workflow-integration-spec-2026-10-02.md` — 1. Workflow route trace and exact 503 condition
- `codex-error-envelope-wire-contract-2026-10-01.md` — Scope and finding
- `qwen5r.md` — Qwen-5R (Implement) — lane report (kế thừa termf24ec5cb / Qwen-5)
- `codex-legacy-connector-profile-admin-journeys-2026-10-01.md` — Legacy connector, profile, override, and schema-builder admin journeys
- `tester3.md` — Tester-3 Offline Package Receipt
- `codex-legacy-external-api-call-wire-2026-10-01.md` — Legacy External-API Step Call Wire
- `codex-legacy-storage-engine-filecache-2026-10-01.md` — Legacy Storage Engine, FileCache, and Rework Artifact Model
- `qwen-fence-test-align-2026-10-02.md` — FENCE-TEST-ALIGN — x-api-key fence assertion was stale, not the fence
- `codex-legacy-submit-idempotency-sync-wire-2026-10-01.md` — Legacy Submit Idempotency and Sync Wire Contract (2026-10-01)
- `codex-cancel-requested-state-characterization-2026-10-01.md` — CANCELREQUESTED — rework code-path characterization
- `tester-vfy-reg-refresh-2026-10-02.md` — VFY-REG offline refresh — current working tree
- `codex-local-auth-cutover-characterization-2026-10-01.md` — Local Admin authentication cutover characterization (read-only)
- `codex-verify-compat-decoders-2026-10-01.md` — Independent verification: COMP-03b compatibility decoders
- `tester-wsd-syncpost-verify-2026-10-02.md` — WSD-SYNCPOST-VERIFY — independent offline receipt
- `codex-legacy-ratelimit-list-query-surface-2026-10-01.md` — Legacy rate limiting and operations list query surface
- `codex-legacy-progress-step-timeline-wire-2026-10-01.md` — Legacy Progress and Step-Timeline Wire (2026-10-01)
- `tester-admin-fence-red-verify-2026-10-02.md` — Admin operations-list fence red — independent verification
- `codex-p9-01-disbursement-handler-registration-2026-10-01.md` — Result
- `codex-retention-softdelete-visibility-2026-10-01.md` — Retention, soft-delete, and post-delete visibility characterization
- `codex-operations-lifecycle-golden-fixture-assertions-2026-10-01.md` — Operations lifecycle + list — golden-fixture assertion spec
- `codex-legacy-workflow-hitl-run-wire-2026-10-01.md` — Legacy workflow run wire and HITL pause/resume characterization
- `codex-egress-url-guard-inventory-2026-10-01.md` — Rework URL-fetch guard inventory — 2026-10-01
- `codex-functest-c-connector-offline-2026-10-02.md` — FUNCTEST-C — connector offline functional test receipt
- `codex-legacy-demo-orphan-surfaces-2026-10-01.md` — Legacy Demo and Orphan-Surface Characterization
- `codex-result-delivery-encryption-wire-2026-10-01.md` — Result-Delivery Encryption Wire Characterization (2026-10-01)
- `review-ORCH-0019-append.md` — Turn 201 appendix — do not commit standalone; appended into review.md…
- `codex-legacy-worker-runtime-lifecycle-2026-10-01.md` — Legacy Worker Runtime: Retry, Pause, Shutdown, and Lease Recovery
- `codex-operation-surface-cache-semantics-2026-10-01.md` — Operation surface cache and conditional-request semantics — 2026-10-01
- `codex-f8-missing-variant-fixtures-2026-10-02.md` — Added fixture cases
- `codex-legacy-process-name-evidence-2026-10-02.md` — Legacy workflow process names - evidence memo
- `codex-legacy-demo-orphan-reachability-2026-10-01.md` — Legacy demo/orphan surface reachability inventory
- `integration-usage.md` — Integration usage report
- `codex-orch-par-00-admin-operator-journeys-2026-10-02.md` — ORCH-PAR-00 Admin/operator journey inventory
- `tester-postcommit-offline-2026-10-02.md` — Post-commit offline regression baseline — 2026-10-02
- `codex-opt-perf-02-crypto-bench-2026-10-02.md` — Progress / method
- `codex-secret-provenance-2026-10-02.md` — Secret provenance review - offline

## 5. Phan bo theo lane/nguon

| Lane | So file |
|---|---:|
| codex | 85 |
| qwen | 37 |
| tester | 23 |
| coordinator | 3 |
| review | 3 |
| antigravity | 2 |
| cmdcomp01 | 2 |
| qwen4 | 2 |
| cc | 1 |
| claude | 1 |
| claude2 | 1 |
| cmdcomp09 | 1 |
| codex2 | 1 |
| codex3 | 1 |
| codex4 | 1 |
| codex5 | 1 |
| codex6 | 1 |
| command | 1 |
| comp | 1 |
| copilot | 1 |
| integration | 1 |
| openclaude | 1 |
| plan | 1 |
| qwen1 | 1 |
| qwen2 | 1 |
| qwen3 | 1 |
| qwen4r | 1 |
| qwen5 | 1 |
| qwen5r | 1 |
| review-ORCH-0019-append | 1 |
| tester2 | 1 |
| tester3 | 1 |
| W-VAULT01-BIND-1-receipt | 1 |

## 6. Truy xuat

- Tat ca 182 link la relative tu `coordination/reports/`; file o thu muc khac dung ``(ten-file)`.
- File can sua/bo sung: them muc o day **va** them file goc; khong sua dong cu lam mat tro.
- File sinh sau moc thoi gian nay chua co trong INDEX — can chay lai quy tac muc 0.
