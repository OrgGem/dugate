# LDBA-09 unblock guide — review receipt, chốt ba điểm, và lệnh mở khóa rehearsal

Date: 2026-10-09
Coordinator: Claude Code (`term_19edcad8`)
Scope: du-rework only — coordinator metadata. Không sửa source, test, migration, adapter.
Nguồn: receipt `reports/ldba-09-runner-reconciliation.md` (owner Codex-4 `term_d93ff3b1`), spec `dispatch-specs/2026-10-09-LDBA-09-runner-reconciliation.md` (§9 errata), spec mới `dispatch-specs/2026-10-09-LDBA-09A-fixture-unblock.md`.

## 1. Kết luận review — hai phần, tách bạch

| Phần | Verdict | Cơ sở |
|---|---|---|
| Runner contract (W1) | **ACCEPTED** | 4 thay đổi đúng contract, 34/34 offline pass exit 0 |
| Rehearsal (W3/W4) | **BLOCKED** — nguyên nhân gốc là **một field** trong fixture, không phải runner, không phải schema | preflight dừng `BLOCKED_TARGET_CONFLICT`; đọc `001_connector.sql` + W3 + `mapConnector` là đủ để chứng minh |

**Verdict về hành vi owner:** owner **đúng**. Dừng đúng stop condition §7, không sửa lung tung, không bịa credential, không đụng file ngoài lease, container đã remove. Không phạt.

## 2. Verify độc lập — không tin receipt

Coordinator đã tự đọc, không dựa vào bản tóm tắt của owner:

1. `services/connector/src/db/migrations/001_connector.sql:1-9` — `connector_revisions.adapter TEXT NOT NULL`. Đây là nơi đòi.
2. `scripts/ldba-09-skip-fixture-adapter.cjs:27-36` — object `revision` được trả về **không có** `adapter`. Đây là nơi thiếu.
3. `scripts/ldba-03-backfill.cjs:496-512` — `mapConnector` chỉ validate `connector_id`, `revision`, `state`, `tenant_id`, `credential_ref`, `config`, `credential_source`. **Không** validate `adapter`. ⇒ Chỉ DB đòi, runner không đòi.

**Vì sao fix một field là đủ chứ không phải đoán** — đọc tiếp ba migration còn lại:

- `006_connector_revision_lifecycle.sql` thay CHECK state thành `PENDING/ACTIVE/RETIRED`. Runner dùng `RETIRED` cho DISABLED ⇒ **hợp lệ**. (Coordinator đã nghi ngờ đây là defect thứ hai; kiểm tra cho thấy là báo động giả.)
- `007_connector_credential_source.sql` backfill `credential_source` NOT NULL — fixture đã có.
- `008_connector_revision_binding.sql` đổi PK thành `(connector_id, tenant_id, revision)`, thêm trigger `connector_revisions_chain_guard`, thêm CHECK `tenant_id_shape`, `account_id_shape`, `credential_source_shape`, `credential_source_kind` (`legacy-db|vault-kv2`), `account_matches_source`, `vault_path_matches_binding`, `bound_source_is_vault` (`tenant_id = '' OR kind = 'vault-kv2'`).

Các field còn lại của fixture đã thỏa từng constraint: `tenant_id: ''` (UNBOUND) · `account_id: null` · `credential_source: {kind:'legacy-db', credentialRef}` khớp `credential_ref` · `credential_ref` distinct theo từng hàng nên không va chain guard.

## 3. Ba chốt của coordinator

Cả ba open item còn lại trong receipt đều hợp lệ và đều truy về spec hoặc W4 — **không** phải lỗi owner.

**Chốt 1 — AppSetting: giữ 2 hàng CÙNG `key`.**
Spec §3.4 yêu cầu hai hàng cùng slug workflow nhưng **khác** `key`. Điều này không thỏa được: `appSettingSlug(row)` (`ldba-03-backfill.cjs:650-654`) suy slug từ `row.key.slice('wb_schema:'.length)`, nên khác `key` là khác slug. Nguồn legacy thật cũng có `AppSetting.key` UNIQUE ⇒ va chạm khác-key không thể xảy ra. Chốt: giữ fixture hiện tại (2 hàng cùng `key` `wb_schema:analyze`). Nó vẫn chạy được nhánh winner/duplicate và chứng minh diagnostic in **key thật** chứ không phải `undefined` — assertion ở harness `:650-651` giữ nguyên, **không** sửa. Hệ quả trung thực phải ghi trong receipt: tiebreak tính định đoạt ở `:758` chỉ verify được bằng **đọc code**, không chứng minh được bằng fixture khác-key.

**Chốt 2 — User/assignment: cả 3 user pending, không bịa hash.**
Spec §3.4 yêu cầu 3 user đều skip pending-rehash **và** một assignment trỏ user đã ghi. Hai điều này mâu thuẫn trừ khi có sẵn hash scrypt hợp lệ — mà tạo hash trong fixture là vi phạm ranh giới. Chốt: giữ giải pháp của owner (cả 3 user pending; assignment[0] trỏ user pending ⇒ `ASSIGNMENT_USER_NOT_MIGRATED`; assignment[1] dùng `userId` non-UUID ⇒ `ASSIGNMENT_USER_ID_NOT_UUID`). Không tạo hash, không ghi `admin_local_users` trong rehearsal. Đường **ghi** assignment được bù bằng test offline ở W2.

