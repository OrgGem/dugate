# RESUME POINT — qwen_3 / P730-ADMIN-MUTATE (W3)

- Spec: `coordination/dispatch-specs/2026-10-04-1930-P730-ADMIN-MUTATE-W3.md` (task_d3d24feeea5e).
- Trạng thái: **BLOCKED-ON-LEASE/Δ — 0 source byte sửa**. Chi tiết + bằng chứng ở mục 1-5. Đã báo coordinator cùng turn.
- Receipt prep liên quan: `p730-api-audit-prep-2026-10-04.md` (Δ1, Δ2 ở đó đã được bổ sung bằng Δ mới dưới đây).

## 1 — CYCLE: W3 khảo sát trước khi code — hai blocker kỹ thuật

Tôi đo trước khi sửa. Cả hai blocker đều chặn **chữ ký hàm**, không phải chi tiết implementation, nên không thể lách trong lease hiện tại.

### 1.1 Δ2 không thể chốt trong lease — action contract trong @du/contracts thiếu khóa định danh

- `ProfileKeySchema` = `ProfileUpsertParamsSchema.baseSchema` (`packages/contracts/src/profile-policy.ts:48-52, 442`): CHỈ `businessId`, `businessVersion`, `profileName`. **Không có `apiKeyId`/`apiKeyHash`/`profileId`.**
- Primitive duy nhất ghi được revision: `createRevision(input)` (`modules/profiles/profiles.ts:327`) bắt buộc `apiKeyHash` (`:348-351` SELECT api_keys ... NOT FOUND nếu thiếu) và `action` (`:345-347` 422 nếu thiếu); `profileId = input.profileId ?? randomUUID()` (`:353`).
- **Không thể suy** api_key_id hay action từ `{businessId, businessVersion, profileName}`: `profile_bindings` PK là (profile_id, revision), không có cột `profile_name` (đo toàn bộ `migrations/`: 0 hit `profile_name`; chỉ 0004/0026 ALTER thêm cột policy, không có name mapping). Một API key có thể bind nhiều (business, version, action).
- Hành vi UPsert không xác định được: nếu mỗi lần upsert sinh `profileId` mới (randomUUID) thì mỗi save tạo một profile mới thay vì revision N+1 — vô hiệu hóa publish/rollback CAS.
- UI đang gửi gì (`apps/admin-web/src/features/profiles/profiles-screen.tsx:166-170`): `upsertProfile(b, v, n, { expectedRevision: detail.revision, policy })` — không có apiKeyId. `apiKeyId` chỉ xuất hiện ở luồng prompt-override (`:288, 708, 832`).

**Hệ quả bắt buộc:** closure T-API-01 (route GET profile detail trả `revision: 0`/`currentValues: {}` placeholder, `http/routes/admin.ts:419-455`) là **tiền đề** của mutation: chính detail read phải reveal khóa định danh để client gửi lại khi upsert. Chiều phụ thuộc này ngược với thứ tự W3→sau T-API-01 nên tôi không tự quyết.

Đề xuất (chọn một, cần Coordinator + input từ owner `@du/contracts` vì 7 action params đã freeze, có test pin tại `packages/contracts/tests/profile-policy.test.ts:201`):
- **(A) đề xuất của tôi**: migration cộng `profile_name text` + unique `(tenant_id, business_id, business_version, action, profile_name)`-style key vào `profile_bindings`, **VÀ** mở rộng `ApiKeyHashSchema` -> `ApiKeyRefSchema` (zod `.transform()` để wire `apiKeyHash` cũ vẫn parse được — non-breaking) để dispatcher nhận được khóa; leaf map (b,v,n,apiKeyRef) -> profileId bằng SELECT trước khi ghi.
- **(B) tạm thời không migration**: mỗi dispatcher action nhận `apiKeyId` tường minh, leaf resolve profileId = profile mới nhất của key theo (b,v,action). Ưu: không đụng schema. Nhược: `profileName` wire thành mỹ thuật, CAS pointer không còn per-profileName, vi phạm ý nghĩa (b,v,n) mà ProfileKey đã công bố.
Tôi **không tự migration, không tự sửa hợp đồng đã freeze** — cả hai đều vượt lease.

