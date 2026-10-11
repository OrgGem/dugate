# Plan: Security findings orchestrator — SEC-01..SEC-04 — 2026-10-11

- Ngày: 2026-10-11 (Asia/Bangkok)
- Vai trò: Claude Code coordinator (theo `COORDINATOR-CONTRACT.md`)
- Repo scope: `du-rework` (không đụng legacy root, không đụng DB production/legacy)
- Nguồn: `coordination/reports/orchestrator-security-review-2026-10-11.md` (4 finding High/P1)
- Verify độc lập: `coordination/reports/verify-orchestrator-security-INDEPENDENT-DSH2-2026-10-11.md` — **4/4 XÁC NHẬN**, evidence 10/10 hash khớp
- Sổ mở duy nhất: `coordination/PLAN-OPEN-2026-10-09.md` (đăng ký tại §18)
- Trạng thái: **SPECIFIED / chưa dispatch**. Không tick gate, không commit, không push, không `git add`. Không viết dispatch packet (PLAN-OPEN §14).
- **Cập nhật 2026-10-11 (sau khi người dùng trả lời 3 câu hỏi):** SEC-01 **đã chốt cutover, không port tính năng** — yêu cầu kèm là *đảm bảo portal mới không bị lỗi*, đã thành acceptance nghiêm ngặt nhất của task. SEC-03 đã có khuyến nghị policy và **đã được implement trên đĩa**. SEC-02 có quy tắc backfill nhưng **phía duyệt không thể tự động**. **Ba claim trong bản gốc đã hoá ra sai** (SEC-01, SEC-03, và `/admin/legacy/*` trả 404) và đã sửa kèm bằng chứng. Đọc §1.1 + §1.2 cùng §2 trước khi dispatch.

---

## 0. Vì sao plan này khác với hai plan frontend gần đây

Hai plan frontend (AWEB-16..21) đã được **đóng gần hết** — xem §5. Plan này là **security**, ưu tiên khác hẳn: đây là những finding có **tác động vận hành lên dữ liệu thật**, không phải lỗi trung thực hiển thị.

**Coordinator đã tự đọc lại từng finding trên đĩa**, không tin receipt. Kết quả ở §1 — có sai lệch quan trọng so với trạng thái mà receipt mới nhất gợi ý.

---

## 1. Trạng thái thực tế trên đĩa (coordinator tự kiểm, 2026-10-11)

| Finding | Review nói | Coordinator đọc đĩa | Kết luận |
|---|---|---|---|
| **SEC-01** admin legacy dùng quyền platform | High, mở | **Xem §1.1 — claim trước đây viết sai, đã sửa.** Đường tenant-scoped **đã có sẵn**: `auth-dispatch.ts:296` mang `tenantId`; `section-dispatch.ts:82` import `credentialForTenant`, `:98` dùng nó; `:471` và `:543` (operations + overview) đã truyền `access.token` thay vì token platform. Lỗi thật **hẹp hơn nhiều**: **5 fetcher** còn truyền `config.adminToken` vô điều kiện — `:285` businesses, `:324` profiles, `:370` connectors, `:411` api-keys, `:637` audit. | **CÒN MỞ — nhưng khoanh vùng lại** |
| **SEC-02** mặc định `warn` gửi credential tới origin ngoài allowlist | High, mở | `ingestion-consumer.ts:180` vẫn trả `warn` khi env unset. `compose/orchestrator.yml:63` vẫn `:-warn`. | **CÒN MỞ — xác nhận** |
| **SEC-03** bootstrap bỏ qua writer mã hóa | High, mở | **Claim review sai — đã nối rồi.** `create-app.ts:82-83` import cả hai writer; `:660-673` chọn `createS3EncryptedPinnedSourceStorage` khi có encryption facade; `:674-679` fallback plaintext; `:655` + `:681` truyền `requireEncryptedSourceWrites = dataMode === 'real'`. Còn lại: **4 biểu thức `required` không đồng nhất** (`:492`, `:508`, `:528`, `:655`) và kiểm kê object thật. | **ĐÃ NỐI — còn verify + chốt policy** |
| **SEC-04** HTTP 204 giết tiến trình | High, mở | `pinned-fetch.ts:358` **đã có** `hasNoBody = HEAD \|\| [204,205,304].includes(status)`; `:370` `new Response(null, responseInit)`; `:352` + `:376` try/catch quanh `fulfillResponse`; `:342` `.catch(failResponse)` cho nhánh redirect. | **ĐÃ SỬA trên đĩa** |

**Điểm quan trọng:** SEC-04 **đã có code sửa** (`receipt-sec-04-pinned-fetch-impl-2026-10-11.md`, 35 tests pass), nhưng **chưa có verify độc lập cho bản sửa** — receipt DSH2 verify bản *trước khi sửa* và tái hiện được crash. Task của tôi ở đây là **verify bản đã sửa**, không phải sửa lại.

