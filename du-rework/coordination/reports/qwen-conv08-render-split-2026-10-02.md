# CONV-08 — Chia `admin-shell-render.test.ts` theo pane (lane Qwen-5R, verify-only)

## RESUME POINT — 2026-10-02

- **Kết luận 1 dòng:** CONV-08 **đã được implement và commit trước khi packet này tới**. Lane này chỉ **verify độc lập**, **không sửa một dòng code nào**.
- **Trạng thái:** split = VERIFIED. Focused suites = 6/7 exit 0; `admin-shell-render` exit 1 với **2 RED đã chứng minh là pre-existing** (A/B Mục 5).
- **Đã làm:** đo trước/sau (dòng, case, expect), 7 focused runs độc lập, 1 aggregate run, A/B với file 2.815 dòng của commit `17e96b9`, typecheck, guard scan, root-cause 2 RED.
- **Mở:** 2 RED thuộc quyết định sản phẩm (xem Mục 6) — **không** phải lỗi split. Comment `p6-01-shell-fixtures.ts:46` đã lỗi thời.
- **Ranh giới đã giữ:** không tick gate, không commit/push, không sửa renderer hay test, không đụng thay đổi của lane khác.
- **Bước kế tiếp cho coordinator/Reviewer:** adjudicate Mục 6 (ai giữ: data `requiredRole` hay kỳ vọng của test, kèm comment stale ở `p6-01-shell-fixtures.ts:46`).

## 1 — Δ-DEVIATION: task đã hoàn tất trước khi dispatch

Packet spec `coordination/dispatch-specs/2026-10-02-2355-CONV08-render-split.md` (WAVE3, dispatch 23:45:36) yêu cầu chia file 2.815 dòng. Đo trên working tree tại HEAD hiện tại cho thấy việc này **đã xong**:

| Bằng chứng | Kết quả |
|---|---|
| `git rev-parse --short HEAD` | `b088eec` (branch `codex/fix-workflow-builder`) |
| Commit message chứa split | `chore(du-rework): sync doc-compare/disbursement, admin shell split, connector and review fixes` |
| 6 file pane mới | `git show --stat b088eec` → `admin-{business,profile,connector,api-key,operation,overview}-render.test.ts` đều là `+` (mới) |
| File gốc | `admin-shell-render.test.ts` là `2539 +-------` (bị rút gọn) |
| `git status --porcelain services/orchestrator/tests/` | **không có** file nào của CONV-08 bị sửa chưa commit |

Nguồn thực hiện trước đó (theo `coordination/agent-watch-state.json` và `coordination/reviews/2026-10-02-1313-coordinator.md`): lane `b2d08e87` lúc 13:10, kèm receipt độc lập `coordination/reports/tester-conv08-admin-render-split-2026-10-02.md`.

**Hành động của lane này:** không implement lại (làm lại sẽ tạo churn và đè lên work đã commit). Thay vào đó verify lại từ git, không tin receipt.

## 2 — Số dòng trước / sau (literal)

Nguồn "trước": `git show 17e96b9:du-rework/services/orchestrator/tests/admin-shell-render.test.ts` (commit liền trước khi split).
Đếm: `lines = content.split(/\r\n|\n/).length - 1`.

| Pane / file | Dòng trước | Dòng sau | it() | expect() |
|---|---:|---:|---:|---:|
| P6-01 `admin-shell-render.test.ts` | 2815 (chung) | 288 | 23 | 75 |
| P6-02 `admin-business-render.test.ts` | — | 246 | 16 | 52 |
| P6-03 `admin-profile-render.test.ts` | — | 575 | 24 | 89 |
| P6-04 `admin-connector-render.test.ts` | — | 352 | 16 | 59 |
| P6-05 `admin-api-key-render.test.ts` | — | 359 | 19 | 58 |
| P6-06 `admin-operation-render.test.ts` | — | 583 | 28 | 105 |
| P6-07 `admin-overview-render.test.ts` | — | 419 | 14 | 67 |
| **Tổng** | **2815** | **2822** | **140** | **505** |

- File lớn nhất sau split: **583** dòng (P6-06) — thấp hơn ngưỡng 2.000 rất xa.
- `describe()`: 28 → 34. Không phải mất case: 1 outer wrapper cũ được thay bằng **7** outer wrapper, mỗi file một pane.
- Delta dòng **+7**: 7 doc-comment/outer-`describe` wrapper của 7 file, trừ các banner/blank line đi cùng block.

## 3 — Số case và assertion: không giảm (3 cách kiểm)

| Kiểm | Trước | Sau | Kết luận |
|---|---:|---:|---|
| `it(` / `expect(` (static) | 140 / 505 | 140 / 505 | bằng |
| `Tests:` runtime (jest JSON) | 140 | 140 | bằng |
| Set `(describe con, tên test)` | 140 unique | 140 unique | `MISSING_AFTER=0`, `ADDED_AFTER=0` |
| Multiset dòng `expect(...)` (bỏ whitespace) | 505 | 505 | `not_in_before=0`, `unmatched_in_before=0`, `IDENTICAL_MULTISET=true` |

