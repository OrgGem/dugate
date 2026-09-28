# Kế hoạch triển khai: OIDC Admin + Vault credential cho Connector

Trạng thái: **đã chia task, chưa triển khai**. Đây là phạm vi bổ sung trước G6; không đổi trạng thái các task P2/P3/P6/P8 đã tick và không tính task con bên dưới hai lần với các nhóm yêu cầu SEC-01..07. [Review code tích hợp và Admin UI](../coordination/REVIEW-SEC-SERVICE-UI-2026-09-24.md) là căn cứ cho ba task nền mới.

Review refresh: [toàn bộ code/plan](../coordination/FULL-REWORK-REVIEW-2026-09-24.md) và [follow-up](FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md) bổ sung current acceptance holds, evidence rules và thứ tự dưới đây. Vẫn đúng **16 task**, không tạo backlog trùng từ các detail sections SEC-01..07.

## Backlog có thể giao việc

`SEC-00` là cổng quyết định chung. `ADM-BASE-*` đóng khoảng trống tích hợp hiện hữu trước khi thêm auth/secret; `OIDC-*` và `VAULT-*` là task triển khai; `SEC-INT-*` là gate tích hợp/vận hành. Các mục SEC-01..07 ở phần sau là đặc tả chi tiết để đối chiếu acceptance, **không** phải một backlog thứ hai. Owner dưới đây là vai trò đề xuất, chưa phải lệnh phân công agent.

