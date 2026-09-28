# Decision log và assumptions

Trạng thái: design baseline cho implementation hiện hành, chưa phải deployment đã kiểm chứng. Thay đổi quyết định phải cập nhật docs, contract và task impacted cùng lúc.

| ID | Quyết định | Lý do | Revisit trigger |
|---|---|---|---|
| ADR-01 | Ba service roles; coordinator gộp Orchestrator | Đúng phạm vi và giảm deployment | API/runtime cần lifecycle riêng |
| ADR-02 | document-kit là package trong workers | Ít hop, business tự chủ | Parser resource cost cần pool riêng |
| ADR-03 | document-core là một business sáu actions | Scale/deploy theo business | Một action SLA/resource độc lập rõ |
| ADR-04 | Registry manifest immutable, queue exact version | Plugin business và draining an toàn | Contract major rollout |
| ADR-05 | BullMQ commands + Runtime HTTP reports | Không thêm reply/event bus phức tạp | Runtime HTTP write throughput đo được là bottleneck |
| ADR-06 | Worker không có platform DB credential | Không coupling schema và giảm quyền | Business DB riêng, không platform write |
| ADR-07 | Runtime owns generic checkpoints/dependencies | Worker code quyết định steps, state durable | Business workflows vượt generic runtime contract |
| ADR-08 | DB outbox + runtime retry + fencing | Tránh lost job và duplicate side effects | Không thay vì đơn giản hóa thiếu reliability |
| ADR-09 | Connector owns credentials/config/usage ledger | Business-independent adapter boundary | Provider adapter mới |
| ADR-10 | Private S3 là storage bắt buộc cho file bytes production; PG/Redis chỉ giữ metadata/ref/control | Multi-host correctness, retry trên input bất biến, tránh file bytes trong DB/queue | Đổi object-store contract cần migration + G-DATA mới |
| ADR-11 | Same repo, independent workspaces/images | Chia agent dễ, không distributed repo overhead | Team/release governance yêu cầu tách |
| ADR-12 | No automatic production migration | Hệ thống hiện tại chỉ tham khảo | User yêu cầu migration/cutover |
| ADR-13 | pnpm workspace (not npm) for `du-rework/` | npm từ chối protocol `workspace:*` trong manifest của các lane peer (EUNSUPPORTEDPROTOCOL); pnpm resolve native qua `pnpm-workspace.yaml`. Một `pnpm-lock.yaml` duy nhất tại root; chỉ platform lane chạy root install. Root scripts: `pnpm build|test|lint|clean` (recursive). | Toolchain hợp nhất về npm (khi npm hỗ trợ `workspace:*`) hoặc yêu cầu monorepo tool khác |
| ADR-14 | R08-07: node:http/raw-pg platform router giữ làm foundation cho rework; framework/Admin UI/object-storage là deferred. Server-side authorization do platform lane sở hữu (xem chi tiết dưới) | Ổn định contract/ProblemDetails, fail-closed auth, phân tách trách nhiệm rõ; tránh tự khai báo slice tạm là đích cuối | Có authority mới cho framework/UI/storage migration |
| ADR-15 | Pilot gộp Orchestrator và Connector trên một EC2 nhưng khác container/credentials; workers ở EC2 khác. PostgreSQL EC2 hoặc RDS và Redis/Valkey EC2 hoặc ElastiCache là lựa chọn độc lập | Tách role và giữ đường nâng cấp managed mà không đổi contract | Scale/failover/chi phí đo được yêu cầu tách host hoặc backend |
| ADR-16 | JSON stdout → collector có disk buffer → Elasticsearch private TLS; audit/outbox vẫn ở DB | Log tập trung mà không chặn request khi search/log backend lỗi | Log ingestion/retention/compliance thay đổi |
| ADR-17 (SEC-00) | Admin production dùng OIDC session; provider credential thuộc connector account riêng của một tenant và ở Vault KV v2; wire kind chuẩn là `vault-kv2` | Tách tenant API key, provider secret, user session và machine identity; rotation ghim version bằng CAS, revoke chặn invocation fail-closed | Chỉ đổi nếu có ADR riêng cho connector account dùng chung, identity provider khác hoặc credential backend khác |
| ADR-18 (ENC-00, partial) | App-layer AES-256-GCM envelope encryption trước khi ghi S3/PG; Vault Transit bọc DEK; per-tenant delivery encryption qua recipient public key và app streaming gateway cho public upload | Bảo vệ dữ liệu at-rest cả khi storage bị xâm nhập; delivery encryption khi tenant bật; fail-closed khi thiếu key | Chỉ freeze sau khi ký response wire, key-policy timing, crypto profile/test vectors và upload protocol |

