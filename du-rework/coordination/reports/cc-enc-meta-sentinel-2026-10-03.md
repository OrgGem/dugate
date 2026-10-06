# ENC-META-SENTINEL — test plan §2 từ ENC-META-SCAN (TEST-ONLY) — cc_2

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Spec:** `cc-enc-meta-writer-scan-2026-10-03.md` §2 + dispatch `ENC-META-SENTINEL`.
- **Mode:** TEST-ONLY. 2 file test mới; **không sửa source production**; **không tick gate; không commit**; `nocobase-10` không bị nhắc.
- **Files thêm:** `services/orchestrator/tests/enc-meta-sentinel-outbox-source-url.test.ts` (G1), `services/orchestrator/tests/enc-meta-sentinel-runtime-refs.test.ts` (G2). Không file nào khác trong repo bị thay đổi bởi lane này.

**TL;DR (VI):** Đã hiện thực 3 ưu tiên (sourceUrl outbox, `result_ref`, `human_waits`) qua `createApp` + fake PG + fake crypto seam + sentinel-leak helper. Kết quả: **6/8 pass; 2 test đỏ CHÍNH LÀ 2 finding** (đúng thiết kế gap-detector): (G1) `sourceUrl` plaintext trong `outbox.payload`; (G2) `result_ref` plaintext trên cả `tasks` lẫn `operations`. Các phần đã seal (submit, dispatcher gate-filter, HITL resume) **xanh**. Đính chính so với scan trước: URL **không** đi vào Redis — dispatcher loại `gate='ingestion'`; gap chỉ ở cột PG `outbox.payload`. Blocker ngoài lease: `src/server.ts:637` đang có lỗi TS của lane khác → mọi suite import server.ts chết compile; đã chạy bằng config scratch loại diagnostics đúng 1 file đó (ghi rõ §4).

## 1. Test đã hiện thực

| File | Case | Loại | Kỳ vọng |
|---|---|---|---|
| `enc-meta-sentinel-outbox-source-url.test.ts` | G1a submit URL: 2 cột seal, mở lại đúng `{input, sourceUrl, ingestionState}` | GREEN | pass |
| | G1b FINDING pin: outbox payload hiện chứa `sourceUrl` plaintext | GREEN (pin hiện trạng) | pass |
| | G1c **RED detector**: outbox payload không được chứa sentinel | GAP | **fail hôm nay** |
| | G1d dispatcher KHÔNG publish row `gate='ingestion'`; row publish được chỉ chứa refs | GREEN | pass |
| `enc-meta-sentinel-runtime-refs.test.ts` | G2a FINDING pin: `result_ref` lưu verbatim trên `tasks` + `operations` | GREEN (pin) | pass |
| | G2b **RED detector**: `result_ref` không được plaintext | GAP (cần quyết định slot) | **fail hôm nay** |
| | G2c FINDING pin: `human_waits.ui_schema` + `context_ref` verbatim (không slot) | GREEN (pin) | pass |
| | G2d HITL resume: `response_ref` + resume `payload_ref` + outbox row đều không sentinel, mở lại đúng giá trị | GREEN | pass |

Harness (offline hoàn toàn): `jest.mock('pg')` scripted Pool + `jest.mock('bullmq')` bắt `Queue.add` + reversible Vault Transit stand-in + helper `leaksSentinel` (quét mọi depth, kể cả base64) — theo đúng mẫu `crx01-creatapp-metadata-seam.test.ts`. Không cần PG/Redis/Vault/S3 thật.

## 2. Kết quả chạy (literal)

**Cwd:** `D:\Git\dugate\du-rework\services\orchestrator`.

### 2.1 Blocker: lỗi TS của lane khác trong `src/server.ts`

Lần chạy bằng config mặc định của repo **không compile được** (không phải do test mới):

```
$ set NODE_ENV=test && npx jest --runInBand tests/enc-meta-sentinel-outbox-source-url.test.ts
  src/server.ts:637:46 - error TS2339: Property 'migrationWindow' does not exist on type
  '{ backend: "postgres"; } | { backend: "s3"; ... migrationWindow?: boolean ... }'
  Test Suites: 1 failed, 1 total — Tests: 0 total
```

Cùng lỗi với suite có sẵn (chứng minh không phải do lane này):

```
$ npx jest --runInBand tests/crx01-creatapp-metadata-seam.test.ts
  src/server.ts:637:46 TS2339 … → Test Suites: 1 failed, 1 total
```

`src/server.ts` đang `M` (+211/−45 so với HEAD `b088eec`) — lane CRX-02/RFX đang sửa dở. **Không sửa** (ngoài lease).

### 2.2 Chạy được bằng config scratch (loại diagnostics đúng 1 file foreign)

`--config <scratchpad>\enc-meta-jest.config.cjs` — như `jest.config.cjs` của repo nhưng `ts-jest.diagnostics.exclude = ['**/src/server.ts']` (mọi file khác, gồm test mới, **vẫn được type-check**):

```
$ npx jest --runInBand --config …\enc-meta-jest.config.cjs \
    tests/enc-meta-sentinel-outbox-source-url.test.ts tests/enc-meta-sentinel-runtime-refs.test.ts --verbose
JEST_EXIT=1
  √ GREEN: seals both control-plane columns and the envelope opens back to input + sourceUrl
  √ FINDING pin: the outbox payload currently carries sourceUrl in plaintext
  × RED GAP DETECTOR: the outbox payload must not carry sourceUrl plaintext          ← finding G1
  √ GREEN: the dispatcher never publishes gate=ingestion rows, and published rows carry references only
  √ FINDING pin: completeTask stores result_ref verbatim on BOTH tasks and operations
  × RED GAP DETECTOR: result_ref must not rest as plaintext on either row            ← finding G2
  √ FINDING pin: waitInput stores ui_schema and context_ref verbatim (no slot exists)
  √ GREEN: resumeOperation seals response_ref + resume payload; the dispatch row carries references only
Test Suites: 2 failed, 2 total
Tests:       2 failed, 6 passed, 8 total
```

