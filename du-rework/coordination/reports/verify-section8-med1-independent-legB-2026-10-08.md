# VERIFY độc lập leg B — WFA section 8 MED-1 migration ledger validates DB objects (2026-10-08)

> **RESUME POINT — leg B đã chạy xong, PASS trong phạm vi kiểm tra, CÓ 3 nhận xét mở (không phải gate verdict).** 4 lệnh: tsc `exit 0`; suite mới `10 passed / 10 total` `exit 0`; ledger-guard `17 passed / 17 total` `exit 0`; 0032-rollback + verify-trap-fix `14 passed / 14 total` `exit 0`. Trả lời a/b/c ở §2–§4 bằng `file:line` đọc trực tiếp source. Nhận xét coverage ở §5, gồm 1 điểm test (7) không thật sự exhaustive như tên gọi. **Thẩm định của tôi: MED-1 ĐÓNG MỘT PHẦN** — đã đóng trên đường `migrate()`, nhưng verify-only boot vẫn mù và có drift class bị bỏ sót. KHÔNG tick gate, KHÔNG viết VERIFIED/ACCEPTED.

- **Đối tượng:** fix MED-1 — receipt `coordination/reports/fix-section8-med1-migration-ledger-2026-10-08.md`.
- **Vai trò:** leg B, agent thứ hai, provider khác, READ-ONLY. Không sửa source/test, không commit/add/push, không tick gate, không sửa `docs/21-openapi.json`.
- **Scope:** `du-rework` ONLY. Offline only — không claim DB window, không chạy live DB.

## 0. Identity của đối tượng verify (đo trước và sau, không đổi)

| File | SHA-256 (trước lệnh) | SHA-256 (sau lệnh cuối) | Khớp receipt fix? |
|---|---|---|---|
| `orchestrator/services/orchestrator/src/db/migrations.ts` | `d618adabc3fb66bf14473c9f9c6d2a871cbd185d1a2cdc33f7adab2c1bdff0f6` | `d618adabc3fb66bf14473c9f9c6d2a871cbd185d1a2cdc33f7adab2c1bdff0f6` | Có (trùng) |
| `.../tests/med1-migration-ledger-object-drift.test.ts` | `151b2d10244f65a5df512205e321a2d60e553a74d237e63099afa2e20b18b755` | `151b2d10244f65a5df512205e321a2d60e553a74d237e63099afa2e20b18b755` | Có (trùng) |

Không có confounder: không ai sửa 2 file này trong lúc leg B chạy.

## 1. Bảng lệnh / exit / Tests: literal

cwd cho lệnh 1–4: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

