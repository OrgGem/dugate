# DISPATCH — LDBA-09A — Unblock rehearsal fixture (W3 adapter field + W4 expectation swap)

Date: 2026-10-09
Owner: Codex-4 — `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` (live roster, verified idle at prompt)
Predecessor: LDBA-09 (`dispatch-specs/2026-10-09-LDBA-09-runner-reconciliation.md`, receipt `reports/ldba-09-runner-reconciliation.md`)
Scope: du-rework only

## 0. Vì sao có packet này

Receipt LDBA-09 đã được coordinator review **đầy đủ, không tin vào lời khai**. Kết quả review:

- **Phần runner của LDBA-09 là tốt và giữ nguyên.** Bốn thay đổi contract (`RowSkip` + `SKIP_POLICIES` allowlist 4 bảng, pending-rehash identity, diagnostic `row.key`, `LDBA_SKIP_POLICY`) đã verify đúng trên source và có 34/34 offline test. **Không** sửa runner trong packet này.
- **Rehearsal bị chặn bởi một lỗi fixture duy nhất, không phải lỗi runner hay schema.** Coordinator đã đọc trực tiếp `services/connector/src/db/migrations/001_connector.sql:1-9` (`adapter TEXT NOT NULL`) và `scripts/ldba-09-skip-fixture-adapter.cjs:27-36` (object `revision` **không** có `adapter`). Runner `mapConnector` (`ldba-03-backfill.cjs:496-512`) **không** đòi `adapter` — chỉ DB đòi. ⇒ Fix là **một field** trong file test-only.
- **Coordinator đã chứng minh field này là đủ**, không chỉ hợp lý: đọc `006_connector_revision_lifecycle.sql` (thay CHECK state thành `PENDING/ACTIVE/RETIRED` ⇒ `RETIRED` hợp lệ, không phải defect), `007_connector_credential_source.sql` (backfill `credential_source` NOT NULL), `008_connector_revision_binding.sql` (PK `(connector_id, tenant_id, revision)`, trigger `connector_revisions_chain_guard`, CHECK `tenant_id_shape`, `bound_source_is_vault` = `tenant_id = '' OR kind = 'vault-kv2'`). Các field còn lại của fixture (`tenant_id: ''`, `account_id: null`, `credential_source: {kind:'legacy-db', credentialRef}`, `credential_ref` distinct theo từng hàng) **đã thỏa mọi** constraint và chain guard. ⇒ Thêm `adapter` là unblock thật.
- **Hai mâu thuẫn fixture còn lại trong spec LDBA-09 §3.4 là lỗi của coordinator**, đã được owner khai trung thực. Coordinator chốt lại ở mục 3 — owner **không** tự sửa, chỉ thực hiện đúng chốt này.

## 1. Vùng lease — chốt cụ thể

### 1.1. File **được VIẾT** (lease)

| W | File | Thay đổi duy nhất được phép |
|---|---|---|
| W2 | `services/orchestrator/tests/ldba-03-runner-skip.test.cjs` | Thêm test offline đường **ghi** (xem §2.3). Không xoá/sửa test hiện có. |
| W3 | `services/orchestrator/scripts/ldba-09-skip-fixture-adapter.cjs` | Thêm field `adapter` vào object `revision` (xem §2.1). Không thay đổi khác. |
| W4 | `services/orchestrator/scripts/ldba-09-harness.cjs` | Sửa hai dòng trong `assertReportSkips` (xem §2.2). Không thay đổi khác. |
| W5 | `du-rework/coordination/reports/ldba-09A-fixture-unblock.md` | Receipt mới. |

### 1.2. File **chỉ ĐỌC** (không sửa)

- `services/orchestrator/scripts/ldba-03-backfill.cjs` — runner, đã ACCEPTED ở LDBA-09.
- `services/orchestrator/scripts/ldba-03-production-adapter.cjs` — adapter production LDBA-08.
- `services/connector/src/db/migrations/001..009_*.sql` — bộ migration connector.
- `services/orchestrator/migrations/001..0037_*.sql` — bộ migration orchestrator.

### 1.3. **Ngoài lease** (cấm sửa)

Mọi file ngoài bảng §1.1. Đặc biệt: migration, contract, catalog, crypto, BFF, UI, adapter LDBA-04/05/06, adapter LDBA-08, plan, spec LDBA-09.

## 2. Ba thay đổi bắt buộc

### 2.1. W3 — thêm `adapter` vào `revision`

Trong `prepareConnector`, object `revision` được trả về **phải** chứa field `adapter`:

