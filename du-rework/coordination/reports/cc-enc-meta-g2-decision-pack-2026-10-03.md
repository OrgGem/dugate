# ENC-META-G2-DEC — Decision pack: slot/format cho các writer còn hở (G2/G3/G5/G6)

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Spec:** dispatch `ENC-META-G2-DEC`.
- **Mode: READ-ONLY.** Không sửa file nào ngoài receipt này; **không chạy test**; **không tick; không commit**; `nocobase-10` không bị nhắm.
- Nguồn: `cc-enc-meta-writer-scan-2026-10-03.md` (G2/G3/G5/G6) + `cc-enc-meta-sentinel-2026-10-03.md` (RED detectors) + re-anchor source hiện tại. Mỗi mục: evidence file:line, options, blast radius, khuyến nghị.

**TL;DR (VI):** (G2) `result_ref` **có chứa nội dung tài liệu thật** (lc-checker nhét OCR text base64 qua `data:…` — `lc-checker/src/worker.ts:276,322,144-166`) ⇒ **nên seal**, đề xuất **2 slot mới** `tasks.result_ref` + `operations.result_ref`, seal tại **Orchestrator lúc nhận callback** (worker không giữ metadata key; nó chỉ POST plaintext qua runtime API), format y hệt envelope hiện có, **không cần migration** (cột `text`). (G3) `human_waits.input_schema/ui_schema/context_ref` hiện **write-only, không route nào trả ra** — đề xuất **1 slot `human_waits.wait_definition`** gói 1 envelope cho cả 3 field (hoặc tối thiểu seal `ui_schema`+`context_ref`). (G5) `file_name/mime_type`, `usage_events.payload`, `callback_url`, `connector_bindings`, `submit_artifacts`: **không seal** — toàn refs/số liệu vận hành, có evidence schema + lý do từng cái. (G6) đã có sẵn primitive **`BoundedDualReadWindow` ≤14 ngày** trong ENC-09 (`legacy-payload-migration.ts:494-535`) nhưng runtime/consumer **hardcode `true`** — đề xuất wire window + gate bằng ENC-09 inventory `unresolvedReferences===0`, hết hạn ⇒ fail closed.

## 1. G2 — `tasks.result_ref` / `operations.result_ref`

### 1.1 Evidence hiện tại

| Việc | Vị trí |
|---|---|
| Writer (duy nhất) | `runtime.ts:545` (`UPDATE tasks … result_ref=$2`), `:568` (`UPDATE operations … result_ref=$2`) trong `completeTask`; giá trị = `body.resultRef` từ worker callback |
| Cột | `migrations/0001_platform_v1.sql:48` (tasks), `:85` (operations) — **`text`**, không index/WHERE trên cột |
| Worker → Orchestrator | `packages/worker-sdk/src/worker.ts:463-468` POST `/tasks/:id/complete` qua `runtime-client.ts:218-219`; worker **không** giữ metadata seam (seam Vault Transit chỉ nằm ở Orchestrator) |
| Reader 1 — public | `server.ts:2144-2150` (`GET /api/v1/operations/:id/result`) → `data.resultRef` nguyên văn; wire được bọc theo tenant policy ENC-07 (`:2151-2160`) |
| Reader 2 — admin | `server.ts:4297-4303` (`buildAdminOperationDetail`, `:4250`) — cùng projection |
| Reader 3 — worker runtime | `GET /api/runtime/v1/tasks/:id/children` (`server.ts:1815-1821`) → `runtime.ts:876-894` trả `resultRef` của từng child |
| Reader 4 — join | `runtime.ts:1443-1470`: `joinSummary[taskKey] = s.result_ref` rồi merge vào parent payload (**parent payload sau đó được seal** ở `:1480-1484`) |
| Reader 5 (chết) | `submission.ts:730-758` `loadOperationView` SELECT `result_ref` nhưng **không map vào view** — cột bị kéo thừa, có thể dọn sau |
| Nội dung thực tế | **KHÔNG chỉ là ref**: lc-checker nhét OCR/visual text: `encodeInline({kind:'ocr',fileName,text})` → `data:application/json;base64,…` (`lc-checker/src/worker.ts:276,322`; decode `:144-166`); document-core dùng `artifact://<uuid>` (`document-core/src/worker.ts:1037,1209,1504,…`) nhưng **đọc lại** resultRef của child để parse (`:682-686`, `:1625-1629`) |
| Contract | `CompleteTaskRequestSchema.resultRef = z.string().min(1)` (`contracts/src/runtime.ts:163`) — không giới hạn ngữ nghĩa/kích thước |

### 1.2 Options

