# REVIEW — đợt feature Admin Portal AP-01..AP-05 — 2026-10-09

**Vai trò:** Claude Code (single dispatcher) — review + reconcile plan theo yêu cầu của Antigravity (Single Dispatcher).
**Phạm vi review:** toàn bộ code change `git status` trên `du-rework/orchestrator/apps/admin-web/src` (28 file ` M` + 3 file `??` tại thời điểm review), trong đó AP-01..AP-05 lease 6 file ` M` + 3 file mới.
**Implementers:** AP-01 Codex-3 (`term_6bd1346d`) · AP-02 Codex-2 (`term_ca784044`) · AP-03 Qwen-1 (`term_4bca69af`) · AP-04 Qwen-2 (`term_16fef1c3`) · AP-05 Codex-4 (`term_d93ff3b1`).
**Verify độc lập:** DeepSeek-1 (`term_8bfe6adc`) — `reports/verify-ap01-to-ap05-INDEPENDENT-DSH-2026-10-09.md`.
**Ràng buộc đã tuân thủ:** KHÔNG commit / KHÔNG push / KHÔNG `git add`; chỉ ghi file coordination (plan + report này); KHÔNG sửa source/test; KHÔNG tự revert hunk của lane khác.

---

## 1. Phương pháp

1. Đọc 5 receipt + verify report; đối chiếu từng claim với code thật trên cây làm việc (working tree, HEAD `72e225a`).
2. `git diff` từng file trong lease AP-01..AP-05; phân biệt hunk thuộc feature đã duyệt vs hunk ngoài scope (cùng file, không có trong receipt).
3. Kiểm tra import/export/API method mới có tồn tại không (`listTenants`, `listApiKeys`, `getBusinessVersions`, `listBusinesses`, `businessVersionAction`, `getHealth`, `TenantSelect`, `NativeSelect`, `parseBusinessPage/Versions`).
4. Đối chiếu 3 cổng verify độc lập (typecheck / build / jest) với receipt của implementer.
5. Không chạy lại typecheck/build/jest (đã có verify độc lập; tránh duplicate claim). Review này là **static review + reconcile evidence**, không phải verify leg thứ hai.

---

## 2. Tổng kết verdict

| ID | Feature | Verdict | Ghi chú |
|---|---|---|---|
| AP-01 | Tenant scoping (Profiles & Businesses) | **APPROVED-WITH-CONDITIONS** | Feature đúng; cùng file có 3 hunk ngoài scope chưa receipt (§4.1) |
| AP-02 | Connector ID NativeSelect | **APPROVED-WITH-CONDITIONS** | Feature đúng; regression tenant display trong `ManageRevisionFacts` (§4.2) |
| AP-03 | OpenAPI staleness indicator | **APPROVED** | Đúng receipt; thiết kế trung thực (không bịa build date); hunk OPU-REF-1 khai rõ |
| AP-04 | Workflows unblock guidance | **APPROVED** | Pure append +27/-0, khớp receipt 100% |
| AP-05 | Legacy shell link badge+icon | **APPROVED** | Đúng receipt; cùng file có wrapper/health của lane khác (§4.3) |

**Verdict đợt: APPROVED-WITH-CONDITIONS** — 5/5 feature đúng scope đã duyệt, 3/3 cổng verify độc lập PASS. Điều kiện duy nhất: 3 nhóm hunk ngoài scope trong cùng file lease (§4) cần được gán owner + receipt trước khi coi đợt là ACCEPTED. Không có blocker kỹ thuật.

---

## 3. Review từng feature

### AP-01 — Tenant scoping (Codex-3) — APPROVED-WITH-CONDITIONS

**File trong lease:** `features/profiles/profiles-screen.tsx`, `features/businesses/businesses-screen.tsx`.
**File mới (untracked, hỗ trợ):** `lib/tenant-context.tsx` (TenantProvider/useTenant, localStorage key `du_global_tenant_id`, auto-select default ACTIVE tenant), `components/ui/global-tenant-selector.tsx`, `components/ui/toast.tsx` (ToastProvider + GlobalErrorBoundary).

