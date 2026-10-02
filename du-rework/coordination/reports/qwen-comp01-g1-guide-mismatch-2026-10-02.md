# COMP01-G1 — guide `/api/v1/extract` mismatch (read-only supplement)

- **TaskRef**: `task_6cdf4cb1e604`
- **Spec**: `du-rework/coordination/dispatch-specs/2026-10-02-0320-COMP01-G1-guide-mismatch.md`
- **Date**: 2026-10-02
- **Lane**: `qwen_4` (codex) — read-only characterization
- **Gates ticked**: NONE. All `G-*` remain NO-GO.
- **Commits**: NONE. Không sửa/ghi/xoá file hiện có nào.
- **Security**: không tái hiện lỗi bảo mật legacy; chỉ nêu fact về path.

---

## 0. Method + boundaries held

Files opened (read-only): `du-rework/docs/06b-api-spec-overview.md`,
`du-rework/docs/21-openapi.json`, `du-rework/architecture/09-readiness.md`,
`du-rework/services/orchestrator/src/compat/legacy-action-router.ts` (+ test),
`du-rework/coordination/reports/codex-comp01-slice-{a,c,e}-*.md` (chỉ để de-dup),
`app/api/v1/docs/extract/route.ts`, `lib/endpoints/registry.ts`.

Không chạm: `server.ts`, `contracts/src`, `businesses/document-core/**` (lease D3),
`tasks/*.md`, `AGENTS.md`, lockfile, execution overlay. Không chạy live/infra, không cài gói,
không nhắn `nocobase-10`. Không đề xuất nào chạm public wire → COMP-02..09 không bị chặn.

**De-dup check (spec bước 1).** Slice A, C, E **không** phủ chủ đề này. Đo được:

| Receipt | Số lần có `06b` / `api-spec-overview` / `readiness` |
|---|---|
| `codex-comp01-slice-a-...md` | 0 (1 match không liên quan: `fix-plan-workflow-builder.md:151-161`) |
| `codex-comp01-slice-c-...md` | 0 |
| `codex-comp01-slice-e-...md` | 0 (1 match không liên quan: `workflow-schema-guide.md:224-246,541`) |

Đóng `G-1` từ `qwen-comp01-consolidate-2026-10-02.md:50,211` (§5).

---

## 1. Claim sai (wrong side) — file:line

`du-rework/docs/06b-api-spec-overview.md` mang path này ở **hai chỗ độc lập**:

| # | file:line | Nội dung | Cách sinh ra path |
|---|---|---|---|
| C1 | `06b:48` | `### Public — /api/v1` | khai báo base path |
| C2 | `06b:53` | dòng 2 của bảng catalog: `POST /extract` + mô tả 6 sub-case | tương đối so với base ở C1 → `/api/v1/extract` |
| C3 | `06b:117` | `C->>M: POST /api/v1/extract {files, params}` | mermaid sequence diagram, path tuyệt đối |

Không chỉ dòng 2: cùng bảng còn có `POST /ingest` (`06b:52`), `POST /analyze` (`:54`),
`POST /transform` (`:55`), `POST /generate` (`:56`), `POST /compare` (`:57`) — **cả 6 route
document đều dính y hệt**.

**Đo được: chuỗi `/api/v1/docs` xuất hiện 0 lần trong `06b`.** Ba match của token `docs`
trong file là `06b:42` (`API docs`), `06b:252` (`docs/06-public-api.md`),
`06b:261` (`docs/21-openapi.json`) — đều là *tên file tài liệu*, không phải route path.

> Đây là phép đo quyết định verdict: một lỗi gõ cục bộ sẽ để lại phần còn lại của file ở
> shape đúng. Ở đây không. Việc thiếu `/docs` là **có hệ thống trên cả 6 route và cả file
> 286 dòng** → không phải lỗi gõ.

---

## 2. Route thật (correct side) — file:line

Có **hai** bề mặt thật, và `/api/v1/extract` **không phải** bất kỳ bên nào.

### R1 — legacy Next.js app (path mà COMP-01 so sánh)

| file:line | Nội dung |
|---|---|
| `app/api/v1/docs/extract/route.ts:1` | `// app/api/v1/extract/route.ts` ← **path sai trong comment đầu file** (đây là CM-A1, xem §4) |
| `app/api/v1/docs/extract/route.ts:5-7` | `export async function POST(req) { return runEndpoint('extract', req); }` |
| `lib/endpoints/registry.ts:115` | `route: 'POST /api/v1/docs/extract',` |
| `lib/endpoints/registry.ts:113` | `slug: 'extract',` |