### 1.1 SEC-01 — đã khoanh vùng lại: lỗi hẹp hơn review nói, nhưng còn thật

**Claim trước của tôi sai, đã sửa.** Ở §1 bản trước tôi viết `section-dispatch.ts` có **7 chỗ** `adminToken` và **0** tham chiếu `credentialForTenant`. Đọc lại từng dòng, đó là hai claim sai:

| Claim trước | Thực tế đã đối chiếu |
|---|---|
| 7 chỗ `adminToken: config.adminToken` tại `:251,290,336,377,421,480,574` | **5 chỗ**: `:285` businesses, `:324` profiles, `:370` connectors, `:411` api-keys, `:637` audit |
| 0 tham chiếu `credentialForTenant` | **2 chỗ**: `:82` import, `:98` dùng |
| claims session không có tenant | `auth-dispatch.ts:296` **có** `tenantId: rec.tenantId` |
| operations/overview không được guard | **đã có** — `:140-143` `sectionHasProtectedRead` + `:143` `legacyReadCredential` |

**Cơ chế đã có sẵn và đúng:** `legacyReadCredential` (`:88-100`) trả token platform cho role `admin`, còn operator thì lấy `credentialForTenant(config.tenantAdminTokens, tenantId)` (`:98`). Nhờ vậy operations và overview đã ghi đúng tenant (`:471`, `:543`).

**Lỗi thật — một viewer/operator đọc được dữ liệu cross-tenant.** Năm fetcher còn lại **không** qua `legacyReadCredential` và **nằm ngoài** guard `:140-143` (guard chỉ chọn `operations` và `overview`, `:141-142`):

| Đường | Role tối thiểu (`p6-01-shell-fixtures.ts:223-229`) | Token dùng | Hậu quả |
|---|---|---|---|
| `/admin/businesses` | `viewer` | `config.adminToken` (`:285`) | **Cross-tenant** — viewer tenant A đọc business của B |
| `/admin/audit` | `operator` (`shell-router.ts:190`) | `config.adminToken` (`:637`) | **Cross-tenant** — auditor A đọc audit của B |
| `/admin/profiles` `/admin/connectors` `/admin/api-keys` | `admin` | `config.adminToken` | Đúng thiết kế — admin là platform-level |

**Khai thác KHÔNG cần quyền admin.** Đây là phần làm review nặng hơn mức thật. Review nói lỗi nâng quyền đọc xảy ra ở mọi section; thực tế operations + overview đã kín, còn lỗi thật nằm ở businesses và audit, và **viewer đã đủ** cho cái trước.

### 1.2 SEC-01 — hai topology, và claim *404* của tôi ở đây là sai

**Đính chính quan trọng:** §1.2 bản đầu của tôi viết rằng `/admin/legacy/<section>` trả **404** vì `matchShellRoute` so sánh pathname nguyên bản. **Điều đó sai.** `shell-router.ts:202` có sẵn bước bỏ prefix:

```ts
const checkPath = p.startsWith('/admin/legacy/') ? p.replace('/admin/legacy', '/admin') : p;
```

⇒ `/admin/legacy/businesses` **không** 404 — nó được rewrite thành `/admin/businesses` rồi khớp nav item và render section bình thường. Test đã có sẵn xác nhận đúng hành vi này: `tests/sec-or-01-legacy-read-scope-offline.test.ts:64,106,133-134,164,174` dùng `/admin/legacy/operations` và `/admin/legacy/overview` và **đều** nhận `routeId` dạng `section:...`.

**Phạm vi đính chính — đính chính của tôi cũng phải thu hẹp.** Đọc `p6-01-shell-fixtures.ts:222-230`: `NAV_ITEMS` có đúng 7 mục, **không có `audit`**. Còn `shell-router.ts:189` và `:196` so `p` **nguyên bản** với `/admin/audit` và `/admin/crypto-config`, tức **không** đi qua bước bỏ prefix.

| Path | Thật | Cơ chế |
|---|---|---|
| `/admin/legacy/businesses` `/operations` `/overview` `/profiles` `/connectors` `/grants` `/api-keys` | **200, section thật** | `:202` bỏ prefix rồi khớp nav item |
| `/admin/legacy/audit` | **404** | `:189` so `p` nguyên bản; `NAV_ITEMS` không có audit |
| `/admin/legacy/crypto-config` | **404** | `:196` so `p` nguyên bản; không có nav item |
| `/admin/legacy` và `/admin/legacy/` | 200, khung rỗng `admin-root` | `:172`, `section: null` |

⇒ **Phát biểu đúng nhất:** claim 404 của tôi **sai ở 7 section nav, đúng ở audit và crypto-config**. Đường khai thác dễ nhất (`/admin/legacy/businesses`) **có** tồn tại và render thật — khẳng định này đứng vững sau khi thu hẹp.

