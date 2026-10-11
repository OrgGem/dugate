# ADMIN-PORTAL FEATURE ANALYSIS — self-checked & approved — 2026-10-09

**Vai trò:** coordinator. User đã duyệt thêm tính năng mới và uỷ quyền tự kiểm tra/duyệt: "tôi đồng ý thêm các ính năng mới, bạn hãy tự kiểm tra và duyệt, phân tích các tính năng trên portal admin".
**Mode:** read-only survey + feature analysis. Không commit/push. Không tick gate. Không đọc `.env.live`.
**Scope:** `orchestrator/apps/admin-web/src/features/*` + `src/app/admin/*` + `app-shell/*`.

## 1. Khảo sát hiện trạng (file:line đã verify trên code thật)

| Feature | Files | Ghi chú |
|---|---|---|
| api-docs | `features/api-docs/api-docs-screen.tsx` | Có `SpecBuildLabel` (:59-73) hiển thị source/bytes/fingerprint/"bundled at build time" — tín hiệu staleness MỘT PHẦN đã có |
| api-keys | `features/api-keys/api-keys-screen.tsx` | Dùng `TenantSelect` (:198) |
| businesses | `features/businesses/businesses-screen.tsx` | **Không có tenant scoping** (grep "tenant" = 0 hit) |
| connectors | `features/connectors/connectors-screen.tsx` | Dùng `TenantSelect` (:810); connector ID là free-text Input + datalist (:482-494) |
| docs | `features/docs/docs-screen.tsx` | — |
| identity | `features/identity/identity-screen.tsx` | — |
| operations | `features/operations/operations-screen.tsx` | Dùng `TenantSelect` (:226) |
| overview | `features/overview/overview-screen.tsx` | — |
| profiles | `features/profiles/profiles-screen.tsx` | **Không có tenant scoping** (grep "tenant" = 0 hit) |
| secrets | `features/secrets/secrets-screen.tsx` | Dùng `TenantSelect` (:315) |
| security | `features/security/security-screen.tsx` | Dùng `TenantSelect` (:110) |
| settings | `features/settings/settings-screen.tsx` | — |
| usage | `features/usage/usage-screen.tsx` | Dùng `TenantSelect` (:150) |
| workflows | `features/workflows/workflows-screen.tsx` | Disabled banner Δ-DEV-03 (:8-32), không đọc/mutate data |
| app-shell | `app-shell/app-shell.tsx` | Link "Legacy shell" trơn (:137), NAV không có Workers entry |

`TenantSelect` được dùng trong 6 screens (api-keys, connectors, operations, secrets, security, usage) nhưng **không** có trong profiles và businesses.

## 2. Bảng tính năng đề xuất — đã self-check & duyệt

| # | Feature | Problem solved | file:line | Size | Risk | Verdict |
|---|---|---|---|---|---|---|
| F1 | Tenant scoping cho Profiles & Businesses | Profiles/businesses thiếu tenant scope trong khi 6 screens khác dùng `TenantSelect`; typo tenant → scope sai/thiếu | `features/profiles/profiles-screen.tsx` (chưa có), `features/businesses/businesses-screen.tsx` (chưa có) | S–M | Low | **DUYỆT** |
| F2 | Connector ID: free-text → `<select>` thật | Nhập tay connector ID dễ sai; datalist không chặn giá trị lạ | `features/connectors/connectors-screen.tsx:482-494` | S | Low | **DUYỆT** |
| F3 | OpenAPI staleness indicator mạnh hơn | `SpecBuildLabel` hiện có fingerprint nhưng không có "last regenerated date" hay drift warning | `features/api-docs/api-docs-screen.tsx:59-73` | S | Low | **DUYỆT** |
| F4 | Workflows-disabled unblock guidance | Banner Δ-DEV-03 không link tới điều kiện mở gate hay owner | `features/workflows/workflows-screen.tsx:8-32` | S | None (display only) | **DUYỆT** |
| F5 | Legacy-shell link rõ ràng hơn | `<a href="/admin">Legacy shell</a>` trơn dễ bỏ sót | `app-shell/app-shell.tsx:137` | S | Low | **DUYỆT** |

## 3. Chi tiết kỹ thuật từng feature

### F1 — Tenant scoping cho Profiles & Businesses
- **Vấn đề:** `profiles-screen.tsx` và `businesses-screen.tsx` không có bất kỳ tenant nào (grep "tenant" = 0 hit cả hai file). 6 screens khác đều dùng `TenantSelect`. Khi operator thao tác profiles/businesses mà không chọn tenant, request đi thiếu tenant scope → sai tenant hoặc lỗi 422.
- **Giải pháp:** Thêm `TenantSelect` vào cả hai screen, lưu tenant vào state, gắn vào mọi BFF call. Reuse `components/ui/tenant-select.tsx` có sẵn.
- **Size:** S–M (2 files, thêm component + state + wire vào BFF calls).
- **Risk:** Low — pattern đã có sẵn từ 6 screens khác.

### F2 — Connector ID select
- **Vấn đề:** `connectors-screen.tsx:482-494` dùng `<Input list="connector-id-suggestions">` — datalist chỉ gợi ý, không chặn. Operator nhập `openai ` (có space) hoặc `OpenAI` (sai case) → request 404 hoặc lạ.
- **Giải pháp:** Thay bằng `<select>` lấy từ `connectorSuggestions` (đã có sẵn từ listRows). Giữ datalist làm fallback nếu danh sách dài.
- **Size:** S (1 file, ~10 dòng).
- **Risk:** Low.

### F3 — OpenAPI staleness indicator
- **Vấn đề:** `SpecBuildLabel` (:59-73) hiển thị `SPEC_SOURCE`, `SPEC_RAW_BYTES`, `SPEC_FINGERPRINT`, "bundled at build time". Fingerprint có nhưng operator không biết spec đã lâu chưa regenerate, không biết có drift giữa bundle và code thật không.
- **Giải pháp:** Thêm "last regenerated" timestamp (từ build metadata hoặc file mtime) và drift warning khi fingerprint bundle ≠ fingerprint route thật (nếu đo được).
- **Size:** S (1 file, ~15 dòng).
- **Risk:** Low — display only, không ảnh hưởng API.

### F4 — Workflows unblock guidance
- **Vấn đề:** `workflows-screen.tsx:8-32` banner nêu Δ-DEV-03 nhưng không link tới điều kiện mở gate, không tên owner, không hướng dẫn operator phải làm gì.
- **Giải pháp:** Thêm link tới plan/task mô tả điều kiện unblock, tên owner, và câu hỏi "cần làm gì để mở".
- **Size:** S (1 file, ~5 dòng).
- **Risk:** None — display only, không đọc/mutate data.

### F5 — Legacy-shell link
- **Vấn đề:** `app-shell.tsx:137` — `<a href="/admin" className="block px-3 py-2 text-xs text-[var(--text-sub)]">Legacy shell</a>`. Link trơn, dễ bỏ sót giữa các nav item khác.
- **Giải pháp:** Thêm icon + label rõ ràng hơn (ví dụ: "Legacy Admin Shell" + icon external-link), hoặc tách thành nav item riêng với phân biệt rõ.
- **Size:** S (1 file, ~3 dòng).
- **Risk:** Low.

## 4. Kết luận

Cả 5 feature đều **DUYỆT** để thêm vào plan. Tất cả là S–M, risk Low/None, không chạm backend, không chạm contract, không chạm live gates. Có thể implement song song nhiều lane nếu cần.

Không commit, không push, không tick gate.
