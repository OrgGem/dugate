# OR10-01 — Technical specification: origin allowlist cho source credential, do admin duyệt (2026-10-10)

> **Trạng thái: PROPOSAL (chưa implement, chưa đánh giá, không tick gate).** Tài liệu chỉ đọc + khảo sát source, ghi đúng `file:line`; chưa sửa một dòng code nào. Quyết định thuộc admin/coordinator.
> **Scope:** `du-rework` · **Vị trí khảo sát:** `services/orchestrator/src/modules/operations/{acquisition-ref-resolver.ts, ingestion-consumer.ts}`, `packages/contracts/src/{profile-policy.ts, legacy-workflow.ts, profile-callback.ts, operations.ts, ip-policy.ts}`, `packages/egress/src/pinned-fetch.ts`, `businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts`.

## 1. Tóm tắt điều hành

**Vấn đề:** credential nguồn (bearer token / header) giải mã từ profile **không gắn với origin nào cả** — `FileUrlAuthConfigSchema` chỉ có `{type, token, header_name, header_value, query_*}` (`packages/contracts/src/profile-policy.ts:240-250`). `withSourceAuth` gắn credential cho **bất kỳ origin nào của URL đầu tiên** (`acquisition-ref-resolver.ts:262-289`), tức `sourceUrl` do người submit chỉ định. Pin theo origin chỉ chặn **rò rỉ khi redirect hop**, không chặn **gửi tới sai origin từ đầu**.

**Khuyến nghị (1 dòng):** thêm allowlist **exact-origin** cạnh credential ở profile (reuse `CallbackApprovedOriginSchema`), admin duyệt qua cổng **publish profile đã có** (platform admin + CSRF + `expectedRevision` CAS), kiểm tra tại `openGate` trước mọi I/O với mode `warn → enforce`, ghim theo đúng `(profile_id, revision)` mà `credentialRef` đã pin sẵn.

## 2. Khảo sát hiện trạng (mọi dòng đều đọc trực tiếp)

| # | Thành phần | File:line | Điều đã xác nhận |
|---|---|---|---|
| 1 | `resolveSourceAuth` | `acquisition-ref-resolver.ts:160-257` | Đọc **đúng dòng pin** `(profile_id, revision)`; tenant là trust anchor (mismatch → 403); decrypt tại chỗ; **6 mã từ chối fail-closed**; query-auth bị cấm (Δ2) |
| 2 | Hình dạng credential | `profile-policy.ts:240-250` | **Không có trường URL/origin nào** — credential theo bản chất là origin-less |
| 3 | `withSourceAuth` | `acquisition-ref-resolver.ts:262-289` | Pin `originalOrigin` của **URL đầu**; cross-origin → bỏ credential (redaction, không fallback); origin không parse được → không gắn (fail-closed); **không bao giờ throw**, **không check allowlist nào** |
| 4 | Điểm gọi duy nhất | `ingestion-consumer.ts:577-585` | `openGate`: resolve **sau** lease renew, **trước** mọi mạng; `s3://` bỏ qua resolver (`:578`); wrap `options.transfer.fetcher ?? createPinnedFetch()` (`:585`). Grep `withSourceAuth` trong `src/` = đúng 3 hit (import, call, definition) |
| 5 | Egress/SSRF | `ip-policy.ts:244`, `:150-220`; `pinned-fetch.ts:164` | Chính sách **ở mức IP**: chặn private/loopback/link-local/CGNAT/multicast + unwrap v4-in-v6/6to4/Teredo/NAT64; **origin công khai thì ĐƯỢC phép** → lỗ hổng vẫn mở |
| 6 | Submit-time | `operations.ts:273`, `:289` | `sourceUrl` (max 2048, `https:` hoặc `s3://`) chạy `adjudicateUrlDestination` lúc parse — chặn destination xấu, **không** giới hạn host công khai |
| 7 | Escalation taxonomy | `ingestion-consumer.ts:410-420` | `failureCode()` phân nhánh theo **class** `SourceAuthDeniedError` → mã mới tự đi vào taxonomy; `PERMANENT_CODES` ở `:300` phải thêm mã mới nếu không sẽ retry vô ích |
| 8 | Test hiện có | `tests/p730-acquire-ref-resolver.test.ts:207-260` | Đã pin: gắn same-origin, redaction cross-origin, origin không parse được → không gắn |

