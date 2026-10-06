# CREDWORKFLOW-PREP — production credential workflow writer (READ-ONLY design) — 2026-10-05

**Packet:** CREDWORKFLOW-PREP (Δ5 từ CW-A) · lane cc_1 · dispatch 01:03. **Mode:** READ-ONLY — file duy nhất ghi là receipt này; 0 source edits; không tick/commit.
**Snapshot:** 2026-10-05 01:03–01:2x +07 · HEAD `b088eec`.

## 0. TL;DR

- **Vault client thật ĐÃ CÓ cho Transit** (`VaultTransitProvider`, HTTP thật, env `DU_VAULT_TRANSIT_OPTIONS`); **client KV2 (write/rotate) CHƯA có trong `src`** — chỉ có port `VaultCredentialWriter` (+ mock semantics đầy đủ ở `tests/harness/mock-vault/client.ts` + REST shape thật ở `vault-live.test.ts`). Thiếu đúng **một module writer** + **một composition fn** là workflow bật được.
- Mọi thứ khác đã sẵn: `createCredentialWorkflow` (rotate/revoke/reconcile/describe/resolveBinding — T20-V1 đã siết trust-origin), `createConnectorRevisionHttpAdapter` (0 call-site, dùng thẳng được), CW-A management store (compose xong), capabilities route (tự flip khi `ctx.credentialWorkflow` có).
- Đề xuất: **packet CREDWORKFLOW-IMPL** = 2 file mới + 2 file sửa nhỏ + tests; **không cần migration platform**.

## 1. Map hiện trạng (file:line verified)

### 1.1 Client Vault phía orchestrator

| Thành phần | Ở đâu | Dùng được gì |
|---|---|---|
| **Transit (thật)** `VaultTransitProvider` | `modules/encryption/vault-transit-provider.ts` | HTTP thật: `x-vault-token` từ `VaultTransitIdentity{token:()=>string}`, `redirect:'error'`, timeout, response bounded, mã lỗi typed (`VAULT_FORBIDDEN/UNAVAILABLE/REJECTED/INVALID_VAULT_RESPONSE`) — **pattern request chuẩn để mirror** (`:300-359`) |
| Config env Transit | `boot-options.ts:21-25, :212-260` | `DU_VAULT_TRANSIT_OPTIONS` (JSON: `vaultAddress`, `allowedKeyRefs`, `transitMount?`, `requestTimeoutMs?`), token riêng encrypt/decrypt `DU_VAULT_TRANSIT_ENC_TOKEN`/`_DEC_TOKEN`; compose `new VaultTransitProvider(...)` tại `:255` — **khuôn compose để copy** |
| **KV2 (chưa có)** | grep toàn `src`: chỉ port | `VaultCredentialWriter{ writeCas/readVersions }` (`workflow.ts:40-45`) |

### 1.2 KV2 wire semantics (nguồn: mock + live)

- **Mock đầy đủ** `tests/harness/mock-vault/client.ts:141-166` (dùng chung nhiều suite — semantics đã được pin):
  - `writeCas`: `POST /v1/{mount}/data/{path}` body `{data:{[key]: value}, options:{cas?}}` → **412 `CAS_CONFLICT`**, **403 `CAPABILITY_DENIED`**, ≥500 **retryable**, khác → `VAULT_WRITE_FAILED_<status>`; thiếu token → `VAULT_NO_TOKEN`; thành công trả `data.version`.
  - `readVersions`: `GET /v1/{mount}/metadata/{path}` → `{current_version, versions[]}`; 403 → `PREFIX_DENIED`.
