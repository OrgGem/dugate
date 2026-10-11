# Đánh giá kiến trúc độc lập (DSH2) — OR10-01 origin allowlist cho source credential — 2026-10-10

**Vai trò:** Independent architecture reviewer (DSH2). **READ-ONLY**, không sửa một dòng source/test/config; không `git add`/commit/push; không tick gate.
**Đối tượng:** `coordination/reports/proposal-or10-01-origin-allowlist-2026-10-10.md` (PROPOSAL, 158 dòng) + code working tree mà nó tham chiếu.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 · ambient `NODE_ENV=production`.
**Raw:** `coordination/reports/raw/verify-or10-01-proposal-2026-10-10/DSH2/` — `01-dsh2-probe.log`, `02-dsh2-probe.cjs` (probe độc lập của tôi, nạp **chính source TS** của contracts), `SHA256SUMS.txt`.

**Phạm vi đánh giá:** (a) vấn đề nêu trong proposal có thật không; (b) tính khả thi của **R1** (`allowedOrigins` top-level trong `ProfileEndpointPolicySchema`); (c) điểm thi hành `openGate` tại `ingestion-consumer.ts:577-585`; (d) các mắt xích mà proposal bỏ sót hoặc mô tả sai. **Không** đánh giá giá trị nghiệp vụ của việc siết credential — đó là quyết định của admin.

---

## 0. Kết luận điều hành

| Câu hỏi | Trả lời độc lập |
|---|---|
| Lỗ hổng (credential không gắn origin) có thật? | **CÓ, xác nhận bằng code** — `FileUrlAuthConfigSchema` không có trường origin; `withSourceAuth` chỉ pin origin **của URL đầu** và redact khi hop lệch, **không** kiểm allowlist nào (§1) |
| Điểm thi hành `openGate` (`ingestion-consumer.ts:577-585`) có đúng như proposal mô tả? | **ĐÚNG CHÍNH XÁC** — số dòng khớp, lease renew ở `:570-571` trước đó, `s3://` bỏ qua resolver ở `:577`, chưa có I/O nào trước điểm chèn E1; `sourceUrl` đã được cross-check ở `:798-800` (§3) |
| R1 (`allowedOrigins` top-level trong policy) có khả thi? | **KHẢ THI về mô hình contract** (có precedent, `.strict()` đã chứng minh bằng probe), **NHƯNG mô tả plumbing trong proposal SAI 2 chỗ** và thiếu 2 mắt xích ⇒ nên chốt thành **R1′** (§2.5) |
| Claim 'không cần migration bảng / resolver chỉ cần đọc thêm cột `policy`' | **SAI** — `profile_bindings` **không có** cột `policy`; mỗi field top-level là **một cột riêng** (precedent `request_redaction` 0033, `callback_policy` 0036) ⇒ R1 **cần một migration ADD COLUMN** mà danh sách thay đổi §5 không có (§2.2) |
| Claim 'schema `.strict()` nên phải thêm tường minh, thiếu là 422' | **ĐÚNG — đã chứng minh thực nghiệm** (probe P1/P2/P3: key lạ bị `unrecognized_keys`) |
| E2 ('origin không thuộc list → throw trong wrapper') | **CÓ VẤN ĐỀ** — nó biến hành vi redaction cross-origin **cố ý** hiện nay thành **terminal failure**, và **mâu thuẫn trực tiếp với test #5** của chính proposal (§4 F2) |
| Hai mã từ chối mới + `PERMANENT_CODES` | **ĐÚNG** — `failureCode` đọc `err.code` cho `SourceAuthDeniedError` (`:414-415`) nên taxonomy tự theo; thiếu `PERMANENT_CODES` thì retry vô ích (`:816-818`) — probe P8 xác nhận set hiện có 11 mã, chưa có 2 mã mới |
| Read wire cho admin UI | **THIẾU trong proposal** — `ProfileEndpointPolicyReadSchema` cũng `.strict()` và chưa có field này ⇒ nếu không thêm, **không có đường nào để admin đặt allowlist** (probe P2) (§4 F3) |

