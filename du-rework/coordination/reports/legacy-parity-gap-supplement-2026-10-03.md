# Receipt — legacy-parity-gap-supplement — 2026-10-03

**Packet:** legacy-parity-gap-supplement · **Dispatch:** 2026-10-03T23:02+07:00 (coordinator command-code, theo yêu cầu user)
**Boundary:** chỉ ghi `du-rework/tasks/*.md` + receipt này. Không sửa code/source/test; không tick gate; không commit; không chạm `nocobase-10`; không dispatch agent khác.
**Deliverable duy nhất thay đổi repo:** `tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md` (MỚI, 2 row `ORCH-LPG-01/02`).
Không sửa bất kỳ row plan hiện có nào. `tasks/README.md` đang `M` từ trước — giữ nguyên, không đụng.

## 1. Bảng phân loại coverage (tóm tắt; anchor đầy đủ theo nhóm)

**Phạm vi quét:** 46 file `app/api/**/route.ts`, toàn bộ `lib/**` (endpoints, parsers, pipelines,
queue, storage, workflow-builder + 15 module gốc), `worker.ts`, `middleware.ts`. Mỗi capability
đúng 1 trong 3: **(a)** có row plan · **(b)** đã implement ở rework · **(c)** THIẾU ⇒ row mới.

| Nhóm legacy | Anchor | Class | Căn cứ |
|---|---|---|---|
| 6 doc services + workflows + schema trigger | `app/api/v1/docs/*` | (a) | COMP-00..11; P9-04; PAR-16; matrix `ORCHESTRATOR-LEGACY-FEATURE-PARITY:16,20` |
| Operations poll/list/cancel/download/resume, services, billing | `app/api/v1/{operations,services,billing}/*` | (a) | COMP-04..08; PAR-07/17 |
| apikeys / profile-endpoints / ext-overrides / ext-connections(+test) | `app/api/internal/*` | (a) | PAR-01/02/03 + field-level PAR-11/12/13/14 |
| user-profiles, users CRUD, NextAuth/OIDC | `app/api/internal/user-profiles`, `app/api/users/*`, `app/api/auth/*` | (a) | LOCAL-00..06; PAR-05/16 |
| workflow-schemas (+override, +pipeline-mappings) | `app/api/internal/workflow-schemas/*` | (a) | PAR-04/16; P9-04; COMP-09 |
| settings (+cache/s3-test/test), swagger, analytics, operations UI poll | `app/api/{settings,swagger,operations}/*`, `internal/analytics` | (a) | PAR-06/15 (17-key replacement map + bounded diagnostics); PAR-09/17; PAR-07 |
| recover-stalled, health | `app/api/internal/recover-stalled`, `app/api/health` | (a)+(b) | PAR-08/17 safe-ops; rework lease sweep P2-09 + health route đã có |
| auth-key read, dev-sync-endpoints, raw Bull Board, cleanup-by-GET | `internal/{auth-key,dev-sync-endpoints}`, `api/{bull-board,cleanup}` | (a) non-parity | `ORCHESTRATOR-LEGACY-FEATURE-PARITY:28` — retire có replacement, không sao chép |
| prompt-wizard, chat, demo pages | `internal/prompt-wizard`, `api/chat`, `app/doc-pipeline|lc-checker|doc-compare` | (a) decision | PAR-00 register + matrix `:26` — product decision, không thuộc generic Orchestrator |
| registry/runner/presets, pipeline engine/format/validate, processors | `lib/endpoints/*`, `lib/pipelines/*` | (a) | COMP registry/sub-case wire; PAR-02/12 merge/lock; PAR-03/14 connector egress/prompt/session; compress-levels = sub-case params |
| parsers word/excel, upload validate 300MB/.docm/allowlist/NFC | `lib/parsers/*`, `lib/upload.ts` | (a) | P9/COMP ingest-extract; PAR-12 `allowedFileExtensions`; ART-02/03 (`P8-release-readiness.md:36`); RFX-08. Detail notes §3 file addendum |
| file-url-downloader (SSRF, per-profile auth, 120s) | `lib/file-url-downloader.ts` | (a)+(b) | PAR-12 `fileUrlAuthConfig`; P8-04 SSRF suite; rework URL ingestion + ingestion-consumer fail-closed đã implement |
| queue singleton, retry 3 attempts exp backoff, stalled 30s/×2 | `lib/queue/*`, `worker.ts:68-82` | (b) | rework runtime retry budget + expired-lease recovery (P2-09, đã test) |
| storage local/s3 backend | `lib/storage/{local,s3}-backend.ts` | (a)+(b) | DATA/DEPLOY-STORAGE-LOGGING; CRX-02 S3 read guard; RFX crypto seam |
| crypto AES-GCM cho key/secret at rest | `lib/crypto.ts` | (a) | ENC rows + PAR-12 `fileUrlAuthConfig` |
| logger, errors, config, rbac, auth | `lib/{logger,errors,config,rbac,auth}.ts` | (a) | LOG-01; LOCAL/OIDC; PAR-05 |
| cleanup files 24h + cache TTL 168h | `lib/cleanup*.ts`, `lib/settings.ts:108` | (a) | PAR-08/17 retention job có confirm/dry-run/audit; DATA-02; refCount interplay → LPG-01 |
| rate-limit module | `lib/rate-limit.ts` | **rejected** | §3.1 — legacy không wire vào `/api/v1/**`; không phải parity gap |
| zip stream | `lib/zip.ts` | **rejected** | §3.2 — dead code, 0 caller |
| spending-limit 402 chain | `lib/pipelines/submit.ts:152-173` | **rejected** | §3.3 — capability bị COST-04 + COMP-08 bao phủ |
| **FileCache content-hash dedup** | `lib/storage/dedup.ts:21-81` | **(c) → `ORCH-LPG-01`** | §2.1 |
| **Worker heap-ratio backpressure** | `worker.ts:122-141` | **(c) → `ORCH-LPG-02`** | §2.2 |

