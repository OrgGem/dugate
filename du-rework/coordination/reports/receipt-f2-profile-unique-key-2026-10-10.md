# Receipt — F2: keying duy nhất cho profile table view (2026-10-10)

> **RESUME POINT — IMPLEMENTED + offline [PASS], chưa ACCEPTED.** Issue F2 **xác thực là lỗi thật** (2 loại va chạm chứng minh được, có test tiền đề pin). 3 helper mới trong `state.ts`, view đã nối lại, **11 test mới**, full suite admin-web **48/48 exit 0**, `tsc --noEmit` exit 0. Không commit/push, không đổi backend.

- **Files đã sửa:** `orchestrator/apps/admin-web/src/features/profiles/state.ts`, `src/features/profiles/profiles-screen.tsx`
- **File mới:** `orchestrator/apps/admin-web/tests/profiles-row-key.test.mjs`
- **Không sửa:** backend, contracts, `types.ts`, các file profile khác.

## 1. Điều tra issue F2 — lỗi có thật

| # | Sự kiện | Bằng chứng |
|---|---|---|
| 1 | Key bảng là ghép 3 trường bằng `:` | `profiles-screen.tsx:811` (trước sửa): `` key={`${row.businessId}:${row.businessVersion}:${row.profileName}`} `` |
| 2 | **Không có id nào trên wire** | `ProfileListRow` (`lib/api/types.ts:309-321`) chỉ có `tenantId, businessId, businessVersion, profileName, revision, status, keyCount, boundActions, createdAt, updatedAt` — **không `id`/`profile_id`** ⇒ bộ 4 trường CHÍNH là định danh |
| 3 | **`tenantId` bị bỏ khỏi key** | key cũ ghép 3 trường; bảng có `tenantId`. Trang có thể chứa nhiều tenant: `parseProfileListPage(value, expectedTenantId?)` — tham số 2 là **tùy chọn** (`state.ts:206-211`), và screen gọi với `globalTenantId` có thể là `undefined` (`:160`, `:369`) ⇒ cùng 3-trường, khác tenant → **key trùng thật** (probe: `OLD_KEY_IGNORES_TENANT=true`) |
| 4 | **Ghép `:` không injective** | cặp `(a, b, c:d)` và `(a, b:c, d)` ghép ra **cùng** `a:b:c:d` — tiền đề được pin trực tiếp trong test (xem §3). Các field đến từ nguồn legacy nên `:` là ký tự hợp lệ |
| 5 | Parser **không dedup** | `parseProfileListPage` (`state.ts:206-236`) chỉ gate shape/scope/phân trang; item trùng lặp hoàn toàn hợp lệ với nó → key trùng rơi thẳng vào React (dev warning + row state có thể nhận nhầm) |
| 6 | Group `<Fragment>` thì **an toàn** | nhóm dựng bằng `Map<businessId,…>` (`:701-706` trước sửa) ⇒ key nhóm luôn duy nhất (Map key uniqueness) — vấn đề nằm ở ROW key, không phải group |

## 2. Giải pháp đề xuất (và đã thực thi)

**Nguyên tắc:** một nguồn sự thật duy nhất cho định danh, và key phải tồn tại dù wire trả trùng.

