# QWEN-1 — Backend/Platform lane (R2-A: Admin audit atomicity + tenant authorization)

> [!IMPORTANT]
> **RESUME POINT — 2026-09-25 ~04:10 +07.** Đọc khối này là tiếp tục được, khỏi đọc transcript.
> Lane nhận bàn giao từ Claude Code (đã đóng). **W49-QW1-1 (R2-A: R3-01/R3-02) ĐÃ CHỐT** — live
> 115/115 exit 0, receipts mục 3 + 1b-closing. **W49-QW1-2 (MM-05 re-arm + queueIntegrity health):
> code XONG, offline XANH** (sweep 8/8 exit 0, probe Qwen-2 4/4 không đụng, build exit 0) — xem
> §W49-QW1-2 cuối file. **Chưa làm (cần DB window, KHÔNG thuộc lượt này):** drill live MM-05d +
> flip p8-02b MM-05c (Tester) và re-check `runtime.test.ts` health keys live (offline nó vẫn xanh
> vì `queueIntegrity` vắng mặt khi `autoDispatch:false`). Hạ tầng :5433/:6380 ĐANG UP do tiến trình
> khác dựng (~04:0x) — tôi không cầm window, không sửa, **không teardown** (chỉ lệnh cycle 78).
> **W49-QW1-3 (Idempotency admin POST): XONG — offline 14/14, lint 0.** **W49-QW1-4
> (ADM-BASE-02: principal/tenant enforcement trên MỌI admin route mang tenant): XONG —
> scope test 19/19, toàn cây test:unit 21/22 suites & 779/780 tests** (red duy nhất =
> flaky loopback, chạy đơn lẻ 56/56 xanh; boundary suite của qwen3 đã TỰ ĐẢO XANH vì
> lane đó lên source-fix). Xem §W49-QW1-4 cuối file. Không commit/push.
> **W49-QW1-5 (HOTFIX cycle 84): collision 0011 ĐÃ SỬA — file tôi thành 0012, runner giờ
> reject prefix trùng + verify so filename; guard test 6/6; Tester xem HƯỚNG DẪN RE-RUN Round 7
> (§W49-QW1-5, DB cũ có thể cần 1 câu DELETE ledger).**
> **W49-QW1-13 (cycle 99): X2 no-echo 404 (lifecycle) + resume atomic (client vào
> resumeOperation) — offline 63/63, lint 0, build 0; `W48-QW1-LIVE-006` đã nộp (kỳ vọng 12/12).**
> **W49-QW1-12 (cycle 98): OIDC-04 login/callback/logout flow — offline 7/7, lint 0, build 0;
> unit toàn cây CHỐT 36/37 & 962/962 (đỏ duy nhất = connector-revision-http lane khác, compile
> fail — quy kết coordinator).**
> **W49-QW1-14 (cycle 100): OIDC-04 MOUNT vào Admin Shell router — dispatchShellRequestAsync
> intercept /admin/login (GET+POST), /admin/oidc/callback, /admin/logout (clear ca 2 cookie);
> mount test 6/6 offline; regression khong-flow giu nguyen; lint 0; build 0; unit toan cay
> 38/40 & 1012/1016 (4 fail = class flaky loopback, chay don lẻ 93/93 xanh).**
> **W49-QW1-16 (cycle 102): MOCK OIDC IdP in-process (discovery, JWKS RS256+ES256, authorize
> PKCE S256 bat buoc, token verify code/verifier/redirect, revoke+introspect) + client ES256 —
> 10/10 & 33/33 offline exit 0, khong hoi quy 5 case hostile cu. BUILD/unit gate TAM do vi
> file lane R1-A (artifacts/integrity-scanner) dang sua do — KHONG sua ho; cho ho chot.**
> **W49-QW1-18 (cycle 103): E2E OIDC-04 HARNESS — `tests/admin-shell-oidc-flow-integration.test.ts`
> noi shell router + OidcClient THAT + mock IdP cycle 102 qua loopback HTTP that: (1) login 302
> -> /authorize PKCE S256, binding chung bang b64u(sha256(verifier server-side)); (2) code
> exchange tai /token, id_token RS256+ES256 verify qua JWKS phuc vu; (3) callback mint
> du_session (HttpOnly/SameSite=Lax/Path=/, session record = claims da verify); (4) GET /admin
> voi cookie -> 200 trang Admin (khong round-trip IdP nua). Kem replayed-code 403 + unknown-state
> 403 + anonymous gate baseline. 7/7 exit 0; ca OIDC family 7 suites 80/80 exit 0; lint 0.
> KHONG dong gop src; KHONG DB window; khong commit/push.**
> **W49-QW1-19 (cycle 108-113, KHAN): 2 finding reviewer da CHOT. (1) rbac.ts —
> resolveAdminActionAuthAsync dao thu tu: bearer -> du_session (store plane) ->
> legacy du_admin; session CHET/fa khong duoc 'hoi sinh' bang legacy cookie;
> AdminActionCookieAuth.them tenantId tu store, dispatcher cho phep role 'operator'
> cookie CHI khi co tenant server-side (cancel/resume), fail-closed 403 khong tenant;
> principalOf: operator+tenant -> tenant_operator (fence dung tenant cua session).
> sessionToActionAuth cung mang tenantId. (2) main.ts wire DU_ADMIN_OIDC_* (ten cua
> runbook vault-oidc-operations.md) qua module moi src/app/admin/oidc-boot.ts:
> thieu hoan toan -> null (plane tat); partial -> TU CHOI BOOT; secret-file tren het;
> PKCE chi S256. Receipts: targeted 12 suites 189/190 (1 fail = ETIMEDOUT storm,
> re-run don le 7/7 exit 0); full tree 46/48 & 1117/1126 (9 fail = class bao port
> 64xxx cua admin-shell-server/platform-mount, khong thuoc mien toi sua); lint 0;
> build 0. Khong DB window, khong commit/push, khong tick row.**
> **W49-QW1-20 (orchestrator request — persistent session store): OIDC-02 READY OFFLINE.
> Module moi `src/modules/auth/redis-session-repository.ts`: SessionRepository nam sau
> gateway seam 7 lenh (get/set+EX/del/sadd/srem/smembers/expire), key layout
> `du:admin:sess:s:<id>` + index `du:admin:sess:p:<sha256(iss|sub)>`; TTL = con lai tuyet
> doi (idle touch khong bao gio moi duoc gia han); parse fail-closed (payload hong ==
> khong co, id khong khớp key == hong); revokePrincipal chi DEL id qua shape-gate (index
> nhiễm doc khong cham duoc key la); adapter ioredis KET NOI RIENG (khong share voi
> BullMQ), enableOfflineQueue:false + maxRetriesPerRequest:1 => Redis outage FAIL CLOSED.
> `oidc-boot` + env `DU_ADMIN_OIDC_SESSION_BACKEND=memory|redis` (memory = mac dinh/fallback
> test; redis = yeuc REDIS_URL, khong im lang downgrade); main.ts shutdown dong ket noi SAU
> app.close(). Receipts: repo 12/12 + boot 11/11 offline (fake gateway in-process, khong
> socket Redis nao); targeted 13 suites 205/206 (1 = storm ETIMEDOUT, solo 10/10); full tree
> 1137/1142 (5 fail ETIMEDOUT class, oidc-boot suite xanh cung batch); lint 0; build 0.
> CHUA lam (can dispatch + window): live 2-replica qua Redis that + Redis GETDEL cho
> challenge store. Khong DB window, khong commit/push, khong tick row.**
> **W49-QW1-21 (orchestrator request 121+): REDIS PERSISTENT PLANE HOAN CHINH. (a)
> `createRedisChallengeStore` (cung module): state->PKCE challenge nang Redis, key
> sha256(state) (login secret khong bao gio ten hoa trong keyspace), EX=con lai TTL,
> consume = GETDEL nguyen tu (mot winner cross-replica; gateway seam them getdel
> bat buoc — Redis <6.2 fail vi khong co GETDEL la fail-closed co chu dich, khong
> race), payload doc lai phai qua shape-gate + returnTo allowlist (Redis bi nhiem doc
> khong the sinh open-redirect trong Location). (b) oidc-boot AUTO-DETECT: REDIS_URL
> co + khong backend env => 'redis' (ca sessions + challenges); explicit 'memory'
> van giu per-process; khong duong nao im lang degrade. (c) Codex-4 giu nguyen
> (Partial<RedisOptions> fix). Receipts: targeted 13 suites 215/215 exit 0 (lan dau ca cycle khong flake); FULL TREE XANH TUYET DOI 49/49 & 1151/1151 exit 0; lint 0;
> build 0. Van con (can dispatch + window): live drill Redis that hai replica.**
> **W49-QW1-25 (cycle 126+, Reviewer Finding 3 HIGH): MULTI-REPLICA SCENARIO PACK —
> `tests/oidc02-multi-replica-offline.test.ts`: SHARE (mint A -> dispatcher resolver
> tren B ra role+tenant+CSRF that), REVOKE (revokePrincipal cross-replica + ton tai qua
> restart + khong blacklist principal), EXPIRY (absolute khong gia han boi activity,
> idle truot cross-replica qua lastSeenAt CHUNG, Redis-native TTL tu don khi khong ai
> doc), LOAD BALANCER (4 replica xoay vong — ONE key, destroy 1 chet 4). Tich hop
> oidc-boot/REDIS_URL da co (grep xac nhan nguyen ven, khong code lai). TESTER-1 GUARD:
> block DU_LIVE_INFRA=1 (+REDIS_URL) chay Y het scenario tren Redis THAT — offline
> describe.skip, ZERO socket, khong cham 5433/6380; keyPrefix random-per-run + cleanup
> explicit DEL, khong FLUSHDB/SCAN. Receipts: pack 9/9 + 3 skipped exit 0; OIDC-02
> family 6 suites 123 passed/3 skipped exit 0; npx tsc --noEmit 0; build 0; full tree
> run-2 47/50 & 1155/1163 — 5 fail CON LAI deu class storm 59xxx (webhook-boundary
> fail-ca-nhan trong tree = collateral fetch loopback timeout, solo 32/32 exit 0).
> Khong DB window, khong commit/push, khong tick row.**
> **W49-QW1-27 (cycle 138, Reviewer audit 132-137): OIDC-02 SEPARATE-PROCESS HARNESS —
> fixture `tests/fixtures/oidc02-replica-harness.ts` (replica = component graph HOAN
> TOAN MOI nhu oidc-boot build per process; share DUY NHAT gateway+IdP; SEC-00 plane
> constants; helpers browser-shaped qua router that; live-extension contract 5 buoc
> child-process cho Tester-1 ghi thang trong file) + suite
> `tests/oidc02-process-replicas-offline.test.ts` 6/6 exit 0 LAN DAU: callback hoan
> thanh o replica KHAC phuc vu ca 2 router; logout cookie o A giết o B; rotate
> cross-process; restart giu phien song + revoke chet vinh vien; expiry ABSOLUTE/IDLE
> tren dong ho that lan toan cluster qua lastSeenAt CHUNG. FIXTURE khong match
> testMatch nao → khong the pha suite cu (da chay lai 8 suite lang gieng: 91 pass/3
> skip + 1 flake boot ETIMEDOUT, solo 14/14 exit 0). tsc/lint/build 0. Khong DB
> window, khong cham 5433/6380, khong commit/push, khong tick row.**
> **W49-QW1-28 (cycle 138 tiep): LIVE 2-PROCESS BLOCK — `tests/fixtures/oidc02-replica-probe.js`
> (moi process = 1 replica that, router production tu dist, gateway that
> `createIoredisSessionGateway(REDIS_URL)`, keyPrefix per-run, `/__probe/*` chan bang token,
> handshake `LISTENING <port>`, SIGTERM sach) + block gated
> `DU_LIVE_INFRA==='1'` trong `oidc02-process-replicas-offline.test.ts`: 4 scenario
> mint/resolve A→B, logout cross-process, rotation cross-process, idle-expiry dong ho that
> tren 2 CON NODE TIENG. Offline: 4 skipped, ZERO child/Redis/handle — 6/6 pass, jest tho
> sach; probe smoke-tested qua sink `127.0.0.1:9` (500 fail-closed + 200 control = code
> chay that, van offline); pair 19/19+7 skip; TSC_OK/LINT_OK/BUILD_OK. Tester-1 runbook in
> trong block. Lane khong cham 5433/6380; khong commit/push; khong tick row.**
> **W49-QW1-33 (Reviewer audit 150-155): block DU_LIVE_INFRA du 6 CA — them live nuclear-revoke
> cross-process (probe /__probe/revoke da co tu 138b, chi them consumer; count >=2 LA LOWER BOUND
> vi revokePrincipal dem key DEL that) + live RESTART child thu ba that cung Redis/runTag (serve
> survivor mint truoc khi no ton tai; revoke thuc thi boi child moi giet ca session no khong mint;
> SIGTERM+waitForExit trong finally). Zero src/ sua. Offline 6 pass/6 skip/12 total exit 0 sach
> handle; TSC_OK/LINT_OK. docs/29 LIVE-001: literal moi `Tests: 12 passed, 12 total`, lenh Tester
> khong doi. Tester-1 re-run lay 12/12. Khong commit/push, khong tick row.**
> **W49-QW1-15 (cycle 101): SESSION LIFECYCLE HARDENING — gate du_session moi route protected
> (live -> claims inject; expired/revoked/forged/anonymous -> graceful 302 /admin/login + quet
> cookie da); da-login GET /admin/login -> 302 /admin; favicon + du_admin legacy passthrough
> khong doi; nut Sign-out san co + SSO login = redirect chain. lifecycle 10/10, mount/router
> regression xanh, lint 0, build 0, unit toan cay 41/43 & 1044/1057 (2 do = flaky loopback,
> retry don le 56/56 + 93/93).**
> **W49-QW1-6: (a) ADM-BASE-02 action dispatcher + CSRF/cookie gate + RBAC matrix — offline
> 26/26 exit 0, lint 0; (b) HOTFIX cycle 85: MM-05 re-arm CAS precision bug (PG microsecond vs JS
> millisecond) — `date_trunc('millisecond')` hai phía, sweep 8/8, BUILD XONG, Tester re-run Round 7
> (rearm-1) ngay được trên dist hiện tại.**
> **W49-QW1-7 (cycle 88): LIVE HTTP matrix 10 ô ĐÃ VIẾT + compile-verify 0 lỗi
> (`tests/admin-action-rbac-live.test.ts`, excluded khỏi unit gate, chạy 1 mình trong window);
> OIDC-03 seam `mapOidcClaimsToPrincipal` default-deny — dispatcher suite 30/30, unit toàn cây
> 24/25 (828/829, đỏ = flaky loopback), build 0.** Tester cần DB window dispatch cho:
> live matrix + Round 7 rearm-1 + các phần live §4.4/§W49-QW1-6.A.
> **W49-QW1-8 (cycle 91): (a) suite live đã SỬA theo feedback round-1 (D2 assert `title` —
> HttpError.message nằm ở `title` của problem(), không phải `detail`; M-group thêm CONTROL_BIZ
> `is_active=true` + cleanup theo FK order) — compile 0 lỗi, Tester re-run ngay;
> (b) SEC-01 `src/modules/auth/oidc-client.ts` (RS256-only, discovery+JWKS TTL/rotation
> throttle, PKCE S256, state/nonce single-use, exchange+at_hash) — offline 23/23 exit 0;
> unit toàn cây lần đầu XANH TUYỆT ĐỐI 30/30, 885/885; lint 0; build 0.**
> **W48-QW1-LIVE-002 receipt: D 4/4 XANH (fix `title` thành công). Round-3 đã nộp
> (`docs/29` W48-QW1-LIVE-003): 6 ô M fail 403 = PRF-01 ĐÚNG spec (D4 kéo KEY_A vào profile-mode
> khi CONTROL_BIZ chưa có binding) — sửa fixture-only bằng 2 seed rows, compile 0 lỗi, kỳ vọng
> 10/10. **REVIEW-PATCH pre-run đã áp** (reviewer audit): cleanup tách tham số tenant cho
> DELETE operations (lỗi route-param nuốt FK), admin_idempotency chuyển từ route-LIKE sang
> whitelist key do suite mint — compile 0 lỗi lại. Chờ Tester chạy window; Qwen-1 không mở DB.**
> **W49-QW1-9/10 (cycles 93–95): round-3 500 = manifest seed thiếu `runtime` (fix
> fixture-only, `W48-QW1-LIVE-004` đã nộp, compile 0 lỗi). OIDC-02 HOÀN THÀNH:
> `src/modules/auth/session-store.ts` — opaque id, metadata server-side {sessionId,issuer,sub,
tenantId,role,createdAt,lastSeenAt,expiresAt}, TTL absolute + idle sliding, rotate chống
> fixation, destroy/revoke tức thì, repo seam 4-phương-pháp (Redis/DB install được sau, 2-replica
> đã chứng minh bằng shared-map), cookie HttpOnly+Lax+Secure, CSRF secret server-side,
> `sessionToActionAuth` nối thẳng dispatcher gate cycle-84 — offline 17/17; oidc-client 23/23;
> lint 0; build 0; unit toàn cây 32/33 & 886/886 (suite đỏ duy nhất = boundary R1-C
> `leaseTokens` TS2353 — lane đó đang sửa dở, không thuộc lane này).**
> Không commit/push. Không tick task row — `ADM-BASE-01` vẫn `[ ]`, quyền reconcile thuộc coordinator.
> cwd lane: `D:\Git\dugate`; package: `du-rework/services/orchestrator` (`@du/orchestrator`).

## W49-QW1-1 — R2-A Backend Platform Audit & Transaction Atomicity (ADM-BASE-01, Findings R3-01 & R3-02)

