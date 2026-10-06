# Corrections S3/S4/G2 — stale text (minimal, no behavior change)

**Packet:** corrections-s3-s4-g2 · **Lane:** cc_2 (command-code) · **Dispatch:** 2026-10-03T15:02+07:00 (coordinator command-code).
**Nguồn:** `coordination/reports/tick-proposal-2026-10-03.md` §2 (S3/S4) + `review-plan-adjust-2026-10-03.md` §3 G2 (nợ của packet review-plan-markers-features).
**Mode:** bounded fix, text-only. **Không tick; không commit; không chạm `nocobase-10`.** File ghi: 2 source (text-only) + receipt này.

**TL;DR:** G2 sửa xong 2 chỗ text (message + comment) — tsc xanh, focused suite liên quan xanh, A/B chứng minh 13 red còn lại trong `admin-shell-server` là **pre-existing**. S3 **không cần sửa**: comment "host dispatch pending" đã được `b088eec` sửa từ trước (chứng minh pre/post bên dưới). S4 ghi corrigendum tại receipt này (không sửa receipt của lane khác): 3 anchor đã re-verify thủ công từ HEAD.

## 1. S3 — comment manifest "host dispatch pending" (không còn tồn tại ⇒ không sửa)

- Trạng thái hiện tại: `businesses/document-core/src/manifest/document-core.manifest.ts:333-337` — comment đã đúng:
  > `// Multi-turn workflow with its own handler kind. Dispatch is already wired:`
  > `// documentCoreHandlers.disbursement is registered, the root dispatcher`
  > `// routes on ctx.action, and host-side fan-out/approval rides the SDK's ...`
- Bằng chứng "stale text cũ đã bị xoá bởi `b088eec`": bản trước commit (`git show b088eec~1:…document-core.manifest.ts`) có **dòng 242**:
  > `// manifest fallback until host dispatch wiring is added in the separate F4 lane.`
  — grep `host dispatch` trên cây hiện tại = **0 match**; `git diff HEAD -- <file>` = **rỗng** (file clean, không lane nào đang sửa).
- **Hành động: không sửa gì** (đúng điều kiện dispatch: "nếu comment không còn tồn tại thì ghi rõ"). Không đổi behavior (không có diff). S3 coi như **đóng ở mức marker text** — phần acceptance của P9-01 (cross-service run) vẫn thuộc plan P9, không thuộc packet này.

## 2. S4 corrigendum (không viết lại lịch sử)

Theo dispatch: **không sửa receipt `tester-p9-03` của lane khác**; đính chính đặt tại đây. Câu "not mounted or registered" trong receipt tester-p9-03 là **stale** — 3 anchor sau đã được tôi re-verify trực tiếp trên HEAD `b088eec` (đọc source, không suy diễn):

| # | Anchor (HEAD `b088eec`) | Nội dung xác minh |
|---|---|---|
| 1 | `businesses/document-core/src/manifest/document-core.manifest.ts:110` | `'doc-compare'` nằm trong danh sách handler-kinds của manifest (`:103-111`: ingest…disbursement, doc-compare) |
| 2 | `…document-core.manifest.ts:431` | action `doc-compare` được khai báo đầy đủ (`name: 'doc-compare'`, displayName, inputSchema left/right, `:428-444`) |
| 3 | `businesses/document-core/src/worker.ts:2000` | `'doc-compare': async (ctx, payload) => handleDocCompare(ctx, payload)` — nằm trong `documentCoreHandlers`; cross-check REG-04: `defineBusiness(documentCoreManifest, documentCoreHandlers)` (`:2007-2010`) |
| 4 | `businesses/document-core/src/recipes/recipe-definitions.ts:448-450` | recipe `'doc-compare:workflow'` → `recipeId: 'recipe-doc-compare-workflow-v1'`, `action: 'doc-compare'`, steps 4 bước |

⇒ Registration/recipe của **doc-compare đã có trong HEAD**; câu "not mounted or registered" trong tester-p9-03 **superseded bởi corrigendum này**. Điều còn thiếu của P9-03 (không thay đổi bởi corrigendum): bug `normalizeDocCompareInput` không reject side/file thứ ba (`doc-compare.ts:141-164`) + chưa có Orchestrator/registry mount public + live provider run (acceptance "registration + cross-service run") — thuộc plan P9, không tick.

## 3. G2 — 2 chỗ text stale `POST /api/v1/admin/api-keys` (đã sửa)

**Cơ chế đúng đã xác minh trước khi viết comment/message:**
- Form: `api-key-section-renderer.ts:259` POST `/admin/api-keys/new`; matcher `mutation-dispatch.ts:38` (`issue = pathname === '/admin/api-keys/new'`) + role/CSRF fences (`:50-59`), rồi `config.adminAction('apikey.issue', {tenantId})` (`:70-72`).
- BFF: `shell-server.ts:365-387` — `adminAction` gọi `POST /api/v1/admin/actions` (`:366`), với `apiKey: du_…` sinh một lần cho issue (`:374-375`).
- `http/routes/admin.ts` chỉ có GET `/api/v1/admin/api-keys(/:keyId)` (`:505`) — **không có POST** ⇒ reference cũ sai.

