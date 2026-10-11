# Verify độc lập (DSH) — F1 profile detail auth fix — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), read-only lease trên `src/http/routes/admin.ts`, `src/modules/admin-read/tenant-profile-detail.ts`, `tests/tapi01-closure-offline.test.ts`, `tests/aweb04-bff-profiles.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-f1-profile-detail-2026-10-10/DSH/` (`f1-jest.log`, `tsc.log`, `SHA256SUMS.txt`).
**Receipt gốc:** `coordination/reports/receipt-f1-profile-detail-auth-2026-10-10.md` — **tồn tại**.

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tapi01-closure-offline.test.ts tests/aweb04-bff-profiles.test.ts` | **0** | `Test Suites: 2 passed, 2 total` · **`Tests: 21 passed, 21 total`** · không block lỗi |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output · `tsc_error_lines=0` |

Kích thước: `tenant-profile-detail.ts` **42 dòng** · `tapi01-closure-offline.test.ts` 449 · `aweb04-bff-profiles.test.ts` 400 · `admin.ts` 1161.

## 2. Tenant predicate (đọc trực tiếp `tenant-profile-detail.ts`)

- `:1` mục đích: *Tenant-scoped profile detail lookup used by tenant-operator admin reads*; `:6` ghi chú **lookup platform cũ cố ý resolve tuple toàn cục** ⇒ module này là đường riêng cho tenant operator.
- `:10-17` `loadTenantProfileDetail(…, tenantId: string)` dựng `const params = [businessId, businessVersion, profileName, tenantId];` ⇒ **tenant là tham số bind**, không phải lọc sau truy vấn.
- Câu SQL có predicate tenant ở **cả hai** nhánh join:
  - `:27` `AND n.tenant_id=$4`
  - `:37` `AND tenant_id=$4`
  ⇒ profile ngoài tenant **không thể** được trả về, kể cả khi biết đúng `businessId`/`version`/`profileName`.

## 3. 404 cho foreign tenant (đối chiếu route + test)

- Route `src/http/routes/admin.ts`: `:56` import `loadTenantProfileDetail`; `:96` comment *fails closed with 404 — the throw rolls the transaction*; `:108` `throw new HttpError(404, 'NOT_FOUND', …)`; `:193` comment nêu **foreign tenant**; `:242` `tenantId: r.tenantId` ⇒ tenant lấy từ credential, không từ request.
- Test chốt đúng các bound packet yêu cầu:
  - `tapi01-closure-offline.test.ts:325` — *allows a tenant bearer to read its own profile through a **tenant-bound SQL lookup*** (đường hợp lệ).
  - `tapi01-closure-offline.test.ts:339` — *returns the **same not-found** result for a profile **outside the tenant scope*** ⇒ **404, không phân biệt** với không tồn tại (không rò sự tồn tại của profile tenant khác).
  - `tapi01-closure-offline.test.ts:390` — registry row thiếu pointer **fail closed (404)**, không đoán revision.
  - `aweb04-bff-profiles.test.ts:270` — *tenant operator profile list is **fenced to its own tenant***; `:244` operator read **forwarded bằng tenant credential, không bao giờ dùng platform token**; `:362` path segment hỏng → **404 không gọi upstream**.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| 2 suite (tapi01 + aweb04) | **PASS** — 21/21, exit 0 |
| Typecheck orchestrator | **PASS** — exit 0, 0 lỗi |
| Tenant predicate trong SQL | **ĐẠT** — `tenant-profile-detail.ts:27,37` (`$4`), tham số ở `:17` |
| 404 cho foreign tenant (không rò tồn tại) | **ĐẠT** — test `:339` (same not-found); route `admin.ts:96,108` fail-closed |
| Tenant lấy từ credential | **ĐẠT** — `admin.ts:242` `tenantId: r.tenantId`; test aweb04 `:244` (không dùng platform token) |

⇒ **F1 profile detail auth fix: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Offline, không PostgreSQL/HTTP thật:** test dùng fake DB/harness BFF để bắt SQL và luồng credential; hành vi thật (RLS/row-level, quyền DB, đường BFF thật) **chưa** được chứng minh — cần gate live nếu muốn chốt an ninh.
2. **Chưa đối chiếu nội dung receipt gốc** `receipt-f1-profile-detail-auth-2026-10-10.md` (chỉ xác nhận tồn tại) — kết luận dựa trên lệnh chạy thật + đọc mã.
3. **Chưa đọc hết `admin.ts` (1161 dòng)**: tôi mới xác nhận điểm import/throw/tenant; chưa rà các nhánh khác của route có thể trả profile mà bỏ predicate (ví dụ đường platform cố ý global — cần owner xác nhận đó là thiết kế).
4. **Chưa có ca kiểm “tenant A không đọc được profile của tenant B khi biết đủ tuple”** ở mức **hai tenant khác nhau** trong cùng test file (ca `:339` mô tả *outside the tenant scope* — mạnh nhưng tôi chưa đọc chi tiết fixture để khẳng định đúng hai tenant). Ghi nhận là giới hạn đọc của tôi, không phải kết luận thiếu.
5. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
