# Đối chiếu architecture 10–17 với code — packet sửa tài liệu (2026-10-02)

Trạng thái: **plan-only, chưa IMPLEMENTED/VERIFIED/ACCEPTED**. Nguồn là một lượt audit đọc-chỉ (5 nhóm verify song song + kiểm link/sơ đồ) trên bộ `architecture/10`–`17` và hai `CODE-ARCHITECTURE.md`, đối chiếu ngày 2026-10-02.

**Kết quả audit: không có sai lệch nào làm sai lệch bức tranh kiến trúc.** Hai `CODE-ARCHITECTURE.md` đối chiếu từng dòng cây thư mục, 0 file thiếu. Doc 13 không có claim nào bị code/config phủ định. Toàn bộ phát hiện dưới đây là **thiếu sót cục bộ trong doc**, hoặc **doc im lặng về một lỗi có thật trong code**.

Ranh giới quan trọng: packet này chỉ sửa **mô tả**. Nó không tự implement route còn thiếu, không tự quyết 31-vs-28 cho chủ sản phẩm, và không tự tick `[x]` — owner và Reviewer adjudicate.

## Ranh giới ownership giữa các task

```text
DOC-SYNC-01  architecture/10,12,15,16        (doc-only, không đụng docs/)
DOC-SYNC-02  docs/07, docs/21, docs/10,
            businesses/document-core/docs/   (nhiều lane cùng ghi — thận trọng)
DOC-SYNC-03  số 31 vs 28                     (chỉ trong architecture/, chờ chủ sản phẩm)
CODE-FIX-01  services/orchestrator/src/app/admin/*.ts   (CODE — plan only, chưa sửa)
CODE-FIX-02  services/connector/src/*         (CODE — plan only, chưa sửa)
```

Không task nào được giao việc của task khác. `CODE-FIX-01` và `CODE-FIX-02` **không được sửa code ở packet này** — chúng chỉ ghi lại phát hiện vào task board với đầy đủ mô tả để chủ sở hữu mở packet implement sau.

---

## DOC-SYNC-01 — Mô tả admin auth và route trong `architecture/`

| ID | Trạng thái | Owner gợi ý | Phụ thuộc |
|---|---|---|---|
| DOC-SYNC-01 | [~] | Architecture docs; không đụng code | không |

**Allowed write paths:** `du-rework/architecture/10-current-system.md`, `12-flows-and-data.md`, `15-business-capabilities.md`, `16-interface-catalog.md`.

**Acceptance đo được** — mỗi mục dưới phải sửa được *đúng câu chữ* đang sai, không viết lại cả trang:

