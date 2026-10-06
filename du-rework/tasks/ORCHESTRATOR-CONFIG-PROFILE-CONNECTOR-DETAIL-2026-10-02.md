# Orchestrator config/profile/connector parity chi tiết field-level (bổ sung PAR/ACUI)

> **Scope/acceptance bổ sung 2026-10-04:** [CFGADM-00..11](ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md) chốt inventory root, mapping 17 settings và operational journeys. Chức năng legacy hoạt động trong inventory là required trước G-ADMIN-OPS/P8-08/G6; conditional/post-cutover trong register lịch sử không tự defer chúng. Source snapshots/gap bên dưới không là trạng thái implement hiện hành.

**Trạng thái 2026-10-02:** packet `SPECIFIED`, chưa dispatch, chưa `IMPLEMENTED`/`VERIFIED`/`ACCEPTED`.
Đây là **addendum field-level** của [ORCH-PAR-00..10](ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md) và
[ACUI-00..10](ADMIN-CONTROL-PLANE-UI-2026-10-02.md), cụ thể hóa các knob legacy mà hai plan kia mới mô tả ở mức
capability. Không tạo capability trùng tên, không tick parent hai lần, không tạo gate mới.
Các gate `G-COMP`, `G-ADMIN-OPS`, `G-SEC`, `G-LOCAL-ADMIN`, `G-DATA`, `G-ENC`, `G6` giữ **NO-GO**.
Cần file lease, bằng chứng kiểm thử độc lập và review/acceptance theo `AGENTS.md` trước khi tick `[x]`; Antigravity review phần UI của Admin Web theo [contract UI](../docs/admin-ui-development-contract.md), còn policy/API/service theo owner và quy trình repo.
**Handoff 2026-10-04:** [Admin Web plan](ADMIN-WEB-DELIVERY-2026-10-04.md) sở hữu UI React/BFF; [phân tích Profile mới](../coordination/reports/profile-parity-analysis-2026-10-04.md) là snapshot 10:39 ICT về ORCH-PAR-12/13, scoped-user sau `VFY-LOCAL` và Profile secret AES-256-GCM trong DB. Theo directive 17:18, Claude Code đã dừng implementation và giữ review/plan; Qwen/Codex nhận phần còn lại qua coordinator/lease. [PLAN04-01/02](PLAN-COMPLETION-2026-10-04.md) bổ sung snapshot không raw credential và worker/acquisition consumer thật trước acceptance `AWEB-04`. Connector/provider credential vẫn Vault theo ORCH-PAR-14. Task HTML-shell là nhánh tạm, không thay Admin Web.
Ranh giới với [PAR-XA-01..05](ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md) và
[RFX-01..16](ORCH-REVIEW-FIXES-2026-10-02.md) giữ nguyên: COMP sở hữu external wire/fixture,
PAR sở hữu Admin/control-plane capability, RFX sở hữu crypto/upload/boot (không đụng ở đây).

**Serialize bắt buộc (một writer tại một thời điểm):**
`services/orchestrator/src/http/routes/admin.ts` + `src/app/bootstrap/create-app.ts`
(kế thừa `server.ts` sau CONV-01/02/03 — `server.ts` chỉ còn 375 dòng re-export/entry, route table đã tách),
`modules/admin-actions/dispatcher.ts`, `src/app/admin/{auth,section,mutation,crypto-config}-dispatch.ts`
(kế thừa `shell-router.ts` sau CONV-12), migrations orchestrator, `packages/contracts`, `docs/21-openapi.json`.
Các module/helper độc lập (profile policy service, connector proxy, renderer) có thể song song sau khi contract freeze.

## Nguồn đối chiếu (đã đọc trực tiếp)

- Cũ: `app/api/internal/{apikeys,ext-connections,ext-overrides,profile-endpoints,user-profiles,workflow-schemas}/route.ts`,
  `app/api/settings/route.ts`, `lib/db/schema.ts`, `lib/endpoints/profile-resolver.ts`.
- Mới: `services/orchestrator/src/modules/profiles/profiles.ts` (chỉ pin `connectorBindings`
  slot → `{connectorId, revision}`, key không binding đi legacy path),
  `modules/connectors/connectors.ts` (chỉ probe `GET /health/ready`, timeout 5s, sanitize 502,
  không forward header/credential), `modules/admin-actions/dispatcher.ts:95-121`
  (đã có `apikey.issue/revoke/bind-profile`, `business.enable/activate/drain`,
  `operations.cancel/resume/sweep-deadlines`, `connectors.rotate/revoke/test_credential`).