- **REST thật** `tests/vault-live.test.ts:57-88` (window `DU_LIVE_INFRA=1`): đúng 2 call trên + `VAULT_ADDR/VAULT_TOKEN/VAULT_KV_MOUNT` — xác nhận wire không cần bịa.
- `workflow.ts:149-161` `refIssue()` map **error code → HTTP typed**: `CAS_CONFLICT→409 VAULT_CAS_CONFLICT`; token→`403 VAULT_IDENTITY_REJECTED`; policy→`403 VAULT_POLICY_DENIED`; retryable→`503`; còn lại→`502 VAULT_WRITE_FAILED` (message **không** chứa secret). Writer mới **phải throw đúng `{code,retryable}`** để map này chạy.

### 1.3 API rotate/revoke phía platform

- `createCredentialWorkflow` (`workflow.ts:163-436`): `resolveBinding` (yêu cầu binding Migration-008, 403 `BINDING_DENIED` nếu thiếu), `rotate` (writeCas→createPending→activate CAS; idempotency key ⇒ **bắt buộc `IdempotencyPort`** nếu không `503 IDEMPOTENCY_UNAVAILABLE`), `revoke` (`revokeAll` connector disable), `reconcile`, `describe` (masked, chỉ metadata).
- **Dispatcher** `connectors.rotate_credential` (`dispatcher.ts:849-899`): resolveBinding → tenant fence → `executeIdempotent` (dispatcher-level) → rotate (KHÔNG truyền idem key) → **audit `connector.credential_rotate`**.
- **Direct route** `admin.ts:246-277`: `POST/GET /admin/connectors/:id/credentials` — truyền `idempotencyKey+payloadHash` khi client gửi header ⇒ **cần IdempotencyPort**; route này **không tự audit** (audit nằm trong workflow qua `CredentialAuditSink` nếu được inject).
- **Adapter đã có sẵn nhưng 0 call-site**: `createConnectorRevisionHttpAdapter` (`connector-http-store.ts:63`) — chính là `ConnectorRevisionStore` mà workflow cần (get/createPending/bootstrap/activate/retire/revokeAll).
- **Connector-side reader** (`services/connector/src/vault/resolver.ts:10-33`): port `VaultKv2SecretReader` + dev fixture; "real Vault client later" — **thuộc lease connector service**, không thuộc packet này.

## 2. Design: create→clone→rotate→activate (G7) trên nền CW-A

### 2.1 Chuỗi chuẩn (theo prep §3.4 + G7)

| Bước | Ai | Lệnh | Ghi chú |
|---|---|---|---|
| 0 | deploy config | `connectorBaseUrls` + `connectorManagementHeaders` (CW-A) + env Vault mới (§2.3) + `initialBindings` cho chain bound đầu (§2.4) | thiếu một mảnh ⇒ tất cả fail-closed, capabilities nói thật |
| 1 | Platform | `connector.upsert mode:create` (CW-A) HOẶC bootstrap chain đầu | bootstrap = endpoint connector có (`server.ts:230-254`) nhưng **CW-A store chưa expose** → Δ2 §5 |
| 2 | Platform | `connectors.rotate_credential` (đang có) | Vault writeCas (CAS) → createPending (clone head + credentialSource/tenant/account) → activate CAS → ACTIVE; trả masked |
| 3 | Platform | `connector.activate` (CW-A) | cho PENDING tạo qua `upsert mode:revision` (chain đổi ⇒ 409) |
| 4 | Platform | `connector.test` (CW-A) | probe masked `{ok,errorCode?}` |
| 5 | Platform | `connector.disable` / `connector.retire` / `connectors.revoke_credential` | reference-safe: revision đang pin bởi operation cũ **không bị sửa** (chỉ ledger đổi trạng thái) |

**Ranh giới 2 store (không trộn):** `ConnectorManagementStore` (CW-A, DTO platform, actions `connector.*`) ≠ `ConnectorRevisionStore` (workflow port, wire riêng của `connector-http-store`, dùng cho rotate). Cả hai trỏ cùng connector service, base URL từ cùng config.

### 2.2 Composition (điểm bật G1)

Trong `create-app` (kế cận chỗ `connectorManagement`):

