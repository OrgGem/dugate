# CREDWORKFLOW-IMPL — production credential workflow (writer + compose + G7 chain) — 2026-10-05

**Packet:** CREDWORKFLOW-IMPL (D1–D5 adjudications áp dụng) · lane cc_1 · dispatch 01:24. **Offline; không tick; không commit/push.**
**Snapshot:** 2026-10-05 01:24–01:4x +07 · HEAD `b088eec`.

## 0. Write set + pin (post)

| File | Trạng thái | SHA-256 |
|---|---|---|
| `src/modules/connector-credentials/vault-kv2-writer.ts` | **MỚI** | `f0a2b721706c491ffeae…` |
| `src/modules/connector-credentials/compose.ts` | **MỚI** | `401abe6204045046b2e4…` |
| `src/app/bootstrap/create-app.ts` | compose + pass + seam | `1d635893fc99cc8cdfbb…` |
| `src/modules/connectors/connector-management-store.ts` | +`bootstrap()` (D2) | `eced6192cfef4c47baf8…` |
| `src/modules/admin-actions/dispatcher.ts` | +`connector.bootstrap` (D2) | `9808d0dbce80607c6511…` |
| `packages/contracts/src/connector-management.ts` | +`ConnectorBootstrapParamsSchema` | `6e9b7f913828f876342f…` |
| `packages/contracts/dist/connector-management.d.ts` | rebuild (`tsc -p`, exit 0) | `246cff94e298552c8110…` |
| `tests/vault-kv2-writer-offline.functional.test.ts` | **MỚI** | `1f1e57a8d36e47b7a86e…` |
| `tests/credworkflow-compose.test.ts` | **MỚI** | `b6047be0f8abd8fd8a1e…` |
| `tests/credworkflow-e2e-offline.functional.test.ts` | **MỚI** | `c880d5cab530cb969111…` |

**No-touch (hash cũ nguyên):** `workflow.ts` `496c08cf…`; `connector-http-store.ts` `6cd185c4…`; không chạm connector service/contracts khác.

## 1. Thi hành theo D1–D5

- **D1 (no sink):** composer **KHÔNG** wire `CredentialAuditSink` — audit giữ nguyên hành vi (dispatcher tự audit `connector.credential_rotate`; direct route không audit như hôm nay). Ghi chú: khi nào cần audit direct-route ⇒ decision riêng.
- **D2 (bootstrap):** `ConnectorBootstrapParamsSchema` (contracts) + `store.bootstrap()` (strip `replayed` trước khi parse DTO strict — connector trả `{...view, replayed}`) + action `connector.bootstrap` admin-only (audit `connector.bootstrap`, idempotency như các mutation khác, 503 khi thiếu store).
- **D3 (env + refuse-boot):** `composeCredentialWorkflow({env, revisions, fetchImpl?})` — env đủ (`DU_VAULT_KV_OPTIONS` JSON {vaultAddress bắt buộc, kvMount?, requestTimeoutMs?} + `DU_VAULT_KV_TOKEN` + optional `DU_CONNECTOR_INITIAL_BINDINGS`) → workflow; **partial/hỏng ⇒ `CredentialWorkflowBootError` (refuse-boot typed)**; **vắng hết ⇒ undefined** (+ capabilities false — logic CW-A sẵn có). create-app: compose khi requested **và** có `connectorBaseUrls` (thiếu base ⇒ refuse-boot typed); `config.credentialWorkflow` **override** thắng compose; seam `credentialWorkflow` thêm vào App return.
- **D4 (defer):** không làm idempotency adapter; direct route với `Idempotency-Key` tiếp tục **503 IDEMPOTENCY_UNAVAILABLE** khi thiếu port (giữ nguyên); note đã ghi trong compose doc.
- **D5:** không chạm connector-side reader.

## 2. Writer KV2 (`vault-kv2-writer.ts`)

