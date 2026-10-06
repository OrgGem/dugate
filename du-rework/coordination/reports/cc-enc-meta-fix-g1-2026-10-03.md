# ENC-META-FIX-G1 — seal `sourceUrl` in outbox payload (flip G1c green) — cc_2

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Spec:** dispatch `ENC-META-FIX-G1` + finding G1 từ `cc-enc-meta-sentinel-2026-10-03.md`.
- **Mode:** IMPLEMENT (bounded). **Không tick gate; không commit.** `nocobase-10` không bị nhắm.

**TL;DR (VI):** `sourceUrl` trong `outbox.payload` giờ được **seal bằng chính seam `metadataCrypto`** theo cùng binding với root task payload — `(tenantId, slot 'tasks.payload_ref', refId rootTaskId)` — nên cột PG outbox không còn giữ URL plaintext; consumer mở lại đúng giá trị trước khi dùng. Seam không cấu hình ⇒ giữ nguyên plaintext byte-for-byte (opt-in như cũ). **G1c chuyển XANH**; G1b cập nhật theo hiện trạng mới; thêm case consumer round-trip + negatives. Focused set 6 suite / **198 test pass, exit 0**; `tsc --noEmit` **exit 0**; file sentinel G2 giữ nguyên 1 đỏ **có chủ đích** (result_ref, ngoài phạm vi packet).

## 1. Thiết kế & thay đổi (declared scope)

**Binding chọn:** `(tenantId, 'tasks.payload_ref', rootTaskId)` — trùng đúng binding mà root task payload đã dùng. Lý do: (a) URL là một phần tử của task payload nên cùng "row identity" là đúng ngữ nghĩa; (b) consumer chỉ cần **một context** đã có sẵn (`record.tenantId`, `record.taskId`) để mở cả hai bản; (c) **không cần thêm slot mới** vào `METADATA_SLOTS` — `metadata-crypto.ts` nằm ngoài lease. (Nếu platform muốn slot riêng cho outbox payload, đó là packet follow-up; xem §5.)

**1.1 Writer — `services/orchestrator/src/modules/operations/submission.ts`** (trong lease):

```ts
// NEW private helper (sau sealSubmitMetadata):
async function sealOutboxSourceUrl(
  crypto: MetadataCrypto | undefined,
  sourceUrl: string | undefined,
  tenantId: string,
  rootTaskId: string
): Promise<unknown> {
  if (sourceUrl === undefined) return undefined;
  if (!crypto) return sourceUrl;
  return crypto.seal(sourceUrl, { tenantId, slot: 'tasks.payload_ref', refId: rootTaskId });
}
```

```diff
      const sealedInputRef = await sealSubmitMetadata(metadataCrypto, submission.input, ctx.tenantId, 'operations.input_ref', operationId);
      const sealedTaskPayload = await sealSubmitMetadata(metadataCrypto, taskPayloadValue, ctx.tenantId, 'tasks.payload_ref', rootTaskId);
+     // ENC-META-FIX-G1: seal BEFORE the tx (Vault call must not sit inside it).
+     const sealedOutboxSourceUrl = await sealOutboxSourceUrl(metadataCrypto, submission.sourceUrl, ctx.tenantId, rootTaskId);
@@ outbox payload
              gate: submission.sourceUrl ? 'ingestion' : undefined,
-             sourceUrl: submission.sourceUrl,
+             sourceUrl: sealedOutboxSourceUrl,
```

- Khi seam bật: field là **envelope object** (`version/algorithm/dek/nonce/tag/aad/ciphertext/plaintextSha256`) — self-describing như các slot khác; KHÔNG dùng `sealSubmitMetadata` vì helper đó trả JSON-text cho cột jsonb, còn đây nhúng trong payload JSON nên cần object (tránh double-encode).
- Khi seam tắt (`metadataCrypto === undefined`): trả về **plaintext string** đúng như lịch sử — deployment không opt-in không đổi byte nào.
- Không có `sourceUrl` (inline submit): trả `undefined` → `JSON.stringify` bỏ field (test cũ `'sourceUrl' in payload === false` vẫn xanh).

**1.2 Consumer — `services/orchestrator/src/modules/operations/ingestion-consumer.ts`** (consumer trực tiếp của outbox payload — khai báo theo yêu cầu lease):

