# DOCS-CONNECTOR-WIRE — openapi connector family + BFF map + env + ENC-09 note — cc_2 — 2026-10-05

**Packet:** coordinator 02:34 (+07). **Mode:** doc-only; offline; no commit; không tick. Giữ format hiện có (x-absent array-style, bảng env 12b, note block 04-data-state).
**Boundary:** 3 docs + receipt này. Không chạm source/tests/tasks/ledger.

---

## 0. TL;DR

- **openapi**: thêm **route family connector management** (3 path: list / capabilities / revisions) + **`x-bff-map`** (4 mapping BFF→orchestrator). JSON parse OK.
- **docs env (12b §3.2 mới)**: `DU_VAULT_KV_OPTIONS` / `DU_VAULT_KV_TOKEN` / `DU_CONNECTOR_INITIAL_BINDINGS` (env thật của compose credential workflow — all-or-nothing, refuse-boot khi partial) + deployment config `connectorBaseUrls` / `connectorManagementHeaders` (ServerConfig **chưa có env parser** trong `main.ts` — ghi trung thực, kèm hành vi 503/capabilities false).
- **ENC-09 note (04-data-state)**: block mới — **7 METADATA_SLOTS** (5 cũ + `operations.prompt_overrides_ref` + `tasks.result_ref`/`operations.result_ref`), convention envelope JSON text cho cột TEXT, `readStoredText` fail-closed, **backfill window** `allowPlaintext=true` (legacy verbatim) → đóng ⇒ `NOT_SEALED`; **backfill thật chưa chạy** (chỉ offline receipts); G-ENC không đổi.
- **Stale refs check**: 0 stale trong scope (chi tiết §4).

## 1. File đã sửa (post-edit sha16)

| File | Việc | sha16 |
|---|---|---|
| `docs/21-openapi.json` | +3 paths admin connectors (:2660-2743) +`x-bff-map` (:2751-2756) | `DF2495AED3134E16` |
| `docs/12b-deployment-guide.md` | +§3.2 connector management + Vault credential workflow (:153-170) | `76C718DBE860BC60` |
| `docs/04-data-state.md` | +§ENC-META/ENC-09 slots + backfill window note (:98-106) | `F431FD54E4404DFC` |

## 2. Nội dung chính

### 2.1 openapi — route family + BFF map

- `GET /api/v1/admin/connectors` — list platform ledger (redaction `[REDACTED]`, strict DTO; 503 khi seam chưa compose; `admin.ts:543`, auth `AdminBearer`).
- `GET /api/v1/admin/connectors/capabilities` — `{management, credentialWorkflow, test}` verbatim, `false` không bị làm phẳng (`admin.ts:532`).
- `GET /api/v1/admin/connectors/{id}/revisions/{rev}` — `latest|current|digits`; ledger thật khi compose / degraded envelope khi không (Δ1); `secretSlots []` — secret không bao giờ lên wire (`admin.ts:551-602`).
- `x-bff-map` (mới, cùng style mảng string như `x-absent`): 4 mapping — list / capabilities / revisions / `POST /admin/api/actions`; ghi rõ fence platform-admin tại BFF (401/403 trước upstream), relay verbatim, CSRF-before-upstream + Idempotency-Key clamp 200.

### 2.2 12b — env + deployment config

- 3 env mới với semantics all-or-nothing + refuse-boot typed (`CredentialWorkflowBootError`); `DU_VAULT_KV_TOKEN` = machine identity (không root token ngoài provisioning).
- `connectorBaseUrls`/`connectorManagementHeaders`: document là **deployment config (ServerConfig)**, hiện **chưa env-wired** trong `main.ts` — thiếu base ⇒ seam `undefined` ⇒ list 503 + capabilities `management:false` + credential workflow refuse-boot nếu requested. Không bịa tên env không tồn tại.

### 2.3 04-data-state — ENC-09

- 7 slots kèm lý do tách slot (`tasks.result_ref` vs `operations.result_ref` vì cùng chuỗi ở 2 row; AAD bind `(tenant, slot, refId)` ⇒ replay chéo = `CONTEXT_MISMATCH`).
- Window semantics + trạng thái thật (chưa backfill live; docs 28/35 cập nhật khi window mở; không gate đổi).

## 3. Evidence literal

```
node JSON.parse(docs/21-openapi.json): OPENAPI_JSON_OK
'/api/v1/admin/connectors' mentions in openapi: 6 (3 paths + refs)
'x-bff-map' in openapi: 1
'not yet routed|contract frozen, not yet' in openapi: 0
```

## 4. Stale refs check (sweep)

| Check | Kết quả |
|---|---|
| `not yet routed` / `contract frozen, not yet` trong openapi | **0** (đã đóng ở DOC-SYNC-TAPI01, còn sạch) |
| Connector management bị liệt kê trong `x-absent` | Không — không có entry mâu thuẫn; 3 path đã hiện diện thật |
| `8081` trong docs | 3 hit `docs/17-operational-runbooks.md:86,111,112` — **KHÔNG stale**: đối chiếu `infra/docker-compose.yml:59` (`127.0.0.1:8081:8080`, connector profile loopback, "not a production deployment plan") — khớp nguyên văn |
| `connectorBaseUrls` trong docs trước packet | Không có trang docs nào mô tả — nay §3.2 phủ (trước chỉ có trong receipts/live-plan) |

## 5. Δ / notes

- **Δ-env-example:** `.env.example` hiện **chưa có** `DU_VAULT_KV_OPTIONS/DU_VAULT_KV_TOKEN/DU_CONNECTOR_INITIAL_BINDINGS` (chỉ có `CONNECTOR_PORT/URL/...`). Packet này là docs-scope nên **không sửa** template; đề xuất packet env-sync riêng (pattern `env-example-sync` cũ) nếu coordinator muốn template = docs.
- openapi giữ nguyên mọi entry cũ (chỉ thêm); không đổi x-absent ngoài việc thêm key mới sau mảng.
- Không chạy test/suite (doc-only); JSON parse + grep là evidence đủ cho packet này.