**G2-A (khuyến nghị) — seal tại Orchestrator, 2 slot mới, reader unseal:**
- Thêm `'tasks.result_ref'` và `'operations.result_ref'` vào `METADATA_SLOTS` (`metadata-crypto.ts:44-49`), dùng **đúng envelope v1 hiện có** (version/algorithm/keyRef/dek/nonce/tag/aad/ciphertext/plaintextSha256) — không format mới.
- Trong `completeTask`: seal `body.resultRef` **trước tx** (như submit: Vault call không nằm trong write tx) với context `(tenant, 'tasks.result_ref', taskId)` / `(tenant, 'operations.result_ref', operationId)`. Cần `tenantId` → mở rộng SELECT `:509-515` lấy thêm `o.tenant_id` (đọc trước, không khoá) rồi seal; tx bên trong vẫn re-validate lease/business như cũ.
- Reader đổi sang `readStored(..., ctx, allowPlaintext=<G6 window>)`:
  - result route `server.ts:2146` + admin detail `:4299` → mở `operations.result_ref` theo `(tenant, slot, operationId)` (route có `apiKey.tenantId`; admin có principal).
  - children `runtime.ts:894` → mở `tasks.result_ref` theo từng `(tenant, taskId)`.
  - join `runtime.ts:1470` → mở child `tasks.result_ref` **trước khi** merge vào parent (tránh envelope lồng envelope).
- Legacy: chuỗi plaintext cũ không bao giờ pass `isSealed` ⇒ trong window đọc thẳng; hết window fail closed (G6).
- Blast radius: `metadata-crypto.ts` (2 slot + test inventory), `runtime.ts` (2 writes + 3 reads + SELECT tenant), `server.ts` (2 reads — **cần lease Platform**), tests. **Không migration** (cột text; envelope = JSON text). Worker/wire không đổi; `contentHash(resultRef)` trên request không đổi; idempotency replay không so ref.
- Điểm mạnh: bịt đúng dữ liệu nặng nhất (OCR text inline); đối xứng với 4 slot hiện có; wire vẫn plaintext nên SDK/join contract không đổi (chỉ at-rest).

**G2-B — chỉ seal `operations.result_ref`:** ít reader hơn, nhưng bỏ hở `tasks.result_ref` — chính là bản child copy chứa `data:` text mà join/children đọc. Không khuyến nghị (giải quyết nửa vấn đề, lại lệch chuẩn "một seam").

**G2-C — không seal; siết contract refs-only:** cấm `data:` inline (đổi join contract của lc-checker/doc-compare từ chỗi text → artifact), cap size, dựa ENC-07 cho wire. Blast radius thấp ở orchestrator nhưng **phá contract hiện hành của business** (lc-checker đang gửi text nội tuyến, có decode tương ứng) + vẫn để refs nằm plaintext. Chỉ chọn nếu platform quyết không mở slot mới.

### 1.3 Khuyến nghị
**G2-A.** Worker không có key nên seal ở writer nào cũng phải ở Orchestrator — và may là vậy: một chỗ, một seam, một format. Cân nhắc implementation: seal trước tx (cần pre-read tenant) hoặc chấp nhận 2 Vault call trong tx với comment — đề xuất pre-read.

## 2. G3 — `human_waits.input_schema / ui_schema / context_ref`

### 2.1 Evidence hiện tại

| Việc | Vị trí |
|---|---|
| Cột | `migrations/0005_continuation.sql:15-17`: `input_schema jsonb NOT NULL`, `ui_schema jsonb`, `context_ref text`; `response_ref jsonb` (đã seal) |
| Writer | `runtime.ts:957-970` (`waitInput`) — nhận từ worker qua `POST /api/runtime/v1/tasks/:id/wait-input` (`server.ts:1825-1832`) |
| Reader nội bộ | resume: `runtime.ts:1035-1067` (đọc schema → ajv validate input); replay idempotent: `:935-946`, `:973-982` (so `JSON.stringify(input_schema)`) |
| Route trả ra tenant? | **Không**: resume route `server.ts:2264-2269` chỉ nhận `{waitId,input,expectedStateVersion}`; children route không chứa schema. `ui_schema` và `context_ref` **hiện write-only hoàn toàn** (không reader nào ngoài chính insert) |
| Nội dung | `input_schema`/`ui_schema` do worker cung cấp (có thể chứa label/prompt/enum nghiệp vụ); `context_ref` is free string |

### 2.2 Options

