# P745-CONNECTOR-WIRE-PREP — design prep connector save/test/activate (READ-ONLY) — 2026-10-04

**Packet:** P745-CONNECTOR-WIRE-PREP (message-only spec) · **Lane:** cc_1 (`term_c03791d1`) · **Run:** `run_069ecd6957cd` (task `task_3b30aa15f0d3`, dispatch `ctx_041e4b0edaae`, state `:627-634`).
**Snapshot đo:** 2026-10-04 **21:33–21:55 +07**. **Mode:** READ-ONLY — file duy nhất ghi là receipt này; 0 source edits; không tick/commit.

## 0. TL;DR

- **Backend connector ĐÃ CÓ, không thiếu**: Connector service đã implement đầy đủ management API — list/create (`POST /connectors`), clone revision (`POST /connectors/:id/revisions`), bootstrap (first bound chain), activate **CAS** (`.../revisions/:rev/activate`), retire, current/one GET, `test`, `disable`, `credentials/rotate` — với service-identity scope `connector:manage` và redaction header (`[REDACTED]`).
- **GAP nằm ở phía platform (Orchestrator + UI)** — 6 mục:
  - **G1 (blocker chính, = F3)**: `createCredentialWorkflow` (workflow.ts:163) + `createConnectorRevisionHttpAdapter` (connector-http-store.ts:63) **tồn tại nhưng 0 nơi gọi trong src** → `config.credentialWorkflow` chỉ là type optional pass-through (route-context.ts:69, server.ts:111) → mọi `connectors.*` fail-closed 503 (dispatcher.ts:687-689,:729-730). Chưa có boot composition.
  - **G2**: thiếu admin **read** list (`GET /api/v1/admin/connectors`) và các **mutation actions** create/update-as-revision/activate/disable/retire/config-test; table `ADMIN_ACTIONS` (dispatcher.ts:95-121) chỉ có rotate/revoke/test_credential.
  - **G3**: `GET /api/v1/admin/connectors/:id/revisions/:rev` hiện là **placeholder projection** (adapter 'unknown', `capabilities: []`, `state: 'disabled'` — admin.ts:459-501), **không đọc ledger Connector service** → UI disabled đúng như nhãn F3 nhưng không phải "không có backend".
  - **G4**: chưa có DTO canonical platform-side cho connector revision/target (admin-web tự khai `ConnectorRevision` type: lib/api/types.ts:70-81 ≠ `RedactedConnectorRevision` của connector service incl. `credentialRef`/`credentialSource`/binding).
  - **G5**: BFF + admin-web chưa có action wire (BFF chỉ GET revision: bff/handle.ts:92,:349; screen draft in-memory — connectors-screen.tsx:228-297).
  - **G6**: "Test connection" theo CFGADM-07 (prompt/multi-file provider test) chưa expose platform-side; `connectors.test_credential` hiện chỉ là **health probe** `/health/ready` (connectors.ts:49-83).
- **Đề xuất wire** (§3): giữ GET mới là admin routes mỏng (proxy + redact), mutations đi qua `/api/v1/admin/actions` (tận dụng RBAC/CSRF/idempotency/audit sẵn), DTO mới trong contracts, compose boot với connector base URL/identity, UI bật nút theo capability thật.

## 1. Bản đồ hiện trạng (file:line verified)

**S1 — Dispatcher admin actions** (`modules/admin-actions/dispatcher.ts`):
- Table `ADMIN_ACTIONS` `:95-121`: `business.*`, `operations.{sweep-deadlines,cancel,resume}`, `apikey.{issue,revoke,bind-profile}`, `connectors.{rotate_credential,revoke_credential,test_credential}` (platform/admin-only).
- Cases `:677-769`: rotate (CAS + Vault + audit `connector.credential_rotate`, 503 khi thiếu workflow `:687-689`), revoke (`:727-751`), test_credential = **health probe** qua `deps.connectorTest` (`:753-768`, mask còn `{connectorId, ok, errorCode}`).
- Deps `:63-66`: `credentialWorkflow?`, `connectorTest?` — optional/fail-closed.