**Một dòng cho coordinator:** vấn đề và điểm thi hành của proposal **đúng**; R1 **khả thi nhưng phải sửa**: thêm 1 migration cột `allowed_origins` trên `profile_bindings` (không có cột `policy` như proposal tưởng), đọc nó bằng chính `BINDING_CIPHER_SQL` (không đụng snapshot/claim schema), thêm field vào **read schema** cho UI, và **giới hạn E2 vào origin gốc** để không phá redaction redirect.

---

## 1. Vấn đề nêu trong proposal — kiểm chứng độc lập

| # | Điều proposal nói | Kết quả kiểm | Bằng chứng |
|---|---|---|---|
| 1 | Credential 'origin-less' | **ĐÚNG** | `packages/contracts/src/profile-policy.ts:240-250` — `FileUrlAuthConfigSchema` chỉ có `type/token/header_name/header_value/query_key/query_value`, `.strict()`, **không** có URL/origin |
| 2 | `withSourceAuth` gắn credential cho origin của URL đầu, không kiểm allowlist | **ĐÚNG** | `acquisition-ref-resolver.ts:262-288`: `originalOrigin` lấy từ hop đầu (`:278`), hop lệch → gọi `fetcher` **không** kèm credential (`:279-281`), không throw, không so allowlist |
| 3 | Đây là hành vi **cố ý** (redaction, không fallback) | **ĐÚNG** | comment `:251-261` nói rõ 'deliberate redaction, not a fallback' — quan trọng cho F2 |
| 4 | `withSourceAuth` chỉ có 3 hit trong `src/` | **ĐÚNG** | grep độc lập: import `ingestion-consumer.ts:21`, call `:585`, definition `acquisition-ref-resolver.ts:262` |
| 5 | ip-policy chặn private nhưng **cho qua** origin công khai | **ĐÚNG** | `ip-policy.ts:244-278` chỉ adjudicate protocol/userinfo/IP; host công khai → `NEEDS_RESOLUTION`/`ALLOWED`, **không** giới hạn host nào |
| 6 | (bổ sung của tôi) `allowHosts` của ip-policy **không** dùng thay được | **XÁC NHẬN** | `ip-policy.ts:265-267`: `allowHosts` là **opt-in cho phép** IP-literal/private vốn bị chặn — **cực tính ngược** với nhu cầu confine credential; nơi duy nhất dùng seam này là webhook (`modules/webhooks/webhooks.ts:482`) ⇒ proposal đúng khi tách OR10-01 khỏi ip-policy |
| 7 | Submit-time chỉ adjudicate destination, không giới hạn host công khai | **ĐÚNG** | `modules/operations/submission.ts:992` gọi `adjudicateUrlDestination(value)` **không** truyền options ⇒ không có `allowHosts`, không giới hạn host công khai cho `sourceUrl` |
| 8 | Kết luận 'không phải SSRF thuần, mà là credential confinement' | **ĐỒNG Ý** | destination công khai là hợp lệ theo ip-policy; cái sai là **gửi bí mật tới đó** |

⇒ **Mô hình mối đe dọa của proposal đứng vững.** Không có claim nào trong §2–§3 bị bác bỏ.

---

## 2. Tính khả thi của R1 — theo từng tầng

### 2.1 Tầng contract: KHẢ THI, có precedent, đã chứng minh thực nghiệm
- `ProfileEndpointPolicySchema` (`profile-policy.ts:287-305`) là `.strict()`, mọi field `optional()`; hai field top-level gần nhất đều được thêm theo đúng cách này: `requestRedaction` (migration **0033**) và `callbackPolicy` (migration **0036**).
- Probe P1 (chạy trên **source TS thật**): `safeParse({})` → OK; `safeParse({ allowedOrigins: [...] })` → **fail `unrecognized_keys`** ⇒ câu 'phải thêm tường minh, thiếu là 422' của proposal **đúng**; và vì mọi field optional nên thêm field optional **không phá** các partial write hiện có.
- **Nhưng:** `ProfileEndpointPolicyReadSchema` (`:317-332`) cũng `.strict()` và **chưa** có field này (probe P2) ⇒ R1 **bắt buộc** thêm vào cả read shape, nếu không UI không đọc/ghi được allowlist (§4 F3).