| ID | Trạng thái | Owner / phạm vi sửa chính | Phụ thuộc | Kết quả và điều kiện đóng |
|---|---|---|---|---|
| SEC-00 | [ ] | Product + platform + security; `docs/15-decisions.md`, contracts | — | Chốt và ký triển khai theo ADR-17: deployment-specific IdP issuer/claim mapping, Admin public origin/callback + reverse-proxy trust, break-glass, provider key khác tenant `x-api-key`, tenant-owned connector account, credential slot, Vault KV v2 mount/account path/key/version, rotation/revoke/rollback. Freeze JSON contract với `vault-kv2` canonical và read alias `vault-kv-v2`; revision phải có trusted tenant/account binding. Không bật OIDC/Vault trước sign-off và contract freeze. |
| ADM-BASE-01 | [ ] | Platform + Admin UI; `server.ts`, `src/app/admin/*`, Admin GET API | — | `createApp` mount shell vào origin ổn định và nối dữ liệu thật bằng in-process service adapter hoặc base URL cấu hình tin cậy; bổ sung các Admin GET endpoint mà các pane business/profile/connector/API-key/operation/overview thật sự gọi, ưu tiên connector revision/metadata. Production không rơi về catalog fixture; test `createApp` + DB thật xác nhận dữ liệu ở HTML khớp API, không lấy base URL từ query. |
| ADM-BASE-02 | [ ] | Platform + Admin UI; shell action router/BFF + Admin mutations | Plumbing: ADM-BASE-01; secure enable/closeout: OIDC-03 | Xây action matcher/dispatcher với trusted test principal trước; POST rotate/test/cancel/resume/replay gọi service đúng scope. Chỉ bật cookie-auth mutation sau server principal/role/tenant/CSRF. Browser click phải tạo request và chứng minh side effect của từng action: mutation đổi DB; credential test kiểm resolver/provider theo contract, không bắt buộc tự đổi DB. Không gửi admin bearer ra browser; unsupported action 404/405, không trả GET như thành công. |
| ADM-BASE-03 | [ ] | Platform; Orchestrator HTTP error/log boundary | — | Không đưa `String(err)`/upstream Vault/IdP error vào HTTP `detail` hoặc log; ProblemDetails chỉ có mã/thông điệp an toàn, correlation ID. Test sentinel secret/path/token trong lỗi bất ngờ không xuất hiện ở response/log/trace. |
| OIDC-01 | [ ] | Platform/auth; Orchestrator auth/config/routes | SEC-00 | Login/callback Authorization Code + PKCE, discovery/JWKS allowlisted, state/nonce dùng một lần; fake IdP xác nhận cả happy path và issuer/audience/signature/redirect/replay lỗi đều fail closed. Theo SEC-01. |
| OIDC-02 | [ ] | Platform/auth; session store/migration | OIDC-01 | Opaque session dùng chung hai replicas, TTL/idle expiry, rotate sau login, logout/revoke; cookie bảo vệ và không đưa token vào HTML/log. Test restart/replica/expiry. Theo SEC-02. |
| OIDC-03 | [~] | Platform API; principal/RBAC/CSRF contract | OIDC-02; role×action×tenant matrix từ SEC-00 | Map claims → trusted principal, default deny; không tin header tự khai hoặc dùng bearer toàn quyền bỏ qua role. Test direct HTTP từng ô allow/deny của matrix: viewer không mutate; operator chỉ được actions đã duyệt (ví dụ cancel/resume), bị chặn admin-only credential/key changes. CSRF guard cho cookie-auth mutation; Public API key/runtime identity không đổi. Theo SEC-02. |
| OIDC-04 | [ ] | Admin UI + browser test; Admin shell | OIDC-03, ADM-BASE-01 | Nối nút login/logout và luồng session vào shell trên public origin cố định; browser thật qua fake IdP kiểm tra redirect, callback, logout, expired session, role và CSRF. Không nhận DOM-only test là bằng chứng mutation. Theo SEC-01/02. |
| VAULT-01 | [ ] | Contracts + platform + Connector; schema/migrations | SEC-00 | Typed `VaultKv2Ref` (`account`, `mount`, `path`, `key`, `version`) và validator theo binding đã chốt; revision pin immutable source/version và trusted `(tenant_id, connector_id, account_id)`, thêm `PENDING`/`ACTIVE`/`RETIRED` bằng migration tương thích legacy explicit. Chỉ chấp nhận path canonical của đúng binding; chặn traversal/encoded separator/foreign binding. Writes phát `vault-kv2`; reader nhận alias cũ `vault-kv-v2` rồi normalize. Từ chối secret-bearing `config.headers` lưu JSONB, không persist plaintext/token. Theo SEC-03. |
| VAULT-02 | [ ] | Infra/security + platform/Connector; Vault client/policies | VAULT-01 | Hai machine identities tách quyền writer và reader; Vault policy phải giới hạn tenant/account prefix được cấp cho identity. Policy rộng `du/tenants/*` chỉ hợp lệ nếu Vault identity templating/token binding thu hẹp mỗi token về tenant/account được phép. TLS/timeout/token renewal, dev fixture + policy test; không dùng root token hay cho browser/worker đọc Vault. Theo SEC-04/05. |
| VAULT-03 | [ ] | Platform API; Orchestrator Vault writer + connector revision | VAULT-01, VAULT-02, OIDC-03, ADM-BASE-03 | Admin API write-only tạo/rotate provider key bằng KV v2 CAS, revision `PENDING → ACTIVE` idempotent, reconcile khi Vault thành công nhưng DB/Connector lỗi; GET/audit chỉ metadata masked. 403/path/CAS/timeout đều fail closed, không mở invocation trên ref nửa chừng. Theo SEC-04. |
| VAULT-04 | [ ] | Admin UI; Connector configuration section | VAULT-03, ADM-BASE-02 | Form cấu hình provider key ở P6-04 gọi API thật, hiển thị path/key/version/masked state và test/revoke action; không đọc lại raw key. Tách khỏi P6-05 là **tenant API key**. Browser test create/rotate/reload/revoke và DB/Connector state đổi thật. Theo SEC-04. |
| VAULT-05 | [ ] | Connector; secret resolver/invocation boundary | Implement/unit: VAULT-01/02; integration closeout: VAULT-03 | Sau grant + trusted revision/account-binding validation, Connector phải so khớp grant tenant/connector, revision `(tenant_id, connector_id, account_id)`, `ref.account` và path canonical chính xác trước bất kỳ Vault request nào; mismatch bị từ chối, không đọc Vault/provider. Sau đó chỉ đọc đúng `mount/path/key/version` từ KV v2; dùng provider credential slot đã duyệt, không hardcode Bearer. Thiếu field/revoked/403 chặn provider, 5xx retry bounded, không fallback DB. `/connectors/:id/test` giữ cùng tenant/account scope. Unit dùng typed fixture; closeout phải dùng ACTIVE revision/ref do Orchestrator VAULT-03 tạo. Theo SEC-05. |
| VAULT-06 | [ ] | Platform + Connector + operations; lifecycle/migration | VAULT-03, VAULT-05 | CAS rotation, pin old/new revision cho in-flight/new submissions, emergency revoke, legacy→Vault từng connector, restart/reconcile `PENDING`, rollback có điều kiện; concurrent rotation/outage không drift và không lộ secret. Theo SEC-06. |
| SEC-INT-01 | [ ] | Testing/integration + các owner; multi-container harness | OIDC-04, VAULT-04, VAULT-05, VAULT-06, ADM-BASE-01..03; fixtures từ OIDC-01/VAULT-02 | E2E browser login → cấu hình key → Connector đọc path/key → mock provider → rotate/revoke trên services thật; hai replicas, RBAC/tenant/CSRF/policy/outage matrix và sentinel sink scans bên dưới. Fixture phải boot được trước feature tests. Không dùng stub fetcher hoặc health probe thay credential test. Theo SEC-07. |
| SEC-INT-02 | [ ] | Infra/QA + release owner; deploy/runbooks/evidence | SEC-INT-01 để đóng gate; chuẩn bị deploy/runbooks từ M1 | Đóng gói fixture IdP từ OIDC-01 và Vault/policies từ VAULT-02 đã có, không để INT-01 chờ fixture của task này. Env mẫu, bootstrap/renewal/outage/rollback runbook, OpenAPI/ADR; build/typecheck/lint/test exit 0 và evidence vào P8 trước G6. Theo SEC-07. |

### Evidence bắt buộc cho từng task

Owner trong backlog chịu trách nhiệm receipt. Mỗi ID có tên test, command/cwd, current source/build identity, exit code, số pass/fail/skip và positive/negative cases; chỉ có file hoặc unit mock không đủ đóng integration. Các task dùng chung API/fixture tham chiếu cùng receipt, không cộng task/effort lần hai với P2/P3/P6/P8.

