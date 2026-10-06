# CONNECTOR-WIRE-B — nhánh BFF (`/admin/api/connectors*` + `/admin/api/actions`) — 2026-10-05

**Packet:** CONNECTOR-WIRE-B-BFF · lane **dsh_1** (`term_a85c47f2`) · task `task_75f7d8cc08a5` · dispatch `ctx_401c70cd59c3` (00:58).
**Mode:** **Offline; không tick; không commit/push.**
**Spec:** `p745-connector-wire-prep` §3.1 (dòng BFF) · §3.3 (capability advertisement) · §3.5 (lease BFF) · §3.6 (`bff-connectors-actions.test.ts`); handoff §5 của `connector-wire-a-2026-10-05.md`.
**Snapshot:** 2026-10-05 01:15–01:45 +07 · HEAD `b088eec`. Nhánh còn lại (admin-web UI) thuộc **dsh_2** — không chạm.

## 0. Write set + pin (post)

| File | Trạng thái | SHA-256 (20) |
|---|---|---|
| `services/orchestrator/src/app/admin/bff/handle.ts` | sửa: +2 route +1 handler (466 → 529 dòng, +63) | `ccd5c762cbf65c721998…` |
| `services/orchestrator/tests/bff-connectors-actions.test.ts` | **MỚI** (545 dòng) | `f28c0b50e4620472581f…` |
| `coordination/reports/raw/cwb-bff-tsc.txt` / `-suite-r3.txt` / `-regression.txt` / `-standing-red-shell.txt` | **MỚI** (raw evidence) | — |
| `coordination/reports/connector-wire-b-bff-2026-10-05.md` | **MỚI** (receipt này) | — |

**No-touch (hash/nguyên trạng):** `apps/admin-web/**` (dsh_2), `services/connector/**`, `packages/contracts/**`,
`src/http/routes/admin.ts`, `src/modules/admin-actions/dispatcher.ts`, `src/modules/connectors/connector-management-store.ts`,
`src/http/route-context.ts`, `src/server.ts` (toàn bộ lane A cc_1 — 0 dòng sửa), và `src/app/admin/bff/{profiles,operations,security,upstream,envelope,context,body,types}.ts`.

## 1. Khảo sát trước khi sửa (read-only) — cái gì ĐÃ CÓ, cái gì THIẾU

| Hạng mục | Kết luận |
|---|---|
| `POST /admin/api/actions` | **Đã có, action-agnostic.** `handle.ts` nhận `{action, params}`, validate `^[a-z][a-z0-9_.]*$`, gate CSRF-before-upstream, forward `idempotency-key` (clamp 200). `connector.upsert/activate/disable/retire/test` khớp regex ⇒ **chạy được ngay, 0 dòng sửa source**. Điều này được **chứng minh bằng test**, không phải suy đoán (§4). |
| `GET /admin/api/connectors/:id/revisions/:rev` | **Đã có**; `current`/`latest`/số đều qua regex sẵn. |
| `GET /admin/api/connectors` (list) | **THIẾU** — rơi xuống 404 route-miss. |
| `GET /admin/api/connectors/capabilities` | **THIẾU** — lane A đã mở `GET /api/v1/admin/connectors/capabilities` (§3.3 prep), nhưng UI **chỉ đi được qua BFF cùng origin** ⇒ không có route BFF thì advertisement vô dụng. |
| Credential đúng cho connector reads | Upstream là **platform-only** (`assertAdminAuth`, `admin.ts:44-55`). BFF phải gate **tại chỗ**; `credentialFor()` (dùng ở route revision kề bên) sẽ gửi token tenant mà upstream **luôn** 401. |

## 2. Thi hành (chỉ `bff/handle.ts`)

1. **Match trước regex revision** (`/connectors` và `/connectors/capabilities`) để `capabilities` không bao giờ bị đọc thành connectorId; sai method ⇒ **405** qua `assertMethod`.
2. **Fence platform-admin tại chỗ:** thiếu session ⇒ **401**; `role !== 'admin' || principal.kind !== 'platform'` ⇒ **403 PERMISSION_DENIED** — *kể cả khi tenant bearer CÓ được cấu hình* (`tenantAdminTokens`). 0 upstream call.
3. **Platform bearer duy nhất** (`runtime.adminToken`); không forward query param; cookie/authorization của browser **không** qua upstream (`callUpstream` chỉ đặt `authorization/accept/x-correlation-id`).
4. **Relay nguyên envelope:** list ⇒ `{items:[ConnectorManagementRevision]}`; capabilities ⇒ `{management,credentialWorkflow,test}` **verbatim** (`false` không bị làm phẳng thành `true`).