### 2.2 Tầng lưu trữ: MÔ TẢ TRONG PROPOSAL SAI — R1 cần một migration
- Proposal §4.1(b)/(c) nói 'không cần bảng mới, không cần migration bảng' và 'resolver chỉ cần mở rộng `BINDING_CIPHER_SQL` để đọc thêm cột **`policy`**'.
- Thực tế đọc từ migrations: `profile_bindings` **không có** cột `policy`. Policy được lưu **mỗi field một cột**:
  `enabled`, `parameters`, `job_priority`, `allowed_file_extensions`, `file_url_auth_cipher`, `connections_override` (0026) · `request_redaction` (0033) · `callback_policy` (0036).
- ⇒ 'không cần **bảng** mới' **đúng**; nhưng **cần một `ALTER TABLE profile_bindings ADD COLUMN allowed_origins jsonb` + entry trong migration runner**, và danh sách thay đổi §5 **không liệt kê nó**. Đây là **thiếu sót công việc**, không phải lỗi kiến trúc — nhưng nếu dispatch theo §5 nguyên văn thì lane implement sẽ bị chặn giữa đường (hoặc tệ hơn: nhét allowlist vào một cột jsonb có sẵn như `parameters`, sai ngữ nghĩa).
- Ghi chú vận hành kèm theo (proposal đã biết, tôi xác nhận hệ quả): repo không có down-migration; `verifyMigrations` đòi DDL phải verify được qua `information_schema` ⇒ migration phải là `ADD COLUMN IF NOT EXISTS` đúng phong cách 0033/0036.

### 2.3 Tầng pin/đọc: hai tuyến, và proposal đang trộn hai tuyến vào nhau
- Tuyến **snapshot**: resolver đọc `operations.profile_policy_snapshot` (`OP_SNAPSHOT_SQL`, `acquisition-ref-resolver.ts:90-91`) và parse hẹp 2 field (`readPinnedAuth`, `:110-138`). Snapshot là **schema riêng, `.strict()`, 7 field cố định** (`ProfilePolicySnapshotSchema`, `profile-policy.ts:655-676`) — **không** chứa toàn bộ policy (thiếu cả `requestRedaction`, `callbackPolicy`).
- Tuyến **binding**: `BINDING_CIPHER_SQL` (`:93-95`) đọc `profile_bindings` theo đúng `(profile_id, revision)` đã pin — hiện chỉ lấy `tenant_id` + `file_url_auth_cipher`.
- **Coupling nguy hiểm nếu đi tuyến snapshot:** claim path validate snapshot bằng **chính schema đó** (`runtime.ts:219-236`, `PinnedProfilePolicySchema = ProfilePolicySnapshotSchema` — `contracts/src/runtime.ts:69`). Probe P3: thêm key lạ vào snapshot → `unrecognized_keys`. ⇒ Nếu ghi `allowedOrigins` vào snapshot mà quên sửa schema, **mọi claim sẽ 422** (`'operation profile_policy_snapshot does not match the pinned policy shape'`). Thêm nữa, `retry.ts:82-88` copy `profile_policy_snapshot` nên retry sẽ mang theo — nhưng chỉ khi schema/writer đã đồng bộ.
- **Precedent trực tiếp cho tuyến binding (tôi tìm được, proposal không trích):** `modules/operations/mappers.ts:47-65` đọc `p.request_redaction` từ `profile_bindings` theo **revision pin** (`p.revision = $3`) **và** revision hiện tại, fail-closed (`hiddenRequestInput()`) nếu thiếu/parse lỗi. Đây đúng là khuôn mẫu 'đọc cột policy theo revision đã pin' mà OR10-01 cần.
- ⇒ **Khuyến nghị:** đi **tuyến binding** — mở rộng chính `BINDING_CIPHER_SQL` để trả thêm `allowed_origins`, **không** đụng snapshot, **không** đụng claim schema. Đây đúng là ý tưởng (c) của proposal, chỉ cần sửa lại: cột là **mới**, không phải `policy`.