Hai kiểm cuối là kiểm mạnh hơn đếm tổng: **không case nào bị đổi tên, rơi, nhân bản, và không assertion nào bị viết lại/yếu đi** (chỉ di chuyển nguyên khối).

**Ghi chú tự phê bình (probe bị sai lần đầu):** lần chạy đầu mình tách key bằng `fullName.split(' > ')`, nhưng Jest JSON nối `fullName` bằng **khoảng trắng**, nên mọi key rỗng và unique=1 — tức kiểm "không mất case" **không có tác dụng** dù trông xanh. Đã sửa sang `ancestorTitles[1] + title`, in 3 mẫu để chứng minh key khác nhau, rồi mới so sánh. Số liệu Mục 3 lấy từ lần chạy đã sửa.

## 4 — Focused runs: mỗi file chạy độc lập

cwd: `D:\Git\dugate\du-rework\services\orchestrator`.
Command: `npx jest --runInBand --runTestsByPath tests/<file> --json --outputFile=<tmp>` (stdout suppressed, exit code literal qua `cmd /v:on ... echo JEST_EXIT=!ERRORLEVEL!`).

| # | File | JEST_EXIT | Tests | passed | failed | pending |
|---|---|---:|---:|---:|---:|---:|
| 1 | `tests/admin-shell-render.test.ts` | **1** | 23 | 21 | **2** | 0 |
| 2 | `tests/admin-business-render.test.ts` | 0 | 16 | 16 | 0 | 0 |
| 3 | `tests/admin-profile-render.test.ts` | 0 | 24 | 24 | 0 | 0 |
| 4 | `tests/admin-connector-render.test.ts` | 0 | 16 | 16 | 0 | 0 |
| 5 | `tests/admin-api-key-render.test.ts` | 0 | 19 | 19 | 0 | 0 |
| 6 | `tests/admin-operation-render.test.ts` | 0 | 28 | 28 | 0 | 0 |
| 7 | `tests/admin-overview-render.test.ts` | 0 | 14 | 14 | 0 | 0 |
| | **Tổng** | | **140** | **138** | **2** | **0** |

**Aggregate một process (cả 7 path cùng lúc):** `JEST_EXIT=1`, `7 suites / 6 passed_suites / 1 failed_suites`, `tests=140 passed=138 failed=2` — **giống hệt** tổng các lần chạy riêng từng file. Không phát hiện phụ thuộc thứ tự Jest giữa các file.

Lưu ý về môi trường: 7 suite này là unit thuần renderer/fetcher, **không** mở cửa sổ DB/Redis/S3. Cổng loopback/DB không bị đụng. Không chạy live.

## 5 — A/B: 2 RED là pre-existing, KHÔNG do split

Cách kiểm: materialize **đúng file gốc 2.815 dòng** từ commit `17e96b9` vào `tests/__conv08-presplit-baseline.test.ts`, chạy với **cùng production code hiện tại**:

- Materialize: `git show 17e96b9:du-rework/services/orchestrator/tests/admin-shell-render.test.ts > du-rework/services/orchestrator/tests/__conv08-presplit-baseline.test.ts` → `lines=2815 it=140 expect=505`.
- Chạy: `npx jest --runInBand --runTestsByPath tests/__conv08-presplit-baseline.test.ts` → `JEST_EXIT=1`, `tests=140 passed=138 failed=2`.
- **Hai test đỏ trùng tên, trùng vị trí nguyên bản:**
  1. `admin-shell renderer (P6-01) renderShell — four screen states renders an empty screen state with the message`
  2. `admin-shell renderer (P6-01) renderShell — role-filtered nav shows operator-accessible nav items for an operator`
- Dọn dẹp: `del` → `DEL_EXIT=0`; `git status --porcelain` xác nhận file không còn (các file `M`/`??` còn lại thuộc lane khác, không phải của lane này).

**Kết luận:** cùng một bộ test, cùng production, **trước** split 138/2 và **sau** split 138/2. Split không tạo và không che RED nào.

## 6 — Root-cause 2 RED (thuộc product, ngoài lease của lane này)

`git diff 17e96b9 HEAD -- du-rework/services/orchestrator/src/app/admin/p6-01-shell-fixtures.ts`:

```diff
-  { section: 'profiles',   label: 'Profiles',   path: '/admin/profiles',   requiredRole: 'operator' },
-  { section: 'connectors', label: 'Connectors', path: '/admin/connectors', requiredRole: 'operator' },
+  { section: 'profiles',   label: 'Profiles',   path: '/admin/profiles',   requiredRole: 'admin' },
+  { section: 'connectors', label: 'Connectors', path: '/admin/connectors', requiredRole: 'admin' },
```