| Task | Phép đo bổ sung để đóng |
|---|---|
| SEC-00 | ADR có một lựa chọn cụ thể cho từng decision, role×action×tenant matrix, session/deadline/revoke budgets bằng giá trị cấu hình đã duyệt; JSON contract chốt `vault-kv2` cho mọi write và alias `vault-kv-v2` chỉ cho read; có owner sign-off cho cấu hình triển khai. |
| ADM-BASE-01 | Live DB có dữ liệu khác catalog; HTTP/HTML khớp từng GET pane, foreign scope bị chặn; không có fixture fallback trong production config. |
| ADM-BASE-02 | Mỗi action có request/response và observable side effect đúng contract; direct denied/CSRF/unsupported POST có status và zero side effects. |
| ADM-BASE-03 | Unique sentinel trong unexpected exception; response/log/trace có zero matches, vẫn có stable error code/correlation ID. |
| OIDC-01 | Fake IdP boot trước tests; state/nonce replay và sai issuer/audience/signature/redirect từng case fail closed, không tạo session. |
| OIDC-02 | Session từ replica A dùng được ở B; logout/revoke/TTL/idle-expiry chặn cả A/B; reload/restart không khôi phục session đã revoke. |
| OIDC-03 | Mọi ô matrix SEC-00 có direct HTTP assertion; forged browser identity header không nâng quyền; denied call không ghi DB/Vault. |
| OIDC-04 | Browser qua IdP thật trong fixture: redirect/callback/session/logout/expiry; request assertions và server role checks, không chỉ DOM. |
| VAULT-01 | Schema rejects từng malformed mount/path/key/version/binding/secret header trước persist; migration test legacy và immutable revision. Assert mọi serializer/writer phát `vault-kv2`, parser nhận `vault-kv-v2` rồi canonicalize; foreign tenant/connector/account/path bị reject. |
| VAULT-02 | Fixture boot lặp được; writer write-allowed/read-denied, reader read-allowed/write-denied trong identity tenant/account prefix; identity khác tenant/account bị deny ở Vault policy; renewal/expiry/outage tests. |
| VAULT-03 | Duplicate/CAS/concurrent rotation và crash sau Vault write: không có duplicate ACTIVE revision hoặc invocation bằng PENDING ref; metadata responses không secret. |
| VAULT-04 | Create/rotate/test/revoke qua live API; reload không raw value; HTTP + DB/Connector state tương ứng thay đổi. |
| VAULT-05 | Hai keys cùng path và hai pinned versions trả đúng giá trị cho mock provider; mismatched grant/revision/ref account, tenant, connector hoặc path bị chặn trước Vault read (Vault read count 0) và provider call; missing/revoked/403 có provider call count 0; ref do VAULT-03 phát hành. |
| VAULT-06 | Rotation/restart/revoke/rollback matrix có đúng một expected result mỗi cell theo SEC-00; migration không tự fallback DB khi Vault lỗi. |
| SEC-INT-01 | Full E2E hai replicas, fault matrix, sink sentinel scans đều exit 0; skipped/live-stub case không tính pass. |
| SEC-INT-02 | Clean deploy/runbook rehearsal, config không secret thật, evidence liên kết P8; G-SEC chỉ đóng khi 16 receipts hợp lệ. |

Sink scan dùng sentinel riêng cho provider key, IdP/Vault token và sensitive path/query: HTTP ProblemDetails, Admin HTML/client state/browser trace, stdout/collector/Elasticsearch, structured trace, webhook payload + `last_error`, artifact filename/metadata, usage payload/labels, metrics labels, outbox/retry payload, PostgreSQL revision/invocation JSON và Redis jobs. **Không** coi HTML escaping là confidentiality hoặc GET redaction là write-time protection. SSE chưa có endpoint trong service snapshot; thêm test khi endpoint xuất hiện, không tuyên bố leak SSE hiện tại. `LOG-01` sở hữu log schema/redaction chung; SEC tests reuse cùng sink policy.

### Lộ trình và cổng nghiệm thu

| Mốc | Việc có thể chạy song song | Cổng ra |
|---|---|---|
| M0 — quyết định + lỗi nền | SEC-00; ADM-BASE-01/03 có thể bắt đầu ngay | Theo ADR-17, phạm vi là provider key và connector account tenant-owned; hoàn tất deployment-specific owner sign-off cùng JSON contract freeze trước OIDC/Vault. Admin mount/API read thật và error boundary không phải chờ sign-off này. |
| M1 — nền tảng feature | OIDC-01 và VAULT-01; VAULT-02 sau contract | Public Admin origin + API read thật, error boundary an toàn, fake IdP và Vault dev/policy fixture; contract/ref freeze trước khi hai service sửa cùng wire. |
| M2 — auth và secret backend | ADM-BASE-02 plumbing sau ADM-BASE-01; OIDC-02 → OIDC-03 để secure enable; VAULT-05 unit song song, integrated closeout sau VAULT-03 | Session/RBAC/CSRF server-side, action dispatcher và writer/reader có test negative riêng; chưa bật Admin UI production khi thiếu một nửa. |
| M3 — UX và lifecycle | OIDC-04, VAULT-04; VAULT-06 sau write/read path | Browser click có mutation thật; rotation/revoke/migration có pin version, rollback và test restart. |
| M4 — nghiệm thu | SEC-INT-01 → SEC-INT-02 | Gate `G-SEC`: 16/16 task đóng bằng evidence, không có plaintext leak, tích hợp exit 0. Chỉ khi đó mới dùng làm bằng chứng P8/G6; không tự động cutover. |

**Đường găng secure enable:** SEC-00 → OIDC-01 → OIDC-02 → OIDC-03 → ADM-BASE-02 closeout → VAULT-04 → SEC-INT-01 → SEC-INT-02; nhánh VAULT-01/02 → VAULT-03 → VAULT-05 integration/VAULT-06 phải hội tụ trước SEC-INT-01. ADM-BASE-01/03 và dispatcher plumbing làm trước độc lập. OIDC-01 sở hữu fake IdP fixture; VAULT-02 sở hữu real dev Vault/policy fixture từ M1; infra hỗ trợ ngay, không chờ INT-02. Integration owner giữ quyền duy nhất với root workspace lockfile/contracts; mỗi handoff có diff, migration policy, command + exit code, negative evidence và rủi ro.