## 3. Bằng chứng literal (offline, cwd `services/orchestrator`)

| Lệnh | Kết quả |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **TSC_EXIT=0**, không output → `raw/cwb-bff-tsc.txt` |
| `npx jest tests/bff-connectors-actions.test.ts --runInBand` — **3 lượt xanh liên tiếp** (R2/R3/R4) | mỗi lượt **`Test Suites: 1 passed, 1 total` · `Tests: 17 passed, 17 total` · JEST_EXIT=0** (~3.0s) → lượt cuối `raw/cwb-bff-suite-r3.txt` |
| Regression BFF: `aweb02-bff-foundation` + `aweb04-bff-profiles` + `aweb05-bff-reads` + `aweb06-bff-operations` + `aweb07-bff-security` + suite mới | **`Test Suites: 6 passed, 6 total` · `Tests: 76 passed, 76 total` · JEST_EXIT=0** → `raw/cwb-bff-regression.txt` |
| Attribution standing-red (3 shell suite, §5) | **`3 failed, 3 total` · `18 failed, 100 passed, 118 total` · SHELL_EXIT=1** (tái lập **y hệt** 2 lượt) → `raw/cwb-bff-standing-red-shell.txt` |

Không DB/Redis/S3/Vault/network thật: toàn bộ là HTTP loopback + stub upstream trong cùng tiến trình jest. Không claim/lease tài nguyên chung.

### 3.1 Fix trong tiến trình (minh bạch)
- **Lượt R1 ĐỎ — 2 failed/15 passed, cả 2 là lỗi harness do tôi viết sai, KHÔNG phải lỗi source:**
  1. helper `postAction` mặc định gắn cookie admin, nên case "anonymous" thực chất đã authenticated (nhận 403 thay vì 401) → thêm `cookie: null` tường minh;
  2. kỳ vọng danh sách field-error sai: sanitizer `boundedMessage` **strip ký tự điều khiển rồi giữ** entry (`/junk` → `"bad control"`), chỉ entry pointer rỗng bị bỏ, field lạ không copy → sửa kỳ vọng cho đúng hợp đồng.
- Sau fix: R2, R3, R4 đều 17/17 exit 0.

## 4. Hành vi được pin (17 test)

- **Gate (3):** anonymous ⇒ 401 problem+json + `no-store`, **0 upstream**; viewer ⇒ 403 `PERMISSION_DENIED`, 0 upstream; **tenant_operator có bearer cấu hình hợp lệ vẫn 403, 0 upstream** (fence platform-only, không đẩy token tenant lên endpoint luôn từ chối).
- **Reads (3):** list ⇒ 200 `{items}` đúng với upstream, `config.headers.authorization === '[REDACTED]'` **sống qua hop**; upstream nhận **đúng** `GET /api/v1/admin/connectors` (query `?evil=dropme` **không** forward), `Bearer <platform>`, `cookie: null`; capabilities ⇒ booleans verbatim.
- **Lỗi/hạ tầng (3):** upstream 5xx ⇒ **502 `UPSTREAM_ERROR`**, không lộ text upstream (`TEMPORARY_UNAVAILABLE`/detail **không** xuất hiện); upstream không với tới ⇒ **503 `UPSTREAM_UNAVAILABLE`**; sai method cả 2 route ⇒ **405**, 0 upstream.
- **Fence dot-segment (1):** request line thô `/admin/api/connectors/../revisions/1` ⇒ **404** trước upstream (route mới không shadow F-AW05-1).
- **Actions (7):** `GET /admin/api/actions` ⇒ 405, 0 upstream; anonymous/viewer/operator ⇒ 401/403/403 **0 upstream**; admin thiếu CSRF ⇒ 403 `CSRF_REJECTED` **trước** dispatcher; envelope sai (JSON hỏng / action `Connector.Upsert!` / body mảng) ⇒ 422 **0 upstream**; `connector.upsert` ⇒ **201 `{data:…}`**, `{action,params}` forward **verbatim**, `idempotency-key` 260 ký tự bị **clamp 200**; `connector.activate` CAS-loss ⇒ **409 `STATE_CONFLICT`**, `detail` bị bỏ, field-error sanitize đúng (pointer rỗng bị bỏ, ký tự điều khiển bị strip, field lạ không copy), body thô **không** echo; `connector.test`/`activate` happy-path relay đúng `{data:…}`; action lạ ⇒ 404 `ACTION_NOT_FOUND`, detail bị bỏ.

## 5. ⚠ STANDING RED phát hiện — **KHÔNG do packet này** (đề nghị coordinator route)