## ORCH-PAR-11 — API key lifecycle field-level `[ ]`

**Legacy (cũ):** `GET` list `{id,name,status,note}` có scope `getAssignedProfileIds()`;
`POST {name}` sinh `dg_` + 32 bytes base64url, sha256 `keyHash`, `prefix='dg_'`, `status='active'`, trả `rawKey` **một lần**;
`PUT {id,note}` hoặc `{id,action:'rotate'}` xoay hash giữ nguyên id; `DELETE ?id` xóa, `404` khi không thấy,
`403` khi `name==='Global Profile'`.
**Gap:** dispatcher đã có `apikey.issue/revoke` (ghi hash, không lưu raw) nhưng chưa chốt: update note,
delete-guard Global, list-scope theo assignment, prefix/hash contract, copy-once `no-store`.
**Acceptance:** live create → copy-once → submit → rotate → revoke → 401 trên 2 replica;
GET/HTML/log/audit không lộ raw; `Global` delete 403; scoped user không liệt kê key ngoài assignment.
Parent: `ORCH-PAR-01`, `ACUI-05`, `LOCAL-04/OIDC-03`.

## ORCH-PAR-12 — ProfileEndpoint policy + merge/lock semantics `[ ]`

**Legacy:** record `(apiKeyId,endpointSlug)` unique; `enabled` default true; `parameters` JSON
`{key:{value,isLocked}}`; `connectionsOverride` JSON (legacy `string[]` slug + mới `ConnectionStep[]`
`{slug,stepId?,captureSession?,injectSession?}`); `jobPriority LOW/MEDIUM/HIGH` (default MEDIUM);
`fileUrlAuthConfig` mã hóa AES-256-GCM, fallback plain JSON legacy; `allowedFileExtensions` CSV.
`GET ?apiKeyId` enrich từ `SERVICE_REGISTRY` + dbRecord + ext-connections + overrides
(`promptOverride/isActive/stepId`, fallback service-level slug e.g. `extract`).
`POST` upsert: non-admin chỉ được sửa `parameters`/`connectionsOverride` khi endpoint đang `enabled`
(khác → 403); admin full-field + validate slug thuộc registry/service + `VALID_PRIORITIES`.
`mergeParameters`: default từ DB trước, client chỉ override khi không locked; **field locked bị hiện diện
kể cả trùng giá trị vẫn `400 Forbidden Field`** (`profile-resolver.ts:49-86`); unknown/disabled fail-closed.
**Gap:** `profiles.ts` hiện chỉ revision `connectorBindings`; chưa có enabled/allowed/locked/priority/
fileAuth/extCsv/prompt-model-limits trong schema versioned, submission chưa gọi cùng admission seam.
**Acceptance:** golden profile: locked same-value 400, unlocked override ok, absent/default ok,
disabled endpoint 4xx, unknown field 4xx, stale revision 409 CAS, multi-key isolation, replay cùng
idempotency key không đổi config, operation cũ giữ snapshot. Canonical + legacy qua cùng seam
(`PAR-XA-03`), typed `policyDenial`, không tạo operation/task/outbox khi deny.
Parent: `ORCH-PAR-02`, `PAR-XA-03`, `ACUI-04`, `COMP-02/03/04`.

**Bổ sung acceptance PLAN04-01/02:** snapshot chỉ non-secret policy + immutable credential ref, không serialize `EffectiveProfilePolicy` đã giải mã; sentinel scan profile/operation/task/outbox/queue/claim/checkpoint/log. Acquisition giải mã đúng revision sát lúc fetch, fail closed khi key/ref/tag sai; worker nhận non-secret context và thực sự dùng extensions/step mapping. Pin giữ nguyên qua child/retry/restart/HITL và publish/rollback. T-PROF-03 publish/CAS là dependency explicit trước admission; T-AUD-01 ship cùng mutation với principal ID thật. Xem mục 2/3 của bổ sung plan cho owner/write set/test.

## ORCH-PAR-13 — Per-key per-step prompt override key-4 `[ ]`

