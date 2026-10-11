# Verify độc lập (DSH) — MDB-POLICY-02 profiles policy — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet MDB-POLICY-02.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code (không revert, không mutation tạm, không sửa file ngoài lease); **KHÔNG** tick gate; artifact ghi thêm: receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator`.
**Node:** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-mdb-policy-02-2026-10-10/DSH/` (`p02-run1..3.log`, `p01-delta.log`, `tsc.log`, `SHA256SUMS.txt`).

## 0. Đối tượng kiểm (digest khớp receipt gốc)

| File | Dòng (đo) | sha256 |
|---|---:|---|
| `scripts/ldba-context-provider.cjs` | 371 | `aa2fe74d9d07e352af6a9ee09aa6573c722048543af0cff62aa325ca93d35d9b` |
| `tests/mdb-policy-02-profiles.test.cjs` | 238 | `ae2ecdbb068a84a2b3b12303d530859be246cb9b8df8691a1d77e601a262847a` |
| `tests/mdb-policy-01-connector.test.cjs` (ngoài lease) | — | `b51bccaddfce2476a493b823b9cc44cdea12630f70f7d48495829da91104d45d` |

Digest provider **khớp hash sau** mà receipt §2.1 khai; digest test 02 khớp §2.2; digest test 01 khớp hash mà lượt verify trước của tôi đã ghi ⇒ **file ngoài lease không bị sửa**.

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node --test tests/mdb-policy-02-profiles.test.cjs` (lần 1) | **0** | `# tests 19` · `# pass 19` · `# fail 0` |
| 2 | y hệt, lần 2 (tiến trình riêng) | **0** | `# tests 19` · `# pass 19` · `# fail 0` |
| 3 | y hệt, lần 3 (tiến trình riêng) | **0** | `# tests 19` · `# pass 19` · `# fail 0` |
| 4 | `node --check scripts/ldba-context-provider.cjs` | **0** | không output |
| 5 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |
| 6 | `node --test tests/mdb-policy-01-connector.test.cjs` (kiểm Δ1) | **1** | `# tests 20` · `# pass 19` · `# fail 1` — xem §3 |

⇒ Suite mới **19/19 xanh, 3/3 lượt exit 0**; syntax + typecheck exit 0 — trùng khớp receipt §4.3/§4.4.

## 2. Tính đúng đắn của 2 callback (đọc trực tiếp provider)

- **`resolveProfileName`** (`scripts/ldba-context-provider.cjs:292`) với tiền tố literal `PROFILE_NAME_PREFIX = 'Imported '` (`:279`): tên suy từ `endpointSlug`, không suy từ business/action. Lý do đọc được từ code + contract: hàng legacy (`lib/db/schema.ts:122-137`) **không có** cột name/business/action; runner tra registry bằng chính slug nên `action === endpointSlug` tại thời điểm callback chạy; `profile_names` unique gồm `profile_name` nên tên suy từ slug tránh va chạm nếu sau này nhiều slug map về một action (receipt §3.1). Slug không dùng được ⇒ trả chuỗi rỗng để runner báo `INVALID_PROFILE_NAME` (§1 của receipt) — đúng hợp đồng runner `ldba-03-backfill.cjs:591-593`.
- **`normalizeConnectionsOverride`** (`:347`): luôn trả **array mới**; guard `if (!Array.isArray(value)) return null;` (`:338`) cho nhánh wrapper; chỉ giữ field schema-valid qua `CONNECTION_STEP_AUXILIARY_KEYS = ['stepId', 'captureSession', 'injectSession']` (`:313`) — tức `slug` + 3 key phụ, khớp `ConnectionStepSchema` strict (4 key). Entry không có slug dùng được bị **bỏ**; field phụ sai kiểu bị **bỏ field, giữ hợp**. Cách này tránh đúng lớp bẫy của MDB-POLICY-01 (ghi jsonb trực tiếp không re-validate): ở đây chỉ emit shape đã hợp schema.
- Cả hai hàm nằm trong khối export đóng băng (`:364-365`), `prepareConnector` giữ nguyên, 6 callback còn lại vẫn fail-closed (`:358-359` comment nêu rõ) — khớp mô tả receipt §2.1.
- Ghi chú đo: provider 371 dòng (receipt ghi +105 so với 267 ⇒ kỳ vọng 372; lệch 1 dòng do quy ước đếm dòng cuối, không phải thiếu nội dung).

## 3. Δ1 — hậu quả guard staleness tại `mdb-policy-01-connector.test.cjs:292` (tái lập độc lập)

