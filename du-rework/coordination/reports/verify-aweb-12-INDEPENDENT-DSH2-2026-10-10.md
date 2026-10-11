# Verify độc lập (DSH2) — AWEB-12 Profiles table view — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY**: `apps/admin-web/src/features/profiles/profiles-screen.tsx`, `apps/admin-web/tests/profiles-state.test.mjs`, `services/orchestrator/tests/aweb12-profile-list.test.ts`, BFF profiles router — mở rộng đọc sang các module mà đường đọc này chạm (`profile-list.ts`, `keyset.ts`, route admin, `profile-detail.ts`, migrations 0004/0028).
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test offline; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** DB/Redis; **KHÔNG** đọc `.env.live`.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`) · ambient `NODE_ENV=production`.
**Raw:** `coordination/reports/raw/verify-aweb-12-2026-10-10/DSH2/` — 7 log + `08-dsh2-probe.cjs` (probe độc lập của tôi) + `SHA256SUMS.txt`.
**Receipt được kiểm:** `coordination/reports/receipt-aweb-12-profiles-table-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| **AWEB-12 list + table view** | **PASS ở phạm vi offline** — `node --test` 3/3, jest 14/14, probe độc lập **18/18**, typecheck/build xanh |
| **Tenant/business filter** | **PASS, 3 lớp khớp nhau** — screen → BFF (allowlist + scope từ principal) → SQL (`n.tenant_id = $1` bắt buộc, `business_id` tuỳ chọn `$2`), có bằng chứng HTTP thật |
| **Cursor pagination** | **PASS** — cursor bind thành `(timestamp, uuid)`, probe `limit + 1`, `nextCursor` chỉ khi còn hàng, `prevCursor` chỉ khi đã có cursor; count query **không** mang cursor/limit |
| Claim #4 của receipt (`applyCursor` unused ⇒ strict typecheck đỏ) | **KHÔNG TÁI HIỆN ĐƯỢC** — `applyCursor` hiện được dùng ở 6 chỗ; strict tsc và `npm run build` đều exit 0 (§2 #10) |
| **F1 — Open của tenant operator nhận 401** (ngoài lease AWEB-12) | **Phát hiện mới, MEDIUM, fail-closed** — BFF forward credential tenant nhưng route detail chỉ nhận platform token (§5.1) |
| **F2 — trùng tên profile ⇒ React key trùng + Open có thể mở sai hàng** (ngoài lease) | **Phát hiện mới, LOW–MEDIUM, theo schema** — registry cho phép nhiều `profile_id` cho cùng tên; chưa chứng minh bằng dữ liệu thật (§5.2) |