### 1.2 T-AUD-01 cần seam ngoài lease (và ngoài `operations/submission.ts`, nơi packet cấm)

Chuỗi principal hiện kết thúc ở 4 điểm, **không điểm nào thuộc lease của packet này**:
1. `rbac.ts` `AdminSessionView` = `role`, `csrfToken`, `tenantId`, `issuer?` — **KHÔNG có `sub`**, dù `modules/auth/session-store.ts:36-47` `SessionRecord` có `issuer` + `sub` và `app/admin/oidc-flow.ts:227` ghi `sub` lúc mint session.
2. `rbac.ts` `AdminActionCookieAuth` = `kind`, `role`, `csrfOk`, `tenantId?` — không có principal id.
3. `rbac.ts` `AdminPrincipal` = `{role: platform}` hoặc `{role: tenant_operator, tenantId}` — bất biến, không chỗ cho sub. (File này đang được nhiều lane chạm: SEC-PROVENANCE, OIDC-03, Qwen-Admin → xung đột writer.)
4. `modules/audit/audit.ts:43` `AuditRecordInput.actor: string` + `admin_audit_events` chỉ có `actor text NOT NULL` (`migrations/0010_admin_audit.sql:28`) — không có cột role/tenant-principal.

Trong lease của tôi, `actorOf` (`dispatcher.ts:305`) **tối đa** nâng được lên `admin:platform` / `admin:tenant_operator` theo khuôn `actorFor` (`app/admin/crypto-config-api.ts:171-177`). Không thể là principal id + role + tenant, vì thông tin đó bị loại ở mục 1 trước khi tới dispatcher. Nếu implement T-API ngay, tôi buộc phải ghi `actor: shell:<role>` — chính xác là chuỗi packet yêu cầu loại bỏ.

Vi phạm nguyên tắc nếu làm ngược: **`operations/submission.ts` là hot file W1b/W2, packet cấm**; còn `rbac.ts` + `session-store.ts` + `audit.ts` + migration không nằm trong lease của packet — sửa chúng là giành writer của lane khác.

Đề xuất: cấp thêm lease **T-AUD-01 seam** (4 file: `modules/admin-actions/rbac.ts`, `modules/auth/session-store.ts`, `modules/audit/audit.ts`, `migrations/00XX`); hoặc tách `P730-TAUD01-SEAM` rồi dispatcher của tôi nối sau. `publish.ts` và `operations/submission.ts`: tôi không đụng (publish.ts read-only per spec; submission.ts không cần cho seam này).

## 2 — Đã xác nhận/đồng ý với chỉ đạo của packet

- **Role table admin-only**: ĐỒNG Ý. Ghi `bearerRoles: ["platform"]`, `cookieRoles: ["admin"]` cho `profile.upsert`/`profile.publish`/`profile.rollback`, cùng lý do OIDC-03 với `apikey.*` (`dispatcher.ts:104-113`). Điều này khớp BFF hiện gate `ctx.role === admin && principal.kind === platform` (`app/admin/bff/profiles.ts:133-141`) — không cần đổi hàng rào nào.
- **DD/D6** (`apps/admin-web/src/lib/api/client.ts:37` `expectedRevision?: string | number`): chốt `number` để khớp `ProfileRevisionSchema` (`profile-policy.ts:56-60` z<number>). Lưu ý file thuộc `apps/admin-web` — **không có trong lease của tôi**, nên tôi ghi lại thành hành động cho lane UI; chỉ sửa khi được cấp.
- `src/server.ts` mount: **không cần chạm** — route `/api/v1/admin/actions` và route mount BFF đã tồn tại (`admin.ts:296`), dispatcher nối thêm case. Không cần xin cửa sổ độc quyền.
- Prompt-override / assignment: ngoài phạm vi cycle này (Δ3 seam client? của `prompt-overrides.ts:68`; assignment.* NO-GO vì T-AUTH-03/VFY-LOCAL).

## 3 — Kế hoạch implement khi lease được mở rộng (tôi đã sẵn sàng làm ngay)

