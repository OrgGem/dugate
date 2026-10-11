# DISPATCH — LDBA-08 — Adapter source/sink PRODUCTION cho LDBA-03 + harness in-container

**Task ID:** `LDBA-08`
**Repo scope:** `D:/Git/dugate` — **VIẾT** adapter production source/sink cho runner `ldba-03-backfill.cjs` + harness in-container (test-only) + receipt. **ĐỌC** runner, migrations orchestrator `001..0037`, migrations connector `001..009`, `tenants` DDL.
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` — **đọc lại §4 (sáu mismatch cứng), §4.1 tenant, §4.2 ID text vs uuid, §4.4 cost units, §4.5 JSON text vs jsonb, §4.6 workflow schema, bảng LDBA-08 (dòng 321).**
**Owner:** terminal `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` (Codex-4) — **đã đọc màn hình: IDLE tại prompt**; đã tự viết runner `ldba-03-backfill.cjs` (1210 dòng) nên **biết chính xác contract adapter** — đây là owner phù hợp nhất để viết adapter production cho chính runner đó.
**Dependencies:** LDBA-03 ACCEPTED (runner module) · LDBA-07 **NOT-PASS** (4 adapter chưa chạy trên PG thật) — LDBA-08 là packet implementation tiên quyết để LDBA-07 có adapter production chạy được.
**Mode:** implementation trên **DB rehearsal dùng một lần** (disposable PG16, fresh schema, synthetic data). **KHÔNG** đọc DB production/legacy. **KHÔNG** chạy migration lên DB thật. **KHÔNG** chạy backfill lên DB thật.
**Receipt path:** `du-rework/coordination/reports/ldba-08-production-adapter.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet này

LDBA-07 (verify độc lập) kết luận **NOT-PASS**: môi trường rehearsal đã dựng được (fresh schema `001..0037`, 28 bảng, seed synthetic, fail-closed probe đúng) nhưng **4 adapter CHƯA chạy được** trên PG thật. Nguyên nhân gốc đã chốt: **adapter source/sink production của LDBA-03 không tồn tại trên disk** — chỉ có runner `ldba-03-backfill.cjs` (1210 dòng) + test offline. Runner bắt buộc `LDBA03_ADAPTER_MODULE` trỏ một module adapter thật; không có adapter thì không có gì để verify.

⇒ LDBA-08 là packet **implementation** duy nhất: viết adapter production source/sink đáp ứng đúng contract của runner, kèm harness in-container để chạy nó trên DB rehearsal, và áp thêm bộ migration connector `001..009` vào **cùng** container đó.

## 1. Vùng lease — chốt cụ thể

### 1.1. File **được VIẾT** (lease)

| # | Path (tương đối từ `du-rework/orchestrator/`) | Vai trò |
|---|---|---|
| W1 | `services/orchestrator/scripts/ldba-03-production-adapter.cjs` | **Adapter production** source/sink cho runner LDBA-03. Module CommonJS vì runner gọi bằng `require(path.resolve(adapterPath))`. |
| W2 | `services/orchestrator/tests/ldba-03-production-adapter.test.cjs` | Test offline cho adapter (fake db, synthetic fixture) — theo đúng tiền lệ `ldba-03-backfill-offline.test.cjs`. |
| W3 | `services/orchestrator/scripts/ldba-08-harness.cjs` | **Harness in-container** (test-only): dựng container disposable, áp migrations, seed synthetic, gọi runner với `LDBA03_ADAPTER_MODULE` trỏ W1, đối chiếu source/target. |
| W4 | `du-rework/coordination/reports/ldba-08-production-adapter.md` | Receipt. |

### 1.2. File **chỉ ĐỌC** (không sửa)

- `services/orchestrator/scripts/ldba-03-backfill.cjs` — runner (contract nguồn).
- `services/orchestrator/migrations/0001_platform_v1.sql` … `0037_*.sql` — schema đích.
- `services/connector/src/db/migrations/001_connector.sql` … `009_connector_invocation_session_ref.sql` — schema connector.
- `services/orchestrator/src/db/migrations.ts`, `src/migrate-cli.ts` — cơ chế ledger `schema_migrations`.
- `services/orchestrator/src/modules/identity/legacy-user-adapter.ts`, `services/connector/src/db/legacy-connector-adapter.ts`, `src/modules/workflow-schemas/legacy-workflow-schema-backfill-adapter.ts` — adapter LDBA-04/05/06 đã ACCEPTED (tham chiếu cách viết, không sửa).

### 1.3. **Ngoài lease** (cấm sửa)

- Mọi file source production ngoài W1 (runner, migration, contract, catalog, crypto, BFF, UI).
- `package.json`, lockfile, Compose, Dockerfile, `.env*`.
- DB production / DB legacy / DB shared `:5433`.