1. **Thu hẹp mô tả admin auth.** `16-interface-catalog.md` §3 và `12-flows-and-data.md` §1 đều viết "Admin bearer hoặc session/OIDC/local mode tùy cấu hình". Code thật: `assertAdminAuth` tại `services/orchestrator/src/server.ts:2840-2850` chỉ so `Bearer ${adminToken}`, **không có nhánh session nào**; nó gate 9 route (enable/activate/deactivate, connector credentials, sweep-deadlines, business list, version list, profiles, connector revisions, api-keys). Session/OIDC/local chỉ có tác dụng ở `POST /api/v1/admin/actions` qua `resolveAdminActionAuthAsync` (`server.ts:2403`, impl `modules/admin-actions/rbac.ts:386`). Sửa thành: bearer cho các route admin JSON; session/OIDC/local chỉ cấp quyền trên `POST /api/v1/admin/actions`.
2. **Chốt `/tasks/{id}/context` là vắng hẳn.** `16-interface-catalog.md` §2 đang để ngỏ ("có trong một số spec cũ; cần đối chiếu"). Grep `server.ts` = 0 match `/context`; route table kết thúc ở `server.ts:2786` (404 fallback). Sửa thành: route không tồn tại trong router, không phải chờ config.
3. **Thêm `GET /api/runtime/v1/workspace-reference`** vào bảng runtime của `16` §2. Route tại `server.ts:1711-1740`; comment trong code mô tả nó là "the ONLY writer-side integration the worker needs" (`server.ts:1712-1716`).
4. **Thêm bảng `human_waits`** vào nhóm bảng Orchestrator ở `12` §5. Nó có thật: `services/orchestrator/migrations/0005_continuation.sql:9`. Hiện doc 10 §4 bước 3 quảng bá wait-input nhưng §5 không có bảng nền — người đọc không thể khớp hai phần.
5. **Thêm route Connector bị bỏ** vào `16` §4. Quan trọng nhất: `POST /connectors/{id}/revisions/bootstrap` (`services/connector/src/http/server.ts:221`) — route duy nhất tạo được revision 1 của bound chain; comment `server.ts:217-220` nói rõ path `/revisions` thường không làm được. Thêm `GET .../revisions/current` (`:273`) và `GET .../revisions/{n}` (`:279`).
6. **Thêm workflow `doc-compare`** vào `15` §2. Có 6 file tại `businesses/document-core/src/pipelines/workflows/doc-compare/`. **Phải ghi kèm:** nó không có trong `handlerKinds` của manifest (`src/manifest/document-core.manifest.ts:19`) và không file nào ngoài chính nó import — tức là code chưa đăng ký. Doc hiện §2 chỉ liệt kê `disbursement`.
7. **Ghi rõ 2 điểm doc đang im lặng về lỗi code thật** (chỉ mô tả, không sửa code):
   - Admin shell tự hướng dẫn operator gọi `POST /api/v1/admin/connector-bindings` tại `services/orchestrator/src/app/admin/connector-section-renderer.ts:318` và `shell-router.ts:396`, nhưng route này có **0 match** trong `server.ts`. → `16` §3 cần nói rõ connector mutation chỉ tồn tại qua dispatcher action `connectors.rotate_credential` / `revoke_credential` / `test_credential` (`modules/admin-actions/dispatcher.ts:677,727,753`).
   - `services/connector/src/webhook.ts` export `verifyWebhookSignature`/`parseWebhookPayload`, được re-export tại `src/index.ts:28`, nhưng `src/http/server.ts` có **0 match** `webhook` — module chưa có route. → `16` §4 ghi rõ chưa wire.
8. **Sửa số dòng `server.ts`.** `services/orchestrator/CODE-ARCHITECTURE.md` mục "Nhận xét cấu trúc" ghi "khoảng 4.100 dòng"; thực tế 4.299.
9. **Ghi rõ phạm vi root compose.** `du-rework/docker-compose.yml` chỉ `include` 3 trong 5 deployable (orchestrator, connector, document-core) — thiếu `example-review` và `lc-checker`. Doc 13 §1 đã nói root compose không phải production topology nên không sai, nhưng nên nói rõ để không gây hiểu nhầm. File này nằm ngoài write path của task — chỉ ghi chú cross-ref trong `13` nếu owner cho phép, nếu không thì chuyển sang `CODE-FIX-01`.

**Không thuộc scope task này:** không sửa `docs/07` hay `docs/21` (mục 2 ở trên liên quan tới chúng) — đó là `DOC-SYNC-02`. Không sửa file `.ts` nào.

---

## DOC-SYNC-02 — Đồng bộ `docs/` và business docs (nhiều lane cùng ghi)

| ID | Trạng thái | Owner gợi ý | Phụ thuộc |
|---|---|---|---|
| DOC-SYNC-02 | [~] | Docs lane; phải đếm mtime trước khi vá | DOC-SYNC-01 mục 1-2 (để tránh viết hai nơi khác nhau) |

> **Cảnh báo va chạm:** `du-rework/docs/` đang có **nhiều lane cùng ghi** (qwen-docs, qwen-new, codex). Quy tắc bắt buộc: đếm lines/bytes/mtime của file đích **ngay trước khi vá**; lệch số lần ghi cuối so với lúc đọc → lane khác vừa sửa, phải đọc lại toàn văn. Chỉ append phần của mình, không sửa/xoá nội dung ngoài scope. Nếu file đích đang bị lane khác ghi, **dừng và báo**, đừng viết đè.