1. Leaf mới `modules/admin-actions/profile-actions.ts`: parse params bằng schema freeze (`.strict()` fail-closed 422), resolve profileId theo (A)/(B), export `PROFILE_ACTIONS: Record<string, ActionDef>` admin-only.
2. `dispatcher.ts`: +3 case mỏng + spread `PROFILE_ACTIONS` vào `ADMIN_ACTIONS`; mỗi case `executeIdempotent` -> `auditedMutation(db, audit, mutate, auditOf, withMarker)`; `mutate(client)` **chuyển client xuống** `createRevision(input, client)` / `publishRevision(.., client)` / `rollbackTo(.., client)` — nếu quên client thì service tự mở tx riêng và audit mất nguyên tử (đúng lỗi R3-01/cycle-99 đã sửa cho resume).
3. Test offline: positives CAS đúng/sai (409 `REVISION_CONFLICT`), tenant fence foreign+unknown không phân biệt được, CSRF trước role, Idempotency-Key replay/rút-lại-payload-khác (409), read-after-write, fail-closed .strict() unknown key. 3 lần exit 0 liên tiếp mới tuyên bố PASS.
4. Chỉ sau Δ2+seam: closure detail read (`admin.ts:419-455`) thành dữ liệu thật.

## 4 — Δ-DEVIATION (mới của cycle này)

- **Δ7 (blocker)**: action contract ProfileKey thiếu khóa định danh; không chốt được mapping trong lease (mục 1.1).
- **Δ8 (blocker)**: T-AUD-01 seam không thuộc lease; trong lease chỉ nâng actor lên `admin:<role>`, không đạt "principal id thật kèm role/tenant" (mục 1.2).
- **Δ9**: closure T-API-01 là tiền đề của T-API-02 (detail read phải reveal khóa), ngược thứ tự giả định của W3.
- **Δ10**: `apps/admin-web/src/lib/api/client.ts` (DD-06) ngoài lease — cần giao lane UI hoặc cấp lease.

## 5 — Trạng thái

- Sửa đổi: **chỉ 2 file receipt** (`p730-admin-mutate-2026-10-04.md` này + đính chính Δ5 trong `p730-api-audit-prep-2026-10-04.md`). 0 byte product code.
- Không test (không có code để test), không chạy lint/build. Không có Exit Code literal.
- Đính chính đã thực hiện: prep receipt từng nói "7 code PROFILE_* không có throw site" — SAI. Đo lại: `PROFILE_LOCKED_FIELD`/`PROFILE_UNKNOWN_FIELD` throw tại `modules/profiles/policy.ts:136,143`; `PROFILE_EXTENSION_DENIED` tại `modules/operations/submission.ts:790,801,816`. Còn thiếu throw site: `PROFILE_FORBIDDEN`, `PROFILE_NOT_FOUND`, `PROFILE_SLUG_UNKNOWN`.
- Chờ Coordinator: Δ7/Δ8 (lease + quyết định schema). Không tick gate.

## 6 — LEASE-ANNOUNCE (single writer, theo điều kiện phân xử Δ8)

Trước khi ghi, tôi đo mtime bằng `for %F in (...) do @echo %~tF` lúc 20:40 +07 (Exit Code 0):

| File | mtime | So với checkpoint coordinator |
|---|---|---|
| `packages/contracts/src/profile-policy.ts` | 10/04 18:17 | đúng mốc 18:17, không lane nào ghi sau |
| `packages/contracts/tests/profile-policy.test.ts` | 10/04 15:24 | trống |
| `packages/contracts/src/index.ts` | 10/04 14:43 | trống (`export * from ./profile-policy` dòng 14 — re-export tự động) |
| `services/orchestrator/src/modules/admin-actions/rbac.ts` | 10/02 04:08 | trống |
| `services/orchestrator/src/modules/auth/session-store.ts` | 09/26 12:52 | trống |
| `services/orchestrator/src/modules/audit/audit.ts` | 10/03 01:06 | trống |
| `services/orchestrator/src/modules/admin-actions/dispatcher.ts` | 10/02 02:58 | trống |
| `services/orchestrator/src/app/admin/bff/profiles.ts` | 10/04 12:59 | trống |
| `apps/admin-web/src/lib/api/client.ts` | 10/04 13:54 | trống |