**Legacy:** `ExternalApiOverride` unique `(connectionId,apiKeyId,endpointSlug,stepId default '_default')`;
`GET` filter `connectionId/apiKeyId`, join connection `{id,slug,name}`, non-admin bắt buộc `apiKeyId`
+ `requireProfileAccess`; `POST` upsert `{connectionId,apiKeyId,endpointSlug,stepId,promptOverride,isActive}`,
verify connection + key tồn tại (404), non-admin chỉ khi endpoint enabled (403),
`isActive:false` → delete về default (upsert `onConflictDoUpdate` key-4);
`DELETE {connectionId,apiKeyId}` xóa bulk.
**Gap:** chưa có override-slot versioned trong profile revision, chưa enrich `extConnections[]`
(`promptOverride/isActive/stepId`) ở Admin GET, chưa audit/diff/rollback theo revision.
**Acceptance:** CRUD key-4 qua Admin API thật; publish/rollback đổi prompt có hiệu lực với request mới,
operation cũ giữ pin; cross-tenant 403/404 không lộ existence.
Parent: `ORCH-PAR-02`, `ACUI-04`.

**Bổ sung acceptance PLAN04-02:** T-PROM-02 phải resolve/pin override tại admission và nối claim → SDK context → document-core → Connector. Repository CRUD hoặc field contract không chứng minh precedence/step fallback có hiệu lực. Test quan sát actual mock-provider request cho key-4, `_default`, Code > Profile > Connector và capture/inject session; revision thay giữa chừng không đổi invocation cũ. SDK/business/acquisition có packet riêng, không bị chặn bởi write lease Orchestrator-only.

## ORCH-PAR-14 — Connection lifecycle + Vault write-only `[ ]`

**Legacy fields:** `name/slug regex ^[a-z0-9-]+$/description/endpointUrl/httpMethod/authType
(API_KEY_HEADER/BEARER/NONE)/authKeyHeader/authSecret/promptFieldName/fileFieldName/fileUrlFieldName/
defaultPrompt/staticFormFields/extraHeaders/responseContentPath/sessionIdResponsePath/sessionIdFieldName/
timeoutSec/state(ENABLED)`. `GET` mask `authSecret→'••••••••'`; `POST` validate required
(name/slug/endpointUrl/authSecret khi type≠NONE/defaultPrompt), slug unique 409, 201 + mask.
**Gap:** Orchestrator mới chỉ probe readiness (không credential/header, không echo body, 502 sanitize);
chưa có Admin proxy create/list/detail/update-as-new-revision/test/activate/retire/disable/binding,
credential write-only Vault ref + scope tenant/account + allowlist URL egress.
**Acceptance:** Admin → Orchestrator → Connector/Vault → profile → worker invocation cùng revision;
old operation giữ pin; wrong tenant/RBAC, invalid URL/secret, outage fail-closed; GET/log/HTML không
bao giờ trả secret; rotation/revoke có audit + failure isolation.
Parent: `ORCH-PAR-03`, `VAULT-*`, `ACUI-06`.

## ORCH-PAR-15 — Settings 17 key → replacement map + diagnostics an toàn `[ ]`

**Legacy:** allowlist 17 key: `ai_provider/ai_api_key/ai_model/ai_image_prompt/ai_pdf_prompt/
ai_docx_prompt/ai_compare_prompt/ai_generate_prompt/openai_api_key/openai_base_url/api_secret_key/
s3_endpoint/s3_bucket/s3_access_key/s3_secret_key/s3_region/s3_cache_ttl_hours`.
`GET` mask 5 secret; `PUT` chỉ nhận allowlist + string, `400` khi rỗng, đổi S3 → `resetStorageBackend()`.
**Replacement (không copy plaintext vào DB):** từng key → `env/deploy` (immutable process/infra) hoặc
Connector revision / profile revision / Vault ref / retire — bảng mapping do `ORCH-PAR-00` ký;
diagnostic test provider/S3 là bounded action có quyền, không expose key; cache/retention có dry-run,
confirm, audit, **không xóa artifact còn tham chiếu**; `api_secret_key` cần inventory consumer/retire decision của CONT,
không tự map sang admin identity/bootstrap (`LOCAL-00`); Prompt Wizard và Test Endpoint **bắt buộc** phải Connector-mediated +
profile-scoped, không gọi provider trực tiếp từ Orchestrator.
**Acceptance:** matrix từng setting cũ → replacement + owner/scope/source/rollback + màn UI;
secret redaction test; S3 failure/rollback test; deployment config immutable test. Mapping đủ 17 key ở mục 3 của CFGADM; `api_secret_key` chưa có consumer ngoài settings nên candidate retire cần CONT sign-off, không tự import làm bootstrap key. AI defaults/model/base URL, năm prompts, six S3 fields/TTL, provider/S3 test và cache/output cleanup phải có UI edit/test/apply/reload/runtime-use/rollback. CFGADM-01..04/06 là acceptance chi tiết, `requires deployment action` không đóng parity.
Parent: `ORCH-PAR-06`, `ACUI-08/09`, `DATA/ENC`.