**Hệ quả trực tiếp tới quyết định cutover — và nó tốt hơn tôi nghĩ:** `/admin/legacy/*` không chỉ là khung rỗng. Đó là **đường khai thác thật, tới được ngay từ link trên nav của SPA**. Cụ thể: viewer đăng nhập, bấm *Legacy Admin Shell*, rồi vào `/admin/legacy/businesses` sẽ đi qua `handleSectionGet('businesses', 'viewer')` — qua được role guard, **không** qua guard tenant (guard `:140-143` chỉ chọn operations và overview), và tới fetcher `:285` với `config.adminToken` là token platform.

**Nên phát biểu đúng:** đóng `/admin/legacy/*` **có** chặn được đường khai thác chính ở topology hiện tại. Nhưng nó **không** chặn được topology B.

| Topology | Điều kiện | Đường tới lỗi §1.1 | Đóng `/admin/legacy` có chặn được? |
|---|---|---|---|
| **A** — đang chạy | `DU_ADMIN_WEB` bật | `/admin/legacy/businesses` (audit đã 404 sẵn — xem bảng trên) | **Có** |
| **B** — mặc định | `DU_ADMIN_WEB=0` (`.env.docker.example:32`, `compose/orchestrator.yml:45`) | `/admin/businesses`, `/admin/audit` | **Không** |

**Cái bẫy còn lại:** topology B vẫn lộ. Người vận hành tắt `DU_ADMIN_WEB` hoặc deploy theo mặc định là lỗi §1.1 quay lại nguyên vẹn, dù đã làm cutover xong. Đây là lý do **SEC-01F vẫn cần**, và không được bỏ vì đã cutover.

---

## 2. Task

Mỗi task khai lease, phụ thuộc, acceptance. **Chưa giao owner** — chờ agent điều phối của người dùng.

### SEC-01 — Cutover: đóng hẳn bề mặt legacy (người dùng đã chốt 2026-10-11)

**Quyết định: chốt phương án (b)** — đóng `/admin/legacy/*` và gỡ link ở `app-shell.tsx:145`. Người dùng đã trả lời *cutover phần admin legacy*.

**Bổ sung 2026-10-11 — câu hỏi tồn đọng đã có câu trả lời:** người dùng nói *không chặn việc gỡ link, đồng ý cutover, nếu cần tính năng thì tạo lại sau, miễn đảm bảo phía portal mới không bị lỗi*.

⇒ **Không port gì cả.** `/admin/api-keys` cấp hệ thống và bảng grants được ghi nhận là **đã chấp nhận mất**, tái tạo sau bằng task riêng nếu cần. Client `GET /api-keys` vẫn còn nguyên trong `lib/api/client.ts:358,361` nên khi cần thì dựng màn mới trên đó là được, không phải viết lại API.

**Yêu cầu mới được đặt ra rõ ràng: cutover không được làm hỏng portal mới.** Đây là tiêu chí nghiêm ngặt nhất của task, và nó có một cái bẫy kỹ thuật cụ thể — xem bên dưới.

**Kiểm kê chức năng (coordinator đã đối chiếu, xong trước khi chốt):** không có màn legacy nào SPA chưa phủ, trừ hai mục người dùng đã chấp nhận mất.

| Section legacy | SPA tương đương | Kết luận |
|---|---|---|
| `/admin/businesses` | `features/businesses/` (`router.tsx:48`) | Đã phủ |
| `/admin/operations` | `features/operations/` (`:47`) | Đã phủ, SPA giàu hơn |
| `/admin/overview` | `features/overview/` (`:42`) | Đã phủ |
| `/admin/profiles` | `features/profiles/` (`:46`) | Đã phủ |
| `/admin/connectors` | `features/connectors/` (`:45`) | Đã phủ |
| `/admin/audit` | `features/audit/` (`:43`) | Đã phủ |
| `/admin/crypto-config` | `features/secrets/` qua `bff/security.ts` (`router.tsx:51`) | Đã phủ |
| `/admin/grants` | **không có** | Nav chết — `section-dispatch.ts` xử lý `businesses`/`profiles`/`connectors`/`api-keys`/`operations`/`overview` (`:176,189,203,217,231,245`) và **không có nhánh `grants`** ⇒ nav mục này (`p6-01-shell-fixtures.ts:228`) không bao giờ ra dữ liệu |
| `/admin/api-keys` | `features/profiles/api-keys-panel.tsx` | **Phủ một phần** — panel có issue, attach-existing, rotate, copy-once raw key (`:88,109,122,132`). Không có danh sách key toàn hệ thống và không có bảng grants |

**Khoảng trống đã được chủ quyết định: không port, tái tạo sau.** `/admin/api-keys` cấp hệ thống + bảng grants sẽ biến mất cùng legacy. Client `GET /api-keys` còn nguyên trong `lib/api/client.ts:358,361`, nên khi cần thì dựng màn mới trên đó là được.

