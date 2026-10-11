# VERIFY ĐỘC LẬP (leg 2, terminal DSH) — fix enc-meta-sentinel resume (test-double drift) — 2026-10-08

**Vai trò:** leg verify độc lập thứ hai, đối tượng `coordination/reports/triage-enc-meta-sentinel-resume-2026-10-08.md`.
**Quy tắc:** KHÔNG sửa source, KHÔNG sửa test, KHÔNG commit/add/push, KHÔNG tick gate, không hand-edit `docs/21-openapi.json`, offline (không claim DB window).
**Lưu ý đường dẫn receipt:** packet yêu cầu `coordination/reports/verify-encmeta-sentinel-independent-2026-10-08.md`, nhưng **đường dẫn đó đã bị leg khác chiếm** (receipt đã tồn tại, Node `v22.16.0` qua `C:\nvm4w\nodejs\node.exe`). Tôi **không ghi đè**; receipt của tôi nằm ở `…-dsh-2026-10-08.md` (quy ước hậu tố lane như các lượt trước) và raw dùng chung thư mục `raw/verify-encmeta-sentinel-independent-2026-10-08/` (log hai leg nằm cạnh nhau: leg kia `01..05-*`, leg này `cmd1-*`, `cmd2-*`, `full-unit-lane.log`).

**Revision kiểm:** HEAD `df3f955e877fe87bd190461736c40861e2fe78d5` (branch `codex/fix-workflow-builder`), working tree dirty (lane khác).
**Digest nội dung đã kiểm:** `tests/enc-meta-sentinel-runtime-refs.test.ts` = `6d9fbd8c44adda47c0851730582ef42167e30a151b5ec3216e3e96283b09ba00`;
`src/modules/runtime/runtime.ts` (dirty, của lane khác) = `900e2ad60214da8582b86a41abb027145e5d512dac76b4f4fa3515090db8a6a3`.
**Toolchain leg này:** Node `v22.23.3`, Windows PowerShell (leg kia: Node `v22.16.0`) — hai terminal/toolchain khác nhau.

## 1. Bảng lệnh + literal + exit code

