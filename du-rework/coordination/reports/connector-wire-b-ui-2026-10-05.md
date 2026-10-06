# CONNECTOR-WIRE-B-UI (admin-web connector management) — 2026-10-05

**Packet:** CONNECTOR-WIRE-B-UI · lane `dsh_2` (`term_bac0ad06`, task `task_f7ad68e17fa3`, dispatch `ctx_bbb742933ae9`) · nhánh BFF là `dsh_1` (không chạm).
**Spec:** `p745-connector-wire-prep` §3.2/§3.3/§3.5 (hàng admin-web) + §3.6 (offline test); DTO/action thật lấy từ **CONNECTOR-WIRE-A** đã land (`connector-wire-a-2026-10-05.md`).
**Mode:** **OFFLINE — không tick, không commit/push**; chỉ các file ở §0 được ghi (kể cả PNG evidence + receipt này).
**Snapshot:** 2026-10-05 01:45–02:10 +07. Antigravity review UI **sau**, theo coordinator điều phối.

## 0. Write set + SHA-256 (16 ký tự đầu)

| File | Trạng thái | lines | SHA-256 |
|---|---|---|---|
| `apps/admin-web/src/lib/api/types.ts` | MODIFIED — DTO management + params/result | 291 | `ecd13cc4c0065c1e` |
| `apps/admin-web/src/lib/api/client.ts` | MODIFIED — 2 read + 5 action helper | 377 | `cf191a5b87206134` |
| `apps/admin-web/src/lib/api/index.ts` | MODIFIED — export types mới | 43 | `bb7ce2866ca90b1a` |
| `apps/admin-web/src/features/connectors/state.ts` | MODIFIED — reader/gating/mapping | 334 | `880e6d990eda1e9f` |
| `apps/admin-web/src/features/connectors/connectors-screen.tsx` | REWRITTEN — management surface | 886 | `c51681e10ca1c74d` |
| `tests/browser/admin-web/connectors-wire.spec.ts` | **MỚI** — offline x16 | 346 | `50263c97bf29152e` |
| `tests/browser/admin-web/api-keys-connectors.spec.ts` | MODIFIED — case 6/7 theo màn mới | 162 | `2fad6c9d7a13cba7` |

Build digest cuối (`apps/admin-web/dist`): `assets/index-xBfDFWzz.js` `6148de23c282f0d5` · `assets/index-HHyOtXdi.css` `2edb802939854314` (rebuild sau fix title disabled-reason; digest trước `index-wfKva3Gu.js` `d124715bbf4180f9` không còn là build được verify).

> **UPDATE 2026-10-05 02:5x (packet STUB-EXT, cùng lane) — digest trên KHÔNG còn là build hiện tại.**
> Browser journey của STUB-EXT phát hiện **mọi mutation connector bị 403 `CSRF_REJECTED`** (`connectors-screen.tsx` không đọc `getSession()` nên client không có `x-csrf-token`); owner đã sửa trong `load()` + banner `Admin session unavailable`. Chi tiết + bằng chứng: `stub-ext-2026-10-05.md` §3.
> **Build được verify hiện tại:** `assets/index-CqyHzg0b.js` **`0b8ed8ed715bbd16`** · `index-HHyOtXdi.css` `2edb802939854314`; `connectors-screen.tsx` = 902 lines / `755875b569b3f240`. **Gọi Antigravity review UI trên digest CŨ sẽ là review stale** — dùng digest mới.

**No-touch (0 byte đổi):** `services/orchestrator/**` (BFF `bff/handle.ts` thuộc dsh_1), `packages/contracts/**`, `apps/admin-web/src/features/connectors/curl-import{,-preview}.ts(x)` (P730/qwen_5), router/primitives/styles, `tests/browser/admin-web/harness.ts`, lockfile.

## 1. Wire thật đã bám (không đoán)

| Việc | Nguồn đã đọc trong repo |
|---|---|
| Capabilities `{management, credentialWorkflow, test}` `.strict()` | `http/routes/admin.ts:532` + `packages/contracts/src/connector-management.ts:49-56` |
| List `{items:[ConnectorManagementRevision]}` (503 khi thiếu store) | `admin.ts:543` + contracts `:43-46` |
| Revision read **2 shape** (ledger thật khi compose / placeholder endpoint-only khi không) | `admin.ts:551-602` (CW-A Δ1) vs placeholder cũ |
| `connector.upsert` (union `create|revision`), `activate` (CAS `expectedCurrentRevision`), `disable`, `retire`, `test` (narrow `{ok,errorCode?}`) | `admin-actions/dispatcher.ts:962-1136` + contracts `:65-125`; ADMIN_ACTIONS `:150-154` (admin-only, CSRF-before-role) |
| Mutation wire dùng chung `POST /admin/api/actions` **không allowlist** + Idempotency-Key | `bff/handle.ts:144-147` + `handleActions` |