**Đúng receipt:**
- Profiles: thêm `TenantSelect` + `useTenant`; đổi tenant clear stale API keys + profile draft, reload API keys theo tenant đã chọn. Không gửi tenant query lên endpoint không hỗ trợ (profile detail/test BFF không có tenant param).
- Businesses: thêm `TenantSelect` ở header, bind shared context; label + description nêu rõ registry/version là platform-scoped, không gửi tenant query không hợp lệ.
- `TenantSelect` (tracked, có sẵn) dùng đúng: paginated `listTenants` với cursor cycle guard, Base UI SelectRoot/Trigger, `ALL_TENS_VALUE = __all_tenants__`.
- Mọi API method dùng đều tồn tại trong `lib/api/client.ts`.

**Ngoài scope (xem §4.1):** capability gating trong profiles bị thay đổi; businesses có `toggleActive` thay `runAction` + bỏ nút Enable + đổi cách hiển thị status.

### AP-02 — Connector ID NativeSelect (Codex-2) — APPROVED-WITH-CONDITIONS

**File trong lease:** `features/connectors/connectors-screen.tsx`.

**Đúng receipt:** `NativeSelect` (styled native `<select>`, forward `React.SelectHTMLAttributes`) thay Input+datalist; giữ custom-ID mode cho ID ngoài danh sách; trim whitespace khi lookup; suggestions từ `connectorIdSuggestions` (state.ts:169) — không tự nguồn mới.

**Ngoài scope (xem §4.2):** `ManageRevisionFacts` tenant display đổi từ disabled `TenantSelect` thành plain `<code>`; prop `isPlatformAdmin` đổi tên `_isPlatformAdmin` (thành dead prop).

### AP-03 — OpenAPI staleness indicator (Qwen-1) — APPROVED

**File trong lease:** `features/api-docs/api-docs-screen.tsx`.

**Đúng receipt 100%:**
- `SPEC_VERSION`, `SPEC_ABSENT_COUNT` đọc từ `PARSED.doc` (`info.version`, `x-absent.length`).
- 4 trạng thái `ApiDocsFreshness`: `artifact-missing` / `unreadable` / `version-unknown` / `snapshot-age-unknown` — **nêu thẳng là không đo được tuổi bundle**, không bịa ngày build. Đây là điểm mạnh về trung thực.
- `BUNDLE_LOADED_AT = new Date()` module-scope, đã kiểm tra SSR (app dùng `createRoot`, client-only).
- `SpecBuildLabel` giữ nguyên 6 data-attribute cũ, thêm 5 mới (`data-api-docs-freshness`, `data-spec-version`, `data-spec-absent-count`, `data-bundle-loaded-at`, `data-api-docs-freshness-note`).
- Hunk OPU-REF-1 (SPEC_SOURCE, SPEC_RAW_BYTES, fingerprint FNV-1a, BUILD_STATE, missing-artifact branch) có trong cùng file nhưng **khai rõ trong receipt GAP section** — không tự nhận công. Phân biệt đúng.

**Không có hunk ngoài scope chưa khai trong file này.**

### AP-04 — Workflows unblock guidance (Qwen-2) — APPROVED

**File trong lease:** `features/workflows/workflows-screen.tsx`.

**Đúng receipt 100%:** `git diff --numstat` = **+27/-0** (pure append). 5 mục guidance trong `<ul>` bên trong AlertBanner: deployment gate Δ-DEV-03, rollout allow-list (`workflows` chưa trong `ADMIN_WEB_ROUTE_NAMES`), migration `0037_legacy_workflow_schema_catalog.sql`, Vault Transit encryption (ENC-02), runtime readiness (WFA plan). Không import mới, không state mới, không fetch. Không enable route, không sửa `DU_ADMIN_WEB_ROUTES`.

**Feature sạch nhất của đợt.**

### AP-05 — Legacy shell link (Codex-4) — APPROVED

**File trong lease:** `app-shell/app-shell.tsx`.

**Đúng receipt:** "Legacy shell" → "Legacy Admin Shell" + blue border/bg + SVG icon. CSS var `--cf-blue`/`--cf-blue-light` tồn tại trong `styles/tokens.css:19-21`.

**Ngoài scope (xem §4.3):** cùng file còn GlobalErrorBoundary > ToastProvider > TenantProvider wrappers, health polling (`getHealth` mỗi 30s, stale 60s, `AdminHealthSnapshot` trong client.ts), GlobalTenantSelector trong nav — đều từ lane khác (tenant-context/toast/global-tenant-selector untracked). Route `/health` tồn tại trong BFF (`services/orchestrator/src/app/admin/bff/handle.ts:94`).

---

## 4. Hunk ngoài scope — cần gán owner trước ACCEPTED