### 2.4 Tầng thi hành: xem §3 (đúng), trừ E2 (xem §4 F2)

### 2.5 R1′ — bề mặt thay đổi đề xuất (thay cho §5 của proposal)
| # | File | Thay đổi | Ghi chú |
|---|---|---|---|
| 1 | `packages/contracts/src/profile-policy.ts` | `allowedOrigins` (write **và** read schema) + validator canonical hoá/dedup/sort, reuse `CallbackApprovedOriginSchema` | bắt buộc cả hai schema (P1/P2) |
| 2 | `migrations/00XX_profile_allowed_origins.sql` | `ALTER TABLE profile_bindings ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb` | **mắt xích proposal thiếu**; theo khuôn 0033 |
| 3 | `modules/profiles/profiles.ts` (+ `policy.ts`) | persist/đọc cột mới trong upsert/publish (khuôn `request_redaction` `:442-474`) | |
| 4 | `modules/admin-read/profile-detail.ts` | select + trả `allowedOrigins` trong read policy | để UI hiển thị/sửa |
| 5 | `modules/operations/acquisition-ref-resolver.ts` | mở rộng `ResolvedSourceAuth` + `BINDING_CIPHER_SQL` + `assertCredentialOriginAllowed` | **không** đụng snapshot |
| 6 | `modules/operations/ingestion-consumer.ts` | E1 tại `:577-585`, 2 mã mới, **thêm vào `PERMANENT_CODES` (`:300-312`)** | |
| 7 | `features/profiles/profiles-screen.tsx` (+ state) | editor allowlist | lease UI riêng, nhưng **không thể là v2** nếu R1 muốn 'admin duyệt qua publish' |
| 8 | observability | 2 event + `SAFE_LOG_MESSAGES` + rebuild `dist` | proposal đã đúng |

**Không đổi:** snapshot schema/claim path, ip-policy, redirect redaction, query-auth cấm, tenant anchor, `s3://` skip.

---

## 3. Điểm thi hành `openGate` — đánh giá chi tiết

| Khía cạnh | Kết quả |
|---|---|
| Số dòng proposal nêu (`:577-585`) | **Khớp chính xác**: `:577-579` resolve (kèm `s3://` skip), `:580-586` wrap fetcher |
| Có I/O trước điểm chèn E1? | **Không** — lease renew `FENCE_RENEW_SQL` ở `:570-571`, resolve ở `:578`, wrap ở `:585`; chưa có fetch/storage nào |
| `sourceUrl` có sẵn và có tin được? | **Có** — là tham số của `openGate` (`:565`) và caller đã cross-check `envelope.sourceUrl !== sourceUrl` → `escalate(permanentFailure(...))` tại `:798-800` trước khi gọi |
| E1 nên đặt ở đâu? | Ngay sau `:579`, trước `:580` — đúng như proposal; điều kiện `sourceAuth.kind === 'none'` tự nhiên bỏ qua (không có gì để bảo vệ) |
| Hệ quả escalation | `:814-818`: `isPermanent(err) ? escalate : (attempts+1 >= maxAttempts ? escalate : retry)` ⇒ **2 mã mới buộc phải vào `PERMANENT_CODES`**, nếu không operation sẽ retry vô ích (proposal nói đúng, và đây đúng là chi tiết dễ sót nhất) |
| `failureCode` có tự nhận mã mới? | **Có** — `:410-420`, nhánh `err instanceof SourceAuthDeniedError ? err.code` ⇒ chỉ cần khai báo trong union `SourceAuthDenialCode` (`acquisition-ref-resolver.ts:48-54`) |
| `ResolvedSourceAuth` hiện tại | `none \| bearer \| header` (`:43-46`) — **chưa** có origin; probe P7 xác nhận union đúng như proposal mô tả và `BINDING_CIPHER_SQL` chỉ lấy cipher |