- Renderer đi theo **data** (`requiredRole`) qua `ROLE_ORDER[role] >= ROLE_ORDER[item.requiredRole]` (`p6-01-shell-fixtures.ts:67`) nên operator không thấy `profiles`/`connectors`, và `section: 'profiles'` với operator rơi vào `denied` → không có `no profiles yet`.
- Comment `p6-01-shell-fixtures.ts:46-47` **vẫn ghi** "`operator` may additionally see `profiles` and `connectors`" → comment đã lỗi thời so với data ngay dưới nó.
- Đây là thay đổi **product semantics** (lane ACUI), không phải lỗi tách file. Sửa assertion để xanh = **giảm coverage** role/unauthorized, vi phạm đúng ràng buộc của CONV-08.
- **Cần owner quyết định:** (a) giữ `requiredRole: 'admin'` → sửa 2 kỳ vọng test + sửa comment :46; hoặc (b) `requiredRole` phải là `'operator'` → sửa data. **Không lane này tự chọn.**

## 7 — Typecheck và guard scan

| Kiểm | cwd | Command | Kết quả |
|---|---|---|---|
| Typecheck | `D:\Git\dugate\du-rework\services\orchestrator` | `npx tsc --noEmit -p tsconfig.json` | `TSC_EXIT=0`, log rỗng, không diagnostic |
| Guard scan | `D:\Git\dugate\du-rework` | node script quét `(it|test|describe)\.(skip|only|todo)`, `fdescribe`, `fit`, `DU_LIVE_INFRA` trên 7 file | `GUARD_SCAN files_with_guards=0` |

## 8 — Helper fixture: không cần, và không có helper của CONV-08

- Yêu cầu plan: *"chỉ trích fixture builder thật sự dùng chung, không biến snapshot thành helper tự assert"*.
- Thực tế: mỗi pane tự khai báo fixture cục bộ (`sampleRows`, `okCatalog()`, `viewFor()`...), không có builder nào thực sự dùng chung giữa 2 pane. Header của cả 7 file đều ghi: *"Fixtures stay local to this pane; no shared fixture builder is needed."*
- `tests/helpers/` hiện chỉ có **1** file: `operations-page-fixture.ts` — thuộc **CONV-10**, không phải CONV-08 (xác nhận qua `git show --stat b088eec`).
- ⇒ **Không tạo file helper mới** là quyết định đúng, không phải bỏ sót.

## 9 — Acceptance: map từng tiêu chí

| Tiêu chí (packet) | Kết luận | Bằng chứng |
|---|---|---|
| Không file nào > 2.000 dòng | **MET** | max 583 (Mục 2) |
| Số case + assertion chủ đạo không giảm | **MET** | 140/505 giữ nguyên + set equality + multiset identity (Mục 3) |
| Mỗi file chạy độc lập, không phụ thuộc thứ tự Jest | **MET** | 7 run riêng; aggregate 1 process cho kết quả y hệt (Mục 4) |
| Giữ assertion escaping/role/unauthorized/fetch-failure ở từng pane | **MET** | 505 dòng `expect(...)` là multiset y hệt; guard 0 (Mục 3, 7) |
| Focused renderer suites + typecheck pass | **PARTIAL** | typecheck exit 0; 6/7 suite exit 0; `admin-shell-render` exit 1 do 2 RED **pre-existing** (Mục 5) — không có RED mới |
| Read-only renderers | **MET** | `git status` không có file `src/app/admin/*` nào do lane này; không sửa test |
| Không tick gate / không commit | **MET** | không chạm gate, không `git commit`/`git push` |

**Trạng thái trung thực:** split **đã xong và verify xanh về số lượng + hành vi**; acceptance "focused suites pass" **chưa đạt hoàn toàn** vì 2 RED nền, và việc đóng 2 RED nằm ngoài lease test-only của CONV-08.

## 10 — Ledger

- 1 — Δ-DEVIATION: CONV-08 đã implement + commit `b088eec`, không re-implement — Muc 1.
- 2 — Số dòng trước/sau 2815 → 2822 (7 file, max 583) — Muc 2.
- 3 — Case/expect 140/505 không giảm; set equality + expect multiset identity — Muc 3.
- 4 — 7 focused runs độc lập + 1 aggregate run, không order dependency — Muc 4.
- 5 — A/B file pre-split 2.815 dòng: 138/2 trùng tên → RED pre-existing — Muc 5.
- 6 — Root-cause 2 RED: `requiredRole` operator → admin (product), comment :46 stale — Muc 6.
- 7 — Typecheck `TSC_EXIT=0`, guard scan 0 — Muc 7.
- 8 — Không trích helper vì không có builder dùng chung thật — Muc 8.
- 9 — Acceptance map + trạng thái trung thực (1 PARTIAL) — Muc 9.