**Phải GIỮ, không được cắt** — đây là phần quyết định việc portal mới có bị lỗi hay không:
- `/admin/login`, `/admin/logout`, `/admin/oidc/callback` (`shell-server.ts:483-485`). Cắt nhầm ⇒ **không ai đăng nhập được**.
- Toàn bộ `/admin/api/*` của BFF (`isBffPath`, `:482`). Cắt nhầm ⇒ SPA mất **hết** đường gọi dữ liệu, mọi màn trắng.
- Chính `isAdminWebPath` và `resolveAdminWebMount` — cần còn để SPA mount.

**Cái bẫy kỹ thuật cần xử lý chủ đích — không được xoá bừa hai dòng:** `shell-server.ts:486-487` đang loại `/admin/legacy` ra khỏi SPA để đưa nó về legacy renderer. Nếu chỉ **xoá** hai dòng đó thì `/admin/legacy` sẽ **được** `isAdminWebPath` trả `true` và bị đưa vào SPA — tức đường bị đóng bên legacy lại **mở** bên SPA, với nội dung rác từ fallback route `*` (`router.tsx:57`).

Cách xử lý đúng: **thay** hai nhánh loại trừ bằng một nhánh chặn tường minh trả `404` (hoặc redirect sang `/admin`) cho `/admin/legacy` và mọi `/admin/legacy/*`, **đặt trước** phần xử lý admin-web. Không xoá dòng nào.

**Vị trí cần sửa:**
- `app/admin/shell-server.ts:480-501` — thêm nhánh chặn `/admin/legacy*`, giữ nguyên 4 nhánh loại trừ còn lại.
- `shell-router.ts:172` — bỏ `/admin/legacy` và `/admin/legacy/` khỏi danh sách map sang `admin-root`. **Không** bỏ dòng `:202` (`checkPath`) ngay trong task này — nó còn là hàng phòng thủ cho topology B, và thuộc phạm vi SEC-01F.
- `apps/admin-web/src/app-shell/app-shell.tsx:145` — gỡ thẻ link.
- `tests/sec-or-01-legacy-read-scope-offline.test.ts` — các case dùng `/admin/legacy/operations` và `/admin/legacy/overview` **sẽ hỏng** khi chặn ở tầng server. Phải chuyển chúng sang `/admin/operations` và `/admin/overview` để **giữ nguyên** phần kiểm chứng scope của SEC-01F. Không được xoá file test này.

**Lease chính:** `app/admin/shell-server.ts`, `app/admin/shell-router.ts`, `apps/admin-web/src/app-shell/app-shell.tsx`, `tests/sec-or-01-legacy-read-scope-offline.test.ts`.
**Phụ thuộc:** — (câu hỏi port đã có câu trả lời).
**Acceptance — phần không được hỏng:**
1. `/admin` và **toàn bộ** 16 route SPA (`router.tsx:42-56`) load được, không route nào rơi vào `NotFound` do thay đổi này.
2. Đăng nhập, đăng xuất, OIDC callback hoạt động end-to-end.
3. **Mọi** route BFF vẫn trả dữ liệu thật — đây là tiêu chí chính cho yêu cầu *đảm bảo portal mới không bị lỗi*.
4. Nav SPA không còn link `/admin/legacy`.
5. `/admin/legacy` và `/admin/legacy/*` trả `404` hoặc redirect `/admin` — chọn một, ghi vào test.
6. Test suite đầy đủ xanh sau khi sửa, và các case bị ảnh hưởng đã được **chuyển** chứ không bị xoá.
7. **Không** tuyên bố SEC-01 đóng — xem SEC-01F.

### SEC-01F — Vá 5 fetcher còn dùng credential platform (task mới, do §1.1 sinh ra)

**Vì sao tách riêng, dù cutover đã chặn được đường chính:** Ở topology A, cutover chặn `/admin/legacy/*` nên đường khai thác dễ nhất biến mất. Nhưng **topology B vẫn lộ** (§1.2) — `DU_ADMIN_WEB` mặc định `0`, nên `/admin/businesses` và `/admin/audit` vẫn ra dữ liệu cross-tenant. Nếu coi cutover là đã xong thì lỗ hổng quay lại ngay khi ai đó tắt cờ. **Không bỏ task này vì đã cutover.**

**Đây là task nhỏ, không phải sửa lại cả shell:** cơ chế đúng đã có sẵn — chỉ cần đưa 5 chỗ còn lại về dùng nó.

- `section-dispatch.ts:285` (businesses), `:324` (profiles), `:370` (connectors), `:411` (api-keys), `:637` (audit) — thay `config.adminToken` bằng credential đã resolve.
- Guard `:140-143` hiện chỉ chọn `operations` và `overview` (`:141-142`). Businesses và audit **phải** vào cùng guard, nếu không thì chỉ thay token cũng không đủ: cần chặn cả trường hợp không resolve được credential.
- profiles, connectors, api-keys yêu cầu role `admin` — với admin thì `legacyReadCredential` trả token platform (`:93`), nên hành vi **không đổi**. Đây là lý do thay token ở 3 chỗ đó là an toàn: nó chỉ thực sự đổi hành vi ở businesses và audit.
- Xem xét dùng `rbacPrincipal` (`bff/upstream.ts:58`) cho nhất quán với BFF — nhưng đây là **điển hình hoá, không phải fix**. Không gộp vào task này trừ khi người nhận task thấy ràng buộc lease buộc phải.