**Allowed write paths:** `du-rework/docs/07-internal-api.md`, `du-rework/docs/21-openapi.json`, `du-rework/docs/10-document-core.md`, `du-rework/businesses/document-core/docs/variant-matrix.md`.

**Acceptance đo được:**

1. **`/tasks/{id}/context` — gỡ khẳng định sai.** Route vắng hẳn khỏi router (xem DOC-SYNC-01 mục 2). Ba nơi đang khẳng định nó live: `docs/07-internal-api.md:41`, `docs/21-openapi.json:2157`, `architecture/05-internal-api.md:56`. Ghi rõ "chưa implement trong router". **Lưu ý:** `docs/20-openapi-descriptions.md:99` đã nói đúng "Do not publish until implemented" — dùng làm chuẩn văn phong.
2. **`docs/21-openapi.json`** — sửa theo spec `21-openapi.json` trong repo. Nếu file này sinh từ tooling, **tìm và sửa nguồn sinh**, không sửa tay bản artifact; nếu không có nguồn thì ghi blocker thay vì sửa tay.
3. **Đồng bộ 28 → 31.** Số đúng là 31 — khớp manifest enums (`src/manifest/document-core.manifest.ts:35/79/112/146/182/217`), 31 recipe (`src/recipes/recipe-definitions.ts`), và registry gốc `lib/endpoints/registry.ts`. Ba variant chênh là `extract/id-card`, `analyze/fact-check`, `analyze/summarize-eval` — cả ba đều có handler, recipe, normalizer, validator đầy đủ, không phải khai báo mà chưa làm. Sửa ở 2 file trong write path:
   - `businesses/document-core/docs/variant-matrix.md` — tiêu đề file lẫn dòng 3/5 đều ghi 28, bảng 6 action thiếu 3 variant trên. Cần thêm cả các dòng matrix chi tiết tương ứng, không chỉ số tổng.
   - `docs/10-document-core.md:16` ghi "Tổng cộng **28 subcases**: 4+5+5+5+6+3".

**Không sửa `architecture/01`, `04`, `07`, `09`, `docs/00`, `13`, `29`, `30`, `35`, `field-dictionary.md`, `test-fixture-specification.md`, `synthetic-corpus-policy.md`, `traceability-matrix.md`** — phạm vi rộng hơn, xem `DOC-SYNC-03`. Nêu tên các file đó trong handoff để lane sau xử lý.

---

## DOC-SYNC-03 — Số 31 vs 28: chốt trong `architecture/`, để lại `docs/` cho lane khác

| ID | Trạng thái | Owner gợi ý | Phụ thuộc |
|---|---|---|---|
| DOC-SYNC-03 | [~] | Docs + chủ sản phẩm (scope decision) | DOC-SYNC-02 mục 3 đã đồng bộ phần core |

**Allowed write paths:** `du-rework/architecture/01-product.md`, `du-rework/architecture/04-core-api.md`, `du-rework/architecture/README.md`, `du-rework/architecture/07-capacity.md`, `du-rework/architecture/09-readiness.md`.

**Acceptance đo được:**

1. **`architecture/01-product.md:20`** giữ nguyên câu hỏi scope cho chủ sản phẩm, nhưng ghi rõ **code đã có 31** và 28 là con số spec cũ. Hiện câu này là nơi duy nhất trong bộ architecture tự nhận ra chênh lệch, nhưng để ngỏ chưa nói phía nào đúng.
2. **Bảng per-action ở `01` (dòng 13-18)** đang liệt kê 28 — extract thiếu `id-card`, analyze thiếu `fact-check`/`summarize-eval`. Sửa khớp manifest.
3. **`04-core-api.md:144,148`** ghi "28 biến thể" và link `[28 variants](../businesses/document-core/docs/variant-matrix.md)` — link có đích nhưng nhãn sai sau khi DOC-SYNC-02 sửa file đích.
4. **`README.md:38` và `07-capacity.md:59`, `09-readiness.md:22,23,34,62`** — sửa con số, hoặc nếu `09-readiness.md` dùng 28 như một GAP review mở thì **giữ nguyên GAP và chỉ chú thêm** rằng code đã có 31. `09-readiness.md:23` đang ghi GAP-11; `tasks/CODE-REVIEW-ADDENDUM-2026-10-01.md:13` (CRX-05) đã ghi claim "chỉ có 28" là lỗi thời — nói rõ GAP-11 đã được giải quyển ở code nhưng chưa đóng ở text.
5. **Không tự tick GAP-11 thành đã giải quyết.** Việc cắt/thêm scope vẫn là quyết định chủ sản phẩm. Chỉ cập nhật mô tả trạng thái code.