## 2. Đã code (UI)

1. **`types.ts`** — mirror browser-safe của DTO: `ConnectorRevisionState`, `ConnectorManagementRevision`, `ConnectorListPage{items,skipped}`, `ConnectorCapabilities`, `ConnectorRevisionRead` (union 2 shape), `ConnectorCreateParams`/`ConnectorRevisionCloneParams`/`ConnectorUpsertParams`, `ConnectorActivateParams`, `ConnectorTestResult`. `ConnectorRevision` (placeholder) giữ nguyên + ghi rõ là degraded projection.
2. **`client.ts`** — `listConnectors()`, `getConnectorCapabilities()` (trả `unknown` vì reader của screen mới là validator thật) + `upsertConnector/activateConnector/disableConnector/retireConnector/testConnector`. Gom 1 helper `runAction()` (unwrap `{data}` của BFF) — `postAction` cũ **gọi lại chính helper này nên hành vi không đổi** (p745-ui-keys guard vẫn xanh).
3. **`state.ts`** — reader thuần, fail-closed:
   - `parseConnectorManagementRevision` **strict đúng key set** (field lạ ⇒ `null`, không strip — mirror `.strict()` của platform, nơi field lạ = 502);
   - `parseConnectorCapabilities` đòi đủ 3 boolean, key lạ ⇒ `null`;
   - `parseConnectorList` đếm `skipped` cho row hỏng (không âm thầm bỏ, không "sửa" thành hợp lệ);
   - `parseConnectorRevisionRead` phân biệt bằng **key set** (`config` ⇒ management, `endpoint` ⇒ legacy) nên body management hỏng **không** rơi nhầm về placeholder;
   - `connectorActionGating` (null capabilities ⇒ tắt mọi write + lý do), `summarizeConnectorConfig` (chỉ keys/tên header, masked tách riêng), `connectorActiveRevision` (CAS head đọc từ list, không suy đoán), `buildConnectorUpsertParams` (thiếu toạ độ nào trả đúng tên toạ độ đó), `connectorConfigFromDraft` (**secret ⇒ chỉ còn cấu trúc**: tên header/field; file field **không mang value** vì draft giữ path local).
4. **`connectors-screen.tsx`** — đọc capabilities **trước**, chỉ gọi list khi `management:true`; bảng list (redacted config keys, active head, Load); card revision render **cả 2 shape** có nhãn rõ (`platform ledger` / `degraded projection`); nút `Test connection` (`connector.test`), `Activate` (CAS + disabled khi không thấy ACTIVE head), `Disable`, `Retire revision` (ConfirmDialog), tất cả **disabled theo capability thật + nêu lý do**; card draft cURL yêu cầu `connectorId/adapter/credential slot`, `Save connection` chỉ bật khi `management` và đủ toạ độ (payload **không có secret**).
5. **`connectors-wire.spec.ts` (mới, offline 16 ca)** — capabilities strict, fail-closed gating, gating từng capability, strict revision + no-fallback, placeholder vẫn đọc được, list skipped, test narrow, active head, config summary không lộ value, mapping đủ/thiếu toạ độ, **không secret + không path local trong payload**, redaction cấu trúc, static guard screen/client (gọi đúng helper, `disabled={!gating.*}`, không `secretValue` trong screen).
6. **`api-keys-connectors.spec.ts` case 6/7** cập nhật theo màn mới (nút `Test credential` → `Test connection`; text `test/rotate: requires backend` → banner `Capability advertisement unavailable`; thêm assert Activate disabled) — đã chạy lại **browser thật** xanh (§3.5).

## 3. Evidence literal

cwd `apps/admin-web`:
| Lệnh | Kết quả |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **TSC_EXIT=0** (3 lượt: trước/sau `retireConnector`, sau fix title disabled-reason) |
| `npx vite build` | **BUILD_EXIT=0** — 2665 modules, `index-xBfDFWzz.js` 477.12 kB (gzip 149.14) |

cwd `tests/browser`:
| Lệnh | Kết quả |
|---|---|
| `npx playwright test admin-web/connectors-wire.spec.ts admin-web/p730-curl-import.spec.ts admin-web/p745-ui-keys.spec.ts --config admin-web/playwright.config.ts` | **EXIT=0 — 43 passed** (16 mới + 19 p730 + 8 keys) |
| `npx tsc --noEmit -p tsconfig.json` | **BROWSER_TSC_EXIT=2 — RED CÓ SẴN, không do slice này**: `@/lib/api` không resolve trong tsconfig của package (đã đỏ ở `profiles/state.ts`, `profiles/command-bodies.ts` từ trước) + `harness.ts:579` + `p745-ui-keys.spec.ts:76-77`; **không có lỗi nào thuộc file mới của slice này** |

