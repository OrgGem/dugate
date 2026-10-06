# CONNECTOR-WIRE-A (backend core) — 2026-10-05

**Packet:** CONNECTOR-WIRE-A · lane cc_1 · dispatch 00:33. **Offline; không tick; không commit/push.**
**Spec:** `p745-connector-wire-prep` §3.1–3.6 (quyết định kèm, ghi rõ ở §2). Snapshot: 2026-10-05 00:33–00:55 +07 · HEAD `b088eec`.

## 0. Write set + pin (post)

| File | Trạng thái | SHA-256 |
|---|---|---|
| `packages/contracts/src/connector-management.ts` | **MỚI** | `de14780b33e6bdb413ef…` |
| `packages/contracts/src/index.ts` | +1 export | `dae8481058818936d659…` |
| `packages/contracts/dist/{connector-management.d.ts,.js}` | rebuild (`tsc -p tsconfig.json`, exit 0) | `b1ccbd28…` / `15762c6a…` |
| `src/modules/connectors/connector-management-store.ts` | **MỚI** | `23a851ee1345909f666f…` |
| `src/http/route-context.ts` | +`connectorManagement?` | `570a1c04687602de3d21…` |
| `src/server.ts` | +`connectorManagementHeaders?` | `3f4d9759e5823e2617e9…` |
| `src/http/routes/admin.ts` | +capabilities/list + real-ledger branch | `fa2dd6b8a9bd31d56e90…` |
| `src/modules/admin-actions/dispatcher.ts` | +5 action + deps | `668113436c973b1a5c92…` |
| `src/app/bootstrap/create-app.ts` | compose + pass + seam | `ab2a123ef56ac2ede61c…` |
| `tests/p745-connector-management-proxy.test.ts` | **MỚI** | `7c38d6a88e5a37c62ee2…` |
| `tests/p745-connector-actions.test.ts` | **MỚI** | `f571865cbb57e6ea6c60…` |
| `tests/p745-connector-boot-composition.test.ts` | **MỚI** | `3e9af01fba39cbf08220…` |

**No-touch (hash cũ nguyên):** connector service `http/server.ts` `5695e392…`, `config.ts` `daca8611…` (API đọc đủ); `workflow.ts` `496c08cf…`; `connector-http-store.ts` `6cd185c4…`. Không chạm BFF/admin-web (packet B), publish/runtime/submission.

## 1. Thi hành theo §3.5 (5 mục)

1. **Store** `connector-management-store.ts` (pattern `connector-http-store`): `list/getRevision/getCurrent/create/createPending/activate(CAS)/retire/disable/test` — transport→**503** reconcile-safe; status lạ→**502 không echo body**; 200 sai DTO→**502**; 404→`undefined`; 409 activate→`false`; test **narrow** `{ok, errorCode?}`.
2. **Routes admin** (thin): `GET /api/v1/admin/connectors/capabilities` (`{management, credentialWorkflow, test}` — booleans từ composition); `GET /api/v1/admin/connectors` → `{items}` (503 khi thiếu store); `GET .../revisions/:rev` → **ledger thật khi compose** (`latest|current`→current, digits→revision, 404 chuẩn).
3. **Dispatcher** `ADMIN_ACTIONS` +5: `connector.upsert|activate|disable|retire|test` — **admin-only** (bearer platform / cookie admin), CSRF-before-role giữ nguyên; `upsert` = discriminated union `mode:'create'|'revision'`; `activate` CAS loss → **409 `STATE_CONFLICT`** (không audit); 4 mutation có audit row đúng principal fields; store thiếu → **503 trước mọi side effect**.
4. **Boot composition**: create-app compose store từ `connectorBaseUrls` (rỗng ⇒ `undefined` — fail-closed); service-level (list) = URL đầu tiên; named connector resolve đúng entry (unknown→404, không open proxy); `connectorManagementHeaders` (mới, optional) = injection điểm service-identity `connector:manage`.
5. **Contracts** `connector-management.ts`: view `.strict()` (unknown field ⇒ 502, không nới wire), upsert/activate/target params (strict), test result (narrow-rebuild), capabilities; tái dùng `ConnectorRevisionStateSchema` từ `vault.ts` (không nhân bản).

## 2. Deviations có chủ đích (để coordinator adjudicate)