**Chốt 3 — W4: sửa hai dòng bị hoán trong `assertReportSkips`.**
Seed `fixtureOverride(index)` gán `connectionId: CONNECTOR_IDS[index]`; runner check `OVERRIDE_CONNECTOR_NOT_MIGRATED` **trước** `OVERRIDE_CONNECTION_ID_NOT_UUID` (`ldba-03-backfill.cjs:549-554`). Nên expectation đúng là:

```
['ExternalApiOverride', OVERRIDE_IDS[1], 'OVERRIDE_CONNECTOR_NOT_MIGRATED'],
['ExternalApiOverride', OVERRIDE_IDS[2], 'OVERRIDE_CONNECTION_ID_NOT_UUID'],
```

Harness hiện ghi hai dòng này ngược nhau. Preflight dừng trước khi assertion này chạy nên chưa lộ — sẽ lộ ngay ở lượt 1 của LDBA-09A nếu không sửa.

Ba chốt này đã ghi vào **errata §9** của spec LDBA-09 để lưu vết.

## 4. Lệnh unblock — LDBA-09A

Owner: **Codex-4 `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6`** (đã verify live, idle tại prompt). Spec đầy đủ: `dispatch-specs/2026-10-09-LDBA-09A-fixture-unblock.md`. Tóm tắt phạm vi:

Ba thay đổi, tất cả trong file test-only:

1. **W3** `scripts/ldba-09-skip-fixture-adapter.cjs` — thêm `adapter` (string không rỗng, deterministic, rõ synthetic, ví dụ `synthetic-fixture-adapter:` + `row.id`) vào object `revision`. Không đổi field nào khác.
2. **W4** `scripts/ldba-09-harness.cjs` — sửa hai dòng hoán ở mục 3 trên.
3. **W2** `tests/ldba-03-runner-skip.test.cjs` — thêm **ít nhất 2** test offline đường **ghi**: `mapAssignment` với user đã ghi (ghi được hàng, không skip) và `mapConnector` với context trả `revision` đầy đủ gồm `adapter` (ghi được `connector_revisions` + `secret_versions`).

Rồi chạy lại **5 lượt** trên container disposable PG16 mới (`--network none`, tmpfs, không publish port, Node copy vào trong, áp cả hai bộ migration vào cùng container, remove sau khi xong):

| Lượt | Kỳ vọng |
|---|---|
| 1 | preflight `report` → `PREFLIGHT_READY` exit 0 |
| 2 | execute → `APPLIED` exit 0 |
| 3 | execute lần 2 → toàn bộ `identical` (idempotent) |
| 4 | preflight `fail` → `BLOCKED_SKIPPED_ROWS` exit 1 |
| 5 | adapter LDBA-08 → hết `INVALID_UUID` cho override, hết `TRANSFORM_ERROR` cho user; **còn** `TRANSFORM_ERROR` cho connector/profile/workflow/file là **đúng**, không phải hồi quy |

Offline gate vẫn phải xanh: `node --test tests/ldba-03-runner-skip.test.cjs tests/ldba-03-backfill-offline.test.cjs` exit 0.

**Dừng và ghi open item** nếu lượt 1 không ra `PREFLIGHT_READY` — khi đó `adapter` **không đủ** và cần coordinator chốt lại, không tự sửa thêm. Dừng đúng cách là hành vi được chấp nhận.

## 5. Ranh giới (nhắc lại, không nới)

Không sửa runner `ldba-03-backfill.cjs` · không sửa adapter LDBA-04/05/06/08 · không sinh hash · không nới `connector_prompt_overrides.connection_id` sang text · không thêm bảng vào `SKIP_POLICIES` · không đọc DB production/legacy/shared, không chạy migration/backfill lên DB thật · không dùng dữ liệu thật làm fixture · không commit, `git add`, push, không tick gate · container rehearsal phải remove.

## 6. Sau LDBA-09A

- **A1 (timezone legacy) vẫn mở.** Rehearsal chạy trên UTC tường minh, không chứng minh hành vi với nguồn legacy thật. Phải resolve trước khi chạy backfill thật.
- Sau khi LDBA-09A có receipt và rehearsal xanh, LDBA-09 mới đóng được acceptance đầy đủ; LDBA-07/08 vẫn NOT-PASS cho tới lúc đó.
- **Mẫu đã lặp 5 lần:** nguyên nhân gốc thuộc spec của coordinator (LDBA-06 R1..R3, LDBA-07, LDBA-08, LDBA-09), không phải lỗi owner. Bài học vận hành: khi viết fixture cho runner có contract validator, phải đọc DDL đích **trước** khi yêu cầu shape dữ liệu — validator của runner không phải bằng chứng cho tính đầy đủ của schema.

## 7. Ranh giới của chính file này

File này là coordinator report — metadata, không phải product code. Không tick gate nào, không commit, không `git add`, không push. Chưa chạy build/test/DB nào: mọi bằng chứng nêu ở đây là literal lấy từ receipt của owner hoặc từ đọc source trực tiếp; coordinator không tự chạy lại rehearsal.