⇒ **Điểm thi hành là đúng và là điểm hẹp nhất của chuỗi** (một call site duy nhất, sau lease renew, trước mọi mạng). Không có phản biện kỹ thuật nào với E1.

---

## 4. Findings

| # | Mức | Finding | Bằng chứng |
|---|---|---|---|
| **F1** | **HIGH (tài liệu/công việc)** | Proposal khẳng định không cần migration và resolver chỉ cần đọc thêm 'cột `policy`' — cột đó **không tồn tại**; R1 cần 1 migration `ADD COLUMN` + persist + read wire. Dispatch theo §5 nguyên văn sẽ thiếu việc | §2.2; migrations 0026/0033/0036; `BINDING_CIPHER_SQL` `:93-95` |
| **F2** | **HIGH (thiết kế)** | **E2 như đặc tả mâu thuẫn với chính test #5.** Hiện nay hop lệch origin được **redact im lặng** (hành vi cố ý, `:279-281`, được pin bởi `tests/p730-acquire-ref-resolver.test.ts:207-260`). Nếu E2 throw khi 'origin không thuộc list' ở **mọi** hop, một redirect sang host thứ ba sẽ thành `ORIGIN_NOT_ALLOWLISTED` → **terminal FAILED, không retry** (vì sẽ vào `PERMANENT_CODES`) | `acquisition-ref-resolver.ts:262-288`; proposal §4.3 E2 vs §6 test #5 |
| **F3** | **MEDIUM (thiếu mắt xích)** | Read wire thiếu field ⇒ không có đường hợp lệ để admin đặt allowlist; proposal đẩy UI sang 'v2/R2' trong khi R1 tự nhận 'admin duyệt qua publish' — hai điều này không thể cùng đúng | probe P2; `ProfileEndpointPolicyReadSchema:317-332` |
| **F4** | **MEDIUM (coupling)** | Nếu chọn tuyến snapshot thay vì tuyến binding: phải sửa `ProfilePolicySnapshotSchema` **và** writer **và** nhớ `retry.ts:82-88`; quên schema ⇒ **mọi claim 422** | probe P3; `runtime.ts:219-236`; `contracts/src/runtime.ts:69` |
| **F5** | **LOW (im lặng sai)** | `CallbackApprovedOriginSchema` **không canonical hoá**; prior art so bằng `URL.origin` (đã lowercase). Entry `https://FILES.Provider.EXAMPLE` **hợp lệ khi validate nhưng không bao giờ khớp** ⇒ validator của OR10-01 **phải** canonical hoá khi ghi (proposal §5 có nhắc `normalize + dedup + sort`, nhưng §4.2 lại nói 'bám nguyên văn prior art' — cần chốt là *prior art + normalization*) | probe P4/P5 |
| **F6** | **LOW (chính xác tài liệu)** | Prior art callback chỉ `.max(16)`, **không** dedup; OR10-01 yêu cầu dedup ⇒ 422 khi trùng. Khác biệt này là **tốt hơn**, nhưng không phải 'nguyên văn' | `profile-callback.ts:281` vs proposal §4.2 |
| **F7** | **INFO** | `allowHosts` của ip-policy là opt-in **cho phép** (cực tính ngược) ⇒ không thể tái dùng cho credential confinement; non-goal 'không mở rộng ip-policy' của proposal là **đúng** | `ip-policy.ts:263-275` |

---

## 5. Đánh giá rollout (warn → enforce)

- Mô-típ `warn` mặc định → đo → `enforce` là **đúng thói quen repo** (tiền lệ `DU_ADMIN_COOKIE_SECURE`, cửa sổ đọc đôi ENCMETA). Đồng ý.
- **Bổ sung bắt buộc cho phase ramp (proposal thiếu):** một truy vấn 'ai sẽ fail' trước khi flip, ví dụ
  `SELECT count(*) FROM profile_bindings WHERE file_url_auth_cipher IS NOT NULL AND (allowed_origins IS NULL OR allowed_origins = '[]'::jsonb)` — đây là **cùng dữ liệu** mà `warn` audit sẽ đếm, nhưng chạy được ngay không cần chờ traffic.