- Kiểu `string`, **không rỗng**, thỏa `connector_revisions.adapter TEXT NOT NULL` (`001_connector.sql:3`).
- Giá trị **deterministic** và **rõ ràng là synthetic** — ví dụ `'synthetic-fixture-adapter:' + row.id`. **Không** dùng giá trị trông giống adapter production thật.
- **Không** đổi bất kỳ field nào khác của `revision` hay `secret`. Đặc biệt giữ nguyên `tenant_id: ''`, `account_id: null`, `credential_source: {kind:'legacy-db', credentialRef}`, `credential_ref` distinct theo hàng.

### 2.2. W4 — sửa hai dòng bị hoán trong `assertReportSkips`

Seed `fixtureOverride(index)` đặt `connectionId: CONNECTOR_IDS[index]`. Với `CONNECTOR_IDS[1]` là connector bị skip (auth type không được duyệt) và `CONNECTOR_IDS[2]` là connector id **text** đã ghi, thứ tự check của runner (`ldba-03-backfill.cjs:549-554`: `OVERRIDE_CONNECTOR_NOT_MIGRATED` check **trước** `OVERRIDE_CONNECTION_ID_NOT_UUID`) cho kết quả đúng là:

```
['ExternalApiOverride', OVERRIDE_IDS[1], 'OVERRIDE_CONNECTOR_NOT_MIGRATED'],
['ExternalApiOverride', OVERRIDE_IDS[2], 'OVERRIDE_CONNECTION_ID_NOT_UUID'],
```

Danh sách expected hiện có hai dòng này **bị hoán** ⇒ sửa về đúng thứ tự trên. Đây là bug thật của W4, coordinator đã verify bằng cách đọc seed + thứ tự check của runner.

### 2.3. W2 — thêm test offline đường **ghi** (bắt buộc, phạm vi nhỏ)

Rehearsal không chạy được đường **ghi** `user_profile_assignments` (xem mục 3.2) nên phải có bằng chứng offline. Thêm **ít nhất 2** test vào W2, dùng fake context có sẵn (không cần DB):

1. `mapAssignment` với user đã ghi → **ghi được** hàng assignment, không skip.
2. `mapConnector` với context trả `revision` đầy đủ (gồm `adapter`) → **ghi được** `connector_revisions` + `secret_versions`, không `INVALID_CONNECTOR_ADAPTER_OUTPUT`.

Không thêm test ngoài hai đường này.

## 3. Chốt lại hai mâu thuẫn fixture của spec LDBA-09 §3.4

### 3.1. AppSetting — chốt lại là **cùng key**

Spec §3.4 yêu cầu 2 hàng cùng slug workflow, cùng `updatedAt`, **khác `key`**. Điều này **không thỏa được**: `appSettingSlug(row)` (`ldba-03-backfill.cjs:650-654`) suy slug từ `row.key.slice('wb_schema:'.length)` ⇒ hàng khác `key` thì **luôn** khác slug.

**Chốt:** giữ nguyên fixture hiện tại — 2 hàng **cùng** `key` (`wb_schema:analyze`), cùng `updatedAt`, cùng value. Điều này vẫn chạy được nhánh winner/duplicate và chứng minh `:773-774` in **key thật** (`wb_schema:analyze`) chứ không phải `undefined` — assertion `winner`/`skipped` hiện có ở harness `:650-651` giữ nguyên, không sửa.

**Ghi rõ trong receipt:** nguồn legacy thật có `AppSetting.key` UNIQUE nên va chạm **khác key** là không thể xảy ra; tiebreak tính định đoạt ở `:758` (đọc `row.key` thay `row.id`) chỉ verify được bằng **đọc code**, không chứng minh được bằng fixture khác-key. Đây là giới hạn trung thực, không phải lỗi.

### 3.2. User / assignment — chốt lại là **cả 3 user pending**, không bịa hash

Spec §3.4 yêu cầu 3 user đều skip `IDENTITY_PENDING_REHASH` **và** 1 trong 2 assignment trỏ tới user đã ghi. Hai điều nài **mâu thuẫn** nhau trừ khi có sẵn một hash scrypt hợp lệ — mà việc tạo hash trong fixture là vi phạm ranh giới §6 của LDBA-09.

**Chốt:** giữ nguyên giải pháp của owner — cả 3 user pending; assignment thứ nhất trỏ user pending (skip `ASSIGNMENT_USER_NOT_MIGRATED`), assignment thứ hai dùng `userId` **non-UUID** (skip `ASSIGNMENT_USER_ID_NOT_UUID`). **Không** tạo hash, **không** ghi `admin_local_users` trong rehearsal. Đường ghi assignment được bù ở W2 (mục 2.3).

## 4. Chạy lại rehearsal — năm lượt bắt buộc

Dựng lại container disposable PG16 theo đúng kỹ thuật §3.1-3.3 của LDBA-09: `--network none`, tmpfs, **không** publish port, Node copy vào trong, áp **cả hai** bộ migration vào cùng container, seed synthetic UTC tường minh. Container mới, tên mới, **remove sau khi xong**.