**LEASE ĐANG GIỮ (tôi là writer duy nhất, cycle này):**
- `packages/contracts/src/profile-policy.ts`, `packages/contracts/tests/profile-policy.test.ts` (re-export không cần sửa index.ts — `export *` đã có).
- `services/orchestrator/src/modules/admin-actions/rbac.ts`, `modules/auth/session-store.ts`, `modules/audit/audit.ts` — **chỉ ADDITIVE**: thêm field optional/kolom mới, không đổi hoặc loại export hiện có, caller không có principal giữ nguyên hành vi `admin:<role>`.
- `services/orchestrator/src/modules/admin-actions/dispatcher.ts` + leaf mới `modules/admin-actions/profile-actions.ts`.
- `services/orchestrator/src/app/admin/bff/profiles.ts` (chỉ forward khóa mới trong params).
- `apps/admin-web/src/lib/api/client.ts` — **duy nhất `expectedRevision?: string | number` -> `number`** (Δ10).
- migration mới `services/orchestrator/migrations/0028_profile_name.sql` + `0029_audit_actor_principal.sql` (tách 2 file vì 2 concern; cả hai ADDITIVE).
- Test mới trong `services/orchestrator/tests/**` và test mới trong `packages/contracts/tests/profile-policy.test.ts`.

**KHÔNG chạm:** `src/server.ts`, `modules/profiles/publish.ts` (read-only), `modules/operations/submission.ts`, `apps/admin-web` ngoài dòng DD-06.

---

## 7 — LEASE-ANNOUNCE (cc_2 tiếp quản — 2026-10-04 21:47 +07)

Packet `P730-ADMIN-MUTATE` chuyển từ qwen_3 (stream hỏng lặp) sang **cc_2**; task `task_d3d24feeea5e`. Quyết định đã chốt áp dụng: Δ7=(A) (migration 0028 + ApiKeyRef `.transform()` non-breaking + leaf resolve), Δ8 (lease rbac/session-store/audit + migration, additive-only, fallback `admin:<role>` giữ nguyên), Δ10 (client.ts 1 dòng), Δ9 (seam trước, closure detail read sau).

**Pre-write guard (21:47:14, HEAD `b088eec`; SHA-256 16 ký tự đầu):**

| File | mtime | sha16 |
|---|---|---|
| `packages/contracts/src/profile-commands.ts` (qwen_3 20:58) | 10-04 20:58:39 | `1F14C5ED0E5B9B11` |
| `packages/contracts/tests/profile-commands.test.ts` (qwen_3 21:01) | 10-04 21:01:55 | `C1C1B89067ABD0AA` |
| `packages/contracts/src/index.ts` | 10-04 20:59:07 | `8ECFE96C715DF800` |
| `services/orchestrator/src/modules/audit/audit.ts` | 10-03 01:06:38 | `B7F826CC14BE9127` |
| `services/orchestrator/src/modules/admin-actions/rbac.ts` | 10-02 04:08:33 | `074F9E5178A2967E` |
| `services/orchestrator/src/modules/auth/session-store.ts` | 09-26 12:52:15 | `BAB332D06F7E1D37` |
| `services/orchestrator/src/modules/admin-actions/dispatcher.ts` | 10-02 02:58:51 | `9F39B13F7626F912` |
| `services/orchestrator/src/app/admin/bff/profiles.ts` | 10-04 12:59:38 | `09D460D429326964` |
| `apps/admin-web/src/lib/api/client.ts` | 10-04 13:54:50 | `40783AD18FF35226` |
| `modules/admin-actions/profile-actions.ts`, `migrations/0028+0029`, test mới | MISSING (tạo mới) | — |

**Sự thật cần đính chính:** `audit.ts` M từ **10-03 01:06** (refactor CONV-13 `AuditRow`/`toAuditWire`) — KHÔNG phải qwen_3 sửa hôm nay; tôi giữ nguyên phần đó và chỉ thêm field additive.

**LEASE ĐANG GIỮ (cc_2 = single writer, cycle này):** profile-commands.ts + test của nó; index.ts (đã export sẵn — không sửa trừ khi buộc); rbac.ts + session-store.ts + audit.ts (**additive-only**); dispatcher.ts + leaf mới `profile-actions.ts`; bff/profiles.ts (forward khóa); client.ts (đúng 1 dòng Δ10); migrations 0028/0029 (mới, additive); test mới `tests/p730-admin-mutate-offline.test.ts`.