**Liên hệ task gốc:** ADM-BASE-01/02 đóng khoảng trống P2-02/P6-04..06; ADM-BASE-03 đóng error boundary P8-04. OIDC-01..04 mở rộng P2-02/P6-01 và auth gate P8-04; VAULT-01..06 mở rộng P2-02, P3-02/05 và P6-04; SEC-INT-01/02 nối P8-01/04/06/07/08. Những task P3/P6 đã `[x]` là baseline cũ, không chứng minh tích hợp hay OIDC/Vault. P8-08/G6 không được đóng trước `G-SEC` nếu tính hai tính năng này vào release đầu.

## 1. Phạm vi và quyết định trước khi code

**Quyết định SEC-00 theo ADR-17:** “API-key” trong yêu cầu này là **provider/connector API key** được Admin cấu hình, Orchestrator ghi vào HashiCorp Vault và Connector đọc khi gọi provider. Nó **khác** `x-api-key` của tenant gọi Public API: loại này hiện được xác thực bằng hash trong PostgreSQL tại `services/orchestrator/src/server.ts:830-841`; không di chuyển raw tenant key vào Vault hoặc biến OIDC thành auth cho Public API. Connector account thuộc duy nhất một tenant và một connector; không hỗ trợ account dùng chung giữa tenant nếu chưa có ADR và grant chia sẻ mới. Target revision phải mang trusted `(tenant_id, connector_id, account_id)` binding; nếu schema/source hiện tại chưa mang đủ binding thì đó là implementation gap, không được suy tenant/account từ request hay ref do caller gửi.

Hiện trạng: Admin shell đăng nhập bằng một `adminToken` tĩnh rồi ký cookie chỉ chứa role (`services/orchestrator/src/app/admin/shell-router.ts:781-840`); Admin JSON API cũng chỉ so bearer tĩnh (`services/orchestrator/src/server.ts:817-827`). Connector nhận `credentialRef` dạng chuỗi và đọc `secret_versions` mã hóa AES-GCM trong DB (`services/connector/src/services.ts:70-72`, `:127-130`; `src/db/repository.ts:242-256`). Admin shell có UI API-key/Connector nhưng nhiều fetcher đang chờ API thật (`tasks/P6-admin.md`, P6-04/05); không coi renderer/test fixture là hoàn thành luồng quản trị.

Wire contract: producer/writer phải phát `CredentialSource = { kind: 'vault-kv2', account, mount, path, key, version } | { kind: 'legacy-db', credentialRef }`; `vault-kv2` là discriminator canonical cho mọi write. Reader phải tiếp tục chấp nhận alias cũ `{ kind: 'vault-kv-v2', ... }` và chuẩn hóa nó thành `vault-kv2` khi parse; producer không được phát alias. `account` phải bằng account ID trong trusted revision binding. `path` là đường dẫn secret **bên trong mount**, `key` là field của payload, `version` là KV v2 version đã pin; không ghép tùy tiện cả `/data/` vào cấu hình. Với KV v2, API đọc là `GET /v1/{mount}/data/{path}?version=N` và giá trị nằm trong `data.data[key]`; API ghi dùng CAS để tránh ghi đè ngoài ý muốn ([Vault KV v2 API](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2)). Metadata ref/version được lưu, plaintext secret không lưu trong DB, manifest, grant, queue, audit hoặc response GET.

### SEC-00 — Chốt ADR và ranh giới tin cậy

- **Xử lý:** theo ADR-17, cấu hình deployment chốt IdP issuer/client/redirect URI, public Admin origin và reverse proxy cho shell listener riêng, nhóm claim → `admin/operator/viewer`, tenant mapping, chính sách local admin-token migration/break-glass, provider credential slot, Vault KV v2 mount, account path, version pin và rollback/revoke. OIDC client secret được inject qua deploy secret file, không lấy từ provider-credential path.
- **Kết quả:** ADR và schema JSON contract, ma trận quyền cho Browser → Admin shell → Admin API → Vault writer và Connector → Vault reader; ghi rõ `vault-kv2` canonical / `vault-kv-v2` read alias và account-prefix check; không để `account`, `mount`, `path` hay `key` đến từ invocation body/worker.
- **Acceptance:** không còn nhập nhằng hai loại API key; Product/platform/security ký các cấu hình deployment còn lại; contract có ví dụ canonical ref, legacy read alias, rotation, emergency revoke và quy tắc khi OIDC/Vault không khả dụng. Không bật OIDC/Vault trước owner sign-off và contract freeze.

### SEC-01 — Cấu hình và client OIDC trong Orchestrator