## 2. Row mới đã thêm (file `tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md`)

### 2.1 `ORCH-LPG-01` — Content-hash dedup cho file bytes (FileCache parity) `[ ]`
- **Anchor legacy:** `lib/storage/dedup.ts:21-81` (upsert atomic `:31-43`, canonical adopt/delete `:46-55`,
  race fallback `:59-78`); callers `lib/upload-helper.ts:52`, `lib/file-url-downloader.ts:256`;
  model `FileCache`; cleanup `lib/cleanup.ts` + `s3_cache_ttl_hours` (`lib/settings.ts:108`).
- **Chứng minh THIẾU:** grep register (`plan-open-task-register-2026-10-03.md`, 237 row) + `tasks/` cho
  `filecache|refcount|content-hash|dedup` → 0 row phủ; grep `services/orchestrator/src` +
  `packages/worker-sdk/src` → chỉ idempotency/queue/usage dedup (khác concern); artifact
  upload/finalize/multipart luôn ghi object mới.
- **Lý do cần:** tiết kiệm storage/băng thông là hành vi production thật của legacy (mọi upload và
  file_url đều qua dedup); refCount còn là reference-tracking mà retention rework (DATA-02,
  "không xóa artifact còn tham chiếu" PAR-06/17) đang cần.
- **Không tự quyết:** 3 decision point ghi trong row — (i) tenant scope (legacy global ⇒ cross-tenant
  existence oracle), (ii) ENC interplay (ciphertext không dedup được; plaintext md5 lộ equality ⇒
  keyed/convergent hash), (iii) refCount lifecycle khóa với retention.

### 2.2 `ORCH-LPG-02` — Worker memory backpressure (pause/resume claim theo heap ratio) `[ ]`
- **Anchor legacy:** `worker.ts:122-141` (`WORKER_MEMORY_THRESHOLD` default 0.90 `:124`, pause cả hai
  worker `:131-135`, resume hysteresis ×0.85 `:136-140`); bối cảnh concurrency `:32,34`.
- **Chứng minh THIẾU:** grep register + `tasks/` cho `heap|memory|backpressure|pause.*resume` → chỉ có
  triage thủ công (`P8-release-readiness.md:68` OPS-02 runbook), decrypt-path bound (RFX-08), CPU guard
  business (FULL-REWORK:133) — không row nào là automated claim brake; grep `worker-sdk/src` → chỉ
  bounded streaming per-artifact (`artifact-streams.ts:31-38`, `artifact-multipart.ts:93`).
- **Lý do cần:** không có cơ chế này, fleet worker OOM chuỗi dưới tải lớn (đúng failure mode legacy
  đã vá); là production-readiness blocker (P8), không chặn wire cutover.

**Kiểm ID:** prefix `LPG-` grep toàn repo = 0 collision (`GAP-11` thuộc architecture doc register,
namespace khác — không dùng prefix `GAP-`).

## 3. Ứng viên bị loại sau dedupe (kèm bằng chứng)

### 3.1 Rate limiting — KHÔNG phải parity gap
`lib/rate-limit.ts:34-63` (Redis sliding window, fail-open) có đúng 1 caller:
`app/api/internal/auth-key/route.ts:18`; `middleware.ts:33-53` branch `/api/v1/` KHÔNG gọi — capability
"per-API-key rate limiting" trên public wire **chưa từng tồn tại ở legacy** (CLAUDE.md claim là doc
inaccurate). Đã được `codex-legacy-ratelimit-list-query-surface-2026-10-01.md` đặc tả + cờ
MUST-NOT-REPLICATE (bucket từ raw key 16 ký tự đầu). Edge throttling cho rework là capability MỚI →
mục §4 decision, không phải parity row.

