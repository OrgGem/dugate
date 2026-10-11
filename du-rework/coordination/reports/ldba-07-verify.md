# LDBA-07 — Verify độc lập trên DB rehearsal (fresh schema + synthetic data) — 2026-10-09

**Owner:** tester độc lập (term_8bfe6adc), KHÔNG phải implementer LDBA-00..06.
**Spec:** `du-rework/coordination/dispatch-specs/2026-10-09-LDBA-07-rehearsal-verify.md` · plan §5, §9 Q1, bảng LDBA-07 dòng 319.
**Kết quả tổng:** rehearsal dựng được và chạy được **fresh schema + seed synthetic + kiểm fail-closed ở tầng probe**; **4 adapter CHƯA chạy được** trên rehearsal trong cửa sổ này ⇒ tiêu chí `source/target đếm khớp` + `zero parse failure` + `idempotent 2 lần` **CHƯA ĐẠT**. Dừng đúng theo §4 và ghi Open items bên dưới. Không tick gate nào.

---

## 1. DB rehearsal disposable — ĐẠT

Lệnh dựng (đúng tiền lệ 0032, `--network none`, tmpfs, KHÔNG publish port):
```
docker run -d --name du-ldba07-rehearsal --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=<synthetic> -e POSTGRES_DB=du_ldba07_rehearsal postgres:16-alpine
```
Kiểm chứng bằng `docker inspect`:
- `NetworkMode=none` · `PortBindings=map[]` (không publish port) · `Tmpfs=map[/var/lib/postgresql/data:]` · `Image=postgres:16-alpine`
- Container id `efcdb88771c59959836ec10f028bdd951a9973cf34886f20af5599526bc6e4b7`
- `pg_isready` → `accepting connections` sau **1s**; `select version()` → **PostgreSQL 16.11 on x86_64-pc-linux-musl**
- Trước migration: **0 bảng** trong schema public (fresh) ✓
- **Đã remove sau khi xong:** `docker rm -f du-ldba07-rehearsal` → exit **0**; `docker ps -a` không còn container nào khớp `ldba07` ✓

## 2. Fresh schema 001..0037 — ĐẠT

Áp migrations bằng `psql` **bên trong container** (không dùng port), mỗi file **một transaction** (`psql -1 -v ON_ERROR_STOP=1 -f`) + **một dòng ledger** `INSERT INTO schema_migrations (sequence, filename)`, tái lập đúng ngữ nghĩa `migrate()` (`src/db/migrations.ts:69-77` DDL ledger; `:210-215` tx + insert). File SQL được `docker cp` vào `/tmp/migrations`.

| Hạng mục | Kết quả |
|---|---|
| Số file migration | **37** (`0001_platform_v1.sql` … `0037_legacy_workflow_schema_catalog.sql`) |
| Áp thành công | **37/37**, mọi `apply_exit=0` và `ledger_exit=0` |
| `count(*) from schema_migrations` | **37** (min sequence 1, max 37) |
| Bảng trong schema public sau migrate | **28** |
| Sau khi thêm 6 bảng legacy-shaped synthetic | **34** |

Ghi chú kỹ thuật: `0019` có nhắc `CONCURRENTLY` nhưng **nằm trong comment** (giải thích vì sao KHÔNG dùng), nên `psql -1` không gặp lỗi transaction — khớp với thiết kế runner (`migrations.ts` chạy mỗi file trong `db.tx()`).

## 3. Synthetic legacy-shaped data — ĐẠT (seed) / ĐO ĐƯỢC MỘT PHẦN

Seed tự dựng bằng file `raw/ldba-07-2026-10-09/seed-legacy-shaped.sql` (PascalCase table + camelCase column, **timestamp UTC tường minh** dạng `2026-01-01T00:00:00Z`), **không lấy dữ liệu từ DB thật**:

| Bảng nguồn (synthetic) | Số hàng | Ghi chú chọn lọc |
|---|---:|---|
| AppSetting (quoted) | 3 schema + 1 provider = **4** | 2 hàng cùng slug `lc-checker` khác `updatedAt` (2026-02-01 vs 2026-03-01) để test tiebreak |
| ExternalApiConnection (quoted) | **2** | khác `authType` (bearer vs apiKey); 1 hàng `url` **http** để test skip non-HTTPS |
| User (quoted) | **3** | ADMIN/USER/VIEWER; 1 hàng `password` rỗng |
| ApiKey (quoted) | **2** | STANDARD/ADMIN, `spendingLimit` 100.5 và 0 |
| Operation (quoted) | **3** | SUCCEEDED/RUNNING/FAILED; 1 hàng `createdByUserId` NULL |
| UserProfileAssignment (quoted) | **2** | cặp (userId, apiKeyId) |