**S2 — Admin routes hiện có** (`http/routes/admin.ts`):
- `POST|GET /api/v1/admin/connectors/:id/credentials` `:225-259` — credentialWorkflow rotate/describe; **503 nếu chưa compose** (`:233-235`).
- `GET /api/v1/admin/connectors/:id/revisions/:rev` `:459-501` — placeholder ("NO connector registry table on the platform… real connector revision ledger is a follow-up" `:460-467`); envelope: `adapter:'unknown'`, `endpoint:{kind:'configured',maskedHost}`, `capabilities:[]`, `state:'disabled'`, `secretSlots:[]`, `testResult:null`.
- Public probe `GET /api/v1/connectors/:id/test` (`public.ts:196-204`).

**S3 — Composition (vì sao F3)**:
- `workflow.ts:163` `createCredentialWorkflow(deps…)`; port `ConnectorRevisionStore` `:59-90` (get/createPending/bootstrap?/activate CAS/retire/revokeAll?) — đúng shape API connector service.
- `connector-http-store.ts:63` `createConnectorRevisionHttpAdapter` (map sang `GET /connectors/:id/revisions/current`, `POST .../revisions`, `.../activate`, `.../retire`; 503/502 sanitize `:16-21`).
- **Grep toàn src: 0 call-site** của cả hai factory; `credentialWorkflow` chỉ xuất hiện ở type (`server.ts:111`, `route-context.ts:69`) và truyền qua (`admin.ts:331`, `create-app.ts:609`). Base URL cho proxy health `create-app.ts:396-399` (`connectorBaseUrls`).

**S4 — BFF** (`app/admin/bff/`): chỉ `GET /admin/api/connectors/:id/revisions/:rev` → upstream admin route (`handle.ts:92,:349`); không có list/POST connector. (aweb05 receipt `:12,:18,:30-32` ghi F3/F7 disabled honest.)

**S5 — admin-web** (`apps/admin-web/src/features/connectors/`):
- `connectors-screen.tsx:17-24` header "no connector list/registry route (PAR-03/14)… Test/rotate stay disabled"; lookup `:32-48`; nút disabled `:190-203` ("Capability not composed… F3/PAR-03/14"); draft cURL in-memory `:228-297` (Save/Test disabled `:275-290`).
- `state.ts:9-36` parse `ConnectorRevision` (ước lượng: endpoint.maskedHost/capabilities/secretSlots/testResult); `:46-57` `ConnectorImportDraft` (in-memory-only).
- `lib/api/types.ts:70-81` `ConnectorRevision`; `client.ts:51-54,:177-178` `getConnectorRevision`.

**S6 — Connector service (đã xong — nguồn để proxy)** (`services/connector/src`):
- `http/server.ts:164-352`: `GET /connectors` (list, `redactConnectorRevision`) `:164-167`; `POST /connectors` (create; validate connectorId/adapter/credentialRef/config/state ACTIVE|PENDING) `:168-198`; `POST /connectors/:id/revisions` (clone PENDING; bắt buộc `credentialSource`+tenant+account) `:202-226`; `revisions/bootstrap` `:230-254`; `revisions/:rev/activate` CAS `expectedCurrentRevision` → 200/409 `:255-272`; `retire` `:273-281`; `current`/`:rev` GET `:282-297`; `test` `:349-352`; `disable` `:344-348`; `credentials/rotate` `:335-343`.
- Identity: path `/connectors*` yêu cầu scope `connector:manage` (`:131-139`); tenant scope selector `:146-156`.
- `redactConnectorRevision` (`config.ts:19-30`) — mask mọi header value `[REDACTED]`; revision shape `repository.ts:261-288` (credentialRef + credentialSource + tenantId/accountId binding); `ConnectorCredentialSourceSchema` (`packages/contracts/src/vault.ts:185-192`).

**S7 — Contracts**: invocation wire `connector.ts:42-88` (strict, `options` passthrough — MEDIUM-1 prep riêng); **không có DTO management** cho platform → cần file mới (§3).