**Lease chính:** `app/admin/section-dispatch.ts`. **Phụ thuộc:** — (khác file với SEC-01, SEC-03, SEC-02).
**Acceptance:** viewer tenant A gọi `/admin/businesses` **không** nhận business của B; operator tenant A gọi `/admin/audit` **không** nhận audit của B; operator có tenant hợp lệ thì **vẫn** đọc được dữ liệu của tenant mình (chống fix quá tay làm mất chức năng); admin platform không đổi hành vi; role thiếu credential trả 403 chứ không rơi về token platform.

### SEC-02 — Đóng khe gửi credential tới origin chưa duyệt

**Vì sao #2:** secret nguồn đi ra máy chủ ngoài chính sách. DNS pinning không cứu được vì đích là public HTTPS do người gọi chọn.

**Bằng chứng thêm do proposal phát hiện, coordinator xác nhận:** `migrations/0041_profile_binding_allowed_origins.sql:3-4` thêm cột `allowed_origins jsonb NOT NULL DEFAULT '[]'` và **không có câu `UPDATE` nào** ⇒ mọi row binding có sẵn đều rỗng. Cộng với `ingestion-consumer.ts:319-334` đặt cả `ORIGIN_NOT_ALLOWLISTED` và `ORIGIN_POLICY_MISSING` vào `PERMANENT_CODES` (không retry), **bật enforce mà không backfill sẽ làm fail vĩnh viễn mọi ingestion dùng credential nguồn của dữ liệu thật**.

⇒ Đổi mặc định là **thay đổi dữ liệu**, không phải thay đổi một dòng config. Bắt buộc theo thứ tự:
1. **Đo trước, không đổi gì:** đếm số binding có credential nguồn và `allowed_origins` rỗng; đếm warning `credential.origin_denied` hiện có.
2. **Backfill** allowlist cho các row thực sự dùng credential nguồn, dựa trên origin thật của chúng. Điều kiện: 0 row dùng credential nguồn còn allowlist rỗng.
3. **Mới** đổi mặc định: `ingestion-consumer.ts:176-183` + `compose/orchestrator.yml:63` + `docs/12b-deployment-guide.md:108` + `.env.docker.example:63` + test đang pin mặc định (`tests/p730-acquire-consumer-auth.test.ts:32-35` — đổi tên test cho đúng nghĩa, không trình bày như test hỏng).
4. Giữ đường lui có phạm vi: cho phép đặt tường minh `warn` trong một cửa sổ có thời hạn, ghi lý do.

**Hướng giảm rủi ro ngay (không cần backfill):** đặt `DU_SOURCE_CREDENTIAL_ORIGIN_MODE=enforce` ở **tầng deployment** cho môi trường đã khai đủ approved origins, **không** đổi mặc định trong code.

**Phụ thuộc:** bước 1 cần **cửa sổ DB** và là câu hỏi dữ liệu, không phải câu hỏi code. Bước 2 là quyết định dữ liệu. **Cần owner chốt ai backfill** — coordinator không tự quyết chính sách bảo mật (PLAN-OPEN §10.4 vẫn đang chờ ở item này).

#### Quy tắc backfill — trả lời câu *nếu có rule thì tự động làm* của người dùng

Người dùng nói: backfill thì có làm, **cái này nếu có rule thì tự động làm**. Coordinator đã tìm trong code xem có nguồn nào để tự động. Kết quả: **không có quy tắc tự động an toàn cho phía duyệt — và cần nói rõ điều này thay vì làm cho xong.**

**Vì sao tự suy ra từ lịch sử là nguy hiểm.** Đây là điểm cốt lõi: bản chất của SEC-02 là caller tự chọn `sourceUrl` là public HTTPS rồi nhận credential của chính mình. Nghĩa là **tập origin đã từng nhận credential luôn chứa origin do kẻ tấn công chọn**. Nếu backfill lấy allowlist từ `sourceUrl` quan sát được trong lịch sử thì ta chính thức **hợp pháp hoá đúng cái tấn công mà SEC-02 sinh ra để chặn**. Đây không phải lo xa — đó là định nghĩa của lỗ hổng.

**Nguồn first-party mà code cho phép dùng** (đã kiểm, chỉ có hai):

| Nguồn | Là first-party? | Bằng chứng |
|---|---|---|
| `policy.allowedOrigins` do người vận hành khai | **Có** | `modules/profiles/policy.ts:45`, `:84`; ghi vào `profile_bindings.allowed_origins` tại `profiles.ts:311-313`, `:516` |
| `connector_bindings` trong profile | **Có** | `profiles.ts:494`, `:507` |
| Origin trong `sourceUrl` lịch sử | **KHÔNG** — do caller chọn | `submission.ts:377-380` chỉ `validateSourceUrl` + `authorizeS3Source`, không ràng buộc origin |