Thư mục thật trên đĩa là `app/api/v1/docs/extract/` — segment `/docs` là có thật. Code và
registry khớp nhau; chỉ comment dòng 1 sai.

### R2 — canonical machine-readable spec của rework

| file:line | Nội dung |
|---|---|
| `du-rework/docs/21-openapi.json:733` | `"/api/v1/businesses/{id}/actions/{action}": {` |
| `du-rework/docs/06b-api-spec-overview.md:267` | Generic API (`POST /businesses/{id}/actions/{action}`) là canonical; 6 document routes là **facade** tương thích |

Đo trên toàn bộ **44** path key của `21-openapi.json`:

| Path | Số lần |
|---|---|
| `/api/v1/extract` | **0** |
| `/api/v1/ingest`, `/api/v1/analyze`, `/api/v1/transform`, `/api/v1/generate`, `/api/v1/compare` | **0** |
| `/api/v1/docs/*` | **0** |
| `/api/v1/businesses/{id}/actions/{action}` | **1** (dòng 733) |

Nghĩa là: spec machine-readable mang route generic canonical và **không** mang route
facade nào — không shape của `06b`, cũng không shape legacy.

### R3 — compat router của rework cố ý từ chối shape của `06b`

| file:line | Nội dung |
|---|---|
| `du-rework/services/orchestrator/src/compat/legacy-action-router.ts:65-67` | comment: guide cũng vẽ `/api/v1/{action}`, legacy code không hề mount — đó là MISMATCH đã biết, và match vào đây sẽ là **bề mặt MỚI chứ không phải compat** |
| `.../legacy-action-router.ts:68` | `LEGACY_ACTION_PATH_PREFIX = '/api/v1/docs/'` |
| `.../legacy-action-router.ts:221` | `if (!pathname.startsWith(LEGACY_ACTION_PATH_PREFIX)) return null;` |
| `.../tests/legacy-action-router.test.ts:145-147` | `'/api/v1/extract'` nằm trong danh sách **foreign** → `parseLegacyActionPath` null, `router.handles` false |

Mismatch này đã được phát hiện ngay trong COMP-03 và được **ghim bằng negative test**
thay vì bằng một assertion rằng path đó chạy được. Không chỗ nào trong rework phục vụ
`/api/v1/extract`.

---

## 3. Verdict: **defect RIÊNG, không phải CM-A1** — và lớn hơn lỗi gõ tài liệu

**Trả lời spec bước 2: `separate`.** Cùng một chuỗi, nhưng khác lớp, khác chủ sở hữu,
khác hậu quả. Không được đóng chung một mục.

| | **CM-A1** | **G-1 (receipt này)** |
|---|---|---|
| Vị trí | `app/api/v1/docs/extract/route.ts:1` (**comment code**) | `06b:52-57` + `06b:117` (**prose/bảng spec của rework**) |
| Sai cái gì | annotation trỏ tới path không tồn tại | catalog của chính spec trỏ tới path **không có trong artifact nào** |
| Code đúng chưa? | đúng — code ổn, comment sai | không áp dụng — nó *là* spec |
| Hậu quả nếu tin | gây hiểu nhầm khi người ta grep route | client sinh từ `06b` gặp 404 trên cả 6 core action |
| Chủ sở hữu | legacy app (vệ sinh annotation) | COMP-00 / Product (quyết định public surface) |

Lập luận — viết ra để kiểm chứng được:

1. **Không phải lỗi gõ theo nghĩa thường.** §1 đo `/api/v1/docs` = 0 lần trên 286
   dòng. Lỗi gõ là mâu thuẫn cục bộ; đây là một quy ước xuyên cả file.
2. **Không phải CM-A1** vì CM-A1 để lại code chạy được với nhãn sai, còn `06b` *là* nhãn và
   không có code phía sau. Sửa comment trong legacy app không thay đổi được gì về `06b`.
3. **`06b` mâu thuẫn với chính nó về vai trò của 6 route.** §2 (`:52-57`) trình bày chúng
   là public API; §8 (`:267`) hạ chúng xuống thành *facade* sau route generic canonical;
   §7 (`:257`) vẫn để route canonical ở trạng thái `TODO`. TODO đó nay **đã được trả lời
   từ artifact trên đĩa**: `21-openapi.json:733` có path này. Checklist tự đồng bộ của
   `06b` chưa chạy tới cuối, và chính dòng bị bỏ ngang là dòng lẽ ra bắt được issue này.