### 3.2 ZIP download — dead code
`lib/zip.ts:20-50` (archiver, `{slug}-full/text-only.md` + images): grep caller `lib/zip|lib/archive`
trừ du-rework = 0 → không có hành vi production để replicate. `lib/archive.ts` đã nằm trong P9-04
(node library) + P4-06 (archive bomb guard).

### 3.3 Spending-limit enforcement 402 — bị COST-04 + COMP-08 bao phủ
Chain legacy: `submit.ts:152-173` (402 `spending-limit-exceeded` khi `totalUsed >= spendingLimit`),
ghi `totalUsed += totalCost` ở `engine.ts:416-419` / `workflow-engine.ts:235-238`, projection
`billing/balance/route.ts:26-46`, schema `schema.ts:60-61`. Rework plan: COST-04
(`docs/admin-ops-monitoring-cost.md:47` + `:81-98`) đã implement-offline budget policy
`block-new-invocations` + durable `BudgetReservationService` (migration 0022) — tổng quát hơn 402
admission check; COMP-08 phủ balance/usage projection + wire 402. **Coverage note:** khi COMP-08/COST-04
chốt acceptance, cần map rõ legacy 402 problem+json type `https://dugate.vn/errors/spending-limit-exceeded`
vào wire decision; không cần row riêng.

### 3.4 Ứng viên khác đã kiểm và loại
- `/setup` first-admin page: **không tồn tại** trong legacy tree (`ls app/setup` = không có) — CLAUDE.md
  stale; rework đã chọn CLI bootstrap (`LOCAL-01`), replacement có chủ ý.
- `WORKER_CONCURRENCY` + stalled 30s/maxStalledCount 2: đã có ở rework runtime (concurrency config +
  lease sweep P2-09) — (b).
- `.docm`/NFC/compress-levels: detail notes fold vào PAR-12/COMP acceptance (§"Ghi chú detail" file addendum),
  không đủ tầm row riêng.

## 4. Cần quyết định user/product (ghi nhận, không tự quyết)

1. **Edge rate-limiting / throttling cho public wire rework** — legacy không có để replicate; nếu product
   muốn, đây là feature mới (policy: per-key? per-IP? fail-open hay fail-closed khi Redis down? quan hệ
   `RATE_LIMIT_*` legacy chỉ là tham khảo).
2. **`ORCH-LPG-01` decision (i):** dedup per-tenant vs shared pool vs retire — trade-off storage savings
   vs cross-tenant existence oracle. Legacy chọn global; rework không nên mặc định theo.
3. **`ORCH-LPG-01` decision (ii):** dedup dưới encryption-at-rest — keyed/convergent hash hay chỉ dedup ở
   plaintext mode; khóa với ENC owner.
4. **End-user service UI pages** (`app/ingest|extract|analyze|transform|generate|compare|history|ai-demo|login`
   + `components/*`): đã đăng ký product-decision ở PAR-00/matrix `:26` (demo pages ở client/demo app,
   không nhét Orchestrator) — không mở lại ở đây, chỉ xác nhận sweep lần này không đổi kết luận đó.
5. **Admin-key fallback trong workflow trigger** (finding, đề xuất MUST-NOT-REPLICATE):
   `app/api/v1/docs/workflows/route.ts:77-86` và `.../schema/route.ts:76-79` — thiếu apiKeyId thì lấy
   **ADMIN key đầu tiên** gán operation, trong khi middleware pass-through `/api/v1/` ⇒ trigger workflow
   gần như unauthenticated chạy dưới profile admin. COMP-09/P9-04 chốt wire workflow cần loại trừ tường
   minh hành vi này.

## 5. Chưa phủ trong lượt này (công bố giới hạn)

1. **Inventory UI component-level** (`app/(pages)/**`, `components/**`): agent nền phụ trách chạy quá lâu,
   đã stop; quyết định đóng sweep UI bằng register PAR-00 (UI end-user là product decision, không sinh row
   mới bất kể inventory chi tiết). Hai agent inventory còn lại (api routes, lib) mất kết quả sau compaction —
   lane đã tự quét trực tiếp toàn bộ 46 route + `lib/**` thay thế (bảng §1).
2. `prisma/migrations` history, `scripts/`, `mock-service/`, `docs-site/`, `tests/` legacy: tooling/test,
   không phải product capability — ngoài phạm vi parity theo packet.
3. Không verify lại các row (b) bằng chạy test — packet này là plan-audit thuần; live evidence thuộc các
   lane verify (WTV/VFY) hiện hữu.

## 6. Trạng thái cuối

- File mới: `tasks/LEGACY-PARITY-GAP-ADDENDUM-2026-10-03.md` (SPECIFIED, 2 row `[ ]`, không gate mới).
- Không sửa row/plan hiện có; không tick; không commit; không chạm `nocobase-10`.
- Mọi acceptance live (PAR-10/ACUI-10/VFY-LOCAL, gates G-*) giữ nguyên NO-GO.