### 2.1 Prior art — ba bề mặt ĐÃ có approved-origin (tái dùng, không phát minh lại)

| Surface | Định nghĩa | Runtime enforcement | |
|---|---|---|---|
| Workflow egress | `legacy-workflow.ts:204` `approvedEgressOrigins: z.array(CallbackApprovedOriginSchema).max(16)` trong **pin**; `:329-373 validateLegacyWorkflowEgressOrigins` (exact-origin, https-only, không userinfo/hash, **bắt buộc khi dynamic hoặc credential-bearing**, thông báo *"administrator-approved origins"*) | `legacy-schema-runtime.ts:1338-1345 requireApprovedHttpsOrigin` → `LEGACY_WORKFLOW_EGRESS_ORIGIN_DENIED`; **ghim vào digest pin** (`:389`, `:402`) | |
| Callback destination | `profile-callback.ts:279` `approvedOrigins: min(1) max(16)`; `:313` rỗng → deny; `:326` origin không có trong list → deny | kiểm tra trước khi giao hàng | |
| Shape dùng chung | `profile-callback.ts:259` `CallbackApprovedOriginSchema` | **dùng lại shape này** cho OR10-01 → một ngôn ngữ chính sách, không vocabulary mới | |
| **Source acquisition (OR10-01)** | **KHÔNG có gì** | **gap** | |

## 3. Mô hình mối đe dọa (ngắn, cụ thể)

1. **Chuyển credential sang origin do kẻ submitter chọn.** Operation hợp lệ với `sourceUrl=https://attacker.example/x` + profile có bearer token → `withSourceAuth` gắn token cho `attacker.example` (IP public → ip-policy **cho qua**). Không cần redirect, không cần đánh cắp profile. Nghiêm trọng: token thường là API key của bên thứ ba (nhà cung cấp file).
2. **Không đổi semantics khác.** Các lỗ khác đã được bịt: private-IP (ip-policy), query credential (Δ2), rò hop redirect (origin pin), hàng giả mạo (decrypt tag), `s3://` không dùng resolver. ⇒ **OR10-01 là lỗ còn lại trong cùng chuỗi.**
3. **Không phải SSRF thuần:** destination công khai hợp lệ. Nên fix đúng là *credential confinement*, không phải mở rộng ip-policy.

## 4. Thiết kế

### 4.1 Mô hình dữ liệu — Khuyến nghị R1 (không cần bảng mới)

- Thêm key **top-level**: `allowedOrigins: z.array(CallbackApprovedOriginSchema).max(16).optional()` vào `ProfileEndpointPolicySchema` (`contracts/src/profile-policy.ts:~294`, cạnh `fileUrlAuthConfig`). Cả schema này **`.strict()`** nên bắt buộc thêm tường minh — thiếu là 422 đúng phong cách (fail closed thay vì bỏ qua key lạ).
- **Vì sao top-level mà không nhét vào cipher:** (a) allowlist **không phải bí mật**, nên không cần mã hoá; admin/report đọc được mà không giải khoá; (b) `profile_bindings` có một dòng bất biến cho mỗi `(profile_id, revision)` → allowlist được ghim **bởi đúng `credentialRef` mà operation đã pin** — không cần bảng mới, không cần migration bảng; (c) resolver chỉ cần mở rộng `BINDING_CIPHER_SQL` (`acquisition-ref-resolver.ts:93-96`) để đọc thêm cột `policy`, parse hẹp 1 field — đúng triết lý `readPinnedAuth` (đọc đúng thứ cần, coi shape khác là corrupt).
- **Phương án thay thế (admin quyết):**
  - **R2 — bảng admin riêng** `credential_origin_allowlist(tenant_id, profile_id, revision, scheme, host, port, approved_by, approved_at, expires_at)`: tách tác giả vs người duyệt (dual control thật), query được, có TTL. Bù lại: thêm migration bảng (vận hành kèm bẫy `verifyMigrations` case-3 đã biết: mọi DDL phải verify qua `information_schema`, không rollback framework) + surface admin mới. **Chọn R2 nếu admin muốn tách quyền duyệt khỏi quyền sửa profile.**
  - **R3 — env toàn cục** `DU_SOURCE_CREDENTIAL_ORIGINS`: nhanh nhất, đổi cần restart, không có phân quyền theo tenant/profile. Đủ dùng làm kill-switch, **không** đủ làm giải pháp chính.

