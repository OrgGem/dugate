# BÀN GIAO QUYỀN ĐIỀU PHỐI → ANTIGRAVITY (`term_47a1d44b`)

**Thời điểm:** 2026-09-24 23:00 · **Bên chuyển giao:** phiên Qwen Code `term_dd86e46b` (dừng điều phối từ nhạc này)
**Vai trò của bên nhận:** điều phối + verify như cũ — **không tự sửa source, không commit/push/reset**. Mỗi lần giao việc: gửi packet qua `orca terminal send`, rồi **đọc lại bằng MÀN HÌNH**, không tin mtime.

## VIỆC NGAY (theo thứ tự)

1. **`W47-Q2-5` đang chạy** trên `term_4d79e7d3`: wire `startWorker` → điểm tra cứu ART-02 tại `services/orchestrator/src/server.ts:711-738` (200 → `{workspacePath, tenantId, referenced, activeHolders}`, **cố ý không 404**). Khi về, nghiệm **3 điều**: literal `packages/worker-sdk` phải `0 skipped` + `ExitCode 0`; test phải chứng minh lỗi mạng (timeout/5xx/không trả lời) xử lý **AN TOAN = KHÔNG XOÁ**; wiring phải nằm ở chỗ `startWorker` thật, **không phải helper**. Đủ cả ba → reconcile `P4-05 [~]→[x]`. Thiếu bất kỳ cái nào → giữ `[~]`.

   > **ĐÍNH CHÍNH CỦA BÊN CHUYỂN GIAO (23:14) — 3 điều ở trên LÀ KHÔNG ĐỦ, ĐỪNG TICK THEO 3 ĐIỀU ĐÓ.**
   > Tôi đã viết điều 1 này trước khi đọc hết receipt `qwen2.md` §26, và nó đang dẫn coordinator tới một tick
   > sớm. Bằng chứng trên đĩa lúc 23:12:
   > * **(chuẩn) Số test KHÔNG khớp file:** §26 ghi literal `Tests: 9 passed, 9 total` và `124 cũ + 9 mới = 133`,
   >   nhưng `packages/worker-sdk/tests/workspace-reference-wiring.test.ts` khai **10** block `it(...)` hợp lệ
   >   trong **một** `describe` không skip (dòng 80, 97, 107, 120, 133, 145, 161, 172, 181 + describe 68).
   >   Mtime file **22:54:49** nằm TRƯỚC mốc giờ duy nhất trong §26 (lint `22:57:53`), nên không thể chữa bằng
   >   "chạy test trước khi sửa file". Chạy lại `npx jest tests/workspace-reference-wiring.test.ts --runInBand`
   >   (offline, không cần DB) và lấy dòng `Tests:` thật trước khi tin bất kỳ con số nào ở trên.
   > * **(boundary) Wiring đang gate-theo-config, mặc định TẮT:** `src/worker.ts:208` chỉ nối hook khi
   >   `referenceQuery && referenceQuery.tenantIds.length > 0`; không cấu hình ⇒ worker vẫn dùng in-process guard
   >   cũ. Chưa có bằng chứng một đường cấu hình thật nào bật `referenceQuery`.
   > * **(clause) Row chưa được thỏa đúng nghĩa:** `P4-05` còn thiếu *"ART-02 staging-orphan sweeper vs
   >   active-checkpoint protection"* (`tasks/P4-worker-sdk.md:11`), trong khi chính lane ghi §26(1) rằng
   >   `referenced` là **theo TENANT, không theo path** (`workspacePath` chỉ được echo) → một holder đang sống
   >   chặn don **mọi** dir hết hạn trong lượt sweep. Hướng lỗi là an toàn (không xoá), nhưng nó không chứng minh
   >   được protection theo đúng checkpoint.
   > * **(tự nhận của lane owner) §26 kết luận: "row P4-05 vẫn [~]"** và xin REQUEST nghiệm thu LIVE end-to-end.
   >
   > → **Điều kiện thứ 4 bắt buộc cho `[x]`:** một live run thật (worker thật sweep chạm endpoint thật + DB,
   > claim/release có giờ) chứng minh dir còn checkpoint **không** bị don, cộng với dòng `Tests:` khớp số `it`
   > trên đĩa. Thiếu 1 trong 2 → giữ `[~]`. — *Bên chuyển giao, phiên Qwen `term_dd86e46b`.*
   >
   > Ghi chú vai trò: từ 23:02, **quyền reconcile thuộc coordinator mới**. Đây là đính chính **lệnh của tôi**,
   > không phải lệnh mới gửi lane.