⇒ **Quy tắc đề xuất, là phía duyệt:** `allowed_origins` chỉ được lấy từ `policy.allowedOrigins` mà operator đã khai. Đây **đúng** là cái hệ thống đã thiết kế (`profiles.ts:311-313` carry-forward từ revision trước, nên chỉ cần operator khai một lần rồi revision sau tự mang theo).

**Có thể tự động hoá, và nên:**
1. **Bước đo (read-only)** — đếm binding có `file_url_auth_cipher` khác NULL mà `allowed_origins` rỗng. Đây là câu hỏi dữ liệu, chạy được ngay, không chạm gì.
2. **Phía chặn (deny)** — `enforce` là cờ, tự động bật được sau khi đo. Không cần quyết định con người.
3. **Phía duyệt** — **không tự động**. Chỉ có thể: (a) sinh báo cáo danh sách binding cần operator khai, rồi operator khai qua API profile hiện có; hoặc (b) backfill từ `connector_bindings` **nếu và chỉ nếu** connector đó định nghĩa origin cố định mà ta verify được. Coordinator **không** xác nhận có (b) cho tới khi đọc schema connector — ghi ở đây là điều kiện, không phải kết luận.

**Đề xuất cụ thể cho câu *tự động làm*:** tự động hoá bước 1 và bước 2, còn bước duyệt thì đưa ra danh sách chờ operator khai. Lý do nêu thẳng: backfill im lặng sẽ **khiến hệ thống trông như đã an toàn trong khi chưa**, đó là thứ tệ hơn việc chưa bật enforce.

**Phụ thuộc:** bước 1 cần **cửa sổ DB** và là câu hỏi dữ liệu, không phải câu hỏi code. Bước 2 là quyết định dữ liệu. **Cần owner chốt ai backfill** — coordinator không tự quyết chính sách bảo mật (PLAN-OPEN §10.4 vẫn đang chờ ở item này).

**Bonus nhỏ do proposal phát hiện:** `acquisition-ref-resolver.ts:181-182` `safeParse(... ?? [])` nuốt allowlist hỏng thành rỗng, dùng chung mã `ORIGIN_POLICY_MISSING`. Tách mã chẩn đoán riêng (`ORIGIN_POLICY_INVALID`) — **cải thiện chẩn đoán, không đổi hành vi cho/không cho**, có thể gộp cùng đợt hoặc làm sau.

**Lease chính:** `modules/operations/acquisition-ref-resolver.ts`, `modules/operations/ingestion-consumer.ts`, `compose/orchestrator.yml`, `docs/12b-deployment-guide.md`, `.env.docker.example`, `tests/p730-acquire-consumer-auth.test.ts`; bước backfill cần migration mới.
**Acceptance:** origin ngoài allowlist hoặc policy thiếu bị từ chối **trước khi** truyền secret; credential chỉ tới origin đã duyệt; redirect sang origin khác vẫn bỏ credential; số row fail đo được trước khi bật enforce = 0.

### SEC-03 — Verify bản đã nối + khuyến nghị mô hình policy (người dùng đã hỏi ý kiến)

**Claim trước của tôi sai, đã sửa.** §1 bản trước ghi `create-app.ts` **0** tham chiếu `createS3EncryptedPinnedSourceStorage` và `requireEncryptedSourceWrites`. Đọc lại, cả hai **đã có**:

- `create-app.ts:82-83` import cả hai writer.
- `:655` `const requireEncryptedSourceWrites = config.encryptionPolicy?.dataMode === 'real'`
- `:660-673` dùng `createS3EncryptedPinnedSourceStorage` khi `publicUploadEncryption && artifactCryptoFacade`
- `:674-679` fallback `createS3PinnedSourceStorage`
- `:681` truyền `requireEncryptedSourceWrites` vào consumer

⇒ **Không cần nối lại.** Task còn lại là **verify** và **chốt mô hình policy**.

#### Khuyến nghị mô hình policy (trả lời trực tiếp yêu cầu của người dùng)

**Khuyến nghị: lấy `dataMode` làm trục duy nhất, và exemption synthetic phải đồng nhất cho cả 4 biểu thức.**

Bốn biểu thức hiện tại cho cùng một quyết định:

| Đường | Dòng | Biểu thức | Có exemption synthetic? |
|---|---|---|---|
| ghi artifact | `:492` | `!syntheticDataExempt && !artifactMigrationWindowOpen` | **Có** |
| multipart | `:508` | `Boolean(publicUploadEncryption) && !artifactMigrationWindowOpen` | **Không** |
| đọc artifact | `:528` | `encryptedWritesRequired && !artifactMigrationWindowOpen` | **Không** |
| ghi nguồn | `:655` | `dataMode === 'real'` | **Có** (ngầm: `real` mới bật) |

