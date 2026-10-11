# Verify độc lập (DSH) — AWEB-20a UI: nối filter from/to vào API query — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), read-only lease trên `apps/admin-web/src/features/operations/operations-screen.tsx`, `state.ts`, `tests/operations-state.test.mjs`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-20a-ui-2026-10-10/DSH/` (`aweb20a-ui-mjs.log`, `tsc.log`, `SHA256SUMS.txt`).
**Receipt gốc:** `coordination/reports/receipt-aweb-20a-ui-2026-10-10.md` — **tồn tại**.

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node --test tests/audit-state.test.mjs tests/operations-state.test.mjs tests/trace-state.test.mjs` — cwd `orchestrator/apps/admin-web` | **0** | `# tests 20` · `# pass 20` · `# fail 0`; có ca `ok 2 - buildOperationsQuery` |
| 2 | `node D:/Git/dugate/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — cwd `orchestrator/apps/admin-web` | **2** | **7 dòng `error TS`**, tất cả trong `src/features/profiles/profiles-screen.tsx` (xem §3) |

## 2. Logic `operationsTimeWindow` + `operationsWindowInvalid` (đọc trực tiếp)

- **`operationsTimeWindow`** (`state.ts:121-128`):
  ```
  export function operationsTimeWindow(fromDate, toDate): { from: string | null; to: string | null } {
    return {
      from: fromDate === '' ? null : `${fromDate}T00:00:00.000Z`,
      to:   toDate   === '' ? null : `${toDate}T23:59:59.999Z`,
    };
  }
  ```
  Ngày nhập được mở rộng thành **biên ngày trọn vẹn theo UTC** (`00:00:00.000Z` … `23:59:59.999Z`); ô để trống trả **`null`** — đúng doc `:117` (*null means no bound on this side, which must stay absent from the query*), tức không gửi tham số rỗng lên API.
- **`operationsWindowInvalid`** (`state.ts:132-137`): *True when the operator picked a start day AFTER the end day* ⇒ chặn khoảng thời gian vô nghĩa ở tầng UI.
- **Nối vào API query** (`operations-screen.tsx`):
  - `:18,21` import `buildOperationsQuery`, `operationsWindowInvalid`;
  - `:85` `if (operationsWindowInvalid(fromDate, toDate)) return;` — **chặn trước khi fetch**;
  - `:93` `const result = await client.listOperations(buildOperationsQuery({ … }))` ⇒ filter from/to đi thẳng vào query của API;
  - `:212` `const windowInvalid = operationsWindowInvalid(fromDate, toDate);` ⇒ cùng một nguồn sự thật dùng cho trạng thái UI.

| Bound theo packet | Kết quả |
|---|---|
| Biên ngày from/to → tham số query | **ĐẠT** — `state.ts:126-127` + `operations-screen.tsx:93` |
| Ô trống ⇒ **không** gửi bound | **ĐẠT** — trả `null` (`state.ts:126-127`), khớp doc `:117` |
| from > to ⇒ chặn | **ĐẠT** — `state.ts:136` + guard `:85` trước khi gọi API |
| Test | **ĐẠT** — `node --test` 20/20 xanh, có ca `buildOperationsQuery` |

## 3. RED của typecheck — NGOÀI phạm vi AWEB-20a (báo rõ, không bỏ qua)

```
src/features/profiles/profiles-screen.tsx(9,1):   error TS6192: All imports in import declaration are unused.
src/features/profiles/profiles-screen.tsx(17,8):  error TS6133: 'ProfileListRow' is declared but its value is never read.
src/features/profiles/profiles-screen.tsx(101,33): error TS6133: 'setProfileListBusinessId' is declared but its value is never read.
src/features/profiles/profiles-screen.tsx(102,10): error TS6133: 'profileListPage' is declared but its value is never read.
src/features/profiles/profiles-screen.tsx(103,10): error TS6133: 'profileListLoading' is declared but its value is never read.
src/features/profiles/profiles-screen.tsx(104,10): error TS6133: 'profileListProblem' is declared but its value is never read.
src/features/profiles/profiles-screen.tsx(105,30): error TS6133: 'profileListRefresh' is declared but its value is never read.
```

- **7/7 lỗi nằm ở `profiles-screen.tsx`** — **không** file nào thuộc lease AWEB-20a (`operations-screen.tsx`, `state.ts` **0 lỗi**).
- Nguyên nhân là `noUnusedLocals` của `tsconfig` + các khai báo/import chưa dùng còn sót lại từ một thay đổi đang làm dở của lane khác (cùng lớp với sự cố `overview-screen.tsx` TS6133 đã gặp trước đây).
- ⇒ **Gate typecheck admin-web đang ĐỎ tree-wide** vì file ngoài phạm vi; **không** quy cho AWEB-20a và tôi **không** sửa (ngoài lease).

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Test `.mjs` admin-web (20 test) | **PASS** — 20/20, exit 0 |
| `operationsTimeWindow` | **ĐẠT** — biên ngày UTC, ô trống ⇒ `null` |
| `operationsWindowInvalid` | **ĐẠT** — phát hiện from > to; guard chạy trước fetch |
| Nối filter vào API query | **ĐẠT** — `operations-screen.tsx:85,93,212` |
| Typecheck admin-web | **ĐỎ (exit 2)** — 7 lỗi, **toàn bộ ở `profiles-screen.tsx`** (ngoài lease AWEB-20a) |

⇒ **AWEB-20a UI: VERIFY ĐỘC LẬP ĐẠT ở phạm vi chức năng**, nhưng **gate typecheck admin-web hiện không xanh** vì file của lane khác. Không tick gate.

## 5. GAP / open items

1. **Chặn gate:** `profiles-screen.tsx` có 7 lỗi `TS6133/TS6192` ⇒ `tsc --noEmit` của admin-web **exit 2**. Cần owner của màn Profiles dọn khai báo/import chưa dùng (hoặc coordinator cấp lease) trước khi bất kỳ packet admin-web nào tính ACCEPTED — kể cả khi phần chức năng của họ đúng.
2. **Không có bằng chứng browser/runtime:** test là `node --test` trên helper thuần (`state.ts`); tôi **không** chạy Playwright, không gọi API thật, không DB ⇒ việc filter thực sự tới API và phân trang/đếm trên dữ liệu thật **chưa** được chứng minh.
3. **Chưa đối chiếu nội dung receipt gốc** `receipt-aweb-20a-ui-2026-10-10.md` (chỉ xác nhận tồn tại).
4. **`buildOperationsQuery` không thuộc phần tôi đọc sâu:** ca `ok 2 - buildOperationsQuery` xanh, nhưng tôi chỉ đọc `state.ts` + điểm nối ở screen, không đọc hết hàm dựng query (`operations-screen.tsx` 885 dòng).
5. Không commit: cây còn nhiều file ` M` (gồm `profiles-screen.tsx`) ⇒ kết quả gắn HEAD `d0b22104…`.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