1. `profileRowIdentity(row)` (`state.ts:246`) — **JSON của bộ 4 trường** `[tenantId, businessId, businessVersion, profileName]`. JSON thay vì nối chuỗi: ký tự phân cách trong giá trị không thể bị hiểu nhầm là phân cách giữa các giá trị (vụ #4), và `tenantId` tham gia (vụ #3). Các field hiển thị (`revision`, `status`, `keyCount`, `boundActions`) **không** thuộc định danh — có test pin.
2. `keyProfileListRows(rows)` (`state.ts:270`) — key = `identity + "#" + occurrence` (0-based). Wire trả trùng → `#0`, `#1` vẫn duy nhất; thứ tự occurrence làm cho key **deterministic theo cùng input order** ⇒ re-render không remount row (không mất focus/state). Kèm `duplicateIndex` để sự trùng lặp trên wire **hiển thị được** chứ không bị che.
3. `groupProfileListRows(rows)` (`state.ts:291`) — nhóm theo `businessId` (giữ nguyên thứ tự thấy trước), row key lấy từ helper trên → duy nhất trên **toàn trang**, không chỉ trong một nhóm.
4. View nối lại: `profiles-screen.tsx:20` import helper; `:700` một dòng dựng nhóm; `:797` map group; `:801` đếm `group.items.length`; `:805` `<TableRow key={key}>`. Bỏ import `type ProfileListRow` đã trở nên không dùng (bắt buộc vì `tsconfig` bật `noUnusedLocals`).

**Vì sao không chọn các phương án khác:** thêm index số dòng (mất ổn định khi sort/đổi dữ liệu, remount toàn bộ); dùng `revision` (thay đổi khi publish → remount + không phân biệt tenant); sinh id phía backend (cần contract/migration — ngoài phạm vi display-level này).

## 3. Bằng chứng offline (cwd `orchestrator/apps/admin-web`, Node v24.21.0)

### 3.1 Test mới — `tests/profiles-row-key.test.mjs` (11 test, 3 suite)

```
node --test tests/profiles-row-key.test.mjs   →  tests 11 / pass 11 / fail 0   REAL_EXIT=0
```

Quan trọng nhất — **mỗi loại va chạm đều có test TIỀM ĐỀ pin hành vi cũ, không chỉ assert giải pháp**:

- *premise: the previous joined key collides when a value contains the separator* — tính `previousKey()` (bản ghép `:` cũ) cho 2 tuple khác nhau, **cả hai đều ra `a:b:c:d`**;
- *premise + fix: tenantId participates* — `previousKey(tenant-a) === previousKey(tenant-b)` (bằng chứng key cũ bỏ tenant), còn `profileRowIdentity` thì khác;
- *the page parser gates SHAPE, not duplicates* — trang 3 dòng trùng lặp được parser **giữ nguyên** (vụ #5), rồi keying vẫn cho 3 key khác nhau.

### 3.2 Fail-first đã xảy ra (không che)

- Lần chạy đầu của test tiền đề **FAIL**: tôi viết `assert.notEqual(previousKey(first), ...)` trong khi 2 chuỗi **giống hệt** (`actual: a:b:c:d / expected: a:b:c:d`) — assertion bị đảo ngược của chính tôi, runner bắt đúng. Đã sửa về `assert.equal` cho cả hai phía của tiền đề. Sau khi sửa mới xanh.
- (Vòng trước đó: một ví dụ va chạm của tôi ban đầu **không thực sự trùng** với key cũ — probe `OLD_COLLIDES=false` — nên tôi đã thay bằng cặp thật sự trùng; để không có test "xanh vì sai lý do".)

### 3.3 Full suite + typecheck

```
node --test tests/audit-state.test.mjs tests/operations-state.test.mjs tests/profiles-row-key.test.mjs tests/profiles-state.test.mjs tests/trace-state.test.mjs
ℹ tests 48   ℹ suites 9   ℹ pass 48   ℹ fail 0
REAL_EXIT: 0

<node v24> <tsc 5.9.3> --noEmit -p tsconfig.json
REAL_EXIT: 0   (output rỗng — 0 diagnostic, gồm kiểm `noUnusedLocals`)
```

48 = 37 test cũ + 11 test mới. Không có suite nào đỏ.

## 4. Phân định thay đổi (trung thực)

| Thành phần | Delta của TÔI | Ghi chú |
|---|---|---|
| `state.ts` | chèn block `:233-300` (~68 dòng) | 3 export + 2 interface |
| `profiles-screen.tsx` | 4 điểm: import `:20`, bỏ `type ProfileListRow` (không dùng), grouping `:700`, render `:797/:801/:805` | |
| `tests/profiles-row-key.test.mjs` | 100% mới (123 dòng) | `tests/` là thư mục **untracked** → `git diff` không nói gì, nên ghi sha256 ở §5 |

`git diff --numstat` (so với HEAD) của 2 file src = `state.ts +161/-0`, `profiles-screen.tsx +339/-6` — **con số này KHÔNG phải của tôi**: hai file đã có thay đổi chưa commit của lane khác (P0-P5 chuyển API key vào Profile) trước khi tôi đụng. Tôi chỉ ghi delta ở cột trên và không nhận con số numstat.

## 5. Bằng chứng định danh (sha256)

| File | SHA-256 |
|---|---|
| `src/features/profiles/state.ts` | `2d239550d6592ad4b786a71e811f4fe6a2f03c9d349d0b5c35f54055ea8b95c0` |
| `src/features/profiles/profiles-screen.tsx` | `c1fd98ca283e5e8eceb3c78e107c5216b77ad4e221c1085c8ff3b0e9d47e95f5` |
| `tests/profiles-row-key.test.mjs` | `2205923b4536e931ad367503b86d8546ae29b61d98f22d79eb438bb37cfd1fa6` |

## 6. Còn mở / ranh giới

- **Chưa browser-verify.** Đây là thay đổi display/keying; 11 test chỉ pin logic state. Chạy trình duyệt (mở Profiles, bảng render, không cảnh báo React duplicate-key) là việc của lane browser — tôi không chạy Playwright.
- **Không tick gate, không viết VERIFIED/ACCEPTED** — coordinator/Reviewer chốt (kiểu nhận dạng F2 liên quan `G-ADMIN-OPS`/AWEB).
- Không `git add` / `commit` / `push`; không sửa backend/contracts; không mở DB; offline hoàn toàn (node --test + tsc).
- File duy nhất tạo ngoài receipt này: test mới ở §3.
- **Re-verify nếu đọc lại sau:** theo kỷ luật báo cáo của repo, `file:line` trong receipt này là survey 2026-10-10, và 2 file src đang có thay đổi của các lane khác cùng chạy.