**Δ-DECOMP (ghi để coordinator phán nếu cần):** 0028 triển khai dạng **bảng registry `profile_names`** (profile_id PK + unique `(tenant_id, api_key_id, business_id, business_version, action, profile_name)`) thay vì cột `profile_name` trên `profile_bindings`, vì: (1) unique key không thể áp lên bảng append-only (sẽ chặn revision N+1 của chính profile đó); (2) ghi cột trên `profile_bindings` đòi sửa `profiles.ts` — ngoài lease hiện tại; (3) registry là artifact của leaf, giữ single-writer. Leaf resolve (b,v,n,apiKeyRef)→profileId qua bảng này TRƯỚC khi ghi, đúng semantics Δ7-A. Nếu coordinator muốn cột-on-bindings, cần named lease cho `profiles.ts` — chờ quyết.

**KHÔNG chạm (giữ nguyên):** `src/server.ts`, `modules/profiles/publish.ts`, `modules/profiles/profiles.ts`, `modules/operations/submission.ts`, `runtime.ts` (qwen_4 W1c), `worker-sdk/**` + `document-core/**` (qwen_2).

---

## 8 — KẾT QUẢ THỰC THI (cc_2, 2026-10-04 21:47 → 22:2x +07)

**Trạng thái: DONE (offline slice).** Δ7(A) + Δ8 + Δ10 đã triển khai; gate focused xanh 3× liên tiếp; tsc 2 package 0. Không commit/push.

### 8.1 File đã ghi (post-edit sha16)

| File | Việc | sha16 |
|---|---|---|
| `packages/contracts/src/profile-commands.ts` | ApiKeyRefSchema thêm `.transform()` chuẩn hoá `{kind:'id'\|'hash'}` (cả 2 wire vẫn parse) | `908B870B62792A51` |
| `packages/contracts/tests/profile-commands.test.ts` | +1 pin output-shape transform | `726B3ACD489C28BA` |
| `migrations/0028_profile_name.sql` (MỚI) | registry `profile_names` + unique identity index | `5289210AC79726CC` |
| `migrations/0029_audit_actor_principal.sql` (MỚI) | +3 cột nullable `actor_issuer/sub/role` | `96C03D2B5C06F329` |
| `modules/audit/audit.ts` | `AuditRecordInput` +3 optional; INSERT 9 cột (additive) | `1076E2B36956A4CC` |
| `modules/admin-actions/rbac.ts` | cookie-auth `principalId?/issuer?`; `AdminSessionView.sub?`; async resolver mang principal | `55FE5EE47A97955B` |
| `modules/auth/session-store.ts` | `sessionToActionAuth` mang `principalId/issuer` | `7B64F1AD0B1821C7` |
| `modules/admin-actions/profile-actions.ts` (MỚI) | leaf: resolve apiKeyRef→key→registry→profileId TRƯỚC ghi; CAS upsert; publish/rollback + 23503→404 | `8BB9D69D7FBB4E0E` |
| `modules/admin-actions/dispatcher.ts` | spread `PROFILE_ACTIONS` + 3 case (executeIdempotent→auditedMutation→leaf), `auditPrincipalFields` | `3579B01815798A4C` |
| `app/admin/bff/profiles.ts` | forward `body.apiKey` (strict-check object) | `BBB412C25EE803D0` |
| `apps/admin-web/src/lib/api/client.ts` | **Δ10 đúng 1 dòng**: `expectedRevision?: number` | `39B972C00C4F2CE3` |
| `tests/p730-admin-mutate-offline.test.ts` (MỚI) | 18 test offline (stateful fake + undo-journal) | `785D9CE294C8936F` |
| `tests/session-store.test.ts` / `admin-shell-session-lifecycle.test.ts` / `admin-oidc04-claims-tenant-offline.test.ts` | cập nhật pin shape (+2 field mới; KHÔNG giảm assertion) | `7A3DC22E…` / `37060098…` / `A74BB3E8…` |