| # | Command (cwd `orchestrator/services/orchestrator`) | Exit | Literal |
|---|---|---|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/enc-meta-sentinel-runtime-refs.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 10 passed, 10 total`** · 3.487 s — **đạt kỳ vọng** (`cmd1-jest.log`) |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | **không output** (file log chỉ chứa dòng `EXIT_CODE=0` tôi ghi thêm) — **đạt kỳ vọng** (`cmd2-tsc.log`) |
| 3 | `git diff --stat tests/enc-meta-sentinel-runtime-refs.test.ts` | 0 | `1 file changed, 28 insertions(+), 2 deletions(-)` — **xác nhận chỉ test file bị đổi** (`03-git-diff-stat` của leg kia trùng khớp) |
| 4 | (bổ sung ngoài packet) `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent` — full offline lane | **1** | `Test Suites: 6 failed, 14 skipped, 227 passed, 233 of 247 total` · `Tests: 40 failed, 118 skipped, 5094 passed, 5252 total` · 83.494 s (`full-unit-lane.log`) — xem (d) |

## 2. Trả lời a/b/c/d (đọc trực tiếp source, file:line)

### (a) Có thay đổi `src/` nào không? → **Fix test-only ✅; tree có src dirty của lane khác, KHÔNG thuộc fix này**

- Diff của fix = **duy nhất** `tests/enc-meta-sentinel-runtime-refs.test.ts` (28+/2−). Không file `src/**` nào trong diff fix.
- `git status --porcelain -- .../src` **không rỗng**: `src/compat/legacy-host-adapter.ts`, `src/db/migrations.ts`, `src/modules/runtime/runtime.ts` (mtime 09:54–10:09 hôm nay). Đây là việc của lane khác:
  - `runtime.ts` dirty = **chỉ 2 hunk `@@ -1844,7 +1844,12 @@`** — `listOperations` thêm `AND tenant_id=$1` vào subquery cursor ("WFA §8 LOW"), 6 insertions/1 deletion;
  - **SQL được verify nằm ngoài mọi hunk dirty**: grep diff cho `endpoint_slug FROM operations` và `JOIN operations o` = **0 hit** ⇒ `runtime.ts:1459` và `runtime.ts:1523-1524` là nội dung **HEAD**.
- Kết luận: fix bám product đã commit; **không có src change thuộc fix này**. (Leg kia cũng kết luận tương tự và bổ sung tên hunk của `migrations.ts`/`legacy-host-adapter.ts`; tôi chỉ kiểm `runtime.ts` vì đó là file chứa SQL được verify.)

### (b) Sentinel assertion có bị nới/bỏ/đổi kỳ vọng không? → **KHÔNG ✅**

- `leaksSentinel` còn nguyên: định nghĩa `:233` (+ đệ quy `:246`, `:248`).
- Ba assertion bắt buộc vẫn `false`: `:407` `leaksSentinel(answerWrite!.params[1])`, `:408` `leaksSentinel(payloadWrite!.params[1])`, `:410` `leaksSentinel(scripted().outbox[0])`; kèm `:404-405` (`toBeDefined`), `:409` (outbox đúng 1), decrypt `:414`/`:420`.
- Pin khác giữ nguyên: `:319-320`, `:346-347` (false) và `:385-387` (`false` cho structural schema; **`true`** cho `uiSchema`/`contextRef` — exemption có chủ đích, không bị đổi).
- **Diff đầy đủ** của file test chỉ có **2 hunk trong fake `pg`** (`:125-134` matcher operations + row `endpoint_slug: null`; `:137-155` thêm matcher resume-task) — **0 dòng `expect`/`leaksSentinel` bị sửa**.

### (c) Fake matcher có khớp SQL thật không? → **CÓ ✅** (kèm giới hạn đã ghi trong receipt fix §6.3)

| Matcher (test) | SQL thật | Đối chiếu |
|---|---|---|
| `:134` `/SELECT id, tenant_id, state, state_version[\w, ]* FROM operations WHERE id=\$1 FOR UPDATE/` | `runtime.ts:1459` `SELECT id, tenant_id, state, state_version, endpoint_slug FROM operations WHERE id=$1 FOR UPDATE` | **Khớp**: `[\w, ]*` phủ `, endpoint_slug `; SQL một dòng |
| `:143` `/FROM tasks t JOIN operations o ON o\.id = t\.operation_id WHERE t\.id=\$1 FOR UPDATE OF t/` | `runtime.ts:1523-1524` (7 cột + `FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1 FOR UPDATE OF t`) | **Khớp**: regex không neo, so khớp chuỗi con JOIN+WHERE nguyên văn trên dòng 1524 (newline nằm trước `FROM`) |
| Row `:145-153` `{id, state, payload_ref, business_id, business_version, action, correlation_id}` | SELECT đúng 7 cột `:1523` | **Khớp shape**; `payload_ref: null` hợp lệ (nhánh plain không đọc) |
| `action:'extract'` + op `endpoint_slug: null` (`:135`, `:151`) | `runtime.ts:1542-1543` rẽ nhánh pinned khi `action==='schema-workflow'` hoặc `endpoint_slug?.startsWith('workflows:')` | **Khớp chủ đích**: cả hai false ⇒ đi nhánh plain-payload mà test assert |
- Giới hạn: tolerant chỉ ở mức **danh sách cột**; đổi **cấu trúc JOIN/WHERE** vẫn phải cập nhật fake; `[\w, ]*` không phủ cột chứa ký tự ngoài `[\w, ]`.

### (d) Có test nào RED không? → **Trong phạm vi verify: KHÔNG (10/10, exit 0). Ngoài phạm vi: full offline lane 40 đỏ / 6 suite — báo ngay, không bỏ qua.**

- Suite dưới kiểm **PASS** trong full lane (`PASS tests/enc-meta-sentinel-runtime-refs.test.ts`) — không nằm trong danh sách đỏ.
- 6 suite đỏ literal: `admin-audit-mount.test.ts`, `admin-audit-query.test.ts`, `admin-error-boundary-offline.test.ts`, `admin-shell-session-lifecycle.test.ts`, `artifact-read-authorization.test.ts`, `v1-boot-typed-denial.test.ts` (nhóm audit mount/query/pane, error boundary, session lifecycle, boot key policy).
- **Không thể do fix này:** fix chỉ sửa 1 file test; `jest.mock('pg', …)` scoped theo file test; diff fix không chạm `src/`. Đây là đỏ tree-level của lane khác.
- `artifact-read-authorization.test.ts` (5 đỏ) là **MISMATCH docs↔code** đã triage riêng (`coordination/reports/triage-artifact-read-authorization-2026-10-08.md`), không thuộc fix này.
- **Khác biệt so với leg kia:** leg kia chỉ chạy 4 lệnh packet nên kết luận (d) "PASS, không RED"; leg này chạy thêm full lane và phát hiện 40 đỏ ngoài phạm vi — bổ sung thông tin, không mâu thuẫn.

## 3. Verdict

- Ba kỳ vọng packet **đạt literal**: suite 10/10 exit 0 · `tsc --noEmit` exit 0 không output · diff 1 file test (28+/2−).
- (a) test-only ✅ (src dirty của lane khác, ngoài hunk chứa SQL verify) · (b) sentinel/assertion không bị nới/bỏ/đổi ✅ · (c) matcher khớp SQL thật ✅ · (d) không RED trong phạm vi; 40 đỏ ngoài phạm vi đã liệt kê.
- Hai leg độc lập (Node v22.16.0 và v22.23.3) **kết luận trùng nhau ở a/b/c/d**; leg này thêm kiểm full-lane.
- **Không tick gate nào** (VERIFIED/ACCEPTED thuộc coordinator); không sửa file nào ngoài receipt + raw log của lượt này.

## 4. Giới hạn

- Suite dùng **scripted `pg`** (không phải PG thật) ⇒ không thay thế bằng chứng trên PostgreSQL thật; không claim DB window.
- Chưa chạy browser/deployment gate; chưa truy nguyên owner cho 6 suite đỏ ngoài phạm vi (chỉ liệt kê).
- Full-lane run **không có baseline trước fix**, nên "không do fix này" là lập luận (mock scoped + diff test-only), không phải A/B.