## ORCH-PAR-16 — User ↔ key assignment + workflow schema catalog `[ ]`

**Assignment legacy:** `GET ?userId → {apiKeyIds[]}`; `POST {userId,apiKeyIds[]}` replace trong transaction
(delete + insert), verify user 404, `requireAdmin`. Không trả raw key.
**Schema legacy:** `GET ?slug` list/get; `POST {schema|xml}` `validateSchema` → `saveSchema` 201,
`400` khi invalid; `DELETE ?slug`. XML→schema cần size/XXE/DTD guard.
**Gap/quyết định:** `ORCH-PAR-05` chốt giữ assignment hay thay bằng role×tenant×profile (user không nhìn/copy
raw đã cấp, không nâng quyền qua gán, disable user/key thu hồi tương ứng; concurrent revoke + audit;
cross-tenant/role, OIDC vs local). Schema: DAG validate whitelist/cycle, mapping/override theo capability,
publish/rollback/retire, preview/test synthetic, execution chỉ qua Worker; public `schemaSlug` mapping
thuộc COMP; Orchestrator không chạy DSL.
**Acceptance:** assignment + schema CRUD qua Admin API thật; create→publish→submit→poll/result;
invalid graph/stale version/foreign tenant fail-closed; audit đầy đủ.
Parent: `ORCH-PAR-05` + `LOCAL-00..04`; `ORCH-PAR-04` + P9-04 + `COMP-09` + `ACUI-07`.

## ORCH-PAR-17 — Ops/analytics/docs + explicit non-parity `[ ]`

**Parity:** usage/operations list/detail/result/artifact; time-series hour/day 24h/7d/30d
(success/fail, action/provider, token/cost), timezone + late-event/dedup + pagination + tenant fence
(dùng projection, không đếm lại từ log; không gộp billing balance khi chưa có ledger);
safe-ops console chỉ thêm action còn thiếu sau gap-test (stalled lease/recovery, retry/deadline,
queue depth, retention) với dry-run/bounded bulk + confirm + RBAC/CSRF/idempotency/audit;
served versioned OpenAPI (read-only consumer của artifact `COMP-02` freeze, `PAR-XA-01`).
**Explicit non-parity (không sao chép nguyên trạng, ghi replacement):**
`auth-key` (đọc key) → cấm, thay bằng issue/copy-once/audit; `dev-sync-endpoints` (xóa-insert lại)
→ migration có review; raw Bull Board → ops console scoped; cleanup bằng GET → retention job có
confirm/dry-run/audit. Mỗi mục retire cần migration/rollback + product sign-off.
**Acceptance:** cross-check projection vs source events; empty/partial state; crash/restart + duplicate
action + cross-tenant; spec-vs-live route test + link từ Admin; curl example không secret.
Parent: `ORCH-PAR-07/08/09`, `ADM-UX`, `COST`, `COMP-08/10/11`, `ACUI-10`, `ORCH-PAR-00` register.

## Thứ tự + đóng

1. `ORCH-PAR-00` ký cutover register trước: dòng nào `required/post-cutover/retire`, gate đích, migration/rollback.
   `ORCH-PAR-11..17` không vượt register; register phải phản ánh yêu cầu CFGADM hiện hành, không defer chức năng Admin legacy đã chốt required.
2. Đường găng: `ORCH-PAR-11/12/13/14` (+ `ORCH-PAR-16` nửa assignment/schema) trước để có key/profile/connector thật
   cho fixture external `COMP-10`; `ORCH-PAR-15/17` và CFGADM là required theo inventory mới, triển khai lane độc lập nhưng phải đạt trước G-ADMIN-OPS/P8-08/G6.
3. Mỗi task: test đi cùng implementation (command, cwd, build digest, pass/fail/skip, exit code, raw log);
   chạm storage/crypto/migration cần live PG/Redis/S3/Vault/Connector; browser/API matrix 2 tenant,
   2 replica, local/oidc/both; ghi rõ reused vs independent fixture (`PAR-XA-02`); consumer-side evidence
   cho wire change; không cộng double-count `COMP-10` 31/31.
4. Không sửa file ngoài packet đã cấp; đọc lại source trước khi nhận (file:line trong này theo working tree
   quanh `b088eec`, có thể lệch sau rebase).