## 2. Hợp đồng source/sink với runner `ldba-03-backfill.cjs`

Runner đã đọc chi tiết. Adapter **phải** xuất một module CommonJS với shape sau. **Đây là contract bắt buộc — không được đoán.**

### 2.1. CLI + env (runner `runCli`, `:1163-1186`)

- `process.argv[2]` phải là `--preflight` hoặc `--execute`; giá trị khác → exit 2.
- Env `LDBA_A1_PASSED` phải bằng `1`; không → exit 2 (refuse).
- Env `LDBA03_ADAPTER_MODULE` bắt buộc → `require(path.resolve(adapterPath))`; thiếu → exit 2.
- `--preflight` thành công → in `PREFLIGHT_READY`, exit 0. Ngược lại exit 1.

### 2.2. Shape adapter (runner `runBackfill`, `:826-865`)

```
{
  source:        { ... },        // 2.3
  sink:          { ... },        // 2.4
  context:       { ... },        // 2.5
  a1Passed:      true,           // bắt buộc === true
  sourceVersion: '<non-empty>',  // 2.6
  a1SourceVersion: '<non-empty>' // phải === sourceVersion, không → sourceVersionFailure (:781-799)
}
```

### 2.3. `source`

- `source.scan(table)` → **Array** row legacy (`:838-848`, `:868-885`). `table` là một trong 9 `LEGACY_TABLES`: `Operation`, `ApiKey`, `ExternalApiConnection`, `ExternalApiOverride`, `ProfileEndpoint`, `AppSetting`, `FileCache`, `User`, `UserProfileAssignment`.
- Row trả về phải là object với **tên cột camelCase** đúng như legacy (ví dụ `endpointSlug`, `updatedAt`, `spendingLimit`, `createdByUserId`, `s3Key`, `md5Hash`). Runner đọc bằng `row.<camelCase>` và `SOURCE_KEY[table](row)`.
- Đọc bằng driver `pg` (đã có sẵn trong `node_modules`) kết nối tới container rehearsal qua `DATABASE_URL`.

### 2.4. `sink` — 5 method, return contract chính xác

| Method | Signature | Return | Ghi chú runner |
|---|---|---|---|
| `resolveTenantIdsByName` | `(name)` → | **Array of UUID string** | `>1` → `DUPLICATE_TENANT_NAME`; `0` trong preflight → `PREFLIGHT_TENANT_PENDING`; `0` trong execute → gọi `seedTenantByName` rồi resolve lại (`:889-924`). |
| `seedTenantByName` | `(name)` → | UUID string | Chỉ insert **cột name**; DB sinh UUID (`:887-888`). |
| `validatePlan` | `(writes)` → | **Array** của `{table, sourceKey, field, code, message}` | `:997-1019`. Mảng rỗng = hợp lệ. |
| `inspectImmutable` | `(item)` → | `'new'` \| `'identical'` \| `'conflict'` | `:1040-1064`. |
| `applyImmutableBatch` | `(writes)` → | **Array** của `'inserted'` \| `'identical'`, **độ dài phải bằng** `writes.length` | `:1095-1124`. Lỗi có thể mang `.write` và `.code`. |

**Quan trọng về `seedTenantByName`:** bảng `tenants` có `name text NOT NULL` **không có UNIQUE** (đã đọc DDL `0001_platform_v1.sql`). Nên seed **phải** serialize bằng advisory lock (ví dụ `pg_advisory_xact_lock` với key cố định) để hai lần chạy song song không sinh 2 tenant cùng tên.

### 2.5. `context` — method surface dùng bởi transform

Runner gọi các method này trong lượt transform. Adapter phải cung cấp đầy đủ:

| Method | Mục đích |
|---|---|
| `resolveBusinessAction(slug)` | Trả `{businessId, businessVersion, action}` — **bắt buộc** đầy đủ 3 string, không → `UNMAPPED_ENDPOINT` (`:252-267`). Dùng registry sẵn có. |
| `prepareConnector(row, opts)` | Chuẩn hóa row `ExternalApiConnection` → dạng connector. |
| `resolveProfileName(row)` | Resolve tên profile từ row `ProfileEndpoint`. |
| `normalizeConnectionsOverride(raw)` | Chuẩn hóa `ExternalApiOverride`. |
| `prepareWorkflowSchema(parsed, opts)` | Chuẩn hóa `AppSetting` workflow schema → `legacy_workflow_schemas`. |
| `readFileCacheBytes(s3Key)` | Đọc bytes từ `FileCache` (có thể trả null nếu không có). |
| `artifactTokenFor(row, id)` | Sinh token artifact. |
| `artifactPurposeFor(row)` | Sinh purpose artifact. |
| `prepareAdminLocalUser(row, {username, role, tenantId})` | Chuẩn hóa `User` → `admin_local_users`. |

