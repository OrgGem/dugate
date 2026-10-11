# Verify độc lập (DSH) — F2 profile unique keying fix — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), read-only.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/apps/admin-web` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-f2-profile-key-2026-10-10/DSH/` (`f2-rowkey.log`, `f2-full.log`, `typecheck.log`, `SHA256SUMS.txt`).
**Receipt gốc:** `coordination/reports/receipt-f2-profile-unique-key-2026-10-10.md` — **tồn tại**.

## 1. Bằng chứng chạy

| # | Lệnh (cwd `orchestrator/apps/admin-web`) | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node --test tests/profiles-row-key.test.mjs` | **0** | `# tests 11` · `# pass 11` · `# fail 0` |
| 2 | `node --test tests/*.test.mjs` (full suite, **5** file) | **0** | `# tests 48` · `# pass 48` · `# fail 0` |
| 3 | `npm run typecheck` | **0** | không output · `TS_error_lines=0` |

Ca có tên trong lệnh 1 (nguyên văn):
```
ok 1 - profile row identity — F2 unique keying
ok 2 - keyProfileListRows — keys stay unique even when the wire repeats a row
ok 3 - groupProfileListRows — table view grouping
```
*Ghi chú kỹ thuật:* PowerShell không tự mở glob cho lệnh native nên tôi liệt kê file `.test.mjs` rồi truyền danh sách — thư mục hiện có **5 file**, tổng **48 test**.

## 2. Tính injective của key (đối chiếu mã + test)

**Mã — tuple danh tính được validate đầy đủ trước khi dùng làm key** (`src/features/profiles/state.ts`):
- `:107-110` đọc `businessId`, `businessVersion`, `profileName`, `revision` từ record;
- `:111` **từ chối** nếu thiếu bất kỳ thành phần chuỗi nào (`businessId`/`businessVersion`/`profileName` phải non-null);
- `:112` **từ chối** nếu `revision` không phải **số nguyên ≥ 0** (`typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0`) ⇒ hàng thiếu/sai kiểu **không sinh key** thay vì sinh key rác;
- `:132-135` dựng đối tượng danh tính từ chính tuple đó;
- `:146-149` so khớp ứng viên theo `businessId` + `businessVersion` (+ `profileName`) và `:155-162` kiểm `revision` là **safe integer ≥ 1** cho hàng binding.

**Test — chốt tính duy nhất:** ca `ok 2 - keyProfileListRows — keys stay unique even when the wire repeats a row` kiểm đúng lớp lỗi F2: khi **wire trả lặp cùng một hàng**, các key **vẫn phải khác nhau** ⇒ key là **injective trên tập hàng**, không chỉ trên tuple; ca `ok 1` kiểm danh tính hàng, `ok 3` kiểm nhóm cho table view.

| Bound theo packet | Kết quả |
|---|---|
| `keyProfileListRows` / `profileRowIdentity` **injective** | **ĐẠT (theo test)** — 11/11 xanh, gồm ca lặp hàng vẫn unique |
| Tuple danh tính đầy đủ + validate | **ĐẠT** — `state.ts:107-112,132-135,146-162` |
| Không phá phần còn lại của admin-web | **ĐẠT** — full suite 48/48, typecheck 0 lỗi |

**Giới hạn đọc trung thực:** grep của tôi trên `state.ts` và `profiles-screen.tsx` **không** in ra dòng định nghĩa đúng tên `keyProfileListRows`/`profileRowIdentity` (tôi chỉ thấy các trường danh tính và logic validate; grep trên screen không có hit). Vì vậy tôi khẳng định **hành vi** (qua 11 test + logic validate đã đọc), **không** khẳng định vị trí khai báo chính xác của hai hàm — chúng có thể nằm ở file/module khác mà lượt này chưa rà.

## 3. Verdict

| Hạng mục | Kết quả |
|---|---|
| `tests/profiles-row-key.test.mjs` | **PASS** — 11/11, exit 0 |
| Full suite `.mjs` admin-web | **PASS** — 48/48 trên 5 file, exit 0 |
| Typecheck admin-web | **PASS** — exit 0, 0 lỗi (tiếp tục sạch như lượt verify typecheck-clean trước) |
| Tính injective của key | **ĐẠT** theo ca `keys stay unique even when the wire repeats a row` + validate tuple ở `state.ts:107-112` |

⇒ **F2 profile unique keying: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 4. GAP / ghi chú

1. **Không có bằng chứng browser/runtime:** cả 3 lệnh là test helper `.mjs` + typecheck; **không** render React, không Playwright ⇒ việc React thực sự dùng key đó để tránh trùng/hủy nhầm DOM **chưa** được chứng minh ở tầng render (chỉ chứng minh hàm key đúng).
2. **Chưa định vị được định nghĩa** `keyProfileListRows`/`profileRowIdentity` (xem §2) ⇒ nếu coordinator cần file:line chính xác, cần một lượt grep mở rộng sang các module khác trong `features/profiles`.
3. **Chưa đối chiếu nội dung receipt gốc** `receipt-f2-profile-unique-key-2026-10-10.md` (chỉ xác nhận tồn tại).
4. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 5. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (3 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
