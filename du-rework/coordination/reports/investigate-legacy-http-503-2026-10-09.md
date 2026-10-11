# INVESTIGATE (độc lập) — nhánh 503 trong `src/compat/legacy-http-mount.ts` (gap WFA-02) — 2026-10-09

**Vai trò:** investigator độc lập, chỉ đọc. **Không** sửa source/test/config/docs/plan, không commit/`git add`/push, không tick gate, không hand-edit `docs/21-openapi.json`, không đọc `.env.live`. **OFFLINE** — không PostgreSQL/Redis, không claim DB window. Scope: `du-rework` only.
**Revision kiểm:** HEAD `72e225ae5465e5a648c34bf31fbabbd182763233` · Node `v22.23.3` · cwd `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.
**Digest:** `src/compat/legacy-http-mount.ts` = `f288e1c78d8a6ba0da31cfe8e625fa4d7244c2010831cf446e6a9bd2a2ab93b4`, **908 dòng, sạch so với HEAD** (`git status` rỗng) · `src/compat/legacy-host-adapter.ts` (dirty do lane khác) · `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` (plan — chỉ đọc).
**Raw:** `coordination/reports/raw/investigate-legacy-http-503-2026-10-09/` (`legacy-http-mount.log`, `rv01-loopback-http-offline.log`, `wfa-api-lifecycle.log`).

## TRẢ LỜI NGẮN (điểm quan trọng nhất trước)

**Gap như plan mô tả KHÔNG còn tồn tại ở HEAD.** Plan ghi *"unconditionally returns 503 before submission (`…/legacy-http-mount.ts:404`)"* (`tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md:23`), nhưng tại HEAD **dòng 404 là một helper correlation-id, không có 503 nào**; hai route workflow đã được implement đầy đủ (auth → multipart → decode → resolve schema → submit, `:503-598`). Ba nhánh 503 hiện có đều **có điều kiện**: hai nhánh "host chưa wire callback" (`:533-535`, `:568-570`) và một nhánh lỗi crypto (`:445-447`). Trong app canonical, host **luôn** wire cả hai callback (`legacy-host-adapter.ts:112-114`, factory `:70-77` không rẽ nhánh) ⇒ hai nhánh 503-guard **không thể chạm tới** trong production. Việc còn thiếu là **tài liệu/plan còn stale** + **không có test nào pin shape của 503-guard**.

---

## CÂU 1 — Điều kiện nào dẫn tới 503? (nguyên văn + tên biến)

**Trích nguyên văn quanh dòng 404 (HEAD, `legacy-http-mount.ts:391-407`)** — nơi plan trỏ tới, **không** phải nhánh 503:

```ts
391: /** A legacy HttpError title, so a parser failure keeps the legacy vocabulary. */
392: function titleForStatus(status: number): string {
393:   if (status === 400) return 'Invalid Parameter';
394:   if (status === 401) return 'Unauthorized';
395:   if (status === 403) return 'Forbidden';
396:   if (status === 404) return 'Not Found';
397:   if (status === 409) return 'Conflict';
398:   if (status === 413) return 'Payload Too Large';
399:   if (status === 415) return 'Unsupported Media Type';
400:   if (status === 503) return 'Service Not Available';
401:   return 'Internal Error';
402: }
403:
404: /** The correlation id to stamp on a decode failure, before decoding succeeded. */
405: function decoded0CorrelationId(request: LegacyRouteRequest): string | undefined {
406:   return correlationIdOf(request);
407: }
```

**Ba nhánh 503 thật (nguyên văn):**

| # | Dòng | Điều kiện (biến/flag) | Nguyên văn |
|---|---|---|---|
| 1 | `:533-535` | `host.resolveLegacyWorkflowSchema === undefined` — callback host **không được wire** (khai báo optional `:84-87`) | `if (host.resolveLegacyWorkflowSchema === undefined) {`<br>`  return legacyError(503, 'Service Not Available', 'Workflow schema storage is not available on this deployment.', correlationId);`<br>`}` |
| 2 | `:568-570` | `host.submitLegacyWorkflow === undefined` — callback host **không được wire** (optional `:78-82`) | `if (host.submitLegacyWorkflow === undefined) {`<br>`  return legacyError(503, 'Service Not Available', 'The legacy workflow submission service is not available on this deployment.', correlationId);`<br>`}` |
| 3 | `:445-447` | **có điều kiện theo lỗi**, không theo flag: `code === 'SCHEMA_CRYPTO_UNAVAILABLE'` do host ném ra | `if (code === 'SCHEMA_CRYPTO_UNAVAILABLE') {`<br>`  return legacyError(503, 'Service Not Available', 'Workflow schema storage is temporarily unavailable.', correlationId);`<br>`}` |

Không có ENV/feature-flag nào tham gia: cả ba đều là **guard theo capability của host** (interface `LegacyCompatHost`, `:59-119`). Nguồn của mã `SCHEMA_CRYPTO_UNAVAILABLE`: `src/modules/workflow-schemas/workflow-schemas.ts:111` (*"Workflow schema encryption is not configured"*), `:196`, `:263`.

## CÂU 2 — 503 phát ra ở đâu trong chuỗi xử lý, shape ra sao?

- **Route/handler:** phát ra bên trong `handleLegacyRoute` (`:485-908`), nhánh `docs.kind === 'workflows' | 'workflow-schema'` (`:503-598`) — tức `POST /api/v1/docs/workflows` và `POST /api/v1/docs/workflows/schema`. Chuỗi: `src/http/routes/public.ts:323` gọi `handleLegacyRoute(...)` với `legacyCompatHost(ctx)` (`:340`) → mount trả `LegacyRouteResponse` → `public.ts:342-390` chuyển tiếp nguyên trạng `{status, body, headers}` (`:384-389`).
- **Response shape — KHÔNG phải problem+json chuẩn:** `legacyError` (`:195-209`) dựng body 4 trường theo wire legacy:
  `{ type: 'https://dugate.vn/errors/service-not-available', title: 'Service Not Available', status: 503, detail: <literal>, correlationId? }` — **không** có `code`, **không** có `errors`, **không** `urn:du:error:*` (comment `:189-194` nói rõ đây là surface khác canonical). `headers: {}` (`:208`) ⇒ content-type do listener đặt `application/json` (không phải `application/problem+json`).
- **correlationId:** chỉ có khi **caller tự gửi** `x-correlation-id` — `correlationIdOf` (`:239-242`) trả `undefined` nếu thiếu, và `legacyError` chỉ thêm field khi `!== undefined` (`:207`). CorrelationId do server sinh (listener) **không** được stamp vào body legacy (nó chỉ nằm ở response header `x-correlation-id`).
- **Không đủ dữ kiện để giữ câu?** Không — đủ: cả ba nhánh nằm trong file mount, không đi qua error boundary canonical; shape legacy là **cố ý** (parity), không phải bug hình thức.

## CÂU 3 — Blast radius: route nào bị ảnh hưởng, có nuốt route mới không?

**Đếm route trong file (`legacy-http-mount.ts`): 12 entry** (9 pattern path; `docs` có 3 biến thể):

| # | Route (legacy) | Dòng | Canonical twin? |
|---|---|---|---|
| 1 | `POST /api/v1/docs/{action}` × 6 slug (`ingest, extract, analyze, transform, generate, compare`) | `:493-494`, `:602-648` | **Không** (docs/legacy-only) |
| 2 | `POST /api/v1/docs/workflows` (named) | `:503-598` | **Không** |
| 3 | `POST /api/v1/docs/workflows/schema` | `:503-598` | **Không** |
| 4 | `GET /api/v1/operations/{id}` | `:660-694` | **Có** — `public.ts:476` |
| 5 | `DELETE /api/v1/operations/{id}` | `:663-673` | Không (canonical không có DELETE) |
| 6 | `GET /api/v1/operations` | `:696-728` | **Có** — `public.ts:439` |
| 7 | `POST /api/v1/operations/{id}/cancel` | `:730-749` | **Có** — `public.ts:707` |
| 8 | `POST /api/v1/operations/{id}/resume` | `:730-778` | **Có** — `public.ts:717` |
| 9 | `GET /api/v1/operations/{id}/download` | `:730-806` | Không (canonical download là `/api/v1/artifacts/{id}/download`, `public.ts:626`) |
| 10 | `GET /api/v1/billing/balance` | `:809-840` | **Không** (legacy-only) |
| 11 | `GET /api/v1/billing/usage` | `:842-886` | **Không** (legacy-only) |
| 12 | `GET /api/v1/services` | `:889-905` | **Không** (legacy-only) |

**Phân biệt legacy vs route mới:** (a) **theo path prefix** — `/api/v1/docs/*` chỉ legacy; (b) **theo credential** — với các path trùng (`/api/v1/operations*`), mount **từ chối** request có admin bearer: `hasAdminBearer` (`:147-150`) → `if (hasAdminBearer(request)) return null;` (`:658`), để canonical route (ADM-BASE-01/02) trả envelope canonical; chỉ caller `x-api-key` mới là client legacy. (c) Mọi path không thuộc bảng → `return null` (`:907`) → fall-through nguyên vẹn.

**Kết luận blast radius:** hai nhánh 503-guard chỉ chạm **đúng 2 route legacy-only** (`POST /api/v1/docs/workflows`, `POST /api/v1/docs/workflows/schema`). **Không nuốt route canonical nào** (các path đó không có twin canonical), và trong app canonical hai nhánh này **không chạm tới** vì host luôn wire (`legacy-host-adapter.ts:112-114`). Nhánh 503 crypto (`:445-447`) cũng chỉ trên `workflows/schema`, khi deployment thiếu metadata crypto.

## CÂU 4 — Test nào chạm nhánh 503, test nào chưa bắt được, vì sao?

Đã chạy offline (`jest.unit.config.cjs`, mỗi suite một tiến trình) để xác nhận trạng thái hiện tại:

| Suite | Exit | Literal |
|---|---:|---|
| `tests/legacy-http-mount.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 32 passed, 32 total`** |
| `tests/rv01-loopback-http-offline.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 48 passed, 48 total`** |
| `tests/wfa-api-lifecycle.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 14 passed, 14 total`** |

- **Không test nào pin nhánh 503-guard:** grep `503|Service Not Available` trong `tests/legacy-http-mount.test.ts` = **0 hit**. Các test workflow trong file đều **wire callback** trước khi gọi (`:151`, `:193-197`, `:224-228`, `:240`, `:250`) ⇒ nhánh `host.X === undefined` không bao giờ chạy.
- **Vì sao test chưa bắt được:** fake host trong suite mount luôn cung cấp `submitLegacyWorkflow`/`resolveLegacyWorkflowSchema` cho mọi case workflow; còn `rv01-loopback-http-offline.test.ts` chạy qua composition thật (`legacyCompatHost`) nên cũng luôn wired. Muốn hiện ra 503 phải dựng host **thiếu** callback (ví dụ `host({})` + gọi `POST /api/v1/docs/workflows`) — hiện không có case nào làm vậy.
- **Nhánh 503 crypto (`:445-447`)** được phủ **ở tầng catalog** (`tests/wfa-runtime-schema-catalog.test.ts:142-170` assert `SCHEMA_CRYPTO_UNAVAILABLE`) nhưng **không** có test nào pin **mapping của mount** (code → 503 `Service Not Available`).
- **Bối cảnh plan:** `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md:46` đã cấp lease cho `tests/legacy-http-mount.test.ts` + `tests/rv01-loopback-http-offline.test.ts` để **thay các assertion 503 vô điều kiện cũ** — việc đó đã xong (không còn assertion 503 nào), nhưng kéo theo hệ quả: **guard mới không còn test**.
- `tests/migrations.test.ts` **bị live-gate loại** (`jest.unit.config.cjs:18` `'migrations\\.test\\.ts$'`) ⇒ không tính là pass và không liên quan câu này.

## CÂU 5 — Thiết kế sửa tối thiểu (1 phương án tốt nhất + 2 phương án bị loại)

**PHƯƠNG ÁN TỐT NHẤT — không sửa product; thêm test pin guard + sửa text stale (2 owner khác nhau):**
1. **Thêm 2 case vào `orchestrator/services/orchestrator/tests/legacy-http-mount.test.ts`** (file đã nằm trong lease WFA theo plan `:46`):
   - `POST /api/v1/docs/workflows` với host **không** có `submitLegacyWorkflow` ⇒ assert `status === 503`, body `{type:'https://dugate.vn/errors/service-not-available', title:'Service Not Available', status:503, detail:'The legacy workflow submission service is not available on this deployment.'}` và `correlationId` xuất hiện khi gửi `x-correlation-id`;
   - `POST /api/v1/docs/workflows/schema` với host **không** có `resolveLegacyWorkflowSchema` ⇒ 503 với detail `'Workflow schema storage is not available on this deployment.'`; và 1 case host có resolver **ném** `SCHEMA_CRYPTO_UNAVAILABLE` ⇒ 503 `'Workflow schema storage is temporarily unavailable.'` (pin mapping `:445-447`).
2. **Sửa text stale (owner khác, KHÔNG phải tôi):** `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md:23` (bỏ "unconditionally returns 503 … :404", thay bằng "capability-gated 503 ở `:533-535`/`:568-570`; workflow routes đã implement") và `coordination/reports/wfa-api-contract-2026-10-07.md:13,17,19` (các dòng còn mô tả stub với line ref `:198-204,397-415`).
   **Lý do:** code ở HEAD đã đúng/đủ; cái thiếu là **bằng chứng test cho guard** và **tài liệu khớp code**. Chi phí: 2-3 case test + 2 file text; không đụng product ⇒ rủi ro ~0.

**BỊ LOẠI A — "gỡ 503 stub trong mount" (cách hiểu theo câu chữ plan):** không có gì để gỡ: hai nhánh là guard capability, gỡ đi thì host thiếu callback sẽ rơi xuống `internalError` **500** (mất chẩn đoán "deployment chưa cấu hình") hoặc TypeError; plan `:13` cũng nói *"Neither removal of the 503 stub alone … closes this task"*.
**BỊ LOẠI B — biến hai callback thành bắt buộc (bỏ optional) / đổi 503 thành problem+json canonical:** (i) bỏ optional phá các host một phần + test hiện có mà **không đổi hành vi production** (vốn đã wired); (ii) đổi shape 503 sang problem+json phá parity legacy đang được pin (`legacy-http-mount.test.ts` 32 test + `docs/39-legacy-parity-contract.md`) — legacy client parse `detail`, không parse `code`.

## CÂU 6 — Rủi ro nếu sửa

- **Thêm test (phương án tốt nhất): rủi ro sản phẩm bằng 0** — chỉ thêm assertion vào file test đã có lease; không đổi runtime.
- **Nếu ai đó định "sửa" guard trong mount:** contract đang đóng băng bởi test + docs: `tests/legacy-http-mount.test.ts` **32/32**, `tests/rv01-loopback-http-offline.test.ts` **48/48**, `tests/wfa-api-lifecycle.test.ts` **14/14** (đều exit 0, offline, chạy trong lượt này) + parity contract `docs/39-legacy-parity-contract.md`; thêm nữa plan `:103` cấm "unconditional 503 / queue-only success / hidden mapping subset" đóng task. Bỏ guard sẽ đổi hành vi cho host chưa cấu hình (từ 503 typed → 500/exception) — regression chẩn đoán.
- **Adapters đang chạy:** `legacy-host-adapter.ts:70-77` (factory) + `:112-114` (hai callback) — wired vô điều kiện; `resolveLegacyWorkflowSchema` phụ thuộc `ctx.metadataCrypto` (`:113`), nên đường 503 crypto là **deployment-dependent thật**, không phải chết.
- **Finding mở đã biết, không thuộc gap này:** `legacy-http-mount.ts:432-434` forward `HttpError.message` vào detail legacy — `wfa-section8-security-review-2026-10-08.md:47,74` xếp **F4 LOW** (thiếu test redaction 5xx). Không đụng trong lượt này.

## CÂU 7 — Residual (vượt lease — ghi lại, KHÔNG sửa)

| # | File:line | Nội dung | Owner |
|---|---|---|---|
| R1 | `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md:23` | văn bản stale: *"unconditionally returns 503 before submission (…:404)"* — ở HEAD `:404` là `decoded0CorrelationId`, không có 503 | plan owner |
| R2 | `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md:46,103` | lease/wording nhắc "obsolete unconditional-503 assertions" / cấm "unconditional 503" — nay đã hết đúng nghĩa | plan owner |
| R3 | `coordination/reports/wfa-api-contract-2026-10-07.md:13,17,19` | contract report vẫn mô tả stub 503 với line ref `legacy-http-mount.ts:198-204,397-415` | report owner |
| R4 | `legacy-http-mount.ts:481-483` vs `:235`, `:602`, `:907` + test `legacy-http-mount.test.ts:67` | comment nói *"an unknown `/api/v1/docs/*` slug is a 404 here rather than falling through"*, nhưng code trả `null` (fall-through) và test `:67` assert `toBeNull()` ⇒ **comment lệch code+test** | mount owner |
| R5 | `legacy-http-mount.ts:432-434` | F4 LOW: forward `HttpError.message` vào detail legacy, không có test redaction 5xx (đã ghi ở `wfa-section8-security-review-2026-10-08.md:74`) | mount owner + security reviewer |
| R6 | `legacy-http-mount.ts:118`, `:895` | `serviceCatalogue` chưa được host wire ⇒ `GET /api/v1/services` trả 200 với `services: []` (hành vi đã chốt ở `wfa-muc6ab-2026-10-08.md`) | catalogue owner |

## XÁC NHẬN READ-ONLY & TRẠNG THÁI

- **Read-only:** không sửa source/test/config/docs/plan; `legacy-http-mount.ts` vẫn **sạch so với HEAD** (digest `f288e1c7…93b4`); không commit/`git add`/push; **không tick gate** nào (VERIFIED/ACCEPTED thuộc coordinator); không hand-edit `docs/21-openapi.json`; không đọc `.env.live`.
- **Offline:** 3 suite chạy bằng `jest.unit.config.cjs` (32/48/14 passed, exit 0); **không** PostgreSQL/Redis/S3, **không claim DB window**.
- `tests/migrations.test.ts` bị live-gate loại (`jest.unit.config.cjs:18`) — **không tính là pass** và không dùng làm bằng chứng.
- Không có gì bị "sửa cho xanh"; mọi kết luận dựa trên đọc code + test offline hiện có.