**S8 — Liên quan**: PAR-14 (lifecycle + Vault write-only, field legacy Connections đã liệt kê trong `tasks/ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md:84-98`); CFGADM-07 (full lifecycle + Import cURL + prompt/multi-file test + profile binding, reference-safe retire); binding profile giữ qua `connector_bindings` slot→{connectorId, revision} (PAR-12).

## 2. GAP chính xác

| # | GAP | Bằng chứng | Hệ quả |
|---|---|---|---|
| G1 | Boot chưa compose credential workflow + revision adapter store | 0 call-site `createCredentialWorkflow`/`createConnectorRevisionHttpAdapter`; F3 ⇒ 503 (dispatcher.ts:687-689) | Mọi action connector fail-closed; cũng là "capabilities: []" trên UI |
| G2 | Thiếu platform endpoints/actions: create, update-as-revision, activate, disable, retire, config-test, list | admin.ts:459-501 + dispatcher.ts:95-121 | Không thể Save/Test/Activate từ bất kỳ UI nào |
| G3 | Read route không đọc ledger (placeholder) | admin.ts:487-501 | UI nhận projection giả-nghĩa (đúng nhưng không tiến hoá được theo thật) |
| G4 | Thiếu DTO canonical platform-side (write/read/test + redaction contract) | lib/api/types.ts:70-81 vs config.ts:5-30 | Mapping ad-hoc, rủi ro lộ `credentialSource`/header values |
| G5 | BFF + UI chưa có action wire (POST) | handle.ts:92; screen :275-290 | Save/Test/Activate vẫn disabled (đúng, không giả) |
| G6 | Provider test (prompt/multi-file) chưa expose; `test_credential` = health probe | dispatcher.ts:753-768; connectors.ts:49-83 | CFGADM-07 journey J-AI/J-SETUP chưa chạy được end-to-end |
| G7 | Sequencing credential: connector create/clone cần `credentialRef`+`credentialSource` (write-only Vault) nhưng platform chưa có flow "save config → gắn credential → activate" | server.ts:168-226 yêu cầu field; route rotate riêng (admin.ts:225-259) | Cần quyết định thứ tự (rotate trước hay clone-rồi-rotate-rồi-activate) + bootstrap cho chain đầu |

## 3. Đề xuất wire (không thực thi)

**3.1 Endpoints (platform admin API):**
- Reads (admin route mỏng, redact, không echo upstream body khi lỗi):
  - `GET /api/v1/admin/connectors` → proxy connector `GET /connectors` (list, redacted).
  - `GET /api/v1/admin/connectors/:id/revisions/:rev|current` → **thay placeholder** bằng proxy thật + redaction; 404/503 map chuẩn.
- Mutations → thêm vào `/api/v1/admin/actions` (RBAC/CSRF/idempotency/audit đã có sẵn; khớp hint UI "ride /admin/api/actions"):
  - `connector.upsert` — create mới hoặc clone revision mới (config + adapter + binding; **secret không nằm trong payload này**).
  - `connector.activate` — CAS `expectedCurrentRevision` (409 khi chain đổi; audit).
  - `connector.disable` / `connector.retire` — reference-safe (không xoá revision đang được pin bởi operation cũ).
  - `connector.test` — provider/config test (payload giới hạn: prompt/files; response masked `{ok,latencyMs?,errorCode?,provider?}`); giữ `connectors.test_credential` (health probe) như lớp riêng.
  - Giữ nguyên `connectors.rotate_credential/revoke_credential`.
- BFF: map `/admin/api/connectors` (list) + `/admin/api/actions` (các action trên) sau session gate.

**3.2 DTO (contracts mới — đề xuất `packages/contracts/src/connector-management.ts`):**
- `ConnectorRevisionViewSchema`: `{connectorId, revision, adapter, state: PENDING|ACTIVE|RETIRED, configSummary: {headers: string[] (chỉ keys), …không value}, endpoint{kind,maskedHost}, capabilities: string[], secretSlots: [], testResult, tenantId?, accountId?, createdAt, updatedAt}` — `.strict()`, không mang secret.
- `ConnectorRevisionWriteSchema`: `{connectorId, adapter, config (subset an toàn của AdapterConfig), tenantId?, accountId?, credentialSource?: ConnectorCredentialSourceSchema, expectedCurrentRevision?}` — secret chỉ qua route/action rotate (Vault write-only).
- `ConnectorTestRequestSchema/ResponseSchema`: request `{prompt?, files?: [{name,mimeType,contentBase64?}]}` (bounded size), response masked.
- Nguyên tắc: platform **không** lộ `credentialRef` nội bộ nếu không cần; header values chỉ tồn tại dạng `[REDACTED]`/absent.