## Assumptions có default để tiến hành

| Topic | Default kế hoạch | Cần xác nhận trước |
|---|---|---|
| Auth | Public API giữ tenant `x-api-key`; Admin production dùng OIDC session; Connector/Vault dùng machine identity riêng | Deployment phải cấu hình issuer, client, public origin/callback, role mapping và trusted proxy trước secure enable |
| Tenant | Tenant được xác định server-side; mỗi provider account thuộc đúng một tenant; không chia sẻ account giữa tenants | Chỉ thay khi có ADR và account-binding contract/test cho shared account |
| Provider | Generic multipart/json + mock | P0 connector protocol inventory |
| Workflow mới | example-review proof trước workflow ngành | P7/P9 chọn business production tiếp theo |
| Legacy API | Paths giữ, exact payload compatibility chưa cam kết | P0 characterization matrix |
| SLO/load | Chưa có production SLA; benchmark target ghi riêng | P0 workload budget |
| Runtime versions | Pin phiên bản supported tại implementation | P1 compatibility spike |
| Retention | Configurable; cửa sổ dedup ≥ retry/replay | P0 vận hành/dữ liệu policy |

## Evidence sources

Repository mapping nằm [reference-compatibility](14-reference-compatibility.md). BullMQ semantics tham khảo tài liệu chính thức đã đối chiếu ngày 2026-09-20: [idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs), [process-step jobs](https://docs.bullmq.io/patterns/process-step-jobs), [production](https://docs.bullmq.io/guide/going-to-production). Documentation mới có thể khác phiên bản dependency sẽ pin; P1 phải xác minh API thực dùng.

---

## ADR-14 (R08-07): Platform server architecture for rework

### Accepted for this rework

- **Router:** raw `node:http` + regex-based path matching + manual JSON
  serialisation (`services/orchestrator/src/server.ts`). This is the delivery
  foundation: all registry, submission, runtime lifecycle, artifacts, grants,
  usage, and migration modules are wired through it today.
- **Auth model:** single global bearer tokens — separate `adminToken` (Admin
  routes) and `runtimeToken` (runtime routes), fail-closed when missing; public
  API key (`x-api-key` SHA-256 hash) for submission/read. The platform lane
  (`services/orchestrator`) owns all server-side authorization:
  `assertAdminAuth`, `assertRuntimeAuth`, `resolveApiKey`, tenant-scoped
  `cancelOperation`/`resumeOperation`/`getOperation` checks.
- **Admin namespace:** `/api/v1/admin/*` with bearer auth. The
  `enable`/`activate`/`deactivate`/`profile-bindings`/`sweep-deadlines` routes
  are the current Admin surface; `enable` now 404s on un-registered versions
  (W29-C fix) matching activate/deactivate fail-closed behaviour.
- **Error contract:** ProblemDetails (`urn:du:error:*`, correlation ID) as the
  stable API interface; no REST-framework dependency needed to emit it.
- **DB:** raw `pg` pool; migrations tracked in `schema_migrations`; test
  isolation via `assertTestDatabase` + scoped row cleanup only.

### Deferred — do not treat as complete

- **Rendered Admin UI:** W26-O/W29-O produce headless view-model helpers only.
  No browser/a11y/route-wiring/R08-07 UI server is claimed done.
- **Framework adoption:** moving to express/fastify/Koa is additive (framework
  wraps existing handler functions). No DB migration needed; route table maps 1:1.
  A future wave may require this but does not alter the handler contract.
- **Production object storage:** artifacts are currently in PG
  (`services/orchestrator/src/modules/artifacts/artifacts.ts`). ADR-10
  S3 storage is mandatory before production; the PG slice is a bounded
  deliverable, not a permanent design. See [G-DATA plan](../tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md).
- **Session/RBAC/CSRF admin auth:** the target admin auth model per
  `docs/07-internal-api.md` uses session cookies, RBAC roles, and CSRF
  protection under `api/internal/v1`. Current bearer-token admin auth is a
  bounded slice — not the final enterprise admin model.
- **Path migration:** the target `POST /api/internal/v1/...` namespace is not
  adopted in this rework. All Admin routes live under `PUT/POST /api/v1/admin/`
  for now.

### Compatibility / migration consequences

- The `node:http` router is a thin, replaceable layer: all business logic lives
  in pure service functions (`RegistryService`, `SubmissionService`, etc.).
  Wrapping these in a future framework is a routing-layer change, not a DB
  schema change.
- ProblemDetails is the stable contract; changing it requires a coordinated
  contract bump across SDK/Connector/Admin consumers.
- Migrating to `api/internal/v1` session/RBAC auth is a separate wave with its
  own ADR and must not be silently declared complete from the bearer-token slice.

### Authorization ownership

Server-side authorization is owned entirely by the platform lane
(`services/orchestrator`): `assertAdminAuth`, `assertRuntimeAuth`,
`resolveApiKey`, `ProfileService.resolveBinding` (PRF-01), and tenant-scoped
`cancelOperation`/`resumeOperation`/`getOperation`/`listOperations`. Cross-tenant
reads are denied via `tenant_id` match (404 NOT_FOUND, never 403 — no
information leakage). Admin routes are global-by-design: the single bearer token
represents a trusted global administrator; multi-admin RBAC is deferred to the
session/RBAC auth wave.

---

## ADR-17 (SEC-00): OIDC Admin và provider credential theo tenant

**Trạng thái:** Accepted cho kiến trúc mục tiêu ngày 2026-09-25. Đây là quyết
định thiết kế, không phải bằng chứng OIDC/Vault đã được triển khai hay gate
`G-SEC` đã đóng. OIDC/API và Vault integration vẫn phải đạt các acceptance ở
[`SEC-OIDC-VAULT-2026-09-24.md`](../tasks/SEC-OIDC-VAULT-2026-09-24.md).

### Phạm vi và danh tính

- `x-api-key` của tenant chỉ xác thực Public API và tiếp tục lưu dưới dạng hash
  trong PostgreSQL. Provider/connector API key là credential khác: giá trị
  chỉ nằm trong Vault; OIDC không thay thế Public API authentication.
- Mỗi deployment cấu hình đúng một OIDC issuer, client ID và redirect URI chính
  xác tuyệt đối. Callback là
  `${DU_ADMIN_OIDC_PUBLIC_ORIGIN}/admin/oidc/callback`; origin production phải
  là HTTPS cố định. Discovery/JWKS chỉ lấy từ issuer cấu hình. Chỉ chấp nhận
  `RS256` và `ES256`; không có wildcard issuer, redirect hay thuật toán.
- `groups` là claim duy nhất dùng để map role; giá trị group được allowlist
  bằng cấu hình phía server. Một subject phải khớp đúng một role group
  (`admin`, `operator` hoặc `viewer`); thiếu hoặc khớp nhiều role đều bị deny.
  Tenant không lấy từ request, cookie hay group name: platform tra cứu cặp
  `(issuer, subject)` trong mapping quản trị đã duyệt và gắn đúng một `tenant_id`.
  Principal chưa map hoặc tenant không còn active bị deny. Không có global
  administrator mặc định.
- `DU_ADMIN_OIDC_PUBLIC_ORIGIN` là nguồn chuẩn dựng redirect/cookie origin;
  không dựng từ `Host`, query string hoặc header do client gửi. Listener Admin
  chỉ nhận traffic từ reverse proxy đã khai báo trong trusted-proxy CIDR config.
  Chỉ peer thuộc allowlist mới được cung cấp `Forwarded`/`X-Forwarded-*`; proxy
  phải ghi đè các header này và chấm dứt TLS.
- Production dùng opaque `HttpOnly; Secure; SameSite=Lax` session trong Redis
  dùng chung giữa replicas, trên connection riêng với BullMQ. Session lưu
  `issuer`, `subject`, role, tenant, CSRF secret và expiry; cookie chỉ chứa ID
  ngẫu nhiên. TTL tuyệt đối là 8 giờ, idle TTL là 30 phút; OIDC state/nonce có
  hiệu lực tối đa 10 phút và dùng một lần. Redis/session store lỗi thì Admin
  auth deny, không hạ cấp sang memory hay token cookie. Client secret được
  inject bằng mounted deployment secret file; không bootstrap OIDC client
  secret từ chính Vault provider-credential path.
- Break-glass qua HTTP bị tắt trong production. Khi IdP hỏng, vận hành khôi
  phục IdP hoặc rollback OIDC deployment config bằng quy trình hạ tầng có audit;
  static `adminToken` không phải đường dự phòng production. Local/dev có thể
  giữ local auth nhưng không bật đồng thời làm fallback cho OIDC production.

### Claim-surface difference (SEC-00)

The browser session surface uses `roleFor` to keep the UI fail-safe when an
otherwise valid claim carries multiple tenant values: it reduces the effective
role to the least-privileged read-only `viewer` and does not grant mutation
authority from an ambiguous claim. The bearer/API surface is stricter:
`mapOidcClaimsToPrincipal` returns `null` and the request is denied by default
when the claim shape is ambiguous or cannot establish one trusted tenant,
rather than inventing a viewer principal. Both paths consume the same canonical
claim-shape rules exported by
[`@du/contracts` OIDC claim shapes](../packages/contracts/src/oidc-claim-shapes.ts),
so the difference is an intentional boundary policy, not parser drift.

### Tenant/account isolation và role matrix

- Connector account là tenant-owned: một `account_id` gắn bất biến với đúng
  một cặp `(tenant_id, connector_id)`. Provider account dùng chung nhiều tenant
  bị cấm trong thiết kế này; muốn chia sẻ phải có ADR mới và grant chia sẻ rõ
  ràng. Connector revision phải lưu account binding tin cậy cùng tenant scope;
  Connector kiểm binding này với tenant trong signed invocation grant trước
  khi đọc secret. `account`, `mount`, `path`, `key` không bao giờ lấy từ
  invocation body hay worker payload.
- Vault KV v2 dùng một mount được cấu hình và allowlist bởi deployment (`secret`
  là mount mặc định). Provider API key có field `api-key`; path nằm bên trong
  mount và theo mẫu
  `du/tenants/{tenant_id}/connectors/{connector_id}/accounts/{account_id}`.
  Path phải khớp tenant/connector/account của revision; mount tùy ý hoặc path
  ngoài prefix bị từ chối. DB chỉ lưu ref metadata và version pin, không lưu
  provider key/token.

| Quyền trong đúng tenant đã map | Viewer | Operator | Admin |
|---|---:|---:|---:|
| Đọc operations và connector metadata đã mask | Có | Có | Có |
| Cancel/resume operation | Không | Có | Có |
| Replay operation | Không | Không | Có |
| Tạo/rotate/test/revoke provider credential; bind connector account | Không | Không | Có |
| Quản lý tenant `x-api-key` | Không | Không | Có |
| Đọc hoặc mutate tenant khác | Không | Không | Không |

Cross-tenant object được trả như không tồn tại. Credential test thuộc quyền
admin vì nó xác minh khả năng đọc Vault và có thể gọi provider. Raw key không
hiển thị lại sau khi write-only request kết thúc; GET/list/audit chỉ trả ref,
version và trạng thái mask.

### OIDC session và Vault credential là hai trust domain

- OIDC chứng minh danh tính người quản trị và tạo principal
  `(issuer, subject, role, tenant_id)`. Session cookie/CSRF token không chứa,
  suy ra hoặc cấp quyền Vault; IdP ID/access token không được gửi xuống browser,
  ghi vào audit hay dùng làm Vault token.
- Sau khi kiểm tra role và tenant, Orchestrator dùng machine identity riêng
  làm Vault writer. Connector dùng machine identity khác, read-only, để đọc
  đúng prefix/account của revision. Writer không đọc secret data; reader không
  ghi, delete hoặc liệt kê ngoài prefix. Không dùng root token. Worker, browser,
  invocation grant và Redis job không nhận Vault token hay plaintext key.
- Admin session chỉ có quyền gọi chức năng theo role/tenant. Connector không
  tin principal header do browser gửi; nó xác thực service identity/grant rồi
  dùng tenant/account binding đã lưu trên revision. Credential resolution
  không dùng session admin và không biến session thành service credential.

### Canonical source và tương thích

Credential source của connector revision là một trong hai JSON object sau:

```json
{"kind":"vault-kv2","account":"acct-uuid","mount":"secret","path":"du/tenants/tenant-uuid/connectors/openai/accounts/acct-uuid","key":"api-key","version":7}
{"kind":"legacy-db","credentialRef":"opaque-legacy-ref"}
```

`vault-kv2` là discriminator canonical cho mọi write mới. Reader tiếp tục nhận
alias tường minh `vault-kv-v2` và chuẩn hóa nó thành `vault-kv2` trong memory;
không phát alias khi ghi. Alias chỉ được bỏ bằng một ADR/contract migration
riêng sau khi persisted rows và deployed readers đã được kiểm kê. Vault version
phải là số nguyên dương được pin; `latest` không phải source hợp lệ cho revision.
`legacy-db` chỉ dùng AES-GCM `secret_versions` qua `credentialRef` tường minh.
Thiếu/hỏng discriminator là lỗi credential, không được tự chuyển sang DB.

### Rotation, revoke và rollback

1. Writer đọc metadata version hiện tại rồi ghi KV v2 bằng CAS: lần tạo đầu
   dùng `cas=0`; rotation dùng đúng version hiện tại làm expected CAS. CAS
   conflict trả conflict và không tạo revision. Plaintext chỉ đi qua write-only
   request tới Orchestrator rồi Vault.
2. Khi CAS write thành công, Orchestrator tạo revision `PENDING` ghim
   `{account,mount,path,key,version}` vừa được Vault trả về. PENDING không
   được invoke. Connector reader probe field/version thật trước khi activate.
3. Activation là một CAS transaction trên current ACTIVE revision:
   revision mới chuyển `PENDING → ACTIVE`, current chuyển `ACTIVE → RETIRED`
   trong cùng transaction. Chỉ một revision được ACTIVE. Mất CAS thì revision
   vẫn PENDING để reconcile/retire; không mở invocation bằng ref nửa chừng.
   Submission mới pin revision ACTIVE. Invocation đã qua bước credential
   resolution trước rotation được phép kết thúc; invocation chưa được admission
   trước khi revision cũ retire bị từ chối.
4. Revoke tạo tombstone authoritative cho account/version và retire mọi revision
   tham chiếu nó trước khi trả thành công. Propagation budget là 2 giây; nếu
   không xác nhận được tombstone/binding trong budget thì trả unavailable và
   mọi invocation mới fail closed. Connector kiểm revoke state trước khi đọc
   và ngay trước provider dispatch; không cache plaintext. Sau revoke, provider
   call mới bị chặn. Request đã được provider nhận trước thời điểm revoke không
   thể bị thu hồi từ phía Connector.
5. Emergency revoke có thể KV v2 soft-delete/destroy đúng version theo incident
   policy; cả application tombstone lẫn deleted/destroyed version đều làm ref
   invalid. Vault timeout, 403, version thiếu, hoặc trạng thái revoke không rõ
   đều chặn provider và không fallback sang legacy DB hay Vault version khác.
6. Rollback chỉ tạo revision mới `PENDING` ghim version cũ nếu version đó chưa
   bị revoke/deleted/destroyed và cùng tenant/account binding còn hợp lệ; CAS
   activate theo quy trình thường. Revision/version cũ không bị sửa tại chỗ,
   plaintext không được đọc lại để rollback.

Vault read timeout là 1 giây mỗi attempt, tối đa 3 attempt với backoff 100 ms
và 200 ms (tổng budget tối đa 3.3 giây); budget này phải nhỏ hơn provider
deadline. Revocation không có cache grace period. Rotation, revoke và reconcile
đều phải idempotent theo request key; response/audit chỉ có actor, resource
metadata, version và outcome.

### Consequences và việc cần triển khai

- Contract và migration phải mang tenant/account binding trên revision và
  enforce exact Vault prefix; source hiện tại chỉ xác thực hình dạng ref nên
  chưa chứng minh được isolation theo ADR này.
- Orchestrator/Admin phải enforce principal mapping, role matrix, fixed origin,
  trusted proxy và production break-glass policy trước khi bật cookie mutation.
  Connector/Vault phải enforce machine-identity policies, CAS workflow,
  pre-dispatch revoke check, timeout budgets và sink redaction.
- Việc thêm ADR-17 không đóng SEC-00 hoặc VAULT-01..06: owner vẫn cần contract,
  migration, negative tests và integrated receipt trên revision ACTIVE do
  Orchestrator tạo. G-SEC tiếp tục mở tới khi toàn bộ evidence trong task đạt.

---

## ADR-18 (ENC-00): Application-layer envelope encryption và external result delivery

### Context và bài toán

Hệ thống xử lý tài liệu cần đảm bảo tính bảo mật nghiêm ngặt cho dữ liệu tài liệu nhạy cảm (input, output, checkpoint):
1. **At-rest security:** Dữ liệu lưu trữ trong S3 hoặc DB phải được mã hóa trước khi gửi tới storage backend (application-layer encryption), đảm bảo nếu storage bị compromise thì dữ liệu vẫn bất khả xâm phạm.
2. **Delivery security:** Khi trả kết quả cho external tenant app qua API công khai, nếu tenant cấu hình mã hóa đầu ra, kết quả phải được bọc trong envelope mã hóa bằng public key của chính tenant, giải mã hoàn toàn ở client-side ngoài hạ tầng DUGate.
3. **Key management:** Phải dùng mô hình envelope encryption: mỗi artifact/file dùng một Data Encryption Key (DEK) 256-bit độc lập; DEK được wrap/unwrap thông qua Vault Transit engine. Không lưu master key hoặc plaintext DEK ở DB/S3/log.

### Baseline kỹ thuật đã chọn (ENC-00 vẫn partial)

1. **Storage Backend Scope:**
   - S3 là production backend chính thức cho file bytes theo ADR-10 và `G-DATA`.
   - PostgreSQL storage backend (`artifact_blobs` hoặc table tương đương) chỉ được hỗ trợ làm **pilot / fallback có kiểm soát** (kích thước artifact tối đa 10 MB, retention ngắn hạn). Cả S3 và DB đều dùng chung một định dạng envelope ciphertext thống nhất. Không tự động chuyển đổi ngầm giữa S3 và DB.
2. **Output Delivery Policy:**
   - Chính sách mã hóa output được quản lý **per-tenant** tại cấu hình Admin (`deliveryEncryptionEnabled: boolean`).
   - Mặc định là `disabled` (trả result envelope tiêu chuẩn). Khi `enabled`, server giải mã lớp storage DEK trong bộ nhớ streaming và bọc lại bằng recipient delivery DEK mới cùng public key của tenant.
   - Không hỗ trợ query parameter hay header client-controlled để bypass policy đã cấu hình.
3. **Recipient Cipher Suite & Envelope Format:**
   - Hỗ trợ hai bộ suite tiêu chuẩn, định danh qua field versioned:
      - **Suite 1 (Ưu tiên):** HPKE RFC 9180 (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM cho payload).
     - **Suite 2 (Tương thích Enterprise/Legacy):** RSA-OAEP-SHA256 (cho key wrapping) + AES-256-GCM (cho payload).
   - Envelope delivery mang: `{ version: 1, suite: "hpke"|"rsa-oaep-aes-gcm", recipientKeyId, enc, nonce, tag, ciphertext }`.
4. **Tenant Public Key Lifecycle & Ownership:**
   - External tenant đăng ký public key qua Admin API/UI kèm chữ ký xác minh quyền sở hữu (Proof-of-Possession challenge).
   - Public key được lưu kèm metadata: `fingerprint` (SHA-256), `algorithm`, `version`, `effectiveAt`, `revokedAt`.
   - Result delivery ghim `recipientKeyVersion` tại thời điểm sinh kết quả. Nếu public key bị revoke hoặc không tìm thấy, API trả lỗi 422/409 fail-closed, tuyệt đối không trả plaintext fallback.
5. **Streaming Chunking & Plaintext Inventory:**
   - File lớn (> 5 MB) được mã hóa theo các chunk độc lập (mỗi chunk 4 MB) sử dụng AES-256-GCM authenticated streaming, kèm manifest chứa chunk hashes và monotonic chunk index để chống truncate/reorder.
    - Metadata DB (`operations.input_ref`, `tasks.payload_ref`, child/HITL state, outbox), queue, log và temp bền vững không chứa inline plaintext của nội dung tài liệu; chỉ chứa encrypted references, hash, và metadata không nhạy cảm.
6. **Public upload boundary:** Public single/multipart/compatibility upload phải qua streaming gateway mã hóa trong app trước khi ghi S3. Presigned PUT/part trực tiếp với plaintext không đạt yêu cầu; client-side encryption không tự thay thế nghĩa vụ mã hóa của app. Một mô hình khác cần ADR/phê duyệt riêng.

### Quyết định còn mở trước contract freeze

- Chốt policy và recipient key version tại thời điểm tạo result hay mỗi lần GET; xác định hành vi với result cũ khi Admin toggle, key rotate/revoke và khi Vault outage.
- Chọn một wire profile chính xác cho mỗi suite: HPKE `enc` so với RSA wrapped DEK, AAD, nonce/tag, authenticated chunk manifest, thuật toán/key IDs và external-client test vectors. `enc` không được dùng mơ hồ cho hai loại dữ liệu khác nhau.
- Chốt `GET /operations/:id/result` trả business data hay ref, `/artifacts/:id/download` trả 200 proxy hay 302, hai mode plain/encrypted và cache/webhook semantics. Đồng bộ contracts/OpenAPI trước ENC-01/07.
- Chốt PoP challenge, key retention, file/inline-text budgets, rotation/backup và Product/Security/Architecture sign-off. Gateway phải có backpressure, size/hash semantics theo ciphertext và kiểm thử direct-upload bypass.

### Trạng thái Gate

- ADR-18 ghi baseline thiết kế; `ENC-00` vẫn `[~]` cho tới khi bốn nhóm quyết định còn mở được ký và contract freeze. Không giao crypto wire implementation từ baseline này.
- Gate `G-ENC` tiếp tục mở cho đến khi `ENC-00`, `ENC-01` đến `ENC-09`, `ENC-META-01` và `ENC-INT-01` được chốt/triển khai đúng phạm vi, kiểm thử độc lập và được Reviewer phê duyệt.