**G3-A (khuyến nghị) — 1 slot `human_waits.wait_definition`, 1 envelope gói cả 3 field:**
- `seal({inputSchema, uiSchema, contextRef}, {tenant, slot:'human_waits.wait_definition', refId: waitId})` ghi vào… chọn chỗ chứa: hoặc một cột mới (cần migration) **hoặc** thay `input_schema` bằng envelope object chứa cả 3 (không cần cột mới nhưng `input_schema NOT NULL` phải giữ object — hợp lệ). Vì không reader nào trả ra, format nội bộ tự do.
- Resume/replay mở envelope một lần rồi chạy logic cũ (ajv trên `inputSchema` đã mở; so replay bằng JSON.stringify giá trị đã mở).
- Blast radius: `runtime.ts` (waitInput write, resume read, 2 replay compares), `metadata-crypto.ts` (1 slot), tests. Không route/wire change. Không migration nếu nhét vào `input_schema`; **có migration** (cột `wait_definition jsonb`) nếu muốn giữ 3 cột nguyên shape.

**G3-B — chỉ seal `ui_schema` + `context_ref` (giữ `input_schema` plaintext):** resume path gần như không đổi (không cần mở để validate); vẫn bịt 2 field tự do. Rủi ro còn: enum/default trong `input_schema` có thể chứa chuỗi nghiệp vụ. Blast radius nhỏ hơn A.

**G3-C — không seal; bound size + coi là structural:** rẻ nhất nhưng `context_ref`/`ui_schema` là free-text worker-supplied, khó biện luận "không phải nội dung"; đi ngược tinh thần G1/G2.

### 2.3 Khuyến nghị
**G3-A** — vì các field này không có reader trả ra ngoài, chi phí seal ~1 wrap + 1 open, đổi lại đóng trọn nhóm; nếu muốn tối thiểu thay đổi thì **G3-B** là fallback chấp nhận được. Không chọn C.

## 3. G5 — Metadata phụ: phân loại seal / không-seal / redact

| Field | Evidence | Phân loại | Lý do |
|---|---|---|---|
| `artifacts.file_name` / `mime_type` | Writers: `artifacts.ts:171`, `multipart-service.ts:798,1038`, `upload-encryption-gateway.ts:854`, `ingestion-consumer.ts:239-243`. Readers/projections: `grants.ts:215` (wire tới worker), `artifacts.ts:388`, `multipart-service.ts:93`, `upload-encryption-gateway.ts:816`; `ArtifactRefSchema.fileName/mimeType` (`contracts/src/operations.ts:163-164`) | **KEEP (không seal)** | Là metadata vận hành (hiển thị/tải file), expose lặp lại ở nhiều projection kể cả wire worker; seal sẽ đẩy envelope ra grants/UI hoặc phải unseal ở ≥4 chỗ. Không có WHERE/ORDER theo tên (không mất query). Nội dung tài liệu nằm ở bytes (đã có ENC-03/05). Đề xuất kèm bound charset/length khi có dịp (policy, không phải slot). |
| `usage_events.payload` | `usage.ts:340-343`, `budget-reservations.ts:623`; schema `UsageEventSchema` (`contracts/src/runtime.ts:405-419`): eventId/invocationId/operationId/taskId/units{…}/costMicrousd/currency/measurement/occurredAt | **KEEP (không seal)** | Chỉ số + UUID, **không free text**; pricing/project đọc trực tiếp jsonb (`usage.ts` project) — seal sẽ phá aggregate. |
| `operations.callback_url` | Write: `submission.ts` INSERT operations (giá trị `submission.callback?.url ?? null`); read: `webhooks.ts:61-73,92` (scheduler + copy vào `webhook_deliveries.destination_url`); validate HTTPS/no-credentials tại submit `submission.ts:375-383`; **không xuất hiện trong wire projection nào** | **KEEP + redact policy** | Cần plaintext đúng lúc dispatch (2 nơi đọc, +1 bản copy trong deliveries). URL có thể mang query token ⇒ bù trừ: không log/không trả ra API (đã đúng), error/audit không echo. Nếu policy đòi at-rest: upgrade path = slot + unseal tại scheduler **và** deliveries (2 chỗ), cần quyết riêng. |
| `operations.connector_bindings` | Render/parse: `profiles.ts:21-26,32-51,57-63` — `Record<slot, {connectorId, revision}>` → lưu dạng `"connectorId@revision"` (`submission.ts:338`); read: claim `runtime.ts:278,1578`, grants `grants.ts:158,198` | **KEEP (không seal)** | Thuần platform config refs (tên connector + revision), không secret value; worker cần thấy để invoke. |
| `operations.submit_artifacts` | `server.ts:2105-2114,2192,4258-4266`; `artifacts.ts:362,416`; `grants.ts:158` | **KEEP (không seal)** | Mảng `{artifactId, role}` — thuần UUID refs, dùng trong SQL predicate jsonb `@>` (seal sẽ phá truy vấn). |

## 4. G6 — Đóng backfill window `allowPlaintext`