`psql -f seed` → **exit 0**, thông báo `INSERT 0 3` / `0 2` / `0 3` / `0 2` (cửa sổ log hiển thị) và tổng số bảng public tăng 28 → **34** ⇒ 6 bảng legacy-shaped được tạo thật.
**Gap đo lường:** truy vấn đếm nguồn theo tên quoted bị **mangle khi đi qua `docker exec` trên Windows** (dấu nháy kép của identifier bị PowerShell/docker làm mất, psql nhận tên lowercase) nên **số đếm nguồn không được ghi lại dạng literal**; số hàng ở bảng trên lấy từ chính file seed + thông báo INSERT. Nếu cần literal, phải chạy lại với `docker cp` file .sql rồi `psql -f` (không truyền SQL inline qua Windows).

## 4. getHealth fail-closed (plan §5) — ĐẠT Ở TẦNG PROBE, kèm 2 lưu ý trung thực

Đường code: `src/server.ts:326-368` — probe DB là `SELECT 1` (`:331`) rồi `ctx.runtime.getActiveLeasesCount()` (`:333`), và `getActiveLeasesCount` chạy `SELECT count(*)::int as count FROM tasks WHERE state = 'RUNNING'` (`src/modules/runtime/runtime.ts:508`). Nếu probe ném lỗi → `dbOk=false` (`server.ts:334-337`) → `isOk = dbOk && redisOk` (`:347`) → body `status` là `degraded` (`:355`) và HTTP **503** (`:367`) — tức **KHÔNG ok** ✓.

Bằng chứng đo trên rehearsal:

| Probe | DB rỗng `du_ldba07_fresh` (chưa có bảng tasks/outbox) | DB đã migrate `du_ldba07_rehearsal` |
|---|---|---|
| `SELECT 1` (server.ts:331) | trả `1` (thành công) | trả `1` (thành công) |
| `SELECT count(*)::int as count FROM tasks WHERE state = 'RUNNING'` (runtime.ts:508) | **ERROR: relation tasks does not exist** ⇒ `dbOk=false` ⇒ `degraded`/503, **không ok** ✓ | trả `0` (thành công) |

**Lưu ý 1 (giới hạn phạm vi):** tôi xác minh ở **tầng probe SQL + đọc code**, **không** boot app/route trên rehearsal (không có Redis trong `--network none`, và boot app cần cấu hình đầy đủ). Vì vậy tôi chưa chứng minh được hành vi end-to-end của `GET /api/v1/health`.
**Lưu ý 2 (nhãn trạng thái):** plan §5 nói kỳ vọng trả **`unknown`**; code thực tế trả **`degraded`** khi `db === false` (`src/app/admin/bff/health.ts:83`) — `unknown` chỉ xuất hiện khi `db`/`redis` là **null** (`:84`). Trên rehearsal cả `db` và `redis` đều false ⇒ kết cục là **`degraded` + 503**. Điều kiện cốt lõi (KHÔNG ok) **đạt**, nhưng **nhãn không khớp câu chữ plan** ⇒ ghi thành open item để coordinator chốt (sửa câu chữ plan hay sửa hành vi BFF).

## 5. Bốn adapter LDBA-03/04/05/06 — CHƯA CHẠY ĐƯỢC (open item chặn tiêu chí)

| Adapter | Trạng thái trong cửa sổ này | Lý do cụ thể |
|---|---|---|
| LDBA-03 backfill | **KHÔNG chạy** | `scripts/ldba-03-backfill.cjs` (1210 dòng) yêu cầu adapter qua `LDBA03_ADAPTER_MODULE` với contract khá lớn: `source.scan`; `sink.inspectImmutable`, `sink.validatePlan`, `sink.applyImmutableBatch`, `sink.resolveTenantIdsByName`, `sink.seedTenantByName`; `adapter.context`; `adapter.a1Passed === true`; `adapter.sourceVersion`/`a1SourceVersion` (`:783-786`, `:826-872`). Adapter source/sink production **không tồn tại trên disk** (§1.5 spec xác nhận). Viết adapter synthetic đủ để qua preflight + ghi immutable batch cho ~9 bảng là một hạng mục implementation riêng, **vượt phạm vi một lượt verify**. |
| LDBA-04 identity | **KHÔNG chạy** | Cần harness Node **trong container** gọi module TS (`migrateLegacyLocalCredentialOnLogin`, `mapLegacyUserProfileAssignment`) — khả thi về nguyên tắc (xem §6) nhưng cần bước build/bundle TS + copy `pg`, chưa làm trong cửa sổ này. |
| LDBA-05 connector | **KHÔNG chạy** | Ngoài việc cần harness như trên, **bảng sink của connector không tồn tại** trên rehearsal: migrations `001..009` của **service connector** là bộ riêng, không nằm trong `001..0037` của orchestrator. Đo được: truy vấn tìm `connector_revisions`/`secret_versions` → **0** bảng (không tồn tại). |
| LDBA-06 workflow schema | **KHÔNG chạy** | Cần harness TS + một `MetadataCrypto` với key provider giả (test-only) chạy trong container; chưa làm trong cửa sổ này. |

