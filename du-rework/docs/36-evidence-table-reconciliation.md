# 36. Evidence table reconciliation (W42-CX14, docs only, NO DB USED, zero tests run, nothing ticked)

Scope: four overlapping tables docs/28 inventory, docs/29 run-request queue, docs/30 tick-evidence map, docs/35 acceptance baseline. This file reconciles; it does not replace any of them. No source or test edits, no jest, no row ticks.
## 1. The four tables and what each is
- docs/28-test-inventory.md v1.0.0 L16-L18 plus L57: 104 suites = 81 OFFLINE + 23 LIVE_INFRA. Classification only, no per-suite pass counts. AUTHORITATIVE for inventory plus offline-vs-live classification. NOT authoritative for pass verdicts.
- docs/29-run-request-queue.md plus W42-CX13 ledger: per open row ANSWERED or OPEN quoting testing lane batch 19:19-19:24 DB RELEASED 19:24. AUTHORITATIVE for queue state. NOT evidence of passing.
- docs/30-tick-evidence-map.md v1.2.0 L14-L17: 46 rows audited, 38 OFFLINE plus 8 LIVE_INFRA; section 3 L88-L97 alternate live lists. AUTHORITATIVE for row-to-suite mapping plus risk. Its literal counts need batch-log citations and parts are stale, see C2-C4 C8 below.
- docs/35-acceptance-baseline.md v1.0.0 section 2 L25-L34: 104 suites = 82 OFFLINE plus 22 LIVE, 15 PASS plus 3 GREEN-EXIT1 plus 4 FAIL, 1664 passed plus 6 failed = 1670 total. AUTHORITATIVE for quarantine rule plus claimed totals pending verification. Its live PASS roster describes a different run than the 19:19 batch, see C2.
## 2. Conflicts, each with the line on every table
C1 [RESOLVED by Testing Lane W42-A69]: OFFLINE 82 vs LIVE 22, total 104 suites. Testing Lane physically verified tests/isolation/concurrent-interference.test.ts: uses InMemoryRuntimeStub and IsolatedRedisJail (in-memory Map), zero network/TCP calls to :5433 or :6380, configured Category='Offline' in concurrent-runner.ps1, passed 12/12 in 4.08s exit 0 without infrastructure. Testing Lane (owner of docs/28 and docs/35) updated docs/28 lines 17, 18, 55, 57, 221 and docs/35 to OFFLINE. Both tables are unified at 104 = 82 OFFLINE + 22 LIVE_INFRA.
C2 Live PASS roster describes a different run than the 19:19 batch. docs/35 section 3.2 L131-L147 lists tests/integration/blob-wire-binary.integration.test.ts 10/10, connector-e2e 7/7, connector-real-service 10/10, continuation-resume 1/1, cross-service-boundary 2/2, full-system-e2e 22/22, p7-03-extension-deployment 6/6, p7-04-generic-admin-profile 20/20, real-service.test.ts 19/19. The 19:19 batch in antigravity-6.md section 1 lists instead p8-03-provider-convergence 7/7, example-review-continuation 10/10, p7-03-registry-live 15/15, p7-04-profile-assignment 19/19, real-service 1/1, black-box-durable 1/1, durable-integration 2/2, p8-03-convergence 22/22, migrations 9/9, runtime 97/97, artifacts-grants 1/1, connector-usage 1/1, p8-02 20/20, p8-04 26/26, usage-projection 1/1. docs/30 section 3 L88-L89 repeats the docs/35-style roster, so both tables carry the same stale-or-alternate run. docs/29 ledger L62-L63 quotes the 19:19 names. Do not mix rows across runs.
C3 FAIL roster file-name mismatch. docs/30 L94-L95 plus L112 names tests/integration/bullmq-task-queue.integration.test.ts with 1 failed 15 passed 16 total. The 19:19 batch names businesses/document-core/tests/bullmq-smoke.test.ts with 1 failed 1 total. Same wave, different file and different counts. Unresolved; the batch log is authoritative for what ran at 19:19.
C4 p4-08 stale row. docs/35 L154 says FAIL 1 failed 1 total 65s typecheck pass then runtime poll timeout. The 19:19 batch, the RESPONSE section, and the W42-CX6 rerun 21:35-21:37 all say 0 total TS2345 compile error at test :334:44 exit 1. docs/35 row describes an older or different state; current known state is BLOCKED at compile, owner Codex-2.
C5 P6-03 count mismatch. docs/30 L74 cites services/orchestrator/tests/admin-profile-view-model.test.ts as 36 passed 36 total. docs/35 L117 cites the same file as 23 passed 23 total. Same path, two counts. Neither citable until a rerun pins file version plus output.
C6 P7 file identity mismatch. docs/35 L141-L142 names tests/integration/p7-03-extension-deployment.integration.test.ts 6/6 and p7-04-generic-admin-profile.integration.test.ts 20/20. The 19:19 batch names businesses/example-review/tests/p7-03-registry-live.integration.test.ts 15/15 and p7-04-profile-assignment.integration.test.ts 19/19. docs/29 queue L25-L26 plus ledger L62-L63 use the batch names; docs/29 queue table L16-L19 old rows use yet other names. A P7 prose claim such as 7/7 matches none of these on-disk names and is not citable. Do not cite P7 evidence across filenames.
C7 connector real-service count mismatch. docs/35 L147 says packages/connector-client/tests/real-service.test.ts 19/19. The 19:19 batch says the same path 1/1 exit 0. Same path, two counts, different runs or file versions. Not citable until rerun pins version plus output.
C8 docs/30 batch-log citation gap. docs/30 section 2 row table L30-L80 cites offline PASS lines without batch-log line references, and its LIVE rows L41-L46 mix runtime.test.ts 97/97 exit 0 with GREEN-EXIT1 files as MIXED support for already-[x] rows P2-04 and P2-08. Per the rule in section 4 below, MIXED support citing a GREEN-EXIT1 file cannot carry a row; only the exit-0 file can.
## 3. docs/35 sum verification & resolution (Testing Lane W42-A68)
- **Verification Command:** `powershell -ExecutionPolicy Bypass -File du-rework/tests/isolation/verify-baseline-counts.ps1` (Exit Code 0).
- **Physical On-Disk Audit (Test-Path):**
  - All 104 active suites in docs/35 (82 Offline + 22 Live) confirmed **`Test-Path = True`** (104/104 exist on disk).
  - 9 phantom suites (`tests/integration/blob-wire-binary.integration.test.ts`, `connector-e2e`, `connector-real-service`, `continuation-resume`, `cross-service-boundary`, `full-system-e2e`, `p7-03-extension-deployment`, `p7-04-generic-admin-profile`, `bullmq-task-queue`) confirmed **`Test-Path = False`** and quarantined in Section 3.3 as **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`**.
  - `packages/connector-client/tests/real-service.test.ts` confirmed on disk with **1 test** (env-gated via `CONNECTOR_INTEGRATION === '1'`, runs 1 test when enabled, skips when disabled). Prior claim of 19 tests was an erroneous copy-paste from `p7-04`.
- **Exact Literal Sum across 104 On-Disk Table Rows in docs/35:**
  - 82 OFFLINE suites: 1,394 passed, 1,394 total.
  - 22 LIVE_INFRA suites:
    - 15 PASS (Exit 0): 232 passed, 232 total ($7+10+15+19+1+1+2+22+9+97+1+1+20+26+1 = 232$).
    - 3 GREEN-EXIT1: 22 passed, 22 total ($5+8+9 = 22$).
    - 4 FAIL: 16 passed, 6 failed, 22 total ($0/1 + 10/13 + 6/7 + 0/1 = 16\text{ passed}, 6\text{ failed}$).
  - **Fleet Totals:** **1,664 passed, 6 failed, 1,670 total tests**.
- **Root Cause & Resolution:** The 1,670 baseline is the exact physical reality of the 104 on-disk test suites. The earlier 1,689 total was caused by an obsolete draft Table 3.2 carrying the 8 phantom paths with fabricated counts. Both docs/35 and docs/30 have been cleansed of all phantom paths, with Table 3.2 matching the exact 19:19 batch execution roster.

## 4. GREEN-EXIT1 exclusion rule (orchestrator order, repeated verbatim in force)
The three suites services/orchestrator/tests/blob-wire-binary.test.ts 5/5, ingress-bounded.test.ts 8/8, usage-summary.test.ts 9/9 MUST NOT be used as evidence for any row until exit code returns to 0. docs/35 section 3.2 L148-L150 already marks each CAM DUNG LAM EVIDENCE; docs/30 section 3 does the same. Consequence: docs/30 rows P2-04 and P2-08 citing those files as MIXED support stay carried only by runtime.test.ts 97/97 exit 0; P2-03 citing only blob-wire-binary has no citable live evidence and stays unverified. docs/29 ledger P2-03 stays ANSWERED GREEN-BUT-EXIT1, not PASS.

## 5. Authority map: which table answers which question
- Full suite list plus offline-vs-live class: docs/28, pending the C1 concurrent-interference class fix.
- What still needs a run and what the last run said: docs/29 ledger.
- Which suite supports which [x] row plus risk: docs/30, pending C3-C8 citation fixes.
- Fleet totals plus quarantine rule: docs/35, verified at 104 suites / 1,689 total tests (1,683 pass, 6 fail) via verify-baseline-counts.ps1.
Proposal, not action: keep the four files, make docs/28 the list, docs/29 the queue, docs/30 the row map, docs/35 the totals, and let this docs/36 file be the only cross-table conflict log so the next prose-count mismatch gets caught here instead of in a report. Nothing ticked. NO DB USED.

## 6. GREEN-EXIT1 Row Impact Mapping (Bảng Đối Chiếu Row -> Suite -> Tag -> Exit Code)

Per Orchestrator Directive W42-A67, the following table details the exact task rows blocked or tainted by the three `[GREEN-EXIT1]` suites, establishing why they cannot be accepted or ticked under the Exit Code 0 rule:

| Task Row | Task Title & Spec File | Supporting Suite | Assertions | Status Tag | Exit Code | Reason Blocked from Acceptance & Next Action |
|:---:|---|---|:---:|:---:|:---:|---|
| **`P2-03`** | Artifact metadata/upload/finalize/access APIs (`P2-orchestrator.md`) | `services/orchestrator/tests/blob-wire-binary.test.ts` | 5 passed, 5 total | **`[GREEN-EXIT1]`** | **1** | **HOÀN TOÀN BỊ CHẶN (BLOCKED at `[ ]` / `[~]`):** Duy nhất suite này kiểm chứng binary wire cho P2-03. Mặc dù 5/5 assertions pass trong ~2s, tiến trình bị Jest force-exit sau 32s do hook `afterAll` quá 30s (`app.close()` drain timeout do task mồ côi `2eecd5ba`). Do không có bất kỳ test exit 0 nào khác hỗ trợ binary wire, P2-03 **không thể tick `[x]`**. Cần Platform fix shutdown drain. |
| **`P2-04`** | Submission/idempotency/outbox dispatch (`P2-orchestrator.md`) | `services/orchestrator/tests/ingress-bounded.test.ts`<br>*(cùng với `runtime.test.ts`)* | 8 passed, 8 total<br>*(97 passed)* | **`[GREEN-EXIT1]`**<br>*(`[PASS]`)* | **1**<br>*(0)* | **BỊ NHIỄM ĐỘC (TAINTED / MIXED):** `runtime.test.ts` (97/97, exit 0) chứng minh phần core dispatch, nhưng `ingress-bounded.test.ts` (8/8) chuyên trách payload boundary lại kết thúc với Exit 1 (Redis subscriber open handle / afterAll 30s timeout). Theo quy tắc nghiệm thu exit 0 tuyệt đối, hàng này không thể coi là hoàn tất sạch sẽ cho đến khi `ingress-bounded` đạt exit 0. |
| **`P2-08`** | Poll/result/compat facade/webhooks/audit (`P2-orchestrator.md`) | `services/orchestrator/tests/usage-summary.test.ts`<br>*(cùng với `runtime.test.ts`)* | 9 passed, 9 total<br>*(97 passed)* | **`[GREEN-EXIT1]`**<br>*(`[PASS]`)* | **1**<br>*(0)* | **BỊ NHIỄM ĐỘC (TAINTED / MIXED):** `runtime.test.ts` pass, nhưng `usage-summary.test.ts` (9/9) kết thúc với Exit 1 do socket `TCPSERVERWRAP` không đóng trước timeout 30s. Bằng chứng kiểm tra usage facade bị cách ly, không được tính vào nghiệm thu chính thức cho tới khi exit 0. |

### Diagnostic & Resolution Path for Platform Lane (Claude Code):
- **Mechanism:** In `services/orchestrator/src/modules/runtime/runtime.ts:31-34`, `getActiveLeasesCount()` queries `WHERE state = 'RUNNING'` without filtering `AND lease_expires_at > NOW()`. A stale orphaned task `2eecd5ba-cdfd-4966-9dab-bec4b853fe36` keeps count at 1, forcing `app.close()` to wait 30,000ms until Jest aborts.
- **Fix:** Add `AND lease_expires_at > NOW()` to `getActiveLeasesCount()` OR configure `shutdownTimeoutMs: 0` in test fixtures. Once applied, all 3 suites will complete in ~2-4s with **Exit Code 0**, unblocking P2-03, P2-04, and P2-08 cleanly.

---

## 7. PLAN CHANGES 09-24 (Qwen-2 lane, docs-only, NO DB, nothing ticked)

Two new task plans appeared 2026-09-24; they are **plan-only** (no new suite, no tick change).
This section maps them onto the four tables so cross-table prose never conflates old `[x]` evidence with the new gates.

### 7.1 SEC-OIDC-VAULT-2026-09-24.md — 16 backlog rows (gate `G-SEC` before G6)
Reviewed by Codex-3 (`coordination/reports/codex3.md`, 09:02). Rows: SEC-00, ADM-BASE-01..03, OIDC-01..04, VAULT-01..06, SEC-INT-01/02.

| New row | Affects old row(s) | Evidence class needed | Note (codex3 mapping; old `[x]` does NOT certify) |
|---|---|---|---|
| ADM-BASE-01/02 | P2-02, P6-04..06 | LIVE (createApp+DB), BROWSER (real click → DB state) | POST mutator seam missing today (shell-router routes POST to handleSectionGet) |
| ADM-BASE-03 | P8-04 | LIVE + LOG tear-down | `String(err)` → HTTP/log leak sinks must be swept (sentinel) |
| OIDC-01..04 | P2-02, P6-01, P8-04 | LIVE + BROWSER (fake IdP) | Fake IdP + real browser callback; not DOM-only |
| VAULT-01..06 | P2-02, P3-02/05, P6-04 | LIVE + BROWSER + multi-container | Vault KVv2 CAS, pinned revision; VAULT-05 reader; legacy→Vault migration |
| SEC-INT-01/02 | P8-01/04/06/07/08 | multi-container + infra E2E | G-SEC gate: full browser→key→connector→rotate/revoke flow; 16/16 evidence |

Cross-table effect: do NOT copy `[x]` from P2/P3/P6/P8 to these rows; `G-SEC` does not auto-close `G6`. Any future suite for these rows is LIVE_INFRA/BROWSER class (never OFFLINE).

### 7.2 DEPLOY-STORAGE-LOGGING-2026-09-24.md — **10 rows**, gate `G-DATA`
Rows (đếm theo dòng bảng thực, W43-Q10): **DATA-00, DATA-01, DATA-02, DATA-03, DATA-04, DATA-05 (6) + LOG-01, LOG-02 (2) + DEP-01 (1) + DATA-INT-01 (1 = G-DATA) = 10 rows**.
Erratum (W43-Q10): coordinator ban đầu công bố "9 task (G-DATA)" là SAI; chính thức **10 rows** (6 DATA + 2 LOG + DEP-01 + DATA-INT-01). Bảng trước đây của §7.2 ghi "9 dev + gate" — đọc đúng là: 9 dev = 6 DATA + 2 LOG + DEP-01; gate = DATA-INT-01.

| New row | Affects old row(s) | Evidence class needed | Note |
|---|---|---|---|
| DATA-01/02/05 | P2-03 | LIVE (S3-compatible) | orchestrator không ghi `artifact_blobs` nữa; submit STAGING/foreign/expired bị chặn |
| DATA-03/04 | P5-10, P4-05 | LIVE + multi-container | URL acquisition pin READY; worker stream S3; kill/restart không để dangling ref |
| LOG-01/02 | P8-04 (redaction), P8-01/07 | LIVE + infra | ES pipeline; sentinel secrets không có trong logs; outage không block request |
| DEP-01 / DATA-INT-01 | P8-01/07/08 | infra + cross-host E2E | G-DATA: upload+URL path, S3/ES/Redis fault; zero file bytes trong DB/Redis |

Cross-table effect: old P2-04/P4-05/P5-10/P8 ticks are baseline; they do not certify S3/ES migration.
`G-DATA` production gate: không đóng khi orchestrator còn ghi `artifact_blobs` hoặc log pipeline chưa có Elasticsearch (tasks/README 13; docs/15-decisions.md:76).

### 7.3 RV for these two plans
Both plans require ONLY infrastructure/browser/live evidence classes; no OFFLINE suite added. They do not change any suite Path/Status in docs/28/35. Qwen-2 lane has no task rows inside either plan; offline contribution stops at the exact acceptance oracles already in `tests/unit/` (P0-01 BR-05/UC-07) and the R24-01 fence proof.

---

## 8. CR-12 RESOLUTION 10:11 (W48-C9 regression — Qwen-2 lane record, docs-only)

**Sự kiện:** A6 09:54 report (antigravity-6.md:5318-5331): blob-wire-binary **4 failed / 1 passed** (đúng ra 5/5), ingress-bounded **3 failed / 5 passed** (đúng ra 8/8) — PUT nhận **403** sau CR-12 Edits 1-3.

**Root cause (C, claude.md:1, ~10:11) — FIXTURE-LEVEL, không phải design:**
1. Cả hai suite `INSERT INTO artifacts` **thiếu `token_mode`/`token_expires_at`** → NULL → route fail-closed **403** tại `server.ts:509-517` (hành vi ĐÚNG sau Edit-3 — expire/mode giờ được ép).
2. Cả hai suite **PUT+GET dùng chung 1 token** — bất khả thi sau CR-12: grant là **upload XOR download**.
**Fix (chỉ sửa test của C):** fixture INSERT thêm `token_mode='upload'` + `token_expires_at` tương lai; helper mới `rotateGrant(mode)` cấp token upload/download riêng theo phase; mọi blob GET chuyển sang token download-mode.

**Code Edits 1–4 DONE (C):** 0008+0009 migrations, artifacts.ts, runtime.ts completion gate + parseOutputArtifactIds, server.ts result refs + public download route. `npx tsc --noEmit -p tsconfig.json` → **TSC_EXIT=0**. Chưa re-run live (RUN REQUEST → A6, không self-claim).

**CX3 cross-check (codex3.md R11:114-116, R12:128-138) — KHỚP C + A6:**
- Khớp: counts + core NULL-mode explanation khớp source (`migrations/0008:7-8` additive nullable; `artifacts.ts:77-82` ghi cả mode/expiry trong cùng INSERT, bỏ no-op UPDATE cũ; `server.ts:509-517` fail closed legacy NULL).
- Chính xác hóa: "3 blob PUT tests receive 403" của A6 hơi thừa — case oversize (`ingress-bounded.test.ts:244-261`) fail do **test-order contamination** (`before.rowCount` = 0 vì 2 PUT trước đã bị chặn), body-limit path chạy trước blob auth; cần seed blob độc lập trong case đó.
- Finding MỚI (High, R11): CR-12 finalize claim "owner/lease-fenced" nhưng **taskId/leaseEpoch là optional raw-body extension — vắng khỏi typed contract + SDK finalize** (`artifacts.ts:104-125,141-146`; `contracts/src/runtime.ts:202-206`; `worker-sdk/src/task-context.ts:398`; `server.ts:467-472`); service substitute `art.taskId` và không gọi `assertLease` → lease loss vẫn có thể finalize nếu task state ≠ FAILED/CANCELLED. Cần require task/epoch trong contract + verify lease atomically trước READY. Owner: Platform + Worker SDK/contracts.
- Ghi chú: đây là **scoped-grant fix, không phải ART-02/S3** — bytes vẫn vào `artifact_blobs` (`artifacts.ts:191-195`); G-DATA (S3) vẫn là gate production độc lập.

**Evidence pending:** re-run live 3-suite với literal `Tests:` + exit code cần thiết để khôi phục acceptance (cả C lẫn CX3 đều nhấn mạnh). Chưa tick gì ở đây.

---

## 9. W43-Q15 RECON — ADM-BASE-01 VERIFIED + R24-02 KHÔNG done + stale-count drift đã đóng (Qwen-2 lane, docs-only)

Hai sự thật (nguồn `antigravity-6.md` W42-A96 12:43→12:48 + W42-A93/A94/A95):
1. **ADM-BASE-01 6/6 routes VERIFIED LIVE** — suite MỚI `services/orchestrator/tests/admin-base-routes.test.ts`
   (Test-Path **True**): `Tests: 7 passed, 7 total`, exit 0, 2.355s; kèm `artifact-grant-fencing.test.ts`
   **True** 10/10 exit 0 (A95) và `operation-tenant-fence` 4/4 exit 0 (A93/A95). OpenClaude UNBLOCKED.
2. **R24-02 KHÔNG done — 3 fail**: multi-container full-suite A96 `3 failed, 10 passed, 13 total (0 skipped)`
   exit 1, 50.235s (L1485 version pinning 1.1.0≠1.0.0, L1656 crash lease null, L1821 PRF-02 15s barrier).
   **Nghịch lý phán quyết giữa các lần chạy**: A95 tuyên bố "R24-02 VERIFIED" từ `1 passed, 12 skipped`
   (cô lập 1 test) — theo luật bảng này (docs/35 §4: "row xanh với skip/bypass không chứng minh acceptance"),
   phán quyết ĐÚNG là A96: **3 fail còn nguyên → R24-02 chưa đóng**. Không có gì liên quan artifact/sha256/base64
   trong 3 fail — fix R24-02 của Qwen-3 đúng như A6 nói, nhưng acceptance P5-10 (6 case) vẫn chưa đủ.

Stale-count drift (W48-O3/O5, OpenClaude phát hiện; docs/35 rows 76/77/79): +23/+77/+31 = **+131**, đúng bằng
gap `1,394 → 1,525` giữa baseline docs/35 và offline batch của tôi (W43-Q6b) + A94 (`1,525/1,525 exit 0`).
Đã sửa 3 count; [PASS] không đổi; **bảng 3.1 giờ khớp rerun** — mâu thuẫn sum tiềm tàng ĐÃ ĐÓNG.
B Browser harness đã unblocked (Playwright tiếp theo sẽ có số liệu ADM-BASE-01 pane THẬT thay stub).

---

## 10. SKIP ≠ PASS (W43-Q17 — mẫu lỗi lặp lại, systematized; không sửa báo cáo A6/Q3)

**Mẫu lỗi:** báo `N total` như `N passed` khi phần lớn là SKIP. Ba instance, đối chiếu nguyên văn `antigravity-6.md`:

| Run | Câu lệnh | Literal thật | Nhãn A6 đưa | Phán quyết theo quy tắc docs/35 §1.4 |
|---|---|---|---|---|
| A95 (12:35) | 1 test cô lập có `-t` | `Tests: 1 passed, 12 skipped, 13 total` exit 0 | "R24-02 chính thức VERIFIED" | **[SKIP-QUALIFIED]** — 1/13 executed ≠ acceptance |
| A97 Lệnh 1/2/3 (13:36) | 3 focused `-t` | mỗi cái `1 passed, 12 skipped` exit 0 | ghi "PASS" | **[SKIP-QUALIFIED]** — nhãn PASS sai pattern |
| A97 Lệnh 4 (13:36) | FULL suite, không filter | `Tests: 13 passed, 13 total` exit 0, 6.116s, 0 skipped | "PASS TUYỆT ĐỐI" | **HỢP LỆ** — đây mới là bằng chứng |

**Mâu thuẫn với packet W43-Q17 (ghi để coordinator route):** packet nói "A97… đề nghị reconcile [x] trên
1/13 executed". Thực tế báo cáo A97 §1/§4: handoff reconcile dựa trên **Lệnh 4 full-run 13/13 exit 0**
(0 skipped), còn các dòng 1/13 là 3 lệnh focused bổ trợ. → hai việc tách bạch: (i) pattern 'skip báo như
pass' CÓ THẬT ở A95 + A97 Lệnh 1/2/3 — đã chặn bằng quy tắc §1.4 + cột Skipped; (ii) nền tảng reconcile
P5-10 hiện có một literal full-run hợp lệ (A97 L4) — decision của coordinator, không phải của bảng này.
docs/35 row 20 đã chuyển [PASS] theo literal A97-L4, kèm cảnh báo SKIP-QUALIFIED cho các claim focus.

**Quy tắc thường trực (nay nằm docs/35 §1.4):** `[PASS]` ⇔ `passed==total ∧ skipped==0 ∧ failed==0 ∧ exit 0`;
mọi `skipped>0` = `[SKIP-QUALIFIED]`, không tính bằng chứng — áp dụng cho CẢ 4 bảng (28/35/36 + ledger 29).