---

## CODE-FIX-01 — Admin shell chỉ hướng dẫn tới route không tồn tại (CODE, plan only)

| ID | Trạng thái | Owner gợi ý | Phụ thuộc |
|---|---|---|---|
| CODE-FIX-01 | [~] | Orchestrator + Admin UX; P6-admin | DOC-SYNC-01 mục 7 ghi nhận |

> **Đã chốt theo chỉ đạo user:** Phương án A — sửa hướng dẫn, KHÔNG thêm route. Không tick `[x]`: cần Claude Code `APPROVED`.

**Mismatch ban đầu (3 chỗ, không phải 2):**

| Nơi | Claim | Thực tế |
|---|---|---|
| `src/app/admin/connector-section-renderer.ts:318` | "The platform exposes only `POST /api/v1/admin/connector-bindings`" | `server.ts` có **0 match** `connector-bindings` |
| `src/app/admin/shell-server.ts` (comment P6-04) | idem | idem |
| `src/app/admin/shell-router-shared.ts` (comment fetcher) | idem | idem |

**Phát hiện mới khi sửa — comment sai ở tầng thứ hai.** Cả ba chỗ không chỉ hướng sai về binding route, chúng còn nói **"GET route chưa có, chờ nó land"**. Điều đó sai: `GET /api/v1/admin/connectors/:id/revisions/:rev` **đã tồn tại** tại `server.ts:2562` (ADM-BASE-01). Tức admin shell đang tự diễn giải một `not-found` là do route chưa có, trong khi nguyên nhân thật có thể là connector chưa được đăng ký.

**Việc đã làm:**
- `connector-section-renderer.ts` — chuỗi `not-found` hiện trực tiếp cho operator nay nói đúng đường đi thật: không có platform route tạo binding; connector đăng ký ở Connector service; đổi credential qua `POST /api/v1/admin/actions` với action `connectors.rotate_credential` / `revoke_credential` / `test_credential` (xác minh ở `modules/admin-actions/dispatcher.ts:118-120,677,727,753`).
- `shell-server.ts` + `shell-router-shared.ts` — comment ghi GET route là chờ-land, nay ghi nó đã có và quy `not-found` về nguyên nhân đúng.
- Chỉ sửa nội dung hiển thị và comment. **Không** thêm route, **không** đổi schema/router.

**Verify:** `tests/admin-connector-render.test.ts` **16/16 pass x2** (exit 0). `admin-shell-render.test.ts` có 2 test đỏ nhưng **chứng minh không phải do thay đổi này**: stash đúng 2 file của packet rồi chạy lại vẫn đúng 2 fail — nguyên nhân là role `operator` bị chặn ở section `profiles`, không liên quan connector. Đã stash pop, diff khôi phục nguyên vẹn.

**Phương án B (thêm `POST /api/v1/admin/connector-bindings`) — vẫn mở nhưng không chọn.** Lý do kỹ thuật, không phải thẩm mỹ: `server.ts:2554-2560` ghi rõ platform **không có** connector registry table — connector sống ở Connector service, platform chỉ giữ base URL và health probe. Tạo binding route sẽ phải bịa ra bảng state mà platform không có. Nếu sau này cần, nó phải thuộc Connector-side revision lifecycle (`revisions/bootstrap`), không phải admin route.

**Câu hỏi auth đã trả lời:** shell không tự gọi route admin JSON bằng cookie. Các fetcher gọi **server-side** qua `jsonBaseUrl` với admin bearer do server cấu hình, có fallback in-process catalog. Đây là **bug tài liệu, không phải bug runtime** — `assertAdminAuth` chỉ nhận bearer là đúng với cách shell dùng nó.

