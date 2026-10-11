# INDEPENDENT VERIFIER — verify legacy mount + artifact read authorization (leg QWEN) — 2026-10-09

> **Vai trò:** VERIFIER đọc độc lập — lane khác, không sửa gì. Offline (không PG/Redis, không claim DB window). Scope `du-rework` ONLY.
> **Không làm:** edit source/test/config/docs, commit/git add/push, tick gate. Không đọc `.env.live`.

## 1. Lệnh chạy độc lập (mỗi lệnh 1 process riêng, KHÔNG pipe)

cwd: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`
Node: `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` (v24.21.0)

### Lệnh 1 — `tests/legacy-http-mount.test.ts`

```
& $env:TEMP\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/legacy-http-mount.test.ts
Test Suites: 1 passed, 1 total
Tests:       35 passed, 35 total
REAL_EXIT: 0
```

**Kết luận: suite LEGACY-HTTP-MOUNT XANH — 35/35, đúng kỳ vọng.** Không có FAIL.

### Lệnh 2 — `tests/artifact-read-authorization.test.ts`

```
& $env:TEMP\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts
Test Suites: 1 failed, 1 total
Tests:       5 failed, 85 passed, 90 total
REAL_EXIT: 1
```

**Kết luận: suite ARTIFACT-READ-AUTHORIZATION ĐỎ — 5 failed / 85 passed / 90 total, đúng kỳ vọng trong đề bài.** Đây là trạng thái đã có, KHÔNG phải do leg này gây ra.

## 2. Danh sách FAIL của Lệnh 2 (đủ 5)

| # | Test | Expected → Received | Vị trí |
|---|---|---|---|
| 1 | `does not grant reads for STAGING artifacts, even in the same operation` | `code: STATE_CONFLICT` → `PERMISSION_DENIED` | `tests/artifact-read-authorization.test.ts:375` |
| 2 | `rejects expired and fenced requesters before minting a read grant` | `{status: 403, code: PERMISSION_DENIED}` → `{status: 409, code: LEASE_LOST}` | `:386` |
| 3 | `reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact` | `STATE_CONFLICT` → `PERMISSION_DENIED` | `:597` |
| 4 | `prefers expiry over task state when both are wrong` | `{status: 403, code: PERMISSION_DENIED}` → `{status: 409, code: LEASE_LOST}` | `:732` |
| 5 | `FINDING: the lease_active boolean collapses a missing expiry and a past one` | `{status: 403, code: PERMISSION_DENIED}` → `{status: 409, code: LEASE_LOST}` | `:742` |

## 3. Kết luận đọc (mục 3 của đề bài) — 3 nhánh 503 có được pin không?

**CÓ. Cả 3 nhánh 503-guard đều được pin.** `503` xuất hiện **9 lần** trong `tests/legacy-http-mount.test.ts`: mỗi test 1 lần ở tên nhánh + 2 lần assertion/setup. Cụ thể 3 test-item:

| Dòng | Nhánh 503 được pin |
|---|---|
| `:256` | `returns a legacy 503 when workflow submission is not configured and echoes the correlation id` |
| `:280` | `returns a legacy 503 when workflow schema resolution is not configured` |
| `:297` | `maps unavailable schema crypto to a legacy 503` |

Các `status: 503` body assertion ở tương ứng `:269/:273`, `:287/:291`, `:308/:312`. Cộng thêm tương phản ở Lệnh 1: test `never echoes a decoder or host error message into a 500` CŨNG xanh, nên 2 luận điệp này hợp lý: 503 hữu danh được pin, còn 500 bị mask.

## 4. Kết luận đọc (mục 4 của đề bài) — dòng forward `error.message` và 5xx có lộ message nội bộ không

**Điểm forward:** `src/compat/legacy-http-mount.ts:433` — trong `workflowHostErrorResponse`, nhánh `if (error instanceof HttpError)` (`:431-434`): `legacyError(error.status, title, error.message, correlationId)` — đây là **chỗ duy nhất** nạp `error.message` của HttpError vào `detail` của legacy body.

**Có 5xx nào mang message nội bộ chạy qua dòng đó không? → KHÔNG ở code hiện tại.** Bằng chứng:

1. Grep `HttpError\(5*` / `HttpError(500|502|503|504` trong toàn bộ `src/compat/` → **0 hit** ⇒ không có HttpError 5xx nào được dựng trong vùng compat.
2. Đường 5xx duy nhất trong `workflowHostErrorResponse` là nhánh `code === 'SCHEMA_CRYPTO_UNAVAILABLE'` (`:446-448`), dùng **text cố định** `Workflow schema storage is temporarily unavailable.` — không cảm thấy `error.message`.
3. Lỗi không phải HttpError / host/decoder error → không lọt nhánh `:431`, rơi `internalError(correlationId)` (`:451`). `internalError` (`:331-339`) trả 500 với **text cố định** `…could not be completed (correlationId …)` — không echo message nội bộ.
4. Nhánh HttpError 4xx được forward (`:433`) dùng `error.message` của các lỗi do chính route dựng (`409 STATE_CONFLICT` ở `:56`, `503 TEMPORARY_UNAVAILABLE` ở `:58`, `422` validation…), tất cả là text public.

**Ghi chú review (không phải FAIL hiện tại):** dòng `:433` không lọc theo status class — nếu tương lai ai `throw new HttpError(500, …, '<chi tiết nội bộ>')` trong cùng nhánh, message đó sẽ lộ vào `detail`. Nên cân nhắc guard `>= 500` chỉ dùng title generic; hoặc truyền thêm deny-list message. Đường đi hiện tại an toàn nhờ 3 lý do trên và test `never echoes…` (`legacy-http-mount.test.ts`) đang xanh.

## 5. Xác nhận ranh giới

- Không sửa bất kỳ file `src/`, test/, config, docs nào — chỉ đọc + chạy test + ghi receipt.
- Không `git add`/`commit`/`push`.
- Không tick gate, không viết VERIFIED/ACCEPTED.
- Offline hoàn toàn: không mở PG/Redis, không claim DB window.
- File duy nhất tạo: `coordination/reports/verify-legacy-ara-INDEPENDENT-QWEN-2026-10-09.md`.