**3.3 Capability advertisement**: ưu tiên derive từ composition (proxy + workflow + connector `/capabilities` — server.ts:163) thay cho `[]` tĩnh; UI bật nút theo capability list này (giữ nguyên nguyên tắc "không nút giả").

**3.4 Sequencing (G7, đề xuất)**: `save draft (config, ACTIVE/PENDING tuỳ chain)` → `rotate credential (Vault, trả ref)` → `clone/bootstrap revision gắn credentialSource` → `activate CAS` → `test`. Bootstrap dùng cho chain bound đầu tiên (workflow.ts:70-76; server.ts:230-254).

**3.5 Lease dự kiến (file-map cho packet implement):**

| Vùng | File dự kiến | Ghi chú |
|---|---|---|
| Orchestrator proxy/store | `src/modules/connectors/connector-management-store.ts` (mới; tái dùng pattern `connector-http-store.ts`) | 1 writer |
| Orchestrator routes | `src/http/routes/admin.ts` (mục connectors) hoặc tách `admin-connectors.ts` | thin dispatcher, không logic nghiệp vụ |
| Orchestrator actions | `src/modules/admin-actions/dispatcher.ts` (+ADMIN_ACTIONS) | RBAC/audit sẵn |
| Orchestrator boot | `src/main.ts` / `src/app/bootstrap/create-app.ts` / `src/http/route-context.ts` | compose workflow (Vault store + revision adapter + identity headers) |
| Contracts | `packages/contracts/src/connector-management.ts` + `index.ts` | single-writer |
| BFF | `src/app/admin/bff/handle.ts` (+ nhánh mới) | session gate |
| admin-web | `features/connectors/{connectors-screen,state,curl-import*}`, `lib/api/{types,client}` | UI bật nút + draft→write mapping |
| Connector service | **read-only** (API đủ); nếu test payload cần mở rộng → lease riêng | xác nhận `management.test` shape khi implement |

**3.6 Test plan pin (offline/live):**
- Offline — orchestrator:
  1. `p745-connector-management-proxy.test.ts` — list/get passthrough + redaction (không header value/credential secret trong response); 502 sanitize (không echo body); 503 fail-closed khi chưa compose; map 409 CAS.
  2. `p745-connector-actions.test.ts` — RBAC matrix (platform-only), CSRF, idempotency replay, audit row `connector.*`, tenant scope; `disable/retire` không phá pin operation cũ (assert SQL không update snapshot cũ).
  3. `p745-connector-boot-composition.test.ts` — boot thiếu workflow → 503; boot đủ (fake workflow+store) → happy path; capability list phản ánh composition.
- Offline — BFF: `bff-connectors-actions.test.ts` — session gate, 401/403/409 envelope, 405.
- Offline — admin-web: `connectors-wire.test.ts` — parse DTO mới, capability gating, draft→`ConnectorRevisionWrite` mapping (secret chỉ write-only, summary vẫn masked).
- Live (window riêng): compose connector service + Vault thật → create→clone→rotate→activate→retire round trip + profile binding pin (operation cũ giữ revision); J-AI/J-SETUP connector leg (CFGADM-07). Không tính mock/receipt cũ.

## 4. Limitations

- Static read-only; chưa chạy test/build; chưa mở connector stack. `management.test` phía connector (services.ts) chưa đọc full signature — cần xác nhận khi implement (G6).
- "0 call-site" xác định bằng grep `services/orchestrator/src` (harness/test ngoài phạm vi).
- Đây là prep + khuyến nghị kỹ thuật — không phải product/quyết định dispatch; mọi lease/ordering chờ coordinator chốt.

READ-ONLY compliance: chỉ receipt này được ghi; không tick/sửa; không commit/push.
