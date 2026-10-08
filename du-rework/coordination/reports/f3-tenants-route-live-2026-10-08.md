# F-3 — LIVE tenant-roster route suite (test-only) — 2026-10-08

**Task:** F-3 coverage gap from `coordination/reports/tenant-usage-connector-verify-dsh2-2026-10-08.md` §F-3:
no test ran the roster SQL / `GET /api/v1/admin/tenants` against real PostgreSQL, and none exercised a real
`tenant_operator` credential through the real handler.
**Lane:** test-only. **Không sửa product source, không sửa test cũ, không commit/push, không hand-edit `docs/21-openapi.json`.**
**Lease:** tạo mới **1 file** `orchestrator/services/orchestrator/tests/f3-tenants-route-live.test.ts`; chỉ **đọc**
`src/http/routes/admin.ts` (route thật nằm ở đây — tự xác minh, xem §5) và `src/modules/admin-read/tenant-list.ts`.
**Tree:** HEAD `df3f955e877fe87bd190461736c40861e2fe78d5`, working tree DIRTY (lane khác đang mở; `tenant-list.ts` được
lane khác cập nhật lúc 05:45:00 trong lúc tôi làm — xem §4/F3-L3). Node **v22.23.3**, Windows.
**Không claim VERIFIED/ACCEPTED**, không tick ledger.

---

## 1. DB / window đã dùng (theo convention repo, không tự bịa)

| Hạng mục | Giá trị |
|---|---|
| PostgreSQL | container **`du-live-postgres`** (Up, healthy) → `127.0.0.1:5433`, **PostgreSQL 16.11** |
| Database | `du_orchestrator_test` (user `du`) — đúng DB test của repo |
| Connection string | `postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test` (mặc định y hệt các live suite hiện có: `admin-audit.test.ts:18`, `usage-summary.test.ts:6`; không dùng DB dev/legacy) |
| Redis | container **`du-live-redis`** → `redis://127.0.0.1:6380` |
| Guard | `validateTestDatabaseTarget` / `validateTestRedisTarget` + `assertSafeIsolationConfig` (fail-closed trước khi kết nối/ghi) |
| Cô lập | `du-rework/tests/isolation/namespace.ts`: schema riêng mỗi run `du_test_f3_tenants_<rand>` + Redis DB index 1–14; suite **không** ghi vào schema `public` |
| Cleanup | `afterAll`: `app.close()` → `DROP SCHEMA IF EXISTS "<run schema>" CASCADE` → `cleanupArtifactDir()` |
| Bằng chứng cleanup | sau các run: `leftover_isolation_schemas=[]`, `other_sessions=0`, `public_tenants=3` (không đổi) |
| DB window | **CLAIM 2026-10-08 05:50:02 +07:00 → RELEASE 2026-10-08 05:58:34 +07:00**; đo trước khi claim và lúc release: `other_sessions=0`, không có jest process cạnh tranh (process khớp 'jest' duy nhất là subprocess của chính harness DSH) |
| Lưu ý trung thực | RUN-1 (§3) bắn lúc ~05:45:42, trong bước đo trước khi claim chính thức; claim chính thức bao RUN-2..RUN-5 + negative control |

Lệnh chạy live: `DU_LIVE_INFRA=1` + `DATABASE_URL`/`REDIS_URL` như trên, cwd `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`.

## 2. Command + exit code literal + số test