2. **`W48-C1` đã gửi Claude Code** (`term_07f2c54d`) lúc 22:58, chưa thấy turn start: làm **audit ledger THẬT** — migration + cột `id/tenant_id/actor/action/resource/severity/correlation_id/created_at` + index; **mọi** admin mutation phải ghi 1 dòng; `GET /api/v1/admin/audit` đọc bảng đó, thêm tenant predicate, và **tôn trọng tham số `limit` đang bị bỏ qua** (`server.ts:1227-1237`); 3 test (mutation sinh row thật · tenant A không đọc được của B · limit được tôn trọng). ⚠️ Đây là **lần thứ 5** gửi loại lệnh này cho lane đó: **nếu vẫn không turn start thì DỪNG ping**, báo người dùng kèm bằng chứng màn hình + receipt ID `efac417f`.
3. **`P8-02 [~]` ĐANG KHÔNG CÓ NGƯỜI LÀM.** Lane codex mới `term_bc25e34d` bị từ chối **3/3** lần (`agent_prompt_blocked` → `Input refused`). Chuyển `P8-02` cho Qwen-2 **sau khi** `W47-Q2-5` xong (tránh 2 lane cùng giữ `packages/worker-sdk`). Boundary: **chỉ tạo file mới** trong `businesses/document-core/tests/` và `tests/integration/`; **cấm** sửa `multi-container-e2e.integration.test.ts` (Qwen-3), `services/connector` (Codex-2), `packages/worker-sdk` (Qwen-2), `src/server.ts` + `src/app/admin` (Claude Code).
4. **`P5-10 [~]`:** suite document-core đã `13/13 exit 0` (`W47-A6-7`) → nút duy nhất là **28-cases matrix** (`all-variants-e2e` 29/29, `six-action-fail-closed-matrix` 35/35, `corpus-regression` 29/29 — đều đã xanh offline ở `W46-A6-8`). Chạy **3 lần liên tiếp** 3 file đó **cùng một lệnh**, có giờ phân biệt, rồi reconcile.
5. **Chuẩn bằng chứng (áp dụng mọi row):** `passed==total` **và** `skipped==0` **và** `failed==0` **và** `ExitCode 0` trên **một dòng riêng** (Duration **không** phải exit code). Với suite localhost-HTTP: **3 lần liên tiếp**. Hiện `admin-shell-server.test.ts` chỉ **60%** và 4 suite lõi **66.7%** do `connect ETIMEDOUT` (cổng TCP tạm thời trên Windows) → **chưa sửa flake thì TUYỆT ĐỐI không ký** G2/G3/G4/G-ADMIN-OPS có viện dẫn chúng.
6. **Đừng đếm lane IDLE là khoẻ:** `term_bc25e34d` (3/3 từ chối), `term_12224548` (Qwen-3, 3 packet không uptake), và Codex-2 `term_50c6a1ed` chỉ nhận lại sau ~90 phút → coi là **mong manh**.

## TRẠNG THÁI BẢN GIAO (23:00)

* Row: **P0..P9 = `55 [x]` / `5 [~]` / `16 [ ]`** · **SEC = `0/0/16`** · **ADM-UX = `0/0/8`** · **DEPLOY = `0/0/10`**
* 4 tick do phiên Qwen reconcile, tất cả có bằng chứng đầy đủ: **P4-08** 17:40 · **P2-07** 18:05 · **P5-10** 18:14 · **P8-03** 22:50. Vì `P5-10` **đã `[x]`**, mục 4 phía trên là **kiểm định 3× để củng cố hồ sơ**, **không phải** để mở lại row đó.
* **Không lane nào tự tick.** Kiểm chứng bằng **số học row** (55 = 51 + 4; 5 = 9 − 4), **không dùng `git status`** vì cả cây `du-rework/` vốn dirty từ đầu.
* **Nợ USER — bên nhận không tự quyết:** giá trị ADR `SEC-00` và `DATA-00` (26 row `[ ]` đứng ở đây), `owner document-core`, quyết định **mở lại `P6-02..07`** hay không, và restart/retire các kênh kẹt.
* **Hồ sơ đầy đủ:** `WAVE-39-ORCHESTRATOR-REALLOCATION.md` §14 (3656 dòng) → đọc từ mục **`>>> RESUME POINT (20:45)`**, rồi **`RESUME DELTA` 2→9**.
* **3 bài học về chính người tiền nhiệm** (đừng lặp): (a) `act=0` do đọc sai tên field JSON → báo sai "fleet frozen" 8 chu kỳ; (b) kết luận Claude Code kẹt kênh là **sai** — nó giao `W47-C1`+`W47-C2`, chỉ là provider `claude` báo `no turn start` khi thực ra đã nhận; (c) kết luận Qwen-3/Codex-2 kẹt: Codex-2 **hồi phục** lúc 20:08.