### 2.6. Write item shape (runner `write`, `:240-250`)

```
{ entity, key: String(key), value, source: { table, sourceKey: String(SOURCE_KEY[table](row)) } }
```

`entity` là một trong 13 `DESTINATION_ORDER`: `api_keys`, `connector_revisions`, `secret_versions`, `profile_bindings`, `profile_active_revisions`, `profile_names`, `operations`, `connector_prompt_overrides`, `artifacts`, `artifact_blobs`, `admin_local_users`, `user_profile_assignments`, `legacy_workflow_schemas`.

### 2.7. Report status (runner)

`BLOCKED_A1`, `BLOCKED_ADAPTER`, `BLOCKED_SOURCE_READ`, `PREFLIGHT_TENANT_PENDING`, `BLOCKED_TRANSFORM`, `BLOCKED_TARGET_PREFLIGHT`, `BLOCKED_TARGET_CONFLICT`, `PREFLIGHT_READY`, `BLOCKED_TARGET_WRITE`, `APPLIED`. Receipt phải ghi rõ status cuối và số lượng từng loại.

## 3. Harness in-container — hướng dẫn bắt buộc

Mục đích: chạy adapter production trên **PG thật** mà **không** publish port, **không** đụng DB thật. Kỹ thuật đã chứng minh khả thi ở LDBA-07 §6.

### 3.1. Container disposable (tiền lệ `migration-0032-restore-rehearsal-2026-10-05.md`)

```
docker run -d --name du-ldba08-rehearsal --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=<synthetic> -e POSTGRES_DB=du_ldba08_rehearsal postgres:16-alpine
```

- `--network none`, **không publish port**, tmpfs, **remove** sau khi xong.
- Docker đã sẵn sàng (server 28.5.1).

### 3.2. Node chạy **trong** container (không cần publish port)

LDBA-07 đã chứng minh:

```
docker create --name ldba08-node-src node:24.21.0-alpine3.24
docker cp ldba08-node-src:/usr/local/bin/node <host>/node-linux
docker cp <host>/node-linux du-ldba08-rehearsal:/tmp/node
docker exec du-ldba08-rehearsal /tmp/node -v    # -> v24.21.0
```

Bổ sung cần thiết cho LDBA-08:
- Copy `node_modules/pg` (thuần JS) vào container, hoặc chạy adapter bằng Node trên host kết nối qua `docker exec` psql. **Ưu tiên**: build TS → JS trên host, copy JS + `pg` vào container, chạy bằng `/tmp/node`.
- Kết nối PG trong container qua **unix socket** hoặc `localhost` (vì `--network none` vẫn có loopback).

### 3.3. Áp migrations — **cả hai bộ** vào cùng container

Đã đo: bộ migration **connector** `001..009` tạo 4 bảng (`connector_revisions`, `secret_versions`, `connector_invocations`, `connector_usage_outbox`) — **zero name collision** với 28 bảng orchestrator. ⇒ **áp cả hai vào cùng container.**

- Bộ orchestrator `001..0037` (37 file) — theo đúng ngữ nghĩa `migrate()` (`migrations.ts:69-77` DDL ledger; `:210-215` tx + insert). Mỗi file **một transaction** (`psql -1 -v ON_ERROR_STOP=1 -f`) + **một dòng ledger** `INSERT INTO schema_migrations (sequence, filename)`.
- Bộ connector `001..009` (9 file) — cùng cách, cùng bảng ledger `schema_migrations` (nếu connector dùng ledger riêng thì ghi riêng, **ghi rõ** trong receipt).
- **Ghi rõ** trong receipt: số file áp được, số bảng tạo ra, `count(*) from schema_migrations`.

### 3.4. Seed synthetic (tự dựng, không từ DB thật)

- Seed dữ liệu **legacy-shaped** vào các bảng legacy (PascalCase: `Operation`, `ApiKey`, `User`, `AppSetting`, `ExternalApiConnection`, `ExternalApiOverride`, `ProfileEndpoint`, `FileCache`, `UserProfileAssignment`).
- **Timestamp dùng UTC tường minh** (ví dụ `2026-01-01T00:00:00Z`) — xem mục 4 về A1.
- Mỗi bảng seed **ít nhất 2–3 hàng** để test chọn lọc (2 `AppSetting` cùng slug khác `updatedAt`; 2 `ExternalApiConnection` khác `authType`; 1 hàng `url` http để test skip non-HTTPS).
- **Ghi rõ** số hàng seed từng bảng.

### 3.5. Chạy runner + đối chiếu