- **Δ1 — placeholder giữ làm degraded shape:** prep §3.1 nói "thay placeholder"; thi hành: **compose ⇒ ledger thật**, **không compose ⇒ giữ nguyên placeholder honest** (byte-identical) thay vì 503. Lý do: supertest/frozen `admin-base-routes` pin shape placeholder trong cửa sổ live + shell hiện dựa vào envelope đó; 503 read-route sẽ là hồi quy ngoài phạm vi A. Capabilities phơi `management:false` để client gate — không dữ liệu bịa.
- **Δ2 — `connector.test` KHÔNG audit** (mirror `connectors.test_credential`: probe không đổi trạng thái); 4 mutation còn lại audit đầy đủ.
- **Δ3 — `connectorManagementHeaders` mới trong ServerConfig** (không có trong lease liệt kê — additive optional, cần cho identity khi gọi connector service; mặc định absent vẫn compose).
- **Δ4 — revision DTO `.strict()` ⇒ connector thêm field lạ = 502** (fail-closed, không silently widen). Nếu muốn strip thay vì reject, đổi 1 chữ ký schema — nêu rõ.
- **Δ5 — `credentialWorkflow` vẫn là config-injected** (Vault writer chưa có implementation production trong `src` — grep xác nhận); capabilities phơi `credentialWorkflow:false` khi thiếu. Compose workflow thật = packet riêng (cần Vault client) — không tự mở.

## 3. Evidence literal (cwd `services/orchestrator`)

| Lệnh | Kết quả |
|---|---|
| `npx tsc --noEmit` trong tiến trình | **CW_TSC1=2** (4 lỗi store tự gây: CFA `never` + narrow body) → fix inline → **CW_TSC2=0** → cuối **CW_TSCF=0, ERR=0** |
| `packages/contracts`: `npx tsc -p tsconfig.json` | **CTRB_EXIT=2** (trùng tên `ConnectorRevisionState*` với `vault.ts` → tái dùng) → **CTRB2=0**; sau đó **CTRB3=0** (đổi test-result non-strict) |
| 3 suite mới (`proxy` 11 + `actions` 10 + `boot` 2 = 23) **× 3 lượt** | **R1/R2/R3=0 — mỗi lượt `3 suites / 23 tests passed`** (lượt đầu có 3 fix test-harness, xem §3.1) |
| Regression: `crx01` + `crx02` + `enc-meta-sentinel-outbox` + `admin-actions-vault04-offline` + `connector-revision-http-offline` + `connector-credentials-offline` + `admin-base-routes` | **REG1=0 — 6 suites passed / 66 tests; 1 suite SKIP có lý do:** `admin-base-routes` window-gated (`DU_LIVE_INFRA=1` mới chạy, boots real PG :5433/Redis :6380 — đúng guard của chính nó, 7 tests skip) |

### 3.1 Fix trong tiến trình (mid-hop, ghi minh bạch)
- Store: `unexpected()` chuyển arrow-const → function declaration (`never` CFA); narrow `body` trong `list()`.
- Test-harness tự sửa: scripted fetch dùng chung handler trả sai shape cho call thứ hai; capture thêm `headers` để assert identity thật.
- Contracts: `ConnectorTestResultSchema` bỏ `.strict()` (store rebuild narrow — upstream thêm field không làm probe 502, không nới wire).

## 4. Hành vi được pin (23 test)

- **Store (13):** list giữ redaction `[REDACTED]` + unknown-field⇒502; identity headers gửi mọi call; transport⇒503; status lạ⇒502 **không echo body**; DTO sai⇒502; 404⇒undefined; CAS 409⇒false/200⇒true; retire/disable URL đúng + 204⇒void; test narrow `{ok}` (providerBody bị bỏ).
- **Actions (9):** 401/403 (viewer/operator/anonymous) zero store-call; CSRF-before-role; 503 đủ 5 action khi thiếu store; 422 mode/param; upsert create/pending đúng input; activate CAS-loss 409 **không audit**, win⇒audit; disable/retire audit warning + **không một SQL nào chạm operations/connector_bindings/profile_policy_snapshot** (pin-safety); test masked + không audit; **Idempotency-Key replay**: 1 store call, 1 audit, response thứ hai bằng response thứ nhất; cùng key khác payload ⇒ 409 `IDEMPOTENCY_CONFLICT`.
- **Boot (2):** không `connectorBaseUrls` ⇒ seam `undefined`; có ⇒ store defined + `list()`/`test()` chạy qua fetch-stub đúng URL, redaction giữ, probe narrow.

## 5. Chuyển tiếp / giới hạn

- **Packet B (chưa làm):** BFF map `/admin/api/connectors*` + `/admin/api/actions`; admin-web bật nút theo capabilities + draft→upsert mapping; T6.
- **Live còn thiếu:** round-trip connector thật (create→clone→rotate→activate→retire) + Vault thật + window `DU_LIVE_INFRA=1` (admin-base-routes placeholder pin chạy ở đó); observed provider test live.
- **Credential workflow production writer** (Vault KV2) = packet riêng (§2 Δ5).
- Không tick; không commit/push; chỉ các file trong §0 được ghi.