**Bằng chứng cho phía exemption synthetic:** `ingestion-consumer.ts:158-160` ghi rõ đường plaintext là **hợp đồng có chủ đích** cho synthetic/legacy — *keeps the historical plaintext path byte-identical for synthetic/legacy environments*. Và `boot-options.ts:290-294` đã chốt `real` là mặc định fail-closed, còn `synthetic` phải khai tường minh kèm `approvedBy` + `acknowledgedAt` + `isolatedFromRealData` (`:219-225`) — nghĩa là synthetic đã là một lựa chọn có chủ đích, có người chịu trách nhiệm, không phải trạng thái ngầm.

**Vấn đề thật còn lại — không phải chọn (i) hay (ii), mà là sự không đồng nhất.** Ở synthetic mode với backend S3, `boot-options.ts:294` vẫn có thể bật `publicUploadEncryption` (vì `|| s3`). Khi đó `:508` = đúng (multipart **bắt buộc** mã hóa) trong khi `:492` = sai (ghi artifact **miễn** mã hóa). Hai đường ghi cùng một bucket lại có hai quyết định ngược nhau. Đây là lỗi sống, không phải tranh luận kiến trúc.

**Nên làm:** một hàm duy nhất trong `create-app.ts` resolve quyết định mã hóa từ `dataMode` + migration window, rồi cả 4 chỗ đều đọc nó. Không thêm biểu thức thứ năm.

**Khuyến nghị phụ, quan trọng hơn:** migration window (`:482-483`) **không** nên áp cho ghi nguồn. Lý do: migration window là miễn trừ cho **artifact đã ghi trước**, còn `:655` quyết định cho **dữ liệu mới đang vào**. Áp migration window cho dữ liệu mới nghĩa là một cờ vận hành tạm thời mở lỗ hổng cho dữ liệu thật. `:655` đã đúng — giữ nguyên.

**Kiểm kê bắt buộc (review yêu cầu, ngoài phạm vi offline):** liệt kê object đã ghi qua đường này; với từng object xem có sealed marker không, có manifest sidecar không. **Không được giả định coi chúng như sealed** — strict reader có thể từ chối. Cần đọc bucket thật. Đây là phần rủi ro còn sống lâu nhất của SEC-03, và nó **không** sửa được bằng code.

**Lease chính:** `app/bootstrap/create-app.ts`, `modules/operations/ingestion-storage-s3.ts`, `modules/operations/ingestion-consumer.ts`.
**Phụ thuộc:** phần kiểm kê cần cửa sổ S3 thật; phần verify cần chạy consumer test.
**Acceptance:** cả URL và IAM S3 ingestion tạo sealed object với context đúng tenant/artifact/version; marker + manifest tồn tại; strict reader đọc được; lỗi provider không để lại object plaintext; synthetic mode giữ nguyên đường plaintext byte-identical **trên cả 4 đường**; verify độc lập xác nhận `:660-673` thực sự được chọn khi `dataMode === 'real'`.

### SEC-04V — Verify độc lập bản sửa 204

**Không phải sửa — là verify.** Code sửa đã trên đĩa (xem §1). Receipt của người sửa tự báo 35 tests pass; **chưa có lượt verify độc lập nào cho bản sửa**.

**Lease:** read-only `packages/egress/**` + chạy probe loopback. **Phụ thuộc:** —.
**Acceptance:** 204/205/304/HEAD trả `body === null` và **không** làm chết tiến trình; caller catch **có** chạy; 204 webhook vẫn là giao thành công 2xx; response 200 thường vẫn trả bytes; lỗi status/header/giải nén trả về bằng rejection chứ không phải crash; timeout/abort không để socket treo. Dùng lại probe `raw/verify-orchestrator-security-2026-10-11/DSH2/05-crash-204.cjs` chạy **sau** khi sửa, so kết quả trước/sau.

---

## 3. Thứ tự và ràng buộc lease

| # | Task | Loại | Lease |
|---|---|---|---|
| 1 | **SEC-04V** | verify, rẻ, độc lập | read-only egress |
| 2 | **SEC-01** | code, **đã chốt cutover** | `shell-server.ts` + `shell-router.ts` + `app-shell.tsx` + test |
| 3 | **SEC-01F** | code, **rò dữ liệu còn lại sau cutover** | `section-dispatch.ts` |
| 4 | **SEC-03** | verify + gộp policy, **đã có code** | `create-app.ts` + storage |
| 5 | **SEC-02** | **quyết định dữ liệu trước, code sau** | resolver + compose + migration |

**Thứ tự đổi so với lần ghi trước:** SEC-01F không còn đứng trước SEC-01. Sau khi đính chính §1.2 (tôi đã viết sai rằng `/admin/legacy/*` trả 404), cutover **có** chặn được đường khai thác chính ở topology đang chạy, nên nó đi trước. SEC-01F vẫn bắt buộc nhưng là lớp thứ hai.