```
LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<path W1> /tmp/node services/orchestrator/scripts/ldba-03-backfill.cjs --preflight
LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<path W1> /tmp/node services/orchestrator/scripts/ldba-03-backfill.cjs --execute
```

- Preflight phải ra `PREFLIGHT_READY` (exit 0).
- Execute phải ra `APPLIED` (exit 0).
- **Đối chiếu source/target counts** cho từng entity trong `DESTINATION_ORDER`.
- **Zero parse failure** (không `BLOCKED_TRANSFORM`, không `RowFailure`).
- **Idempotent**: chạy execute **2 lần**, lần 2 toàn bộ `identical`, không sinh revision 2.

## 4. A1 (timezone) — giới hạn trung thực

Runner LDBA-03 đọc timestamp naive là UTC cố định. **A1 (timezone runtime legacy thật) vẫn mở** và LDBA-08 **không thể** đóng nó vì không được đọc DB legacy thật. Trên rehearsal, dữ liệu synthetic dùng UTC tường minh nên giả định UTC của runner được kiểm soát. **Ghi rõ trong receipt:** đây là bằng chứng runner + adapter đúng với dữ liệu UTC, **không phải** đóng A1. A1 vẫn mở cho real backfill.

## 5. Tiêu chí nghiệm thu — đã chốt cụ thể

- [ ] Adapter production W1 tồn tại, `require()` được, xuất shape đúng §2.2.
- [ ] `source.scan` trả đủ 9 bảng legacy, row camelCase đúng.
- [ ] `sink` đủ 5 method, return contract đúng §2.4; `seedTenantByName` dùng advisory lock.
- [ ] `context` đủ 8 method, `resolveBusinessAction` trả đủ 3 string.
- [ ] Test offline W2 pass (fake db, synthetic fixture), exit 0.
- [ ] Harness W3 dựng được container disposable PG16, `--network none`, không publish port.
- [ ] Áp được **cả hai** bộ migration (orchestrator `001..0037` + connector `001..009`) vào cùng container; ghi rõ số file + số bảng + ledger count.
- [ ] Seed synthetic legacy-shaped, timestamp UTC tường minh, mỗi bảng 2–3 hàng.
- [ ] Runner `--preflight` → `PREFLIGHT_READY` exit 0.
- [ ] Runner `--execute` → `APPLIED` exit 0.
- [ ] **Source/target counts khớp** cho từng entity trong `DESTINATION_ORDER`.
- [ ] **Zero parse failure** (không `BLOCKED_TRANSFORM`, không `RowFailure`).
- [ ] **Idempotent**: execute 2 lần, lần 2 toàn bộ `identical`.
- [ ] **A1 ghi rõ là vẫn mở** (rehearsal UTC không đóng A1).
- [ ] Receipt ghi: mỗi entity số source/target, số skip + lý do, mọi open item.
- [ ] File receipt **không** ký tự nháy kép, **không** trailing whitespace.

## 6. Ranh giới (bắt buộc)

- **KHÔNG** đọc DB production/legacy/shared `:5433`. Chỉ container disposable.
- **KHÔNG** chạy migration lên DB thật. Chỉ container rehearsal.
- **KHÔNG** chạy backfill lên DB thật. Chỉ container rehearsal.
- **KHÔNG** sửa source production ngoài W1 (runner, migration, contract, catalog, crypto, BFF, UI).
- **KHÔNG** commit, `git add`, push, không tick gate.
- **KHÔNG** để container rehearsal sau khi xong (remove).
- **KHÔNG** dùng dữ liệu thật làm fixture.

## 7. Khi nào **phải dừng**

Dừng và ghi `Open items for coordinator` nếu:
- Không dựng được container PG16 disposable (Docker lỗi, port xung đột).
- Migration `001..0037` hoặc `001..009` chạy lên rehearsal lỗi (schema conflict).
- Runner `--preflight` không ra `PREFLIGHT_READY` sau khi đã sửa adapter hợp lý.
- Runner `--execute` không ra `APPLIED`, hoặc source/target counts không khớp.
- Bất kỳ parse failure không giải thích được.
- Bất kỳ yêu cầu nào ở §6.

**Dừng đúng cách là hành vi được chấp nhận.**

## 8. Dispatch proof

- **Request ID:** `LDBA-08-2026-10-09`
- **Owner:** `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` (Codex-4) — đã đọc màn hình, **IDLE tại prompt**, tác giả runner `ldba-03-backfill.cjs`.
- **Dependency evidence:** LDBA-03 ACCEPTED (runner); LDBA-07 NOT-PASS (adapter production không tồn tại); plan §4 (sáu mismatch), bảng LDBA-08 dòng 321.
- **Acceptance:** adapter production đúng contract + chạy trên PG thật + source/target khớp + zero parse failure + idempotent + cả hai bộ migration áp được.