**Diff (text-only, 2 file):**

```diff
--- a/du-rework/services/orchestrator/src/app/admin/api-key-section-data.ts
+++ b/du-rework/services/orchestrator/src/app/admin/api-key-section-data.ts
@@ -259,7 +259,7 @@ export async function fetchApiKeys(
       return {
         kind: 'empty',
         message:
-          'No API keys are registered yet. Use POST /api/v1/admin/api-keys to issue the first one.',
+          'No API keys are registered yet. Use the "Issue new API key" form to issue the first one (POST /admin/api-keys/new -> POST /api/v1/admin/actions, action apikey.issue).',
       };
     }
     return buildOkFromCatalog(catalog, keyId);

--- a/du-rework/services/orchestrator/src/app/admin/api-key-section-renderer.ts
+++ b/du-rework/services/orchestrator/src/app/admin/api-key-section-renderer.ts
@@ -249,9 +249,10 @@ function renderDetailPanel(ok: ApiKeyListOkResult, csrfToken = '', canManage = t
 }
 
 function renderCreateForm(csrfToken = ''): string {
-  // The create affordance. Issues a POST against
-  // `POST /api/v1/admin/api-keys` (the platform already exposes
-  // this route today; see `services/orchestrator/src/server.ts`).
+  // The create affordance. The form posts to the shell route
+  // `POST /admin/api-keys/new`, which `handleAdminMutationPost`
+  // (`app/admin/mutation-dispatch.ts`) forwards as the `apikey.issue`
+  // admin action to the BFF (`POST /api/v1/admin/actions`).
   // Renderer never invents a default raw key.
   return [
     '<section class="api-key-section__create">',
```

**Không đổi behavior:** chỉ 1 chuỗi hiển thị ở empty-state + 1 comment; không route/HTML/API nào đổi (`:259` form action giữ nguyên `/admin/api-keys/new`). Kiểm tra pin test trước khi sửa: `admin-api-key-render.test.ts:197` chỉ assert prefix `'No API keys are registered yet'`; `admin-shell-server.test.ts:1143` dùng message fixture giả riêng (không phải string này) ⇒ không test nào pin route cũ.

## 4. Kiểm thử (literal)

```
cwd: D:\Git\dugate\du-rework\services\orchestrator (NODE_ENV=test)
> pnpm exec jest --runInBand tests/admin-api-key-render.test.ts tests/admin-shell-server.test.ts
JEST_EXIT=1
PASS tests/admin-api-key-render.test.ts            ← suite sở hữu empty-message: 19/19 PASS
FAIL tests/admin-shell-server.test.ts              ← 13 failed / 43 passed (pre-existing, xem A/B)
Test Suites: 1 failed, 1 passed, 2 total
Tests:       13 failed, 62 passed, 75 total

A/B (control: swap 2 file về HEAD, chạy lại đúng suite fail):
> pnpm --dir du-rework/services/orchestrator exec jest --runInBand …/admin-shell-server.test.ts
AB_JEST_EXIT=1 — Test Suites: 1 failed, 1 total / Tests: 13 failed, 43 passed, 56 total
⇒ ĐÚNG 13 red với cả 2 trạng thái (có edit / HEAD) ⇒ không do edit này; ví dụ failure đầu:
   expected "requires &#39;operator&#39;" trong trang 403 P6-01 — red wording/product-nav đã có từ trước.
   (Sau A/B đã restore nguyên trạng 2 file; `git diff --stat` xác nhận còn đúng 2 file / 5(+)/4(−).)

> pnpm exec tsc --noEmit -p tsconfig.json      (chạy lại trên trạng thái cuối sau restore)
TSC_FINAL_EXIT=0
```

**document-core tsc:** KHÔNG chạy — điều kiện dispatch ("nếu S3 chạm document-core") không xảy ra vì S3 không sửa file nào; S4 chỉ đọc. (Package có script: `lint: tsc --noEmit`, `test:typecheck: tsc --noEmit -p tsconfig.test.json` — sẵn sàng nếu coordinator muốn chạy riêng.)

## 5. Ranh giới & không chứng minh

- Chỉ 2 file source sửa (text-only) + receipt này. Không tick; không commit; không sửa receipt `tester-p9-03` (S4 là corrigendum tại đây); không chạm `nocobase-10`.
- `admin-shell-server` 13 red: A/B-proven pre-existing trong packet này (không thuộc lane); không sửa.
- S3: đóng ở mức text (không còn stale text); acceptance P9-01 (cross-service/live) vẫn chờ owner kế hoạch P9 — ngoài packet.