`admin-shell-router` + `admin-shell-server` + `admin-shell-platform-mount` = **18 failed / 100 passed / 118 total, exit 1** (tái lập y hệt 2 lượt, không flaky).

**Nguyên nhân (bằng chứng mtime + file:line, không phải suy đoán):**
1. **Nav role drift:** `src/app/admin/p6-01-shell-fixtures.ts` (mtime **10-02 02:55**) đặt `profiles/connectors/grants/api-keys` ⇒ `requiredRole:'admin'` (`:226-229`), trong khi `src/app/admin/view-models.ts:54-56` vẫn `'operator'` và `tests/admin-shell-router.test.ts:42-48` kỳ vọng `'operator'` ⇒ router trả `'admin'` (fail 1) và mọi case dùng **cookie operator** trên `/admin/profiles` `/admin/connectors` nhận **403 thay vì 200** (fail ~16).
2. **`POST /admin/login` 302 → 503:** cookie posture TLS (`src/app/admin/auth-dispatch.ts:109-131`, `auth.tls_required`) — test không cấu hình `cookiePolicy.requireSecure=false` (fail 1).

**Vì sao chắc chắn không do tôi:** diff của tôi **chỉ** thêm routing `/admin/api/connectors*` trong `bff/handle.ts`; file này chỉ được import bởi `shell-server.ts` (grep `bff/handle` = 1 match) và chỉ phục vụ `isBffPath('/admin/api/*')`. Các test đỏ render **HTML pane** `/admin/{profiles,connectors}` và `/admin/login`, không đi qua BFF. Mtime fixture (10-02) + view-models (09-25) đều **trước** mtime sửa của tôi (10-05 01:17).

**Không thuộc lane tôi** (shell/fixtures + admin-web) nên **không tự sửa**; nêu để coordinator giao đúng owner.
**Ảnh hưởng nhánh dsh_2 (UI):** role gate của nav và capability gate của connector phải **thống nhất** — hiện nav đòi `admin` còn `view-models.ts` nói `operator`; nên chốt trước khi UI bật nút.

## 6. Deviations / observation để coordinator adjudicate

- **Δ1 — upstream 5xx bị BFF gộp thành 502 `UPSTREAM_ERROR`** (luật sẵn có `envelope.ts:58-72`: 5xx không lộ nội bộ platform). Hệ quả: "store chưa compose" của lane A (**503 `TEMPORARY_UNAVAILABLE`**) tới UI là **502**, không phải 503. Cổng đúng theo thiết kế là **capabilities `management:false`** (§3.3) — đã pin trong test. Muốn giữ 503 end-to-end thì là **thay đổi hợp đồng BFF dùng chung** (aweb06/07) ⇒ packet riêng, không tự mở.
- **Δ2 — tôi thêm route `capabilities`** (không liệt kê thành dòng riêng trong §3.5): bắt buộc, vì UI chỉ với tới được `/api/v1/admin/connectors/capabilities` của lane A qua BFF cùng origin, và §3.3 chốt "UI bật nút theo capability list này".
- **Δ3 — connector reads là platform-admin-only** (mirror upstream). Route revision kề bên (`handle.ts:328-370`) dùng `credentialFor()` cho phép token tenant — upstream sẽ 401. **Bất nhất có sẵn, tôi không sửa** (surgical) nhưng nêu để adjudicate.
- **Δ4 — BFF không paginate/không filter list**: lane A trả `{items}` không phân trang ⇒ forward đúng, không bịa param.

## 7. Chuyển tiếp (handoff cho dsh_2 / UI)

- `GET /admin/api/connectors` ⇒ `{items: ConnectorManagementRevision[]}` (shape: `packages/contracts/src/connector-management.ts:25-46`).
- `GET /admin/api/connectors/capabilities` ⇒ `{management, credentialWorkflow, test}` (booleans) — **dùng để gate Save/Test/Activate**.
- Mutations: `POST /admin/api/actions` + header `x-csrf-token` (bắt buộc) + `idempotency-key` (tuỳ chọn), body `{action, params}`, action: `connector.upsert` (`mode:'create'|'revision'`) / `connector.activate` / `connector.disable` / `connector.retire` / `connector.test`; lỗi là **problem+json** (`code`, `errors[{pointer,message}]`), 409 `STATE_CONFLICT` cho CAS-loss.
- **Còn thiếu (cần live window, ngoài packet offline):** round-trip connector service thật (create→clone→rotate→activate→retire), Vault thật, browser evidence — trùng §5 lane A.
- Không tick; không commit/push; chỉ các file ở §0 được ghi.