| Lượt | Lệnh (môi trường) | Kỳ vọng |
|---|---|---|
| 1 | `LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<W3> LDBA_SKIP_POLICY=report ... --preflight` | `PREFLIGHT_READY`, exit 0 |
| 2 | Cùng fixture, `report ... --execute` | `APPLIED`, exit 0 |
| 3 | Cùng fixture, `report ... --execute` (lần 2) | toàn bộ `identical` (idempotent) |
| 4 | `LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<W3> LDBA_SKIP_POLICY=fail ... --preflight` | `BLOCKED_SKIPPED_ROWS`, exit 1 |
| 5 | `LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<adapter LDBA-08> ... --preflight` | **không** còn `INVALID_UUID` cho override; **không** còn `TRANSFORM_ERROR` cho user; **còn** `TRANSFORM_ERROR` cho connector/profile/workflow/file — đây là **đúng**, không phải hồi quy |

**Đối chiếu source/target counts** cho từng entity trong `DESTINATION_ORDER` ở Lượt 1. **Zero parse failure** ngoài các skip đã liệt kê ở §2.2 + mục 3.

## 5. Tiêu chí nghiệm thu

- [ ] W3 `revision` có `adapter` là string không rỗng, deterministic, rõ synthetic.
- [ ] W3 không đổi field nào khác.
- [ ] W4 `assertReportSkips` khớp đúng thứ tự §2.2.
- [ ] W2 có ≥2 test đường ghi theo §2.3; toàn bộ W2 pass exit 0.
- [ ] Offline: `node --test tests/ldba-03-runner-skip.test.cjs tests/ldba-03-backfill-offline.test.cjs` pass exit 0.
- [ ] `node --check` pass W2 + W3 + W4.
- [ ] Lượt 1 `PREFLIGHT_READY` exit 0.
- [ ] Lượt 2 `APPLIED` exit 0.
- [ ] Lượt 3 toàn bộ `identical`.
- [ ] Lượt 4 `BLOCKED_SKIPPED_ROWS` exit 1.
- [ ] Lượt 5 đúng kỳ vọng bảng §4.
- [ ] Source/target counts khớp từng entity; zero parse failure ngoài skip đã liệt kê.
- [ ] `report.workflowDuplicates` in key thật, không phải `undefined`.
- [ ] Receipt ghi rõ mục 3.1 (AppSetting cùng key + giới hạn tiebreak) và mục 3.2 (không bịa hash).
- [ ] Receipt ghi **A1 vẫn mở** — rehearsal UTC không đóng A1.
- [ ] Receipt **không** ký tự nháy kép, **không** trailing whitespace.
- [ ] Container rehearsal đã remove; ghi tên container.

## 6. Ranh giới (bắt buộc)

- **KHÔNG** đọc DB production/legacy/shared. Chỉ container disposable.
- **KHÔNG** chạy migration hay backfill lên DB thật.
- **KHÔNG** sửa runner `ldba-03-backfill.cjs`.
- **KHÔNG** sửa adapter production LDBA-08 hay adapter LDBA-04/05/06.
- **KHÔNG** sinh hash scrypt, hash giả, hay ghi `admin_local_users` trong rehearsal.
- **KHÔNG** nới `connector_prompt_overrides.connection_id` sang text.
- **KHÔNG** thêm bảng vào `SKIP_POLICIES`.
- **KHÔNG** thay đổi seed ngoài phạm vi đã chốt ở mục 3.
- **KHÔNG** commit, `git add`, push, không tick gate.
- **KHÔNG** để container rehearsal sau khi xong (remove).
- **KHÔNG** dùng dữ liệu thật làm fixture.

## 7. Khi nào **phải dừng**

Dừng và ghi `Open items for coordinator` nếu:

- Lượt 1 không ra `PREFLIGHT_READY` (nghĩa là `adapter` là **không đủ** — ghi đúng code lỗi và column bị từ chối).
- Lượt 2 không ra `APPLIED`.
- Lượt 3 có bất kỳ hàng nào không `identical`.
- Lượt 4 không ra `BLOCKED_SKIPPED_ROWS`.
- Lượt 5 vẫn còn `INVALID_UUID` cho override hoặc `TRANSFORM_ERROR` cho user.
- Bất kỳ skip nào ngoài danh sách đã chốt ở §2.2 + mục 3.
- Bất kỳ parse failure không giải thích được.
- Bất kỳ yêu cầu nào ở §6.

**Dừng đúng cách là hành vi được chấp nhận.**

## 8. Dispatch proof

- Owner: Codex-4, `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` — verify live trước khi dispatch: terminal còn trong roster, trạng thái idle tại prompt, không có tiến trình chạy.
- Receipt: `du-rework/coordination/reports/ldba-09A-fixture-unblock.md`.
- Coordinator: Claude Code (`term_19edcad8`), 2026-10-09.