- **Phụ thuộc:** SEC-00. **Owner:** platform/auth.
- **Xử lý:** thêm cấu hình `issuer`, `clientId`, client-secret reference, exact callback URL, allowed return paths và allowed signing algorithms; discovery/JWKS chỉ từ issuer cấu hình, cache/refresh có timeout và TLS validation. Bỏ hardcode `role:<role>:<adminToken>` khỏi luồng production, giữ local mode chỉ theo ADR. Dùng Authorization Code + PKCE; sinh `state` và `nonce` một lần cho mỗi login, kiểm tra và tiêu thụ một lần ở callback; kiểm tra ID token signature, `iss`, `aud`, `exp`, `iat`, `nonce`, algorithm.
- **Acceptance/test:** fake IdP với callback hợp lệ đăng nhập được; sai issuer/audience/signature/nonce, state cũ hoặc replay, redirect URI lệch và discovery/JWKS lỗi đều fail closed, không mint session. Không dùng implicit flow hoặc access token làm bằng chứng đăng nhập. Cơ sở: [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html), [OAuth Security BCP / PKCE và redirect](https://datatracker.ietf.org/doc/html/rfc9700).

### SEC-02 — Session, logout và RBAC Admin thực sự

- **Phụ thuộc:** SEC-01. **Owner:** platform + Admin UI.
- **Xử lý:** thay cookie tự chứa role bằng opaque session ID có TTL/revoke trong kho dùng chung giữa replicas (Redis hoặc DB), lưu `issuer+sub`, tenant và role đã map server-side; default deny nếu group/tenant chưa map. Cookie `HttpOnly`, `Secure` khi HTTPS, `SameSite=Lax` phù hợp redirect từ IdP, rotation sau login, timeout/idle expiry; logout thu hồi session. Chặn open redirect, dùng CSRF token thực cho mọi mutation cookie-auth. Admin shell không đưa bearer nội bộ/Vault token xuống trình duyệt.
- **API boundary:** chọn và hiện thực đúng **một** đường BFF/same-origin rõ ràng. Nếu shell gọi Admin JSON API bằng service credential, API phải kiểm tra principal/role/tenant được ủy quyền và audit actor, không chỉ tin việc ẩn nút trong HTML; không nhận principal qua header tự khai do browser gửi. Public `x-api-key` và runtime service identity giữ nguyên.
- **Acceptance/test:** login/logout/expire/revoke qua hai replicas; direct HTTP kiểm toàn bộ role×action×tenant matrix SEC-00: viewer không mutate, operator chỉ có actions được duyệt, admin-only credential/key actions bị chặn cho operator. CSRF/cross-tenant bị chặn; audit có actor, không token. Kiểm callback bằng browser thật.

### SEC-03 — Contract và lưu metadata Vault ref

- **Phụ thuộc:** SEC-00. **Owner:** contracts + platform + Connector.
- **Xử lý:** tạo typed `VaultKv2Ref` (`account`, `mount`, `path`, `key`, `version`) trong contract/revision. Revision lưu binding tin cậy `(tenant_id, connector_id, account_id)`; `ref.account` phải bằng `revision.account_id`, còn `ref.path` phải bằng chính xác `du/tenants/{tenant_id}/connectors/{connector_id}/accounts/{account_id}` sau khi parse path segment, không dùng phép so chuỗi prefix thiếu ranh giới segment. Allowlist mount; reject URL tùy ý, `..`, empty segment, encoded separator, metadata endpoint và mọi binding/path mismatch trước persist. Migration thêm `credential_source`/status/version/account binding cho connector revision và giữ explicit `legacy-db` cho bản cũ; không nhét secret hay Vault token vào `credentialRef` chuỗi. Reject credential-bearing `config.headers` trước khi JSONB persist; response redaction không thay thế write-time validation.
- **Acceptance/test:** cùng một revision/ref được truyền Orchestrator → Connector không drift; ref của tenant A không bind vào tenant B; mismatch tenant, connector, account hoặc path segment bị reject; round-trip migration đọc được legacy revision; mọi producer ghi `vault-kv2`, reader nhận và canonicalize alias `vault-kv-v2`; JSON/log redaction loại plaintext và token. Không đổi định dạng `credentialRef` của dữ liệu cũ bằng heuristic âm thầm.

### SEC-04 — Admin API/UI cấu hình API key và ghi Vault tại Orchestrator

- **Phụ thuộc:** SEC-02/03. **Owner:** platform + Admin UI.
- **Xử lý:** bổ sung Admin API tạo/đổi/kiểm tra metadata credential provider theo connector (body write-only chứa `mount/path/key` và secret một lần; account/tenant lấy từ trusted Admin principal và binding server-side, không tin body; response chỉ trả ref/version/masked state); RBAC admin, tenant scope, CSRF qua shell, audit không chứa giá trị. Vault writer dùng machine identity riêng (Kubernetes auth khi chạy K8s; AppRole/đường tương đương khi self-hosted), TLS và policy `create/update` chỉ trên tenant/account prefix được cấp; không dùng root token. Ghi KV v2 với CAS vào path derive từ binding tin cậy, lưu version trả về; tạo connector revision mới để pin source với `kind: 'vault-kv2'` rồi activate qua workflow idempotent. Nếu Vault ghi thành công nhưng DB/Connector update lỗi, giữ `PENDING` và reconcile/rollback rõ ràng, không mở provider call bằng ref nửa chừng. Nối form cấu hình Connector P6-04 với API thật và hiển thị path/key/version/masked state, không hiển thị lại secret; P6-05 là tenant API key, ngoài phạm vi Vault provider credential.
- **Acceptance/test:** admin hợp lệ tạo và rotate được, request lặp không nhân đôi revision; viewer/operator, tenant sai, path ngoài prefix, CAS conflict, Vault timeout/403 đều fail closed; GET/list/audit/HTML không chứa raw key. Dùng Vault dev fixture cho luồng thực, không chỉ mock renderer.

### SEC-05 — Vault reader trong Connector theo `path` + `key`

- **Phụ thuộc:** SEC-03/04. **Owner:** Connector.
- **Xử lý:** `SecretResolver` abstraction đọc `legacy-db`, canonical `vault-kv2` và compatibility alias `vault-kv-v2` (normalize alias về canonical); mọi producer/write chỉ phát `vault-kv2`. Connector dùng machine identity **read-only** riêng, Vault policy chỉ cho tenant/account prefix được cấp. Sau khi xác thực invocation grant và load revision binding tin cậy, trước mọi Vault request Connector phải xác minh grant tenant/connector trùng revision, `ref.account === revision.account_id`, và `ref.path` bằng path canonical `du/tenants/{tenant_id}/connectors/{connector_id}/accounts/{account_id}`. Không lấy `account`, `mount`, `path` hay `key` từ invocation body/worker; mismatch bị từ chối trước Vault read. Khi binding hợp lệ, chỉ đọc đúng `mount/path/version`, lấy `data.data[key]`; kiểm tra field là chuỗi không rỗng, secret version chưa deleted/destroyed. Chỉ đưa giá trị vào provider credential slot đã duyệt trong phạm vi invocation (không hardcode Bearer cho mọi adapter); không trả qua Connector API, không persist ledger/usage, không log. Timeout ngắn hơn provider deadline, xử lý token expiry/renewal và TLS; mặc định không cache plaintext, hoặc cache TTL ngắn theo exact version với invalidation/revoke đã chứng minh.
- **Lỗi:** thiếu path/key, version bị revoke/deleted, sai policy → `CREDENTIAL_INVALID`/fail closed, **không** gọi provider; Vault 5xx/network/timeout → lỗi tạm thời retryable với bound, không tự fallback sang secret DB cũ. `test(connectorId)` phải kiểm tra được ref/khả năng đọc thật thay vì chỉ kiểm tra adapter (`services/connector/src/services.ts:135-145`).
- **Acceptance/test:** mock Vault và Vault dev thật chứng minh đúng key/path/pinned version; grant/revision/ref tenant, connector, account mismatch, sibling-prefix/path traversal đều bị từ chối với Vault read count 0 và provider call count 0; đúng binding mới đọc được. Kiểm tra read identity bị deny ngoài tenant/account policy prefix, không provider call khi Vault lỗi, không plaintext trong response/log; two-replica test đọc cùng ref và giữ scope. Connector `/connectors/:id/test` kiểm tra secret ref và quyền đọc thật, không chỉ trả pass vì adapter ACTIVE; Orchestrator health probe vẫn là phép thử khác.

### SEC-06 — Rotation, migration và rollback không drift

- **Phụ thuộc:** SEC-04/05. **Owner:** platform + Connector + operations.
- **Xử lý:** workflow `PENDING → ACTIVE → RETIRED`: cập nhật secret bằng CAS tạo Vault version mới và connector revision mới; submission mới pin revision mới, operation đang chạy giữ revision/version cũ theo policy. Emergency revoke chặn version/ref cũ theo quyết định SEC-00; phân biệt revoke trong app với Vault soft-delete/destroy. Chuyển legacy AES-GCM `secret_versions` từng connector bằng thao tác đặc quyền, xác nhận round-trip và audit trước khi disable đường cũ; không bật fallback khi Vault down. Giữ công cụ rollback revision khi secret cũ còn hợp lệ, không tự động expose plaintext.
- **Acceptance/test:** concurrent rotations/CAS conflict; in-flight invocation dùng version cũ hoặc bị chặn đúng policy; Vault outage không quay lại DB; migration từng phần, restart giữa chừng, rollback và cleanup orphan `PENDING` đều có test.

### SEC-07 — Tích hợp, vận hành và gate bảo mật

- **Phụ thuộc:** SEC-01..06. **Owner:** P8/test + platform + Connector.
- **Xử lý:** compose/test Vault + fake OIDC provider, Vault policies tách writer/read-only, env mẫu **không chứa token thật**, runbook bootstrap auth method/policy/role, unseal/outage/rotation/revoke, metrics không gắn secret/path nhạy cảm, readiness báo degradation đúng. Cập nhật OpenAPI và tài liệu auth boundary; thử luồng browser login → cấu hình secret → connector test → invocation thật bằng mock provider → rotate → revoke.
- **Acceptance gate:** test unit, API integration, multi-container và security negative matrix đều pass; kiểm tra raw provider key/Vault token không xuất hiện trong PostgreSQL, Redis/job, response, logs, traces hay HTML; test phân quyền writer không đọc được secret và reader không ghi được. Không tự tick P6/G4 hoặc P8/G6 từ test mock đơn lẻ.

## Nhật ký packet SEC lane — trạng thái theo phạm vi (2026-09-26)

Reviewer Codex-3 **Turn 60** ([independent audit](../coordination/reports/review.md)) và **Turn 70** (re-validation) phán quyết đúng **một** packet của lane này đủ bằng chứng sống: `W-SEC-RBAC-SYNC-1` ở phạm vi matrix OIDC-03. Ghi ở đây là **packet-level acceptance**, không phải tick dòng task, và **không** đóng gate nào. Các packet dưới đây là bằng chứng offline **do lane tự ký**, chưa được adjudicate — đọc cùng để không nhầm mức.

| Packet | Kết luận | Phạm vi | Lệnh + môi trường | Receipt |
|---|---|---|---|---|
| W-SEC-RBAC-SYNC-1 | **ACCEPTED** (Turn 60; Turn 70 xác nhận lại) | Đồng bộ 3 cell live M2/M3/M5 của suite OIDC-03 sang envelope ADM-UX-02 | `pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts`, **PostgreSQL localhost:5433/du_orchestrator_test** + **Redis localhost:6380**, `DU_LIVE_INFRA=1`, HEAD `7811298`, literal ExitCode `0` | [T-CODEX-TEST-20](../coordination/reports/tester.md) — **12/12 pass**; log thô [T-CODEX-TEST-20-live-reval.log](../coordination/reports/T-CODEX-TEST-20-live-reval.log) — **file cục bộ, `*.log` nằm trong `du-rework/.gitignore` nên không portable sang clone mới**; lane: [qwen-sec.md §6](../coordination/reports/qwen-sec.md) |
| W-SEC-CLAIM-ASSERT-1 | VERIFIED-OFFLINE (chưa adjudicate) + **1 production tightening chờ quyết (Δ13)** | Contract assertion shape claim giữa browser `roleFor` và bearer `mapOidcClaimsToPrincipal` ở `@du/contracts` | offline; contracts 14 test ×3, orchestrator 10 suite ×3, lint/build exit 0, có negative control | [qwen-sec.md §5](../coordination/reports/qwen-sec.md) |
| W-OIDC04-FLOW-1 | VERIFIED-OFFLINE | Seam claim → session → gate qua id_token xác thực thật (11 test) | loopback IdP + RSA thật; **không** có browser driver | [qwen-sec.md §4](../coordination/reports/qwen-sec.md) |
| W-ADMBASE03-ERR-1 | VERIFIED-OFFLINE | Browser-tier 500 boundary có `code` + `correlationId`; sentinel 21 test | offline | [qwen-sec.md §3](../coordination/reports/qwen-sec.md) |
| W-OIDC03-RBAC-1 | VERIFIED-OFFLINE | `assertRoleActionTenant` (auth → table → CSRF → role → tenant) + 13 test | offline | [qwen-sec.md §2](../coordination/reports/qwen-sec.md) |
| W-OIDC02-REPLICA-1 | VERIFIED-OFFLINE | Offline revoke/restart/expiry giữa replica (5 test) | offline; 7 live legs vẫn chờ cửa sổ Tester | [qwen-sec.md §1](../coordination/reports/qwen-sec.md) |

### Bốn giới hạn của diện ACCEPTED — phải đọc kèm, không suy rộng

1. **Chỉ đúng 12 cell đó.** D1–D4, M1–M6, X1–X2 trên envelope chuẩn hoá. Không suy ra OIDC-04, Vault, SEC-INT-01/02, SEC-00 hay `G-SEC`.
2. **12 cell KHÔNG chạm tới mapper claim → principal.** Chúng xác thực bằng static `adminToken` / `tenantAdminTokens` (`resolveAdminPrincipal` trong `modules/admin-actions/rbac.ts`), không phải id_token. Nên nhánh `mapOidcClaimsToPrincipal` — kể cả phần siết Δ13 của `W-SEC-CLAIM-ASSERT-1` — **chỉ có bằng chứng offline**, chưa từng được matrix sống nào chạm tới. Đừng đọc dòng OIDC-03 `[~]` là đã live-verify claim path.
3. **Receipt 9/12 cũ không bị xoá.** T-CODEX-TEST-19 (M2/M3/M5 đỏ vì đọc `rows`) bị **thay** cho đúng suite này bởi T-CODEX-TEST-20, nhưng giữ làm lịch sử chẩn đoán.
4. **OIDC-03 mới `[~]`, chưa `[x]`.** Còn: SEC-00 sign-off (dependency của cả nhánh), OIDC-04 browser evidence, SEC-INT-01. Turn 70 yêu cầu **không chạy lại** 12 cell trừ khi build identity hoặc contract đổi.

## Checklist bàn giao cho Tester — browser OIDC-04 (đề xuất, chưa chạy)

> Soạn bởi lane Qwen-SEC theo mục 5 của packet W-SEC-STATUS-SYNC-1. **Đây là đề xuất kịch bản, không phải kết quả**: lane không mở DB window, không chạy browser. Mọi dòng PASS bên dưới do Tester ghi kèm ảnh + exit code. Mọi selector/route/wording dưới đây đã **đối chiếu source hiện tại** (không bịa) — neo nêu kèm file.

**B0. Điều kiện tiền đề (thiếu thì dừng, báo blocker)**
- [ ] Chạy trên build hiện tại; ghi build ID/commit + cwd + lệnh khởi động; CLAIM/RELEASE DB window đúng nghi thức (PG :5433, Redis :6380, `DU_LIVE_INFRA=1`).
- [ ] Dùng **fake IdP fixture của OIDC-01** trên loopback, KHÔNG dùng IdP thật và KHÔNG dùng catalog/fixture dữ liệu cũ.
- [ ] Public origin cố định của shell; **không** lấy base URL từ query string.
- [ ] Chuỗi sentinel (vd `SENTINEL-<random>`) đặt vào IdP subject/tenant để dò rò secret ra URL, DOM, log, trace.

**B1. Login redirect + PKCE — neo: `GET /admin/login`, `handleLogin` (`src/app/admin/oidc-flow.ts`)**
- [ ] `GET /admin/login` → **302** sang `authorization_endpoint` của IdP, mang `response_type=code`, `code_challenge_method=S256`, `state` và `nonce` **khác nhau**.
- [ ] **Không** có `code_verifier` trên URL, không có token/id_token trong URL, Referer hay lịch sử.
- [ ] Hai lần login liên tiếp cho `state` khác nhau (chống replay).

**B2. Callback + cookie minting — neo: `GET /admin/oidc/callback`, `handleCallback`, `buildSessionCookie`**
- [ ] Callback hợp lệ → **302** về `returnTo` (mặc định `/admin`) kèm `Set-Cookie: du_session=<43 ký tự [A-Za-z0-9_-]>`; cookie có **HttpOnly** + **SameSite=Lax** (thêm **Secure** nếu origin là https).
- [ ] Sau khi vào shell, `span.admin-shell__role[data-role]` hiện đúng `Role: admin|operator|viewer` (anchor `src/app/admin/shell-render.ts:337`). **Đây mới là bằng chứng mint thật** — chỉ quan sát 302 là chưa đủ.
- [ ] Callback độc hại (state lạ / state dùng lại / hết hạn / thiếu code / có `error` từ IdP) → **một** shape 403 duy nhất, không set cookie, thân trang không lộ chi tiết.

**B3. Role × action × tenant + CSRF từ trình duyệt (neo: dòng OIDC-03 ở file này; wording từ `dispatcher.ts`)**
- [ ] Operator **tenant A**: cancel operation của A → 200 và **state đổi thật trong DB**; cùng thao tác lên operation của B → 404 (không rò tồn tại).
- [ ] Viewer: mọi mutation bị 403, wording `session role is not permitted for this action`; `GET /admin` vẫn 200 (đọc được, không sửa được).
- [ ] CSRF: mutation **không** kèm token và kèm token sai → 403 với wording `cookie-authenticated admin actions require a valid CSRF token`.
- [ ] `apikey.bind-profile` (admin-only) với operator → 403.

**B4. Logout / revoke — neo: `POST /admin/logout`, `form.admin-shell__logout` (`shell-render.ts:340`)**
- [ ] Logout là **form POST**: bấm `form[action="/admin/logout"] button[type=submit]`. Dùng `GET /admin/logout` phải **405** — nếu 200 thì route đã lệch.
- [ ] Sau logout: 302 về `/admin/login` + cookie bị xoá; cùng profile trình duyệt truy cập `/admin` → 302 với cookie cũ đã dọn, **không** trả 401/403 thô (`shell-router.ts:196`).
- [ ] **Chứng minh phía server**: lấy sid cũ, gọi lại API bằng sid đó ngoài browser → phải chết (302), tức session bị hủy thật chứ không chỉ xoá cookie.

**B5. Vòng đời session (neo: `oidc02-process-replicas-offline.test.ts`, `session-store.ts`)**
- [ ] Rotate session sau login; idle TTL và **absolute deadline** quan sát được trong browser; hết hạn thì bounce về `/admin/login` chứ không phục vụ trang lỗi.
- [ ] Revoke theo principal (nuclear) làm mọi phiên của principal đó chết **trên cả hai replica**, xác nhận qua browser trước và sau khi restart một replica.

**Cảnh báo quan trọng khi viết test (đã kiểm tra source):** hệ thống **không có** grant `refresh_token` — grep `refresh_token`/`refreshToken` trong `services/orchestrator/src` cho **0 kết quả**. Đừng viết scenario đòi response có `refresh_token`. Cải mới trong luồng = xoay vòng/TTL/hạn của session opaque, và revoke bằng logout hoặc `revokePrincipal`.

> **Không suy ra OIDC-04 xong khi B0–B5 xanh**, và **không** tick `G-SEC`: còn SEC-00 sign-off, nhánh Vault live chain (migration 008 + policy writer/reader + rotation/revoke/reconcile) và SEC-INT-01/02. Lane Qwen-SEC không tự tick.


## Thứ tự giao việc

1. **ADM-BASE-01/03** là lỗi tích hợp/bảo mật hiện hữu, có thể sửa ngay. **SEC-00** là cổng bắt buộc trước OIDC-01 và VAULT-01; sau ADR, hai nhánh feature có thể chạy song song.
2. **ADM-BASE-02 plumbing** xây sau ADM-BASE-01 với trusted test principal; **OIDC-02/03** là điều kiện bật mutation/đóng dispatcher acceptance và VAULT-03 Admin write API. **VAULT-02/05 unit** xây sau contract; VAULT-05 integration dùng revision thật từ VAULT-03.
3. **OIDC-04 + VAULT-04** chỉ nhận khi shell đọc API thật và POST thực sự đổi state; **VAULT-06** chỉ bắt đầu khi write/read path đã có test.
4. **SEC-INT-01/02** chạy verification theo từng lát, nhưng chỉ đóng sau full-flow, fault/security matrix và evidence trên build mới. Các nhóm SEC-01..07 phía trên không được tick riêng ngoài backlog 16 dòng.

Tài liệu tham chiếu: [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html), [OAuth 2.0 Security BCP](https://datatracker.ietf.org/doc/html/rfc9700), [Vault KV v2 API](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2), [Vault policies](https://developer.hashicorp.com/vault/docs/concepts/policies), [Vault Kubernetes auth](https://developer.hashicorp.com/vault/docs/auth/kubernetes), [Vault AppRole auth](https://developer.hashicorp.com/vault/docs/auth/approle).