### 4.2 Ngữ nghĩa allowlist (bám nguyên văn prior art)

- Exact-origin, **không wildcard** v1 (subdomain wildcard là cách allowlist bị vượt; để sau nếu admin yêu cầu).
- `https:` bắt buộc; `http:` chỉ khi deployment đặt mode dev — và vẫn phải qua ip-policy (http≠qua cổng private).
- Không `userinfo`, không `#fragment`, không query trong entry; `max 16`; dedup + sort khi validate (giống `legacy-workflow.ts:331-334`).
- So sánh theo `URL.origin` chuẩn hoá (case host, default-port hoà), không so sánh chuỗi thô.
- List **rỗng/không có** khi credential `configured = true`: ở `enforce` → **từ chối** (fail-closed, buộc khai báo); ở `warn` → cho qua + audit (không đụng luồng cũ).

### 4.3 Điểm thi hành (hai tầng: pre-check + defense-in-depth)

- **E1 — pre-check chính trong `openGate`** (`ingestion-consumer.ts:577-585`), ngay sau khi `resolveSourceAuth` trả về, **trước khi wrap fetcher**: gọi `assertCredentialOriginAllowed(sourceAuth, sourceUrl)` → throw `SourceAuthDeniedError(403, code)`. Không có I/O nào xảy ra trước check này (đã đứng sau lease renew `:571`, trước mọi mạng).
- **E2 — kiểm tra lại bên trong `withSourceAuth`** tại lời gọi đầu tiên (nơi nó đã parse `origin`): origin không thuộc list → throw cùng mã, **trước** `fetcher(...)`. Lý do: E1 bảo vệ đúng `sourceUrl`; E2 bảo vệ khỏi mọi wrapper trong tương lai / nơi khác lắp lại wrapper mà quên E1 (theo thói quen hai lớp của repo).
- **Mã từ chối mới, 2 giá trị để chẩn đoán** (đúng triết lý "phân biệt *chưa cấu hình* với *có cấu hình nhưng hỏng*"):
  - `ORIGIN_NOT_ALLOWLISTED` (403) — list có entry nhưng origin không khớp;
  - `ORIGIN_POLICY_MISSING` (422) — credential configured, list vắng mặt/không hợp lệ khi mode `enforce`.
- **Bắt buộc kèm theo:** thêm cả hai vào `PERMANENT_CODES` (`ingestion-consumer.ts:300`) — `failureCode` (`:410-420`) đã map theo class nên taxonomy tự nhận, nhưng **không thêm vào set này thì retry vô ích** vì redelivery không đổi được origin. Đây là chi tiết dễ bỏ sót nhất của change.

### 4.4 Knob vận hành — `DU_SOURCE_CREDENTIAL_ORIGIN_MODE` = `warn` | `enforce`

- **Thiếu precedent hợp nhất trong repo:** `DU_ADMIN_COOKIE_SECURE` (auto/enforce) và cửa sổ đọc đôi ENCMETA đều theo mô-típ *quan sát trước → siết sau*. Dùng đúng mô-típ đó.
- `warn` (mặc định khi ship): vẫn gắn credential như cũ, nhưng **audit mỗi lần origin không nằm trong list** + đếm → đo được bao nhiêu profile cần thêm entry.
- `enforce`: không có entry hoặc origin lệch → E1/E2 throw.
- **Bắt buộc đo trước khi siết:** hành vi `warn` phải chạy ít nhất 1 chu kỳ quan sát trên môi trường thật (audit count = 0) trước khi flip; flip là thay đổi config deployment, không phải code.
- Không có entry "off": mặc định là `warn`. Hủy bỏ control này là rollback code (out of scope đề xuất này).

### 4.5 Vận hành & audit

- Sự kiện (lưới audit `admin_audit_events`, migration 0010 — precedent `metadata-window-control.ts:122 audit.record(...)`):
  - `credential.origin_approved` — admin publish profile có `allowedOrigins` (payload: profileId, revision, **các origin** — origin KHÔNG phải bí mật; **không bao giờ** token/header value);
  - `credential.origin_denied` — E1/E2 ném (payload: operationId, tenantId, origin, code, mode).