```ts
const credentialWorkflow = config.credentialWorkflow
  ?? composeCredentialWorkflow({
       env: process.env,
       revisions: createConnectorRevisionHttpAdapter({ baseUrl: <first>, headers: connectorManagementHeaders }),
       // audit: KHÔNG wire (Δ1 §5) — giữ hành vi audit hiện tại của dispatcher
     });
```

- `composeCredentialWorkflow` (module mới): đọc env §2.3 → dựng `VaultKv2CredentialWriter` → `createCredentialWorkflow({vault, revisions, initialBindings})`.
- Pass `credentialWorkflow` vào `deps.route({...})` như hiện tại (`create-app.ts:645` đang là `config.credentialWorkflow` → đổi thành biến compose); capabilities route **tự flip** `credentialWorkflow:true` (đã có, CW-A).
- `App` seam: thêm `credentialWorkflow` (test seam, như `connectorManagement`).

### 2.3 Env đề xuất (khuôn `DU_VAULT_TRANSIT_OPTIONS`)

| Env | Nội dung | Bắt buộc khi |
|---|---|---|
| `DU_VAULT_KV_OPTIONS` (JSON) | `{ vaultAddress, kvMount?, requestTimeoutMs? }` | bật workflow |
| `DU_VAULT_KV_TOKEN` | token orchestrator-writer (policy: chỉ write metadata path tenant của mình) | bật workflow |
| `DU_CONNECTOR_INITIAL_BINDINGS` (JSON) | `{ [connectorId]: {tenantId, accountId} }` → `deps.initialBindings` (workflow **validate fail-closed lúc construct** — `workflow.ts:176-184`) | khi cần legacy→bound transition |

**Strict-partial policy (đề xuất, Δ3):** có ≥1 env nhưng thiếu/JSON hỏng ⇒ **refuse boot** (kiểu `EncryptionBootConfigError`), không im lặng 503 — cùng triết lý `boot-options.ts:213-216`. Không env ⇒ workflow `undefined`, capabilities `credentialWorkflow:false`.

### 2.4 Writer KV2 mới (`vault-kv2-writer.ts`) — hợp đồng

- Chữ ký: `createVaultKv2CredentialWriter({vaultAddress, kvMount?, token: VaultTransitIdentity|(()=>string|Promise<string>), requestTimeoutMs?, fetchImpl?}): VaultCredentialWriter`.
- Bắt buộc theo mock semantics (§1.2) + hygiene của transit provider: `x-vault-token`, `redirect:'error'`, timeout, response ≤ giới hạn, **throw `{code,retryable}` đúng bảng** (CAS_CONFLICT/CAPABILITY_DENIED/VAULT_NO_TOKEN/5xx-retryable/khác-nonretryable); `readVersions` validate `{current_version, versions[]}`.
- **Không log, không echo value**; message lỗi tĩnh.

## 3. Lease file-map (packet IMPL, chưa mở)

| Vùng | File | Loại |
|---|---|---|
| Writer KV2 | `src/modules/connector-credentials/vault-kv2-writer.ts` | **MỚI** |
| Compose | `src/modules/connector-credentials/compose.ts` (`composeCredentialWorkflow`) | **MỚI** |
| Boot | `src/app/bootstrap/create-app.ts` (compose + pass + seam) | sửa nhỏ |
| Config type | `src/server.ts` (`credentialWorkflow?` giữ nguyên = override; không thêm field nếu env-read nằm trong compose) | sửa nhỏ/không |
| Store CW-A | `connector-management-store.ts` (+`bootstrap()` — Δ2) | sửa nhỏ (nếu chốt) |
| Tests | `vault-kv2-writer-offline.functional.test.ts`, `credworkflow-compose.test.ts`, mở rộng `admin-actions-vault04`/`connector-revision-http-offline` + 1 e2e offline mới | mới/extend |
| Không chạm | `workflow.ts`, `connector-http-store.ts`, connector service, contracts | — |
| **Migration** | **KHÔNG cần** | binding cols + `admin_idempotency` đã tồn tại; Vault external |