- Wire đúng semantics đã pin: `POST /v1/{mount}/data/{path}` body `{data:{[key]:value}, options:{cas}?}`; `GET /v1/{mount}/metadata/{path}`; header `x-vault-token`; `redirect:'error'`; timeout abort; response ≤64KB; URL absolute bắt buộc.
- **Failure contract** cho `refIssue`: `412→CAS_CONFLICT`, `403→CAPABILITY_DENIED` (metadata→`PREFIX_DENIED`), `401/thiếu token→VAULT_NO_TOKEN`, `408/429/5xx→VAULT_SERVER_ERROR retryable`, network/timeout→`VAULT_UNAVAILABLE retryable`, 200 thiếu version→`VAULT_WRITE_FAILED` (không pin version không tồn tại), metadata hỏng→`VAULT_METADATA_FAILED`.
- **Không message nào chứa secret** (mọi throw là chuỗi tĩnh).

## 3. Evidence literal (cwd `services/orchestrator`)

| Lệnh | Kết quả |
|---|---|
| `packages/contracts`: `npx tsc -p tsconfig.json` | **CTRB=0** |
| `npx tsc --noEmit -p tsconfig.json` | **TSC=0** (giữa chừng) → cuối **TSCF=0, ERR=0** |
| 3 suite mới (`writer` 5 + `compose` 4 + `e2e` 3 = 12) **× 3 lượt** | **R1/R2/R3=0 — mỗi lượt `3 suites / 12 tests passed`** (2 vòng fix fixture inline: `account` field + audit mock typing — ghi §3.1) |
| Regression 9 suite: `crx01`, `crx02`, `enc-meta-sentinel-outbox`, `admin-actions-vault04-offline`, `connector-revision-http-offline`, `connector-credentials-offline`, `p745-connector-{management-proxy,actions,boot-composition}` | **REG=0 — `9 suites / 89 tests passed`** |

### 3.1 Fix inline (mid-hop)
- Fixture `credentialSource` thiếu `account` (contract vault-kv2 yêu cầu) → thêm `account:'a1'` ở 2 file.
- `audit.record` jest.fn() calls typing (`TS2352/TS2493`) → khai báo tham số tường minh `(_input, _client?)`.

## 4. Hành vi được pin (12 test)

- **Writer (5):** body/URL/header **literal** (kèm case không `cas` — không có `options` block); ma trận fail `{code,retryable}` đúng 7 case (412/403/401/500/429/400/200-thiếu-version) + network/timeout/no-token (kể cả token supplier throw) — **mọi message không chứa sentinel** (kể cả own-properties); readVersions exact + PREFIX_DENIED + body hỏng fail-closed.
- **Compose (4):** requested() semantics; partial/bad JSON/bad URL ⇒ `CredentialWorkflowBootError`; complete env ⇒ **rotate thật chạy** (Vault write có CAS, `createPending` được gọi với path canonical, result `{revision:3,state:'ACTIVE',version:3}`; sentinel **có** trong Vault body (positive control), **không** trong result); Vault down ⇒ **503, `createPending` 0 lần**.
- **E2E + boot (3):** chuỗi thật `create→bootstrap→rotate→activate→test→disable` qua **dispatcher + CW-A store + credential workflow** — bootstrap body có `replayed:false`, rotate gọi Vault đúng 1 lần, **sentinel không xuất hiện** ở: mọi response body, mọi audit arg, mọi request body gửi connector, mọi SQL (deep scan + base64); audit actions **đúng thứ tự 5 hàng**; **0 SQL chạm operations/connector_bindings/profile_policy_snapshot**; Vault-down case: rotate 503 + không request revision nào tới connector + 0 audit. **Boot:** env đủ ⇒ `app.credentialWorkflow` defined; vắng ⇒ undefined.

## 5. Δ / chuyển tiếp

- **Live còn thiếu (window riêng):** Vault dev thật + connector service thật: rotate CAS thật, secret đọc lại bởi connector-side reader (D5 — reader thật của họ vẫn "later"), `DU_LIVE_INFRA=1` chain; vault-live.test.ts sẵn có cho Transit/KV round-trip.
- **D4 note giữ nguyên:** direct route `…/credentials` + `Idempotency-Key` = 503 khi chưa có port; adapter optional chờ decision.
- Không tick; không commit/push; chỉ file trong §0 được ghi.
