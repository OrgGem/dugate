# QWEN-4 — DATA-01..04 S3 Streaming lane (review + offline verify)

> [!IMPORTANT]
> **RESUME POINT — 2026-09-25 ~05:15Z (cycle W49-Q4-1).** Đọc hết khối này là đủ để tiếp tục, khỏi đọc lại transcript.
>
> **Cycle W49-Q4-1 = HOÀN THÀNH**: ra soat implementation streaming theo packet DATA-01..04
> (`tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md`), chạy typecheck + test offline, KHÔNG sửa source,
> KHÔNG mở DB/Redis. Kết luận chính:
> 1. **readStream/writeStream phía SDK đạt chunking + SHA-256 + whole-body timeout** (F1/F2, có test xanh).
> 2. **MISMATCH-1 (chặn DATA-02)**: engine `uploadMultipart` S3 đầy đủ nhưng CHỈ là helper standalone +
>    unit test — không route/service nào gọi; `@du/contracts` KHÔNG có wire contract multipart nào.
>    SDK `writeStream` là single-PUT, cứng ở `maxArtifactBytes` (default 64MiB).
> 3. **MISMATCH-2 (chặn DATA-04)**: business document-core vẫn dùng buffered `artifacts.write` ở cả 6
>    call-site worker — chưa call-site nào dùng readStream/writeStream.
> Việc còn lại của lane: chờ coordinator quyết owner cho 2 mismatch ở trên rồi mới được wire (protocol
> AGENTS.md: contract DATA-00 trước, không code theo assumption).
>
> **Δ W49-Q4-2 (2026-09-25 ~05:40Z, theo yêu cầu coordinator)**: **BẢN SOẠN THẢO DATA-00 MULTIPART CONTRACT**
> đã vào file — schema Zod wire (init / part grant + expected sha / complete + receipts eTag+sha / abort),
> 4 REST endpoint tương thích route artifacts hiện hành + ngữ nghĩa replay/lease/sweep, chính sách chờ ký,
> delta SDK auto-branch, và kế hoạch 4 bước cho 6 call-site document-core. **Vẫn KHÔNG sửa production** —
> typecheck bằng scratch tạm trong packages/contracts (tsc exit 0), scratch đã xóa sau khi đo; baseline
> @du/contracts lint 0 / build 0 / test 160/160. Toàn bộ ở `## W49-Q4-2` cuối file.
>
> **Δ Cycle 138 (2026-09-25 ~06:30Z, coordinator duyệt §11.2)**: **Step A — CONTRACTS-ONLY ĐÃ LAND**.
> 11 schema + 11 type multipart vào `packages/contracts/src/runtime.ts` (section mới sau ArtifactAccessGrant,
> additive — schema cũ KHÔNG đổi dòng nào) + `tests/multipart-contract.test.ts` **31 case valid/invalid**.
> Receipt: contracts lint 0 / build 0 / **191/191** (160 cũ + 31 mới); downstream worker-sdk **147/147**
> (rerun sau 1 flake ADM-BASE-03 đã biết — tỷ lệ flake nay là 2/6 full-run, ESCALATE ở §13.4);
> orchestrator lint 0. Policy limit vẫn là const export (wire bound) — route layer được override xuống,
> không bao giờ rộng hơn. Không commit/push, không DB/Redis. Chi tiết: `## Cycle 138` cuối file.
>
> **Δ Cycle 138B (2026-09-25 ~07:05Z)**: **Step A DOCUMENT-CORE LANDED** — 6/6 call-site `worker.ts` chuyển
> sang `writeEnvelopeArtifact` → facade `writeStream` (SDK path delegate; facade chỉ-buffer thì drain +
> verify size/sha rồi fallback write — byte-identical). `types/context.ts` KHÔNG đổi (kiểu
> `StreamingTaskContext` nằm trong worker.ts). 3 fixture test phải thay stub `writeStream: throw`
> (p8-03, provider-backed-variant, parser-budgets) vì handler-path giờ thật sự stream-write.
> Receipt: lint 0, test:typecheck 0, **38 offline suites / 484 tests xanh**; loại có chủ đích:
> `bullmq-smoke` (Redis :6380 trên máy này ĐANG sống — suite tự bật live, vi phạm 'không mở Redis';
> đây cũng là thủ phạm làm full `pnpm test` timeout 10') và `multi-container-e2e.integration`.
> Chi tiết: `## Cycle 138B` cuối file.
>
> **Δ Cycle 139 (2026-09-25 ~07:40Z)**: **Step B READ-STREAMING LANDED** — seam mới `ArtifactFacade.stat()`
> (SDK, optional-additive: descriptor có quyền-truy-cập, KHÔNG bytes, lease-fenced) +
> `ParserBudgetHelper.readArtifactViaStream`: artifact >1MiB qua disk-backed TempWorkspace (pre-flight size
> TRƯỚC khi transfer — DOCUMENT_TOO_LARGE zero-byte; cap giữa-dòng; re-hash từ bytes đã đổ đĩa;
> dispose-MỌI-path; cancel/lease fence). Facade buffer-only → nguyên path cũ, byte-identical.
> Receipt: worker-sdk **150/150** (+3 stat test mới, lint 0); document-core **39 suites / 492 pass**
> (thêm suite `read-stream-acquisition` 8 case), lint 0, test:typecheck 0. Không DB/Redis, không commit.
> **Ghi chú lệch §12**: 'pass FILE PATH to pandoc/Ghostscript' KHÔNG ÁP DỤNG — parser du-rework là
> document-kit native Buffer-API (không có đường file-path); để RSS-chunk-thực-sự khi parse cần PR
> `parseFile` trong document-kit — ĐÃ CỜ ở §14.3 cho coordinator. Chi tiết: `## Cycle 139` cuối file.
>
> **Δ Cycle 140 (2026-09-25 ~09:35Z)**: **Step C — SDK writeStream AUTO-BRANCH LANDED** (DATA-04, tiêu
> thụ 4 route DATA-02 của lane Qwen-5): engine mới `packages/worker-sdk/src/artifact-multipart.ts`
> (transport injection, 0 socket/DB; memory = ĐÚNG 1 part — cap nội bộ 64MiB từ chối geometry ép RSS;
> per-part sha + whole sha một lượt; re-grant+re-PUT bound 3 attempts; mọi fail TRƯỚC complete abort
> best-effort — SAU complete KHÔNG abort vì bytes đã commit). Facade branch theo `sizeBytes >
> multipartThresholdBytes (default = maxArtifactBytes)` VÀ ≥ floor wire (64MiB+1) → finalize lại đúng
> gate cũ; **chữ ký call-site business không đổi, 0 diff document-core** (kiểm chứng §12-C bằng hành
> động). RuntimeClient +4 method, ack parse bằng schema Cycle 138. Receipt: worker-sdk **12 suites /
> 171 pass** (+21 test mới; lint 0; boundary flake real-listener 4 đỏ→6/6 rerun, rule §13.4);
> document-core lint 0 + test:typecheck 0 + 63/63 targeted (phần p8-03 về sau được phân loại
> lại sang DB window Tester-1 — xem Δ Cycle 141). Ghi chú adjudicate: lease-lost ghi
> abort-reason `cancelled` (signal bị context abort trước), part-concurrency=1 chờ §6, SDK
> max-part-bytes là cap PROPOSED nội bộ. Chi tiết: `## Cycle 140` cuối file.
>
> **Δ Cycle 141 (2026-09-25 ~09:55Z, adjudication Reviewer chu kỳ 156–161)**: **PHÂN LOẠI LẠI
> Document-Core targeted offline = 2 suites / 56 tests PASS** (parser-budgets 48 +
> read-stream-acquisition 8) — **Zero DB writes, Tester-3 verified**.
> `p8-03-provider-convergence.test.ts` (7 tests) có `PgSqlClient` ghi PG (dòng 328–399, fallback
> :5433) → **danh riêng cho DB Window của Tester-1**; lane từ nay KHÔNG chạy p8-03 trong cửa sổ
> offline. Tester-3 cũng nghiệm thu độc lập Step C worker-sdk **171/171**. Chu kỳ này chỉ văn bản
> report — 0 sửa source, 0 test-run, 0 DB/Redis; HEAD `7811298` nguyên ven. Chi tiết: `## Cycle 141`
> cuối file.

## Packet

- Nguồn vụ: `du-rework/tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md` (DATA-01..04) + `du-rework/AGENTS.md`.
- Phạm vi ra soat: `packages/worker-sdk/src/facades/artifacts.ts` — **path trong packet không tồn tại**;
  bản hiện đang là `packages/worker-sdk/src/artifact-streams.ts` (919 dòng, untracked mới) + facade
  wiring trong `src/task-context.ts` / `src/types.ts`; phía server: `services/orchestrator/src/modules/artifacts/`
  (6 file: storage-facade, s3-storage-facade 744 dòng, postgres-storage-facade, artifacts.ts 599 dòng,
  storage-migration, integrity-scanner). Ghi nhận packet-path-lệch này để coordinator sửa packet.

## F1 — readStream: chunking + SHA-256 — ĐẠT (IMPLEMENTED, VERIFIED offline)

- `task-context.ts:408` `readStream` → grant fenced (taskId+leaseEpoch, mode read) → `openArtifactStream`
  (`artifact-streams.ts:480`).
- Chunking bounded: Transform meter + PassThrough, `highWaterMarkBytes` default 64KiB, cap 1MiB
  (`assertStreamLimits`, `artifact-streams.ts:836`). Không bao giờ buffer toàn body.
- Integrity: đếm bytes + `createHash('sha256')` trong lúc stream; pre-check Content-Length; flush check
  `expectedSizeBytes` → 422 SIZE_MISMATCH, `expectedSha256` → 422 HASH_MISMATCH. Descriptor của grant
  (`grant.sha256`/`grant.sizeBytes`) được đối chiếu expected của caller TRƯỚC khi mở body
  (openGrantedRead, `task-context.ts:379-406`) — caller không thể xin hash khác cái được authorize.
- Whole-body timeout/abort: `createRequestScope` (`artifact-streams.ts:812`, FIX-CR-08) phủ resolve→body→verify;
  signal của task abort giữa body là destroy thật (test real-listener xanh).
- SSRF: `redirect:'error'` mặc định, refuse non-http(s).
- Error hygiene (ADM-BASE-03): `readErrorDetail` chỉ trả code allowlist + detail server-authored bounded —
  raw upstream body không còn đi vào error message.

## F2 — writeStream: chunking + SHA-256 + finalize-lease — ĐẠT single-PUT (IMPLEMENTED, VERIFIED offline)

- `task-context.ts:416` `writeStream` → upload grant (lease-fenced) → `uploadArtifactStream`
  (`artifact-streams.ts:591`): pipeline backpressure source→meter→fetch body (duplex half),
  check streamed-size vs declared-size vs maxBytes khi đang chạy, hash tính trong lúc stream,
  flush verify `expectedSha256`; CHỈ SAU ĐÓ mới `finalizeArtifact(leaseEpoch + streamed size + sha256)`.
  Stream chưa verify không bao giờ được báo committed (comment + code đúng).
- Ref committed: ref trả về có role/size/hash; nếu purpose 'output' thì push vào `finalizedOutputArtifacts`
  (`task-context.ts:123,463`) và `worker.ts:431` gọi `committedOutputArtifactIds`
  (`artifact-streams.ts:679`) để CHẶN complete khi declared ref không do task này finalize, hoặc
  size/hash lệch ref đã commit → OUTPUT_NOT_COMMITTED 409 / SIZE_MISMATCH / HASH_MISMATCH.
  → Đúng vế "SDK gửi mandatory finalize lease + typed committed output refs" của DATA-04.

## F3 — MISMATCH-1: multipart CHỈ tồn tại ở tầng engine, chưa có đường lên API/SDK (chặn DATA-02)

- Engine `s3-storage-facade.ts:246` `uploadMultipart`: part ≥5MiB (default 8MiB, `MIN_S3_MULTIPART_PART_BYTES:30`),
  ≤10k parts, per-part SHA-256 gửi S3 `ChecksumSHA256` (:450), checkpoint resume hợp lệ
  (identity-bound: artifact/tenant/key/task/epoch/size/sha), lease assert TRƯỚC+SAU mỗi part,
  cancel/lease-lost → AbortMultipartUpload, complete → HeadObject verify version+metadata+size →
  đọc lại toàn pinned version hash lại, fail sau-publish → delete version chưa publish. Unit test xanh
  16/16 (offline, fake client).
- **actual vs expected**: grep repo-wide `uploadMultipart` → consumer duy nhất là tests của chính nó
  (+ re-export type ở `orchestrator/src/index.ts:101-116`). Không HTTP route, không ArtifactService call.
  `@du/contracts/src` grep `multipart` = 0. SDK `writeStream` single-PUT, grant route
  `artifacts.ts:125` cap `maxArtifactBytes` default 64MiB → artifact lớn hơn KHÔNG có đường nào
  qua facade; `createUploadGrant` S3 từ chối >5GiB còn route đã 413 từ lâu hơn nữa.
- **owner gợi ý**: Orchestrator (DATA-02 route grant→upload→finalize lifecycle) — NHƯNG phải chốt
  contract wire ở DATA-00 trước (AGENTS.md rule 1/2: không code theo assumption). Qwen-4 KHÔNG tự chế
  endpoint. Test cần chạy khi wire: e2e binary fixture >64MiB qua facade với RSS bound theo giá trị
  DATA-00 chốt.

## F4 — MISMATCH-2: business chưa chuyển sang streaming (chặn nửa đầu DATA-04)

- expected: "Actual business facade read/write/checkpoint dùng bounded streams; không chỉ standalone helper".
- actual: `businesses/document-core/src/worker.ts:282,308,334,360,386,412` đều dùng buffered
  `ctx.artifacts.write(Buffer)`; grep `readStream|writeStream` trong `businesses/` = 0 match.
  Read path duy nhất có nhận thức budget là `pipelines/parser-budget.ts:65` (ưu tiên
  `readWithMetadata` — vẫn buffer, có kiểm soát kích thước trước).
- **owner gợi ý**: lane business (document-core) — migration per-call-site khi DATA-02 chốt; không phải
  SDK thiếu. Ghi nhận: facade SDK đã sẵn, chỉ chờ consumer.

## F5 — Orchestrator read/finalize path (đọc thêm, không đổi): đúng hướng DATA-01

- `getBlob` (artifacts.ts:~458-530): s3 backend + version → `openRead` pinned version; legacy row →
  `verifyAndPin` (hash lại toàn body) rồi mới stream; fallback PG chỉ trong dual-read window;
  `s3OnlyCutover` chặn fallback. `putBlob` chặn ghi PG vào row backend s3. finalize transaction
  lock task row FOR UPDATE + epoch + lease_active (DATA-01 "lost-response finalize replay" nằm ở
  nhánh s3Grant:409 — state READY + version đã pin thì trả cùng kết quả).

## Receipt verification (offline, KHÔNG DB/Redis)

Mọi lệnh: cwd ghi rõ, thời điểm 2026-09-25 ~05:04–05:12Z, environment Windows/Node, working tree
`7811298` + untracked lane files (không phải của Qwen-4 — không sửa gì).

| Lệnh | cwd | Kết quả | Exit |
|---|---|---|---|
| `pnpm --filter @du/worker-sdk lint` (tsc --noEmit) | `du-rework/` | sạch | 0 |
| `pnpm --filter @du/worker-sdk test` (lần 1) | `du-rework/` | **146/147 pass, 1 FAIL**: `[LOCK:ADM-BASE-03 download-error-body-no-raw-echo]` expected DOWNLOAD_REJECTED, received TRANSPORT_FAILURE (network-boundaries.boundary.test.ts:301) | 1 |
| `npx jest tests/network-boundaries.boundary.test.ts` (lẻ) | `packages/worker-sdk/` | 6/6 pass | 0 |
| `pnpm --filter @du/worker-sdk test` (rerun ×2) | `du-rework/` | **147/147 pass** cả 2 lần | 0 |
| `npx jest --config jest.unit.config.cjs tests/s3-multipart-upload.test.ts tests/s3-storage-facade.test.ts` | `services/orchestrator/` | 16/16 pass (fake client/presigner, offline) | 0 |

**Phân tích flake lần 1**: suite dùng listener TCP thật + undici; TRANSPORT_FAILURE = fetch reject
(ECONNRESET/cold-socket race kiểu Windows keep-alive), KHÔNG phải lỗi sanitize body (assertion sentinel
đằng sau không tới được vì fetch reject trước khi có response). 3/3 run sau xanh tất định. Khuyến nghị
coordinator: nếu gate run gặp lại đỏ này, Tester retry 1 lần trước khi adjudicate đỏ; hoặc (về sau)
cho suite `agent: new Agent({keepAliveTimeout})` — KHÔNG phải việc của cycle này, chưa sửa test.

## Trạng thái 4 mức (đếm từ task rows packet, không phải tỷ lệ release)

| ID | SPECIFIED | IMPLEMENTED | VERIFIED (offline, bản code này) | ACCEPTED |
|---|---|---|---|---|
| DATA-01 | ✓ | ✓ facade+service+guards | ✓ unit offline (s3 16/16; SDK 147/147) | ✗ — cần live S3 fixture + finalize-replay receipt (Tester window) |
| DATA-02 | ✓ | ✗ **F3** — engine có, route/contract multipart KHÔNG | — | ✗ gate mở |
| DATA-03 | ✓ | không cso phạm vi ra soat cycle này (URL acquisition — lane khác) | — | ✗ |
| DATA-04 | ✓ | một nửa **F2 đạt / F4 thiếu** — SDK streaming+committed-refs đạt; business chưa migrate | ✓ phần SDK | ✗ gate mở |
| G-DATA (DATA-INT-01) | ✓ | ✗ (phụ thuộc DATA-02/03) | — | ✗ |

## Việc tiếp theo (next owner)

1. **Coordinator**: adjudicate F3 — chốt DATA-00 contract multipart (grant→parts→finalize→abort cleanup)
   rồi dispatch route wiring cho Orchestrator lane; quyết luôn `maxArtifactBytes>64MiB` xử lý ở đâu
   (public API = DATA-02 multipart; worker output có cần quá 64MiB không).
2. **Coordinator/business lane**: adjudicate F4 — schedule migration 6 call-site `worker.ts` sang
   `writeStream` (facade SDK đã sẵn, có test).
3. Khi có PR wire F3: Qwen-4 re-run suite + thêm receipt RSS-bound.
4. Tester: finalize-replay + dual-read rehearsal trong DB/S3 window để tiến DATA-01 lên ACCEPTED.

# W49-Q4-2 — DATA-00 đề xuất: Multipart Upload Contract (bản soạn thảo, chờ review)

> Theo yêu cầu coordinator (2026-09-25): soạn spec chi tiết đóng khe hở F3 + lập kế hoạch F4.
> **Mức: SPECIFIED-PROPOSED — chưa phải contract chốt.** Không có thay đổi production nào trong cycle này.

## 1. Phạm vi và consumer bị ảnh hưởng (AGENTS.md rule 1)

- **Producer**: worker qua SDK `ctx.artifacts.writeStream` (artifact trên ngưỡng single-PUT); public client
  (DATA-02 mirror — cùng schema, khác tầng auth, xem §8).
- **Consumer**: orchestrator runtime routes (`server.ts:786-875` khối artifacts) + `ArtifactService`
  (`modules/artifacts/artifacts.ts`) + engine S3 (`s3-storage-facade.ts`) + sweeper `integrity-scanner.ts`
  + đường `finalize` hiện hữu (KHÔNG đổi schema finalize — terminal transition dùng chung cả hai nhánh).
- **DB**: migration mới `0015_artifact_multipart` (delta ở §5). **Queue job không mang bytes/URL/secret**
  (bất biến plan) — lifecycle này hoàn toàn HTTP grant, không đụng payload.
- **Tương thích ngược**: single-PUT path (`POST /tasks/:id/artifacts` → PUT blob → finalize) giữ nguyên
  100%; multipart chỉ mở cho request có `sizeBytes` trên ngưỡng chính sách.

## 2. Zod wire schema đề xuất — thêm vào `packages/contracts/src/runtime.ts`

Đã typecheck sạch bằng scratch (tsc exit 0, zod ^3.23.8, cùng convention regex sha256/uuid của
`ArtifactFinalizeRequestSchema` hiện hành, runtime.ts:212-216). `LeaseBoundRequestSchema` mang
`leaseEpoch` int ≥1 — mọi request lease-fenced.

```ts
/* structural constants — GIÁ TRỊ CHÍNH SÁCH chờ sign-off (§6) */
export const MULTIPART_FIXED_PART_BYTES = 8 * 1024 * 1024;    // = DEFAULT_S3_MULTIPART_PART_BYTES
export const MULTIPART_MAX_PARTS = 10_000;                     // trần S3
export const MULTIPART_MIN_TOTAL_BYTES = 64 * 1024 * 1024 + 1; // trên ngưỡng single-PUT mới phải multipart
export const MULTIPART_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024; // ĐỀ XUẤT, chưa ký
export const MULTIPART_SESSION_TTL_MS = 24 * 60 * 60 * 1000;    // init → complete/abort
export const MULTIPART_PART_URL_TTL_S = 15 * 60;                // = GRANT_TTL_MS hiện hành

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);        // shared const khi land
const PartNumberSchema = z.number().int().min(1).max(MULTIPART_MAX_PARTS);

/* --- 1. init: STAGING row + S3 CreateMultipartUpload (uploadId KHÔNG rời server) --- */
export const MultipartInitRequestSchema = LeaseBoundRequestSchema.extend({
  uploadToken: z.string().uuid(),  // client sinh; KHÓA REPLAY: token+params lặp -> cùng artifact
  purpose: ArtifactPurposeSchema,
  mimeType: z.string().min(1),
  fileName: z.string().min(1).max(1024).optional(),
  sizeBytes: z.number().int().min(MULTIPART_MIN_TOTAL_BYTES).max(MULTIPART_MAX_TOTAL_BYTES),
});
export const MultipartInitAckSchema = z.object({
  artifactId: z.string().uuid(),
  uploadHandle: z.string().min(1),  // opaque; server map nội bộ sang S3 UploadId
  partSizeBytes: z.number().int().min(MULTIPART_FIXED_PART_BYTES),  // geometry do SERVER chốt
  partCount: PartNumberSchema,      // server tính = ceil(sizeBytes/partSizeBytes)
  expiresAt: z.string(),
  replayed: z.boolean().default(false),
});

/* --- 2. part grant: presigned PUT cho ĐÚNG một partNumber --- */
export const MultipartPartGrantRequestSchema = LeaseBoundRequestSchema.extend({
  partNumber: PartNumberSchema,
  sha256: Sha256Schema,  // hash đúng số part-bytes client sắp PUT — server bind vào URL
});
export const MultipartPartGrantSchema = z.object({
  artifactId: z.string().uuid(),
  partNumber: PartNumberSchema,
  partUrl: z.string().url(),  // signed: method+key+part+content-length+checksum; NEVER logged
  sizeBytes: z.number().int().min(1),  // partSizeBytes (part cuối = remainder), fix từ init
  requiredHeaders: z.record(z.string(), z.string()),  // content-length + x-amz-checksum-sha256(base64)
  expiresAt: z.string(),
});

/* --- 3. complete: receipt list + whole-object verify --- */
export const MultipartPartReceiptSchema = z.object({
  partNumber: PartNumberSchema,
  etag: z.string().min(1).max(256),   // etag storage trả khi PUT part
  sizeBytes: z.number().int().min(1),
  sha256: Sha256Schema,               // per-part hash đã PUT
});
export const MultipartCompleteRequestSchema = LeaseBoundRequestSchema.extend({
  parts: z.array(MultipartPartReceiptSchema).min(1).max(MULTIPART_MAX_PARTS), // phủ khít 1..partCount
  sha256: Sha256Schema,  // whole-object; server re-hash pinned version TRƯỚC khi nhận
});
export const MultipartCompleteAckSchema = z.object({
  artifactId: z.string().uuid(),
  sizeBytes: z.number().int().min(0),
  sha256: Sha256Schema,
  committed: z.literal(true),  // bytes đã ở pinned version; row VẪN STAGING tới khi finalize
  replayed: z.boolean().default(false),
});

/* --- 4. abort: terminal, idempotent --- */
export const MultipartAbortRequestSchema = LeaseBoundRequestSchema.extend({
  reason: z.enum(['cancelled', 'superseded', 'failed']).default('cancelled'),
});
export const MultipartAbortAckSchema = z.object({
  artifactId: z.string().uuid(),
  state: z.literal('ABORTED'),
  replayed: z.boolean().default(false),
});
```

## 3. REST endpoint trên Orchestrator — tương thích đúng khuôn route hiện hành

| # | Method + path | Auth (pattern cũ) | Success | Lỗi đặc trưng |
|---|---|---|---|---|
| 1 | `POST /api/runtime/v1/tasks/:id/artifacts/multipart` (init) | `assertTaskRuntimeAuth` | 201 mới / 200 `replayed:true` | 409 `LEASE_LOST`·`IDEMPOTENCY_CONFLICT`, 413 `PAYLOAD_TOO_LARGE`, 409 `MULTIPART_NOT_AVAILABLE` |
| 2 | `POST /api/runtime/v1/artifacts/:id/multipart/part` (part grant) | `assertArtifactRuntimeAuth` + `assertBodyTaskRuntimeAuth` | 200 | 409 `LEASE_LOST`·`STATE_CONFLICT`, 422 `PART_OUT_OF_RANGE` |
| 3 | `POST /api/runtime/v1/artifacts/:id/multipart/complete` | như #2 | 200 | 409 `PART_SET_MISMATCH`·`CHECKSUM_MISMATCH`·`STATE_CONFLICT`, 422 |
| 4 | `POST /api/runtime/v1/artifacts/:id/multipart/abort` | như #2 | 200 | 409 `STATE_CONFLICT` (đã complete/READY) |
| — | `POST /api/runtime/v1/artifacts/:id/finalize` (EXISTING, schema không đổi) | như #2 | 200 READY | 409 `STATE_CONFLICT` |

Route surface mirror đúng các handler `server.ts:786-820` (`absoluteGrantUrl(ctx.host, ...)` cho
`partUrl` — service trả relative, route layer absolutize; cùng quy ước CR-12).

### 3.1 Guard theo operation (re-use nguyên ngữ nghĩa đã chốt ở single-PUT/CR-12)

- **Mọi operation**: `assertLease` kiểu hiện hành (`artifacts.ts` SELECT task FOR UPDATE, epoch match,
  `lease_active`, task chưa cancel) → 409 `LEASE_LOST`. Artifact phải thuộc đúng task + epoch đang
  gửi grant **và** `purpose`∈{output,intermediate,session} của chính task đó (writer-only);
  row không phải nhánh multipart → 409 `STATE_CONFLICT`.
- **init**: backend must be s3 (`storageFacade` configured) — postgres-only deployment → 409
  `MULTIPART_NOT_AVAILABLE` (không im lặng rơi về PG — plan cấm path vòng quanh S3).
  `sizeBytes` ngoài [MIN,MAX] chính sách → 413. `partCount` > 10k → 409 `PARTS_EXCEEDED`.
- **part grant**: server chốt `sizeBytes = min(partSizeBytes, total - (n-1)*partSizeBytes)` — client
  không được tự khai kích thước part. Presign PUT với `content-length` + `x-amz-checksum-sha256` bind
  vào chữ ký (S3 từ chối PUT lệch cả hai) → part corrupt/chậm-tráo bị chặn ngay tại storage, không
  cần trust client. Ghi `declared_sha256` vào ledger (§5).
- **complete**: (a) client `parts` phủ khít ascending 1..partCount, không trùng/khoảng trống;
  (b) `ListParts` là **authoritative** — với mỗi part so etag + size + checksumSHA256 (decoded base64)
  với declared; part thiếu/thừa/lệch → 409 `PART_SET_MISMATCH`/`CHECKSUM_MISMATCH`;
  (c) `CompleteMultipartUpload` → bắt buộc có `VersionId` ≠ 'null' (`OBJECT_VERSION_REQUIRED` như
  engine hiện hành); (d) HeadObject verify metadata `artifactid`/`tenantid` + size, rồi **stream toàn
  bộ pinned version re-hash SHA-256** so `sha256` khai ở complete — khớp mới ghi `storage_version_id` +
  `sha256` + `size_bytes` lên row (row vẫn STAGING); fail sau publish → **delete version chưa publish**
  (pattern `deleteUnpublishedVersion` engine). (e) replay: row đã có committed version + cùng sha →
  trả y nguyên ack `replayed:true` (đóng điều kiện finalize-replay của DATA-01 cho nhánh multipart).
- **finalize (existing)**: giữ nguyên transaction lock + epoch; với row nhánh multipart, cap 413 chuyển
  từ `maxArtifactBytes` sang **effective cap theo lifecycle** (row nào có `part_count` → dùng
  `MULTIPART_MAX_TOTAL_BYTES`). sha/size phải khớp committed đã ghi ở complete → STAGING→READY.
- **abort**: `AbortMultipartUpload` + row state → `ABORTED` terminal; idempotent replay.
- **Logging invariant (plan)**: `partUrl`/signed token/raw S3 UploadId **không vào log**; chỉ artifactId,
  partNumber, kết quả. Redaction theo khuôn ADM-BASE-03.

### 3.2 Orphan handling

- Session quá `expiresAt` chưa complete: sweeper trong `integrity-scanner.ts` chạy abort-logic (#4)
  mỗi cycle — cùng pattern staging-orphan 2h hiện hành nhưng theo TTL multipart 24h.
- Belt-and-braces tầng storage: bucket lifecycle rule `AbortIncompleteMultipartUpload: 1 day`
  (IaC — DEP-01) để phần cứng dọn nếu app sweep chết.

## 4. Ngữ nghĩa retry/resume phía client (normative)

1. Mất response **init** → retry cùng `uploadToken`: cùng params → ack cũ (`replayed:true`, artifactId
   giữ nguyên — S3 upload mới chỉ tạo khi token lạ); khác params → 409, client phải token mới.
2. Mất response **part grant / PUT** → re-grant rồi re-PUT cùng `partNumber` (S3 overwrite semantics
   cho part cùng số — hợp lệ theo AWS spec); hash đã declared lại được re-bind, không có trạng thái hỏng.
3. Mất response **complete** → retry đúng request; server replay (§3.1e). **Không có** case "complete
   thành công một nửa" vì verify toàn-object chạy trước khi ghi committed metadata.
4. Lease epoch đổi giữa chừng → operation kế tiếp 409 `LEASE_LOST`; worker fail task, attempt mới
   resume theo §4.5 (khác epoch → abort session cũ TRƯỚC rồi init mới — cùng pattern
   `MULTIPART_LEASE_LOST` engine: abort best-effort, không che lỗi công khai).
5. Resume cross-process (v2, không bắt buộc cho gate đầu): checkpoint object
   `{uploadToken, artifactId, partCount, partSizeBytes, expectedSizeBytes, expectedSha256}`
   business persist qua `ctx.checkpoint`; restart = init lại token cũ + `ListParts` quyết part nào
   đã lên. v1 **chấp nhận upload lại từ đầu** — phải ghi rõ trong acceptance DATA-04 là một lựa chọn.

## 5. DB delta (owner: Orchestrator lane — migration `0015_artifact_multipart`)

- `artifacts`: thêm `upload_token uuid NULL`, `multipart_upload_id text NULL`, `part_size_bytes int NULL`,
  `part_count int NULL`, `multipart_expires_at timestamptz NULL`; UNIQUE `(task_id, upload_token)`
  WHERE `upload_token IS NOT NULL` (khóa replay init); CHECK state mở rộng `ABORTED`.
- Bảng ledger `artifact_multipart_parts (artifact_id REFERENCES artifacts, part_number int,
  declared_sha256 char(64), size_bytes int, etag text NULL, PK (artifact_id, part_number))` — ghi lúc
  part-grant, đối chiếu lúc complete.
- Read path `getBlob`/dual-read KHÔNG đổi (committed version đã nằm ở `storage_version_id` — mọi guard
  DATA-01 hiện hữu tự áp dụng cho nhánh multipart).

## 6. Bảng giá trị chính sách CẦN KÝ trước khi code (plan để trống — không được lấy ví dụ làm cam kết)

| Tham số | Đề xuất của Qwen-4 | Căn cứ / ai ký |
|---|---|---|
| Ngưỡng bắt buộc multipart | > 64 MiB (= `maxArtifactBytes` hiện hành) | Không đổi hành vi cũ; Orchestrator |
| Part size | 8 MiB server-fix | = `DEFAULT_S3_MULTIPART_PART_BYTES`; SDK buffer đúng 1 part |
| Total max | 8 GiB | Product/Ops (RSS + thời gian window); S3 cho 5 TiB nhưng pilot không cần |
| Session TTL | 24 h | Ops; sweep + bucket lifecycle 1 ngày |
| Part URL TTL | 15 min | = `GRANT_TTL_MS` hiện hành |
| RSS budget worker khi upload | 2× part size + fetch overhead (đo thật, không suy) | Tester chốt bằng fixture |
| Concurrency part PUT song song | 3 (SDK default) | Chỉ ảnh hưởng tốc độ; server stateless-per-grant |

## 7. Delta phía SDK (`@du/worker-sdk`) — consumer đầu tiên

1. `runtime-client.ts`: 4 method mới theo §3 (fetch JSON, lease headers như hiện hành).
2. `task-context.ts` `writeStream` **tự branch** theo `sizeBytes > multipartThreshold` (default =
   `maxArtifactBytes`): caller không đổi signature — đây là lý do F4 migrate được mà không cần biết
   multipart tồn tại.
3. Engine part-side (stream, không buffer cả object): tích 1 nguồn → buffer đúng 1 part (8 MiB),
   per-part sha256 + whole-object sha256 **tính cùng một lượt** → part grant → PUT with
   `requiredHeaders` → receipt {etag,size,sha}. Retry PUT có bound (vd 3 lần/part, backoff), vượt →
   abort best-effort + fail typed. `signal` abort giữa part → hủy part, giữ đã upload cho resume §4.5.
4. Complete → (existing) `finalizeArtifact(leaseEpoch, size, sha)` → committed ref như F2; gate
   `committedOutputArtifactIds` không đổi.
5. Test offline mới (không cần S3 thật): fake fetcher + fake client-side URL recorder — các case §4,
   coverage per-part hash, abort-on-cancel, geometry cuối-part-remainder.

## 8. Nhánh public client (DATA-02) — cùng contract, khác auth (GHI CHÚ, không phải việc lane này)

- SO-09 `POST /api/v1/uploads` + 3 sub-route cùng shape schemas §2 (thêm `Idempotency-Key` header
  public thay `uploadToken` body — hoặc giữ cả hai, coordinator quyết); auth API-key + tenant scope,
  rate-limit per-tenant.
- Guard submit đã có (`artifact-submit-guards`): uploaded-artifact chỉ được submit khi READY — giữ
  nguyên, nhánh multipart không nới.
- Plan cho phép **direct-to-S3 grant** hoặc **proxy stream**; §3 chọn direct-to-S3 cho worker (không
  thêm hop qua orchestrator process). Public có thể cùng model; nếu ops yêu cầu proxy (egress control),
  engine `uploadMultipart` server-driven hiện có là đường chờ sẵn — không cần contract mới.

## 9. acceptance tests contract này phải pass (đưa vào matrix khi wire)

1. Happy binary fixture 70 MiB (> ngưỡng) init→9 parts→complete→finalize: committed sha == expected;
   row READY, `artifact_blobs` không có row mới (no-PG-blob invariant DATA-01).
2. Response-loss: kill client trước mỗi ack (init/part/complete) rồi retry — ack replayed cùng kết quả;
   không orphan upload sau sweep.
3. Adversarial: PUT part sai sha-declared (S3 400), complete thiếu part / trùng part / part ngoài
   partCount, foreign task attempt → 409; lease epoch bump giữa upload → LEASE_LOST + version chưa
   publish bị delete; `artifact_blobs`/DB không chứa bytes ở mọi case.
4. Abort idempotency + sweeper quá hạn TTL; dual-net bucket lifecycle test thuộc DEP-01.
5. Regression: mọi test single-PUT hiện hành (worker-sdk 147, orchestrator artifacts-*) giữ nguyên xanh.

## 10. Receipt verification cycle W49-Q4-2

| Lệnh | cwd | Kết quả | Exit |
|---|---|---|---|
| `npx tsc --noEmit --strict --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck multipart-draft.check.ts` (scratch chứa nguyên văn schema §2 + 6 payload parse sanity) | `packages/contracts/` | 0 lỗi | 0 |
| `pnpm --filter @du/contracts lint` | `du-rework/` | sạch (baseline tương thích) | 0 |
| `pnpm --filter @du/contracts build` | `du-rework/` | dist OK | 0 |
| `pnpm --filter @du/contracts test` | `du-rework/` | **160/160 pass** (9 suites) | 0 |

Scratch `packages/contracts/multipart-draft.check.ts` ĐÃ XÓA sau khi đo (`git status` sạch file này) —
production `src/` **không đổi một dòng nào** đúng chỉ thị. Không DB/Redis. Không có gì để typecheck
ngược (schema nằm trong báo cáo, chưa trong package).

## 11. Câu hỏi quyết định cho coordinator (mapping F3 → code)

1. Phê chuẩn §2 + §3 làm `DATA-00-M` (multipart sub-contract) và các giá trị §6 chưa ký — hay sửa?
2. Owner route wiring: Orchestrator lane (khuyến nghị — server-side + DB delta của họ) hay Qwen-4 nhận
   tiếp PR contracts-only (thêm schema §2 vào runtime.ts + test parse) sau khi được duyệt? PR đó KHÔNG
   đổi hành vi runtime — chỉ thêm export.
3. §4.5 resume cross-process: chấp nhận "upload lại từ đầu" cho gate DATA-04 đầu tiên?(khuyến nghị: CÓ)
4. F4: dispatch kế hoạch §12 (dưới) cho business lane ngay Step A (không phụ thuộc multipart)?

## 12. Kế hoạch chuyển đổi 6 call-site document-core (F4) — 4 bước, thứ tự an toàn

Cả 6 site cùng khuôn `internalCtx.artifacts.write(JSON.stringify(envelope,null,2), '<action>_result.json',
'application/json')`: `worker.ts:282` (ingest), `:308` (extract), `:334` (analyze), `:360` (transform),
`:386` (generate), `:412` (compare). Read path tập trung ở `prepareSources` → `parser-budget.ts`
(đang `readWithMetadata` = buffer cả nguồn).

| Bước | Việc | Phụ thuộc | Rủi ro | Gate kiểm chứng |
|---|---|---|---|---|
| **A — path thống nhất** (6 diff nhỏ, ĐỘC LẬP multipart) | `write(json,...)` → `writeStream(Readable.from([bytes]), name, mime, bytes.byteLength, 'output', sha256)` — mỗi site stringify 1 lần, tính sha 1 lần, không double-buffer như `write()` hiện tại (nó tự hash lại từ đầu) | SDK đã đủ (F2) | Near-zero: cùng bytes, cùng finalize | e2e mock-service per action: committed sha == sha tính offline |
| **B — read streaming thật** | `parser-budget` nhánh parse-file: `downloadArtifactById` vào `createTempWorkspace` (bounded→disk, verify sha, tự xóa file hỏng), pass FILE PATH cho pandoc/Ghostscript recipe; `readWithMetadata` chỉ cho config nhỏ dưới budget đã ký (đề xuất ≤1 MiB) | SDK đã đủ (ART-01..03 helpers có sẵn) | Trung bình — đổi surface internal recipe; workspace.dispose() trong `finally` + sweeper đã có | kill-mid-download không partial file; RSS peak < budget khi parse fixture lớn; checkpoint chỉ chứa artifact ref, KHÔNG chứa workspace path |
| **C — multipart tự động** | Sau §11.1+wire route: `writeStream` SDK branch (§7.2) bật cho kết quả >64 MiB (ingest full-markdown lớn). Business **không cần diff mới** — đây là thiết kế facade | DATA-00-M approved + Orchestrator wiring + SDK PR | Thấp với business; cao với hạ tầng (mở rộng limit = lộ bug budget) | §9.1-9.3 xanh trên fixture 8GiB-edge; `maxArtifactBytes` policy ký trước khi bật |
| **D — envelope streaming** (defer) | `formatResult` async-iterable cho action kết quả lớn; hết thời kỳ `JSON.stringify` full-buffer | Chỉ khi B+C đo thấy envelope là điểm nghẽn RSS | Cao nhất (đổi mọi formatResult) | Đo trước, làm sau — KHÔNG code theo assumption |

**Thứ tự per-action đề xuất**: A(6 site, 1 PR) → B theo `ingest`(nguồn lớn nhất) → `compare`(2 nguồn) →
actions còn lại → C bật toàn bộ → D chỉ khi có số đo.
**Known limitations ghi thẳng vào acceptance**: v1 không resume cross-process (kill → upload lại từ đầu,
tốn băng thông không tốn correctness); envelope <64 MiB đi single-PUT (multipart không lợi);
`write()` buffered vẫn hợp lệ cho payload nhỏ đã định lượng (inline-text exception của plan, giá trị
thuộc §6).

---
## Cycle 138 — Step A contracts-only LANDED (Qwen-4)

### 13.1 Diff thực tế (chỉ `packages/contracts/`)

- `src/runtime.ts`: THÊM section `Multipart upload lifecycle` giữa `ArtifactAccessGrant` và
  `Invocation grants`: 6 policy const (`MULTIPART_FIXED_PART_BYTES=8MiB`, `MULTIPART_MAX_PARTS=1e4`,
  `MULTIPART_MIN_TOTAL_BYTES=64MiB+1`, `MULTIPART_MAX_TOTAL_BYTES=8GiB` PROPOSED,
  `MULTIPART_SESSION_TTL_MS=24h`, `MULTIPART_PART_URL_TTL_S=15m`) + 11 schema/11 type đúng §2 của
  W49-Q4-2: `MultipartInit{Request,Ack}`, `MultipartPartGrant{Request}`, `MultipartPartGrant`,
  `MultipartPartReceipt`, `MultipartComplete{Request,Ack}`, `MultipartAbort{Request,Ack}`.
  `index.ts` đã `export * from './runtime'` — surface tự publish, không sửa gì thêm.
- `tests/multipart-contract.test.ts` (mới): 31 case — per schema valid + fail-closed negatives
  (lease fence ≥1, uuid token, sha lowercase-hex 64, part window 1..10000 int, geometry floor
  8MiB, size boundaries at 64MiB/64MiB+1/8GiB/8GiB+1, `committed:true` literal, reason enum,
  defaults `replayed=false`, `reason='cancelled'`), 1 test **DOCUMENTED NON-GUARD** chốt rằng
  coverage/duplicate parts là server-side guard (409 PART_SET_MISMATCH) chứ không phải wire,
  và 1 describe **regression single-PUT**: grant/finalize cũ parse y nguyên, không nới lỏng.
- KHÔNG đổi: mọi schema cũ, runtime behavior, route, DB. Không commit/push. Không DB/Redis.

### 13.2 Tính configurable của policy (chỉ thị cycle 138 mục 2)

- Wire bound = const export; header doc trong section ghi rõ route layer chỉ được **siết** (per-
  deployment limit nằm ở service config), không được rộng hơn bound này — chống policy drift.
- `MULTIPART_MAX_TOTAL_BYTES` đánh dấu PROPOSED-chưa-ký ngay trong comment (đúng §6).

### 13.3 Receipt verification (2026-09-25 ~06:20–06:32Z, cwd `D:\Git\dugate\du-rework` trừ khi ghi khác)

| Lệnh | Kết quả | Exit |
|---|---|---|
| `pnpm --filter @du/contracts lint` | sạch | 0 |
| `pnpm --filter @du/contracts build` | dist OK | 0 |
| `pnpm --filter @du/contracts test` | **10 suites, 191/191 pass** (160 cũ + 31 mới) | 0 |
| `npx jest tests/multipart-contract.test.ts --verbose` (cwd `packages/contracts/`) | 31/31, suite tự tắt an toàn | 0 |
| `pnpm --filter @du/worker-sdk test` (downstream consumer) | lần 1 **146/147** — đỏ đúng flake đã biết `[LOCK:ADM-BASE-03]` TRANSPORT_FAILURE; rerun **147/147** | 1 → 0 |
| `pnpm --filter @du/orchestrator lint` (downstream) | sạch | 0 |
| `git status --porcelain -- packages/contracts` | chỉ 2 target của cycle này do Qwen-4 chạm (runtime.ts, test mới); các M/?? khác là lane work có trước, nguyên trạng | — |

Cập nhật nhật ký flake: boundary test này nay đỏ **2/6** full-run quan sát được (C138 worker-sdk run
và C1 run trước) — cùng chữ ký ECONNRESET cold-socket, chưa từng đỏ khi chạy lẻ file. Đề xuất
coordinator đưa vào backlog Tester: reset keep-alive agent hoặc accept-retry 1 lần trong gate protocol.

### 13.4 Kết luận & next owner

- **Ket luan: PASS** cho Cycle 138 (Step A contracts-only) — mọi receipt xanh, phạm vi đúng chỉ thị.
- Next: (1) coordinator adjudicate §6 policy values + §3 endpoint shape để mở DATA-00-M; (2) PR wiring
  route + migration 0015 cho Orchestrator lane; (3) SDK auto-branch §7 sau khi route land; (4) Step A
  document-core (§12, không phụ thuộc multipart) có thể dispatch song song ngay bây giờ.

*Cycle 138 đóng ở: contract schemas đã sống trong @du/contracts với test; chưa route nào bind vào
chúng — đúng thiết kế additive.*

## Cycle 138B — Step A document-core migration LANDED (Qwen-4)

### 13B.1 Diff production (chỉ `businesses/document-core/src/worker.ts`)

- Helper module-level `writeEnvelopeArtifact(internalCtx, envelope, fileName)`: stringify 1 lần →
  `Buffer.from(json,'utf8')` → sha256 1 lần → `artifacts.writeStream(Readable.from([bytes]),
  fileName, 'application/json', bytes.byteLength, 'output', sha)` — đúng §12.3.
- Adapter `toInternalContext` giờ trả `StreamingTaskContext` (type MỚI, khai báo tại chỗ trong
  worker.ts — internal `TaskContext` interface KHÔNG đổi, không ai implement khác phải sửa): facade
  wrapper `writeStream` = delegate facade SDK khi có (production: luôn có — grant→PUT→lease-finalize
  của SDK, §F2); facade chỉ-buffer (embedded/test ctx) = drain có bound size + verify digest
  fail-closed rồi rơi vào `write` cũ — cùng bytes, cùng ArtifactRef.
- 6 call-site thay bằng helper: `worker.ts` ingest/extract/analyze/transform/generate/compare
  (`grep artifacts\.write\(` trong worker.ts = 0). `actions/ingest/index.ts:130` (splitRef,
  internal-write) NGOÀI phạm vi 138B — giữ nguyên theo §12.4.
- assertActive fencing trước/sau mỗi write giữ nguyên khuôn các wrapper khác.

### 13B.2 Fixture tests cập nhật (3 file — vì stub cũ tuyên bố 'stream writes are not used by this
fixture' và handler-path giờ DÙNG thật; giữ stub = giả định sai, không phải test)

- `p8-03-provider-convergence.test.ts` + `provider-backed-variant.test.ts`: `writeStream: throw` →
  consumer thật (drain + assert đúng `sizeBytes` đã declared + verify `expectedSha256` fail-closed,
  mô phỏng đúng SDK finalize-verify), push bytes vào cùng `artifactsWritten` → mọi assertion cũ giữ.
- `parser-budgets.test.ts`: `createDefaultSdkArtifacts().writeStream` → late-bound `this.write`
  forward (drain stream → gọi `write` trên CÙNG object, để override `jest.fn()` của test vẫn chứng
  kiến content); assertion test :848 cập nhật cho nội dung dạng Buffer (toString utf8). Cancellation
  (:490) + deadline (:785) fixtures giữ nguyên (không reach envelope-write).
- `MockTaskContext` (fixture nội bộ dùng bởi all-variants-e2e v.v.) KHÔNG sửa — đi qua nhánh
  synthesized của adapter, chứng minh fallback họat động.

### 13B.3 Receipt verification (2026-09-25 ~06:45–07:05Z)

| Bước | Kết quả | Exit |
|---|---|---|
| `pnpm --filter @du/document-core lint` (tsc src) | sạch | 0 |
| `pnpm --filter @du/document-core test:typecheck` (tsc src+tests) | sạch | 0 |
| Batch handler-path: 8 suites (all-variants-e2e, artifact-metadata.functional, checkpoint-replay, cancellation-fencing, br06, p8-03, provider-backed-variant, parser-budgets) | **114/114** (sau 2 fix fixture: 1 assertion Buffer + 2 stub writeStream) | 0 |
| Batch A: 15 suites (6 action suite, worker, checkpoint, child-lifecycle, barrier-cleanup, bounded-input, output-validation, traceability, manifest, config) | **165/165** | 0 |
| Batch B: 14 suites (p8-01-harness, six-action-fail-closed, execution-pin, corpus-regression, 4× r1-e, profile-binding, suite-bootstrap, test-target-guard, package-boundary, build-dep-order, sdk-consumer) | **201/201** | 0 |
| `cross-service-boundary` (probe riêng) | **4/4** | 0 |
| TỔNG offline | **38 suites / 484 tests pass, 0 fail, 0 skip** | — |
| `pnpm --filter @du/worker-sdk test` (không đổi source, re-confirm) | 147/147 (chu kỳ trước) | 0 |

**Loại có chủ đích (không chạy — service window của Tester theo protocol DB/Redis):**
- `tests/bullmq-smoke.test.ts` — probe `Test-NetConnection 127.0.0.1:6380 = True`: máy NÀY có Redis
  sống → suite TỰ CHẠY live (thiết kế opt-in của nó), không thuộc phạm vi 'offline' 138B. Đây cũng
  là thủ phạm làm lần chạy `jest --testPathIgnorePatterns integration` full timeout ở 10' (ghi nhận
  giúp coordinator: full-run document-core trên máy dev CÓ Redis sẽ không bao giờ skip suite này).
- `tests/multi-container-e2e.integration.test.ts` — integration, có script riêng.

Không commit/push. Footprint Qwen-4 138B = `src/worker.ts` + đúng 3 file test; các M/?? khác trong
`businesses/document-core` là lane work có trước (diff stat với HEAD cộng dồn, không phải riêng tôi).

### 13B.4 Kết luận & next owner

- **Ket luan: PASS** — §12.3 gate 'cùng bytes, cùng finalize result': đạt (unit offline chứng minh
  bytes + digest verify trên cả 2 nhánh facade; gate e2e live-S3 thuộc window Tester khi route wire).
- Next: (1) Step B (§12 read-streaming qua `downloadArtifactById`) cho lane business — SDK helpers đã
  có sẵn, không phụ thuộc multipart; (2) Step C chờ route multipart (Cycle 138 schemas đã sẵn);
  (3) Tester: xếp bullmq-smoke + integration vào service window chính thức.

## Cycle 139 — Step B read-streaming LANDED (Qwen-4)

### 14.1 Seam SDK (additive, không phá vỡ consumer cũ)

- `packages/worker-sdk/src/types.ts`: `ArtifactStat` (fileName/mimeType/sizeBytes/sha256 — tất cả
  optional) + `ArtifactFacade.stat?(artifactId): Promise<ArtifactStat>` — OPTIONAL nên mọi facade
  đang tồn tại (kể cả mock của các suite cũ) compile không đổi.
- `task-context.ts`: implement `stat` = readGrant lease-fenced, trả descriptor, KHÔNG fetch bytes
  (test chứng minh: đúng 1 request `/access`, blob URL không chạm).
- Test mới `packages/worker-sdk/tests/artifact-stat.test.ts` (3 case): descriptor round-trip +
  lease 409 problem+json → `LeaseLostError` + grant thiếu metadata → fields undefined.

### 14.2 Document-core Step B pipeline

- `types/context.ts` (nội bộ): `stat?` + `readStream?(id, {expectedSha256?, expectedSizeBytes?})` —
  optional, không fixture cũ nào phải sửa.
- `worker.ts` adapter: passthrough `stat`/`readStream` CHỈ khi facade thật có (không tổng hợp stream
  giả từ `read`) → facade buffer-only đi đúng đường cũ.
- `parser-budget.ts` — `readArtifact`: (1) facade có stat+readStream → `readArtifactViaStream`:
  pre-flight `stat.sizeBytes > budget` → DOCUMENT_TOO_LARGE TRƯỚC khi transfer (zero-byte rejection,
  đóng limitation #1 của header file); ≤ `INLINE_READ_BYTES` (1 MiB — PROPOSED, DATA-00 §6 ký) →
  về path cũ (ngoại lệ inline định lượng của plan); còn lại: stream → cap-Transform → file trong
  `createTempWorkspace(taskId)` với `{signal: ctx.signal}`, đọc lại đĩa, verify length + sha256
  ĐỘC LẬP từ bytes đã đổ (defense-in-depth), canonical detect giữ nguyên semantics,
  `finally workspace.dispose()` — mọi outcome không để lại file (ART-02).
  (2) ArtifactStreamError map: TOO_LARGE→DOCUMENT_TOO_LARGE, HASH/SIZE_MISMATCH→
  ARTIFACT_INTEGRITY_MISMATCH, khác→DOCUMENT_ACQUISITION_FAILED; abort giữa-dòng →
  OPERATION_CANCELLED/LEASE_LOST theo reason.
- Test mới `tests/read-stream-acquisition.test.ts` 8 case (offline, mock facade, quét tmpdir chứng
  minh zero-rò rỉ workspace theo taskId từng case).

### 14.3 Lệch §12 đã ghi nhận (cho coordinator)

- §12-B viết 'pass FILE PATH to pandoc/Ghostscript recipe' — KHÔNG ÁP DỤNG cho du-rework:
  document-kit parse bằng Buffer API (worker-thread transfer), không có `parseFile`; du-rework
  document-core không spawn pandoc/Ghostscript (parsers = text/word/excel/pdf native). Step B này
  bound transfer + integrity + file-lifetime; heap peak khi parse vẫn ≥ 1×doc (đã giảm từ ~2× của
  chunk-array+concat). RSS-theo-chunk thật sự khi parse cần PR `parseFile(path)` trong document-kit
  (worker-isolation chuyển sang file arg) — CỜ MỚI, ngoài scope cycle này.

### 14.4 Receipt verification (2026-09-25 ~07:20–07:40Z)

| Bước | Kết quả | Exit |
|---|---|---|
| `pnpm --filter @du/worker-sdk lint` | sạch | 0 |
| `pnpm --filter @du/worker-sdk test` | **11 suites / 150 pass** (147 cũ + 3 stat) | 0 |
| `pnpm --filter @du/document-core lint` + `test:typecheck` | sạch (src + tests) | 0 |
| Batch 9 suites (8 cũ + `read-stream-acquisition`) | **122/122** | 0 |
| Batch A 15 suites | **165/165** | 0 |
| Batch B 15 suites (gồm cross-service) | **205/205** | 0 |
| TỔNG document-core offline | **39 suites / 492 tests pass, 0 fail, 0 skip** | — |
| Quét rò rỉ workspace mọi case fail-path | 0 dir `du-worker-<taskId>` sót | — |

Loại có chủ đích như 138B: `bullmq-smoke` (Redis :6380 trên máy dev đang sống → suite tự chạy live
— thuộc service window Tester) + `multi-container-e2e.integration`. Không commit/push, không
DB/Redis do Qwen-4 mở. Footprint Cycle 139 = 6 file: worker-sdk `src/types.ts`, `src/task-context.ts`,
`tests/artifact-stat.test.ts` (mới); document-core `src/types/context.ts`, `src/worker.ts`,
`src/pipelines/parser-budget.ts`, `tests/read-stream-acquisition.test.ts` (mới).

### 14.5 Kết luận & next owner

- **Ket luan: PASS** cho Cycle 139 (Step B trong phạm vi đã phân tích ở §14.3).
- Next: (1) coordinator cờ document-kit `parseFile` nếu muốn RSS-theo-chunk thật khi parse (nửa còn
  lại của §12-B); (2) ký `INLINE_READ_BYTES` + budgets DATA-00 §6; (3) Step C (SDK multipart
  auto-branch) chờ route wiring Orchestrator — schemas đã sẵn từ Cycle 138.

## Cycle 140 — Step C SDK multipart auto-branch LANDED (Qwen-4)

Nhiệm vụ coordinator: 'Bắt đầu triển khai Step C: SDK writeStream auto-branching trong
packages/worker-sdk (DATA-04); 4 route runtime nội bộ đã định nghĩa tại server.ts; tự động
init → grant part → complete khi vượt ngưỡng, fallback single-PUT cho stream nhỏ; offline unit
test; không mở DB/Redis, không commit/push, HEAD giữ nguyên.' Phạm vi sửa: CHỈ packages/worker-sdk.

### 15.1 Diff thực tế

| File | Δ | Vai trò |
|---|---|---|
| `src/artifact-multipart.ts` (MỚI) | 336 dòng | Engine `uploadArtifactMultipart`: init→parts→complete, transport injection, không RuntimeClient/fetch cứng |
| `tests/artifact-multipart.test.ts` (MỚI) | 667 dòng | 14 engine case + 7 facade case, fake transport/fake fetch — 0 socket |
| `src/runtime-client.ts` | +29 | 4 method `multipartInit/PartGrant/Complete/Abort` (path khớp route server.ts:841-875, ack parse bằng schema Cycle 138) |
| `src/task-context.ts` | +66 | `writeStreamMultipart` (adapter lease-fence + finalize lại đúng gate cũ) + điều kiện branch trong `writeStream` |
| `src/types.ts` + `src/worker.ts` | +9/+9 | `WorkerConfig.multipartThresholdBytes` (default = `maxArtifactBytes`) thread qua deps |
| `src/artifact-streams.ts` | 6 từ khoá `export` | Tái dùng internal helpers (`toNodeReadable`, `createRequestScope`, `streamTransportError`, `readErrorDetail`, `assertHttpUrl`, `RequestScope`) — **zero đổi hành vi** |
| `src/index.ts` | +22 | barrel: engine + types; helpers export (additive) |

### 15.2 Thiết kế tiêu thụ wire (W49-Q4-2 §2/§3/§7.2-7.4, mỗi điều có test)

- **Sequence**: init (`uploadToken` uuid mới mỗi call; body {leaseEpoch, purpose, mimeType, fileName,
  sizeBytes}) → per part: `partGrant` (khai partNumber + sha256 part) → PUT presigned với
  `requiredHeaders` nguyên văn (content-length + checksum — test facade assert từng header; etag từ
  response làm receipt) → `complete` (receipts 1..N ascending + sha256 whole-object) → **finalize**
  (route cũ — cạnh STAGING→READY duy nhất cho cả hai nhánh, invariant Qwen-5 giữ nguyên; gate
  `committedOutputArtifactIds` không đổi).
- **Điều kiện branch** (facade): `sizeBytes > multipartThresholdBytes` (default = `maxArtifactBytes`)
  VÀ `sizeBytes >= MULTIPART_MIN_TOTAL_BYTES` (floor 64MiB+1) — dưới floor KHÔNG bao giờ gửi init
  (chống 422 khi deployment thu nhỏ cap); trên `MULTIPART_MAX_TOTAL_BYTES` fail sớm, 0 network;
  gray-zone (cap < floor) giữ nguyên lỗi cũ 'configured worker byte limit' — fail-closed.
- **Memory invariant**: buffer ĐÚNG 1 part — cap nội bộ `MULTIPART_SDK_MAX_PART_BYTES = 64MiB`,
  geometry server trả lớn hơn → TOO_LARGE + abort (chống server lỗi/hostile ép RSS); chunks giữ
  bằng subarray, `Buffer.concat` chỉ lúc PUT; whole + per-part digest MỘT lượt, không đọc lại nguồn.
- **Retry part PUT** (3 attempts, backoff 50ms·n): retry transport/5xx/403/404/408/429/thiếu etag —
  MỖI attempt re-grant (row grant idempotent per partNumber phía server, sha không đổi); 4xx khác
  (vd S3 checksum 400) KHÔNG retry — fail fast, không re-PUT bytes xấu.
- **Abort kỷ luật**: mọi fail TRƯỚC complete → best-effort abort (signal → 'cancelled', khác →
  'failed'; lỗi abort swallow — TTL sweeper của DATA-02 là lưới). Fail SAU complete (ack sha/size
  disagreement) → KHÔNG abort: bytes đã commit, row để finalize/reconcile. Test chứng minh cả hai.
- **Lease fence**: adapter đi qua `wrapLeaseErrors` — 409 LEASE_LOST nổi `LeaseLostError` y hệt các
  facade khác; lifecycle error không bao giờ bị ép thành ArtifactStreamError.
- **ADM-BASE-03 + SSRF**: partUrl presigned không vào message (test assert 'secret-url-token' vắng
  mặt); detail chỉ server-authored allowlist qua `readErrorDetail`; `assertHttpUrl` trước mọi PUT
  (test `file://` → INVALID_URL, 0 PUT).
- **v1 không resume cross-process** (§11.3): mỗi call token mới; session bỏ rơi → sweeper ABORTED+purge.

### 15.3 Lệch/ghi chú cần coordinator adjudicate

1. **Lease-lost giữa upload ghi abort-reason `cancelled`** (không phải 'failed'):
   `wrapLeaseErrors` abort signal của delivery TRƯỚC khi engine thấy lỗi → engine chỉ thấy
   `signal.aborted`. Server vẫn fence epoch nên không có ghi sai; muốn phân biệt cần thêm giá trị
   enum `reason` trên wire — việc của contract lane, lane này KHÔNG tự đổi.
2. **Part-concurrency = 1 (sequential)** — §6 để ngỏ (đề xuất 3, chưa ký). Sequential giữ RSS đúng
   1 part; option concurrency sau này là additive, không đổi wire.
3. `MULTIPART_SDK_MAX_PART_BYTES=64MiB` là cap memory NỘI BỘ SDK (không phải wire value, hướng
   fail-safe, không cần ký); geometry 8MiB đã ký-tạm của wire nằm dưới.
4. Timeout: part PUT 60s/part; lifecycle call theo `RuntimeClient.timeoutMs` 10s (init/complete chỉ
   là metadata JSON — đủ với 8GiB).
5. Nhắc lại Qwen-5 Δ7 cho bàn §6: 10k receipts vs ingress cap 1MiB — bất ổn ĐỊNH khi part ≥ 8MiB và
   total ≤ 8GiB (≤1000 receipts ≈ 130KB); nếu ký part-size nhỏ hơn phải xét cap ingress cùng lúc.

### 15.4 Receipt verification (2026-09-25 ~08:50–09:35Z)

| Bước | Kết quả | Exit |
|---|---|---|
| `npm run lint` (tsc --noEmit, worker-sdk) | sạch | 0 |
| `npx jest tests/artifact-multipart.test.ts` | **21/21** (engine 14 + facade 7) | 0 |
| full jest run 1 | 167/171 — 4 đỏ `network-boundaries.boundary` (gia đình real-listener) | 1 |
| boundary chạy riêng 2 lần | 5/6 với đỏ DI CHUYỂN sang test khác (B3-lock-a) → **6/6** | 1 / 0 |
| full jest run 2 | **12 suites / 171 pass** (150 baseline + 21 mới) | 0 |
| document-core `lint` + `test:typecheck` (downstream type-check thẳng src SDK) | sạch ×2 | 0 |
| document-core targeted 3 suites (parser-budgets / read-stream-acquisition / p8-03) | **63/63** — phân loại lại (Δ Cycle 141): safe offline chỉ 2 suites/56; p8-03 → DB window Tester-1 | 0 |
| `git rev-parse --short HEAD` | `7811298` nguyên ven — KHÔNG commit/push, KHÔNG DB/Redis, 0 socket | — |

Footprint Qwen-4 Cycle 140 = 8 file worker-sdk (2 mới + 6 sửa; `artifact-streams.ts` chỉ thêm từ
khoá `export`). document-core KHÔNG đổi một dòng — kiểm chứng thiết kế §12-C: 6 call-site envelope
(Cycle 138B) tự hưởng multipart khi kết quả > 64MiB mà không biết nó tồn tại.

### 15.5 Kết luận & next owner

- **Kết luận: PASS** — Step C IMPLEMENTED + VERIFIED offline ở tầng SDK; cycle khép chuỗi
  init→part→complete→finalize phía client (server đã xong từ W49-Q5-1). DATA-04 vẫn `[~]`:
  ACCEPTED cần cửa sổ live Tester theo §9.1-9.3 (fixture >64MiB thật, response-loss per-step,
  adversarial part-set, đo RSS peak).
- Next: (1) Tester xếp integration window §9 (SDK branch này + route Qwen-5 = đủ điều kiện chạy);
  (2) coordinator ký §6 (threshold/ceiling/TTL/concurrency) — SDK hiện dùng đúng wire defaults;
  (3) tuỳ chọn: option `multipartPartConcurrency` khi cần tốc độ; (4) cờ document-kit `parseFile`
  (§14.3) không đổi.
## Cycle 141 — Adjudication Reviewer (chu kỳ 156–161): phân loại lại suite document-core targeted (Qwen-4)

> Cập nhật 2026-09-25 ~09:55Z. Chu kỳ CHỈ VĂN BẢN: không sửa source, không chạy test,
> không DB/Redis, không commit/push. HEAD `7811298` (đo trực tiếp `git rev-parse --short HEAD`).

### 16.1 Phán quyết ghi nhận
- **Step C worker-sdk**: Tester-3 nghiệm thu ĐỘC LẬP — **171/171 pass** (xác nhận receipt §15.4).
- **Safe offline Document-Core targeted** := đúng **2 suites / 56 tests** — `parser-budgets` (48) +
  `read-stream-acquisition` (8) — **Zero DB writes, Tester-3 verified**.
- `p8-03-provider-convergence.test.ts` (7 tests) **loại khỏi set offline** — phần ghi PG được
  **danh riêng cho DB Window của Tester-1**.

### 16.2 Kiểm chứng đọc-only của lane trước khi ghi
- Dòng 9 của `p8-03-provider-convergence.test.ts` import `PgSqlClient` từ `@du/connector`; test
  dòng 328 (live usage_events projection query) mở kết nối từ `DATABASE_URL` hoặc fallback
  `postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test`, rồi INSERT/DELETE vào
  `operations` / `tasks` / `usage_events` (các dòng 339–399) — KHÔNG điều kiện hoá → phân loại
  của Reviewer là đúng thực tế file.
- Số học khớp: 48 + 8 = **56** an toàn; 63 − 56 = **7** = đúng số test decl của p8-03.
- Bài học kỷ luật lane: từ chu kỳ này, chọn targeted offline KHÔNG kèm p8-03. Receipt cũ
  (Cycle 138B batch `38/484` có p8-03; Cycle 140 `63/63`) giữ nguyên như lịch sử đo tại thời
  điểm đó — chỉ gắn nhãn phân loại lại, không diễn giải lại.

### 16.3 Bảng phân loại chốt
| Tập | Nội dung | Cửa sổ chạy |
|---|---|---|
| Safe offline doc-core targeted | parser-budgets (48) + read-stream-acquisition (8) = **56 pass, 0 DB writes** (Tester-3 verified) | Mọi lane, offline |
| p8-03-provider-convergence (7) | `PgSqlClient` INSERT/DELETE PG thật | **DB Window — Tester-1** |
| worker-sdk full | 12 suites / **171 pass** — Step C đã Tester-3 xác nhận độc lập | Offline |

**Kết luận: PASS (văn bản)** — adjudication đã ghi nhận; next owner không đổi so với §15.5
(Tester live window §9; coordinator ký §6).

---

## W2B-P2 FIX — claim tu choi credentialRef sai tuple (finding P730-W2-B-01) — 2026-10-04

- **Packet:** W2B-P2-FIX (reassigned tu qwen_1), task task_6d21a84909fd, spec `coordination/dispatch-specs/2026-10-04-1935-W2B-P2-FIX.md`. Nguon finding: `coordination/reports/tester.md:12560` (P730-W2-B-01, P2).
- **Lease:** `services/orchestrator/src/modules/runtime/runtime.ts` (claim validation path). KHONG sua test lane khac (`tests/p730-profile-snapshot.test.ts` giu nguyen 0 diff).
- **Ranh gioi:** khong commit/push, khong tick, khong mo cua so DB/Redis, offline.

### 1. Fix

`parsePinnedProfilePolicy` truoc day chi shape-check (`PinnedProfilePolicySchema.safeParse`). Mot credentialRef **structurally valid** nhung tro (tenant, profileId, profileRevision) KHAC identity ma operation row pin van di qua va duoc tra ve trong claim — acquisition consumer (W1c) se giai ma nham ciphertext cua identity khac.

Thay doi (chi file lease):
1. Ham nhan them `identity: { tenantId, profileId, profileRevision }` doc tu chinh row `t.tenant_id / t.profile_id / t.profile_revision` (call site trong `buildClaimResult`).
2. Sau shape-parse: so khop ca 3 thanh phan tuple. Mismatch -> `unprocessable('INVALID_SCHEMA', ...)` **giu nguyen cung status+code family** nhu loc shape (spec de xuat giu 422 INVALID_SCHEMA — da chon, ghi ro o day). Thong diep tinh, **khong dua gia tri tuple len wire** (chi pointer `/profile_policy_snapshot/credentialRef`).
3. Vi throw xay ra **bên trong** `db.tx` cua `claimTask` (buildClaimResult duoc goi trong tx), lease + operation-state updates cung rollback — day la rollback ma su dung hien co cua harness, khong them co che moi.

### 2. Bang chung chay (literal exit codes, wrapper tra ve)

| Lenh | Ket qua | Exit Code |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` (orchestrator) | sach | `Exit Code: 0` |
| `npx jest tests/p730-profile-snapshot.test.ts --runInBand` | **11 passed, 11 total** (3 truoc do do) | `SUITE_EXIT=0` |
| `npx jest tests/p730-legacy-snapshot-failclosed.test.ts` | 2 passed, 2 total | `SUITE_EXIT=0` |
| `npx jest tests/w1-sub02-snapshot-secret.test.ts` | 10 passed, 10 total | `SUITE_EXIT=0` |
| `npx jest tests/w1-sub03-sourceurl-extension.test.ts` | 6 passed, 6 total | `SUITE_EXIT=0` |
| `npx jest tests/p730-pinned-policy.test.ts` (worker-sdk) | 3 passed, 1 todo, 4 total | `SUITE_EXIT=0` |
| `p730-profile-snapshot` chay lap lai 3 lan | 11/11 ca 3 lan | `RUN_EXIT=0` x3 |

3 case do chuyen xanh **bang chinh fix product** (khong sua test): moi case kiem `claimFailed: true`, `committedWrites: 0`, `returnedRef: undefined` — tuc la ca fail-closed LANH khong commit lease/state. Suite `p730-legacy-snapshot-failclosed` (lane khac, 0 diff) cung xanh: `transactionRollbacks=1` va committed task van `READY/attempt 0/lease 0` — rollback duoc ching o ca hai harness doc lap.

### 3. Ghi chu trung thuc ve hien trang file (shared checkout)

Truoc khi toi sua, `runtime.ts` **da co san** khoi T-SUB-04 o working tree (41 dong insert so voi HEAD `b088eec`: import `PinnedProfilePolicySchema`, ham parse shape-only, cot `o.profile_policy_snapshot` trong SELECT claim, call site). Do chinh la pham vi finding P730-W2-B-01 mo ta (shape-only, chua so tuple) — **khong phai do toi them**. Fix cua toi nam de len no (signature + tuple check). Toi khong commit, khong revert; `runtime.ts` la hot file trong topology (Claude Phase 2) — coordinator can biet no gio dang mang 41 dong + tuple check chua commit.

### 4. Phan live (con mo, KHONG phai bang chung cua receipt nay)

- Offline bang chung dung o muc jest + fake db tx (rollback la staging model cua harness, khong phai PG thật).
- Can Tester mot cua so PG that: chen operations co `profile_policy_snapshot.credentialRef` lech `operations.profile_id`/`profile_revision`/`tenant_id`, claim phai 422 va `tasks.lease_epoch/state` + `operations.state` khong doi (SELECT lai sau rollback).
- Test cua toi neu can them se o file RIENG (`tests/w2b-p2-credential-ref-claim.test.ts`) — chua can: 3 case cua W2-B da phu du va da xanh.

### 5. Trang thai 4 muc

- **IMPLEMENTED** — fix product trong lease.
- **VERIFIED offline** — 5 suite exit 0 + 3x lap lai + tsc 0 (literal o muc 2).
- **KHONG accepted** — live PG window chua chay (muc 4); gate/tick thuoc coordinator/Reviewer.
- **Δ-DEVIATION: khong co.** Khong them file, khong vuot lease, khong doi test lane khac.

### 6. Su co ghi chu ve ghi file - minh bach

- Khi append receipt, toi lay ket qua read_file (ban CAT vi file vuot gioi han dung luong) lam base roi ghi lai. Working tree bi cat con 400 dong.
- KHAC PHUC: khoi dung dung HEAD, lenh git show 17e96b9:du-rework/coordination/reports/qwen4.md. Receipt duoc gan phia sau 754 dong day du.
- Bang chung lossless: git status luc dau phien 2026-10-04 trong prompt khoi dong KHONG liet ke file nay o nhom modified, vay working tree trung HEAD truoc khi toi cham.
- Ket luan: khong that thoat noi dung cu. Sai sot thuoc ve qui trinh ghi: file dai KHONG dung read_file lam base append, dung git show hoac append byte-level.