**Một dòng cho coordinator:** AWEB-12 **đạt verify độc lập ở phạm vi offline** (18/18 probe + 3/3 + 14/14 + build xanh, fence tenant/business/cursor đều có bằng chứng); nhưng nút **Open** dẫn tới route detail chỉ chấp nhận platform token ⇒ **tenant operator bấm Open sẽ 401** (F1), và cùng tên profile có thể sinh nhiều hàng (F2) — cả hai nằm **ngoài lease AWEB-12**, cần route sang owner tương ứng.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `node --test tests/profiles-state.test.mjs` (`apps/admin-web`) | **0** | `✔ parseProfileListPage` · `ℹ tests 3` · `ℹ pass 3` · `ℹ fail 0` |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb12-profile-list.test.ts tests/aweb04-bff-profiles.test.ts` (`services/orchestrator`) | **0** | `PASS` ×2 · `Test Suites: 2 passed, 2 total` · `Tests: 14 passed, 14 total` |
| 3 | probe độc lập DSH2 (`08-dsh2-probe.cjs`) | **0** | `PROBE_RESULT 18/18 checks passed` (A1–A3 parser, B1–B4 SQL/keyset, C1–C3 web parse, D1–D5 BFF HTTP, E1–E3 screen) |
| 4 | `tsc --noEmit -p tsconfig.json` (`services/orchestrator`) | **0** | 0 dòng output |
| 5 | `tsc --noEmit -p tsconfig.json --noUnusedLocals false` (`apps/admin-web`) | **0** | 0 dòng output |
| 6 | `tsc --noEmit -p tsconfig.json` (strict, `apps/admin-web`) | **0** | 0 dòng output |
| 7 | `npm run build` (`apps/admin-web`, `tsc && vite build`) | **0** | `✓ built in 8.59s`; chunk 1 046.08 kB + cảnh báo >500 kB (đã biết) |

Artifact đã kiểm (sha256 · mtime · git):

| File | sha256 | mtime | git |
|---|---|---|---|
| `apps/admin-web/src/features/profiles/profiles-screen.tsx` | `c607bab6…a104` | 21:56:57 | ` M` |
| `apps/admin-web/src/features/profiles/state.ts` | `3838ee90…299f` | 21:52:57 | ` M` |
| `apps/admin-web/tests/profiles-state.test.mjs` | `b9fcca13…0827` | 21:53:42 | `??` |
| `services/orchestrator/src/modules/admin-read/profile-list.ts` | `c406a2bf…f3ff` | 21:48:55 | `??` |
| `services/orchestrator/src/modules/admin-read/keyset.ts` | `d841f472…3bdf` | 10-07 04:30:18 | sạch |
| `services/orchestrator/src/app/admin/bff/profiles.ts` | `671ddf10…c53d` | 21:49:41 | ` M` |
| `services/orchestrator/src/http/routes/admin.ts` | `3869fdfc…f889` | 21:49:04 | ` M` |
| `services/orchestrator/tests/aweb12-profile-list.test.ts` | `ddf64c35…dbb6` | 21:53:42 | `??` |
| `services/orchestrator/tests/aweb04-bff-profiles.test.ts` | `fc5df9d0…8130` | 21:54:35 | ` M` |
| `apps/admin-web/src/features/operations/operations-screen.tsx` | `f2ca1c64…22b4` | 21:57:23 | ` M` |

---

## 2. Đối chiếu từng claim của receipt

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Catalog tenant-scoped, có business filter, nhóm theo business | **ĐÚNG** | screen `:152-153` (query tenant + business), `:172` (effect phụ thuộc filter), `:702-705` (group theo `row.businessId`), `:803-809` (hàng tiêu đề nhóm + số lượng); probe E1 |
| 2 | Cột: tên, business version, status active/disabled, số key active, bound actions | **ĐÚNG** | `:793-798` 6 tiêu đề + probe E2 khớp từng chuỗi; `:815-824` badge status/keyCount/boundActions |
| 3 | Mở profile theo identity business/version/name | **ĐÚNG (về wiring)** | `:831` `load(undefined, {businessId, businessVersion, profileName})`; probe E3. *Hiệu lực thực tế cho tenant operator bị chặn bởi F1 (§5.1)* |
| 4 | Paging bằng cursor của BFF | **ĐÚNG** | `:354-362` dùng `nextCursor` + `limit` của trang hiện tại; `:843-849` nút Load more chỉ khi `nextCursor !== null`; `:374-377` nối items |
| 5 | Các state loading / empty / 401-403 / malformed / upstream-network tách biệt | **ĐÚNG** | `:766-781` (no tenant → banner; loading → LoadingState; 401/403 → DeniedState; khác → ErrorState), `:778-781` (empty riêng), `:161-167` + `:370-379` (`UNREADABLE_RESPONSE`, `NETWORK_ERROR`), `:784-788` (lỗi khi load-more vẫn giữ hàng đã tải); probe E2 |
| 6 | Client từ chối hàng ngoài tenant/business đã chọn | **ĐÚNG** | `state.ts:216-217`; probe C1 (hàng khác tenant → `null`, khác business → `null`) |
| 7 | BFF chỉ forward business + pagination, tenant suy từ principal, có fence operator | **ĐÚNG** | `bff/profiles.ts:377` allowlist đúng `businessId|limit|cursor|sort`; `:395` `authorizeAuditTenantRead(rbacPrincipal(principal), query.tenantId)`; `:419-420` set/delete `tenantId` theo scope; `:388-391` unscoped → 403 `PROFILE_SCOPE_GATE`. Probe D1–D5 (HTTP thật, nguồn TS hiện tại) |
| 8 | Upstream: tenant predicate bắt buộc + business tuỳ chọn, không lộ key material | **ĐÚNG** | `profile-list.ts:70-75` (`n.tenant_id = $1`, business `$2`); `:92-98` select list chỉ metadata + `key_count` + `bound_actions`; probe B1/B4 (`raw_key`, `key_hash`, `secret`, `prefix`, `api_key_id`, `token` **không** có trong select list) |
| 9 | `node --test` 3 passed; jest 14 passed; orchestrator typecheck pass; admin-web tsc `--noUnusedLocals false` + vite build pass | **ĐÚNG** | lệnh #1–#3, #4, #5, #7 khớp từng con số |
| 10 | `npm run typecheck` / `npm run build` của admin-web **báo lỗi** `operations-screen.tsx(134,9): 'applyCursor' is declared but its value is never read` | **KHÔNG TÁI HIỆN ĐƯỢC (đã hết hiệu lực)** | `applyCursor` khai báo tại `:134` và **đang được dùng** tại `:264, :280, :287, :291, :295, :433-435`; strict tsc exit 0 và `npm run build` exit 0 (lệnh #6, #7). File đổi lúc `21:57:23` — đúng lúc receipt ghi `21:57:59` ⇒ lỗi đó là **trạng thái giữa-edit của lane khác**, nay đã xong |
| 11 | Không stage/commit/push, không tick gate | **ĐÚNG** | không có `git add`/commit nào trong lượt của tôi; cây vẫn dirty như trước |

---

## 3. Tenant/business filter — ba lớp, kiểm bằng probe riêng

**Lớp 1 (screen):** query gửi `tenantId: globalTenantId` + `limit: '100'` + `businessId` khi có filter (`:152-153`, `:358-363`); parse luôn truyền tenant + business đã chọn (`:160`, `:369`).

**Lớp 2 (BFF, HTTP thật trong probe D):**
| Probe | Kịch bản | Kết quả đo được |
|---|---|---|
| D1 | operator tenant A đọc list | upstream `…?businessId=document-core&limit=25&tenantId=11111111-1111-4111-8111-111111111111`, `Authorization: Bearer <tenant A token>` (không phải platform token) |
| D2 | operator tenant A hỏi `tenantId=B` | **403 `PERMISSION_DENIED`, 0 request tới upstream** |
| D3 | operator gửi thêm `ignored=1&adminToken=leak` | upstream chỉ nhận `sort=…&tenantId=A`; không có `ignored`, không có `leak` |
| D4 | platform admin chọn tenant A | upstream có `tenantId=A&limit=50`, credential platform |
| D5 | platform admin **không** chọn tenant | upstream **không** có `tenantId` (route upstream khi đó trả trang rỗng theo thiết kế `admin.ts:559-563`) |

**Lớp 3 (SQL):** `listAdminProfilePage` luôn đặt `n.tenant_id = $1` là bind đầu tiên và **không** nội suy tenant vào câu SQL; business thành `$2` khi có. Probe B1: params `[T, 101]` (không business) và `[T, doc-core, 26]` (có business, limit 25); count query dùng lại đúng `WHERE` đó với params chỉ gồm filter. Probe A2: 6 input thù địch (tenant lặp, tenant không UUID, business 257 ký tự, business chứa `%00`, sort lạ, cursor rác) đều bị **422 `INVALID_SCHEMA`**; A1: limit được kẹp `[1, 200]` (`ADMIN_LIST_LIMIT_MAX`).

---

## 4. Cursor pagination — kiểm độc lập

| Kiểm | Kết quả |
|---|---|
| Cursor là **bind param**, không nội suy | B2: params `[T, doc-core, '2026-10-10T08:00:00.000000Z', <uuid>, 26]`, SQL chỉ chứa template `::timestamptz, $n::uuid`; **không** chứa uuid cursor |
| Probe `limit + 1` | B1/B2: param cuối luôn `limit + 1` (26 cho limit 25, 101 cho limit 100) |
| `nextCursor` chỉ khi còn hàng | B3: 3 hàng với limit 2 ⇒ trả 2 hàng + `nextCursor !== null`; trang sau chỉ 1 hàng ⇒ `nextCursor === null` |
| `prevCursor` không tự trỏ về chính nó | B3: trang 1 (`cursor === null`) ⇒ `prevCursor === null`; trang 2 (đến bằng cursor) ⇒ `prevCursor !== null` (khớp `keyset.ts:184-187`) |
| Count không mang cursor/limit | B2: `calls[1].params = [T, doc-core]`, `total = 7` |
| Cursor phải cùng `sort` | `keyset.ts:100-102` chặn cursor khác sort bằng 422; A2 phủ cursor rác |
| Cursor id phải là UUID | `profile-list.ts:54-56` (thêm cho profile list) |

---

## 5. Hai phát hiện mới (ngoài lease AWEB-12 — không sửa, chỉ báo cáo)

### 5.1 F1 — nút Open của tenant operator đi vào route chỉ nhận platform token (MEDIUM, fail-closed)
Chuỗi bằng chứng:
1. BFF detail read chọn credential theo principal: platform → platform token; operator → **tenant token** (`bff/profiles.ts:356-359`, `upstream.ts:67-71`).
2. Route upstream cho detail dùng `assertAdminAuth(ctx)` (`http/routes/admin.ts:592`), mà hàm này **chỉ** chấp nhận đúng `Bearer <config.adminToken>` và ném 401 cho mọi token khác (`admin.ts:63-74`).
3. Trong khi đó route **list** (AWEB-12) dùng `resolveAdminPrincipal` + `authorizeAuditTenantRead` (`admin.ts:553-558`), và `resolveAdminPrincipal` **có** nhận tenant token (`rbac.ts:30-55`).
⇒ **Tenant operator xem được bảng Profiles nhưng bấm Open sẽ nhận 401**; platform admin thì Open bình thường. Đây là **mismatch BFF ↔ upstream**, không phải lỗ hổng (fail-closed).
**Vì sao offline test không thấy:** `aweb04-bff-profiles.test.ts:244-252` khẳng định operator read được forward kèm tenant credential và mong 200 — nhưng stub upstream của test **luôn trả 200**, nên nó không thể phát hiện upstream thật từ chối tenant token. Probe D của tôi cũng dùng stub, nên **tôi cũng chưa chứng minh end-to-end** — kết luận này là **đọc code có file:line**, cần một lượt live (hoặc unit test trên route với 2 token) để chốt.

### 5.2 F2 — cùng tên profile có thể sinh nhiều hàng ⇒ React key trùng và Open có thể mở sai hàng (LOW–MEDIUM)
1. Registry `profile_names` có unique index `(tenant_id, api_key_id, business_id, business_version, action, profile_name)` (`migrations/0028_profile_name.sql:33-34`), và write path resolve theo **đủ 6 cột** (`admin-actions/profile-actions.ts:97-102`).
2. ⇒ Với cùng `(tenant, business, version, name)` nhưng khác `api_key_id`/`action`, hệ thống tạo **các `profile_id` khác nhau**; list AWEB-12 join `profile_names` theo tenant (+business) nên trả **nhiều hàng cùng tên** (`profile-list.ts:77-80`).
3. Screen đặt React key `${businessId}:${businessVersion}:${profileName}` (`profiles-screen.tsx:811`) ⇒ **key trùng** khi đó; nhóm theo business đếm từng hàng.
4. Nút Open gọi `load(businessId, businessVersion, profileName)`; route detail resolve bằng **chỉ 3 cột** với `ORDER BY a.moved_at DESC, n.profile_id LIMIT 1` (`admin-read/profile-detail.ts:49-61`) ⇒ có thể mở **profile khác hàng vừa bấm**.
Đã kiểm ngược để loại trừ khả năng nhân dòng: `profile_bindings` có `PRIMARY KEY (profile_id, revision)` (`migrations/0004_profile_bindings.sql:25`) và `profile_names.profile_id` là PK (`0028:22-31`) ⇒ mỗi profile chỉ 1 hàng; rủi ro **không** đến từ JOIN mà từ **nhiều profile_id cùng tên**.
**Chưa chứng minh end-to-end** (không có DB để tạo 2 hàng cùng tên), nên ghi là **rủi ro theo schema + code**, không phải bug đã tái hiện.

---

## 6. GAP / open items

1. **Định tuyến F1** cho owner của route detail/BFF credential (không phải AWEB-12): hoặc route detail phải nhận tenant principal kèm fence tenant, hoặc BFF phải chặn operator ở detail bằng `PROFILE_SCOPE_GATE` như nó làm với unscoped — hiện tại nó forward rồi để upstream 401.
2. **Bổ sung test bắt được F1**: một test route-level với **2 token** (platform + tenant) sẽ phát hiện ngay; test BFF hiện tại không thể vì stub luôn 200.
3. **F2**: nếu muốn bảng định danh duy nhất theo tên, cần hiển thị thêm `apiKeyId`/`action` (hoặc dùng `profile_id` làm key); nếu không, ít nhất React key phải là duy nhất. Cần owner của registry/detail xác nhận mô hình danh tính.
4. **Nghi vấn kèm theo (chưa kết luận):** `loadProfileDetail` không có predicate tenant (`profile-detail.ts:57`) — với principal platform thì đúng thiết kế (platform đọc cross-tenant), nhưng nếu sau này route mở cho tenant principal (theo hướng sửa F1) thì **phải** thêm fence tenant, nếu không sẽ thành đọc chéo tenant. Ghi lại để không sửa F1 theo hướng mở toang.
5. **Claim #10 của receipt đã hết hiệu lực** — nếu coordinator dùng receipt làm bằng chứng, nên ghi đính chính để không hoãn acceptance vì một lỗi đã được lane khác xử lý xong.
6. **Quan sát nhỏ:** `parseProfileListPage` kiểm `createdAt`/`updatedAt` là string nhưng **không** `Date.parse` (khác `parseProfileWorkflowPage:161`); probe C3 ghi nhận hành vi hiện tại — không phải khiếm khuyết đã chứng minh, chỉ là ranh giới strictness.
7. **Không có browser/runtime evidence** cho bảng này: mọi thứ là offline + HTTP BFF với stub; live/browser gate vẫn mở.

---

## 7. Xác nhận

- Chỉ **đọc** + chạy lệnh; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 8 file raw trong `coordination/reports/raw/verify-aweb-12-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe nằm trong raw để tái lập; probe **không** ghi gì vào repo (chỉ bind cổng loopback tạm và đóng lại trong `finally`).
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Mọi kết luận gắn sha256 tại §1; các file AWEB-12 đều là thay đổi **chưa commit** nên kết quả chỉ đúng cho revision đã ghi.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