- **Nhãn log phải vào `SAFE_LOG_MESSAGES` ngay trong cùng thay đổi** (bài học CR10-02-D1: không có nhãn thì sink ra `[REDACTED]`) **và phải rebuild `packages/observability`** vì `main` trỏ `dist/index.js` (gitignored) — verify lại bằng `findstr` trên `dist` sau build, **không** lấy log jest làm bằng chứng.
- Không log token, header value, query; log chỉ `origin` + `code` + mode.

### 4.6 Surface admin (v1 tối thiểu)

- **v1:** cánh gate đã tồn tại — profile `upsert`/`publish` hiện là platform admin + CSRF + `expectedRevision` CAS (BFF `bff/profiles.ts`). Tác giả chỉ đề xuất (lưu nháp), **admin publish là hành động duyệt**; revision mới bất biến → allowlist ghim cùng credential. **Không cần table, không cần route mới.**
- **v2 (nếu admin chọn R2):** hành động `credentialOrigin.approve/revoke` + mục Hiển thị trong màn Profiles (`features/profiles/profiles-screen.tsx`) — ghi nhận là lease UI riêng, không gộp vào change này.
- Cảnh báo cần nhớ: comment `profile-policy.ts:~286` nói BFF **forwards `body.policy` unvalidated today** ⇒ validation phải nằm ở contracts khi upsert; nếu không, key allowlist sẽ đi vào được mà không ai validate.

## 5. Danh sách thay đổi đề xuất (theo phase)

| Phase | File | Thay đổi |
|---|---|---|
| 1 (contract) | `packages/contracts/src/profile-policy.ts` | thêm `allowedOrigins` + helper `validateCredentialAllowedOrigins(value)` reuse `CallbackApprovedOriginSchema` (normalize + dedup + sort) |
| 1 (contract+type) | `src/modules/operations/acquisition-ref-resolver.ts:43-48` (`ResolvedSourceAuth`) | mở rộng union thêm `allowedOrigins: readonly string[]` cho các nhánh `bearer`/`header` |
| 1 (resolver) | `src/modules/operations/acquisition-ref-resolver.ts:93-96, :160-257` | đọc `policy` từ đúng dòng pin; parse hẹp 1 field; trả list theo mode; thêm 2 mã từ chối |
| 1 (enforce) | `src/modules/operations/ingestion-consumer.ts:577-585`, `:300` | E1 pre-check; thêm 2 code vào `PERMANENT_CODES` |
| 1 (E2) | `acquisition-ref-resolver.ts:262-289` | check trong wrapped fetch trước khi gọi `fetcher` |
| 2 (audit) | seam audit + `packages/observability/src/log-events.ts` | 2 event + nhãn `SAFE_LOG_MESSAGES`; **rebuild observability** |
| 3 (ramp) | env docs + deployment config | `DU_SOURCE_CREDENTIAL_ORIGIN_MODE` warn→enforce |
| 4 (tuỳ chọn R2) | migration + admin action + UI | bảng approve có approver/TTL — chỉ nếu admin chọn R2 |

**Không đổi:** ip-policy/`pinned-fetch` (destination), origin pinning (redirect), query-auth cấm (Δ2), tenant anchor, `s3://` skip, mã từ chối hiện có.

## 6. Kế hoạch test (offline, không DB window)

Mở rộng `tests/p730-acquire-ref-resolver.test.ts` (baseline `:207-260`) — ma trận tối thiểu:

1. origin nằm trong list → credential gắn, đúng header/token;
2. origin không nằm trong list + `enforce` → throw `ORIGIN_NOT_ALLOWLISTED`, **`fetcher` không được gọi** (không I/O);
3. cùng test ở `warn` → không throw, **audit được emit 1 lần**, credential vẫn gắn;
4. list vắng mặt + credential configured + `enforce` → `ORIGIN_POLICY_MISSING` (phân biệt với 2);
5. redirect cross-origin **vẫn** bị redaction (test cũ không được mất — regression pin);
6. entry `https://host:8443` khớp `…:8443`, không khớp `https://host` (exact port, không mặc định hoá);
7. case host: `https://EXAMPLE.com` ≡ `https://example.com` (so theo `URL.origin`);
8. entry có `userinfo`/fragment/query → validate 422 lúc upsert (contracts);
9. `>16` entry → 422; trùng lặp → 422 (dedup ở validator, không im lặng bỏ);
10. `http:` entry → 422 ở enforce; ở mode dev (nếu admin bật) → chỉ khi đặt flag;
11. `s3://` → resolver không gọi, không có allowlist nào ảnh hưởng;
12. credential `kind: none` → không có list, không bị chặn (không có gì để bảo vệ);
13. tenant mismatch vẫn `REF_TENANT_MISMATCH` (không bị allowlist nuốt);
14. query-auth vẫn `QUERY_AUTH_FORBIDDEN`;
15. 2 mã mới nằm trong `PERMANENT_CODES` (assert trực tiếp vào set — pin hành vi escalation, không chỉ hình dạng lỗi);
16. audit payload không chứa token/header value (so sentinel như thói quen test redaction);
17. entry hợp lệ nhưng destination private → ip-policy **vẫn** deny (chứng minh hai gate độc lập);
18. legacy row (cipher cũ, không policy field) → mặc định theo mode (warn cho qua + audit; enforce từ chối `ORIGIN_POLICY_MISSING`).

Kiểm chứng bổ sung: chạy `tsc --noEmit` + suite offline; **không claim live window**. Live (acquisition thật với provider thật) thuộc cửa sổ Tester riêng.

## 7. Lộ trình & rủi ro

| Giai đoạn | Hành động | Rủi ro nếu bỏ qua |
|---|---|---|
| Ship | Phase 1+2, mode mặc định `warn` | không có rủi ro luồng cũ (vẫn attach) |
| Quan sát | đo `credential.origin_denied` (warn) ≥ 1 chu kỳ | siết sớm sẽ phá mọi profile chưa khai list |
| Siết | admin đổi mode `enforce` ở deployment | cần checklist profile → origin trước; thiếu = các operation `escalate` terminal FAILED (không retry được) — đúng hành vi nhưng sẽ surprise |
| Rollback | đổi mode về `warn` (config, không cần code) | — |

**Rủi ro chính được chấp nhận có ý thức:** fail-closed ở enforce biến sai cấu hình thành `FAILED` rõ ràng thay vì fetch ẩn danh — tôi chọn điều đó thay vì "im lặng bỏ credential" (mất cảnh báo, và một fetch ẩn danh có thể vẫn thành công dưới con mắt sai của operator). Đây là lựa chọn cần admin xác nhận ở §8.

## 8. Câu hỏi chờ admin quyết

1. **R1 (top-level policy) hay R2 (bảng approve có approver/TTL)?** — R1 đủ dùng cho "admin duyệt" nhờ cổng publish; R2 thêm dual control thật.
2. **Wildcard subdomain** có cần không? (đề xuất: không cho v1.)
3. **Empty-list khi enforce** = deny (đề xuất) hay degrade sang anonymous? (đề xuất: deny.)
4. **Port semantics**: exact-port (đề xuất) hay bỏ mặc định port?
5. **Mode mặc định cho deployment mới**: `warn` rồi siết, hay `enforce` ngay (mới setup ít profile hơn)?
6. **Người duyệt có phải khác người sửa profile?** (chỉ R2 trả lời được.)
7. **TTL cho entry** (theo tháng) có bắt buộc không?

## 9. Non-goals

- Không thay ip-policy / `pinned-fetch` (destination policy); không mở rộng allowlist sang connector `baseUrl` (surface riêng, sang đề xuất khác); không đổi Vault/credential storage; không thêm wildcard; không tự implement — tài liệu này chỉ là spec.

## 10. Ranh giới

- **0 sửa đổi** source/test/config; chỉ ghi tài liệu này.
- Không commit/add/push, không tick gate, không viết VERIFIED/ACCEPTED.
- Mọi `file:line` đã đọc trực tiếp từ working tree ngày 2026-10-10 (survey date) — theo kỷ luật báo cáo của repo, cần re-verify nếu tài liệu này bị đọc lại sau khi các lane khác thay đổi file.