Đây là finding chính của review này. Các hunk này **nằm trong cùng file lease** của AP-01/AP-02/AP-05 nhưng **không có trong receipt** tương ứng. Receipt của implementer khai chung chung "existing uncommitted edits were already present" — không liệt kê, không giải thích lý do, không gán owner.

### 4.1 Profiles — capability gating bị thay đổi (AP-01)

```diff
-  const policyShipped = caps.length > 0;
-  const hasCapability = (name: string): boolean => caps.some((capability) => capability.capability === name);
-  const canTest = hasCapability('testEndpoint');
-  const canPublish = hasCapability('publish');
-  const canRollback = hasCapability('rollback');
+  const policyShipped = true;
+  const canTest = true;
+  const canPublish = detail !== null && detail.revision >= 1;
+  const canRollback = detail !== null && detail.revision >= 2;
```

**Vấn đề:** UI gating trước đây phụ thuộc vào server-advertised capabilities (`caps`); nay hardcode `true` và suy ra từ `revision`. Hệ quả: nút Test/Publish/Rollback luôn hiện với mọi profile có revision đủ, kể cả khi backend chưa hỗ trợ capability đó. Đây là **thay đổi hành vi**, không phải tenant scoping.

**Mức độ:** Trung bình. Không phải lỗi bảo mật (server vẫn enforce), nhưng phá vỡ nguyên tắc "UI phản ánh capability thật của backend" và là scope creep so với AP-01.

### 4.2 Businesses — `toggleActive` thay `runAction` + bỏ nút Enable (AP-01)

```diff
-  async function runAction(businessId, version, action: 'enable' | 'activate' | 'deactivate') {
+  async function toggleActive(businessId, version, makeActive: boolean) {
+    if (makeActive) {
+      // Automatically ensure the version is enabled if currently in draft/registered state
+      const row = versions?.kind === 'ready' ? versions.data.rows.find((r) => r.version === version) : null;
+      if (row && row.status !== 'ENABLED') {
+        const enableResult = await client.businessVersionAction(businessId, version, 'enable');
+        ...
+      }
+      const result = await client.businessVersionAction(businessId, version, 'activate');
```

Kèm theo: nút "Enable" bị xóa khỏi UI; status badge đổi từ `businessStatusVariant(row.status)` sang Active/Inactive suy ra từ `row.activeVersion !== null`; cột "Active yes/no" bị xóa; import `businessStatusVariant` bị xóa (giờ là orphan export trong `state.ts:54`).

**Vấn đề:** (a) `toggleActive` tự động gọi `enable` trước `activate` — thay đổi semantics của action, không có trong AP-01; (b) bỏ nút Enable là thay đổi UI rõ ràng; (c) `businessStatusVariant` thành dead code.

**Mức độ:** Trung bình. Hành vi mới (auto-enable) có thể là cải tiến hợp lý, nhưng phải được duyệt riêng, không lẫn vào AP-01.

### 4.3 Connectors — tenant display regression (AP-02)

```diff
-  isPlatformAdmin,
+  isPlatformAdmin: _isPlatformAdmin,
...
-        {read.revision.tenantId === undefined ? ... : isPlatformAdmin ? <TenantSelect .../> : ...}
+        {read.revision.tenantId ? (
+          <code>{read.revision.tenantId}</code>
```

**Vấn đề:** (a) tenant ID trong revision facts trước đây hiển thị qua disabled `TenantSelect` (có thể copy, có context), nay thành plain `<code>` — regression nhỏ về UX; (b) prop `isPlatformAdmin` đổi tên `_isPlatformAdmin` và không còn dùng — dead prop, code smell.

**Mức độ:** Thấp (UX regression + dead code), nhưng cần gán owner để quyết: giữ `<code>` hay khôi phục `TenantSelect`.

### 4.4 App-shell — wrapper/health của lane khác (AP-05)

Cùng file `app-shell.tsx` chứa: GlobalErrorBoundary > ToastProvider > TenantProvider wrappers, health polling section (`getHealth` 30s, stale 60s, `AdminHealthSnapshot`), GlobalTenantSelector trong nav. Đều từ 3 file untracked (`tenant-context.tsx`, `toast.tsx`, `global-tenant-selector.tsx`) — **không thuộc AP-05**.

**Vấn đề:** không phải defect; chỉ là rủi ro khi review theo file. Cần gán owner cho 3 file untracked này (có thể là lane tenant-context đang chạy song song).