### 8.2 Gate literal

```
contracts build:  CONTRACTS_BUILD_EXIT=0     (pnpm exec tsc -p tsconfig.json — cần cho orchestrator resolve @du/contracts dist)
contracts tsc:    CONTRACTS_TSC_EXIT=0       (pnpm exec tsc --noEmit -p tsconfig.json)
orchestrator tsc: ORCH_TSC_EXIT=0            (pnpm exec tsc --noEmit -p tsconfig.json)
admin-web tsc:    ADMINWEB_TSC_EXIT=0        (apps/admin-web: pnpm exec tsc --noEmit -p tsconfig.json — Δ10)

Focused set 3× liên tiếp (cwd tương ứng):
  contracts : Test Suites: 2 passed / Tests: 39 passed  — exit 0 ×3 (profile-commands + profile-policy)
  orch      : Test Suites: 9 passed / Tests: 215 passed — exit 0 ×3
              (p730-admin-mutate-offline 18, admin-mutation-atomicity, admin-action-dispatcher,
               session-store, admin-idempotency, oidc03-role-action-tenant-offline,
               admin-oidc04-claims-tenant-offline, admin-api-keys, aweb04-bff-profiles)
Suite mới riêng: 18/18 passed, exit 0.
```

**2 test listener standing-red (chứng minh PRE-EXISTING bằng A/B):** `admin-shell-session-lifecycle` còn đỏ đúng 2 test (*mount default … legacy mint* + *default console sink*) — A/B **swap 4 file tracked (rbac/dispatcher/session-store/audit) về HEAD** → tái hiện **y hệt 2 failed** (49 skipped); restore hash-verified `RESTORED_ALL_MATCH=True`. Ngoài ra suite này nằm trong danh sách "11 suite standing" đã A/B trước đó (`cc-conv02-2026-10-03.md:70` — ambient NODE_ENV). **4 lỗi ban đầu do pin shape của tôi (đã sửa) + 2 standing này; không phải regression từ nhánh W3.**

### 8.3 Δ ghi nhận khi thi công

- **Δ-DECOMP (0028):** triển khai dạng bảng registry `profile_names` (không phải cột trên `profile_bindings`) — lý do đã ghi ở §7: unique key không áp được lên bảng append-only (chặn revision N+1) và ghi cột sẽ cần lease `profiles.ts` (ngoài cấp). Leaf resolve qua registry trước khi ghi, đúng semantics Δ7-A. Nếu coordinator muốn cột-on-bindings → cần named lease `profiles.ts`, chờ quyết.
- **Δ7 transform:** thực hiện literal `.transform()` trên ApiKeyRefSchema (output normalize `{kind:'id'|'hash'}`); wire cũ `{apiKeyHash}`/`{apiKeyId}` giữ parse; test pin output-shape mới.
- **Δ8 phạm vi:** principal fields hiện gắn cho 3 case `profile.*` (đúng T-AUD-01 slice). Các case cũ giữ `actor` như trước (additive — không đổi hành vi). Nếu muốn áp toàn bộ actions → packet riêng.

### 8.4 Chưa chứng minh / gaps (theo lane rules)

1. **Real PG**: serialization `FOR UPDATE`, unique-race registry, FK 23503 thật — chỉ mô phỏng offline (DD-07 live follow-up như cũ); acceptance live vẫn mở.
2. **Closure T-API-01 (detail read)**: chưa làm — Δ9 "seam trước, closure sau"; UI end-to-end (apiKey từ detail read) còn chờ packet closure.
3. **Idempotency marker race live** (23505 → replay winner) chưa chạy trên PG thật.
4. Scoped USER (`VFY-LOCAL`), prompt-override.*, assignment.* — ngoài phạm vi, không mở.
5. `auditPrincipalFields` chưa áp cho mọi action cũ (chủ ý additive).

**Đề xuất kế tiếp cho coordinator:** (1) independent verify slice này (pattern W2-B/cc_1 audit) trước khi tick; (2) mở packet closure T-API-01 detail read (dùng `profile_names` + `profile_active_revisions` để trả `profileId`/`revision` thật); (3) live window cho PG serialization/FK cells.