### 4.1 Evidence hiện tại
- Hardcode: `runtime.ts:214-222` (`openMetadata` → `readStored(value, ctx, true)`) và `ingestion-consumer.ts:547-553` (`readStored(…, true)`) — không có config/counter/deadline.
- Semantics: `metadata-crypto.ts:174-187,309-321` — plaintext chỉ được trả khi cờ `true`; envelope sai binding **luôn** fail (kể cả cờ true).
- FINDING đã pin: `runtime-encryption-metadata.test.ts:1168-1177` ("backfill window has no deadline, only a per-call boolean").
- **Primitive đã tồn tại trong ENC-09** (`legacy-payload-migration.ts`):
  - `MAX_DUAL_READ_WINDOW_MS = 14 ngày` (`:21`);
  - `createBoundedDualReadWindow(startsAt, expiresAt)` — window immutable, ≤14 ngày, `allowsLegacyRead(now)` (`:494-519`);
  - `readDuringBoundedDualRead(...)` — encrypted luôn đi đường thường; legacy chỉ trong window, **ngoài window throw** (`:521-535`);
  - `canRetireLegacyPayloads(inventory, backupSignedOff)` — chỉ khi backup sign-off + `unresolvedReferences === 0` (`:485-492`);
  - inventory/backfill idempotent lock/CAS + verify readback (`:113-194`, `:318+`), `legacyDeletionAllowed:false`.

### 4.2 Options
**G6-A (khuyến nghị) — wire bounded dual-read window vào 2 call site:**
- Config boot (ví dụ `metadataLegacyWindow: {startsAt, expiresAt}`) → `createBoundedDualReadWindow` (tự chặn >14 ngày) → `openMetadata`/consumer dùng semantics `readDuringBoundedDualRead` (isSealed → open; legacy chỉ khi `allowsLegacyRead`; hết hạn ⇒ fail closed).
- Thêm counter/log "plaintext read" trong window để đo tiến độ về 0; mở window **chỉ sau** khi ENC-09 inventory đạt `unresolvedReferences === 0` cho 4 slot + payload_ref (backfill verified).
- Blast radius: `runtime.ts`, `ingestion-consumer.ts`, config plumbing boot (`server.ts`/`main.ts` — cần lease ngoài lane), tests (window matrix: inside/outside/encrypted/legacy).

**G6-B — cờ đơn giản `DU_METADATA_ALLOW_PLAINTEXT` (default true → flip false sau backfill, xoá cờ chu kỳ sau):** ít code nhất, nhưng không có bound ≤14 ngày cưỡng chế bằng cấu trúc và không tái dùng primitive ENC-09.

**G6-C — cờ per-slot (4 flags):** mịn nhất cho rollout cuốn chiếu từng slot, nhưng tăng bề mặt config; chỉ chọn nếu migration theo slot là yêu cầu vận hành thật.

### 4.3 Khuyến nghị
**G6-A** — primitive đã được xây chính xác cho việc này; "deadline" nên gắn với **bằng chứng backfill hoàn tất (unresolvedReferences=0)** chứ không phải ngày lịch; hết window mặc định **fail closed** (không bao giờ "open to infinity"). Lưu ý deletion (xoá legacy) vẫn cần backup sign-off riêng — đóng read-window ≠ được xoá bản cũ.

## 5. Tổng hợp — user cần chốt

| # | Quyết định | Options | Khuyến nghị |
|---|---|---|---|
| 1 | G2 `result_ref` | A: 2 slot mới + seal tại `completeTask` + unseal 5 reader · B: chỉ `operations.result_ref` · C: không seal, siết refs-only | **A** |
| 2 | G3 `human_waits.*` | A: 1 slot gói 3 field · B: seal `ui_schema`+`context_ref` · C: không seal | **A**, fallback B |
| 3 | G5 | KEEP cả 5 nhóm (file_name/mime, usage payload, callback_url + redact, connector_bindings, submit_artifacts) | **KEEP + policy** như §3 |
| 4 | G6 | A: bounded window (≤14d, ENC-09 primitives) · B: env flag · C: per-slot | **A** |

**Hệ quả & việc kế tiếp (không tự làm):** G2/G3/G6 đụng `metadata-crypto.ts` + `server.ts` (ngoài lease hiện tại của mọi packet ENC-META còn lại) ⇒ cần 1–2 implementation packet với lease rõ (Platform/Encryption owner), kèm: slot additions + tests inventory slots, unseal ở 5 reader G2, window plumbing G6. G2 nên kèm dọn `loadOperationView` kéo thừa `result_ref`. Khi chốt, RED detectors hiện có (`enc-meta-sentinel-runtime-refs` G2b) chuyển xanh theo cùng tiêu chí như G1.
