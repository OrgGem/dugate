# LDBA-09 Verify (độc lập, lane DSH) — LDBA-09B rehearsal unblock — 2026-10-09

**Vai trò:** tester độc lập (term_8bfe6adc), KHÔNG phải implementer LDBA-09B.
**Đường dẫn receipt:** packet yêu cầu `du-rework/coordination/reports/ldba-09-verify.md`, nhưng **đường dẫn đó đã có receipt của lane khác** (24 dòng, cũng xác nhận LDBA-09B). Tôi **không ghi đè**; receipt độc lập của tôi nằm ở path hậu tố lane này và có mục đối chiếu ở §5.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy; **KHÔNG** git commit / `git add` / push; **KHÔNG** tick gate nào; không sửa source/test.
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233` · **node** `C:\Users\Gem\.local\share\deepseek-cli\node_modules\node\bin\node.exe` = **v22.23.3**.
**Raw:** `du-rework/coordination/reports/raw/ldba-09-2026-10-09/` (`lenh1-stdout.log`, `lenh1-stderr.log`, `lenh2-stdout.log`, `lenh2-stderr.log`).

## 0. Đối tượng kiểm (4 file, đều untracked `??`)

| File | Dòng | sha256 (16 ký tự đầu) |
|---|---:|---|
| `tests/ldba-03-runner-skip.test.cjs` | 468 | `0413357c25026163` |
| `tests/ldba-03-backfill-offline.test.cjs` | 511 | `94f1baab8a63a85c` |
| `tests/ldba-03-production-adapter.test.cjs` | 328 | `70781fb52d9228dc` |
| `scripts/ldba-09-harness.cjs` | 773 | `7fb6c385a6b2e6e8` |

## 1. LỆNH 1 — `node --test` (3 file) → **PASS**

```
node --test tests/ldba-03-runner-skip.test.cjs tests/ldba-03-backfill-offline.test.cjs tests/ldba-03-production-adapter.test.cjs
```
**REAL_EXIT = 0** (đo bằng `$LASTEXITCODE` ngay sau lệnh) · stdout 17 724 byte · stderr **0 byte**.

Literal (stdout, dòng tổng kết của node test runner):
```
# tests 42
# pass 42
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 141.8187
```
⇒ **42/42 test pass, 0 fail, 0 skipped** trên cả 3 file. Danh sách `ok <số> - <tên test>` có 38 dòng khớp mẫu đầu dòng (một số dòng con bị thụt lề nên không khớp mẫu; con số chuẩn là 42 của runner).

## 2. LỆNH 2 — `node scripts/ldba-09-harness.cjs` → **PASS (5/5 vòng đạt đúng kỳ vọng)**

```
node scripts/ldba-09-harness.cjs
```
**REAL_EXIT = 0** · stdout 77 160 byte · stderr 0 byte.

Đối chiếu **mốc kỳ vọng** với **dòng RUNNER thật**:

| Vòng | Dòng RUNNER (nguyên văn) | Runner exit | Status | Mốc harness | Kết luận |
|---|---|---:|---|---|---|
| 1 | `RUNNER ldba-09-skip-fixture-adapter.cjs --preflight policy=report` | 0 | `PREFLIGHT_READY` | `FIXTURE_PREFLIGHT_READY` | PASS |
| 2 | `RUNNER ldba-09-skip-fixture-adapter.cjs --execute policy=report` (lần đầu) | 0 | `APPLIED` | `FIXTURE_APPLIED_FIRST` | PASS |
| 3 | `RUNNER ldba-09-skip-fixture-adapter.cjs --execute policy=report` (chạy lại) | 0 | `APPLIED` | `FIXTURE_APPLIED_REPLAY_ALL_IDENTICAL` | PASS (idempotent) |
| 4 | `RUNNER ldba-09-skip-fixture-adapter.cjs --preflight policy=fail` | 1 | `BLOCKED_SKIPPED_ROWS` | `FIXTURE_FAIL_POLICY_BLOCKED` | PASS (âm tính có chủ đích) |
| 5 | `RUNNER ldba-03-production-adapter.cjs --preflight policy=default` | 1 | `BLOCKED_TRANSFORM` | `LDBA08_REGRESSION_EXPECTED_CONTEXT_FAILURES` | PASS (âm tính có chủ đích) |

Bằng chứng idempotency vòng 3: toàn bộ 20 mục `preflight` của lần execute thứ hai trả `result` = **`identical`** (không còn mục `new`); `TARGET_ROWS` giữ nguyên sau replay (api_keys=2, connector_revisions=2, secret_versions=2, profile_bindings=2, profile_active_revisions=2, profile_names=2, operations=2, connector_prompt_overrides=1, artifacts=2, artifact_blobs=2, legacy_workflow_schemas=1).
Bằng chứng fail-closed vòng 4: `destinationRows planned=0` (policy=fail ⇒ không ghi gì).
Bằng chứng vòng 5: đúng 8 `TRANSFORM_ERROR` với message `approved context policy is not configured for …` (prepareConnector ×3, resolveProfileName ×2, prepareWorkflowSchema ×1, readFileCacheBytes ×2) — adapter production **chặn khi thiếu context**, không bịa cấu hình.

Kết luận cuối của harness (nguyên văn):
```
HARNESS_PASS disposable_pg16=1 network=none tmpfs=1 published_ports=0
IN_CONTAINER_EXIT=0
CONTAINER_REMOVED du-ldba09-pg16-1791511947140-7784
OFFLINE_TEST_EXIT=0
MIGRATIONS orchestrator=38 connector=9 target_tables=34 schema_migrations=38 connector_schema_migrations=9
```
- Harness tự dựng **một container PG16 disposable** (`network=none`, tmpfs, **published_ports=0**), chạy harness **bên trong container** (`IN_CONTAINER_EXIT=0`), rồi **remove**; kiểm lại `docker ps -a` sau lượt chạy: **không còn container nào khớp `ldba`** ⇒ không rò rỉ.
- Harness áp **cả hai bộ migration**: orchestrator **38**, connector **9**, `target_tables=34` ⇒ đúng điểm chặn tôi đã ghi ở LDBA-07 (bộ connector chưa được áp) và nay **đã xử lý trong rehearsal LDBA-09**.
- Vòng in-container chạy `node --test` file runner-skip: 16 test pass (`ℹ pass 16`, `ℹ fail 0`), `OFFLINE_TEST_EXIT=0`.

## 3. Verdict

| Hạng mục | Kết quả |
|---|---|
| LỆNH 1 (`node --test`, 3 file) | **PASS** — exit 0, 42/42 test, 0 fail, 0 skipped |
| LỆNH 2 (harness) | **PASS** — exit 0, **5/5 vòng đạt mốc kỳ vọng**, `HARNESS_PASS`, `IN_CONTAINER_EXIT=0`, container đã remove |
| Yêu cầu all 5 rounds pass + exit 0 | **ĐẠT** theo nghĩa: 5/5 vòng đạt kết quả kỳ vọng và **harness exit 0**. Trung thực: vòng 4 và 5 là **vòng âm tính có chủ đích**, runner exit **1** theo thiết kế (`BLOCKED_*`), không phải lỗi; cách đọc mọi vòng runner phải exit 0 sẽ **không khớp thiết kế harness** |

## 4. Ghi chú và GAP

1. **Identity tables vẫn 0 sau backfill là đúng thiết kế:** `TARGET_ROWS admin_local_users=0`, `user_profile_assignments=0`; hàng `User`/`UserProfileAssignment` bị skip có mã (`IDENTITY_PENDING_REHASH` ×3, `ASSIGNMENT_USER_NOT_MIGRATED`, `ASSIGNMENT_USER_ID_NOT_UUID`) — khớp LDBA-08 (rehash ở lần login đầu), không phải lỗi backfill.
2. **Skip có kiểm soát 10/22 hàng nguồn**, mọi skip đều có `code` + `reason` (`CONNECTOR_ROW_OUT_OF_SCOPE`, `OVERRIDE_CONNECTOR_NOT_MIGRATED`, `OVERRIDE_CONNECTION_ID_NOT_UUID`, …); `failures` rỗng ở vòng 1-3 ⇒ **zero parse failure** trên đường fixture.
3. **Untracked:** cả 4 file LDBA-09 đang `??` ⇒ verification gắn với working tree; digest ở §0.
4. **Phạm vi:** rehearsal **offline + container disposable**; **không** đọc DB production/legacy, không claim DB window thật; **A1 (timezone) vẫn mở** — fixture dùng UTC tường minh, không đóng A1.
5. Không tick gate nào; không commit / `git add` / push.
6. Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.

## 5. Đối chiếu với receipt đã có ở `ldba-09-verify.md` (không hòa giải)

| Hạng mục | Receipt đã có (lane khác) | Lượt của tôi (DSH) | Khớp? |
|---|---|---|---|
| Node runtime | v24.21.0 | **v22.23.3** (node PATH) | khác runtime, cùng kết quả |
| LỆNH 1 | exit 0; 42 tests / 42 pass / 0 fail / 0 skip | exit 0; **42/42, 0 fail, 0 skip** | **KHỚP** |
| LỆNH 2 | exit 0; `HARNESS_PASS … published_ports=0`; `IN_CONTAINER_EXIT=0` | exit 0; **cùng chuỗi `HARNESS_PASS`**; `IN_CONTAINER_EXIT=0` | **KHỚP** |
| 5 vòng | 5 mốc `FIXTURE_*`/`LDBA08_*` | **đúng 5 mốc đó**, kèm dòng RUNNER + status để truy vết | **KHỚP** |
| Container | `CONTAINER_REMOVED du-ldba09-pg16-1791511995002-15920` | `CONTAINER_REMOVED du-ldba09-pg16-1791511947140-7784` | khác instance, cùng hành vi remove |
| Giới hạn A1 | không nêu | ghi rõ **A1 vẫn mở** | bổ sung |