Hai test đỏ fail đúng chỗ (đều `Expected: false, Received: true` — tức sentinel **có mặt** trong giá trị persist). Chạy lại với exclude mở rộng (`**/src/**`) cho kết quả y hệt → không có lỗi TS nào khác lẫn vào.

### 2.3 `tsc --noEmit` (theo acceptance)

```
$ npx tsc --noEmit -p tsconfig.json
TSC_EXIT=2
  src/server.ts(637,46): error TS2339: Property 'migrationWindow' does not exist on …
```

**Đúng 1 lỗi, thuộc file của lane khác** (đã xác minh bằng cách chạy lại sau đó — vẫn còn). Type của 2 test mới được ts-jest kiểm với diagnostics bật cho mọi file trừ `src/server.ts` (mục 2.2); không có lỗi TS nào từ test mới. Sau khi lane kia sửa, chạy lại `npx jest --runInBand tests/enc-meta-sentinel-*.test.ts` bằng config mặc định là đủ.

## 3. Findings từ test (kết quả đúng theo dispatch: lộ plaintext thì ghi finding, không sửa source)

| ID | Writer | file:line | Bằng chứng test | Mức độ / xử lý |
|---|---|---|---|---|
| **G1** | `outbox.payload` của URL submission | `submission.ts:344-356` (`sourceUrl:` :355) | G1b pin: `payload.sourceUrl === SOURCE_URL`, `leaksSentinel=true` tại tham số `$3` của `INSERT INTO outbox`; G1c đỏ | **Đính chính scan trước:** URL chỉ nằm plaintext ở **cột PG outbox**; **không vào Redis** — dispatcher loại `gate='ingestion'` (dispatcher.ts:41; G1d xanh) và row publish thật (`gate:'ready'`) chỉ chứa refs. Fix cần quyết định nhỏ: consumer đang đối chiếu `payload.sourceUrl` với envelope sealed (ingestion-consumer.ts:570) — có thể bỏ khỏi payload (lấy từ envelope), thay bằng digest, hoặc seal (thêm slot không cần thiết nếu chọn 2 cách đầu) |
| **G2** | `tasks.result_ref`, `operations.result_ref` | `runtime.ts:545,568` | G2a pin: cả hai tham số `result_ref=$2` chứa `RESULT_REF` (sentinel) verbatim; G2b đỏ | Worker-supplied string; muốn seal phải **thêm `METADATA_SLOTS` entry + migration + đổi read path** (FINDING này đã được pin từ trước ở `runtime-encryption-metadata.test.ts:603-617`). Cần quyết định contracts |
| **G2b** | `human_waits.input_schema`/`ui_schema`/`context_ref` | `runtime.ts:958-970` | G2c pin: `ui_schema` + `context_ref` chứa sentinel; `input_schema` không (control) | Không có slot; cần quyết định policy — test chỉ pin, không có detector (fix không thể cục bộ) |
| GREEN | submit 2 cột + dispatcher filter + HITL resume (response_ref, resume payload_ref, outbox) | submission.ts:254-255/471-477; runtime.ts:1073-1081, 1100-1107 | G1a, G1d, G2d | Đang đúng — giữ làm regression khi các fix G1/G2/G2b được thực hiện |

## 4. Chưa hiện thực được / chưa làm (và lý do)

- **T1 child spawn, T2 join merge, T4 checkpoint** (`runtime.ts:811-824`, `1474-1489`, `463-477`): **offline khả thi** nhưng cần model scripted-PG lớn hơn (nhiều statement trạng thái child/parent). Không nằm trong 3 ưu tiên của dispatch → để lượt sau; cấu trúc mock hiện tại đã sẵn để mở rộng.
- **T7 log scan, T9 artifact `file_name`, T10 S3 bytes, T11 usage payload**: T7/T9/T10 kỹ thuật offline khả thi (mock console/stdout; scripted pg bắt INSERT artifacts; stub `s3Client.send` bắt `PutObject` body) nhưng ngoài 3 ưu tiên; T11 cần schema cho phép field text (hiện là số/ids — nhiều khả năng không chứa sentinel hợp lệ, cần xác nhận schema trước khi viết test có nghĩa).
- **G2b detector** (đòi seal `human_waits` schema/context): không viết vì đây là quyết định contracts/slot, không thể xanh bằng fix cục bộ — viết detector sẽ tạo test đỏ vĩnh viễn không có chủ.
- **Live**: byte-scan S3/Redis/PG thật, Vault outage thật, worker temp — giữ nguyên trong §4 của receipt scan.

## 5. Ghi chú vận hành

- File config scratch nằm ngoài repo: `<scratchpad>/enc-meta-jest.config.cjs` — chỉ dùng để vượt blocker ngoài lease; **không phải deliverable**. Khi `src/server.ts:637` được lane sở hữu sửa, chạy lại bằng config mặc định và xoá workaround.
- Không tick gate, không commit. HEAD vẫn `b088eec`; ngoài 2 test mới + receipt này, lane không thay đổi file nào.