```ts
// NEW export (seam mở hộp cho cả test round-trip):
export async function openDispatchSourceUrl(
  raw: unknown,
  binding: { tenantId: string; taskId: string },
  crypto: MetadataCrypto | undefined
): Promise<string> {
  if (typeof raw === 'string') return raw;                    // legacy row (pre-fix / seam-off)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MetadataCryptoError('NOT_SEALED', 'dispatch sourceUrl is neither a string nor a sealed envelope');
  }
  if (!crypto) {
    throw new MetadataCryptoError('KEY_PROVIDER_FAILED', 'dispatch sourceUrl is sealed but no metadata seam is configured');
  }
  const opened = await crypto.readStored(raw, {
    tenantId: binding.tenantId, slot: 'tasks.payload_ref', refId: binding.taskId,
  }, false);                                                  // fail-closed: plaintext không đi qua đường này
  if (typeof opened !== 'string' || opened.length === 0) {
    throw new MetadataCryptoError('NOT_SEALED', 'dispatch sourceUrl did not open to a non-empty string');
  }
  return opened;
}
```

`processRow` rework:
- Gate tọa độ đầu vào giờ chấp nhận `rawSourceUrl` là **string** HOẶC object không-array (empty string vẫn skip như cũ; đổi tên biến `sourceUrl` → `rawSourceUrl`).
- Sau cross-check `record.taskId === taskId` (đã có tenant + id để bind), URL được **resolve** qua `openDispatchSourceUrl`; lỗi map đúng như pattern payloadRef bên dưới: `KEY_PROVIDER_FAILED` → retry bounded → escalate ở maxAttempts; mọi lỗi crypto khác → permanent escalate (`'dispatch sourceUrl cannot be opened under its binding'`). Diễn ra **trước** mọi network/storage work.
- So khớp `envelope.sourceUrl !== sourceUrl` (:570 cũ) giữ nguyên — giờ cả hai vế đều là plaintext đã mở.

**1.3 File touched (đúng lease + khai báo):** `submission.ts`, `ingestion-consumer.ts` (consumer), `tests/enc-meta-sentinel-outbox-source-url.test.ts`. **KHÔNG** sửa: `server.ts`, schema/migration, `metadata-crypto.ts`, `dispatcher.ts` (chỉ đọc — nó publish payload nguyên văn, envelope đi qua opaque; row `gate='ingestion'` không bao giờ được publish nên Redis chưa từng dính G1). `tests/enc-meta-sentinel-runtime-refs.test.ts` giữ nguyên (G2 ngoài phạm vi).

## 2. Cập nhật test (G1 file)

| Case | Trước | Sau |
|---|---|---|
| G1a submit seal 2 cột | pass | **giữ nguyên** — pass |
| G1b pin | pin plaintext (`toBe(true)`) | **viết lại**: `payload.sourceUrl` là envelope (version 1, aes-256-gcm, ciphertext string), `leaksSentinel(payload) === false`, mở được bằng seam độc lập đúng `(TENANT, tasks.payload_ref, rootTaskId)` → `SOURCE_URL`, và **row khác bị từ chối** (`MetadataCryptoError`) |
| G1c detector | RED (fail) | **XANH** — giữ nguyên câu assert, thêm chú thích "was RED" để traceability |
| G1d dispatcher gate-filter | pass | **giữ nguyên** — pass |
| G1e round-trip (MỚI) | — | payload bắt từ writer → `openDispatchSourceUrl` (đúng seam consumer) mở ra `SOURCE_URL` |
| G1e negatives (MỚI) | — | legacy plaintext string pass-through; envelope mis-bound → `CONTEXT_MISMATCH`; shape rác → `MetadataCryptoError`; sealed + không seam → `KEY_PROVIDER_FAILED` (không bao giờ plaintext) |

## 3. Evidence (literal, cwd `D:\Git\dugate\du-rework\services\orchestrator`, `NODE_ENV=test`)

**3.1 Focused set — exit 0:**

```
$ npx jest --runInBand tests/enc-meta-sentinel-outbox-source-url.test.ts \
    tests/url-ingestion-consumer-offline.functional.test.ts \
    tests/url-ingestion-backend-failclosed-offline.test.ts \
    tests/crx01-creatapp-metadata-seam.test.ts \
    tests/submission-metadata-crypto-e2e.test.ts tests/runtime-encryption-metadata.test.ts
FOCUSED_EXIT=0
PASS tests/url-ingestion-consumer-offline.functional.test.ts
PASS tests/runtime-encryption-metadata.test.ts
PASS tests/enc-meta-sentinel-outbox-source-url.test.ts
PASS tests/submission-metadata-crypto-e2e.test.ts
PASS tests/url-ingestion-backend-failclosed-offline.test.ts
Test Suites: 6 passed, 6 total
Tests:       198 passed, 198 total
```