4. **`06b` và `architecture/09-readiness.md` kết luận ngược nhau về cùng một chuỗi:**

| file:line | Cách đọc `/api/v1/extract` |
|---|---|
| `du-rework/docs/06b:53,117` | một route **mới** của nền tảng rework |
| `du-rework/architecture/09-readiness.md:33` | một path **legacy**, xếp dưới mục *khác biệt với tài liệu project gốc* → **không mặc định hỗ trợ**; canonical mới là business/action + Operation `id/state` |

Hai tài liệu rework gán **hai nghĩa không tương thích** cho cùng một path. Đây mới là
finding, và nó không quy về một lần sửa chính tả: một trong hai tài liệu phải bị rút lại,
hoặc chuỗi này phải được gán một nghĩa thống nhất.

---

## 4. Chỉ nêu fact (không tự tuyên verdict)

- **Không route legacy nào** trả lời ở `/api/v1/extract`. (R1: chỉ có `app/api/v1/docs/extract/`.)
- **Không route rework nào** trả lời ở `/api/v1/extract`. (R3: prefix là `/api/v1/docs/`;
  dạng không có `/docs` là negative test đã ghim.)
- Chuỗi `/api/v1/extract` xuất hiện trong cây rework tại: `docs/06b:53`, `docs/06b:117`,
  `architecture/09-readiness.md:33`, `services/orchestrator/tests/legacy-action-router.test.ts:145`,
  cộng với `tasks/API-COMPAT-DUGATE-2026-09-28.md:50` và hai dòng trong
  `coordination/scripts/coordinator-*.py` — hai dòng sau chỉ **trích lại chính mismatch cần tìm**.
- Bề mặt machine-readable authoritative `21-openapi.json` mang
  `/api/v1/businesses/{id}/actions/{action}` và **không** mang route document nào.

### 4.1 Vì sao không đóng chung với CM-A1

| | CM-A1 | G-1 |
|---|---|---|
| Bản chất | **annotation** trong code legacy | **đặc tả** của rework |
| Code phía sau | có, và chạy đúng | không có route nào ở shape này |
| Sửa comment legacy có giải được? | có | không |
| Người chịu trách nhiệm | lane sở hữu legacy app | COMP-00 (quyết định public surface) |
| Rủi ro nếu bỏ sót | đọc nhầm khi grep | client sinh từ `06b` nhận 404 trên cả 6 core action |

`coordination/reviews/2026-10-01-0925-coordinator.md:40` chỉ đề cập CM-A1. Không tài liệu
nào trong 8 slice receipt trước đó đụng G-1 (đo ở §0).

---

## 5. Điều tôi KHÔNG quyết

Theo spec: G-1 là **evidence đầu vào quyết định**, không phải blocker, và quyết định public
wire thuộc COMP-00. Vì vậy tôi **không** đề xuất: có nên mount `/api/v1/{action}` làm
facade trong rework; có nên viết lại `06b` thành `/api/v1/docs/{action}`; hay nên rút lại
`09-readiness.md:33` hay `06b`. **Cả ba lựa chọn đều chạm public wire → BLOCKED-COMP-00.**
Ba hướng chỉ được liệt kê để người quyết định thấy hình dạng của lựa chọn, không phải để tôi
chọn.

**Gate impact: NONE.** Receipt này không tick, không dịch chuyển, không ngụ ý bất kỳ release
gate nào. Tất cả `G-*` vẫn NO-GO.

---

## 6. Cross-reference

| Nguồn | Nội dung liên quan |
|---|---|
| `tasks/API-COMPAT-DUGATE-2026-09-28.md:50` | text task COMP-01 nêu tên mismatch này |
| `qwen-comp01-consolidate-2026-10-02.md:50,211` | §5 G-1: đánh dấu chưa slice nào phủ |
| `qwen-docs.md:4716,4730` (E9 / Δ-COMP01-2) | đã định vị đúng `06b` và **cố ý không** gọi nó là bug; đây là câu hỏi, không phải verdict — receipt này bổ sung phép đo mâu thuẫn mà E9 thiếu. Không mở lại, chỉ mở rộng |
| `coordination/reviews/2026-10-01-0925-coordinator.md:40` | CM-A1, phạm vi riêng |
| `du-rework/docs/06b:257` | checklist tự đồng bộ còn `TODO` — nay đã có câu trả lời từ `21-openapi.json:733` |

---

*End of receipt. Read-only; no gate ticked; no commit; no existing file touched.*