**Quan hệ phụ thuộc:**
- **SEC-01 và SEC-01F không cùng file** (`shell-server.ts`/`shell-router.ts`/`app-shell.tsx` vs `section-dispatch.ts`) ⇒ song song được nếu owner khác. Nhưng **SEC-01 có sửa `tests/sec-or-01-legacy-read-scope-offline.test.ts`**, đó chính là test của SEC-01F ⇒ **cùng owner thì nên serialize**, tránh hai người cùng đụng một file test.
- **SEC-01F và SEC-03 không cùng file** ⇒ song song được.
- Ràng buộc lease với OR10-01/CR10-01 ở PLAN-OPEN §10.3 **không áp dụng** cho cả hai (khác file).
- **SEC-02 và SEC-03 cùng chạm `ingestion-consumer.ts`** ⇒ cùng owner thì serialize hoặc gộp một lần sửa file.
- **Bước đo của SEC-02 là read-only** nhưng **cần cửa sổ DB**; **kiểm kê của SEC-03 cần cửa sổ S3 thật** — cùng phải xếp hàng với backlog LDBA đang chờ.
- Verifier phải **độc lập với implementer**. Không tự revert hunk lane khác.

**Ưu tiên vận hành:** thứ tự do **rủi ro dữ liệu** quyết định, không do độ rẻ. SEC-04V làm sớm để đóng nhanh. SEC-02 tuy nghe rẻ nhưng **bước đầu là câu hỏi dữ liệu**, không dispatch như một thay đổi code.

---

## 4. Điều KHÔNG claim

- **Chưa xác minh trên image/deployment đang chạy.** Review và DSH2 đều tự giới hạn rõ: không kiểm tra ingress, NetworkPolicy, Vault policy, bucket policy thực tế. Kết luận chỉ áp cho working tree tại `d0b2210`.
- **Coordinator không chạy probe.** Mọi kết luận ở §1 là **đọc tĩnh source**. Probe thực thi thuộc DSH2 và người sửa, không phải tôi.
- **Không gán CVSS** — chưa xác minh môi trường triển khai.
- **Ba claim của chính tôi đã sai** (hai dòng SEC-01 ở §1.1 + một dòng ở §1.2; một dòng SEC-03 ở §1; và `/admin/legacy/*` trả 404 ở §1.2) và đã sửa kèm bằng chứng. Đây là lần thứ tư trong tuần này một claim lệch thực tế — lần này do **tôi** ghi rồi không kiểm lại, khác với các lần trước do agent khác làm việc. Suy ra quy tắc: **phải verify cả claim của chính mình, không chỉ claim lấy từ report** — và khi kết luận *tương negative* (không có route nào, sẽ trả 404) thì phải tìm bằng chứng phủ định, vì claim đó dễ sai nhất.
- **Cutover đã chốt nhưng chưa thực thi.** Đây là đặc tả, không phải báo cáo hoàn thành.
- **SEC-01 đóng KHÔNG đồng nghĩa SEC-01 an toàn.** Cutover chặn đường ở topology A; lỗ ở topology B nằm ở SEC-01F. Hai việc khác nhau, hai task khác nhau, và thứ tự §3 đã phản ánh điều đó.
- **Không tự động hoá phía duyệt của SEC-02.** Đã nêu lý do ở mục quy tắc backfill. Tự suy ra từ lịch sử sẽ hợp pháp hoá chính tấn công cần chặn.
- **Không coi SEC-04 là đã đóng.** Đã sửa trên đĩa ≠ đã verify. Task là verify, chưa chạy.

---

## 5. Ghi nhận: hai plan frontend gần đây đã đóng gần hết

Không thuộc plan này, nhưng người đọc §1 cần biết để không dispatch trùng:

| Task | Sau ngày 2026-10-10 |
|---|---|
| AWEB-16b Overview metrics | **ĐÃ XONG** — `operations-monitor-dashboard.tsx:66-77` telemetry lấy từ `operationMetrics` server aggregate, không còn `operations.length` làm tổng; `:78` `metricCount` trả `—` khi thiếu aggregate; `:216-217` nhãn nói rõ cửa sổ + `sampledAt` + cờ stale |
| AWEB-20 phần frontend | **ĐÃ XONG** — `features/operations/state.ts:137-140` chuyển ngày thành UTC ISO gửi lên server |
| AWEB-21 deep-link URL params | **ĐÃ XONG** — có verify độc lập, `tests/deep-link-query-hydration.test.mjs` 8/8 xanh ổn định 3 lượt |

⇒ `PLAN-FRONTEND-ADMIN-WORKSPACE-2026-10-10.md` §9 của tôi ngày 2026-10-10 đã **lại lệch** — nó ghi ba task trên là việc còn lại. Đã sửa ở §10 của plan đó. Đây là lần thứ hai plan lệch trong hai ngày liên tiếp; nguyên nhân là agent tiếp tục làm việc trong khi plan chưa cập nhật, **không** phải do đọc sai. Bài học đã lưu vào memory.