## 4. Test plan pin (KHÔNG implement)

**Offline — writer (`vault-kv2-writer-offline.functional.test.ts`):**
1. writeCas happy: body **đúng** `{data:{[key]:value}, options:{cas}}` (literal, không thừa field), trả `data.version`; header `x-vault-token` gửi đúng.
2. **Fail-closed ma trận giả Vault:** 412→`{CAS_CONFLICT,retryable:false}`; 403→`{CAPABILITY_DENIED,false}`; 500→`{…,retryable:true}`; timeout/abort→retryable; thiếu token→`VAULT_NO_TOKEN` — và **qua `refIssue`**: 409 `VAULT_CAS_CONFLICT` / 403 `VAULT_POLICY_DENIED` / 503.
3. **Secret không lộ:** sentinel trong `value` không xuất hiện trong bất kỳ error message/JSON nào (deep scan + base64) ở mọi nhánh lỗi.
4. readVersions: shape đúng → trả; 403→PREFIX_DENIED; body lạ→fail (không best-effort).
5. **Vault down toàn phần** → rotate reject 503, **0 revision row** (assert store chưa được gọi), workflow result không có `revision`.

**Offline — compose (`credworkflow-compose.test.ts`):**
6. env đủ → workflow defined; gọi rotate chạy end-to-end với fake Vault + fake revisions; capabilities `credentialWorkflow:true`.
7. env thiếu/hỏng JSON → **boot/construct refuse** (typed error); env vắng → `undefined` + capabilities false (không regression CW-A).
8. `config.credentialWorkflow` override thắng compose (injection contract giữ).

**Offline — e2e chuỗi (§2.1, 1 file):** create → clone → rotate → activate → test → disable, qua dispatcher + CW-A routes với fake Vault/store: **secret 0 chỗ trên mọi response + audit + log arg**; revoke path; operation cũ giữ revision (không SQL chạm snapshot).
**Live (window riêng, không tính mock):** `DU_LIVE_INFRA=1` + Vault dev + connector service: rotate thật (CAS thật), secret đọc lại được bởi connector-side reader, retire/disable không phá pin.

## 5. Δ / blockers (để coordinator chốt)

- **Δ1 (audit trùng lặp):** nếu wire `CredentialAuditSink` khi compose thì dispatcher-path sẽ có **2 audit rows** (workflow + dispatcher) cho cùng rotate. Đề xuất: **không wire sink** (giữ hành vi audit hiện tại; direct route tiếp tục không audit như hôm nay) — hoặc wire + bỏ audit dispatcher (đổi hành vi đã test). **Khuyến nghị: không wire.**
- **Δ2 (`bootstrap` thiếu trong CW-A store):** chuỗi bound đầu cần `POST /revisions/bootstrap`; `ConnectorRevisionStore` (workflow) có `bootstrap`, nhưng **CW-A store chưa expose** → thêm method + route/action `connector.bootstrap` (hoặc chỉ dùng rotate path như hiện tại). Chốt: làm trong IMPL hay packet riêng.
- **Δ3 (env naming + strict-partial policy):** đề xuất `DU_VAULT_KV_*` như §2.3 + refuse-boot khi partial — chốt tên + chính sách (refuse vs undefined).
- **Δ4 (direct-route idempotency):** route `…/credentials` với `Idempotency-Key` hiện 503 nếu không có `IdempotencyPort`. Optional adapter qua `admin_idempotency` (lookup/store) — chốt có làm kèm IMPL không.
- **Δ5 (connector-side real reader):** `VaultKv2SecretReader` thật vẫn "later" phía connector service — live chain chạy được nhưng connector đọc secret phải dùng dev fixture hoặc client thật của họ (lease riêng, không thuộc lane này).
- **Blocker:** không có cho phần offline; live cần Vault + connector service trong window.

READ-ONLY compliance: chỉ receipt này được ghi; không tick; không commit/push.