- Hệ quả enforce đã được proposal mô tả đúng: profile chưa khai list ⇒ operation **FAILED terminal** (không retry). Tôi xác nhận cơ chế: `PERMANENT_CODES` + `:816-818`.
- Không có 'off': rollback = đổi config về `warn` ✓ (không cần revert code) — chấp nhận được.
- **Rủi ro chưa được nêu:** trong giai đoạn `warn`, nếu audit event mới **không** được thêm vào `SAFE_LOG_MESSAGES` thì tín hiệu đo sẽ ra `[REDACTED]` và phase ramp mất dữ liệu — proposal đã cảnh báo (§4.5, bài học CR10-02-D1) và tôi xác nhận đây là điều kiện tiên quyết thật, không phải chi tiết phụ.

---

## 6. Khuyến nghị & trả lời các câu hỏi §8 của proposal

| # | Câu hỏi admin | Khuyến nghị kỹ thuật của tôi |
|---|---|---|
| 1 | R1 hay R2? | **R1′** (R1 + cột `allowed_origins` trên `profile_bindings`, đọc qua `BINDING_CIPHER_SQL`). R2 chỉ đáng giá nếu admin thực sự cần **dual control** (người duyệt ≠ người sửa profile) hoặc **TTL**; khi đó chi phí thêm là 1 bảng + approver/TTL + action + UI, còn chi phí 'migration' thì **R1′ đã phải trả rồi** (F1) |
| 2 | Wildcard subdomain? | **Không** cho v1 — đồng ý; exact-origin + canonical hoá (F5) |
| 3 | Empty-list khi enforce? | **Deny** — đồng ý; và tiền lệ callback đã deny đúng như vậy (probe P6) |
| 4 | Port semantics? | **Exact-port** — `CallbackApprovedOriginSchema` chấp nhận port tường minh (probe P4), nhưng **default-port hoà** chỉ đạt được nếu canonical hoá bằng `URL.origin` lúc validate (F5) |
| 5 | Mode mặc định deployment mới? | **`warn`** rồi siết — nhất quán với mô-típ repo và tránh biến lỗi cấu hình thành FAILED hàng loạt ngay khi bật |
| 6 | Người duyệt khác người sửa? | Chỉ R2 trả lời được — nhưng lưu ý: hiện `profile.upsert/publish` là **platform admin + CSRF + CAS** (`bff/profiles.ts`), nên R1′ vẫn có 'một cổng duyệt' theo nghĩa quyền, chỉ **không** có tách biệt *người* |
| 7 | TTL cho entry? | Không bắt buộc ở v1; nếu cần TTL thì phải đi R2 (cột `expires_at`) — R1′ không có chỗ tự nhiên cho TTL |

**Sửa bắt buộc trước khi dispatch (theo thứ tự):** F2 (ngữ nghĩa E2 + cập nhật test #5) → F1 (thêm migration + persist vào §5) → F3 (read wire + editor, không để v2) → F5 (canonical hoá) → F4 (chốt tuyến binding, đừng đụng snapshot).

---

## 7. Xác nhận

- Chỉ **đọc** source/proposal + chạy **một probe offline** nạp chính source TS của `packages/contracts` (không DB, không mạng, không build, không sửa file nào trong repo).
- Không `git add`/commit/push; **không** tick gate; **không** viết VERIFIED/ACCEPTED. Đây là **đánh giá kiến trúc**, không phải verify một implementation (OR10-01 mới ở mức PROPOSAL, chưa có code để verify).
- File tôi tạo: báo cáo này + 2 file raw + `SHA256SUMS.txt` trong `coordination/reports/raw/verify-or10-01-proposal-2026-10-10/DSH2/`.
- Mọi `file:line` trong báo cáo này đọc từ working tree tại HEAD `d0b22104` (nhiều file liên quan đang ` M` do lane khác — kết luận gắn với revision đã đọc; nếu code đổi, các mục §2–§4 phải được đọc lại).
- Báo cáo tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