### 3.5 Browser thật (harness offline, dist vừa build)

Boot: `npx tsx tests/browser/admin-web/harness.ts <tmp.json>` (cwd `du-rework`) → `HARNESS_READY` (port động: lượt cuối `http://127.0.0.1:55359`, stub `…55358`); **không DB/Redis** (factory `createAdminShellServer` không chạm global state).

| Lệnh | Kết quả |
|---|---|
| `npx playwright test admin-web/api-keys-connectors.spec.ts -g "connectors:"` | **EXIT=0 — 2 passed** (6 + 7) ở browser thật trên build cuối; ảnh `05-10-connector-unavailable.png`, `05-11-connector-ready-disabled-actions.png` |
| `npx playwright test admin-web --reporter=list` | **EXIT=0 — 89 passed, 5 skipped, 0 failed** (47.2s, build cuối) |

- 5 skipped = `live-admin-web.spec.ts` (live-gated `DU_LIVE_INFRA=1` — đúng guard của nó, **không phải pass**).
- Evidence dir: `coordination/evidence/connector-wire-b-ui-2026-10-05/` (bộ ảnh full-suite; 2 ảnh connectors của slice này ở trên).
- Harness đã **tắt sau khi chạy**: các cặp port 53787/53788 và 55358/55359 đã closed (verify bằng `Get-NetTCPConnection`). Không còn job nền.

## 4. GAP / việc còn thiếu (nói thẳng)

- **G1 — BFF chưa có 2 read route** (thuộc `dsh_1`): UI đọc `GET /admin/api/connectors/capabilities` và `GET /admin/api/connectors`; hiện BFF trả 404 ⇒ màn hình hiển thị **"Capability advertisement unavailable"** và **tắt mọi write (fail-closed)** — đúng hành vi, nhưng hành trình browser cho list/activate/disable/retire **chưa chạy được**. Yêu cầu hợp đồng BFF (coordinator chốt với dsh_1):
  - `GET /admin/api/connectors` → proxy upstream `GET /api/v1/admin/connectors`, body `{items:[…]}` (503 khi thiếu store);
  - `GET /admin/api/connectors/capabilities` → `{management,credentialWorkflow,test}` — **phải match TRƯỚC** `/connectors/:id/revisions/:rev`;
  - mutations **không cần route mới**: `/admin/api/actions` hiện forward mọi action + CSRF + Idempotency-Key.
- **G2 — `Rotate secret` cố ý KHÔNG nối** trong slice UI này (write-only value path/Vault writer = packet riêng, CW-A §2 Δ5): nút luôn disabled + title nói rõ; **không có nút giả**.
- **G3 — chưa có live round-trip** connector service thật (create→clone→rotate→activate→retire) + Vault + window `DU_LIVE_INFRA=1`; browser evidence ở §3.5 là **offline harness** (stub upstream), không thay live gate.
- **G4 — harness stub chưa mô phỏng list/capabilities/actions mới**; khi BFF land, cần mở stub + thêm case browser cho đường management (owner: wave browser evidence của coordinator).
- **G5 — `tests/browser` tsc đỏ có sẵn** (alias `@/lib/api` + `harness.ts:579` + `p745-ui-keys.spec.ts:76-77`): pre-existing, không sửa trong slice này để giữ surgical diff; cần owner tương ứng xử lý.

## 5. Antigravity review (UI) — phạm vi đề nghị

Route `/admin/web/connectors`, build digest `index-xBfDFWzz.js` / `6148de23c282f0d5` (trong `apps/admin-web/dist`). Trạng thái cần kiểm: (a) capabilities 404 ⇒ banner + **mọi** write disabled; (b) revision legacy ⇒ nhãn `degraded projection`, không hiện config keys; (c) revision management ⇒ `platform ledger`, config **chỉ keys**, header masked tách riêng; (d) draft cURL ⇒ Save disabled khi thiếu toạ độ + nêu đúng toạ độ thiếu, **không** secret trong payload; (e) `Rotate secret` disabled kèm lý do. UI verdict (`UI_APPROVED`/`CHANGES_REQUIRED`) do Antigravity ghi theo build trên; slice này **không tự tick** row nào.

**Compliance:** offline; không commit/push; không tick task/plan; chỉ file §0 (+PNG evidence §3.5) được ghi.
