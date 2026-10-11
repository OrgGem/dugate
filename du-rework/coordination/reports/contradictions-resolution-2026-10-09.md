# Contradiction adjudication receipt — 2026-10-09

Người yêu cầu: `làm theo đề xuất` — bước 1 của đề xuất 3 bước (phân xử 8 mâu thuẫn trước khi dispatch).
Vai trò: coordinator, **review-only**. Không sửa source/test/docs, không tick gate, không commit / `git add` / push.
Phương pháp: mỗi claim trong §3 của `PLAN-OPEN-2026-10-09.md` được trở về `file:line` trên working tree hiện tại hoặc receipt có literal. Không tin report (theo memory `ldba-coordinator-delegated-authority`).

## 1. Kết luận ngắn

Trong 8 mâu thuẫn: **4 còn mở thật** (#1, #4, #6, #7) · **3 đã phân xử xong nhưng cần ghi lại đúng** (#2, #3, #5) · **1 đã tự sửa trong file** (#8).

Ngoài ra phát hiện thêm **2 lỗi anchor** trong chính sổ tay mở, và **1 mục mở mới** phát sinh từ việc đối chiếu.

## 2. Bảng verdict

| # | Mâu thuẫn | Verdict | Hành động |
|---|---|---|---|
| 1 | F-VFY6-01: `MASTER_PLAN.md:13` vs `:31` | **MỞ** — `:31` thiếu caveat OPEN | ghi caveat vào `:31` |
| 1b | **Anchor drift lần 2 (ghi nhận sau khi §4 áp dụng):** bản thân §7 mục 1–3 đã sửa `MASTER_PLAN.md:3` (blockquote 1 dòng → 3 dòng) và thêm 1 dòng caveat tại §12.2, làm mọi anchor trong receipt này lệch **+2**. Anchor thật hiện tại: **`:15`** (hàng D-BOOT-01 / F-VFY6-01) và **`:33`** (dòng §12.2), caveat ở `:34`. Sổ tay mở đã được sửa theo giá trị mới. Bài học áp dụng: **mọi chỉnh sửa metadata vào `MASTER_PLAN.md` phải giữ nguyên số dòng**, nếu không phải quét lại toàn bộ anchor. | **ĐÃ SỬA** | giữ nguyên số dòng khi sửa metadata; đã cập nhật cả `MASTER_PLAN.md:5` và sổ tay mở |
| 2 | CR-11: `CODE-REVIEW-2026-09-23.md:105` vs reconciliation `:36` | **PHÂN XỬ XONG** — cả 2 anchor đều sai; CR-11 đã fix, regression agent-reported | không còn mâu thuẫn; ghi chú chưa rerun độc lập |
| 3 | R24-02: `WHOLE-CODE-REVIEW-2026-09-24.md:21` vs `FULL-REWORK-REVIEW-2026-09-24.md:59` | **PHÂN XỬ XONG** — bản sau thắng: source fixed, integration rerun pending | R24-02 giữ mở ở tầng integration |
| 4 | P4-05: bảng `[x]` vs comment `[~]`/`[ ]` | **MỞ** — bảng `[x]` stale so với evidence 23:46 | hạ về `[~]`; blocker = ART-02 |
| 5 | P6-07: bảng `[x]` vs comment `[~]` | **PHÂN XỬ XONG** — clause đã được đáp ứng, nhưng artifact đã bị ghi đè | giữ `[x]`; sửa lại dòng reconcile (path + số liệu sai) |
| 6 | P5-04/P5-10: bảng `[x]` vs acceptance hold `:3` | **MỞ** | giữ mở tới khi Tester độc lập + review packet |
| 7 | UBW header `:3` vs AP-01..05 `:88-92` | **MỞ** — header stale | cập nhật header |
| 8 | MM-05: evidence `/health` structured vs phrase `server.ts:510 constant HEALTHY` | **ĐÃ TỰ SỬA** trong cùng dòng `:14` | không còn mâu thuẫn |

## 3. Chi tiết từng mục (anchor đã verify trên working tree)

### #1 — F-VFY6-01 — **MỞ**

- Anchor thật: `MASTER_PLAN.md:13` (hàng `D-BOOT-01 / F-VFY6-01`) và `:31` (dòng §12.2 intake). Anchor `:11` / `:29` trong sổ tay mở đã lệch **+2** do chính coordinator thêm blockquote ở `:3` (chứng minh: `git diff -U0 MASTER_PLAN.md` → `@@ -2,0 +3,2 @@`).
- `MASTER_PLAN.md:13` ghi: policy direction **SPECIFIED**, chưa claim implementation hoàn tất; **Accept: OPEN**.
- `MASTER_PLAN.md:31` ghi: `Implemented by oc_1: 7-case matrix + main integration 60/60 tests exit 0, regression 487/487 exit 0` — **bỏ mất caveat**.
- Bằng chứng quyết định: `reports/f-vfy6-01-closure-receipt-2026-10-06.md:8-9` nguyên văn:
  - `:8` — `Status: IMPLEMENTED with offline evidence (typecheck + 7-case matrix + main-harness integration green).`
  - `:9` — `F-VFY6-01 stays OPEN until the r4.1 candidate-level matrix (§4.3 of the spec) runs and an independent review accepts it — per §12.2 that evidence, not this receipt, closes the finding.`
- **Verdict:** `IMPLEMENTED` (offline) / **NOT ACCEPTED** / **OPEN**. `:13` là anchor đúng; `:31` phải bổ sung caveat.

### #2 — CR-11 — **PHÂN XỬ XONG**

- Anchor A sai: `CODE-REVIEW-2026-09-23.md:105` là ghi chú captured-output, **không phải** CR-11. Heading CR-11 thật ở `:87` (`### CR-11 — High: request bodies are unbounded and stream errors escape the handler catch`).
- Anchor B đã chết: `PROGRESS-RECONCILIATION-2026-09-23-EVENING.md` đã bị archive trong đợt dọn 2026-10-09; path sống là `_archive/PROGRESS-RECONCILIATION-2026-09-23-EVENING-superseded-2026-10-09.md`.
- Nội dung thật ở bản archive `:36`: `CR-11: progress is now source + agent-reported 8/8 regression PASS, superseding the earlier source-only/pending-test note. This review did not independently rerun the DB suite.`
- **Verdict:** CR-11 **đã fix** (source + `services/orchestrator/tests/ingress-bounded.test.ts` tồn tại), regression **8/8 agent-reported, chưa rerun độc lập**. Không còn là mâu thuẫn; chuyển thành ghi chú ưu tiên thấp.

### #3 — R24-02 — **PHÂN XỬ XONG**

- `WHOLE-CODE-REVIEW-2026-09-24.md:21`: `R24-02 remains open ... still globally rewrites blob fetches and retains a base64 fallback. P5-10 stays [~]`.
- `FULL-REWORK-REVIEW-2026-09-24.md:59`: `customFetch còn fault/claim barriers nhưng blob rewrite và base64 fallback đã bỏ; :649, :658 so actual bytes với finalized hash/size` → `Source fixed, integration rerun pending`.
- **Verdict:** bản sau thắng. **Source đã fix; integration rerun còn pending.** R24-02 giữ mở ở tầng integration; P5-10 giữ `[~]`.

### #4 — P4-05 — **MỞ** (bảng stale)

- `tasks/P4-worker-sdk.md:11` hàng P4-05 đang là `[x]`, nhưng **cùng hàng** chứa 2 comment mâu thuẫn:
  - `coordinator 23:18 reconcile [~]->[x]` — nêu 3 điều kiện handover đều met (9/9 `workspace-reference-wiring.test.ts`, 133/133 SDK regression, wiring tại `packages/worker-sdk/src/worker.ts:202-223`).
  - `W42: upgraded [ ]->[~] (not [x]) on live evidence 23:46:45-23:47:12` — kèm `REMAINING for [x]: ART-02 staging-orphan sweeper vs active-checkpoint protection — platform lane DEFERRED that decision`.
- Thứ tự thời gian: **23:18 sớm hơn 23:46**. Comment 23:18 đứng trước trong file nhưng là bản cũ hơn. Bảng đang giữ kết quả của bản cũ.
- Thêm: `:16` (Status audit 2026-09-21) ghi `P4-05/07/08 stay unchecked`; `:20` (W39-CC 2026-09-23) ghi `P4-05 stays [ ]`.
- **Verdict:** P4-05 phải là **`[~]`, không phải `[x]`**. Blocker duy nhất = quyết định ART-02 (sweeper vs active-checkpoint protection), platform lane đã DEFER.

### #5 — P6-07 — **PHÂN XỬ XONG** (nhưng dòng reconcile sai)

- `tasks/P6-admin.md:23` hàng P6-07 là `[x]`, kèm `COORDINATOR RECONCILE 05:55` trích `tests/browser/artifacts-summary.json` với `generatedAt 2026-09-24T05:45:26+07:00`, 31 screenshots / 28 axe scans / critical 0 / serious 0 / 59 records, `sections.spec.ts` 14 passed, `interactions.spec.ts` 4 passed, `.last-run.json` status passed.
- **Phát hiện khi đối chiếu:** file artifact hiện tại nằm ở `tests/browser/artifacts/artifacts-summary.json` (path trong comment thiếu thư mục `artifacts/`), và nội dung đã bị **ghi đè bởi lần chạy sau**: `generatedAt 2026-10-08T06:58:22.319+07:00`, **249 screenshots / 236 axe scans** / critical 0 / serious 0.
- **Verdict:** clause `[~]` trong sổ tay mở **đã được đáp ứng** — P6-07 giữ `[x]`. Lần chạy 2026-10-08 còn mạnh hơn (nhiều scan hơn, vẫn 0 critical/serious). Tuy nhiên dòng reconcile trong file đang trích **path sai + số liệu của artifact đã bị ghi đè**, nên không còn truy vết được nguyên văn. Cần sửa lại dòng đó trước khi dùng làm bằng chứng.
- Lư ý ranh giới: đây là bằng chứng **browser/a11y** là đủ cho clause của P6-07. Câu hỏi riêng biệt về route thật (profile/connector/audit còn placeholder) là mục mở khác — xem §4.

### #6 — P5-04 / P5-10 — **MỞ**

- `tasks/P5-document-core.md:3` nguyên văn: `Acceptance hold 2026-09-27: INGEST-WIRE-01 yêu cầu OCR/digitize truyền bytes/artifact thật tới Connector trong multi-container E2E. Tick P5-04/P5-10 lịch sử và parse-only live receipt không chứng minh hai variant này. Không đổi tick trước khi Tester độc lập và Claude Code review packet bổ sung.`
- **Verdict:** **MỞ**. Tick `[x]` trong bảng là tick lịch sử; acceptance hold thay thế nó cho tới khi có Tester độc lập + review packet bổ sung.

### #7 — UBW header — **MỞ** (header stale)

- `PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md:3`: `Task: UBW-00..08. Trạng thái: PROPOSED / SPECIFIED theo yêu cầu người dùng; chưa IMPLEMENTED, VERIFIED hay ACCEPTED.`
- `:88-92` (sổ tay mở ghi `:87-91`, lệch +1): AP-01..AP-05 đều `IMPLEMENTED · VERIFIED`, mỗi hàng có receipt `reports/receipt-ap0N-*.md` và verify độc lập `reports/verify-ap01-to-ap05-INDEPENDENT-DSH-2026-10-09.md`.
- Chi tiết: AP-01 và AP-05 ghi `APPROVED-WITH-CONDITIONS` (3 hunk ngoài scope trong cùng file); AP-02 cũng vậy (regression tenant display).
- **Verdict:** header **stale**. Cần cập nhật thành: parent `UBW-00..08` vẫn PROPOSED/SPECIFIED cho các hàng chưa làm, nhưng AP-01..05 đã IMPLEMENTED · VERIFIED · REVIEWED-WITH-CONDITIONS, chưa ACCEPTED ở tầng parent.

### #8 — MM-05 — **ĐÃ TỰ SỬA**

- `docs/31-mm-status-refresh.md:14` (hàng MM-05) đã tự chứa trong **cùng một dòng**: `corrected W48/Tester-3-run: /health is structured {status,db,redis,activeLeases} at server.ts:433-461 — old phrase `server.ts:510 constant HEALTHY` is STALE; still NO queue-integrity signal`.
- **Verdict:** không còn mâu thuẫn. Không được trích phrase cũ ở đâu khác. Phần còn mở của hàng này: MM-05 reconciliation vẫn thiếu; p8-02b MM-05a/b/c chỉ đúng một phần.

## 4. Lỗi anchor trong chính sổ tay mở (phát hiện thêm)

| Vị trí trong sổ tay | Anchor cũ | Anchor thật |
|---|---|---|
| §1 hàng D-BAKE-r4.1 | `MASTER_PLAN.md:9` | `:11` |
| §1 hàng D-SC01-01 | `:10` | `:12` |
| §1 hàng F-VFY6-01 | `:11` | `:13` |
| §1 hàng §12 intake | `:29` | `:31` |
| §1 hàng REVIEW-PLAT-MIG-07 | `:40` | `:42` |
| §1 hàng WT-01..09 | `:45` | `:44` (header) / `:47` (trạng thái) |
| §2 mục B UBW-AP-01..05 | `:87-91` | `:88-92` |
| §3 #2 anchor B | `PROGRESS-RECONCILIATION-2026-09-23-EVENING.md:36` | `_archive/PROGRESS-RECONCILIATION-2026-09-23-EVENING-superseded-2026-10-09.md:36` |

Nguyên nhân gốc: coordinator tự thêm 2 dòng blockquote vào `MASTER_PLAN.md:3` trong đợt dọn trước, làm lệch +2 mọi anchor sau đó; và file reconciliation đã bị archive trong cùng đợt.

## 5. Mục mở mới phát sinh

- **P6-ROUTES** — `coordination/reports/claude.md:1269-1273` (`QUESTION FOR THE USER`): P6-02..P6-07 đều `[x]`, nhưng route profile/connector/audit còn placeholder, shell mount thiếu `jsonBaseUrl`, browser/a11y verification bị hoãn. Câu hỏi: giữ `[x]` (phạm vi view-model) hay mở lại `[~]`/`[ ]` tới khi route thật + live-pane proof + browser harness có? **Chưa có câu trả lời.** Đây là mục mở thật, không nằm trong 8 mâu thuẫn cũ.

## 6. Hệ quả cho số mục mở

- 8 mâu thuẫn → **4 còn mở thật** (#1, #4, #6, #7) + **1 mục mở mới** (P6-ROUTES).
- #2, #3, #5, #8 được đóng dưới dạng ghi chú — không tự tick, không tự claim ACCEPTED.
- #4 và #7 là 2 mục **rẽ nhánh dispatch**: #4 cần owner quyết ART-02; #7 cần cập nhật metadata header (coordinator có thể làm, thuộc phạm vi plan metadata).

## 7. Việc coordinator sẽ làm tiếp (không tự làm ngay trong receipt này)

1. Sửa 8 anchor trong §4 của sổ tay mở cho khớp working tree.
2. Cập nhật §3 của sổ tay mở: đóng #2/#3/#5/#8, giữ #1/#4/#6/#7, thêm P6-ROUTES.
3. Cập nhật §1 verdict của `MASTER_PLAN.md` và `PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` cho khớp.
4. Sau khi sổ tay ổn định, mới cắt dispatch-spec theo đúng format `dispatch-specs/2026-10-09-LDBA-09B-replay-unblock.md`.

## 8. Ràng buộc đã tuân thủ

- Không commit, không `git add`, không push, không tick gate.
- Không dùng ký tự nháy kép trong file này.
- Không đọc DB production/legacy; không tạo migration.
- Mọi claim đều có `file:line` trên working tree hiện tại hoặc literal trong receipt.