| # | Command | Exit | Tests: (literal) |
|---|---|---:|---|
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | *(không có dòng Tests — tsc im lặng)* |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts` | **0** | `Tests:       10 passed, 10 total` |
| 3 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/migrations.test.ts tests/migrations-ledger-guard.test.ts` | **0** | `Tests:       17 passed, 17 total` (chỉ ledger-guard chạy; xem note) |
| 4 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/migration-0032-rollback.test.ts tests/migration-verify-trap-fix.test.ts` | **0** | `Tests:       14 passed, 14 total` |

Literal từ lệnh 2:

```
  PASS  tests/med1-migration-ledger-object-drift.test.ts
  MED-1: migrate() fails closed when a recorded migration object was dropped
    √ healthy fully-migrated schema resolves and applies nothing (12 ms)
    √ dropped TABLE (legacy_workflow_schemas, migration 0037) throws instead of skipping (24 ms)
    √ dropped INDEX (legacy_workflow_schemas_one_active) is detected and named (8 ms)
    √ drift in two different migrations is reported together, each file named (5 ms)
    √ fails closed BEFORE applying pending migrations: no ledger write, no DDL (4 ms)
    √ a pending migration is NOT falsely flagged: absent objects are allowed until it runs (5 ms)
    √ exhaustive: dropping ANY declared object of ANY shipped migration is detected (305 ms)
  MED-1: the extractor sees the right objects (independent pin)
    √ 0037 declares exactly the legacy workflow schema table and its two indexes (2 ms)
    √ 0001 declares the core platform tables (2 ms)
    √ commented-out DDL is not a declaration (0019) (2 ms)

Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total
```

**Note lệnh 3:** `tests/migrations.test.ts` là suite **live-gated** — `:30` `const LIVE = process.env.DU_LIVE_INFRA === '1'`, `:31` `liveDescribe = LIVE ? describe : describe.skip`. Không chạy được offline, và tôi **không** bật `DU_LIVE_INFRA` (không claim DB window). Nên cross-check dùng `migrations-ledger-guard.test.ts` (17/17) + bộ 0032/verify-trap-fix (14/14).

## 2. (a) TABLE bị drop nhưng ledger row còn → `migrate()` THROW hay skip? Cơ chế nào phát hiện? Drift nào bị BỎ SÓT?

### TRẢ LỜI: THROW, không skip. Phát hiện bằng **probe catalog thật** (không phải so sánh giữa các hàng ledger).

Đường đi trong `migrate()` (`src/db/migrations.ts:181`):

1. `:191` `const drifted = await recordedMigrationsMissingObjects(db, files, done);` — chạy **trước** vòng lặp apply pending.
2. `recordedMigrationsMissingObjects` (`:154-172`): với **mỗi file có ledger row** (`:161` `if (!done.has(file.sequence)) continue;`), parse DDL bằng `declaredSchemaObjects` (`:112-121`), rồi probe từng tên (`:166` `if (!(await schemaObjectExists(db, name))) missing.push(name);`).
3. `schemaObjectExists` (`:127-138`) chạy **SQL đọc**: `SELECT EXISTS(... FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1) OR EXISTS(... FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1)` (`:129-136`) → đây là **probe catalog**, đọc trạng thái DB hiện tại, không suy từ ledger.
4. Có drift ⇒ `throw new Error` (`:196-204`) với message `refusing to skip recorded migrations against an incomplete schema: …` (`:197`) + tên file + danh sách object thiếu + **repair SQL** `DELETE FROM schema_migrations WHERE sequence IN (…)` (`:202`).
5. Vòng lặp apply pending (`:209-217`, `db.tx` ở `:210`) nằm **sau** ⇒ không skip âm thầm.

Nối tới boot: `create-app.ts:277-281` chọn `migrate(db)` khi `autoMigrate === true`; khối này nằm trong `try` (`:271`) và `catch` đóng pool rồi **rethrow** (`:305-309`) ⇒ throw từ drift làm **boot fail** (fail-closed) ở chế độ autoMigrate.

### Các drift bị BỎ SÓT (đọc từ regex + grep migrations, có bằng chứng)

Extractor chỉ khớp `CREATE [UNIQUE] {TABLE|INDEX} [CONCURRENTLY] [IF NOT EXISTS] <tên>` ** neo đầu dòng** (`migrations.ts:117`), nên:

| # | Drift bị bỏ sót | Bằng chứng | Ghi chú |
|---|---|---|---|
| A1 | **Object không phải TABLE/INDEX**: `CREATE EXTENSION` | `migrations/0001_platform_v1.sql:5` `CREATE EXTENSION IF NOT EXISTS pgcrypto;` | Extension bị drop + ledger row còn ⇒ `migrate()` **vẫn skip im lặng**. Đây là case drift thật trong cây shipped, không phải giả định |
| A2 | **Index do CONSTRAINT sinh ra** (không có dòng `CREATE INDEX` nào tham chiếu tên) | `migrations/0015_artifact_multipart.sql:75` `PRIMARY KEY (artifact_id, part_number)` trong CREATE TABLE | Tên index backing do PG tự sinh (`…_pkey`), không bao giờ nằm trong regex ⇒ không probe. Đúng loại case bạn nêu |
| A3 | **Constraint `ADD CONSTRAINT`** | `0015_artifact_multipart.sql:41,61`, `0013_artifact_storage_version.sql:17` | `CHECK/UNIQUE` constraint không có `CREATE INDEX` line tương ứng |
| A4 | **Column-level drift** (`ALTER TABLE … DROP/ALTER COLUMN`) | ngoài phạm vi thiết kế; `tests/migration-0032-rollback.test.ts` pin rằng verify không bao giờ soi cột thật | Cột bị drop vẫn false-green ở **cả** `migrate()` lẫn `verifyMigrations()` |
| A5 | **DDL không neo đầu dòng / tên nằm dòng khác** (`; CREATE TABLE x`, `CREATE TABLE IF NOT EXISTS\n  x (…)`) | regex `:117` | Không probe |
| A6 | **Tên schema-qualified** | grep `IF NOT EXISTS public\.` trong `migrations/` → **0 hit** | Trường hợp lý thuyết: `IF NOT EXISTS public.foo` sẽ lấy `public` làm tên object. **Hiện chưa xảy ra** trong cây shipped |
| A7 | **Ledger row không có file trên đĩa** | `recordedMigrationsMissingObjects` duyệt `files` (`:159`) chứ không duyệt ledger | Orphan row không được quét bởi drift scan; nhưng đã bị `migration-verify-trap-fix` bắt ở verify |

Ngoài ra: probe dùng `current_schema()` (`migrations.ts:131,134`) trong khi `trackingTableExists` hardcode `'public'` (`:98`) — nếu `search_path` không phải `public` thì hai bên dùng schema khác nhau (có thể sinh cảnh báo drift giả).

## 3. (b) Có side-effect nào chạy TRƯỚC khi throw không?

**Trả lời: không có ledger write và không có DDL migration trước throw. Nhưng có MỘT câu DDL idempotent được phát ra trước — nói thẳng để không ghi quá.**

Thứ tự thực tế trong `migrate()` trước khi throw:

1. `:182` `loadMigrationFiles(...)` — đọc đĩa, thuần.
2. `:183` `await ensureTrackingTable(db)` — **phát DDL** `CREATE TABLE IF NOT EXISTS schema_migrations (...)` (`migrations.ts:69-77`).
3. `:184` `appliedMigrations(db)` — `SELECT` (`:85-93`), read-only.
4. `:191` drift probe — toàn `SELECT` qua `db.query` (không transaction, không write) (`:127-138`).
5. `:196` throw.

Đánh giá:

- **Ledger INSERT**: chỉ nằm trong `db.tx` ở `:210-216`, tức **sau** throw ⇒ không ledger write trước throw. Test (5) pin đúng điều này: `expect(db.inserts).toEqual([]); expect(db.ddl).toEqual([])` (`test:165-166`).
- **DDL migration pending**: cũng chỉ ở `db.tx` sau throw ⇒ không chạy.
- **Ràng buộc thật của `ensureTrackingTable`**: nó là `CREATE TABLE IF NOT EXISTS`, mà drift thì đòi ledger đã có row ⇒ bảng đã tồn tại ⇒ câu lệnh này là no-op trong đúng kịch bản MED-1. Nhưng nó **vẫn được phát ra**, nên: nếu database đọc-only / role không có quyền `CREATE`, boot sẽ chết với lỗi quyền **trước khi** kiểm tra drift có bao giờ chạy — tức lỗi drift bị che. Đây là điểm tinh vi nhất của (b), và không có test nào chặn nó.

## 4. (c) `verifyMigrations` còn nguyên không? Ý kiến của tôi: MED-1 đã đóng chưa?

### verifyMigrations: CÒN NGUYÊN (không thêm probe object)

- `verifyMigrations` (`migrations.ts:230`) chỉ làm: `trackingTableExists` (`:232`, đọc `information_schema.tables` cho **bảng ledger**, `:95-103`) + `appliedMigrations` (`:248`) + các kiểm tra count/orphan của trap-fix trước đó.
- **Không có probe object trong verify**: `schemaObjectExists` chỉ được gọi **đúng 1 chỗ** là `:166` (trong `recordedMigrationsMissingObjects`), mà hàm này chỉ được `migrate()` gọi (`:191`). Grep `information_schema|pg_indexes|schemaObjectExists` cho đúng 7 hit, không hit nào nằm trong vùng verify.
- Cross-check xanh là bằng chứng không hồi quy: `migration-0032-rollback.test.ts` + `migration-verify-trap-fix.test.ts` → `14 passed, exit 0` — 2 suite này pin semantics của verify, nếu MED-1 lỡ sửa verify thì chúng phải đỏ.

### Ý kiến của tôi: MED-1 **ĐÓNG MỘT PHẦN**, chưa đóng trọn

Phần đã đóng thật: finding gốc viết *"autoMigrate **skips** it and verifyMigrations still passes → boots against an incomplete schema"*. Nửa **skip** của `migrate()` đã được đóng đúng và có bằng chứng offline. Fail-closed từng chặn được (test 2,3,4,5), có tên file + object + repair SQL, và boot `autoMigrate` thật sự chết (`:305-309`).

Phần CHƯA đóng — và đây là lý do tôi không đồng ý với chữ **"COMPLETE"** trong receipt fix:

1. **Verify-only boot vẫn mù.** Đường production được chính code mô tả là `npm run migrate` rồi `npm start` (`create-app.ts:274-275`), tức `npm start` chạy `autoMigrate=false` ⇒ `verifyMigrations` ⇒ **không** probe object. Drift chỉ bị bắt ở bước `npm run migrate` (process riêng). Nếu ai đó promote bằng verify-only, hoặc bỏ qua bước migrate, thì schema thiếu vẫn boot. Fix lane có nói thẳng residual này — tôi chỉ xác nhận nó **là khoảng hở thật**, không phải ghi chú hình thức, và nó chính là nửa còn lại của câu finding.
2. **Class drift ngoài TABLE/INDEX** (A1–A3 ở §2), trong đó có case shipped thật: `CREATE EXTENSION pgcrypto` (`0001_platform_v1.sql:5`) và index của `PRIMARY KEY` (`0015_artifact_multipart.sql:75`).
3. **Column-level** (A4) — vẫn false-green, nhưng đây là quyết định phạm vi có chủ ý, không tính là lỗi của MED-1.

Kết luận hành động đề xuất (để owner quyết, không phải kết luận của tôi): hoặc (i) thêm probe object vào `verifyMigrations`, hoặc (ii) làm contract deploy bắt buộc chạy `npm run migrate` và kiểm chứng điều đó ở boot, hoặc (iii) nới extractor sang EXTENSION/VIEW/SEQUENCE/TYPE + tên index của constraint. **Việc này là quyết định của owner, không phải của leg verify này.**

## 5. Nhận xét coverage của test (load-bearing không? test (7) có thật sự exhaustive không?)

### Assertions có load-bearing không? CÓ, phần lớn.

- Test 2–4 assert **nội dung** throw (`rejects.toThrow(/…/)`) với regex trỏ tới **tên object**, **tên file**, và **repair SQL** (`test:105-116`, `:124-126`, `:152-155`) → không phải `rejects.toThrow()` trần. Đổi message thành chung chung sẽ đỏ.
- Test 5 assert **không có side-effect**: `db.inserts` và `db.ddl` rỗng (`test:165-166`) → chặn đúng lỗi "throw sau khi đã ghi ledger".
- Test 6 là guard chống **over-blocking**: pending 0037 phải được apply (`test:181`), rồi lần hai skip sạch (`test:184`). Đây là test chống lỗi "fix đại trà quá mức" — nhiều fix thiếu loại này.
- Test 1 chặn false-positive khi healthy (`applied`, `inserts`, `ddl` đều rỗng).

### Test (7) "exhaustive" — exhaustive thật, NHƯNG trên một vũ trụ hẹp hơn tên gọi. Đây là nhận xét quan trọng nhất của leg B.

- **Nó thật sự duyệt TẤT CẢ file shipped**, không phải vài file: `for (const file of migrationFiles())` (`test:175`), và với mỗi object thì drop và chờ throw (`test:179-189`). Vòng lặp này cũng là lý do test mất 305 ms so với ~5–20 ms của các test khác.
- **Nhưng danh sách object để thử lấy từ chính extractor CỤC BỘ của test** (`test:175` → `declaredObjects(file.sql)`), và extractor đó là **bản sao y hệt** regex của implementation (`test:27-35` vs `migrations.ts:112-121`, cùng regex, cùng `.toLowerCase()`, cùng cách bỏ comment).
- Hệ quả: một khoảng trống **có mặt ở cả hai bản** sẽ không bao giờ bị test nào chạm — test (7) không thấy `CREATE EXTENSION pgcrypto` (`0001:5`), không thấy index của `PRIMARY KEY` (`0015:75`) để mà thử drop. Nói cách khác: test (7) exhaustive **trên tập `CREATE TABLE/INDEX` mà regex nhìn thấy**, không phải trên toàn bộ object mà migration thật sự tạo ra.
- **Phần header của test cần đính chính**: nó viết *"independent of the implementation so a parser gap in the implementation surfaces as a failed assertion, not as a shared blind spot"*. Câu đúng một nửa: bản sao **có** bắt được trường hợp hai regex **lệch nhau** (nếu implementation thu hẹp, test (7) drop một tên mà implementation không còn probe ⇒ migrate resolve ⇒ đỏ). Nhưng nó **không** bắt được khoảng trống **dùng chung**, và chính khoảng trống dùng chung là loại rủi ro MED-1 quan tâm. Không coi đây là FAIL của test, nhưng là một tuyên bố mạnh hơn sự thật.
- **Pin mạnh nhất** là test (8): `expect(objects).toEqual([...3 tên…])` cho 0037 (`test:197-201`) — vì là danh sách **chính xác do người đọc SQL rút ra**, nếu regex bỏ sót một object thật của 0037 thì `toEqual` đỏ. Test (9) và (10) dùng `toContain`/`not.toContain` ⇒ yếu hơn, chỉ chứng minh có, không chứng minh không thừa.
- **Giới hạn offline đã được nói thẳng trong test**: `ScriptedCatalogDb` trả probe bằng **tên object truyền vào** (`test:60-63`), nên nó không chứng minh được PG thật trả lời giống vậy, và không có bằng chứng nào trên **index có thật** vì nhánh probe chỉ khớp `information_schema.tables`. Suite live-gated (`tests/migrations.test.ts`) mới là nơi probe được thật sự kiểm — và nó chưa chạy (xem note lệnh 3).

## 6. RED — mọi FAIL

**Không có lỗi nào trong 4 lệnh của leg B.** Tất cả `exit: 0`, không dòng `✕`, không `Test Suites: … failed`. Cụ thể:

- tsc: exit 0, im lặng.
- suite MED-1 mới: 10/10 xanh.
- ledger-guard: 17/17 xanh.
- 0032-rollback + verify-trap-fix: 14/14 xanh.
- `migrations.test.ts` **không phải FAIL**: là suite live-gated, không chạy offline, tôi không bật `DU_LIVE_INFRA` nên nó không được tính là xanh lẫn không cũng không phải đỏ.

Các **nhận xét mở** (không phải test đỏ, là khoảng hở thiết kế đã được đo bằng file:line): A1–A7 ở §2, side-effect tiền throw ở §3, residual verify-only boot ở §4, và mức exhaustive thật của test (7) ở §5.

## 7. Xác nhận ranh giới

- **KHÔNG tick gate nào.** Không sửa `tasks/` plan WFA, không sửa `coordination/gates/`.
- **KHÔNG viết VERIFIED/ACCEPTED.** §4 chỉ là **thẩm định của tôi về mức độ đóng**, không phải phán quyết gate.
- Không sửa file `src/` hay test/ nào; không `git add` / `commit` / `push`.
- Không sửa `docs/21-openapi.json`.
- Offline only: không mở DB window, không claim DB window, không chạy live DB.
- File duy nhất tạo/ghi: receipt này.