| # | Command (cwd = services/orchestrator) | Exit | Kết quả literal |
|---|---|---|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs tests/f3-tenants-route-live.test.ts` (**suite mới**, `DU_LIVE_INFRA=1`) | **0** | `Test Suites: 1 passed, 1 total` / **`Tests: 11 passed, 11 total`** / 5256 ms |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts` (**suite cũ**) | **0** | `Test Suites: 2 passed, 2 total` / **`Tests: 9 passed, 9 total`** |
| 3 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/f3-tenants-route-live.test.ts` (offline, `DU_LIVE_INFRA` unset) | **0** | `Test Suites: 1 skipped, 0 of 1 total` / **`Tests: 11 skipped, 11 total`** (offline lane không bị ảnh hưởng; skip ≠ pass) |
| 4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |
| 5 | (bổ sung) test-inclusive typecheck: temp config ngoài repo gồm `src/**/*.ts` + file test mới | **0** | không output |

Raw: `coordination/reports/raw/f3-tenants-route-live-2026-10-08/` (`run5-f3-live-green.log`, `old-tenant-suites.log`,
`new-suite-offline-skip.log`, `tsc-noemit.log`, `RESULTS.txt`, `SHA256SUMS.txt`, `DIGESTS.txt`, probe scripts).

## 3. Fail-first (giữ log đỏ; nói thẳng cái gì đỏ và vì sao)

Không có case nào đỏ vì **hành vi product sai**. Bốn lần đỏ đầu là lỗi **harness/kỳ vọng của chính tôi**; tôi giữ nguyên
log và ghi rõ từng lần thay vì tô xanh:

| Run | Exit | Đỏ vì | Xử lý |
|---|---|---|---|
| RUN-1 | 1 (10 failed/10) | suite gọi **public listener**; `/api/v1/admin/**` bị chặn bởi PM-M02-ROUTE (`src/http/ingress-guard.ts:26`) → mọi request 404 | chuyển sang **internal listener** (`app.internalServer`), không đổi product |
| RUN-2 | 1 (7 failed/4 passed) | schema cô lập **không rỗng**: `createApp` seed tenant dev-fallback `default` (`create-app.ts:290-295`, RFX-10) | oracle đổi sang **snapshot SQL cùng schema** (so sánh tuyệt đối, không phụ thuộc môi trường) |
| RUN-3 | 1 (2 failed/9 passed) | (d) case "base64 padding" của tôi **dán nhãn sai** (base64 của UUID 36 ký tự không có padding, trùng byte với base64url → route nhận đúng, không phải 422); (e) kỳ vọng viết theo **bản `tenant-list.ts` cũ hơn** | (d) thay bằng token **có padding thật**; (e) cập nhật theo semantics **fail-closed** đã hardening |
| RUN-4 | 1 (1 failed/10 passed) | control phía platform của tôi kỳ vọng `[]` nhưng đúng phải là các row **sau** B | sửa theo snapshot |
| RUN-5 | **0 (11 passed/11)** | — | giữ nguyên expectation, không nới lỏng assertion nào |

**Negative control (chứng minh test không vô nghiệm):** mutation **trên file test của chính tôi** (đã revert) —
`tenantAdminTokens` map `OP_B` → `TENANT_A` (token operator trói sai tenant) → case (a) **đỏ** tại assertion chống lộ
(`negative-control-red.log`, exit 1). Hash file trước == sau (`fe98e8fa…8050`) → revert sạch. Đây **không** phải đỏ product.

## 4. Suite mới chứng minh gì (11 case, đều live PG + HTTP thật)

| Case | Nội dung | Kết quả |
|---|---|---|
| (0) | roster chỉ phục vụ ở **internal listener**; gọi public listener → **404 NOT_FOUND**, body không lộ tên/id tenant | PASS |
| anon | token sai/không token → **401 UNAUTHENTICATED**, không serialize row nào | PASS |
| **(a)** | `tenant_operator` scope **B**, **không** `tenantId` → đúng **1 row B**, `total=1`, `next/prevCursor=null`; body **không** chứa id/tên của A, C **và** của tenant seed `default` | **PASS (đây là bằng chứng live quan trọng nhất còn thiếu)** |
| (a2) | `?tenantId=A/C/default/unknown` với token B → vẫn chỉ row B; id nước ngoài **không** xuất hiện trong body (route không nhận tham số scope) | PASS |
| (b) | platform không `tenantId` → roster **bằng đúng snapshot SQL** theo `(lower(name), id)`, `total = số row`; wire item **đúng 3 khoá** `{id,name,state}`; tenant `SUSPENDED` được trả và state giữ nguyên | PASS |
| (c1) | keyset walk `limit=2` trên PG thật: các page **bằng đúng** các chunk của snapshot; **không trùng, không sót, không bịa** row; `total` giữ nguyên toàn population ở mọi page; page đầu không có prev, page cuối không có next | PASS |
| (c2) | `prevCursor` của page 2 → quay lại **đúng** page 1 (cùng items), `prevCursor=null`, `nextCursor` còn sống | PASS |
| (d) | cursor rác (charset, non-UUID, **base64 có padding**, quá dài, non-canonical) → **422 `INVALID_SCHEMA`** `application/problem+json`, **không** trả `items` (không restart im lặng); áp dụng cả trên đường tenant_operator. Ghi nhận live: spelling standard-base64 của UUID này **trùng** base64url nên được nhận như cùng boundary (đúng, không phải lỗi) | PASS |
| (d2) | cursor hợp lệ trỏ tenant **không tồn tại** → **200** page rỗng, `total` vẫn = toàn population (phân biệt rõ "sai định dạng → 422" với "không có row → 200 rỗng") | PASS |
| (e) | cursor **mint bởi route** tại row ngay trước B, replay dưới scope B → **rỗng, fail-closed** (subquery biên mang scope → NULL), không lộ row biên; **control**: cùng token trên đường platform **vẫn là boundary thật** (trả các row sau B) ⇒ rỗng là do scope fence, không phải token hỏng; cursor tại chính B trong scope cũng rỗng, `total=1` | PASS |
| (f) | `limit=0`→1, `limit=1000`→`ADMIN_LIST_LIMIT_MAX`, `limit=abc`→default, `limit=2`→2; `sort`/`tenantId`/param lạ **bị bỏ qua** (allow-list), không 422 | PASS |

### Live facts phát hiện trong lúc chạy (không phải bug, nhưng cần biết)

- **F3-L1 — roster không bao giờ rỗng ở boot zero-config:** `createApp(autoMigrate:true)` seed tenant dev-fallback
  `00000000-0000-0000-0000-000000000001` / `default` (ACTIVE) + API key `dev-fallback` (`create-app.ts:283-304`, gate
  `shouldSeedDevFallback`, RFX-10). Roster vì vậy luôn có row `default`; mọi giả định "roster rỗng khi chưa seed" là sai.
- **F3-L2 — route admin chỉ sống ở internal listener:** `/api/v1/admin/**` bị `isPublicIngressAllowed` chặn (404 generic) —
  BFF/Portal phải trỏ `jsonBaseUrl` vào internal listener, và `create-app.ts:973-991` làm đúng điều đó.
- **F3-L3 — hardening advisory #1 đã có trong working tree:** `tenant-list.ts:132-133` thêm `AND id = $scope` vào subquery biên
  (digest hiện tại `f3e6dc94…f813`, mtime 05:45:00), tức "cursor replay ngoài scope → NULL, không probe ordering" — **mới hơn**
  bản tôi đọc lúc đầu (`857817f5…1ca5`, đã ghi trong receipt `tenant-verify-dsh-2026-10-08.md`). Case (e) pin đúng semantics này.
- **F3-L4 — test cũ mất một nhánh coverage (LOW, test-quality):** regex biên của fake DB trong
  `tenant-list-cursor-codec-offline.test.ts:54` **không còn khớp** subquery đã thêm scope
  (`probe-regex-check.cjs`: `scoped_boundary_regex_matches=false`, `platform_boundary_regex_matches=true`), nên case
  "cursor replay dưới scope khác" của suite offline **pass mà không thực sự chạy predicate biên** (scope đơn lẻ đã cho 1 row).
  Suite live (e) giờ phủ đúng nhánh đó. **Không sửa test cũ** theo lease — ghi lại để owner quyết định.

## 5. Vì sao gọi internal listener / route nằm ở đâu (đã tự xác minh)

- Route thật: `src/http/routes/admin.ts:413-431` (`if (method === 'GET' && pathname === '/api/v1/admin/tenants')`), được
  `src/server.ts:378` (`handleAdminRoutes`) dispatch, và `createApp` nhận route table qua `deps.route` (`create-app.ts:817`).
- `createApp` bind **hai** listener (`create-app.ts:957-964`): public và internal; handle internal lộ qua `app.internalServer`
  (dùng bởi `pm-m02-ingress-verification.test.ts:199-203`). Admin family chỉ qua được internal listener (`ingress-guard.ts:26`).

## 6. CHƯA cover (nói thẳng)

- **Browser/DOM/UI**: `TenantSelect` render (F-4) — ngoài lease này.
- **BFF `/admin/api/tenants` live**: suite BFF hiện có vẫn là offline + stub upstream; lane này **không** chạy BFF→upstream thật.
- **F-5**: tenant-operator gửi `cursor` **qua BFF** với cursor thật — chưa chạy.
- **Live `/api/v1/usage/events` 422 / usage upstream** — không thuộc F-3.
- **Concurrency/churn**: schema cô lập nên không đo `total`/pagination dưới ghi đồng thời; hành vi dưới churn chỉ được
  suy luận từ SQL, không phải từ run này.
- **Offline lane**: suite mới bị `DU_LIVE_INFRA` gate → trong `jest.unit.config.cjs` nó là **11 skipped** (không phải pass);
  file **không** nằm trong `testPathIgnorePatterns` (không được sửa config theo lease).
- **`tsc --noEmit -p tsconfig.json` chỉ phủ `src/**`** (tests bị exclude); bằng chứng typecheck cho file test là ts-jest
  (RUN-5 xanh) + temp config test-inclusive (exit 0) — không phải gate `tsc` của repo.

## 7. Artifact

- Test mới: `orchestrator/services/orchestrator/tests/f3-tenants-route-live.test.ts` (11 test, `DU_LIVE_INFRA` gate,
  schema cô lập, oracle = snapshot SQL cùng schema).
- Receipt này + raw: `coordination/reports/raw/f3-tenants-route-live-2026-10-08/` (18 file: log các run, negative control,
  suite cũ, offline skip, tsc, `RESULTS.txt`, `DIGESTS.txt`, `SHA256SUMS.txt`, 4 probe script + 1 temp tsconfig).
- Digest file nguồn/test tại thời điểm chạy (`DIGESTS.txt`), gồm: test mới `fe98e8fa…8050`;
  `tenant-list.ts` `f3e6dc94…f813`; `admin.ts` `5130b70d…acdc`; `ingress-guard.ts` `814f4663…f446`;
  `create-app.ts` `e49f877b…6d16`; `tests/isolation/namespace.ts` `7c84be44…cdf0`;
  `test-target-guard.ts` `d6513b39…c45a`; suite cũ `22436c1a…2cc7` / `4f3b0e7f…f302`.
- **Không** file product/test cũ nào bị sửa/tạo/xóa bởi lane này ngoài test mới; **không** commit/push;
  `docs/21-openapi.json` không bị chạm.