Bối cảnh finding: `coordination/reports/review.md` cycle 6/6 (R3-01 HIGH atomicity, R3-02 HIGH
security-plan gap) và `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md` mục 65 ("Platform must
authorize requested tenant from authenticated principal/role, make mutation+audit atomic… Add
foreign-principal negative tests and audit-INSERT fault tests"). Đường dẫn packet ghi
`services/orchestrator/…` là tương đối trong workspace `du-rework/`.

### 1. R3-01 — mutation + audit INSERT giờ là MỘT transaction

**Cơ chế** (chọn phương án "one transaction" của finding, không outbox — ledger là bảng DB nội
cùng pool, chưa có lý do outbox):

- `src/modules/audit/audit.ts`: thêm `Queryable` (pool-hoặc-tx-client); `record(input, executor?)`
  ghi qua executor được truyền; hàm mới `auditedMutation(db, audit, mutate, auditOf)` — chạy
  mutate + audit INSERT trên CÙNG `PoolClient` trong `db.tx`. INSERT fail → ROLLBACK cả mutation
  (đúng phát biểu "the mutation still persists without its audit event" của finding là không còn
  dựng được nữa). Mutation fail → không có INSERT nào được thử.
- `src/modules/registry/registry.ts`: `activateVersion`/`deactivateVersion` nhận `client?` optional
  — có client thì chạy thẳng trên transaction của caller (**không nested BEGIN**), không thì tự
  mở tx như cũ. Callers cũ (kể cả `tests/runtime.test.ts`) không đổi hành vi.
- `src/modules/profiles/profiles.ts`: `createRevision(input, client?)` — tương tự; độc lập giờ cũng
  chạy trong tx riêng (trước đây là 3 query không tx — race max(revision)+INSERT cũng được đóng
  một phần, vẫn còn ở READ COMMITTED, ghi chú mở ở mục 6).
- `src/modules/lifecycle/lifecycle.ts`: `sweepDeadlines(client?)` — cùng khuôn.
- `src/server.ts**: 5 route admin-mutation (findings nêu 4 dòng, thực tế có 5 call site
  `ctx.audit.record`): `business.enable` (~:986), `business.activate`, `business.drain`,
  `apikey.profile_bind` (profile-bindings), `operation.deadline` (sweep-deadlines) — tất cả chuyển
  sang `auditedMutation`. Wire shape/status code/response body GIỮ NGUYÊN (kể cả 404 fail-closed
  W29-C của enable; severity/action/resource taxonomy W48-C1 không đổi).

### 2. R3-02 — GET /api/v1/admin/audit phân quyền theo principal/role

- `ServerConfig.tenantAdminTokens?: Record<token, tenantId>` — bearer scoped-to-tenant do nền tảng
  cấu hình (caller không tự chọn; pattern giống `connectorBaseUrls`: platform config, never input).
- Helper xuất khẩu (unit-test offline được): `resolveAdminAuditPrincipal(config, authHeader)` →
  `{role:'platform'} | {role:'tenant_operator', tenantId} | null`; `authorizeAuditTenantRead(principal, requested)`
  → tenant hiệu lực hoặc **401/403 PERMISSION_DENIED**. 403 có chủ đích im tên tenant (no existence leak).
- Ma trận: platform bearer → mọi tenant (operator console, regression giữ nguyên); tenant-operator →
  chỉ tenant của mình, tenant lạ **403**, thiếu `tenantId` → tự soi tenant mình (không còn "honest
  empty" cho operator); bearer lạ → 401; tenant bearer KHÔNG phải admin route khác → 401
  (`assertAdminAuth` giữ nguyên platform-only, không nới).
- `createApp` fail-closed lúc boot nếu tenant token alias `adminToken`/`runtimeToken` (tinh thần W11-C1).
- OIDC-03 thay bảng bearer bằng claims; **contract route principal→scope giữ nguyên**, không phải viết lại.

### 3. Receipts (lệnh · cwd · exit code · counts)

Tất cả chạy trên `du-rework/services/orchestrator` trừ khi ghi khác; infra PG :5433 + Redis :6380
bởi `docker compose -f du-rework/infra/docker-compose.yml up -d` (tôi start; ports dead trước đó).

| # | Lệnh | Exit | Kết quả |
|---|---|---|---|
| 3.1 | `pnpm install --prefer-offline` (cwd `du-rework`) | 0 | +5 pkgs, 44.6s |
| 3.2 | baseline TRƯỚC sửa: `jest --runInBand --testPathIgnorePatterns "(admin-audit|admin-base-routes|admin-error-boundary|admin-shell-live-pane|artifact-grant-fencing|blob-wire-binary|ingress-bounded|migrations\.test|operation-tenant-fence|runtime\.test|usage-summary|workspace-reference)"` | 1 (env) | **12/14 suites pass, 682/686 tests**; 4 fail = `admin-shell-server`/`admin-shell-platform-mount` EADDRINUSE/ETIMEDOUT cổng ephemeral — flaky CÓ TRƯỚC, không liên quan R2-A |
| 3.3 | `pnpm run lint` (= `tsc --noEmit -p tsconfig.json`) | 0 | 0 lỗi (duyệt src; tests do ts-jest typecheck lúc chạy) |
| 3.4 | `npx jest --runInBand tests/admin-mutation-atomicity.test.ts tests/admin-audit-scope.test.ts` | 0 | **2 suites, 22/22 pass** (offline, không DB/Redis) — gồm 4 FAILURE-INJECTION case audit-INSERT (assert committed = ∅ sau rollback) |
| 3.5 | `npx jest --runInBand tests/admin-audit.test.ts` (LIVE PG) | 0 | **11/11 pass**, trong đó: *injected audit outage → 500 (sanitized), status unchanged, NO ledger row* — trigger plpgsql BEFORE INSERT trên `admin_audit_events` RAISE EXCEPTION đúng resource marker → `business_versions.status` vẫn `REGISTERED_DISABLED`, ledger 0 row; và *tenant-operator(A) asking for tenant B → 403 (the R3-02 hole, closed)* + 401 foreign-write + regression platform/tenant A/B |
| 3.6 | `pnpm --filter @du/orchestrator test:unit` (cũ 15/16 pass rồi) | 1 | **15/16 suites, 706/708**; 2 fail `admin-shell-server` (ETIMEDOUT ephemeral, đúng class flaky 3.2) — đáng ngờ do tôi chạy ĐỒNG THỜI với 3.7 |
| 3.7 | re-run serial sạch: `runtime.test.ts` → `test:unit` → `admin-base-routes.test.ts` (background shell `bg_4cd4d3f3`) | — | **PENDING — append vào W49-QW1-1b khi có kết quả.** Lần chạy trộn đầu tiên của `runtime.test.ts` fail 97/104 với `connect EADDRINUSE 127.0.0.1:5433` ở hook (client-socket Windows, không phải product path — `admin-base-routes` cùng run vẫn PASS; `admin-audit` LIVE PASS đơn lẻ ở 3.5) |

Test IDs mới (để reviewer đối chiếu): `tests/admin-mutation-atomicity.test.ts` (4 describe R3-01:
auditedMutation / registry / profiles / lifecycle, mỗi cái có case `FAILURE INJECTION: …`),
`tests/admin-audit-scope.test.ts` (R3-02 matrix), `tests/admin-audit.test.ts` thêm 2 describe
`R3-01: audit-INSERT fault injection rolls the mutation back` + `R3-02: tenant scope authorized
from the principal, not the query` (live).

### 4. Packaging / surface

- `package.json`: THÊM `"test:unit": "jest --runInBand --config jest.unit.config.cjs"` (`test` giữ
  nguyên = full, cần DB window). `jest.unit.config.cjs` mới: ignore 12 suite live (pattern không
  chứa separator — Windows). File tests của lane khác không bị ignore.
- `src/index.ts`: export thêm `auditedMutation`, `createAuditService`, `resolveAdminAuditPrincipal`,
  `authorizeAuditTenantRead` + types (`AdminAuditPrincipal`, `AuditRecordInput`, `Queryable`).
- Không migration mới, không đổi wire contract nào.

### 5. Boundary đã giữ

Không commit/push/reset. Không sửa `src/app/admin/**` (renderer lane), Workflow Builder,
`businesses/**`. Không đổi 403-message/shape của route khác. File
`tests/webhook-error-boundaries.boundary.test.ts` (mtime 03:26, lane khác vừa tạo giữa chu kỳ —
nhiều khả năng qwen3/R1-C) KHÔNG bị tôi đụng; nó sẽ tính vào tổng `test:unit` ở 3.6/3.7.

### 6. Mở — giao coordinator / reviewer

1. `ADM-BASE-01` chưa tick: acceptance cũ còn phần mount shell + dữ liệu thật + adjudication của
   reviewer 6/6; nhưng điều kiện "principal×tenant enforcement + atomic mutation/audit + negative
   fault tests" ở mục 65 nay đã có receipt (3.4/3.5).
2. Deploy-time wiring cho `tenantAdminTokens` (repo không có env-loader trong `src`; ai owns
   config `DU_TENANT_ADMIN_TOKENS`?). Đề xuất: parser `token=tenantId` ở entrypoint deploy + doc
   `docs/12-operations.md` — chờ coordinator chỉ lane.
3. Renderer `src/app/admin` vẫn fallback kind `apikey.profile_bind` (nudge cũ ở `reports/claude2.md`
   — owner OpenClaude lane).
4. `createRevision` standalone giữ race max(revision) (READ COMMITTED) — chỉ nghiêm trọng nếu có
   caller ngoài route; candidate task riêng, tôi không tự mở mặt trận.
5. Flaky Windows ephemeral-port (`admin-shell-server`/`platform-mount`, và 97-fail ở 3.7): người
   tái hiện nên chạy serialize + retry từng suite trước khi quy kết product.
6. ~~DB window~~ — ĐÃ RELEASED + teardown xong, xem W49-QW1-1b-closing.

---

## W49-QW1-1b — re-run serial + va chạm cross-lane lúc 03:2x (đang tiếp diễn)

Chain nền đầu tiên (`bg_4cd4d3f3`, chạy 03:26–03:3x) **KHÔNG phải fail vì code của lane này**:

- `tests/admin-mutation-atomicity.test.ts` vẫn **PASS** trong chính run nhiễm bẩn đó.
- `runtime`/`base-routes`/`audit-scope` fail ở **compile**, cùng một lỗi duy nhất:
  `src/modules/artifacts/artifacts.ts:108,110,112,131,154 — TS2339 'taskId'/'leaseEpoch' does not
  exist on type` — file KHÔNG thuộc R2-A, mtime **03:22** (một lane đang sửa dở — nghi vấn
  command-code/qwen3 blob-fence; coordinator quy kết). Server import chuỗi
  `server.ts → modules/artifacts` nên mọi suite nào import `src/server` đều chết compile giữa
  chừng; `tsc --noEmit` của tôi ở 3.3 chạy TRƯỚC 03:22 nên mới sạch.
- Cùng window: `admin-shell-server` thêm 2 fail ETIMEDOUT ephemeral-port (đúng class 3.2/3.6 —
  flaky nền Windows, không phải product).
- Hiện tại (trước re-run): `tsc --noEmit` = **0 lỗi** — lane kia đã chốt bản sửa, tree nhất quán.
- `docker ps`: du-rework-postgres/redis Up healthy (probe :5433 đầu tiên trả False nhất thời,
  probe lại True).

### W49-QW1-1b-closing — receipt re-run (cwd `du-rework/services/orchestrator`)

| Lệnh (serial, một tiến trình jest tại một thời điểm) | Exit | Kết quả |
|---|---|---|
| `npx jest --runInBand tests/runtime.test.ts tests/admin-base-routes.test.ts tests/admin-audit.test.ts --forceExit` (LIVE, PG :5433 + Redis :6380) | **0** | **3 suites pass, 115/115 tests** — xác nhận refactor R3-01 (5 route `auditedMutation` + `client?` ở registry/profiles/lifecycle) KHÔNG hồi quy `runtime.test.ts`; 97-fail lúc 03:2x bị loại trừ definitively (môi trường + `artifacts.ts` dở dang của lane khác) |
| `pnpm --filter @du/orchestrator test:unit` (unit config, toàn cây hiện hành) | 1 | **16/19 suites, 718/737 tests** pass. Hai suite CỦA LANE TÔI xanh trong đó: `admin-mutation-atomicity` (22 case) + `admin-audit-scope` |
| `npx jest --runInBand tests/admin-shell-server.test.ts tests/admin-shell-platform-mount.test.ts tests/webhook-error-boundaries.boundary.test.ts` (đơn lẻ, để quy kết 3 suite đỏ) | 1 | 19 fail tách bạch: **14** = `webhook-error-boundaries.boundary.test.ts` — test RED **chủ đích** của lane qwen3 (BR-Q3-01, nhãn `[OPEN:FIX-CR-01/FIX-CR-02/ADM-BASE-03]`, comment "RED today") — không liên quan R2-A; **5** = `admin-shell-server`(1) + `admin-shell-platform-mount`(4), toàn bộ `connect ETIMEDOUT/EADDRINUSE 127.0.0.1:5xxxx` — đúng class flaky loopback Windows có từ baseline 3.2, tái hiện cả khi chạy đơn lẻ 3.5s |

**Attribution để coordinator:** (a) RED-suite policy — suite chủ đích-đỏ có nằm trong gate xanh của
`test:unit` không (đề xuất phân loại `*.boundary.test.ts` chạy kèm nhãn OPEN; tôi không sửa file
lane khác); (b) `artifacts-fencing.test.ts` + `mm05-queue-integrity-offline.functional.test.ts` cũng
là file lane khác mới xuất hiện trong cycle — cả hai PASS.

**DB RELEASED** — `docker compose -f infra/docker-compose.yml down -v` từ `du-rework/`: mọi suite run
của lane này đã xong, không tiến trình jest nào khác đang chờ window. Lệnh cấp vận cho ai cần
:5433/:6380: `docker compose -f infra/docker-compose.yml up -d` (PG `du/du-test-only` →5433; Redis →6380).

---

## W49-QW1-2 — MM-05 Queue Re-arm & Queue-Integrity Health (docs/38, cycle 78)

### 1. Implementation (theo docs/38 §2/§3/§5/§6/§7)

**`src/modules/runtime/runtime.ts`** (packet ghi `runtime.service.ts` — tên file thực tế của package
là `runtime.ts`, không tạo file twin):
- `createRuntimeService(db, queueAccess?)` — tham số hai optional `{ getQueue(name): Queue }`,
  callers cũ không đổi.
- `QUEUE_INTEGRITY_CANDIDATES_SQL` — đúng 6 điều kiện §2 (`type='task.dispatch'`, stamp NOT NULL,
  grace `$1`, `READY/QUEUED`, leaseless, op not-terminal) + `DISTINCT ON` delivery mới nhất +
  LIMIT `$2`; queue_name resolve y hệt fallback dispatcher (`COALESCE(bv.queue, 'du-business-…')`).
- `QUEUE_INTEGRITY_REARM_SQL` — **single-statement CAS**: `WHERE id = $1 AND dispatched_at = $2 AND
  dispatched_at IS NOT NULL AND attempts < $3`, SET `dispatched_at=NULL`, `due_at = now() +
  LEAST(power(2,attempts),300)s`, `attempts+1`. Không tạo delivery row mới, không migration, không
  sửa dispatcher.ts. **Deviation có chủ đích:** design §7.1 nói FOR UPDATE SKIP LOCKED ở bước READ —
  PG KHÔNG cho phép row-lock xuyên `DISTINCT ON`; strictness đặt ở chính CAS write (đúng điều kiện
  packet "không ghi đè dispatcher stamp mới" — test 3 pin nó).
- `sweepQueueIntegrity(opts?)` — per-candidate: cap trước (D1 → `stalled`, không UPDATE); BullMQ
  `getJob(jobIdForDelivery(delivery_id))` là bằng chứng mất DUY NHẤT — alive → `aliveSkipped`;
  undefined → CAS re-arm (`rearmed`/`casSkipped`); getJob NÉM LỖI → `unconfirmed`, không re-arm
  (Redis lỗi ≠ job mất). Fail-closed nếu thiếu queueAccess.
- Types export: `QueueIntegrityCandidate|SweepResult|State|Health`; surface qua `src/index.ts`.

**`src/server.ts`**:
- `ServerConfig`: `queueIntegrityGraceMs` (30_000) / `queueIntegrityBatch` (50) / `queueIntegrityMaxAttempts` (10).
- `runQueueIntegritySweep()` + cache 1 slot (`OK | RECONSTRUCTING | SUSPECT`; SUSPECT khi
  `stalled>0` HOẶC lost ≥2 kỳ liên tiếp); `r.stalled>0` → audit `queue.integrity_stalled`
  (platform-global, actor 'platform', severity warning — precedent deadline-sweep W48-C1).
- Nối `recoveryTimer` hiện hữu (§4): `autoDispatch` OFF ⇒ cả hai sweep OFF; test drive trực tiếp.
- `GET /health`: **chỉ** thêm `queueIntegrity` khi đã có ≥1 sweep (KHÔNG bịa OK); SUSPECT →
  body `'degraded'` nhưng HTTP giữ 200 (D2). Transport fail giữ nguyên shape 503 cũ byte-for-byte.
- Seam cho tests/Tester: `app.runQueueIntegritySweep()`, `app.queueIntegrityHealth()`.

**Docs (§7.5)**: `docs/04` bullet "Job bị Redis mất…" viết lại theo CAS re-arm; `docs/12` alert thêm
`queueIntegrity.state=SUSPECT` (D2); `docs/17` Principles item 1 + Runbook step 3: deadline-sweep là
ESCAPE HATCH không còn là step 1, verify bằng `queueIntegrity.state`.

### 2. Receipts (offline-only — packet CẤM live DB, lượt này không mở window)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `pnpm run lint` (tsc --noEmit) SAU toàn bộ edits | **0** | 0 lỗi |
| `pnpm --filter @du/orchestrator exec jest tests/mm05-queue-integrity-sweep.test.ts` (đúng lệnh packet chỉ định) | **0** | **8/8 pass**, 2.1s: re-arm (probe/1 flip), alive-skip, CAS no-clobber, cap-stalled, Redis-error≠loss, fail-closed-no-queueAccess, structural-pin §2, batch-2-orphans |
| `npx jest --runInBand tests/mm05-queue-integrity-sweep.test.ts tests/mm05-queue-integrity-offline.functional.test.ts` | **0** | 12/12 — **probe Qwen-2 không sửa, vẫn 4/4**; flip sống ở file mới, đúng lane-file discipline |
| `pnpm --filter @du/orchestrator test:unit` (toàn cây, 20 suites) | 1 | **19/20 suites, 733/748**; suite đỏ duy nhất = `webhook-error-boundaries.boundary.test.ts` (RED chủ đích qwen3; chính lane đó đang sửa file — line drift 278→283 giữa hai lần chạy). `admin-shell-server` + `platform-mount` run này PASS (củng cố quy kết flaky ở 1b) |
| `pnpm --filter @du/orchestrator build` | **0** | dist tái build 04:04 (`dist/modules/runtime/runtime.js`, `dist/server.js`) |

### 3. Boundary & hạ tầng

KHÔNG chạy `docker compose down -v` (chỉ lệnh cycle 78). Ghi nhận: :5433/:6380 **đang UP** do tiến
trình khác dựng (~04:0x lúc kiểm tra) — không phải của lane này, để nguyên. Không sửa file Qwen-2
(probe), không sửa dispatcher.ts/lifecycle.ts/migrations (§7.4). Zero live test trong lượt này.

### 4. Handoff — việc còn của MM-05 (cần DB window)

1. **MM-05d drill live** (docs/38 §8): enqueue → wipe queue namespace → grace+2 cycle → assert job
   sống lại, op SUCCEEDED, 0 TIMED_OUT, đúng 1 outbox row với attempts+1 → owner Tester.
2. **MM-05c flip** `tests/integration/p8-02b-…`: characterization → DEGRADED sau wipe khi SUSPECT;
   drive bằng seam `app.runQueueIntegritySweep()`.
3. `runtime.test.ts` W38-A6 health keys: offline xanh nguyên trạng (field vắng khi
   `autoDispatch:false`); window live tới, nếu bật recoveryTimer thì thêm `queueIntegrity` vào
   key-set assertion.
4. Decision D2 đã ghi ở docs/12; alert wiring (metrics owner) còn mở.
5. `queue.integrity_stalled` audit path chưa có test live (cần DB) — offline đã pin cơ chế stalled
   qua cap test.

---

## W49-QW1-8 — SEC-01 OIDC client (cycle 91) + sửa live matrix theo feedback W48-QW1-LIVE-001

### A. Sửa suite live theo receipt Tester (3 passed / 7 failed round-1)

- **D2 fail = test sai trường, KHÔNG phải product bug**: `problem()` (contracts/errors.ts:101-116)
  map HttpError.message vào **`title`**, `detail` để trống — assert cũ đọc `body.detail` nên
  nhận ''. Sửa assert: `body.code === 'PERMISSION_DENIED'` + `body.title` match /csrf/i (ghi chú
  giải thích ngay trong test). D4 cũng siết lại no-echo trên đúng trường `title` + JSON body.
- **M1–M6 fail ở setup 404**: `submission.submit` resolve version theo **`is_active=true`**
  (submission.ts:238-243) — seed cũ chỉ có LIVE_BIZ `REGISTERED_DISABLED` (cố ý cho các ô
  enable D1/D2). Thêm **CONTROL_BIZ `ENABLED`+`is_active=true`** cho control submit; các ô
  D giữ nguyên seed. Cleanup afterAll viết lại theo **thứ tự FK**
  (human_waits→artifact_blobs→artifacts→outbox→tasks→operations) vì M-group giờ để lại
  operations thật; vẫn chỉ xoá row do suite sở hữu.
- Đã compile-verify lại: `npx tsc --noEmit -p tsconfig.live-tests.json` = **0 lỗi**. Một va chạm
  ngoài lane được ghi nhận & xử lý đúng quy tắc: `server.ts` fail compile vì
  **dist của `@du/contracts` cũ** so với src (edit `businessId` của lane claim-fencing) — chỉ
  `pnpm --filter @du/contracts build`, KHÔNG đụng code lane khác. Tester re-run được ngay:
  `npx jest --runInBand tests/admin-action-rbac-live.test.ts` trong window.

### B. SEC-01 — `src/modules/auth/oidc-client.ts` (MỚI, zero-dep, inject-fetch)

- `validateOidcConfig`: issuer/clientId/clientSecret/redirectUri/allowedIssuers (+jwksUri optional),
  https-only (loopback http cho dev IdP), issuer ∈ allowlist, cấm credential trong URL,
  clockToleranceSec clamp 0..60 — fail-closed tại construction.
- Discovery RFC 8414: exact-issuer match, cache, đủ 3 endpoint; mọi URL qua `FetchLike` seam.
- JWKS: TTL cache (default 300s), **rotation-on-unknown-kid đúng một lần/refresh** với
  floor chống bão fetch (30s) — kid lạ thứ hai trong floor → `jwks-refresh-throttled`.
- Verify **RS256-only**: `alg` bị chặn TRƯỚC mọi key lookup (chống HS*-confusion + `none`);
  base64url canonical(strict round-trip); chữ ký số qua `node:crypto`; claims: iss ∈
  allowlist, aud ⊇ clientId, multi-aud đòi azp, exp/nbf ±tolerance, sub/iat/exp bắt buộc;
  **nonce single-use** (ReplayGuard theo token-exp + retention) — verify lần hai cùng nonce →
  `nonce-replay`.
- PKCE S256 (`createPkcePair`), `authorizationUrl` (state/nonce/challenge; **state cũng
  single-use**, `consumeState` cho callback), `exchangeAuthorizationCode` (form POST +
  client_secret_basic, verify id_token với nonce, access-token JWT → at_hash binding theo
  OIDC Core = SHA-256 trên TOÀN BỘ access_token ASCII; opaque token → hợp lệ, null).
- Chưa wire route login/callback (OIDC-04/02 sở hữu session store) — module là client thư
  viện đã kiểm chứng; seam `mapOidcClaimsToPrincipal` (cycle 88) nối thẳng claims đã verify vào
  `AdminActionAuth`.

### C. Receipts cycle 91 (offline tuyệt đối — không DB window, không down -v, không socket)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `npx jest --runInBand tests/oidc-client.test.ts` | **0** | **23/23** — fake IdP RSA thật (2048-bit, ký/verify thật): positive multi-aud+azp; hostile: HS256-confusion, none, chữ ký flipped, b64 không canonical, iss/aud/kid, clock 3 chiều, missing exp/iat/sub (re-signed), nonce mismatch+replay, rotation 1-refresh + storm throttle, TTL refetch, state replay, exchange basic-auth + at_hash (sửa 2 expect-side: at_hash đúng spec hash trên TOÀN BỘ token; trường lỗi là `title`); `ReplayGuard` unit |
| `npx tsc --noEmit -p tsconfig.live-tests.json` (sau sửa suite live) | **0** | live matrix sẵn sàng re-run |
| `pnpm run lint` | **0** | 0 lỗi |
| `pnpm --filter @du/orchestrator test:unit` | **0** | **30/30 suites, 885/885 tests — unit gate xanh tuyệt đối LẦN ĐẦU** (boundary suite qwen3 đã tự đảo xanh; flaky loopback không tái hiện run này) |
| `pnpm --filter @du/orchestrator build` | **0** | dist chứa oidc-client |

Không tick `OIDC-01`: row còn đòi fake-IdP login/callback route thật + replay state/nonce ở tầng
HTTP (thuộc OIDC-02/04 wiring khi được dispatch). Không commit/push.


## W49-QW1-6 — ADM-BASE-02 action dispatcher + cookie/CSRF gate (cycle 84, nốt việc) và CAS-ms hotfix (cycle 85)

### A. Action dispatcher + RBAC + CSRF (dispatch cycle 84, hoàn tất offline)

- **`src/modules/admin-actions/rbac.ts`** (MỚI): toàn bộ primitives R3-02/ADM-BASE-02 (principal,
  resolver, `authorizeAuditTenantRead`/`requireResourceTenant`/`authorizeBindingTenant`) giờ sống ở
  ĐÂY — `server.ts` re-export giữ nguyên public surface (tests/index không đổi import). Thêm:
  `deriveCsrfToken` (HMAC-SHA256(secret, 'du-csrf|'+cookie), stateless), `validateCsrfToken`
  (constant-time, fail-closed), `resolveAdminActionAuth` (bearer TRƯỚC, cookie `du_admin` sau với
  CSRF-state; forged/expired/no-secret → null), `adminActionsMethodGuard` (non-POST → **405**,
  "không trả GET như thành công"). Cookie session KHÔNG mang tenant ⇒ không cookie role nào act
  như operator; mutations cookie-only-admin + csrfOk.
- **`src/modules/admin-actions/dispatcher.ts`** (MỚI): `POST /api/v1/admin/actions` với action
  table v1 (`business.enable|activate|drain`, `operations.sweep-deadlines`, `apikey.bind-profile`
  — đúng surface orchestrator đang có; connector.rotate/cancel-by-admin… → **404 unsupported**
  cho tới khi service tồn tại). `authorizeAdminAction` = ma trận RBAC thuần: bearer platform=all;
  bearer tenant_operator=CHỈ bind-profile (+ gate tenant TRƯỚC mọi write, foreign→403/no-echo,
  unknown key→404); cookie: CSRF check TRƯỚC role check. Execution DELEGATE 100% vào
  `auditedMutation`/`executeIdempotent`/services cũ — hai entry point không thể drift. Audit actor:
  `admin` (bearer) vs `shell:<role>` (cookie).
- Wiring `server.ts`: route mới + import; `index.ts` export surface. Dead-code `isAdminAuthed` đã
  xóa ở cycle 82; `migrations.test.ts` không đụng.
- **Receipt**: `npx jest --runInBand tests/admin-action-dispatcher.test.ts` → **26/26, exit 0**
  (method-guard 405; matrix 401/404/403; 6 case **zero-side-effect** đếm qua stub counters; happy
  path statuses; CSRF primitives; resolveAdminActionAuth 7 case gồm forged-cookie và ms-expiry
  fix cho signCookie). `pnpm run lint` = 0 lỗi sau toàn bộ. Lưu ý quy trình: 2 fix fail đầu tiên
  là TEST-side (tamper token có thể trùng ký tự cuối; iat/exp của shell-auth tính bằng MILLISECONDS)
  — sản phẩm đúng ngay từ đầu.
- Chưa live: HTTP-level proof của dispatcher (route wiring) nằm trong danh sách DB-window Tester,
  cộng dồn §4.4 cycle 82 + 4 case dispatcher (operator POST actions → 403 zero-row; cookie không
  CSRF → 403; GET → 405; bind foreign key → 403 zero side effects).

### B. MM-05 re-arm CAS microsecond bug — HOTFIX cycle 85 (Tester Round 7: 4/5, rearm-1 fail)

- **Root cause chuẩn đoán của Tester được xác nhận**: PG `timestamptz` lưu MICROsecond; node-pg
  parse ra JS `Date` MILLIsecond-only → `dispatched_at = $2` re-compare mất phần sub-ms ⇒ CAS
  trượt mọi re-arm hợp lệ (`r1.rearmed=0`, `casSkipped`). Không phải race thật; là bug precision.
- **Fix** (`src/modules/runtime/runtime.ts`, `QUEUE_INTEGRITY_REARM_SQL`):
  `AND date_trunc('millisecond', dispatched_at) = date_trunc('millisecond', $2::timestamptz)`
  — truncate CẢ HAI phía về cùng thang precision mà client round-trip được; fence vẫn từ chối
  stamp mới ở later MILLISECOND (packet "không ghi đè dispatcher stamp mới" giữ nguyên hiệu lực);
  doc-comment ghi rõ lý do + bằng chứng Tester Round 7.
- **Receipts**: `npx jest --runInBand tests/mm05-queue-integrity-sweep.test.ts` → **8/8 exit 0**
  (fake CAS vốn so epoch-ms = đúng semantics mới); `pnpm run lint` 0 lỗi;
  `pnpm --filter @du/orchestrator build` → exit 0, **dist đã chứa `date_trunc`** (grep xác nhận).
## W49-QW1-7 — LIVE HTTP matrix viết xong + OIDC-03 seam (cycle 88; offline-only, DB window CHƯA được dispatch cho lane này)

### A. Ma trận HTTP live 10 ô — VIẾT + COMPILE-VERIFY, chưa chạy

- File MỚI: **`tests/admin-action-rbac-live.test.ts`** — 10 ô dispatch yêu cầu: D1 operator→dispatcher
  enable **403 zero side effects** (so status DB + đếm ledger); D2 cookie **không CSRF → 403**, có
  CSRF dẫn xuất → **200 + actor `shell:admin`**; D3 GET actions → **405**; D4 bind foreign/unknown/own
  key → **403 (no id echo)/404/201+đúng 1 audit row**; M1 usage operator: B→403, A→200, thiếu
  param→200-of-A (khác platform-422); M2 operations-list chỉ rows của A (control op của B submit
  qua public path bằng key B — không đoán schema); M3 by-id ngoại tenant ≡ 404-của id không tồn
  tại (so cả `code`); M4 api-keys own-only + foreign scope 403; M5 envelope platform
  `{rows,total,limit}` regression; **M6 Idempotency-Key replay live** trên POST profile-bindings
  (same body, header `idempotent-replay: true`, ledger đúng +1 row) — bịt nốt khoảng 'chưa live' của
  W49-QW1-3.
- Discipline: fixture ids thuộc suite, cleanup scoped in-list FK, `autoDispatch:false`, autoMigrate;
  header ghi rõ **chạy MỘT MÌNH trong DB window được dispatch**. Đã thêm
  `admin-action-rbac-live\.test\.ts$` vào `jest.unit.config.cjs` (file này bị lane R1-A bổ sung
  `artifacts-fencing-pg` giữa chu kỳ — tôi chỉ THÈM dòng, giữ nguyên của họ).
- Compile-verify không cần DB: **`tsconfig.live-tests.json`** (mới) →
  `npx tsc --noEmit -p tsconfig.live-tests.json` = **0 lỗi**. KHÔNG chạy suite (không window).
  Lệnh Tester cần khi được dispatch:
  `npx jest --runInBand tests/admin-action-rbac-live.test.ts` (PG :5433 + Redis :6380).

### B. OIDC-03 seam (`mapOidcClaimsToPrincipal`, default-deny) — offline

- `rbac.ts`: `OidcAdminClaims {sub, iss, platformAdmin?, tenantIds?}` + mapper claims→AdminPrincipal,
  **fail-closed**: null/empty sub, allowlist rỗng, iss ngoài allowlist, không tenant + không flag,
  và MULTI-TENANT claim → null (không đoán tenant cho tới khi có per-session selection).
  Platform bearer hiện hành giữ làm bootstrap super-admin tới OIDC-01/02; mapper nạp thẳng vào
  CÙNG `AdminActionAuth` — dispatcher/cổng RBAC không cần biết principal sinh ra thế nào, nên
  matrix cycle 84 giữ nguyên khi IdP thật thế chỗ.
- Offline: 4 describe mới trong `admin-action-dispatcher.test.ts` → **suite 30/30 exit 0** (26 cũ
  + 4 OIDC, gồm case compose: mapper output chạy thẳng authorizeAdminAction).

### C. Receipts cycle 88

| Lệnh | Exit | Kết quả |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.live-tests.json` | **0** | live matrix + src compile xanh — **không chạy DB** |
| `pnpm run lint` | **0** | 0 lỗi (sau OIDC seam) |
| `npx jest --runInBand tests/admin-action-dispatcher.test.ts` | **0** | **30/30** |
| `pnpm --filter @du/orchestrator test:unit` (toàn cây) | 1 | **24/25 suites, 828/829 tests**; đỏ duy nhất = 1 test `admin-shell-platform-mount` `ETIMEDOUT :63131` — class flaky loopback đã pin nhiều lần; `s3-storage-facade.test.ts` (lane khác, mới) PASS |
| `pnpm --filter @du/orchestrator build` | **0** | dist cập nhật (rbac+dispatcher+mapper) |

### D._boundary cycle 88

- Không mở DB window, không down -v, không commit/push. Không chạy live suite nào.
- OIDC-01/02 (login flow PKCE, session store opaque 2-replica) THUỘC lane auth — seam mapper là
  phần platform-API của OIDC-03 mà lane này sở hữu theo dispatch; closeout vẫn cần SEC-00 matrix
  chính thức (quyền coordinator/SEC owner) — bảng ADMIN_ACTIONS v1 hiện giữ operator ở
  `apikey.bind-profile` (tenant-gated); nếu SEC-00 chốt bind-profile là admin-only, chỉ cần sửa
  MỘT dòng trong table — matrix live M/D4 sẽ báo đúng chiều.

- ⇨ **Tester re-run Round 7 (rearm-1)**: dist + source hiện tại là bản cần chạy; migration 0012
  đã sạch như receipt Round 7 của chính Tester. Lane tôi vẫn không mở DB window, không down -v.

---

## W49-QW1-3 — R2-A Priority-5: Idempotency cho admin mutating POST (cycle 80)

Nguồn: `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md:95` ("response-loss retry POST phải có
idempotency hoặc test chứng minh không tạo revision/audit thứ hai") + review.md 6/6 MEDIUM
"retried mutating POST is not idempotent proof".

### 1. Thiết kế đã chọn

`Idempotency-Key` (alias `Client-Token`) — **header tường minh**, không dedup ngầm theo payload:
dedup ngầm sẽ đổingữ nghĩa của retry-cùng-payload hợp lệ (reviewer từng dùng 4 POST giống nhau để test
limit — implicit dedup phá vỡ cả test cũ lẫn client cố ý re-pin). Không có header ⇒ hành vi legacy
giữ nguyên byte-for-byte.

Nguyên tử: marker INSERT chạy **trong cùng transaction** của `auditedMutation` (thêm tham số
`after?`) — revision + audit row + marker commit hoặc rollback CÙNG NHAU. Two-firsts race thua trên
PK → loser rollback toàn bộ → replay response của winner. Retry cùng key: đọc marker, so
`payload_hash` (sha256 canonical JSON — raw apiKey vào hash chứ không lưu raw) → khớp thì trả
nguyên response đã lưu (+ header `idempotent-replay: true`), **không chạy work, không ghi gì thêm**;
lệch payload hoặc lệch route ⇒ 409 `IDEMPOTENCY_CONFLICT`; key malformed ⇒ 422 fail-closed.

### 2. Files

- `migrations/0011_admin_idempotency.sql` ~~0011~~ **→ 0012_admin_idempotency.sql (hotfix cycle 84, xem
  §W49-QW1-5)** (MỚI, additive 0010-precedent): bảng `admin_idempotency`
  (key PK, route, payload_hash, response_code, response_body jsonb, created_at + index retention).
  `migrations.ts` tự nạp theo prefix số; `migrations.test.ts` không pin bảng này (IN-list hẹp) —
  kiểm tra trước khi viết, không phải sửa test lane khác.
- `src/modules/idempotency/idempotency.ts` (MỚI): `canonicalPayloadHash`, `readIdempotencyKey`,
  `executeIdempotent` (kể cả guard "work không ghi marker ⇒ fail closed"), `purgeIdempotencyMarkers`
  (ops helper, CHƯA wire timer — retention cần quyết định riêng).
- `src/modules/audit/audit.ts`: `auditedMutation(..., after?)`.
- `src/server.ts`: `POST /api/v1/admin/profile-bindings` + `POST /api/v1/admin/operations/sweep-deadlines`
  wire qua `executeIdempotent`; các PUT enable/activate/drain không đổi (state-convergent sẵn,
  replay-flag có từ W28-C).
- `src/index.ts`: export surface.

### 3. Receipts (offline-only; KHÔNG mở live DB; KHÔNG down -v — compose vẫn UP cho lane đang giữ)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `npx jest --runInBand tests/admin-idempotency.test.ts` | **0** | **14/14 pass**: hash canonical ổn định thứ tự key; header parse + 422 malformed; no-key legacy 2 lần = 2 mutation; same-key-same-payload retry ⇒ work KHÔNG chạy, 0 statement mới, body/status replay nguyên vẹn; different-payload 409; different-route 409; **lost-race: attempted = revision+audit, committed = ∅ (rollback đủ 3 món), winner replay**; work-throw ⇒ không marker; misuse-guard; purge. |
| `pnpm run lint` | **0** | 0 lỗi TS |
| `pnpm --filter @du/orchestrator test:unit` (toàn cây) | 1 (đỏ ngoài lane) | **19/21 suites, 746/762**; suite tôi xanh hết (idempotency 14, atomicity 22, scope, mm05 8+4). Đỏ = `webhook-error-boundaries` (RED chủ đích qwen3, đã co còn 7 case — lane đó đang hoạt tích cực) + `admin-shell-server` 9 fail `ETIMEDOUT/EADDRINUSE :542xx` (class flaky loopback, fail cả khi chạy đơn lẻ — không liên quan R2-A; 1 fail cascade do call thiếu vì socket chết) |

### 4. Boundary & chưa làm

- Không live test trong lượt này (packet): replay qua HTTP thật + `admin_idempotency` + PG unique
  violation + socket-close-after-commit là **bằng chứng live còn thiếu** — đưa vào DB window kế
  (đề xuất 2 case vào `tests/admin-audit.test.ts` khi có window: retry cùng key qua HTTP trả cùng
  body + ledger vẫn 1 row; reuse key khác payload → 409).
- Không sửa file lane khác ngoài các file lane này đã sở hữu từ W49-QW1-1/2 (audit.ts là chain
  sửa kế tiếp của R2-A).
- Chưa wire retention job cho marker (purge helper có sẵn; cần quyết định cửa sổ ≥ window
  retry/replay công bố theo docs/04).
- Không commit/push. ADM-BASE-01 vẫn `[ ]` — điều kiện "idempotency hoặc test không tạo
  revision/audit thứ hai" nay có receipt offline; adjudication thuộc coordinator/reviewer.

---

## W49-QW1-4 — ADM-BASE-02: principal×tenant enforcement trên mọi admin route mang tenant (cycle 82)

### 1. Phạm vi & quy tắc

Mở rộng mô hình R3-02 (chọn tenant từ CREDENTIAL, không từ query) ra toàn bộ admin surface
mang tenant trong `server.ts`, dùng lại ĐÚNG một resolver:

| Surface | Trước | Sau (cycle này) |
|---|---|---|
| `GET /api/v1/admin/audit` | R3-02 đã chốt | không đổi (nay là alias của resolver chung) |
| `GET /api/v1/usage` (nhánh admin bearer) | platform-only, tenantId bắt buộc | operator token được chấp nhận: thiếu param → ép về tenant mình; `?tenantId=<lạ>` → **403**; platform giữ 422-cũ |
| `GET /api/v1/operations` (nhánh admin) | cross-tenant cho platform | operator: **SQL predicate** `WHERE tenant_id = principal` (server-side fence, không post-filter); platform envelope byte-for-byte |
| `GET /api/v1/operations/:id` (detail) | cross-tenant sau `isAdminAuthed` | operator đọc by-id ngoại-tenant → **404 NOT_FOUND** vô phân biệt (tiền lệ R24-01: by-id không lộ existence); platform giữ nguyên |
| `GET /api/v1/admin/api-keys` (+ /:keyId) | platform-only | operator được đọc: list ép theo tenant (lạ → **403**); by-id ngoại tenant → **404**; platform giữ nguyên |
| `POST /api/v1/admin/profile-bindings` | platform-only | operator **chỉ bind key thuộc tenant mình**: resolve key→tenant trước mutation (SELECT hash+ACTIVE; key lạ/Inactive → 404 cũ), `authorizeBindingTenant`: ngoại tenant → **403 PERMISSION_DENIED** (mutation tường minh); idempotency (W49-QW1-3) giữ nguyên trên cả hai role |
| businesses/versions, connectors/:rev, profiles/:biz, enable/activate/drain, sweep-deadlines | platform-only (`assertAdminAuth`) | GIỮ NGUYÊN platform-only — tài nguyên không mang tenant; operator → 401 (đã pin live ở W49-QW1-1) |

**Deviation có chủ đích, ghi rõ:** packet đòi "tenant khác nhận 403". 403 áp cho **đọc/ghi có chọn
tenant tường minh** (query param / mutation đích); **by-id read** dùng 404 vô phân biệt vì 403 on
by-id lộ thông tin tồn tại-tài-nguyên-sang-tenant-khác — đúng chuẩn fence R24-01 mà repo đã chốt.
Cả hai đều fail-closed; matrix test pin từng loại.

### 2. Helper mới (export, offline-test)

- `resolveAdminPrincipal` (generic) — `resolveAdminAuditPrincipal` thành alias identity-behavior.
- `requireResourceTenant(principal, rowTenantId)` — 401/ok/**404** (message `'not found'` duy nhất).
- `authorizeBindingTenant(principal, keyTenantId)` — 401/ok/**403** `'mutations are scoped to the
  caller tenant'` (không echo id).
- `authorizeAuditTenantRead` wording: `audit reads` → `admin reads` (code `PERMISSION_DENIED`
  giữ nguyên — test live cũ chỉ assert code).
- Xóa dead-code `isAdminAuthed`; comment `buildAdminOperationDetail` cập nhật theo fence mới.
- `src/index.ts`: export đủ `resolveAdminPrincipal`/`requireResourceTenant`/
  `authorizeBindingTenant`/`type AdminPrincipal`.

### 3. Receipts (offline; KHÔNG mở DB window; KHÔNG down -v)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `npx jest --runInBand tests/admin-audit-scope.test.ts` | **0** | **19/19**: matrix cũ R3-02 + 4 describe ADM-BASE-02 (alias-identity, by-id-404-no-leak, binding-403-no-echo, usage/api-keys reuse-cùng-decision) |
| `pnpm run lint` | **0** | 0 lỗi TS |
| `pnpm --filter @du/orchestrator test:unit` (toàn cây) | 1 (1 test flaky) | **21/22 suites, 779/780 tests**; `webhook-error-boundaries` nay **XANH** (qwen3 đã lên source-fix — đính chính cho 2 mục receipt trước); red duy nhất = `admin-shell-server` 1/56 `EADDRINUSE :55477` → chạy đơn lẻ **56/56 exit 0** (pin flaky) |
| `pnpm --filter @du/orchestrator build` | **0** | dist tái build |

### 4. Boundary + việc còn cho DB window

- Không đụng live test nào (`admin-base-routes.test.ts` giữ nguyên — nó chạy platform bearer nên
  không đổi hành vi; case operator-level live được kê dưới đây cho window kế).
- **Live matrix đề nghị cho Tester** (thêm vào `admin-base-routes.test.ts` hoặc
  `admin-audit.test.ts` khi có window): operator(A) → (a) `GET /api/v1/usage?tenantId=B` 403,
  `?tenantId=A` 200, thiếu param 200-of-A; (b) `GET /api/v1/operations` chỉ trả rows tenant A
  (so row B có seeded); (c) `GET /api/v1/operations/:idB` 404 == same-shape-not-found;
  (d) `GET /api/v1/admin/api-keys?tenantId=B` 403, list không tham số chỉ keys của A;
  (e) `POST profile-bindings` key-B → 403 với **zero side effects** (profile_bindings +
  admin_audit_events count không đổi); (f) platform path regression: envelope operations-list
  cũ giữ nguyên byte-for-byte.
- OIDC-03 thay bảng bearer bằng claims — contract principal→scope giữ nguyên, không viết lại.
- `GET /api/v1/admin/api-keys` now fail-closed 401 khi `adminToken` unset **và** token không
  thuộc `tenantAdminTokens` — chính sách "admin endpoints require an admin token" không đổi.
- Không commit/push; `ADM-BASE-02` vẫn `[ ]` (line SEC-OIDC-VAULT-2026-09-24.md:15 còn đòi
  action dispatcher + CSRF + cookie-auth sau OIDC-03 — slice tenant-scope này chưa đóng row).

---

## W49-QW1-5 — ⚠ HOTFIX cycle 84: migration sequence 0011 collision (blocker Tester Round 7)

**Root cause (đã xác nhận trên đĩa):** `0011_artifact_finalize_epoch.sql` (lane R1-A, mtime
03:54) và `0011_admin_idempotency.sql` (của tôi, 04:14) cùng prefix → `migrate()` insert
`schema_migrations.sequence=11` HAI LẦN → duplicate PK giữa chừng Round 7. Đúng như
review.md cycle này phân tích: sau crash, verify chỉ theo sequence nên false-green.

**Fix đã làm (dispatch items 1–4 + nguồn yêu cầu priority-0 của FULL-REWORK:108):**
1. **Rename** file CỦA TÔI → `migrations/0012_admin_idempotency.sql` (giữ số của lane có file
   sớm hơn — không đổi tên file đã-lên-số-của-kẻ-khác). Enumeration lại: 0001..0012, không còn
   duplicate prefix nào (probe Group-Object rỗng).
2. **Runner guard vĩnh viễn** (`src/db/migrations.ts`): `loadMigrationFiles` giờ **throw ngay khi
   thấy hai file cùng sequence** ("duplicate migration sequence N: A và B — renumber one file")
   — trước mọi write; `appliedSequences` → `appliedMigrations` (sequence→filename);
   `verifyMigrations` **so cả filename**: ledger ghi sequence 11 dưới tên file khác tên trên đĩa
   ⇒ throw kèm sẵn câu repair `DELETE FROM schema_migrations WHERE sequence IN (…)`. Không còn
   class lỗi này lọt qua boot.
3. `tests/migrations.test.ts`: **không có reference nào tới 0011_admin_idempotency** (grep cả
   `du-rework`) — không cần sửa; các pin của nó (IN-list 4 bảng, >=5 applied) không đổi.
   Test mới offline: `tests/migrations-ledger-guard.test.ts` (dup→throw, unique→load, pin dir
   hiện hành không dup, stale-ledger→mislabeled+hint, consistent→pass, missing→missing).
4. `src/index.ts`: export `loadMigrationFiles` không đổi API migrate/verify (tên giữ nguyên).

### Receipts (offline, không DB window, không down -v)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/admin-idempotency.test.ts` (đúng lệnh dispatch) | **0** | **14/14** |
| `npx jest --runInBand tests/migrations-ledger-guard.test.ts` | **0** | **6/6** |
| `pnpm run lint` | **0** | 0 lỗi |
| `pnpm --filter @du/orchestrator test:unit` (toàn cây, 23 suites) | 1 | **22/23 suites, 786/789**; đỏ duy nhất: `admin-shell-server` 3 test `ETIMEDOUT :57xxx` — đúng class flaky loopback (đã pin 56/56 xanh đơn lẻ ở cycle 82) |
| `pnpm --filter @du/orchestrator build` | **0** | dist/db/migrations.js rebuild; runner đọc `migrations/` từ package root nên dist không cần SQL |

### ⇨ HƯỚNG DẪN TESTER RE-RUN ROUND 7 (quan trọng — DB của round trước có thể còn ledger cũ)

Guard filename-match MỚI sẽ **cố ý throw** trên DB đã từng ghi `sequence=11` dưới tên
`0011_admin_idempotency.sql` (đúng bài toán false-green — không phải bug mới). Chọn 1 trong 2:

- **A (khuyến nghị, sạch nhất):** trong window của anh/chị: `docker compose -f
  infra/docker-compose.yml down -v && up -d` → DB fresh → `npm run migrate` áp
  `0011_artifact_finalize_epoch` + `0012_admin_idempotency` đúng thứ tự → verify xanh.
- **B (giữ dữ liệu, surgical):**
  ```sql
  SELECT sequence, filename FROM schema_migrations WHERE sequence >= 11;
  -- nếu thấy row (11,'0011_admin_idempotency.sql'):
  DELETE FROM schema_migrations WHERE sequence = 11 AND filename = '0011_admin_idempotency.sql';
  ```
  rồi `npm run migrate && npm run migrate:verify` — migrate sẽ áp nốt 0011 (artifact, nếu chưa
  có cột `artifacts.finalized_lease_epoch`) và 0012 (bảng `admin_idempotency` nếu đã tồn tại
  thì IF NOT EXISTS chỉ là no-op; ledger được ghi đúng).
  Nếu ledger hiện là (11,'0011_artifact_finalize_epoch.sql') thì KHÔNG cần DELETE — chỉ migrate
  (0012 pending) rồi verify.

Bằng chứng để đính kèm receipt re-run: output `npm run migrate` (danh sách applied),
`migrate:status`, và Round 7 với counts nguyên vẹn. Lane tôi không tự vận — DB window là của
Tester theo quy chế.

---

## W49-QW1-10 — round-3 fix (manifest.runtime) + OIDC-02 SESSION STORE (cycles 93-95)

### A. W48-QW1-LIVE-003 -> 004
- Round-3: D 4/4 (title-fix xác nhận sống); M-group 500 = manifest seed thiếu 'runtime'
  (submission.ts:222/248 đọc manifest.runtime.handlerKinds -> TypeError). Sản phẩm đúng,
  seed sai hợp đồng đăng ký. Fix fixture-only: hai manifest mang
  runtime: { wireVersion: '1', handlerKinds: ['root'] }. Compile tsconfig.live-tests.json = 0
  lỗi; src/dist không đổi. LIVE-004 đã nộp vào docs/29 (kỳ vọng 10/10 exit 0; still-red thì
  trích raw, không sửa product theo test). Ghi chú: khi append 004, block từng lọt giữa entry
  003 — đã cắt/dán lại đúng chỗ, cả hai entry nguyên vẹn.

### B. OIDC-02 — src/modules/auth/session-store.ts (MỚI, offline-verified)
- Opaque session: cookie chỉ mang id 43 ký tự base64url (SESSION_ID_RE gate TRƯỚC repo);
  metadata server-side đủ bộ {sessionId, issuer, sub, tenantId, role, csrfToken, createdAt,
  lastSeenAt, expiresAt} theo dispatch + SEC-02.
- Repo seam 4 phương thức get/set/delete/revokePrincipal?: memory repo cung cấp cho test;
  Redis (SETEX)/Postgres cùng interface — store không state cục bộ, 2-replica chứng minh bằng
  shared-map test.
- TTL: absolute (8h, clamp <=24h, KHÔNG nối dài bởi activity) + idle sliding (30m);
  expired/idle-dead -> lazy eviction; MỘT đường null vô phân biệt (unknown == expired).
- rotate() sau login = id MỚI, id CŨ xoá ngay, identity/CSRF/expiresAt/createdAt giữ nguyên
  (rotation không nối dài đời session); rotate trên id chết -> null, không tạo record.
- destroy() tức thì + idempotent, buildSessionClearCookie Max-Age=0; revokePrincipal(iss,sub)
  xoá sạch mọi phiên của subject và fail-closed (SessionError revoke-principal-unsupported)
  khi repo không index theo principal; restart trên cùng repo KHÔNG hồi sinh session đã revoke.
- Cookie SEC-02: HttpOnly, Path=/, SameSite=Lax (IdP redirect là top-level GET; cross-site
  POST vẫn không mang cookie), Secure theo protocol — value là id DUY NHẤT; module không
  logger, không token/role/sub trên wire.
- CSRF THẬT: mỗi session một csrfToken server-side; verifySessionCsrf constant-time;
  sessionToActionAuth(session, provided) phát thẳng AdminActionAuth mà dispatcher cycle-84
  tiêu thụ; seam mapOidcClaimsToPrincipal (cycle 88) là bước OIDC kế.
- Default-deny khi mint: operator không tenantId -> từ chối (operator-requires-tenant).

### C. Receipts cycles 93-95

| Lệnh | Exit | Kết quả |
|---|---|---|
| npx jest --runInBand tests/session-store.test.ts | 0 | 17/17 — lifecycle, touch-khong-noi-absolute,
  idle+absolute eviction, hostile-id KHÔNG chạm repo (well-formed-unknown = 1 null path),
  fixation/rotate, destroy, revokePrincipal (+fail-closed), 2-replica, restart, CSRF,
  cookie posture (assert KHÔNG chứa csrf/sub), principal map, config clamp |
| npx jest --runInBand tests/oidc-client.test.ts | 0 | 23/23 (không hồi quy) |
| pnpm run lint / pnpm --filter @du/orchestrator build | 0 / 0 | dist chứa
  auth/session-store.js; exports trong src/index.ts |
| pnpm --filter @du/orchestrator test:unit | 1 | 32/33 suites, 886/886 tests. Suite đỏ
  DUY NHẤT = webhook-error-boundaries.boundary.test.ts TS2353 'leaseTokens' — lane R1-C
  đang sửa dở chính file đó, không phải product, không phải lane này. Run ĐẦU có 32 fail
  ETIMEDOUT loopback nhất thời (hosts port exhaustion) — run lại sạch hoàn toàn; ghi đúng
  thực tế, không tô xanh hộ.

### D. Chưa đóng row
- Không tick OIDC-02: row còn đòi restart/replica test trên store THẬT (Redis/DB repository +
  login/callback route thuộc wiring OIDC-01/04) khi coordinator dispatch; phần offline của
  hàng đợi abstraction + semantics đã đủ bằng chứng.
- Không commit/push; không mở DB window; không down -v.

---

## W49-QW1-11 — Cycle 96: LIVE-005 (inputSchema fix) + OIDC-03 RBAC matrix wired

### A. W48-QW1-LIVE-004 -> 005
Round-4: manifest dùng sai key `schema:{}` — `submission.ts:113 ajv.compile(actionDef.inputSchema)`
⇒ Ajv throw ⇒ 500. FIX fixture-only: `inputSchema: { type:'object', additionalProperties:true }`
cho CẢ hai business. **LIVE-005** đã nộp vào docs/29 (kèm đổi chính sách bên dưới), kỳ vọng
**12/12 exit 0**.

### B. OIDC-03 — matrix thật vào dispatcher + route + session seam
- `ADMIN_ACTIONS` theo SEC line 19: **operator chỉ** `operations.cancel|resume` (approved set),
  `apikey.bind-profile` thành ADMIN-ONLY cho cả bearer lẫn cookie; business/sweep vẫn
  platform-only; cookie mutations cần CSRF (gate TRƯỚC role, như cũ).
- Route `POST /api/v1/admin/profile-bindings`: operator → 403 '...require the platform admin
  role' TRƯỚC mọi lookup (zero side effects; thay quyết định cycle-82 — ghi rõ supersede).
- Executor cancel/resume: tenant của operator lấy TỪ CREDENTIAL; service fence trả 404 vô phân
  biệt cho op ngoại tenant ⇒ không audit, tx rollback. `lifecycle.cancelOperation(client?)` (cùng
  khuôn sweep) ⇒ cancel + audit MỘT transaction. Platform cancel resolve tenant từ row.
- Wiring OIDC-02/03: `resolveAdminActionAuthAsync` — bearer → **opaque `du_session`** (store qua
  `ServerConfig.adminSessionStore`, role+CSRF server-side) → legacy cookie; header tự khai
  (`x-du-role`...) KHÔNG BAO GIỜ tạo principal (test chứng minh null).
- Live suite thêm ô **X1** (operator cancel own op → 200 + audit tenant-scoped) và **X2**
  (cancel op tenant B → 404, ledger+state không đổi); D4 viết lại theo policy ADMIN-ONLY.
- **Receipts**: dispatcher matrix **42/42** (7 principal × 7 action + cancel/resume execution +
  async-auth cells); session 17/17; oidc-client 23/23; **test:unit toàn cây 33/33 suites,
  929/929 tests, exit 0** (boundary R1-C đã tự xanh); `tsc --noEmit` **0 lỗi**; build **exit 0**.
- Ghi nhận middleware nhiễu: build/lint fail 1 lần vì `connector-credentials/workflow.ts` của
  lane VAULT đang sửa dở (lỗi của họ, không sửa hộ); lane đó chốt ⇒ gate của tôi xanh.
- Không tick `OIDC-03`: còn đòi direct-HTTP assertion TRÊN LIVE cho từng ô (LIVE-005 đang chờ
  Tester) + SEC-00 matrix chính thức từ coordinator. Không commit/push; không DB window.

---

## W49-QW1-12 — OIDC-04 login/callback/logout flow (cycle 98, offline)

### A. Module mới: `src/app/admin/oidc-flow.ts` (pure handlers, DI seams)
- `handleLogin`: `createPkcePair()` + state/nonce random; challenge {verifier, nonce, returnTo,
  expiresAt 10m} lưu SERVER-SIDE trong `OidcChallengeStore` (one-shot, TTL) — browser chỉ
  round-trip `state`; 302 → IdP authorize URL (S256; verifier KHÔNG bao giờ ra URL).
- `handleCallback`: MỘT hình dạng từ chối 403 cho mọi hostile (state lạ/thiếu/đã tiêu/
  hết hạn, `error=` từ IdP, token lỗi) — không oracle; `consume()` một lần (chống replay);
  exchange bằng verifier đã lưu; id_token verify qua OidcClient (chữ ký/iss/aud/exp/nonce),
  claims → role map default-deny: `platformAdmin`→admin, đúng-MỘT-tenant→operator,
  còn lại→viewer (session vô hại, không mutate được); mint opaque session OIDC-02 +
  `set-cookie: du_session` (HttpOnly, Lax, Secure theo publicOrigin) + 302 về returnTo.
- `sanitizeReturnTo`: ALLOWLIST chính tắc (`^/[A-Za-z0-9/_?=&#-]*$`, cấm `//`, `..`, scheme,
  encode ký tự) — open redirect bất khả thi do cấu trúc; mọi shape lạ → `/admin`.
- `handleLogout`: destroy session trong store + cookie `Max-Age=0` + 302 `/admin/login`;
  cookie rác/vắng vẫn 302 vô hại (idempotent, không leak).
- KHÔNG sửa `shell-router.ts` (lane OpenClaude) — ba handler là hàm thuần, mount một dòng khi
  lane shell sẵn sàng; `src/index.ts` export đầy đủ types/factory.

### B. Receipts (offline tuyệt đối — không DB, không socket, không live)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `npx jest --runInBand tests/admin-oidc-flow.test.ts` | **0** | **7/7** — PKCE redirect + verifier-not-on-URL + state mới mỗi login; happy path: exchange đúng verifier (S256 recompute = challenge), session admin, cookie `du_session=…; HttpOnly; SameSite=Lax` (origin http ⇒ không Secure); tenant→operator, multi/absent→viewer; returnTo giữ path an toàn, 5 shape open-redirect → `/admin`; 9 nhánh hostile 403 **zero session, zero cookie**; logout destroy + clear + idempotent. Một fail đầu tiên là TEST-side (`'\admin\evil'` mất backslash vì escape JS — sản phẩm đúng, sửa test) |
| `pnpm run lint` / `pnpm run build` | **0 / 0** | 0 lỗi TS; dist cập nhật |
| `test:unit` toàn cây | 1 (đỏ lane khác) | **CHỐT** (`bg_623acc22`, 22.4s): **36/37 suites,
  962/962 tests** — `admin-oidc-flow` PASS cùng toàn bộ suite lane này. Đỏ DUY NHẤT =
  `tests/connector-revision-http-offline.functional.test.ts` (file MỚI lane connector/VAULT:
  `@du/connector` không resolve từ package orchestrator + 3 lỗi TS riêng của file) — không
  phải product của lane tôi, không sửa hộ; đề nghị coordinator quy kết lane owner. Run ĐẦU
  treo >10 phút rồi tự hết — nhiều khả năng file đó đang giữa-thiết-kế (nó boot HTTP
  listener); ghi hiện tượng, không quy kết chắc chắn |

Không tick `OIDC-04` (row cần browser thật + mount shell + expired-session qua HTTP thật —
một phần thuộc lane OpenClaude/Tester). Không commit/push; không mở DB window; không down -v.

---

## W49-QW1-13 — Cycle 99: FIX-X-RESUME-ATOMIC + nộp W48-QW1-LIVE-006

1. **X2 no-echo (lifecycle.ts)**: `cancelOperation` đổi 404 từ `operation ${id} not found` →
   message CO DINH `'operation not found'` (ca 2 nhánh not-found + tenant-mismatch) — body
   admin/X2 không còn parrot id mà caller đang probe; nhất quán `requireResourceTenant`
   (cycle 88). Public tenant-fence 404 giữ status/code, chỉ text gọn lại — không test cũ nào
   assert message đó (đã grep).
2. **Resume atomic (runtime.ts + dispatcher.ts)**: `resumeOperation(id, tenant, body, client?)`
   theo khuôn cancel/sweep — dispatcher truyền transaction client ĐANG MỞ ⇒ resume mutation +
   wait + outbox row + audit commit CÙNG một transaction; caller cũ (public route) giữ tx riêng.
3. **Offline verify**: dispatcher suite cập nhật stub + assert mới (`message === 'operation not
   found'`, không chứa `op-foreign`, audit 0 dòng) → **42/42**; cộng atomicity 22 + mm05 8 =
   **63/63 exit 0**; `pnpm run lint` **0**; `pnpm run build` **0**. Không live run (không
   window, không down -v).
4. **`W48-QW1-LIVE-006` ĐÃ NỘP** vào docs/29: 12/12 kỳ vọng cho `admin-action-rbac-live.test.ts`
   (X2 giờ pass sạch nhờ (1); resume atomic chứng minh qua X1 + ledger). Routing Tester
   `term_c9d336eb`. Lưu ý thứ tự file: queue giữ nguyên các entry 003/004/005 chưa có receipt.

---

## W49-QW1-14 — Cycle 100: OIDC-04 mount vào Admin Shell router (offline)

1. **`shell-router.ts`**: thêm `ShellRuntimeConfig.oidcFlow?` + `dispatchShellRequestAsync` —
   lớp async MỎNG đè lên dispatcher thuần (sync không đổi 1 byte hành vi khi không mount flow):
   GET|POST /admin/login → 302 IdP (PKCE; POST local bị CHẶN khi flow mounted — hai đường
   đăng nhập không thể cùng tồn tại, self-contained cookie không còn cửa sau);
   GET /admin/oidc/callback → exchange + mint `du_session` (HttpOnly/SameSite=Lax/Secure theo
   origin — flag do `buildSessionCookie` của OIDC-02 quyết, một chỗ duy nhất);
   POST /admin/logout → hủy session + MỘT header `Set-Cookie` xóa cả `du_session` lẫn
   `du_admin` cũ. Các route khác rơi xuống dispatcher sync nguyên trạng.
2. **`shell-server.ts` / `server.ts`**: `CreateAdminShellServerOptions.oidcFlow` +
   `AdminShellAttachInput.config.adminOidcFlow` + `ServerConfig.adminOidcFlow` — attach và
   re-mount trong `listen()` đều truyền qua spread; server listener chính dùng
   `dispatchShellRequestAsync` (request handler vốn async).
3. **Test mount offline mới** `tests/admin-shell-oidc-mount.test.ts` — **6/6 exit 0**: PKCE
   redirect; callback mint session + set-cookie đúng shape; logout xóa CẢ HAI cookie +
   session chết trong store; local-password-POST bị intercept (không set du_admin); route
   section xuyên qua nguyên vẹn; REGRESSION không-flow == sync response (equal-object).
   Một fail đầu là test-side (URL.origin không kèm base path) — sản phẩm đúng.
4. **Gate**: lint **0**; build **exit 0**; `test:unit` toàn cây **38/40 suites, 1012/1016
   tests** — 4 fail là đúng class flaky loopback (`admin-shell-server` ETIMEDOUT + 1 cascade,
   `platform-mount` EADDRINUSE): chạy ĐƠN LẺ 2 suite đó = **93/93 exit 0** ngay sau đó.
   `connector-revision-http` (lane khác) nay đã xanh tự nhiên; boundary qwen3 xanh; suite mới
   `admin-actions-vault04-offline` + `graceful-shutdown.boundary` của lane khác PASS.

5. Còn lại của row OIDC-04 (KHÔNG thuộc slice mount này, chờ dispatch/window): browser thật
   qua fake IdP + expired-session drill + tick row — routing đề xuất: OpenClaude (shell UI)
   + Tester (browser/live). Không commit/push; không DB window; không down -v.

---

## W49-QW1-15 — Cycle 101: OIDC-04 session lifecycle hardening (offline)

1. **UI buttons**: chrome P6-01 đã có sẵn form **Sign out** (`POST /admin/logout`,
   shell-render:340) — handler mounted cycle-100 nay hủy CẢ HAI phiên nên nút dùng được luôn
   cho OIDC; **login** = `GET /admin/login`: anonymous → 302 IdP (PKCE), đã-sign-in → 302
   `/admin` (không round-trip IdP thừa). Không cần sửa renderLoginPage (form local chỉ còn
   đường legacy khi KHÔNG mount flow).
2. **Graceful redirect khi `du_session` chết** — `dispatchShellRequestAsync` giờ là SESSION
   GATE cho mọi route protected khi `oidcSessions` mounted:
   - live session → claims TIÊM vào dispatcher sync (`dispatchShellRequest(req, cfg,
     claimsOverride?)` — signature mở rộng tương thích ngược 100%, sync default không đổi);
   - EXPIRED (TTL/idle — store trả null) / REVOKED (destroy/revokePrincipal) / FORGED (id
     well-formed nhưng lạ) / ANONYMOUS → **302 `/admin/login` + Set-Cookie quét `du_session`
     stale** (`Max-Age=0`), routeId `oidc-session-gate` — không bao giờ còn pane 401/403 thô
     dưới OIDC;
   - cookie `du_admin` legacy (không có du_session) → passthrough dispatcher cũ (coexist);
   - `/favicon.ico` miễn gate; config không-`oidcSessions` → hành vi tiền-101 nguyên vẹn.
3. **Test offline mới** `tests/admin-shell-session-lifecycle.test.ts` — **10/10 exit 0**: live
   serve; expired→302+swept+store-đã-evict; revoked→302; forged→302; anonymous→302 (không
   phải 401); legacy passthrough; already-login→`/admin`; anonymous-login→PKCE; favicon
   bypass; gate-OFF regression = 401 pane cũ. (1 expect test-side sai 200-vs-401 — sửa theo
   contract cũ của lane shell, sản phẩm đúng.)

### Receipts cycle 101

| Lệnh | Exit | Kết quả |
|---|---|---|
| `npx jest --runInBand tests/admin-shell-session-lifecycle.test.ts` | **0** | **10/10** |
| `... tests/admin-shell-session-lifecycle + admin-shell-oidc-mount + admin-shell-router` | **0** | **41/41** — mount + router lane khác không hồi quy |
| `pnpm --filter @du/orchestrator test:unit` | 1 | **41/43 suites, 1044/1057**; 13 fail = `admin-shell-server`(8)+`platform-mount`(5) toàn `ETIMEDOUT/EADDRINUSE :555xx–56xxx` class flaky loopback đang diễn ra trên máy (retry ĐƠN LẺ: server **56/56**, platform-mount **PASS** ngay trong run solo kế) — không phải regression; ghi nhận để coordinator/Tester biết khi xếp window |
| `pnpm run lint` / `pnpm run build` | **0 / 0** | dist cập nhật |

Không commit/push; không mở DB window; không down -v. Row OIDC-04 vẫn chờ phần browser-thật
(OpenClaude/Tester) — server-side lifecycle giờ đóng kín: mint → serve → expire → revoke →
graceful re-login.

Ghi chú process: `dispatcher.ts` bị từ-chối-edit một lần vì mtime đổi giữa chu kỳ (chính các
edit cycle 96 của tôi chưa kịp re-read) — đã re-read rồi apply, không có va chạm lane khác.
Không commit/push; không tick row.

---

## W49-QW1-17 — Cycle 102: Mock OIDC IdP harness (in-process HTTP) + ES256 trong client

### A. Deliverables
- **oidc-client.ts (nâng cấp có chủ đích)**: alg policy RS256-only → **RS256 + ES256(P-256,
  chữ ký ieee-p1363 chuẩn JWT)**; `none`/HS* VẪN chặn TRƯỚC mọi key-lookup (alg-confusion
  chết); Jwk thêm crv/x/y; `assertSupportedAlg` + `verifySignature(alg,...)`; docs đổi theo.
- **`tests/stubs/mock-oidc-idp.ts` (MỚI; ngoài src program nên không vào dist)**: discovery
  RFC 8414 (issuer khớp chính xác, S256 khai báo); `/jwks` publish CẢ HAI key RS256 + ES256
  (kid mock-rs-1/mock-es-1); `/authorize` ép response_type=code + **S256 challenge bắt buộc**
  + **nonce bắt buộc** (400 nếu thiếu), code single-use, 302 trả code+state đúng redirect_uri;
  `/token` nhận client_secret_basic HOẶC form client_id, kiểm code một lần + redirect_uri +
  SHA-256(code_verifier)==challenge (sai ⇒ invalid_grant), id_token ký theo alg chọn +
  nonce/aud/exp/at_hash, access JWT đi kèm; `/revoke` + `/introspect` cho ngữ nghĩa revoke
  on-the-wire; knobs setPrincipal/setSigningAlg/setIdTokenTtl/failNextTokenEndpoint/lastIssued
  /reset/close.
- **`tests/mock-oidc-idp.test.ts` (MỚI)**: OidcClient THẬT × HTTP THẬT (loopback in-process):
  discovery/JWKS 2-alg; **full PKCE happy path** (authorize→code→exchange→verify, claims khớp);
  **ES256 happy path**; verifier sai fail; **code replay fail**; thiếu challenge/nonce ⇒ 400;
  nonce mismatch ⇒ đúng reason `nonce-mismatch`; **HS256-forged-trên-public-JWK ⇒
  `unsupported-alg`**; endpoint 503 ⇒ `upstream-http`; reset vô hiệu code cũ; revoke→introspect
  active:false trọn vòng.

### B. Receipts (offline; KHÔNG DB window — chỉ loopback HTTP trong-process)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `npx jest --runInBand tests/mock-oidc-idp.test.ts tests/oidc-client.test.ts` | **0** | **33/33** (IdP 10 + client 23 — 5 case hostile CŨ của client vẫn xanh sau khi mở ES256: không hồi quy) |
| `npx jest --runInBand tests/mock-oidc-idp.test.ts` (đơn lẻ) | **0** | **10/10** |
| `pnpm run lint` | **0** | 0 lỗi |
| `pnpm run build` | **0** | exit 0 — lưu ý: giữa chu kỳ từng fail 1 lần vì `artifacts/integrity-scanner.ts` của lane R1-A đang sửa dở (file+test của họ cùng xuất hiện, test họ còn TS2416 riêng); lane đó chốt ⇒ build tôi xanh lại mà không đụng file họ |
| `pnpm --filter @du/orchestrator test:unit` (run ĐẦU, giữa bão port) | 1 | 40/46, 1072/1090 — đỏ vì cổng loopback + file R1-A dở; |
| `pnpm --filter @du/orchestrator test:unit` (run CHỐT sau khi lane R1-A/VAULT chốt file) | 1 | **43/46 suites, 1092/1095 tests**; `artifact-integrity-scanner` (R1-A) và `mock-vault-harness` (VAULT) nay PASS. 3 fail còn lại = 3 test đơn lẻ của `admin-shell-server` (ETIMEDOUT :58766), `platform-mount` (EADDRINUSE :58835), `connector-revision-http` (fetch tới chính server lane đó) — toàn bộ là lớp cổng ephemeral loopback của máy, KHÔNG phải suite lane này fail vì logic (IdP 10/10, client 23/23 ngay trong run này). |

Kiểm chứng thêm sau run chốt: `admin-shell-server` chạy đơn lẻ VẪN fail 5/56 với các cổng
khác (`:58999/59021/59025/59063`) trong khi trước đó hôm nay từng xanh 56/56 và 93/93 —
hành vi điển hình của exhaustion cổng ephemeral loopback trên Windows khi nhiều suite
HTTP-local + docker-proxy cùng chạy; các suite cùng kiểu (mock-vault, connector-revision,
platform-mount) cũng lệch 1-5 test mỗi run. Kiến nghị cho coordinator/owner suite P6-HTTP:
(a) giãn lịch chạy các suite real-HTTP, hoặc (b) refactor dùng chung MỘT listener per-suite
thay vì per-test — quyết định thuộc owner suite đó; lane tôi không sửa file shell của lane khác.

Harness này chính là 'fake IdP' mà acceptance OIDC-01/04 mô tả — sẵn sàng cho bước browser/
mount kế tiếp (OpenClaude/Tester). Không commit/push; không tick row; không down -v.

---

## W49-QW1-18 — CYCLE 103: End-to-End OIDC-04 Integration Harness (offline, real loopback HTTP)

**Yêu cầu dispatch:** dùng `tests/stubs/mock-oidc-idp.ts` (cycle 102) viết
`tests/admin-shell-oidc-flow-integration.test.ts` test round-trip đủ 4 bước:
(1) `GET /admin/login` redirect sang `/authorize` của mock IdP với PKCE challenge hợp lệ;
(2) code đổi tại `/token` lấy ID token hợp lệ; (3) `GET /admin/oidc/callback` mint session
cookie; (4) `GET /admin` với cookie được cấp trả HTTP 200 trang Admin. Không DB window,
không commit/push.

### A. Thiết kế harness

- **Không seam giả:** suite đi qua `dispatchShellRequestAsync` (router mount cycle 100/101),
  `createOidcFlow` (cycle 98), `createSessionStore` (cycle 95) và `createOidcClient` với
  `fetchImpl` bọc **global fetch thật** — toàn bộ discovery/JWKS/authorize/token là HTTP
  loopback thật tới mock IdP. Sockets duy nhất là IdP fake (cổng ephemeral 127.0.0.1),
  zero DB/Redis/app service — đúng ranh giới 'no DB window'.
- **`recorderChallenges()`**: wrapper quanh memory challenge store THẬT, chỉ *ghi nhớ*
  bản `put(state → {verifier, nonce, ...})` để test chứng minh binding PKCE từ verifier
  server-side (`b64u(sha256(verifier)) == code_challenge` trên URL redirect) mà không
  phá tính one-shot của `consume`. Dùng cùng recorder để test (2)-component: đổi code
  thẳng qua `client.exchangeAuthorizationCode` bằng verifier đã capture — chứng minh
  `/token` chấp nhận verifier thật, rồi chính code đó quay lại callback → 403 (single-use
  fail-closed, đúng một hình dạng denial).
- **Step-2 proof tại boundary provider**: sau callback, decode `idp.lastIssued.idToken`
  — header `alg RS256`/`kid mock-rs-1`, payload `iss == idp.issuer`, `aud du-admin`,
  `sub mock-user-1`, `nonce == nonce login`, `platformAdmin true`, `at_hash` present —
  tức ID token mà flow mint session *là* token do `/token` ký và verify pass qua JWKS
  phục vụ. Có thêm biến thể **ES256** (`idp.setSigningAlg`) chạy trọn round-trip.
- **Step-4 proof**: `GET /admin` với `du_session=<43 ký tự>` → `routeId admin-root`,
  HTTP 200, `content-type text/html`, body có `<title>` (shell render), **không**
  `location`, và `idp.lastIssued` không đổi — serving chỉ đọc session store, không
  round-trip IdP. Session record assert `role admin / sub / issuer` từ verified claims.
- **Baseline + hostility glue**: anonymous `GET /admin` → 302 `/admin/login` +
  `du_session=;` swept (gate cycle 101 chạy đúng trên dữ liệu E2E thật); unknown-state
  callback → 403, không cookie.
- Test-only change: **không sửa src**, dist giữ nguyên; `beforeEach idp.reset()` cách
  ly code/principal/alg giữa các test; một listener IdP dùng chung cả suite
  (tránh thêm áp lực ephemeral-port storm đã kiến nghị cuối cycle 102).

### B. Receipts (offline; KHÔNG DB window)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/admin-shell-oidc-flow-integration.test.ts` | **0** | **7/7** (step 1 PKCE binding; step 2+3 round-trip + verified claims; ES256 variant; step 4 200-page; anonymous gate; replayed-code 403; unknown-state 403) |
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/admin-shell-oidc-flow-integration.test.ts tests/admin-shell-oidc-mount.test.ts tests/admin-shell-session-lifecycle.test.ts tests/admin-oidc-flow.test.ts tests/session-store.test.ts tests/oidc-client.test.ts tests/mock-oidc-idp.test.ts` | **0** | **7 suites, 80/80** — toàn bộ OIDC family không hồi quy |
| `pnpm run lint` (`tsc --noEmit -p tsconfig.json`) | **0** | 0 lỗi |
| `git status --porcelain du-rework/services/orchestrator` (scope kiểm tra) | 0 | chỉ `?? tests/admin-shell-oidc-flow-integration.test.ts` — src/dst không đổi |

Ghi chú 1 lỗi TS strict gặp khi dev (`m[1]` có thể `undefined` dưới
`noUncheckedIndexedAccess`) → sửa `m?.[1] ?? ''`; test-side, không phải product.

### C. Trạng thái / handoff

- Chuỗi OIDC-01→04 giờ có **bằng chứng round-trip hoàn chỉnh offline** qua fake IdP
  HTTP thật; còn lại thuộc dispatch khác: browser-thật/OpenClaude mount, Redis/DB
  SessionRepository (OIDC-02 live), tick row của coordinator. Tester vẫn chờ chạy
  `W48-QW1-LIVE-006` (kỳ vọng 12/12) trong DB window — lane tôi không mở.
- Không commit/push; không tick row; không `docker compose down -v`.

---

## W49-QW1-19 — CYCLE 108/113 (KHẨN): 2 finding reviewer về OIDC cốt lõi

### A. Finding 1 — `modules/admin-actions/rbac.ts`: thứ tự session + tenant context

**Hiện trạng sai:** `resolveAdminActionAuthAsync` gọi nguyên `resolveAdminActionAuth`
(bearer **+ legacy du_admin**) trước, rồi mới tới `du_session`. Hệ quả:
  - browser còn mang `du_admin` hợp lệ (tồn tại 8h, tự chứa, KHÔNG revoke được)
    thì resolve luôn ở plane legacy — opaque session thành trang trí;
  - **revoking một OIDC session không có tác dụng thực tế**: request vẫn được
    legacy cookie 'hồi sinh' thành admin-equivalent;
  - `AdminActionCookieAuth` không có tenant → `principalOf` trả null cho mọi cookie
    operator → `resolveOpTenant` coi null như platform-path (row-lookup) → operator
    session không những bị khóa mà còn không có đường nào đi đúng.

**Sửa (rbac.ts):**
  - Thứ tự mới: **bearer → `du_session` (store plane) → legacy `du_admin`**. Legacy
    được refactor thành `legacyCookieAuth(...)` dùng chung cho sync/async — shape
    legacy không đổi byte-for-byte, co-existence giữ nguyên (test chứng minh).
  - **Không hạ cấp ngầm:** khi store wired mà request có `du_session` (kể cả id sai
    format), MẶT BẰNG SESSION QUYẾT ĐỊNH — store trả null (expired/revoked) hoặc id
    malformed → resolver trả null (401); KHÔNG fallback du_admin. Đây là rule cùng
    chiều với shell gate cycle-101.
  - `AdminActionCookieAuth` thêm `tenantId?: string | null` — chỉ tới từ STORE
    (`sessionToActionAuth` cũng mang tenantId). Legacy không có → undefined.

**Sửa (dispatcher.ts):**
  - `operations.cancel|resume` cookieRoles `['admin','operator']`; gate cookie:
    CSRF → role table → **operator không tenant server-side = 403 'operator sessions
    must carry a server-side tenant'** (fail-closed, chạy TRƯỚC mọi service).
  - `principalOf`: operator + tenant → `{role:'tenant_operator', tenantId}` — fence
    của `resolveOpTenant` dùng tenant CỦA SESSION (foreign op → service 404 fixed,
    no echo, no audit); admin → platform như cũ. Actor audit `shell:operator`.
  - apikey.bind-profile/business.*/sweep/connectors.* vẫn admin-only với cookie.

### B. Finding 2 — `main.ts` wire OIDC khi có biến môi trường

Module mới `src/app/admin/oidc-boot.ts` (`buildOidcAdminComponents(env)`) — tên
biến theo đúng `docs/runbooks/vault-oidc-operations.md` (runbook ghi 'placeholder,
app chưa đọc' → từ cycle này app ĐỌC thật):
  - `DU_ADMIN_OIDC_ISSUER|CLIENT_ID|CLIENT_SECRET_FILE|REDIRECT_URI` (+
    `ALLOWED_ISSUERS` comma-list, `PUBLIC_ORIGIN` override — default = origin của
    redirectUri, `PKCE_METHOD` chỉ nhận S256).
  - **Thiếu hoàn toàn → null**: plane OIDC tắt, bearer + legacy giữ nguyên hành vi.
  - **Partial → ném lỗi boot**, liệt kê từng biến thiếu (không bao giờ boot nửa
    mặt-bề-identity).
  - Secret: file mounted được ưu tiên, file rỗng → fail boot (không log giá trị).
  - Trả `{ adminSessionStore, adminOidcFlow }` — main.ts truyền vào `createApp({
    ..., adminSessionStore, adminOidcFlow })`; shell mount (shell-server attach,
    cycle 100) và dispatcher route (server.ts, cycle 96) tự đọc 2 field đó — toàn
    bộ chain OIDC-04 bật mà không cần thêm wiring nào khác.
  - **Ghi chú trung thực:** session repo ở boot là memory (single-replica);
    Redis/DB SessionRepository là phần OIDC-02 còn lại — khi nào có, thay repo sau
    cùng một seam. Multi-replica trước thời điểm đó phải pin traffic admin.

### C. Receipts (offline; KHÔNG DB window)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/admin-action-dispatcher.test.ts tests/session-store.test.ts tests/oidc-boot.test.ts tests/oidc-client.test.ts tests/admin-oidc-flow.test.ts tests/admin-shell-session-lifecycle.test.ts tests/admin-shell-oidc-mount.test.ts tests/admin-shell-oidc-flow-integration.test.ts tests/mock-oidc-idp.test.ts tests/admin-audit-scope.test.ts tests/admin-idempotency.test.ts tests/admin-mutation-atomicity.test.ts` | 1 | **189/190** — fail duy nhất = `tests/oidc-boot.test.ts` live-fetch, cause `connect ETIMEDOUT 127.0.0.1:64831` (bão port đang leo thang 64xxx); cùng batch đó dispatcher 47/47, session-store 17/17 |
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc-boot.test.ts` (đơn lẻ) | **0** | **7/7** — xác nhận đỏ ở trên là environment, không phải code |
| `pnpm run lint` (`tsc --noEmit`) | **0** | 0 lỗi |
| `pnpm run build` (`tsc -p tsconfig.json`) | **0** | 0 lỗi — dist rebuild (main.ts/oidc-boot.ts vào dist) |
| `pnpm --filter @du/orchestrator test:unit` (full tree) | 1 | **46/48 suites, 1117/1126** — 9 fail TẤT CẢ là `connect ETIMEDOUT/EADDRINUSE 127.0.0.1:64xxx` tại `admin-shell-server` (8) + `admin-shell-platform-mount` (1), class bão-port cycle-102 đã kiến nghị; khi storm dịu 2 suite này chạy đơn lẻ từng xanh (lượt này solo `admin-shell-server` còn fail 19/56 ETIMEDOUT liên tiếp = storm nặng hơn theo thời gian, không phải regression — không test nào miền rbac/session liên quan) |

Test mới/cập nhật: dispatcher suite +2 describe (precedence 5 ca: both-cookies,
revoked-no-resurrection, forged-no-dodge, legacy-alone-unchanged, bearer-beats-all;
tenant-execution 6 ca: cancel/resume fence theo tenant session, foreign 404 no-echo,
legacy-operator fail-closed 0 calls, operator vẫn ngoài credential surface, CSRF
trước role), matrix +2 cell, 1 assertion cũ cập nhật theo WHY mới ('tenant' vs
'role'), session-store toEqual +tenantId, `tests/oidc-boot.test.ts` 7 ca
(gate env, missing-list, secret-file precedence + empty-file, PKCE-S256-only,
issuer-allowlist, https-policy, live handleLogin qua mock IdP).

### D. Handoff / lưu ý reviewer

- Row OIDC-02/03/04 của task board: coordinator adjudicate; lane không tick.
- Nếu Tester chạy live matrix trên deployment có cả 2 cookie, kỳ vọng ĐỔI theo
  W49-QW1-19: session plane thắng; legacy-only requests giữ nguyên 12/12.
- Bão port loopback vẫn là risk gate `test:unit` toàn cây — kiến nghị cycle-102
  (giãn lịch / one-listener-per-suite) vẫn mở, thuộc owner suite P6-HTTP.
- Không commit/push; không tick row; không `docker compose down -v`.

---

## W49-QW1-20 — ORCHESTRATOR REQUEST: Persistent Session Store (OIDC-02 Redis repository)

**Yêu cầu:** boot seam đang `createMemorySessionRepository()` (per-process) → thiết kế/
bổ sung RedisSessionRepository trên ioredis sẵn có, lưu opaque session + CSRF secret với
TTL tương ứng; giữ memory seam làm fallback test; kiểm build/lint exit 0. **Đã làm offline,
KHÔNG bật Redis thật — mọi proof chạy trên fake gateway in-process.**

### A. Thiết kế (`src/modules/auth/redis-session-repository.ts`)

- **Gateway seam tối tiểu** (`RedisSessionGateway`: get / set+EX / del(...keys) / sadd /
  srem / smembers / expire) — repository test được bằng fake in-process mà vẫn là CODE THẬT;
  production cắm `createIoredisSessionGateway(url)` adapter.
- **Key layout** namespace riêng `du:admin:sess:` — `s:<sessionId>` (STRING, JSON record,
  `EX` = giây còn lại tới **absolute** expiresAt) + `p:<sha256(len|iss|len|sub)>` (SET index).
  Hash length-prefixed giết mọi delimiter-collision từ issuer/sub do IdP kiểm soát; key cố định.
- **TTL math là tâm điểm acceptance**: store luôn ghi lại CÙNG expiresAt khi touch (idle
  trượt lastSeenAt thôi) ⇒ EX không bao giờ dài hơn cửa sổ absolute cũ — activity không gia
  hạn, và một lệnh delete lạc vẫn để key tự chết, không bao giờ 'sống dai'.
- **Fail-closed mọi đường**: id sai shape → null TRƯỚC khi chạm storage (đếm call verify);
  payload JSON hỏng/sai kiểu/id khớp key-khác/proto-poisoned → null im lặng (không throw,
  không object một nửa); `set()` từ chối id malformed (SessionError, không ghi key rác);
  record đã hết hạn vẫn được `>=1s` rồi die-on-TTL.
- **revokePrincipal cross-replica**: đọc index → lọc members qua đúng shape-gate của
  session-id (index nhiễm độc `'../../management/console'` không thể DEL ngoài namespace —
  test chứng minh key hàng xóm còn nguyên) → DEL batch, đếm kết quả thật, xóa index.
  `delete()` không SREM (không biết principal) — stale member được revoke bỏ qua và index
  tự age-out theo TTL; mọi đường đều có bound.
- **Kết nối RIÊNG, offline-queue TẮT** (`enableOfflineQueue:false`, `maxRetriesPerRequest:1`):
  Redis chết ⇒ lệnh reject ngay → dispatcher 401/500, shell gate bounce login — deny, KHÔNG
  bao giờ grant trên dữ liệu stale. Không chung socket với BullMQ (queue và identity plane
  không tranh nhau).
- **Boot seam** (`oidc-boot`): `DU_ADMIN_OIDC_SESSION_BACKEND=memory|redis` — mặc định
  memory (mọi test đơn lẻ/deployment cũ giữ nguyên); `redis` đòi `REDIS_URL` (thiếu → từ
  chối boot, không im lặng fallback); value lạ → từ chối. `components.close()` được
  main.ts gọi SAU `app.close()` trong graceful-shutdown (callback đang bay resolve xong rồi
  mới đóng connection). Barrel `src/index.ts` export đủ surface.

### B. Tests mới (12 + 4 ca) — all offline

- `tests/redis-session-repository.test.ts` (12): TTL đúng từng giây trên fake clock;
  hostile-payload matrix (9 blobs); poisoned index; delete idempotency; và **hình dạng
  acceptance OIDC-02**: HAI store (replica A/B) dùng chung MỘT gateway — create ở A
  authenticate ở B, sliding touch ở B KHÔNG gia hạn absolute (8h→7h40'), rotate ở B giết id
  cũ trên A, `revokePrincipal` ở A giết phiên sống ở B, và store thứ ba 'restart' trên cùng
  storage thấy đúng trạng thái đã revoke.
- `tests/oidc-boot.test.ts` +4: default memory không dựng gateway; backend lạ/REDIS_URL
  thiếu từ chối boot; **redis backend qua factory injected**: round-trip login→authorize→
  callback qua mock IdP THAT mint session, record nằm trong gateway với TTL `du:admin:sess:s:<id>`
  = 28800s, `close()` đóng gateway (fake.closed true).

### C. Receipts (offline; KHÔNG bật Redis/DB window — zero socket Redis)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/redis-session-repository.test.ts tests/oidc-boot.test.ts` | **0** | **23/23** (repo 12 + boot 11) |
| targeted gate 13 suites (repo, boot, dispatcher, session-store, oidc-client, flow, lifecycle, mount, integration, mock-oidc-idp, audit-scope, idempotency, atomicity) | 1 | **205/206** — fail duy nhất `mock-oidc-idp` ca đầu tiên `connect ETIMEDOUT :51801` (storm nay lan sang 5xxxx); solo retry lần 2 **10/10 exit 0** |
| `pnpm --filter @du/orchestrator test:unit` (full tree) | 1 | **46/49 suites, 1137/1142** — 5 fail TẤT CẢ `connect ETIMEDOUT 5xxxx`: admin-shell-server (3), platform-mount (1), oidc-boot live-test (1 — ca này PASS ở cả 2 run batch trước đó cùng cycle). Không fail nào là logic |
| `pnpm run lint` | **0** | 0 lỗi |
| `pnpm run build` | **0** | 0 lỗi — `redis-session-repository.js` + `oidc-boot.js` vào dist |

### D. Còn lại (cần dispatch, lane không tự mở)

- **Live 2-replica qua Redis THAT** (compose :6380) — tương đương drill Tester của
  OIDC-02: boot 2 process cùng REDIS_URL, login một bên, authenticate bên kia, restart
  không mất phiên. Offline đã chứng minh MỌI semantics phía code; phần còn lại là hạ tầng.
- **Challenge store vẫn memory**: one-shot login state chưa cross-replica (Redis GETDEL
  là bản nâng cấp cùng pattern gateway ở trên) — đã ghi rõ trong doc-comment module.
- Config hardening cho prod (TLS/ACL Redis, keyPrefix theo môi trường) thuộc row deploy.
- Không commit/push; không tick row; không `docker compose down -v`.

---

## W49-QW1-21 — ORCHESTRATOR REQUEST 121+: Redis Persistent Plane HOÀN CHỈNH (sessions + challenges) + auto-detect

**Bối cảnh:** Codex-4 đã fix `Partial<RedisOptions>` trong adapter và lint 13 projects
xanh — lane giữ nguyên sửa đó, chỉ bổ sung trên cùng module. Yêu cầu: (1) lưu cả
**CSRF/login challenge** vào Redis với TTL phù hợp; (2) `oidc-boot` dùng Redis khi có
redisUrl, memory chỉ là fallback; (3) lint/build exit 0. Offline tuyệt đối — **zero socket
Redis**: mọi proof chạy qua `FakeRedisSessionGateway` in-process (giờ thêm `getdel` atomic).

### A. `createRedisChallengeStore` (`redis-session-repository.ts`, cùng module)

- **Nó là gì**: mặt sau của `OidcChallengeStore` (oidc-flow) — `state -> {verifier, nonce,
  returnTo, expiresAt}` — thứ trước đây chỉ sống trong process nên **login multi-replica
  bị break**: replica A mint challenge, load-balancer đưa callback về B → B không biết
  state là gì → mọi login 'thỉnh thoảng 403' tùy may rủi routing.
- **Key = sha256(state)**, namespace `du:admin:chal:` — state là login secret đang bay
  qua browser; để nó plaintext làm tên key trên hạ tầng chia sẻ là tự ghi nhật ký mật
  khẩu. Test assert không key nào chứa state.
- **`consume` = MỘT lệnh GETDEL** (`getdel` thành method BẮT BUỘC của gateway seam):
  đúng một replica đọc được challenge, loser nhận null → flow ONE denial shape. Không
  cung cấp Lua fallback: Redis thiếu GETDEL thì boot fail-closed, không race hai callback.
- **TTL**: `EX = ceil((expiresAt - now)/1000)` floor 1 (mặc định flow 10 phút); hết hạn
  trong cửa sổ clock-race vẫn deny thêm một lần sau khi parse.
- **Đọc lại là validate lại** (shared storage là hostile input): verifier {43}, nonce/state
  {43}=? (`newToken` giữ padding `=`, `createPkcePair` strip — regex phân biệt đúng producer;
  đây là bug dev duy nhất của cycle, test bắt ngay vòng đầu), returnTo phải pass lại
  **đúng allowlist của sanitizeReturnTo** (charset path, không `//`, không `..`, không
  CRLF) — Redis bị poisoning không thể biến thành open-redirect hay header injection.

### B. `oidc-boot`: auto-detect, không im lang

- **Không có `DU_ADMIN_OIDC_SESSION_BACKEND`**: `REDIS_URL` present ⇒ `redis` (CẢ sessions
  CẢ challenges đi Redis — đúng ý 'co redisUrl thi dung RedisSessionRepository');
  absent ⇒ `memory` — dev/tests/unit byte-for-byte như cũ.
- Explicit value luôn thắng (`memory` force per-process kể cả khi có REDIS_URL — deployment
  quyết định, không phải may mắn; `redis` thiếu REDIS_URL → từ chối boot). Giá trị lạ → từ
  chối. Không đường nào degrade redis→memory lặng lẽ.
- `components.close()` đóng connection DUY NHẤT của plane (shutdown chain main.ts giữ
  nguyên từ -20); `src/index.ts` export thêm `createRedisChallengeStore`.

### C. Tests mới (repo 18/18, boot 11/11 — offline)

- Challenge describe 6 ca: round-trip + hashed key + one-shot; **cross-replica one-shot**
  (B consume của A → A null); TTL window; shape-gate trước storage + put refuse rác;
  poisoned-payload matrix (9 blobs, gồm returnTo `'https://evil'`, `'//evil'`, CRLF,
  `'..'`); clock-race deny.
- Boot 3 ca mới: **auto-wire khi REDIS_URL** (factory called 1, challenge nằm gateway với
  EX 600, không plaintext-state key); **explicit memory thắng REDIS_URL**; và
  **CROSS-REPLICA LOGIN acceptance**: hai `buildOidcAdminComponents` dùng chung một fake —
  A.handleLogin → browser-leg thật qua mock IdP → **B.handleCallback mint du_session** →
  session B mint AUTHENTICATE qua A → replay cùng state/code → 403 (GETDEL đã ăn);
  `close()` hai replica đóng một connection.

### D. Receipts (offline; KHÔNG DB/Redis window)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/redis-session-repository.test.ts tests/oidc-boot.test.ts` | **0** | **29/29** (repo 18 + boot 11) |
| targeted gate 13 suites (toàn bộ admin/oidc/session family) | **0** | **215/215** — không flake lần nào |
| `pnpm --filter @du/orchestrator test:unit` (full tree) | **0** | **49/49 suites, 1151/1151 tests** — xanh TUYỆT ĐỐI toàn cây, storm dịu; xác nhận không hồi quy mọi lane |
| `pnpm run lint` | **0** | 0 lỗi |
| `pnpm run build` | **0** | 0 lỗi — dist có challenge store + auto-detect |

Ghi chú trung thực: (1) dev bug duy nhất là regex state quên `=` padding — test fail
vòng đầu, sửa một dòng; (2) `enableOfflineQueue:false` adapter Codex-4 giữ nguyên —
lane xác nhận lại đúng semantics fail-closed khi chạy live.

### E. Handoff

- Row OIDC-02 giờ đủ điều kiện adjudicate phía code; **live drill 2-replica qua Redis
  that** (compose :6380) vẫn cần dispatch + window riêng — mọi semantics đã pinned offline.
- Challenge store Redis hóa làm remainder 'login replica-affine' trong -20 biến mất.
- Không commit/push; không tick row; không `docker compose down -v`.

---

## W49-QW1-22 — ORCHESTRATOR REQUEST (re-send): 'Execute Redis session repo' — RE-VERIFIED, KHONG MAI CODE

Yeu cau nay trung nội dung daemon giao W49-QW1-21 (challenge Redis store + oidc-boot
ngat REDIS_URL + gate xanh). Lane KIEM TRA LAI hiên trạng thay vi lam lai:

- grep xác nhận đủ 5 thành phân trong source hiên tai: `createRedisChallengeStore`,
  `getdel` (8 điểm — seam + adapter + fake + tests), dong auto-detect
  `redisUrl.length > 0 ? 'redis' : 'memory'` trong oidc-boot, boot dung challenge store
  Redis, và **fix `Partial<RedisOptions>` của Codex-4 vẫn nguyên** — lane không giẫm.
- Gate theo đúng lệnh dispatch:

| Lệnh | Exit | Kết quả |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **0** | 0 lỗi |
| `pnpm run build` (`tsc -p`) | **0** | dist rebuild |
| batch 5 suites (repo 18, boot 11→14 tests sau auto-detect, session-store, flow, lifecycle) | 1 | **64/66** — 2 fail `ETIMEDOUT/EADDRINUSE 127.0.0.1:53997` (class storm, port tang đơn diêu 53997→54020→54451 = process khác đang an ephemeral port NOW)
| retry batch 3 suite loopback (boot + mock-oidc-idp + integration) | 1 | **30/31** — fail DI CHUYỂN sang suite khac (`:54451`) = chác chan environment, không phai logic |
| retry 2 cung batch | **0** | **31/31 x 3 suites** — xanh sach |

Ket luan: OIDC-02 code-side KHONG CON viec gì mở; flakiness loopback vẫn la issue moi
trung cua may (kien nghi cycle-102/108 van mở, thuộc owner suite P6-HTTP). Live drill
2-replica qua Redis that + tick row cho coordinator/Tester dispatch.
- Không commit/push; không tick row; không `docker compose down -v`.

---

## W49-QW1-23 — ORCHESTRATOR REMINDER (lần 3, same item): RE-EXPORT + GATE RE-CONFIRM

Nhan nhac thu ba cho dung hang muc 'RedisSessionRepository + oidc-boot'. Lan nay
themi MỘT thay doi that dung nghia đen cua ly do 'export vao oidc-boot.ts':

- `src/app/admin/oidc-boot.ts` **re-export** toàn bộ surface Redis repo
  (`createRedisSessionRepository`, `createRedisChallengeStore`,
  `createIoredisSessionGateway`, `type RedisSessionGateway/…Options`) — oidc-boot giờ
  la DIEM TICH HOP duy nhat cho persistent admin-identity plane; consumer tu wiring
  (dev fake, Postgres repo tương lai) không phải với vào modules/auth internals.
  Barrel `src/index.ts` vẫn export trực tiếp song song (không phá API cũ).
- Gate: `npx tsc --noEmit -p tsconfig.json && pnpm run lint && pnpm run build` → **exit 0**
  (một chain liền); tests 4 suites **55/56** — fail duy nhất la ca live-fetch của boot
  voi `connect ETIMEDOUT :55589` (storm port Van tang đơn diêu 53997→54451→55589 qua
  các run), re-run don le boot **14/14 exit 0** — trong đó ca
  'CROSS-REPLICA LOGIN' pass.
- TRẠNG THÁI HÀNG MỤC (đề coordinator đóng loop nhắc): sessions+challenges Redis ✓,
  TTL absolute ✓, GETDEL one-shot ✓, auto-detect REDIS_URL ✓, close trong shutdown ✓,
  re-export boot ✓, tsc/lint/build 0 ✓, offline tests xanh ✓. CHI CÒN: live drill
  2-replica qua Redis that (can window + dispatch rieng — lane không tự mở) và tick
  row (coordinator adjudicate).
- Không commit/push; không tick row; không `docker compose down -v`.

---

## W49-QW1-25 — CYCLE 126+ / REVIEWER FINDING 3 (HIGH): OIDC-02 multi-replica scenario pack + Tester-1 live guard

### A. Tích hợp `oidc-boot` — XÁC MINH NGUYÊN VẸN, không code lại

Grep + đọc thân `buildOidcAdminComponents`: auto-detect `REDIS_URL` ⇒ Redis backend cho
CẢ `createRedisSessionRepository` + `createRedisChallengeStore` (shared gateway,
`sessionClose` vào components, shutdown chain main.ts đóng SAU `app.close()`),
`DU_ADMIN_OIDC_SESSION_BACKEND` explicit thắng, memory giữ vai trò fallback dev/test,
re-export surface từ oidc-boot (W49-QW1-23) — đủ nghĩa 'hoàn thiện tích hợp khi có
REDIS_URL'. Fix `Partial<RedisOptions>` của Codex-4 vẫn nguyên.

### B. `tests/oidc02-multi-replica-offline.test.ts` — scenario pack theo đúng 3 từ của reviewer

**SHARE** (2 ca): (1) mint trên replica A → `resolveAdminActionAuthAsync` chạy trên
replica B TRẢ VỀ `{kind:'cookie', role:'operator', tenantId:'T-42', csrfOk:true}` — tức
cả chuỗi dispatcher-authentication cross-replica (CSRF sai → csrfOk:false để gate quyết;
unknown id → null); (2) logout trên B chết ngay trên A, destroy idempotent cross-replica.

**REVOKE** (3 ca): hai session của CÙNG principal do hai replica mint → `revokePrincipal`
trên A = 2, B không còn gì, principal khác **sống nguyên** (surgical); revoked chết qua
'restart' (mọi store object bị vứt, store mới trên cùng gateway không hồi sinh); principal
bị revoke ĐĂNG NHẬP MỚI bình thường (revoke giết session, không blacklist).

**EXPIRY** (3 ca): (1) absolute — touch giữa chu kỳ trên replica KHÁC chỉ còn TTL đúng
PHẦN BỜ (fake Redis assert 600s sau 10', không reset 1200s), quá deadline chết dù hoạt động;
(2) idle — `lastSeenAt` CHUNG: A tạo, B chạm lúc 9', 15' vẫn sống (mới chạm 6'), 26' evict;
(3) Redis-native: không một reader nào, key vẫn tự biến mất theo EX — cluster idle tự dọn.

**LOAD BALANCER** (1 ca): 4 replica đọc xoay vòng = ĐÚNG MỘT key, `lastSeenAt` mới nhất
cho mọi người, destroy một lần chết cả 4.

### C. Guard `DU_LIVE_INFRA` cho Tester-1 (yêu cầu 'có thể … gán guard')

- Block cuối file: `(LIVE ? describe : describe.skip)` với `LIVE = process.env.DU_LIVE_INFRA === 'true'`.
  Offline: **3 ca SKIPPED — zero socket**, không đụng 5433/6380 (tuân thủ lệnh dispatch; mọi
  proof offline chạy trên `FakeRedisSessionGateway`).
- Tester-1 chạy: `set DU_LIVE_INFRA=true` + `set REDIS_URL=redis://127.0.0.1:6380` rồi
  `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc02-multi-replica-offline.test.ts`
  → cùng hình SHARE/REVOKE/EXPIRY trên **Redis thật**, đồng hồ thật (idle 1.5s/absolute 3.2s
  chọn số để hai verdict tách bạch nguyên nhân), `createIoredisSessionGateway` thật.
- Vệ sinh hạ tầng chung: `keyPrefix` **ngẫu nhiên theo run** (`du:admin:sess:live-it-<hash>:`),
  cleanup bằng DEL tường minh các key đã track, **không FLUSHDB/SCAN** — key lane khác trên
  cùng server bất khả xâm phạm về mặt cấu trúc.

### D. Receipts (offline; KHÔNG kết nối 5433/6380)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc02-multi-replica-offline.test.ts` | **0** | **9 passed + 3 skipped** (live guard) |
| family 6 suites (pack, repo, boot, session-store, dispatcher, lifecycle) | **0** | **123 passed + 3 skipped** |
| `npx tsc --noEmit -p tsconfig.json` | **0** | 0 lỗi |
| `pnpm run build` | **0** | 0 lỗi |
| full tree run 1 | 1 | 44/50, 1131 passed/29 fail — tất cả `59xxx` connect class (storm tăng dần 53k→59k trong ca trực) |
| full tree run 2 (retry) | 1 | **47/50, 1155 passed, 5 fail** — `admin-shell-server`(3)+`platform-mount`(1) connect ETIMEDOUT/EADDRINUSE; `webhook-error-boundaries` 1 ca 'assertion' BỊ NGHI NGỜ → điều tra: **solo re-run 32/32 exit 0** = collateral của fetch loopback timeout trong-tree, không phải logic |

Lane một lần nữa nhắc kiến nghị cũ (cycle-102/108): các suite real-HTTP cần MỘT listener
chung hoặc giãn lịch — storm loopback đang làm gate toàn cây nhiễu theo giờ.

### E. Handoff

- Finding 3 phía code: ĐỦ. Phần Tester-1: chạy block `DU_LIVE_INFRA` ở trên khi được
  dispatch window (Redis :6380 là của window đó — lane không tự chạm).
- Không commit/push; không tick row; không `docker compose down -v`.

---

## W49-QW1-26 — FINDING 3 RE-SEND (cycle 126+ lần 2): RE-VERIFIED, ĐÓNG HÀNG MỤC

Orchestrator gửi lại ĐÚNG nội dung đã giao ở W49-QW1-25 (văn bản gần như nguyên văn,
câu 'hoặc' → 'và' cho mock/guard — lane đã làm CẢ HAI chiều). Không code lại;
xác minh nguyên trạng + lấy receipts mới cho cycle này:

| Hạng mục dispatch | Trạng thái | Bằng chứng (mới, cycle này) |
|---|---|---|
| Hoàn thiện tích hợp RedisSessionRepository vào `app/admin/oidc-boot.ts` khi có REDIS_URL | ĐÃ CÓ | grep: `backend = backendRaw \|\| redisUrl.length > 0 ? 'redis'` + `repo = createRedisSessionRepository(gateway)` + `challenges = createRedisChallengeStore(gateway)` (lines 145/159/163) |
| Test 2-replica: SHARE | ĐÃ CÓ | pack PASS — mint A, resolver B trả role+tenant+CSRF thật |
| Test: REVOKE | ĐÃ CÓ | pack PASS — revokePrincipal cross-replica + qua 'restart' + không blacklist |
| Test: EXPIRY | ĐÃ CÓ | pack PASS — absolute-not-extended, idle shared-lastSeenAt, Redis-native TTL |
| Mock Redis offline **và** guard DU_LIVE_INFRA cho Tester-1 | ĐÃ CÓ | 9 passed + 3 skipped (describe.skip offline, zero socket) |
| Chạy offline test suite | **exit 0** | pack+repo+boot+session-store: 57 passed/3 skipped, 1 flake boot live-fetch `ETIMEDOUT :60102` (storm 60xxx) → solo **14/14 exit 0** |
| `npx tsc --noEmit` + lint + build | **exit 0** | chain một lệnh, 0 lỗi |
| Không kết nối 5433/6380 | TUÂN THỦ | mọi proof offline chạy `FakeRedisSessionGateway` in-process; block live chỉ mở khi Tester-1 set `DU_LIVE_INFRA=true` |

Đề nghị coordinator: **đóng Finding 3 phía code**, chuyển phần còn lại thành task
Tester-1 (chạy block guard trong window Redis của họ — lệnh in ngay đầu file
`tests/oidc02-multi-replica-offline.test.ts`). Lane không tick row, không commit/push.

---

## W49-QW1-27 — CYCLE 138 (Reviewer audit 132-137): harness OIDC-02 cho SEPARATE-PROCESS replicas

### A. Fixture mới: `tests/fixtures/oidc02-replica-harness.ts`

Fixture-only (KHÔNG match `testMatch` nào của jest → không thể collect, không phá suite
cũ — đúng ràng buộc 'design/fixture offline'). Nội dung:

- **Replica = component graph hoàn toàn mới** — mỗi replica tự có `OidcClient`,
  `createSessionStore`, `createRedisSessionRepository`/`createRedisChallengeStore` trên
  gateway CHUNG, `createOidcFlow`, `ShellRuntimeConfig` riêng — đúng bộ mà
  `buildOidcAdminComponents` dựng cho MỖI process thật. Hai replica không chia sẻ object
  JavaScript nào ngoài (a) Redis gateway và (b) mock IdP: mọi hiệu ứng cross-replica đi
  qua STORAGE — điểm mà các test store-pair in-process hiện tại chưa chứng minh được
  (chúng chia đường code store, không chia bề mặt HTTP/cookie).
- **`SEC00` constants** = một identity plane duy nhất theo runbook (clientId,
  clientSecret, publicOrigin, redirectUri) — các replica BUỘC đồng ý mọi giá trị; issuer
  tới từ IdP được inject.
- Helpers browser-shaped, tất cả qua ROUTER THẬT `dispatchShellRequestAsync`:
  `loginAt / authorizeAtIdp / callbackAt / visit / logoutAt / sidFrom`.
- **Live-extension contract (Tester-1)** — 5 bước ghi thẳng trong doc-header fixture:
  (1) đổi gateway sang `createIoredisSessionGateway(REDIS_URL)`; (2) mỗi replica một
  process `node` con chạy probe gọi `makeReplica()` + `startAdminShell` trên hai port
  loopback riêng; (3) giữ nguyên helpers nhưng bắn HTTP thay vì dispatch in-process
  (chuyển set-cookie verbatim); (4) giữ SEC00, riêng issuer/secret theo deploy; (5) gate
  `DU_LIVE_INFRA=true` đúng pattern pack cũ. Không FLUSHDB/SCAN — key namespace riêng.

### B. Suite mới: `tests/oidc02-process-replicas-offline.test.ts` — đủ 5 mục reviewer

1. **Callback + cookie cross-process**: login phát động ở A, callback hoàn thành ở B
   (LB đổi chiều), cookie B mint phục vụ 200 trên CẢ HAI router; assert SEC-00 plane
   giống hệt trên cả 2 authorize URL; challenge A để ngỏ bị B ăn bằng GETDEL — A replay
   callback → 403 một hình dạng.
2. **Cookie logout cross-process**: logout ở B → 302 + `du_session=;` quét, và server-side
   A NHÌN THẤY chết (`a.store.get → null`, visit A → 302 gate bounce, không stale-200).
3. **Rotation cross-process**: `rotate` ở B — cookie CŨ chết trên cả hai, cookie MỚI sống
   trên cả hai (fixation defense có hiệu lực toàn cluster, không chỉ trong process mint).
4. **Restart + revoke**: revoke trước khi 'restart' → chết vĩnh viễn qua 2 thế hệ replica
   mới; login mới → 2 process mới (a3/b3) vẫn serve = persistence đúng nghĩa shared store.
5. **Expiry toàn cluster (đồng hồ THẬT, window ngắn)**: absolute 1.6s — hết hạn thì MỌI
   replica 302 (activity không mua được sự sống); idle 1.2s/absolute 60s — B chạm lúc
   0.7s thì A còn serve tới 1.4s (lastSeenAt dùng CHUNG qua storage), im lặng 1.4s → cả
   hai cùng 302.

### C. Receipts (offline; KHÔNG DB window, KHÔNG chạm 5433/6380)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc02-process-replicas-offline.test.ts` | **0** | **6/6 ngay lần chạy đầu** (2 ca expiry canh timing thật, margin 150-700ms) |
| family 8 suites (harness mới + pack + repo + boot + integration + lifecycle + session-store + flow) | 1 | **91 passed + 3 skipped**; 1 flake = boot live-fetch `ETIMEDOUT :54152` (suite CŨ, class storm) → solo retry **14/14 exit 0** |
| `npx tsc --noEmit -p tsconfig.json && pnpm run lint && pnpm run build` | **0** | chuỗi một lệnh, 0 lỗi — fixture/suite mới nằm ngoài tsconfig build (tests/) nên build không đụng; jest compile sạch |
| Kiểm tra 'không phá suite hiện tại' | — | fixture KHÔNG khớp testMatch (`*.test.ts`); jest collectModules chỉ import khi suite chạy; 8 suite láng giềng xanh ở trên |

Ghi chú trung thực: section báo cáo này append LẦN HAI — lần append đầu tool trả
'success' nhưng grep sau đó không thấy nội dung trong file (nghi ngờ race editor
ngoài lane trên `qwen1.md`); đã xác minh bằng `grep W49-QW1-27` trước/sau và giữ
bản có thật này. Đề nghị coordinator nếu audit file thấy duplicate heading thì xóa
block cũ rỗng.
- Không commit/push; không tick row; không `docker compose down -v`.


---

## W49-QW1-28 — CYCLE 138 (tiếp): block live HAI PROCESS THẬT (gate `DU_LIVE_INFRA='1'`)

### A. Deliverables

1. **`tests/fixtures/oidc02-replica-probe.js`** (mới, plain JS — jest không collect,
   node thường chạy được từ `dist/`): MỖI process = MỘT replica thật — server loopback
   cổng ephemeral trước `dispatchShellRequestAsync` của router PRODUCTION (dist),
   component set bản sao đúng nhánh redis của `buildOidcAdminComponents`:
   `createIoredisSessionGateway(REDIS_URL)` + `createRedisSessionRepository` +
   `createRedisChallengeStore` (keyPrefix riêng theo run — không FLUSHDB/SCAN, không đụng
   key lane khác), `createOidcClient`/`createSessionStore`/`createOidcFlow`
   (`PROBE_ABS_MS`/`PROBE_IDLE_MS` cho cửa sổ expiry ngắn). Cookie `du_session` đi lại
   nguyên văn giữa hai process. Control surface `/__probe/{session,rotate,revoke}` chắn
   bằng `x-probe-token`; handshake stdout `LISTENING <port>`; SIGTERM → đóng server +
   gateway. Yêu cầu `pnpm run build` trước (boot từ dist/) — ghi ngay trong runbook.
2. **Block live trong `tests/oidc02-process-replicas-offline.test.ts`** — gate
   `process.env.DU_LIVE_INFRA === '1'` (kèm 'true' tương thích pack chị em); offline là
   `describe.skip` ⇒ **zero child, zero kết nối Redis, zero handle**. `beforeAll` spawn
   HAI probe (chờ `LISTENING`; fail-fast kèm thông điệp nếu dist/ chưa build hoặc
   REDIS_URL không tới được). Bốn scenario đúng danh sách reviewer:
   - **mint/resolve**: login ở A, callback rơi vào B qua HTTP thật, cookie B mint được
     CẢ HAI process serve 200 + `/__probe/session live:true role:admin`;
   - **logout tại B**: 302 + `du_session=;`, A thấy `live:false` và bounce 302
     (server-side, cross-process);
   - **rotation qua B**: cookie cũ chết trên CẢ HAI process, cookie rotated sống trên
     CẢ HAI;
   - **expiry đồng hồ thật**: idle 5s — im lặng 5.6s ⇒ 302 trên mọi process.
   Runbook Tester-1 in thẳng trong block: build → `set DU_LIVE_INFRA=1` →
   `set REDIS_URL=redis://127.0.0.1:6380` → chạy đúng file này.

### B. Bằng chứng offline (lane KHÔNG tự mở :5433/:6380)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `node --check tests/fixtures/oidc02-replica-probe.js` | **0** | SYNTAX_OK |
| smoke wrapper: probe tự boot với mọi sink trỏ `127.0.0.1:9` (cổng discard, không phải hạ tầng app) | **0** | `/admin/login` → **500 fail-closed** "Stream isn't writeable and enableOfflineQueue options is false" — đúng semantics Redis chết: deny tức thì, không treo; `/__probe/session` → 200 `{live:false}` (token check hoạt động); SIGTERM thoát sạch, wrapper exit 0 — TOÀN BỘ đường code probe đã chạy thật, offline |
| `pnpm … test:unit -- --runTestsByPath tests/oidc02-process-replicas-offline.test.ts` | **0** | **6 passed + 4 skipped**; jest thoát sạch, không warning open-handle |
| pair với pack chị em (retry sau 1 flake) | **0** | **19 passed + 7 skipped** |
| `npx tsc --noEmit && pnpm run lint && pnpm run build` | **0** | marker TSC_OK/LINT_OK/BUILD_OK |

Ghi chú: flake duy nhất giữa cycle (1 ca offline `ETIMEDOUT :55512` vào mock IdP) —
class storm đã ghi nhận nhiều cycle, retry xanh, không phải code.

### C. Ý nghĩa với row OIDC-02

- Kịch bản reviewer nêu ('separate-process replicas với callback/cookie logout,
  rotation và restart/expiry trên shared store theo SEC-00 issuer/origin config') giờ
  có ĐỦ hai tầng: offline trong unit-gate (chạy mỗi cycle) và live-2-process khi Tester-1
  bật công tắc — cùng bộ scenario, cùng fixture contract (W49-QW1-27).
- Không có đường nào để block live chạy nhầm trong gate offline (describe.skip +
  require động child_process chỉ trong hook).
- Không commit/push; không tick row; không `docker compose down -v`; lane không kết nối
  5433/6380.

---

## W49-QW1-29 — CYCLE 139: PACKET LIVE CHO TESTER-1 (`W49-QW1-LIVE-001` đã nộp docs/29)

**Yêu cầu:** reviewer cần biên nhận live 2-process real-Redis của 4 ca gated (được xác
định chính xác tại `tests/oidc02-process-replicas-offline.test.ts` **dòng 176→331**,
bốn `it()` ở 288/300/311/322). Lane CHUẨN BỊ packet + lệnh; KHÔNG tự mở window/
:6380.

**Packet đã nộp** — `du-rework/docs/29-run-request-queue.md` mục
`## W49-QW1-LIVE-001 RUN REQUEST — OIDC-02 live 2-PROCESS, real Redis :6380`:

- Lệnh chính xác (cwd `du-rework\services\orchestrator`):
  1. `docker compose ps` (Redis :6380 UP — không restart, không down -v)
  2. `pnpm run build` (probe boot từ dist/ — build cũ = boot lỗi)
  3. `set DU_LIVE_INFRA=1`
  4. `set REDIS_URL=redis://127.0.0.1:6380`
  5. `pnpm run test:unit -- --runTestsByPath tests/oidc02-process-replicas-offline.test.ts`
- **Literal kỳ vọng**: `Test Suites: 1 passed, 1 total` + **`Tests: 10 passed, 10 total`**
  (0 skipped; còn `4 skipped` = env chưa vào shell — xem checklist Troubleshooting trong packet).
- Vệ sinh: key namespace run-scoped TTL ≤600s tự hết hạn, cleanup bởi revoke nội bộ +
  SIGTERM children trong afterAll; không FLUSHDB/SCAN; không đụng key lane khác.
- Troubleshooting 4 nhánh (thiếu build / Redis chết fail-closed / gate env thiếu / storm
  flake loopback) — vẫn đỏ thì trích raw, không sửa product theo test.

**Kiểm định trước khi phát hành (lane, offline):**

| Kiểm | Kết quả |
|---|---|
| Định vị dòng reviewer nêu | khớp: block 176→331, 4 it() 288/300/311/322 (grep line-exact) |
| Dry-run lệnh #5 từ cwd package, KHÔNG env | `6 passed + 4 skipped` exit 0 — đúng trạng thái 'gate chưa bật' packet mô tả |
| Chữ ký packet vs format docs/29 | theo khuôn W48-QW1-LIVE-006 (mục run-request, routing, literal) |
| Không chạm hạ tầng | lane không chạy bước nào có :6380/:5433 |

- Không commit/push; không tick row; không `docker compose down -v`.
- Chờ: Tester-1 claim window chạy W49-QW1-LIVE-001; raw output vào reports/tester.md,
  lane đối chiếu vào đây khi có biên nhận.

---

## W49-QW1-30 — CYCLE 139 FOLLOW-UP: FIX ROOT-CAU Tester-1 (8/10 → harness retry tầng mạng)

**Biên nhận Tester-1 (W49-QW1-LIVE-001):** `8/10 passed, 0 skipped` — 3/4 ca live
(logout, rotation, expiry) PASS trên 2 process + Redis thật; 2 ca fail CÙNG một
nguyên nhân: `connect ETIMEDOUT 127.0.0.1:<port>` khi fetch OIDC discovery/tới mock
IdP (ca live mintLive nhận 500 vì child A timeout sang IdP). Đây đúng class bão port
loopback đã ghi nhận nhiều cycle — nhưng nó nằm trên ĐƯỜNG CRITICAL của acceptance, nên
harness phải tự lành thay vì đỏ cả packet.

**Fix (đúng 2 file reviewer chỉ định + wiring):**

1. `tests/fixtures/oidc02-replica-harness.ts` — thêm `fetchWithRetry` (exported):
   - CHỈ retry tầng MẠNG (`err.cause.code`), KHÔNG bao giờ retry theo HTTP status —
     mọi 5xx fail-closed (kể cả semantics Redis-chết) trả nguyên văn lần đầu.
   - GET/HEAD: `ETIMEDOUT|ECONNREFUSED|EADDRINUSE|ECONNRESET|EPIPE`; POST: chỉ
     `ETIMEDOUT|ECONNREFUSED|EADDRINUSE` — những mã chứng minh request CHƯA được giao,
     nên auth-code one-shot không thể bị retry tiêu phí hai lần.
   - Backoff 150/300/600ms, 4 attempts; `fetchImpl` của client (discovery/JWKS/token)
     và `authorizeAtIdp` đều đi qua nó.
2. `tests/fixtures/oidc02-replica-probe.js` — `retryFetch` nội dòng CÙNG policy (JS
   thuần, child process); `fetchImpl` của probe (leg discovery child→IdP — đúng chỗ
   Tester-1 chết) giờ tự lành qua storm.
3. `tests/oidc02-process-replicas-offline.test.ts` — mọi leg của live block
   (`get/post/probeCall/mintLive idpLeg`) chuyển sang `fetchWithRetry`.

**Verify (lane, offline):**

| Lệnh | Exit | Kết quả |
|---|---|---|
| `node --check` probe | **0** | SYNTAX_OK |
| 4 suites offline (2 pack + integration + mock-oidc-idp) | **0** | **36 passed + 7 skipped** — happy-path không đổi hành vi |
| smoke probe với sink discard `:9` | **0** | `/admin/login` vẫn **500 fail-closed** nguyên văn (retry không che lỗi Redis/Idp chết), control route 200, thoát sạch |
| `npx tsc --noEmit && pnpm run lint && pnpm run build` | **0** | TSC_OK/LINT_OK/BUILD_OK |

**Sự cố giữa đường (KHÔNG thuộc lane, đã xử lý đúng quy tắc):** chain tsc fail
`TS2305: @du/contracts has no exported member 'matchesVaultAccountPath'` — src của
contracts (file `src/vault.ts:134`, lane connector-credentials thêm) đã có nhưng
`dist/` cũ. Lane CHỈ rebuild `pnpm --filter @du/contracts build` (đồng bộ dist — tiền
lệ đã ghi các cycle trước), KHÔNG sửa source lane khác.

**Yêu cầu phát hành lại:** Tester-1 chạy lại **W49-QW1-LIVE-001 y nguyên 5 lệnh** trong
docs/29 (build → set DU_LIVE_INFRA=1 → set REDIS_URL → `pnpm run test:unit --
--runTestsByPath tests/oidc02-process-replicas-offline.test.ts`). Kỳ vọng literal:
`Tests: 10 passed, 10 total`, 0 skipped, 0 failed. Still-red ⇒ trích raw; retry chỉ
chữa storm, không chữa gì khác và không nới semantics.
- Không commit/push; không tick row; không `docker compose down -v`; lane không tự mở
  window.

---

## W49-QW1-31 — CYCLE 139 (tiếp 2): MOCK-IDP WARM-UP + IPv4/keep-alive cứng hóa (Tester-1 re-send)

Báo cáo Tester-1 gửi lại NGUYÊN VĂN (8/10, hai fail ETIMEDOUT discovery) — khả năng cao
chạy TRƯỚC bản vá retry W49-QW1-31. Lane giữ nguyên retry đã giao VÀ bổ sung đúng hai
ý reviewer nêu ('warm-up trước' + 'keepAlive false / localhost fallback'):

**A. `tests/stubs/mock-oidc-idp.ts` — warm-up trong chính `startMockOidcIdp()`:**
- Sau `listen`, server TỰ probe `GET /.well-known/openid-configuration` trên chính
  socket của nó — tối đa 3 lần × 1,2s (AbortSignal) + backoff 150/300ms (≤ ~4,1s worst,
  nằm dưới hook budget 5s của jest). Chỉ khi listener THẬT SỰ trả 200 mới `return api`;
  mọi suite/con trỏ nào cũng nhận một IdP đã chứng minh nhận connection.
- Không ấm → đóng server và NÉM LỖI HÀNH ĐỘNG: 'loopback appears congested… retry the
  run; do not treat as product behavior' — thay vì để downstream chết bằng 500 khó hiểu.
- Vì warm-up nằm trong stub, NÓ BẢO VỆ MỌI người tiêu dùng: mock-oidc-idp, boot,
  integration, pack chị em, và cả child probe của live block (con gọi IdP sau khi parent
  đã boot xong stub ⇒ listener đã ấm từ lâu).

**B. IPv4 tường minh + kill keep-alive socket cũ:**
- `server.keepAliveTimeout = 500` — socket idle nối-giữ chết sau 0,5s, hết cảnh fetch sau
  bấu vào connection đã thiu trên Windows.
- AUDIT 'localhost fallback': mọi địa chỉ KẾT NỐI thật trong harness/probe/test đã là
  `http://127.0.0.1:<port>` từ `idp.url`/`ProbeChild.port` — KHÔNG nơi nào resolve
  'localhost' qua DNS (Node 17+ có thể ưu tiên ::1 trong khi socket chỉ bind 127.0.0.1 —
  hazard Windows kinh điển). Các chuỗi ':2023/localhost' còn lại chỉ là ORIGIN/redirect
  constants (SEC-00), không có fetch nào nhắm vào chúng. ⇒ không cần dispatcher/agent
  tùy biến; fetch + retry + warm-up đủ đóng học thuyết này.

**Receipts (offline):**

| Lệnh | Exit | Kết quả |
|---|---|---|
| 5 suites tiêu dùng stub (mock-oidc-idp, process-replicas, pack, integration, boot) | **0** | **50 passed + 7 skipped** — warm-up chạy ở MỖI beforeAll, không suite nào chạm trần 4,1s |
| `npx tsc --noEmit && lint && build` | **0** | TSC_OK/LINT_OK/BUILD_OK |

**Phát hành lại:** Tester-1 chạy LẠI W49-QW1-LIVE-001 (docs/29) với 5 lệnh NGUYÊN VĂN —
nay mang cả 3 lớp chống storm: retry tầng mạng (chỉ pre-delivery), warm-up có chứng
minh 200, keep-alive/IPv4 cứng hóa. Literal kỳ vọng không đổi: `Tests: 10 passed, 10
total`, 0 skipped. Still-red ⇒ trích raw — nếu raw còn hiện ETIMEDOUT nghĩa là storm
vượt cả retry budget (nâng `attempts` là旋钮 duy nhất được phép chạm, vẫn không đổi
semantics).
- Không commit/push; không tick row; không `docker compose down -v`; lane không tự mở
  window.

---

## W49-QW1-32 — CYCLE 139 (tiếp 3): ROOT-CAUSE THẬT CỦA mintLive 500 — COLD-CONNECT RACE, SỬA TẬN 3 TẦNG

**Chẩn đoán Tester-1 (đúng; lane nhận sai một phần ở -31):** 500 không phải bão port mà
là **race cold-connect**: `createIoredisSessionGateway` trả gateway NGAY, ioredis còn đang
TCP handshake; `enableOfflineQueue:false` ⇒ command ĐẦU TIÊN của request
`/admin/login` đầu tiên (`challenges.put`) reject tức thì *'Stream isn't writeable and
enableOfflineQueue options is false'*. Lane từng thấy đúng thông điệp này ở smoke test
(sink `:9` — Redis chết THẬT) và diễn giải 'fail-closed khi Redis chết' — ĐÚNG cho ca
đó nhưng **che mất bug race** ở môi trường Redis sống. Ghi nhận tinh thần audit của
Tester-1 vào đây.

**Fix tận gốc — `ready()` đã có trong adapter nhưng KHÔNG AI await; nay nối 3 tầng:**
1. **Probe** (`tests/fixtures/oidc02-replica-probe.js`): `await gateway.ready();` ngay
   sau tạo gateway, TRƯỚC `server.listen` — child chỉ báo `LISTENING` khi identity plane
   ĐÃ ẤM; Redis không bao giờ ready ⇒ adapter reject sau 10s ⇒ child exit `PROBE_ERROR`
   (fail lúc boot, loudly) thay vì 500 giữa test.
2. **Production boot** (`oidc-boot` + `main.ts`) — CÙNG race tồn tại ở main: redis branch
   expose `OidcAdminComponents.ready?()` (memory/gateway-không-ready ⇒ undefined);
   `main.ts` `await oidcAdmin.ready?.()` TRƯỚC `app.listen()` — không request nào móe được
   cắm vào plane lạnh; không ready trong budget ⇒ startup THẤT BẠI exit 1 (fail-closed,
   không half-armed).
3. **Adapter hardening** (`redis-session-repository.ts`): `client.on('error', noop)` toàn
   cục (ioredis phát 'error' mỗi reconnect fail; không listener ⇒ EventEmitter NÉM
   UNCAUGHT, có thể hạ process khi Redis chập chờn — command sites vẫn reject riêng, giữ
   nguyên fail-closed); `close()` cứng: ready ⇒ quit, ngược lại ⇒ disconnect, exception ⇒
   disconnect — shutdown không treo trên client chưa nối.

**Tests mới:** adapter 2 ca offline-safe — (1) `ready()` với sink `:9`: tôn trọng đủ
budget ~10s rồi REJECT đúng thông điệp, `close()` hoàn tất <2s, process sống sót mọi
reconnect-error; (2) seam `ready?()` optional — fake không-ready vẫn dùng repo bình
thường. Boot 2 ca — memory ⇒ `ready` undefined; redis + gateway-co-ready ⇒ expose đúng
1 call, plane vẫn serve sau ready, `close()` đóng. Ghi chú minh bạch: interface +
adapter `ready()` đã có sẵn trong file từ một edit song song nào đó (không phải của
lane trong các cycle trước) — lane CHỈ nối consumer, không sửa lại phần đó; test ban
đầu fail TS2339 (`fake.ready`) → cast qua interface, xanh.

**Receipts:** 7 suites gate (repo, boot, process-replicas, pack, session-store,
mock-oidc-idp, integration) **89 passed + 7 skipped, exit 0** (repo suite giờ ~12s vì
ca budget 10s — CÓ CHỦ ĐÍCH) · `node --check` probe OK · `npx tsc --noEmit && lint &&
build` **TSC_OK/LINT_OK/BUILD_OK** · docs/29 packet cập nhật 2 error-signature MỚI cho
Tester-1 (`PROBE_ERROR ... not ready within 10s` = infra lúc boot; `Stream isn't
writeable` GIỮA run = Redis chết giữa chừng — phân biệt với storm port).

**Phát hành lại:** Tester-1 chạy LẠI W49-QW1-LIVE-001 nguyên 5 lệnh; kỳ vọng giữ
nguyên `Tests: 10 passed, 10 total`. Lớp chống nhiễu giờ: ready-gate lúc boot (hết 500
lạnh) + retry mạng pre-delivery + warm-up IdP + keep-alive/IPv4 — mỗi lớp chữa một
class riêng, không lớp nào nới semantics fail-closed.
- Không commit/push; không tick row; không `docker compose down -v`; lane không tự mở
  window.

---

## W49-QW1-33 — Reviewer Audit 150-155: block DU_LIVE_INFRA đủ 6 ca (thêm LIVE revoke cross-process + RESTART process thứ ba)

**Yêu cầu:** khối live của `tests/oidc02-process-replicas-offline.test.ts` mới 4 ca
(mint, logout, rotation, expiry) — spec OIDC-02 còn đòi live **revoke** và **restart**
trên Redis thật. Kỷ luật giữ nguyên: không DB window, không commit/push, offline không
open handle.

**Khảo sát trước khi code (cycle này ZERO file `src/` sửa):**
- Probe đã có sẵn `GET /__probe/revoke?sub=` (mặc định `mock-user-1`) từ 138b — chỉ thiếu
  CONSUMER phía suite.
- `RedisSessionRepository.revokePrincipal` đếm **key DEL thật** (thành viên index đã chết
  không được tính) ⇒ assert `count` chỉ là LOWER BOUND — key của ca trước còn nằm trong
  absolute TTL 60s của run. Ghi thẳng vào comment test để Tester/reviewer sau không đọc
  `count>=2` như một oracle.

**Hai `it()` mới (dòng 349 và 370):**
1. *nuclear revoke AT A kills BOTH sessions on BOTH processes*: mint HAI session (cùng
   principal `mock-user-1` — IdP mock chỉ có một sub), xác nhận `live:true` trên cả A+B,
   revoke tại A ⇒ `typeof count===number` + `count>=2`, rồi MỌI tổ hợp sid×process phải
   `live:false` VÀ `/admin` bounce 302 (probe = server-side truth, fetch = browser truth —
   chốt cả hai chiều).
2. *RESTART = process thứ ba THẬT*: `spawnProbe()` thêm child C cùng `REDIS_URL` + cùng
   runTag keyPrefix — graph-swap offline nhưng bằng OS process churn thật. C serve
   `survivor` mint TRƯỚC khi C tồn tại (`live:true` + 200); doomed mint sau; revoke THỰC
   THI BỞI C giết cả hai trên A/B/C — shared principal index mới làm được điều đó.
   `finally`: SIGTERM C + `waitForExit` (timeout 10s tự resolve) → không orphan pipe,
   jest exit sạch.

**Kiểm tra offline (cwd `du-rework\services\orchestrator`):**
- `pnpm run test:unit -- --runTestsByPath tests/oidc02-process-replicas-offline.test.ts`
  → **`Tests: 6 skipped, 6 passed, 12 total`, exit 0, 8.07s, jest thoát sạch không open
  handle** (ts-jest compile TOÀN FILE kể cả khối skip ⇒ đó chính là syntax+type check cho
  2 ca mới; describe.skip đảm bảo ZERO child/ZERO socket offline).
- `npx tsc --noEmit && pnpm run lint` → **TSC_OK / LINT_OK**.

**docs/29 W49-QW1-LIVE-001 vá theo (lệnh Tester KHÔNG đổi):** block giờ **dòng 195→400,
6 `it()` tại 291/303/314/325/349/370**; thêm mục chứng-minh 5 (revoke cross-process, có
giải thích lower-bound) + 6 (restart child thứ ba, cleanup finally); literal kỳ vọng
**`Tests: 12 passed, 12 total`** (6 offline + 6 live), troubleshooting `6 skipped`, thời
lượng ~25–35s.

**Pending ngoài lane:** Tester-1 re-run W49-QW1-LIVE-001 lấy biên nhận 12/12 — 2 ca mới
dùng đúng surface đã smoke (`/__probe/revoke` có từ 138b), risk chính vẫn là class storm
port đã mitigated 3 lớp. Không commit/push; không tick row; lane không tự mở window.

> /compress




---

## W1-1 - PACKET W1 (T-SUB-01..03): AUDIT IN-FLIGHT TRUOC KHI SUA

**Packet:** `coordination/dispatch-specs/2026-10-04-1805-W1-admission-seam.md` (owner qwen_1 /
`term_7cb640ae`, run `run_069ecd6957cd`).

**Delta-DEVIATION-01 (khong chan):** packet gui toi ten file `6--4-85-W-admission-seam.md` -
**khong ton tai**. File that la `2026-10-04-1805-W1-admission-seam.md` (ten trong packet la
mojibake cua timestamp). Toi doc file that; noi dung khop 4 cau hoi audit nen coi la cung mot packet.

**So series:** `W49-QW1-*` (W49-QW1-1..33) la series **da dong**. Packet W1 mo series moi `W1-*`
de khong tron hai workstream.

### 1. Baseline do duoc (read-only, TRUOC moi chinh sua)

| Lenh (cwd `du-rework/services/orchestrator`) | Ket qua | Exit Code |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` | output rong | **0** |
| `npx jest` 5 suite trong lease | `4 passed, 1 skipped` - `43 passed, 40 skipped, 83 total` - 15.178s | **0** |

**Vet skip - da truy nguyen, KHONG phai test-stub do:** `runtime.test.ts` boc bang
`liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)')` (`tests/runtime.test.ts:41`) => 40
test la **gate ha tang live**, dung thiet ke. Grep `it.skip|describe.skip|TODO|FIXME|.todo(`
 tren **ca 5 file** trong lease => **0 match** => **test-stub fallout da sach**. Theo lane rule
`SKIP != PASS`: 40 test nay **khong** tinh la bang chung cua lane nay.

### 2. DA XONG (doc code, khong phai suy doan)

| ID | Bang chung |
|---|---|
| T-SUB-01 admission seam | `submission.ts:218` goi `resolveEffectiveProfile` **truoc** `randomUUID`/cac INSERT => submit bi tu choi khong de lai row nao |
| Effective-input validate | AJV compile `actionDef.inputSchema` tren `effectiveInput` (merge), 422 `INVALID_SCHEMA` |
| Idempotency hash tren RAW input | `submission.ts:258` - hash `submission.input`, **khong** phai `effectiveInput` |
| T-SUB-03 priority | `submission.ts:439` ghi `priority` vao outbox; `dispatcher.ts:55` doc tu outbox; legacy mode giu `bullMqPriorityFor(PROFILE_JOB_PRIORITY_DEFAULT)`. **F-PP1 giu nguyen huong** |
| T-SUB-03 extension (2 path) | `submission.ts:353` goi `assertProfileExtensionAllowed` **sau** replay check, **truoc** INSERT dau tien |
| DB column | `migrations/0026_profile_policy.sql` muc 2 - `operations.profile_policy_snapshot jsonb NULL` |
| Cipher format | `0026` muc 1 - `file_url_auth_cipher text` = `iv_hex:tag_hex:ciphertext_hex` |
| Claim fail-closed khi shape hong | `runtime.ts:201-219` `parsePinnedProfilePolicy` nem `INVALID_SCHEMA` thay vi chay bang default |

### 3. CON THIEU / DO - 6 finding (thu tu uu tien)

**F-W1-1 CRITICAL - raw secret di vao snapshot + claim.**
`submission.ts:399` ghi `JSON.stringify(profile.policy)`. `EffectiveProfilePolicy.fileUrlAuthConfig`
(`profiles.ts:98`) la **plaintext da giai ma**: `decodePolicy` (`profiles.ts:232`) goi
`decryptFileUrlAuthConfig` roi tra `decrypted?.config ?? null` (`profiles.ts:249`).
Chuoi leak: `file_url_auth_cipher` (da ma hoa) -> giai ma trong RAM -> **`JSON.stringify` vao cot
jsonb thuan** (`profile_policy_snapshot`) -> `runtime.ts` parse -> claim. Cot nay **khong** nam
trong metadata-crypto seal. Vi pham truc tiep `PLAN-COMPLETION-2026-10-04.md` muc 2 + acceptance
PLAN04-01 (sentinel trong token/header/query khong duoc xuat hien o operation snapshot/claim).

**F-W1-2 HIGH - contract `.passthrough()` hai tang.** `PinnedProfilePolicySchema`
(`contracts/runtime.ts:58-69`) co `fileUrlAuthConfig: z.object({type}).passthrough().nullable()`
**va** `.passthrough()` o cap ngoai => moi field la (token/header/query) deu lot. Day la ly do cau
truc ma F-W1-1 khong bi chan o contract boundary.

**F-W1-3 HIGH - guard da viet nhung KHONG noi day.** `fileUrlAuthConfigCarriesSecret()`
(`file-url-auth.ts:155`) ton tai, grep toan repo => **0 consumer**. Day la bang chung chinh xac
Claude dung o dau: da viet ham phat hien secret nhung chua dung no de loc snapshot.

**F-W1-4 MEDIUM - thieu snapshot DTO chuyen biet + ref bat bien.** PLAN04-01 muc 2 yeu cau
snapshot DTO chuyen biet da runtime-validate, khong serialize nguyen `EffectiveProfilePolicy`,
con ref `(tenantId, profileId, profileRevision)`. Hien chua co DTO nao; `profile_id` /
`profile_revision` co o cot rieng (`submission.ts:386-387`) nhung **ban than snapshot khong mang ref**.

**F-W1-5 MEDIUM - `sourceUrl` top-level khong qua extension gate.**
`assertProfileExtensionAllowed` (`submission.ts:697`) chi duyet `artifacts` + `effectiveInput.fileUrls`;
**khong** kiem `submission.sourceUrl`. PLAN04-01 muc 3 neu dich danh: *Khong bo sot top-level
`sourceUrl`*. Day la producer-side => nam trong lease `submission.ts` cua toi (download/acquisition
leg thuoc W1c).

**F-W1-6 MEDIUM - chua co sentinel test cho cot `profile_policy_snapshot`.**
`tests/enc-meta-sentinel-runtime-refs.test.ts` chi phu `result_ref`/`human_waits`/`resume`; khong
suite nao assert sentinel vang o snapshot/claim. Theo `feedback/verify-failure-reason.md`: test
`not.toContain` ma **khong inject sentinel vao input** la bang chung rong - test moi phai inject
that roi moi assert vang.

### 4. Ket luan audit

Claude da lam xong **T-SUB-01, T-SUB-03 va phan hinh dang DB cua T-SUB-02**, con **T-SUB-02 phan
no-secret la do dung cho packet neu** (`submission.ts:399` van la `JSON.stringify(profile.policy)`).
Uu tien sua: **F-W1-1 -> F-W1-2 -> F-W1-4 -> F-W1-6**, roi F-W1-5, F-W1-3.
Khong sua gi o muc nay; phan code nam o W1-2+.

---

## W1-2 - IMPLEMENT T-SUB-02 no-secret snapshot + T-SUB-03 sourceUrl gate (W1 xong)

### 1. Diff (write-set dung lease, khong file ngoai lease)

| File | Thay doi |
|---|---|
| `packages/contracts/src/profile-policy.ts` | + them `ProfileCredentialRefSchema` va `ProfilePolicySnapshotSchema` (`.strict()` 2 tang) |
| `packages/contracts/src/runtime.ts` | `PinnedProfilePolicySchema` gio re-export `ProfilePolicySnapshotSchema`; bo khai bao `.passthrough()` va `fileUrlAuthConfig` raw |
| `services/orchestrator/src/modules/operations/submission.ts` | them `buildProfilePolicySnapshot()`; INSERT snapshot troi ve DTO moi; `assertProfileExtensionAllowed` nhan them `sourceUrl` |
| `services/orchestrator/tests/w1-sub02-snapshot-secret.test.ts` | MOI, 10 test |
| `services/orchestrator/tests/w1-sub03-sourceurl-extension.test.ts` | MOI, 6 test |

**Khong sua:** `0026`/`0027` (migration khong bat buoc - DTO moi la jsonb,van ghi cung cot),
`docs/21-openapi.json` (ngoai lease; DTO nay la internal snapshot, khong phai wire public).
`dispatcher.ts` va `runtime.ts` (orchestrator) giu nguyen - chi can schema moi tu parse.

### 2. Schema/type diff - DTO freeze (y eu cau cua CHECKPOINT (a))

**TRUOC** (`PinnedProfilePolicySchema` tai `contracts/runtime.ts`):

```ts
z.object({
  enabled, parameters: z.record(..., {value}.passthrough()), jobPriority,
  allowedFileExtensions, connectionsOverride,
  fileUrlAuthConfig: z.object({ type: z.string() }).passthrough().nullable(),
}).passthrough();          // <- .passthrough() o CA HAI tang
```

**SAU** (`ProfilePolicySnapshotSchema`, mot schema cho ca hai huong):

```ts
z.object({
  enabled, parameters, jobPriority, allowedFileExtensions, connectionsOverride,
  fileUrlAuthConfigured: z.boolean(),   // thay cho config
  credentialRef: z.object({ tenantId, profileId, profileRevision }).strict(),
}).strict();
```

`SCHEMA_KEYS` do tu test, khong doan:
`["enabled","parameters","jobPriority","allowedFileExtensions","connectionsOverride","fileUrlAuthConfigured","credentialRef"]`
- **khong con** `fileUrlAuthConfig`.

### 3. Payload that (capture tu test, khong viet tay)

**configured** (`fileUrlAuthConfigured: true`):

```json
{"enabled":true,"parameters":{"temperature":{"value":0.2,"isLocked":false}},
"jobPriority":"HIGH","allowedFileExtensions":".pdf,.docx",
"connectionsOverride":[{"slug":"conn-a","stepId":"_default"}],
"credentialRef":{"tenantId":"T","profileId":"P","profileRevision":7},
"fileUrlAuthConfigured":true}
```

**absent** (`type: 'none'` hoac `null`) - chi khac `fileUrlAuthConfigured: false`;
`credentialRef` **van co mat**, de consumer khong phai suy ra ref tu co bien hay khong.

**invalid** (ban ghi cu co `fileUrlAuthConfig`):
`safeParse.success = false`, issue that:
```json
{"code":"unrecognized_keys","keys":["fileUrlAuthConfig"],"path":[],
"message":"Unrecognized key(s) in object: 'fileUrlAuthConfig'"}
```

=> claim fail closed 422 thay vi chay bang secret da giai ma.

### 4. Strict-secret negatives (F-W1-2 dong kich ban ghi cu)

| Input |safeParse|
|---|---|
| raw config (`fileUrlAuthConfig`) | **false** - `unrecognized_keys` |
| key la (`surpriseCredential`) | **false** - `.passthrough()` da bi bo |
| token/header/query sentinel trong snapshot | **khong bao gio duoc ghi** (test 10) |

### 5. Verify (literal Exit Code tu wrapper, khong suy ra marker)

| Lenh | Exit Code |
|---|---|
| `contracts: pnpm run lint` (= `tsc --noEmit`) | **0** |
| `orchestrator: pnpm run lint` (= `tsc --noEmit`) | **0** |
| `contracts: npx jest --runInBand` | **1** - pre-existing, xem muc 6 |
| focused 7 suite (2 moi + 5 baseline) **x3 lien tiep** | **0 / 0 / 0** |
| `tests/enc-meta-sentinel-runtime-refs` + 4 suite lien quan | **0** (182/182) |

Focused 3 lan: `Test Suites: 1 skipped, 6 passed, 6 of 7 total` -
`Tests: 40 skipped, 59 passed, 99 total`. **40 skip = gate `DU_LIVE_INFRA`, SKIP != PASS**,
khong tinh vao bang chung lane nay.

### 6. 8 suite do trong `test:unit` toan cay - KHONG phai do toi (da truy nguyen tung cai)

Tong: `8 failed, 10 skipped, 145 passed, 153 of 163` - `28 failed, 89 skipped, 4281 passed`.

| Suite | Ly do | Bang chung |
|---|---|---|
| `br12-isolation-offline` | manifest gia trong test khong co `inputSchema` => `declaredParameterKeys(undefined)` nem TypeError | **Probe do duoc**: `TypeError: Cannot read properties of undefined (reading 'properties')`. `declaredParameterKeys` + call site la code Phase 2 cua Claude, **co san o read dau tien cua toi truoc moi edit**; code do chay TRUOC moi thay doi cua toi. Probe da xoa |
| `enc-meta-sentinel-runtime-refs` | co ten **RED GAP DETECTOR**, comment trong file: *"Fails today (finding)... requires a METADATA_SLOTS entry for result_ref"* | Danh nghia redact, ve `result_ref` - khong ve profile snapshot |
| 6 suite `admin-shell-*` + `admin-p6-01-shell-fixtures` | lane Admin, ngoai write-set cua toi | Co san truoc cycle nay |

Khong suite nao trong 8 la suite W1 vua viet.

### 7. Mutation probe - chung minh test khong vacuous

Tạm tra ve `JSON.stringify(profile.policy)` (khoi phuc defect) roi chay lai suite W1-02:
**5/10 RED, Exit Code: 1**, va **do sai ly do** (`leaks(...)` tra `true`, khong phai loi khac).
Sau do revert ve fix -> 10/10 xanh. Test bat duoc tai dung cho tai do.

### 8. Mot test cua toi fail vì fixture sai, khong phai vi code

`w1-sub03` case *"admits a sourceUrl inside the CSV"* fail truoc:
`only pdf, docx are accepted; this file has ".pdf"`. Truyen loi la **fixture** cua toi:
CSV phai co **dau cham** (`.pdf,.docx`) - `extname()` doi chieu nguyen ban va
`normalizedAllowedFileExtensions` chi fold **case**, khong fold dot (legacy parity, `policy.ts`
ghi ro la co chu dich de typo hien ra). Da sua fixture, **khong sua code san pham**.

### 9. SKIP co ly do

**ESLint: SKIP.** `npx eslint` -> *"dong cai eslint@10.12.0"* (prompt hang). Repo **khong co
eslint**: `package.json` khong co devDep eslint, va `scripts.lint` chinh la `tsc --noEmit`.
Theo chi dao coordinator 18:36, dung tool co san cua repo -> `pnpm run lint` da chay **Exit Code 0**.
Khong tinh ESLint vao [PASS].

### 10. Trang thai W1 vs 4 muc cua packet

| Muc | Trang thai |
|---|---|
| 1. Audit in-flight (ghi TRUOC khi sua) | **XONG** - muc W1-1, 6 finding |
| 2. Admission seam + snapshot khong raw credential | **XONG** - F-W1-1, F-W1-4 |
| 3. Validate effective input, DTO chuyen biet runtime-validate | **XONG** - `buildProfilePolicySnapshot` validate truoc khi ghi |
| 4. Test-stub fallout 5 file | **XONG** - grep skip/TODO = 0 match; 4 suite xanh; `runtime.test.ts` skip la gate live |

### 11. Delta-DEVIATION can xu ly cho coordinator

**DD-02 (da xu ly trong lease):** them `sourceUrl` vao extension gate. PLAN04-01 muc 3
nam trong PLAN04-02 (W1b) nhung `sourceUrl` admission la producer-side => nam trong lease
`submission.ts` cua toi. Download/acquisition leg van de nguyen W1c.

**DD-03 (can coordinator quyet):** ket qua snapshot **doi shape** so voi cai Claude da ghi.
`operations.profile_policy_snapshot` co the da co duong du trong DB dev voi shape cu
(co `fileUrlAuthConfig`). Shape moi `.strict()` se **fail closed** khi claim - dung y chung,
nhung neu co bang ghi thuoc tinh co plaintext thi can **rewrite** truoc khi claim lai.
`0026` ghi *"Deliberately NOT backfilled"* va du-rework la project moi nen **offline toi khong
do duoc co du lieu do**; day la ket luan suy ra tu tai lieu, **khong phai do duoc**. Can ban live
xac nhan hoac packet migration rieng.

**DD-04 (van mo, KHONG claim):** W1 khong implement acquisition resolve/decrypt theo
`credentialRef` - dung W1c. `fileUrlAuthConfigCarriesSecret` da noi day (F-W1-3) nhung con
duong doc credential o acquisition **chua ton tai** trong code hien tai (grep: 0 consumer
truoc khi tao no). Claim nay chi mang ref, chua mang secret - acquisition se phai lay ciphertext
tu `profile_bindings` bang ref roi giai ma sat luc fetch.

Chua commit/push/reset. Chua tick gate. Khong mo DB/Redis/S3/Vault.

---

## W1 HANDOFF - RELEASE LIST (W1-HANDOFF, receipt-only, 2026-10-04 19:0x)

Packet: `coordination/dispatch-specs/2026-10-04-1901-W1-HANDOFF-RELEASE.md` (run `run_069ecd6957cd`,
task `task_b5aa5fbfd8ca`). **Khong doi code, khong commit, khong tick.**

### 0. Diem quan trong nhat - lease W1 co ~20 file, toi CHI GHI 5 file

Spec yeu cau *"release tung file can chuyen, khong tu gia dinh ca lease het"*. Su that do:
trong ca lease W1, **chi 5 file duoc TOI ghi**. 10 file con lai toi **chi DOC**.

Phan biet nay khong phai suy doan tu mtime: toi biet chinh xac vi tool call cua toi da ghi file nao
(edit/write_file cua toi co ten file). mtime chi **corroborate** - va theo lesson da gap o lane nay,
mtime trung KHONG chung minh tac nhan, nen tinh no la bang chung phu, khong phai bang chung chinh.

**=> Coordinator khong can cho toi release 15 file: toi khong giu chung.**

### 1. Trang thai + digest (sha256 rut gon 12 hex, do bang Get-FileHash)

**A. File TOI da ghi trong W1 (5 file) - day la moi thu toi that su giu:**

| File | sha256[0:12] | mtime | Vai tro |
|---|---|---|---|
| `services/orchestrator/src/modules/operations/submission.ts` | `1655BE49D843` | 18:24:13 | admission seam; `buildProfilePolicySnapshot`; `sourceUrl` extension gate |
| `packages/contracts/src/profile-policy.ts` | `759C51004A5F` | 18:17:26 | them `ProfileCredentialRefSchema` + `ProfilePolicySnapshotSchema` |
| `packages/contracts/src/runtime.ts` | `4CC34F0FAC91` | 18:18:21 | `PinnedProfilePolicySchema` re-export schema moi, bo `.passthrough()` |
| `services/orchestrator/tests/w1-sub02-snapshot-secret.test.ts` | `D3B51AD2CBB4` | 18:23:16 | MOI, 10 test sentinel |
| `services/orchestrator/tests/w1-sub03-sourceurl-extension.test.ts` | `5EF1E24E0BC6` | 18:25:39 | MOI, 6 test sourceUrl gate |

**B. File trong lease nhung toi CHI DOC (15 file) - KHONG can release tu toi:**

| File | sha256[0:12] | mtime | Nguon ghi gan nhat |
|---|---|---|---|
| `modules/profiles/profiles.ts` | `153965D7E20A` | 15:46:16 | Claude Phase 2 |
| `modules/profiles/policy.ts` | `EF02D8EB7FDB` | 16:31:51 | Claude Phase 2 |
| `modules/profiles/publish.ts` | `AE76AC4BC2D6` | 15:27:49 | Claude Phase 2 |
| `modules/profiles/file-url-auth.ts` | `15CFBED3B445` | 15:27:09 | Claude Phase 2 |
| `modules/profiles/prompt-overrides.ts` | `CA2EC15C0BA3` | 16:48:00 | Claude Phase 2 |
| `modules/queue/dispatcher.ts` | `3715751DB581` | 15:58:17 | Claude Phase 2 |
| `modules/runtime/runtime.ts` | `196A9985E963` | 17:17:53 | Claude Phase 2 (dung luc 17:22) |
| `packages/contracts/src/index.ts` | `33A8748D2F78` | 14:43:14 | lane truoc |
| `migrations/0026_profile_policy.sql` | `B98615F802AF` | 14:06:47 | lane truoc |
| `migrations/0027_profile_active_pointer.sql` | `EC28DD7CFBBE` | 14:07:59 | lane truoc |
| `tests/artifact-submit-guards.test.ts` | `E094044122FE` | 17:19:05 | Claude Phase 2 |
| `tests/public-upload-encryption-gateway.test.ts` | `DAB379B1E23B` | 17:19:17 | Claude Phase 2 |
| `tests/url-ingestion-offline.functional.test.ts` | `4F1394D16DEE` | 17:18:34 | Claude Phase 2 |
| `tests/url-ingestion-backend-failclosed-offline.test.ts` | `4F87BEF52360` | 17:18:34 | Claude Phase 2 |
| `tests/runtime.test.ts` | `DA62779AB1FA` | **2026-10-03** 02:29 | lane truoc (khong phai fallout Phase 2) |

`0026`/`0027` **khong co cham** (DD khong phat sinh) - DTO moi van ghi cung cot jsonb, khong can migration.

### 2. De xuat release NGAY cho W1c (acquisition)

| File | Ly do phai sang W1c |
|---|---|
| `modules/profiles/file-url-auth.ts` | W1c can `decryptFileUrlAuthConfig` + `resolveProfileCryptoKey` + `isFileUrlAuthCipher` de giai ma **sat luc fetch**. **LUU Y MOI:** `submission.ts` (cua toi) bay gio **import `fileUrlAuthConfigCarriesSecret` tu file nay** - da co coupling chieu 2 chieu. W1c sua file nay thi focused W1 phai chay lai |
| `modules/profiles/profiles.ts` | W1c can `decodePolicy` de doc `file_url_auth_cipher` theo `credentialRef`. **NHUNG** `selectActiveRow` cung la duong T-SUB-01; sua cho qua lo co the dong admission seam. De nguyen: W1c tao module acquisition rieng chi DOC tu day |

**File MOI (chua co ai giu):** module acquisition resolve `credentialRef` -> ciphertext. DD-04 de nguyen,
chua ai implement. Dat ten/module do coordinator chot de tranh 2 lane cung tao.

### 3. De xuat release cho W1b (consumer T-SUB-04)

| File | Trang thai release |
|---|---|
| `modules/runtime/runtime.ts` | **GIAI PHONG WRITE cho W1b** - `parsePinnedProfilePolicy` bay goi schema moi `.strict()`, nen W1b can sua no de consume `credentialRef`. Cho den luc day no van chay xanh (chi thay doi hanh vi khi shape cu) |
| `contracts/{profile-policy,runtime}.ts` | **CHI DOC cho W1b/W2** - xem muc 4 |

### 4. GIU READ-ONLY (KHONG release write) - 3 file

| File | Ly do |
|---|---|
| `packages/contracts/src/profile-policy.ts` | **DTO da freeze (CHECKPOINT a).** W1b/W2/W1c/W3 chi **consume**; bat ky ai sua se lam drift giua writer va reader - day chinh la tai lieu bao ve single-writer. |
| `packages/contracts/src/runtime.ts` | Cung, va no la noi `PinnedProfilePolicySchema` **re-export**; sua o day tuc la sua contract. |
| `modules/operations/submission.ts` | Admission seam. T-SUB-02 vua dong o day. **Chi giu cho den khi W1b/W2 xong** - xem cau hoi 2. |

### 5. De xuat release cho W3 (publish/CAS)

| File | Ly do |
|---|---|
| `modules/profiles/publish.ts` | T-PROF-03 publish/rollback/CAS la dependency explicit cua T-SUB-02 pin (PLAN-COMPLETION muc 3). W3 can ghi file nay. **Toi khong ghi file nay** nen khong co conflict voi W1. |

### 6. Thu tu + dieu kien an toan (khong 2 writer)

```
[1] GIAI PHONG   file-url-auth.ts + module acquisition moi   -> W1c
[2] GIAI PHONG   runtime/runtime.ts                         -> W1b
[3] GIAI PHONG   publish.ts                                 -> W3
[4] GIU READ-ONLY  contracts x2 + submission.ts          -> den khi [1][2] xong
```

**Dieu kien bat buoc:**

1. `contracts/{profile-policy,runtime}.ts` = **READ-ONLY cho moi lane**, khong phai cho rieng W1.
   Neu W1b/W1c/W3 can them field, ho **dung** `credentialRef` co san hoac mang `DD-DEVIATION`
   de coordinator cap quyen, **KHONG tu them** - them field vao DTO ngay luc nay se pha CHECKPOINT (a).
2. Khong cap 2 writer cho **cung mot file** trong cung mot thoi diem. W1c va W1b deu can
   `file-url-auth.ts`? Khong - chi W1c. Nhung ca hai deu can *doc* contract => cho phep.
3. Bat ky ai sua `file-url-auth.ts` phai chay lai focused W1 (`w1-sub02`, `w1-sub03`) +
   `tests/artifact-submit-guards` + `url-ingestion-*` boi **coupling import** o muc 2.
4. `submission.ts` chi giai phong **sau** khi W1b/W2 chot; neu W3 can ghi cho T-AUD-01 thi phai
   **serialize**, khong giao song song.

### 7. Cau hoi cho coordinator (can quyet truoc khi cap lease)

**Q1 - `credentialRef` ai resolve?** DD-04: chua ton tai code doc credential o acquisition.
Tao module moi hay dua vao `profiles.ts`? Toi de nguyen vi `profiles.ts` la T-SUB-01 seam.

**Q2 - W3 co can ghi `submission.ts` khong?** PLAN-COMPLETION muc 3 noi T-AUD-01 la "phan cua
transaction mutation ngay khi ship API". Neu T-AUD-01 cham `operations/submission.ts` thi phai
serialize voi W1/W1b; neu chi cham admin/publish side thi khong conflict.

**Q3 - W1b sua `runtime/runtime.ts` hay chi doc?** Toi de nguyen. `parsePinnedProfilePolicy` van
xanh; chi can sua khi W1b them consumer that cua `credentialRef`.

**Q4 - DD-03 (data da ghi):** snapshot shape doi => ban ghi cu co plaintext se fail closed khi claim.
Tay ban live xac nhan co du lieu hay khong, hay cap packet migration rieng. Offline toi khong do duoc.

### 8. Constraint observance

Khong sua code/test vong nay. Khong commit/push/reset. Khong tick gate. Khong mo DB/Redis/S3/Vault.
Chi ghi receipt nay.

---

## T-PROF-03 CLOSURE - publish / rollback / CAS evidence (2026-10-04 19:2x)

Packet: `coordination/dispatch-specs/2026-10-04-1910-T-PROF-03-CLOSURE.md` (run `run_069ecd6957cd`,
task `task_f0014eff828a`). Lease moi: `publish.ts` (+ `policy.ts` khi that su, **khong can**),
test moi `tests/p730-prof03-publish-cas.test.ts`. **Khong commit/push, khong tick, offline.**

### 1. invariant THAT suoc xac lap (doc va code khop)

`publish.ts` (mtime 15:27, Claude viet, **chua tung duoc test nao cham** - xac nhan dung nhu
`w1-receipt-audit` §5: grep trong `tests/` chi hit `aweb04-bff-profiles.test.ts`, noi dung dung
o tang BFF wire, **khong goi `publish.ts`**).

| # | Invariant | Bang chung |
|---|---|---|
| I1 | Publish la **CAS move**: `expectedRevision` bat buoc (type-enforced) | stale => 409 `REVISION_CONFLICT`, con tro **khong doi** |
| I2 | Rollback **co** `targetRevision` bat buoc, `expectedRevision` **tuy chon** | rollback khong expected => ok; rollback stale expected => 409 |
| I3 | Doc pointer bang `SELECT ... FOR UPDATE` **truoc** khi so CAS | test kiem `FOR UPDATE` co mat + **thu tu**: lock read truoc pin write |
| I4 | 0027 #2: publish/rollback **chi** doi con tro, khong bao gio ghi `profile_bindings` | `wroteBindings === false`; khong co INSERT/UPDATE/DELETE len bindings |
| I5 | 0027 #3: read **khong bao gio** fallback `MAX(revision)` | profile rollback ve 2 trong khi co revision 7 => doc ra **2**, khong phai 7 |
| I6 | `null` = khong co pointer row, khong substitute revision g | tra `null` |
| I7 | Target khong ton tai bi **FK 23503** chan, khong phai read path | `isUnknownRevisionError` phan loai dung; khong nuot `HttpError` cua chinh no |
| I8 | `pinActiveRevision` la **upsert** | `ON CONFLICT (profile_id) DO UPDATE SET revision = EXCLUDED.revision` |
| I9 | Client truyen vao duoc dung, khong mo tx moi | tx count = 0 khi co client; = 1 khi khong |

### 2. MOT TEST THAT - va no la gi

Test dau tien cua toi *"publish with no revisions at all is 404"* **FAIL (nhan duoc 409)**.
Kiem lai code: CAS compare chay **TRUOC** khi resolve target, nen thieu pointer => 409 chu
phai toi 404. **Test cua toi sai, khong phai code sai** - da viet lai cho dung.

**Phat hien that tu do: nhanh 404 trong `moveActiveRevision` (`notFound('profile has no revisions
to activate')`) la DEAD CODE qua public service.** Ly do:

- `publishRevision` **luon** truyen `expectedRevision` => CAS phai khop mot pointer row ton tai;
- co pointer row => theo composite FK 0027 **bat buoi** co `profile_bindings` row, nen `MAX(revision)`
  khong bao gio NULL tai diem do;
- `rollbackTo` **luon** truyen `targetRevision` => khong di qua nhanh `MAX()`.

**Khong phai bug** (khong lam sai hanh vi) - nhung la guard gia tao cam giac an toan. **Khong sua code**:
xoa nhanh 404 se la refactor ngoai scope, va `moveActiveRevision` la private nen nhac co the dung sau
nay. Da ghi thanh **F-3** de coordinator quyet dinh.

**Bang chung thi cho F-3 (khong phai suy doan):** mutation probe **xoa guard CAS** => nhanh 404
**tro lai reachable** (test doi tu 409 thanh 404).

### 3. Mutation probe

Tạm xoa khoi `if (actual !== input.expectedRevision) throw conflict(...)`:

- **5/25 RED, Exit Code: 1** (3 test publish +1 rollback stale +1 unreachable-404)
- Do sai ly do: promise **resolve** thay vi reject (stale CAS bi bo qua, con tro bi dich)
- Revert xong: `publish.ts` digest = **`AE76AC4BC2D6`** - **bang dung** voi digest da ghi o W1 HANDOFF
  muc 1 => revert byte-identical, khong phai "edit bao thanh cong"

### 4. Verify (literal Exit Code tu wrapper)

| Lenh | Exit Code |
|---|---|
| `p730-prof03-publish-cas.test.ts` **x3 lien tiep** | **0 / 0 / 0** |
| `pnpm run lint` (= `tsc --noEmit`) | **0** |
| 4 suite gop (p730 + aweb04-bff-profiles + w1-sub02 + w1-sub03) | **0** - `51 passed, 51 total` |

`Tests: 25 passed, 25 total` - **khong co skip** o suite nay (`SKIP != PASS`: bo test nao gate).

### 5. PHAN KHONG CHUNG MINH DUOC OFFLINE (bat buoc ghi ro)

| Khong chung minh | Vi sao | Ai chung minh |
|---|---|---|
| **Serialize that cua `FOR UPDATE`** | Mock DB chi mo phong **cai code xin khoa**; khong mo phong MVCC, EvalPlanQual re-read, hay wait tren unique index | **Live window / real PG** |
| **23503 that khi rollback ve revision khong ton tai** | Mock khong co FK; chi test ham phan loai loi | **Live window / real PG** |
| **`ON CONFLICT DO UPDATE` khi 2 tx ghi cung pointer** | Upsert dung trong SQL nhung hanh vi ghi khi tranh chap do PG quyet dinh | **Live window / real PG** |
| **0027 invariant #1** (`createRevision` insert + pin cung tx) | `createRevision` o `profiles.ts`, **ngoai lease packet nay** - chua test | Owner profile tiep / W3 |

**Khong con lai thi dua:** suite nay chung minh **decision logic + SQL issued + thu tu**, khong chung
minh concurrency that. Toi khong tinh fake lock la bang chung serialize.

### 6. Doi chieu 0026/0027 (tham chieu, khong mo lai)

- 0026 §2: `operations.profile_policy_snapshot jsonb NULL` - NULL = "khong ap policy", cam coalesce
  thanh `{}`. **Da dong o W1** (xem W1-2).
- 0027: pointer table (khong phai `is_active` tren `profile_bindings`), composite FK `ON DELETE RESTRICT`,
  backfill `max(revision)` + `ON CONFLICT DO NOTHING` de chay lai duoc.
- **Kiem soat trong lease:** `revision` la `integer` (int4) o **ca** 0006->0004 va 0027 => pg tra
  ve JS **number**, nen so sanh CAS `actual !== expectedRevision` khong gap tranh chap int8->string.
  `ProfileRevisionSchema` la `z.number().int().min(0)` **khong coerce** => string bi contract chan truoc.

### 7. Tra loi §5 cua cc_1 audit - bang chung (b) cho W1c/W3

| Yeu cau | Bang chung |
|---|---|
| Publish co evidence | 9 test trong describe `publish`, xanh 3/3, literal exit 0 |
| Rollback co evidence | 5 test, gồm target row bat bien va rollback forward |
| CAS-conflict dung loai | `REVISION_CONFLICT` / 409, con tro giu nguyen (khong overwrite) |
| Concurrency **mo phong offline** | Co: `FOR UPDATE` co mat + thu tu lock-read truoc pin-write. **Khong** co: serialize that cua PG - xem muc 5 |

**TPROF03 = VERIFIED OFFLINE cho decision layer. `T-PROF-03` chua ACCEPTED** - con phan live o muc 5.

### 8. Trang thai write-set

| File | Trang thai |
|---|---|
| `src/modules/profiles/publish.ts` | **0 product diff** (digest `AE76AC4BC2D6` khop) - chi them bang chung |
| `src/modules/profiles/policy.ts` | **khong cham** - khong can cho invariant nao |
| `tests/p730-prof03-publish-cas.test.ts` | MOI, 25 test |

Khong cham `dispatcher.ts`, `runtime.ts`, `server.ts`, contracts. Khong tick gate. Khong mo DB/Redis/S3/Vault.

### 9. Mo cho coordinator quyet

**F-3 (mo, khong hanh dong):** nhanh 404 dead code trong `moveActiveRevision`. Ba lua chon:
giu nguyen + comment "unreachable qua public service" / xoa / giu de cho API sau dung.
Toi **khong** sua vi xoa la refactor ngoai scope va khu vuc nay co the dung cho lenh moi.

**DD-05 (can lease):** 0027 invariant #1 (`createRevision` insert + pin trong **cung** transaction)
o `profiles.ts`, **ngoai lease packet nay**, **chua co test nao**. Day la invariant ma `publish.ts`
phu thuoc vao (khong co pointer thi moi profile fail closed). Toi de nguyen, can packet rieng hoac
mo lease `profiles.ts`.

**DD-06 (can luu y, KHONG sua):** `apps/admin-web/src/lib/api/client.ts:37` khai bao
`expectedRevision?: string | number`. Contract server la `z.number()` nen string bi 422 tai
boundary - **khong lo** offline. Nhung type client cho phep string la mo hinh sai; can W3/AWEB
chot lai khi sua route.


<!-- appended by coordinator 2026-10-04 20:11 from qwen_1 staged temp (.qwen/tmp/dd05-receipt.md) do lane stream error tai buoc append -->

---

## DD-05 - 0027 invariant #1: createRevision insert + pin CUNG transaction (2026-10-04 19:4x)

Packet: `coordination/dispatch-specs/2026-10-04-1930-DD05-INVARIANT1.md` (run `run_069ecd6957cd`,
task `task_7e8ce5064039`). Lease: `profiles.ts` + test moi `tests/p730-prof03-invariant1.test.ts`.

### 0. Ba quyet dinh cua coordinator - da ghi nhan, khong hanh dong code

| Quyet dinh | Trang thai |
|---|---|
| **DD-05 MET** (basis: CLOSURE 25 test x3 exit 0 + plan-refresh §2) | **Ghi nhan tai muc 6** - day la chot cua coordinator, toi khong tu tick |
| **F-3**: giu nguyen nhanh 404, **khong xoa, khong them comment** | **Khong cham `publish.ts`** (digest khop, muc 5) |
| **DD-06**: chi note cho W3 | **Khong sua** - note tai muc 7 |

### 1. Fake phai mo phong TRANSACTION - ly do

Case **(b)** la trung tam packet nay: pin fail thi insert **khong** duoc ton tai. Fake chi ghi lai
cac lenh khong phat hien duoc dieu do - no se bao "insert da xay ra" cho mot transaction da
rollback. `Store` trong suite giu **write set chua commit** va chi gop vao committed khi COMMIT;
throw => bo. Do do cac assertion rollback co y nghia.

### 2. (a) happy - insert + pin cung tx

| Test | Chung minh |
|---|---|
| revision vua insert **va** active sau commit | bindings `[1]`, pointer `1` |
| pin do `createRevision` tu phat, khong phai caller | `insertIdx < pinIdx` |
| **ca hai** trong MOT transaction | dem `db.tx` mo = **1** |
| revision thu hai bump pointer | bindings `[1,2]`, pointer `2` |

### 3. (b) failure injection - pin fail => insert rollback

| Test | Chung minh |
|---|---|
| insert **da duoc phat** roi **khong ton tai** | co `INSERT INTO profile_bindings` trong `calls`; `bindings.size === 0`, `pointers.size === 0`, `counter === 0` |
| create fail giu nguyen revision + pointer **truoc** do | pointer van `1`, bindings van `[1]` |
| revision bi rollback **khong bi tieu** | create lai cho ra `1`, khong nhay len `3` (khong ho trong chuoi) |

### 4. (c) pointer bat buoc truoc effective

| Test | Chung minh |
|---|---|
| binding co, pointer **khong** => fail closed, **khong** fallback MAX | 404 `NOT_FOUND` (nhanh `pointer-missing`) |
| co pointer => resolve `pinned`, **khong** 404 | `mode/pofileId/revision` khop |
| pointer do invariant #1 tao chinh la cai `getEffectiveRevision` doc | tra `1` |
| key khong co binding nao => **legacy**, khong phai 404 | `{mode:'legacy'}` |

### 5. MUTATION PROBE - va mot test da XANH SAI LY DO

Mutation: chuyen `pinActiveRevision(c, ...)` ra `db.tx` rieng (pham invariant #1).

**Ket qua lan 1: 10/14 RED** - nhung **test (b) "FAILURE INJECTION" van XANH**.

> **Day la fail nguy hiem nhat cua mot test: xanh VI SAI LY DO.** Mutation tao nested transaction,
> fake nem `nested transaction in fake` **truoc** khi toi `failPin`, nen rollback van xanh -
> test xanh khong phai vi pin fail ma vi loi khac.

**Cua chua:** them assertion pin **phai duoc thu** trong cung transaction:
`expect(calls.some(INSERT INTO profile_active_revisions)).toBe(true)`.

**Ket qua lan 2: 11/14 RED**, va (b) do **dung ly do** - pin khong bao gio duoc attemp trong tx ngoai.

Revert xong: `profiles.ts` digest = **`153965D7E20A`** - **bang dung** voi bang W1 HANDOFF muc 1.

### 6. Xac nhan DD-05 da MET (basis coordinator)

Coordinator chot **MET** tren CLOSURE evidence (25 test x3 literal exit 0) + plan-refresh §2.
Toi **ghi nhan**, khong tu tick gate. Packet nay **bo sung** chung cho invariant #1 ma CLOSURE
chua co - sau khi nay thi `publish.ts` (CAS move) va `createRevision` (pin) deu co bang chung
offline cua chung.

**=> W1c/W3 co the mo.** Invariant #1 + invariant #2 + invariant #3 (0027) deu da co test:
| Invariant | Test |
|---|---|
| #1 insert + pin cung tx | `p730-prof03-invariant1` (a)(b)(c) |
| #2 chi doi con tro | `p730-prof03-publish-cas` I4 |
| #3 khong fallback MAX | `p730-prof03-publish-cas` I5/I6 + invariant1 (c) |

### 7. DD-06 - note cho W3 (khong sua trong packet nay)

`apps/admin-web/src/lib/api/client.ts:37` khai bao `expectedRevision?: string | number`.
Contract server la `ProfileRevisionSchema = z.number().int()` **khong coerce**, nen string bi 422 tai
boundary - **khong phai bug runtime**. Nhung type client cho phep string la mo hinh sai.
**W3/AWEB nen chot khi sua route.** Toi khong cham file nay.

### 8. Verify (literal Exit Code tu wrapper)

| Lenh | Exit Code |
|---|---|
| `invariant1` + `publish-cas` **x3 lien tiep** | **0 / 0 / 0** |
| `pnpm run lint` (= `tsc --noEmit`) | **0** |
| 5 suite gop (DD-05 + CLOSURE + aweb04 + w1-sub02 + w1-sub03) | **0** - `65 passed, 65 total` |

`invariant1`: `Tests: 14 passed, 14 total` - **khong co skip** (`SKIP != PASS`).

### 9. Phan KHONG chung minh duoc offline

| Khong chung minh | Vi sao | Ai chung minh |
|---|---|---|
| **Rollback that cua PG** khi pin that fail | Store la fake; PG rollback la co che duy tri thuoc PG | **Live window / real PG** |
| **23503** khi pointer tro toi revision khong ton tai | Fake khong co FK | **Live window / real PG** |
| **Serialize** 2 `createRevision` cho cung profile | `max(revision)+1` co race khi doc khong khoa | **Live window / real PG** |
| **Atomicity that** khi admin route truyen client | Fake `tx` la minh hoa, khong phai router that | **Live window + AWEB** |

**Ghi chu danh gia rui ro (de coordinator can, toi KHONG sua):** hai `createRevision` chay song song
cho cung `profileId` deu doc `max(revision)` **khong khoa** => cung nhan revision, ca hai insert
se **loi unique PK (profile_id, revision)**. `pinActiveRevision` la upsert nen con tro se lai dung,
nhung **mot revision bi orphan** (co binding row, khong bao gio active) - lech nhe invariant #1.
Day la **concurrency that** => thuoc live window, va `profiles.ts` dang trong lease cua toi nen
**DD-07** de coordinator quyet: co mo them `SELECT ... FOR UPDATE` tren profile_id khong.

### 10. Trang thai write-set

| File | Trang thai |
|---|---|
| `src/modules/profiles/profiles.ts` | **0 product diff** (digest `153965D7E20A` khop) |
| `src/modules/profiles/publish.ts` | **khong cham** theo quyet dinh F-3 |
| `tests/p730-prof03-invariant1.test.ts` | MOI, 14 test |

Khong cham contracts/submission/runtime/server/dispatcher/migrations. Khong commit/push. Khong tick.
Khong mo DB/Redis/S3/Vault.