**Ghi chú (chưa sửa, ngoài phạm vi packet):** `tsc --noEmit` orchestrator đỏ **13 lỗi trong `src/app/admin/shell-router-shared.ts`** (`export export` x11, thiếu module `./auth-dispatch`). File đó **untracked**, đang được lane khác tạo/sửa. Không lỗi nào thuộc packet này — không sửa để không đụng lease của lane đó.

---

## CODE-FIX-02 — Connector: `webhook.ts` chưa wire (đã chốt: GIỮ API, sửa mô tả)

| ID | Trạng thái | Owner gợi ý | Phụ thuộc |
|---|---|---|---|
| CODE-FIX-02 | [~] | Connector + P3 | DOC-SYNC-01 mục 7 |

> **Đã chốt theo chỉ đạo user:** giữ helper, KHÔNG wire route inbound, KHÔNG rút export. Sửa code: chỉ docstring trong `services/connector/src/webhook.ts`.

**Quan sát ban đầu:** `services/connector/src/webhook.ts` export `verifyWebhookSignature` + `parseWebhookPayload`; `src/index.ts:28` re-export cả hai → nhìn API package thì đây là tính năng dùng được. Nhưng `src/http/server.ts` có **0 match** `webhook` → không route nào nhận callback. Doc 16 §4 không claim có route này, nên **đây là lỗ hổng code, không phải lỗi doc**.

**Quyết định — wire route hay rút export? → CẢ HAI ĐỀU SAI.** Phân tích lại từ hướng dữ liệu thay vì chỉ nhìn route table:

| Hướng | Vì sao không chọn |

|---|---|

| **Wire route inbound** | Hai hàm này xác minh delivery mà **Orchestrator gửi TỚI subscriber** (`modules/webhooks/webhooks.ts:447` phát ra, `signWebhookBody` ký HMAC-SHA256). Route inbound ở Connector sẽ có nghĩa **nhận callback TỪ provider** — trust boundary khác, secret khác, schema khác. Chưa provider protocol nào khai báo webhook nên wire route là **tự bịa contract**. |

| **Rút export khỏi `index.ts`** | Không phải dead code bị bỏ rơi: có test đầy đủ (`tests/webhook.test.ts`, 6 test), dùng schema đã freeze từ `@du/contracts`, và là API public của package cho consumer. Rút export sẽ **xoá một surface hợp lệ**. |

**Việc đã làm:** sửa docstring để nói rõ đây là helper dành cho consumer, và *vì sao* không có route inbound — có lập luận để người sau không "sửa cho xong" bằng cách tự thêm route.

**Verify:** `tests/webhook.test.ts` 6/6 pass x2; `tsc --noEmit` connector exit 0.

**Còn mở (không phải việc của packet này):** nếu sau này một provider protocol thật sự khai báo webhook inbound, route đó thuộc packet riêng của Connector với secret/replay-window/idempotency riêng.

---

## Thứ tự và rủi ro

1. `DOC-SYNC-01` làm trước — doc-only, không đụng file đang có lane khác ghi.
2. `DOC-SYNC-02` sau, cần đếm mtime `docs/` ngay trước khi vá. Nếu `docs/07` hoặc `docs/21` đang bị lane khác sửa → dừng, báo lại.
3. `DOC-SYNC-03` chạy song song với 02 nhưng **không** ghi cùng file với 02.
4. `CODE-FIX-01` / `CODE-FIX-02` chỉ là plan. Cần người quyết định scope trước khi ai đụng code.

**Không task nào được:** tự implement route còn thiếu, tự tick `[x]`, tự đóng GAP-11, sửa `pnpm-lock.yaml`, hoặc chạy test cần PostgreSQL/Redis/Vault live.

## Gate

Cả 5 packet cần Claude Code `APPROVED` + đối chiếu full acceptance theo `du-rework/AGENTS.md` trước khi đánh dấu `[x]`. Trạng thái hiện tại của bộ hồ sơ kiến trúc là **plan-only**; việc audit là đọc-chỉ, không tạo bằng chứng runtime.