Chạy lại suite policy-01 sau khi policy-02 land:

```
# tests 20 | # pass 19 | # fail 1        REAL_EXIT=1
not ok 20 - every other context callback stays fail-closed until its own policy lands
error: 'Missing expected exception.'
```

- Guard tại `:292-300` lặp **6 callback** (`resolveProfileName`, `normalizeConnectionsOverride`, `prepareWorkflowSchema`, `readFileCacheBytes`, `artifactTokenFor`, `artifactPurposeFor`) và đòi mỗi cái ném `CONTEXT_POLICY_REQUIRED`. Hai callback đầu **đã land policy thật**, nên assertion đầu tiên fail với `Missing expected exception` — **đúng nguyên nhân**, không phải lỗi khác.
- **Đây là guard cũ nay stale theo thiết kế**, không phải regression hành vi: spec MDB-POLICY-02 chỉ yêu cầu **5 callback còn lại** giữ fail-closed, còn `resolveProfileName`/`normalizeConnectionsOverride` phải trở thành policy thật. File này **ngoài lease** và **không bị sửa** (digest không đổi) — cùng một lớp với phát hiện trước đó ở `mdb-01-composition-provider.test.ts:41`.
- **Hệ quả cần coordinator adjudicate:** hiện có **2 test đỏ** trong lane kiểm thử orchestrator do các policy land dần — (a) `mdb-01-composition-provider.test.ts:41` (từ MDB-POLICY-01), (b) `mdb-policy-01-connector.test.cjs:292` (từ MDB-POLICY-02). Cả hai đều là **assertion hợp đồng cũ**, cần cập nhật danh sách/giá trị kỳ vọng theo contract mới (không phải sửa code sản phẩm).

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite MDB-POLICY-02 (19 test) | **PASS** — 3/3 lượt exit 0 |
| `resolveProfileName` | **ĐẠT** — suy tên từ slug, đúng dạng `Imported <slug>`, fail-closed bằng chuỗi rỗng cho slug không dùng được |
| `normalizeConnectionsOverride` | **ĐẠT** — luôn array mới, chỉ emit shape hợp strict schema, an toàn null/scalar/entry hỏng |
| Syntax + typecheck | **ĐẠT** — `node --check` exit 0, `tsc --noEmit` exit 0 |
| Digest provider/test | **KHỚP** receipt gốc |
| Δ1 (guard policy-01 stale) | **TÁI LẬP ĐỘC LẬP** — 1 test đỏ tại `:292`, đúng nguyên nhân, cần adjudicate (ngoài lease) |

⇒ **MDB-POLICY-02: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline (19/19 ×3, syntax + tsc 0)**, với 1 hậu quả ngoài lease cần coordinator xử lý. Không tick gate.

## 5. GAP / open items

1. **Δ1 cần adjudicate:** cập nhật guard `tests/mdb-policy-01-connector.test.cjs:292-296` để chỉ còn 4 callback chưa land, hoặc giao owner MDB-POLICY-01. Tới lúc đó suite policy-01 **không xanh** (19/20).
2. **Việc cập nhật assertion MDB-01 (`mdb-01-composition-provider.test.ts:41`) vẫn treo** từ lượt trước — nay cộng thêm Δ1 ⇒ lane orchestrator có **2 test đỏ** thuộc hợp đồng cũ.
3. **Δ2 (receipt §8):** mất dữ liệu ở tầng step là **vô hình** — runner chỉ kiểm `Array.isArray`, không có kênh per-step, nên entry bị bỏ không xuất hiện trong report; muốn step-level integrity cần packet riêng.
4. **Δ4 (receipt §8):** chưa chứng minh **đường ghi thật** (`profile_names` insert + unique index) — không có PG rehearsal trong lượt này; bằng chứng hiện có là hợp đồng đọc từ migration/contracts + test offline. A1 timezone vẫn mở.
5. **Δ3/Δ5 (receipt §8):** nhánh wrapper là phòng thủ không có writer legacy; `endpointSlug` compound sẽ `UNMAPPED_ENDPOINT` ở `resolveBusiness` **trước** khi tới `resolveProfileName` — tôi đọc code xác nhận logic, **chưa chạy**.
6. **Chưa commit:** provider + test 02 là `??` untracked ⇒ kết quả gắn digest §0.

## 6. Xác nhận

- Không `git add`, không commit, không push (không có gì staged); không tick gate; không sửa source/test (kể cả không sửa guard stale ngoài lease và không revert để lấy RED).
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