Hệ quả trực tiếp (đo được): **target counts = `0|0|0|0|0`** cho `legacy_workflow_schemas`, `admin_local_users`, `api_keys`, `operations`, `user_profile_assignments`. Vì source là 14 hàng synthetic và target là 0, **tiêu chí `source/target đếm khớp` không thể đạt** nếu chưa chạy adapter ⇒ tôi **không** claim đạt.

## 6. Phát hiện hữu ích cho cửa sổ sau — Node chạy được TRONG container `--network none`

Đã kiểm chứng (không cần publish port, không phá ràng buộc `--network none`):
```
docker create --name ldba07-node-src node:24.21.0-alpine3.24
docker cp ldba07-node-src:/usr/local/bin/node <host>/node-linux      # 131 391 152 byte, exit 0
docker cp <host>/node-linux du-ldba07-rehearsal:/tmp/node            # exit 0
docker exec du-ldba07-rehearsal /tmp/node -v                         # -> v24.21.0, exit 0
```
⇒ Cửa sổ sau có thể chạy harness JS/TS (đã biên dịch) **bên trong** container, kết nối PG qua loopback/unix socket, mà vẫn giữ `--network none` + không publish port. Cần thêm: copy `node_modules/pg` (thuần JS) và bước build TS → JS.

## 7. A1 (timezone) — VẪN MỞ (không đóng bởi rehearsal này)

Rehearsal dùng **UTC tường minh** (`2026-01-01T00:00:00Z`, …) nên nó chỉ chứng minh runner/adapter đúng **với dữ liệu UTC**. **A1 (timezone runtime legacy thật) vẫn mở** vì packet này **không được** đọc DB legacy thật. Real backfill vẫn cần một quyết định/đo riêng cho A1.

## 8. Open items for coordinator

1. **Chặn tiêu chí:** chưa chạy được 4 adapter trên rehearsal ⇒ `source/target đếm khớp`, `zero parse failure`, `idempotent 2 lần` **chưa có bằng chứng**. Cần một packet riêng cho harness in-container (đã chứng minh khả thi ở §6) và/hoặc quyết định viết adapter synthetic đủ lớn cho LDBA-03.
2. **LDBA-03 adapter production không tồn tại** — nếu muốn đóng LDBA-03 ở phạm vi production thì phải mở packet implementation cho source/sink adapter, không thể chỉ dựa vào runner.
3. **Bộ migration của connector (`001..009`) chưa được áp** trên rehearsal ⇒ LDBA-05 không thể verify DB round-trip cho tới khi rehearsal áp thêm bộ migration connector (hoặc dùng container thứ hai).
4. **Nhãn `unknown` vs `degraded`:** plan §5 nói `unknown`, code BFF cho `degraded` khi `db === false` (`health.ts:83-84`). Cần chốt: sửa câu chữ plan, hay sửa BFF để trả `unknown` khi DB probe thất bại.
5. **getHealth chưa được đo end-to-end** qua route thật (chỉ đo probe SQL + đọc code) — cần Redis/dựng app nếu muốn bằng chứng route-level.
6. **A1 vẫn mở** (§7).
7. **Gap đo lường:** truyền SQL có identifier quoted qua `docker exec` từ Windows làm mất dấu nháy kép; lần sau dùng `docker cp` file .sql + `psql -f` để có literal đáng tin.

## 9. Ranh giới đã tuân thủ

- **KHÔNG** đọc/đụng DB production, DB legacy, hay DB shared `:5433` — chỉ container disposable `du-ldba07-rehearsal`.
- **KHÔNG** chạy migration lên DB thật; **KHÔNG** sửa source production (chỉ đọc + gọi); **KHÔNG** commit/`git add`/push; **KHÔNG** tick gate.
- **KHÔNG** dùng dữ liệu thật làm fixture (mọi hàng seed đều tự dựng, có nhãn synthetic).
- Container **đã remove** sau khi xong (`rm` exit 0, không còn container `ldba07`); file node tạm trên host đã xoá.
- Artifact ghi thêm: `du-rework/coordination/reports/raw/ldba-07-2026-10-09/` (seed SQL, log apply migration, summary). Receipt này **không** chứa ký tự nháy kép và **không** có trailing whitespace (đã tự quét).
