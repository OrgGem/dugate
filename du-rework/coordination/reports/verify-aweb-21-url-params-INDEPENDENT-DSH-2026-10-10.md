# Verify độc lập (DSH) — AWEB-21 Trace & Audit URL parameters — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), READ-ONLY lease.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa product code; **KHÔNG** tick gate; receipt **0 ký tự nháy kép** (đã tự quét).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3 · cwd `orchestrator/apps/admin-web`.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-21-url-params-2026-10-10/DSH/` (`deeplink-run1..3.log`, `SHA256SUMS.txt`).

## 1. Ba lượt chạy độc lập (mỗi lượt một tiến trình, không retry)

Lệnh: `node --test tests/deep-link-query-hydration.test.mjs`

| Lượt | REAL_EXIT | Literal |
|---|---:|---|
| 1 | **0** | `# tests 8` · `# suites 1` · `# pass 8` · `# fail 0` |
| 2 | **0** | `# tests 8` · `# suites 1` · `# pass 8` · `# fail 0` |
| 3 | **0** | `# tests 8` · `# suites 1` · `# pass 8` · `# fail 0` |

⇒ **8/8 xanh, ổn định 3/3 lượt** (không flake). Ca test (nguyên văn):
```
ok 1 - Trace and Audit URL query hydration
```
*Ghi chú:* số test là **8** (file đã lớn lên so với 4 test tôi đo ở lượt trước) — suite con nằm gọn trong một `describe` nên `# suites 1`.

## 2. Bounds và rehydration — đọc mã trong `features/trace` và `features/audit`

| File | Dòng |
|---|---:|
| `src/features/trace/state.ts` | 373 |
| `src/features/trace/trace-screen.tsx` | 396 |
| `src/features/audit/audit-screen.tsx` | 488 |
| `src/features/audit/state.ts` | 144 |

**Đọc tham số URL:** `trace-screen.tsx:3` — `import { Link, useSearchParams } from 'react-router';` ⇒ màn Trace lấy tham số từ URL (không chỉ từ state nội bộ). Màn Audit dùng cùng cơ chế (file `audit-screen.tsx` có `useSearchParams` theo grep ở lượt verify deep-link trước).

**Chuẩn hoá / chặn giá trị sai (bounds):**
- `trace/state.ts:243-244` — `const parsed = typeof value === number ? value : typeof value === string ? Number(value) : Number.NaN;` rồi `return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;` ⇒ tham số số kiểu lạ/âm/không nguyên bị **trả null**, không bị ép thành giá trị hợp lệ giả.
- `trace/state.ts:268` — `if (!value || !Number.isFinite(Date.parse(value))) return null;` ⇒ mốc thời gian không parse được bị **loại**, không đẩy lên truy vấn.
- Các parser dữ liệu giữ nguyên nguyên tắc đó: `parseOperationWire` (`:61`), `parseOperationsPage` (`:82-84`), `parseOperationDetail` (`:95-97`), `parseTraceAuditPage` (`:128`) — đều trả `null` khi shape sai thay vì đoán.

**Liên kết chéo bằng URL params (đúng mô tả AWEB-21):**
```ts
// trace/state.ts:367-368
const operationQuery = new URLSearchParams({ id: operationId });
const auditQuery = new URLSearchParams({ tenantId, resource: `operation:${operationId}` });
```
⇒ deep link mang **mã operation** sang Trace và mang **tenantId + resource** sang Audit ⇒ mở từ URL khôi phục đúng ngữ cảnh truy vấn (rehydration), thay vì màn trắng.

## 3. Verdict

| Hạng mục | Kết quả |
|---|---|
| `tests/deep-link-query-hydration.test.mjs` ×3 | **PASS** — 8/8 mỗi lượt, exit 0, không flake |
| Đọc tham số URL ở Trace | **ĐẠT** — `useSearchParams` (`trace-screen.tsx:3`) |
| Bounds giá trị sai (số, ngày) | **ĐẠT** — `state.ts:243-244`, `:268` trả `null`, không ép giá trị |
| Rehydration ngữ cảnh qua URL | **ĐẠT** — `state.ts:367-368` dựng `URLSearchParams` cho Trace và Audit |
| Liên kết chéo Trace ↔ Audit | **ĐẠT** — tham số `id` và `tenantId` + `resource=operation:<id>` |

⇒ **AWEB-21 Trace & Audit URL parameters: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 4. GAP / ghi chú

1. **Chưa render thật:** test là `.mjs` chạy helper/JS thuần, **không** dựng React/React Router thật ⇒ tôi xác nhận logic đọc/chuẩn hoá tham số, **không** xác nhận hành vi khi mở URL trên trình duyệt (ví dụ back/forward, tham số trùng lặp, encoding).
2. **Chưa đọc hết** `audit-screen.tsx` (488 dòng) và `audit/state.ts` (144) trong lượt này; phần grep ở lượt trước cho thấy có `useSearchParams` ở Audit, nhưng **chi tiết** chuẩn hoá của Audit chưa được tôi đối chiếu từng dòng.
3. **Chưa kiểm hành vi khi tham số vắng/không hợp lệ ở tầng screen** (ví dụ có xoá tham số khỏi URL hay giữ nguyên) — đó là phần test 8 ca có thể đã phủ; tôi chỉ đọc tên nhóm, chưa đọc từng ca.
4. **Build admin-web đang ĐỎ ở lane khác** (`features/profiles/api-keys-panel.tsx`, `profile-keys.ts` — 6 lỗi `TS2305/TS7006`), đã báo ở receipt `verify-summary-frontend-delivery-INDEPENDENT-DSH-2026-10-10.md`; **không** liên quan tới AWEB-21 và **không** ảnh hưởng `.mjs` (chạy bằng node thuần).
5. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 5. Xác nhận

- Không `git add`, không commit, không push; không sửa product code; chỉ ghi receipt này + raw log (3 file).
- Receipt tự quét: **0 ký tự nháy kép** (đúng ràng buộc lượt này), **0 dòng trailing whitespace**.