---

## 5. Verify độc lập — tóm tắt

Nguồn: `reports/verify-ap01-to-ap05-INDEPENDENT-DSH-2026-10-09.md` (DeepSeek-1, HEAD `72e225a`, node v22.23.3).

| Cổng | Kỳ vọng | Thực tế | Kết luận |
|---|---|---|---|
| Typecheck `apps/admin-web` | exit 0 | Lệnh packet literal fail (MODULE_NOT_FOUND — path `du-rework/orchestrator/node_modules/typescript/bin/tsc` không tồn tại, đúng layout pnpm); fallback `D:/Git/dugate/node_modules/typescript/bin/tsc` → **exit 0, 0 lỗi** | ✅ PASS (qua fallback) |
| Production build `@du/admin-web` | exit 0 + dist | **exit 0**, 2692 modules, `dist/index.html` 470B + 2 assets, 9.85s | ✅ PASS |
| Jest `aweb08-per-route-flag` | exit 0 + 7/7 | **exit 0**, 7 passed / 7 total | ✅ PASS |

**Gap của verify (đã khai trong report, không lặp):** code chưa commit (gắn với working tree, không phải revision chốt); path tsc trong packet không tồn tại (lệch tài liệu, không phải lỗi code); không có bằng chứng browser/runtime; warning engine node (repo pin 24.21.0, verify chạy 22.23.3); không có baseline dist để so byte-for-byte.

**Đánh giá của reviewer:** 3 cổng đều PASS trên cùng một working tree; exit code + literal đầy đủ; không dấu hiệu harness bị bóp (build script tự chạy `tsc --noEmit` trước `vite build` — bằng chứng cộng thêm cho typecheck). Verify đạt mục đích "không regression tĩnh", **không** chứng minh hành vi runtime trong browser.

---

## 6. Đánh giá receipt

| Receipt | Trung thực | Ghi chú |
|---|---|---|
| AP-01 | ⚠️ Thiếu | Chỉ mô tả TenantSelect; không liệt kê 3 hunk ngoài scope (§4.1, §4.2) |
| AP-02 | ⚠️ Thiếu | Chỉ mô tả NativeSelect; không liệt kê tenant display regression (§4.3) |
| AP-03 | ✅ Đầy đủ | Có GAP section riêng, phân biệt hunk OPU-REF-1, fail-first khai rõ |
| AP-04 | ✅ Đầy đủ | +27/-0 khớp; không hunk ngoài |
| AP-05 | ⚠️ Thiếu | Chỉ mô tả badge+icon; không liệt kê wrapper/health cùng file (§4.4) |

**Nhận xét chung:** receipt của AP-03 là mẫu tốt (có GAP section, có fail-first, phân biệt ownership). AP-01/AP-02/AP-05 cần bổ sung phần "hunk ngoài scope trong cùng file" để reviewer sau không phát hiện lại từ đầu.

---

## 7. Đề xuất

1. **Gán owner cho 3 nhóm hunk ngoài scope** (§4.1, §4.2, §4.3) — có thể là chính implementer AP-01/AP-02 hoặc lane khác đang chạy song song. Mỗi nhóm cần receipt ngắn: lý do thay đổi, có duyệt không, test nào cover.
2. **Gán owner cho 3 file untracked** (`tenant-context.tsx`, `toast.tsx`, `global-tenant-selector.tsx`) — nếu là lane song parallel đang chạy, ghi vào plan để tránh conflict.
3. **Bổ sung receipt AP-01/AP-02/AP-05** với section "Hunk ngoài scope trong cùng file" (mô hình như AP-03 §GAP).
4. **Không ACCEPTED đợt này** cho tới khi §4.1–§4.4 có câu trả lời. Feature code không cần sửa — chỉ cần attribution.
5. **Verify tiếp theo (nếu cần):** browser/runtime leg (Playwright hoặc live orchestrator) để đóng gap "không có bằng chứng browser" — ngoài phạm vi yêu cầu hiện tại.

---

## 8. Xác nhận ranh giới

- **KHÔNG** commit / push / `git add`.
- **KHÔNG** sửa source/test/docs product.
- Chỉ ghi 2 file coordination: `PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` (bảng §5) + report này.
- Không tự revert hunk nào của lane khác; tất cả hunk ngoài scope được **giữ nguyên** và chỉ ghi nhận để owner xử lý dưới lease tường minh.