**3.2 G1 file verbose (trước đó trong cùng phiên):**

```
PASS tests/enc-meta-sentinel-outbox-source-url.test.ts
  √ GREEN: seals both control-plane columns and the envelope opens back to input + sourceUrl
  √ GREEN pin: the outbox payload carries the sourceUrl as a sealed envelope under the task binding
  √ GREEN acceptance gate (was RED): the outbox payload must not carry sourceUrl plaintext
  √ G1e: the consumer seam opens the captured dispatch sourceUrl back to the exact URL
  √ G1e negatives: legacy plaintext passes through; mis-bound, malformed, and seam-less values fail closed
  √ GREEN: the dispatcher never publishes gate=ingestion rows, and published rows carry references only
```

**3.3 File sentinel thứ hai (giữ nguyên, đỏ có chủ đích):**

```
FAIL tests/enc-meta-sentinel-runtime-refs.test.ts
  √ FINDING pin: completeTask stores result_ref verbatim on BOTH tasks and operations
  × RED GAP DETECTOR: result_ref must not rest as plaintext on either row    ← G2b, ngoài phạm vi packet này
  √ FINDING pin: waitInput stores ui_schema and context_ref verbatim (no slot exists)
  √ GREEN: resumeOperation seals response_ref + resume payload; the dispatch row carries references only
Tests: 1 failed, 3 passed
```

**3.4 `tsc --noEmit -p tsconfig.json`: `TSC_EXIT=0`.** Ghi chú trung thực: trong lúc chạy có một nhịp `src/modules/audit/audit.ts:142` lỗi TS2304 do **lane khác sửa dở** (CONV-13 khu vực `toWire`/`toAuditWire`) làm `crx01` fail-to-run một lần; lane đó tự sửa, tôi **retry** và cả suite lẫn tsc về xanh. Không sửa file ngoài lease.

## 4. Phân tích tương thích

- **Seam OFF:** payload giữ plaintext string byte-for-byte — `url-ingestion-backend-failclosed-offline` (4/4) chứng minh, gồm case `'sourceUrl' in payload === false` cho inline submit.
- **Row cũ trong lúc nâng cấp:** consumer mới accept cả string (legacy) — `url-ingestion-consumer-offline.functional` (legacy rows + sealed READY flow) xanh.
- **Row mới + binary cũ:** không xảy ra trong cùng process (writer `submission` và consumer `ingestionConsumer` được dựng **chung trong `createApp`**); nếu rolling deploy nhiều bản, row sealed chỉ được consumer bản mới claim — bản cũ nếu gặp sẽ fail **visible** (escalate "sourceUrl is invalid"), không bao giờ đọc plaintext sai.
- **Vault cost:** submit URL giờ có thêm 1 wrap (tổng 3 mỗi submit URL: input_ref + payload_ref + outbox copy); chấp nhận — cùng seam, cùng keyRef.
- **Redis/queue:** không đổi — `dispatcher` lọc `gate='ingestion'`; row publish (`gate:'ready'`) vẫn refs-only (G1d xanh).

## 5. Quyết định & phần không làm

- Không thêm slot mới (`outbox.payload`) vì `metadata-crypto.ts` ngoài lease; dùng binding `tasks.payload_ref` như trên. **Nếu** platform muốn tách slot riêng để phân biệt ngữ nghĩa cột outbox → follow-up packet nhỏ (thêm slot + chỉnh 2 call site), không cần migration.
- Không chọn phương án "bỏ hẳn sourceUrl khỏi payload": giữ **cross-check** dispatch↔task-row như thiết kế gốc (consumer so hai bản đã mở; mismatch vẫn escalate).
- **Không** sửa `result_ref`/`human_waits` (G2/G2b) — vẫn decision-gated; detector result_ref còn đỏ có chủ đích trong file sentinel thứ hai.
- Không tick gate, không commit, không chạy live; HEAD vẫn `b088eec`, hai file source đang nằm trong working tree (các lane khác cũng đang có thay đổi dở ở chính hai file này — delta của lane này là các hunk ở §1, không phải toàn bộ `git diff`).
