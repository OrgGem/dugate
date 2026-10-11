# DISPATCH — LDBA-09 — Runner contract reconciliation cho LDBA-03

**Task ID:** `LDBA-09`
**Repo scope:** `D:/Git/dugate` — **VIẾT** runner `ldba-03-backfill.cjs` (controlled skip + pending-rehash identity + diagnostic `row.key`) + test offline + harness in-container + receipt. **ĐỌC** runner hiện tại, adapter LDBA-08, migrations orchestrator `001..0037`, migrations connector `001..009`, DDL `0023_admin_local_users`, DDL `0026_profile_policy`, module LDBA-04/05/06.
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` — **đọc lại §4 (sáu mismatch cứng), §4.1 tenant, §4.2 ID text vs uuid, §4.3 bcrypt vs scrypt, §4.6 workflow schema, bảng LDBA-09.**
**Owner:** terminal `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` (Codex-4) — **đã đọc màn hình: IDLE tại prompt**; tác giả runner `ldba-03-backfill.cjs` (1210 dòng) nên **biết chính xác contract adapter** — đây là owner duy nhất đủ điều kiện sửa runner mà không phá contract.
**Dependencies:** LDBA-03 ACCEPTED (runner) · LDBA-04/05/06 ACCEPTED (adapter chuyên biết) · LDBA-07 NOT-PASS · LDBA-08 **NOT-PASS** (`BLOCKED_TRANSFORM`) — LDBA-09 là packet **bắt buộc** để LDBA-08 có thể chạy tới `PREFLIGHT_READY`.
**Mode:** implementation trên **DB rehearsal dùng một lần** (disposable PG16, fresh schema, synthetic data). **KHÔNG** đọc DB production/legacy. **KHÔNG** chạy migration lên DB thật. **KHÔNG** chạy backfill lên DB thật.
**Receipt path:** `du-rework/coordination/reports/ldba-09-runner-reconciliation.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet này

LDBA-08 (Codex-4) đã chạy đầy đủ một lần preflight với adapter production thật trên PG16 disposable và kết thúc ở `BLOCKED_TRANSFORM`, exit 1. Bằng chứng: `du-rework/coordination/reports/ldba-08-production-adapter.md`.

Kết luận đã chốt (coordinator đồng ý hoàn toàn): **đây là contract gap giữa runner `ldba-03-backfill.cjs` và các adapter chuyên biết LDBA-04/05/06, không phải lỗi implementer.** Codex-4 đã đúng khi không bịa credential và không tự sửa module ngoài lease.

Ba khoảng cách cụ thể mà LDBA-09 phải khớp được, mỗi khoảng cách đã trích tới **dòng code cụ thể**:

| # | Khoảng cách | Vị trí trong runner | Vị trí trong adapter đã ACCEPTED |
|---|---|---|---|
| G1 | Identity: runner đòi hash scrypt sẵn sàng lúc backfill; LDBA-04 chỉ sinh hash sau khi người dùng nhập plaintext ở lần login đầu | `ldba-03-backfill.cjs:650-683` (`mapUser`, kiểm `SCRYPT_HASH.test` tại `:664`) | `legacy-user-adapter.ts:132-164` (`migrateLegacyLocalCredentialOnLogin`) |
| G2 | Connector: runner không có đường skip nào; mọi `fail()` thành `BLOCKED_TRANSFORM` | `ldba-03-backfill.cjs:372-454` (`mapConnector`) + `:985-988` | `legacy-connector-adapter.ts` (chỉ nhận auth type đã duyệt) |
| G3 | Override: legacy `connectionId` là text; runner đòi uuid; DDL đích **cố tình** giữ `connection_id uuid NOT NULL` | `ldba-03-backfill.cjs:456-476` (`mapOverride`, `uuid(...connectionId)` tại `:458`) | `0026_profile_policy.sql:121-139` (có ghi chú correction từ chối nới sang text) |
| G4 | Diagnostic: báo cáo trùng lặp workflow in `undefined` vì đọc `row.id` trong khi source key của `AppSetting` là `row.key` | `ldba-03-backfill.cjs:758` (sort tiebreak) và `:773-774` (report) | — |

⇒ LDBA-09 là packet **implementation** duy nhất: sửa runner để nó biết ba khái niệm mới — **controlled skip**, **pending-rehash identity**, **diagnostic đúng source key** — mà không làm loãng điều kiện chặn hiện có.

## 1. Vùng lease — chốt cụ thể

### 1.1. File **được VIẾT** (lease)

| # | Path (tương đối từ `du-rework/orchestrator/`) | Vai trò |
|---|---|---|
| W1 | `services/orchestrator/scripts/ldba-03-backfill.cjs` | **Runner** — sửa theo §2 (controlled skip, pending-rehash, diagnostic `row.key`). File duy nhất được sửa trong source production. |
| W2 | `services/orchestrator/tests/ldba-03-runner-skip.test.cjs` | Test offline cho cơ chế skip + diagnostic + gate (fake adapter, không cần DB). |
| W3 | `services/orchestrator/scripts/ldba-09-skip-fixture-adapter.cjs` | **Adapter fixture** (test-only) khai báo skip có chủ đích cho từng hàng để harness chứng minh cơ chế. |
| W4 | `services/orchestrator/scripts/ldba-09-harness.cjs` | **Harness in-container** (test-only): dựng container disposable, áp migrations, seed synthetic, chạy W3 và chạy lại adapter LDBA-08 để đối chiếu hồi quy. |
| W5 | `du-rework/coordination/reports/ldba-09-runner-reconciliation.md` | Receipt. |

### 1.2. File **chỉ ĐỌC** (không sửa)

- `services/orchestrator/scripts/ldba-03-production-adapter.cjs` — adapter LDBA-08 (tham chiếu contract hiện có; **không sửa**).
- `services/orchestrator/scripts/ldba-08-harness.cjs` — harness LDBA-08 (tiền lệ kỹ thuật in-container).
- `services/orchestrator/migrations/0001_platform_v1.sql` … `0037_*.sql` — schema đích.
- `services/connector/src/db/migrations/001_connector.sql` … `009_*.sql` — schema connector.
- `services/orchestrator/src/modules/identity/legacy-user-adapter.ts` — LDBA-04 (đường re-hash đã ACCEPTED).
- `services/connector/src/db/legacy-connector-adapter.ts` — LDBA-05.
- `services/orchestrator/src/modules/workflow-schemas/legacy-workflow-schema-backfill-adapter.ts` — LDBA-06.

### 1.3. **Ngoài lease** (cấm sửa)

- Mọi file source production ngoài W1 (migration, contract, catalog, crypto, BFF, UI, adapter LDBA-04/05/06).
- `package.json`, lockfile, Compose, Dockerfile, `.env*`.
- DB production / DB legacy / DB shared `:5433`.

## 2. Ba thay đổi bắt buộc trong runner

Mọi anchor dòng dưới đây là **trước khi sửa** (runner LDBA-03 đã ACCEPTED, 1210 dòng). **Tên hàm là thẩm quyền cuối cùng** — nếu dòng dịch chuyển, theo tên hàm.

### 2.1. Controlled skip — cơ chế skip có kiểm soát

**Vấn đề.** Runner hiện chỉ có hai kết quả cho một hàng nguồn: ghi được (writes) hoặc `fail()` → `BLOCKED_TRANSFORM` (`:985-988`). Không có kết quả thứ ba. Nên adapter không có cách nào nói **hàng này cố ý không nạp trong v1** mà không làm đỏ cả lượt.

**Thiết kế.** Thêm một kết quả thứ ba, **có kiểm soát**, với bốn lớp chặn.

**(a) Kiểu `RowSkip`** — một lỗi đánh dấu, cùng họ với `RowFailure` (`:89-102`):

```js
class RowSkip extends Error {
  constructor(table, sourceKey, field, code, reason) {
    super(reason);
    this.name = 'RowSkip';
    this.table = table;
    this.sourceKey = sourceKey === null || sourceKey === undefined ? '<unknown>' : String(sourceKey);
    this.field = field;
    this.code = code;
  }
}
```

**(b) Allowlist theo bảng** — hằng `SKIP_POLICIES`, chỉ những `(table, code)` này mới được coi là skip hợpệ:

```js
const SKIP_POLICIES = Object.freeze({
  ExternalApiConnection: Object.freeze([
    'CONNECTOR_ROW_OUT_OF_SCOPE',
  ]),
  ExternalApiOverride: Object.freeze([
    'OVERRIDE_CONNECTION_ID_NOT_UUID',
    'OVERRIDE_API_KEY_ID_NOT_UUID',
    'OVERRIDE_CONNECTOR_NOT_MIGRATED',
  ]),
  User: Object.freeze([
    'IDENTITY_PENDING_REHASH',
  ]),
  UserProfileAssignment: Object.freeze([
    'ASSIGNMENT_USER_NOT_MIGRATED',
    'ASSIGNMENT_USER_ID_NOT_UUID',
    'ASSIGNMENT_API_KEY_ID_NOT_UUID',
  ]),
});
```

**Chỉ bốn bảng này.** Mọi bảng khác (`Operation`, `ApiKey`, `ProfileEndpoint`, `AppSetting`, `FileCache`) **không bao giờ** được skip — mọi lỗi ở đó vẫn là `BLOCKED_TRANSFORM` như cũ. Đây là lớp chặn thứ nhất: **skip không thể nuốt lỗi của bảng không nằm trong allowlist.**

**(c) Hai tầng khai báo skip.**

- **Tầng R — runner tự quyết** (không cầm adapter). Runner tự kiểm tra điều kiện đọc được từ hàng và tự ném `RowSkip`. Dùng cho:
  - `ExternalApiOverride.connectionId` không khớp `UUID_PATTERN` → `OVERRIDE_CONNECTION_ID_NOT_UUID`.
  - `ExternalApiOverride.apiKeyId` không khớp `UUID_PATTERN` → `OVERRIDE_API_KEY_ID_NOT_UUID`.
  - `ExternalApiOverride.connectionId` trùng với một connector đã bị skip trong cùng lượt → `OVERRIDE_CONNECTOR_NOT_MIGRATED`.
  - `UserProfileAssignment.userId` / `apiKeyId` không khớp `UUID_PATTERN` → `ASSIGNMENT_USER_ID_NOT_UUID` / `ASSIGNMENT_API_KEY_ID_NOT_UUID`.
  - `UserProfileAssignment.userId` trùng với một user đã bị skip → `ASSIGNMENT_USER_NOT_MIGRATED`.
- **Tầng A — adapter khai báo** (chỉ cho `ExternalApiConnection` và `User`). Adapter biết chính xác hàng nào nằm ngoài phạm vi v1. Hai cách, runner cả hai đều nhận:
  - Adapter **trả về** một object `{ skipped: true, code, reason }` thay vì ném lỗi; hoặc
  - Adapter **ném** `RowSkip` mà runner export ra (xem §2.4).

**(d) Lớp chặn thứ hai — fail-closed khi code không được duyệt.** Nếu adapter khai báo một `(table, code)` **không** nằm trong `SKIP_POLICIES[table]`, runner **không** coi đó là skip. Runner chuyển nó thành `RowFailure` với code `UNAPPROVED_SKIP` và message nêu rõ code nào bị từ chối. Hệ quả: `BLOCKED_TRANSFORM`. Điều này ngăn adapter (hoặc một adapter mới viết) lợi thế cơ chế skip để nuốt lỗi tùy ý.

**(e) Lớp chặn thứ ba — lỗi cấu hình vẫn phải đỏ.** `AdapterConfigurationError` với code `CONTEXT_POLICY_REQUIRED` (adapter chưa được cấu hình context provider) **không bao giờ** được coi là skip. Chỉ có tín hiệu **theo hàng** mới skip. Trong adapter LDBA-08 hiện tại, `prepareConnector` ném `CONTEXT_POLICY_REQUIRED` khi thiếu context module (`ldba-03-production-adapter.cjs:112-113`) — đó là lỗi cấu hình, phải đỏ. Đây là ranh giới quan trọng nhất của cả packet: **lỗi cấu hình đỏ, hàng ngoài phạm vi thì skip.**

**(f) Lớp chặn thứ tư — gate vận hành.** Thêm env `LDBA_SKIP_POLICY` với hai giá trị:

| Giá trị | Hành vi |
|---|---|
| `report` (mặc định) | Skip được ghi vào `report.skips`, không đỏ. Dùng cho rehearsal và để liệt kê. |
| `fail` | Bất kỳ controlled skip nào cũng làm status thành `BLOCKED_SKIPPED_ROWS`, exit 1. Dùng làm cứng cho backfill thật. |

Mặc định `report` để rehearsal chạy tới cùng được; `fail` là cứng để ngưi vận hành phải xem xét danh sách skip trước khi thực sự nạp. **Không có giá trị thứ ba** — giá trị lạ → exit 2.

**(g) Báo cáo.** Thêm `report.skips` vào `emptyReport()` (`:698-714`), cùng shape với `report.failures`:

```js
skips: [],
```

Mỗi phần tử: `{ table, sourceKey, field, code, reason }`. Ngoài ra `report.sourceRows.skipped` và `report.perTable[table].skipped` **tiếp tục** tăng cho skip (đã có sẵn ở nhánh `:973-977`), để tổng số khớp với số hàng nguồn đã đọc.

**(h) Hook point.** Nhánh đã có sẵn tại `:973-977` là điểm nối tự nhiên:

```js
if (!Array.isArray(planned) || planned.length === 0) {
  report.sourceRows.skipped += 1;
  report.perTable[table].skipped += 1;
  continue;
}
```

Nhánh này đã đếm skip nhưng **không ghi lý do**. LDBA-09 mở rộng nó để ghi lý do khi kết quả trả về là một skip được khai báo, và thêm một nhánh `catch (error)` riêng cho `RowSkip` **trước** `catch (error)` chung, để `RowSkip` không bị `recordFailure` (`:716-729`) bọc thành `TRANSFORM_ERROR`.

**(i) Registry skip.** Thêm `report._skippedSourceKeys` (một `Map<table, Set<string>>`, không xuất ra JSON của report để không lọt vào output) để `mapOverride` và `mapAssignment` tra cứu được hàng nguồn đã skip. Khởi tạo trong `emptyReport()`.

**(j) Chữ ký hàm thay đổi.** `mapOverride(row, tenantId)` → `mapOverride(row, report, tenantId)` và `mapAssignment(row)` → `mapAssignment(row, report)`, vì cả hai cần registry skip. Cập nhật `transform()` (`:801-812`) cho khớp. **Đây là thay đổi chữ ký duy nhất ảnh hưởng tới adapter** — và nó **không** ảnh hưởng adapter LDBA-08, vì adapter không gọi `mapOverride`/`mapAssignment` (runner tự gọi).

### 2.2. Pending-rehash identity — ủy quyền cho LDBA-04

**Vấn đề.** `mapUser` (`:650-683`) đòi `auth.password_hash` phải khớp `SCRYPT_HASH` (`:664`). Nhưng LDBA-04 (`legacy-user-adapter.ts:132-164`) chỉ sinh hash scrypt **sau khi** người dùng nhập plaintext ở lần login đầu, và từ chối tạo identity bị khóa với mật khẩu không biết. Hai điều kiện này loại trừ lẫn nhau theo cấu trúc.

**Ràng buộc schema không thể vượt qua.** `0023_admin_local_users.sql:10-11`:

```sql
password_hash text NOT NULL
  CHECK (password_hash ~ E'^scrypt\\$32768\\$8\\$1\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{43}$'),
```

`password_hash` là `NOT NULL` với CHECK định dạng scrypt cứng. **Không có giá trị pending nào có thể lưu được** — không NULL, không chuỗi rỗng, không hash giả. Nên pending-rehash **bắt buộc** phải là một kết quả skip ở tầng runner, hoãn sang đường login đầu của LDBA-04, **không bao giờ** là một giá trị hash.

**Thiết kế.** Trong `mapUser`, trước khi kiểm tra hash, gọi `context.prepareAdminLocalUser` và nhận **hai** dạng trả về hợp lệ:

```js
// Dạng 1 — identity sẵn sàng (giữ nguyên hành vi hiện tại)
{ password_hash: '<scrypt>', is_enabled: true, is_locked?: false }

// Dạng 2 — hoãn sang login đầu (THÊM MỚI)
{ pending: true, reason: '<text>' }
```

Quy tẩc trong `mapUser`:

1. Validate `username` và `role` **trước** (giữ nguyên `:651-658`) — một hàng skip không được che bởi username hay role không hợp lệ.
2. Gọi `context.prepareAdminLocalUser(row, { username, role, tenantId })` (`:660`).
3. Nếu kết quả có `pending === true` → ném `RowSkip('User', row, 'password', 'IDENTITY_PENDING_REHASH', reason)`. Runner ghi skip, **không** ghi write, **không** sinh hash, **không** ghi hàng `admin_local_users`.
4. Nếu kết quả có `password_hash` khớp `SCRYPT_HASH` và `is_enabled` là boolean → giữ nguyên đường hiện tại (`:661-683`).
5. Bất kỳ dạng nào khác → `fail(..., 'INVALID_IDENTITY_ADAPTER_OUTPUT', ...)` như hiện tại.

**Tương thích ngược bắt buộc với adapter LDBA-08.** Adapter hiện tại (`ldba-03-production-adapter.cjs:511-516`) **ném** `AdapterConfigurationError` với code `PASSWORD_RESET_REQUIRED` thay vì trả `{ pending: true }`. Runner phải nhận diện được trường hợp này để adapter LDBA-08 **không cần sửa** vẫn chạy được: nếu `prepareAdminLocalUser` ném lỗi có `error.code === 'PASSWORD_RESET_REQUIRED'`, runner coi đó là skip `IDENTITY_PENDING_REHASH` với reason lấy từ `error.message`. Ghi rõ trong receipt đây là **tương thích ngược**, và ghi open item: adapter LDBA-08 nên được cập nhật sang dạng `{ pending: true }` trong một packet sau (ngoài lease LDBA-09).

**Không bao giờ:** runner tự sinh hash scrypt, tự tạo hash giả, tự ghi hàng `admin_local_users` với hash rỗng, hoặc tự đặt `is_locked` để bù một hash không tồn tại. Nếu một trong bốn việc đó xuất hiện trong diff, **packet này là NOT-PASS**.

**Hệ quối `UserProfileAssignment`.** `0026_profile_policy.sql:161-166` khai `user_profile_assignments.user_id uuid NOT NULL REFERENCES admin_local_users(id) ON DELETE RESTRICT`. Một assignment trỏ tới user bị skip sẽ vi phạm FK. Nên `mapAssignment` phải skip assignment khi `userId` nằm trong registry skip của `User` (§2.1i). Đây là lý do `UserProfileAssignment` phải có trong `SKIP_POLICIES`.

### 2.3. Sửa diagnostic `row.key`

**Vấn đề.** `SOURCE_KEY.AppSetting` là `row.key` (`:80`), nhưng `selectWorkflowWinners` (`:731-779`) đọc `row.id` — một field **không tồn tại** trên hàng `AppSetting`. Kết quả: `undefined`.

**Hai chỗ, không phải một.** Cả hai phải sửa, nếu không implementer sẽ sửa chỗ hiển thị mà bỏ qua chỗ ngầm:

| Vị trí | Dòng (trước sửa) | Hiện tại | Phải thành |
|---|---|---|---|
| Sort tiebreak | `:758` | `String(left.row.id).localeCompare(String(right.row.id))` | `String(left.row.key).localeCompare(String(right.row.key))` |
| Báo cáo trùng lặp | `:773` | `winner: String(winner.row.id)` | `winner: String(winner.row.key)` |
| Báo cáo trùng lặp | `:774` | `skipped: String(loser.row.id)` | `skipped: String(loser.row.key)` |

**Tại sao chỗ `:758` quan trọng hơn vẻ bề ngoài.** Với hai hàng cùng slug cùng `updatedAt`, tiebreak hiện tại so `'undefined'` với `'undefined'` — luôn bằng nhau, tức **là một no-op âm thầm**. `bucket[0]` rồi được chọn theo thứ tự chèn của `groups` (một `Map`), tức **không xác định** đối với cùng một dữ liệu seed khác nhau. Sửa `:758` khiến lựa chọn winner trở nên **tất định** theo `row.key`. Đây là sửa chữa một lỗi đúng nghĩa, không phải làm đẹp.

**Không được** sửa `SOURCE_KEY` (`:80`) — nó đã đúng. Không được thêm field `id` giả vào hàng `AppSetting`.

### 2.4. Xuất API mới

`module.exports` (`:1195-1210`) thêm:

```js
RowSkip,
SKIP_POLICIES,
```

Để test offline và adapter fixture có thể dùng cùng định nghĩa với runner, không định nghĩa lại.

## 3. Harness in-container — hướng dẫn bắt buộc

Mục đích: chứng minh ba thay đổi trên **PG thật** mà **không** publish port, **không** đụng DB thật. Kỹ thuật đã chứng minh khả thi ở LDBA-07 §6 và LDBA-08 §3.

### 3.1. Container disposable (tiền lệ `migration-0032-restore-rehearsal-2026-10-05.md`)

```
docker run -d --name du-ldba09-rehearsal --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=<synthetic> -e POSTGRES_DB=du_ldba09_rehearsal postgres:16-alpine
```

- `--network none`, **không publish port**, tmpfs, **remove** sau khi xong.
- Docker đã sẵn sàng (server 28.5.1).

### 3.2. Node chạy **trong** container (không cần publish port)

LDBA-07/08 đã chứng minh:

```
docker create --name ldba09-node-src node:24.21.0-alpine3.24
docker cp ldba09-node-src:/usr/local/bin/node <host>/node-linux
docker cp <host>/node-linux du-ldba09-rehearsal:/tmp/node
docker exec du-ldba09-rehearsal /tmp/node -v    # -> v24.21.0
```

Bổ sung: copy `node_modules/pg` (thuần JS) và bản build của runner + W3 + W2 vào container, chạy bằng `/tmp/node`. Kết nối PG trong container qua **unix socket** hoặc `localhost` (vì `--network none` vẫn có loopback).

### 3.3. Áp migrations — **cả hai bộ** vào cùng container

Đã đo ở LDBA-08: bộ connector `001..009` dùng ledger riêng `connector_schema_migrations` (9 dòng), **zero name collision** với 28 bảng orchestrator. ⇒ áp cả hai vào cùng container.

- Bộ orchestrator `001..0037` (37 file) — mỗi file **một transaction** (`psql -1 -v ON_ERROR_STOP=1 -f`) + **một dòng ledger** `INSERT INTO schema_migrations (sequence, filename)`, đúng ngữ nghĩa `migrate()`.
- Bộ connector `001..009` (9 file) — cùng cách, ledger `connector_schema_migrations`.
- **Ghi rõ** trong receipt: số file áp được, số bảng tạo ra, `count(*) from schema_migrations`, `count(*) from connector_schema_migrations`.

### 3.4. Seed synthetic (tự dựng, không từ DB thật)

Seed dữ liệu **legacy-shaped** vào các bảng legacy (PascalCase). **Timestamp dùng UTC tường minh** (ví dụ `2026-01-01T00:00:00Z`) — xem mục 4 về A1. Ít nhất:

| Bảng nguồn | Số hàng | Mục đích chọn lọc |
|---|---|---|
| `ExternalApiConnection` | 3 | 1 hàng id **uuid** + auth type được duyệt (phải **ghi được**); 1 hàng id **uuid** + auth type không được duyệt (phải **skip**); 1 hàng id **text** (phải **ghi được** — `connector_revisions.connector_id` là TEXT) |
| `ExternalApiOverride` | 3 | 1 hàng `connectionId` **uuid** trỏ tới connector đã ghi (phải **ghi được**); 1 hàng `connectionId` **text** (phải **skip** `OVERRIDE_CONNECTION_ID_NOT_UUID`); 1 hàng `connectionId` **uuid** trỏ tới connector đã skip (phải **skip** `OVERRIDE_CONNECTOR_NOT_MIGRATED`) |
| `User` | 3 | 1 hàng `password` đúng định dạng bcrypt (phải **skip** `IDENTITY_PENDING_REHASH`); 1 hàng `password` rỗng (phải **skip** `IDENTITY_PENDING_REHASH`); 1 hàng có `provider` OIDC (phải **skip** `IDENTITY_PENDING_REHASH`) |
| `UserProfileAssignment` | 2 | 1 hàng trỏ tới user đã ghi (phải **ghi được**); 1 hàng trỏ tới user đã skip (phải **skip** `ASSIGNMENT_USER_NOT_MIGRATED`) |
| `AppSetting` | 3 | 2 hàng cùng slug workflow, cùng `updatedAt`, **khác `key`** — để chứng minh tiebreak `:758` chọn đúng và báo cáo in **key thật** không phải `undefined`; 1 hàng non-workflow (skip có lý do, tiền lệ `:736-741`) |
| `ApiKey` | 2 | Không thay đổi hành vi |
| `Operation` | 2 | Không thay đổi hành vi |
| `ProfileEndpoint` | 2 | Không thay đổi hành vi |
| `FileCache` | 2 | Không thay đổi hành vi |

**Ghi rõ** số hàng seed từng bảng trong receipt.

### 3.5. Chạy runner — hai lượt bắt buộc

**Lượt 1 — fixture adapter (W3), chính sách mặc định:**

```
LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<path W3> LDBA_SKIP_POLICY=report \
  /tmp/node services/orchestrator/scripts/ldba-03-backfill.cjs --preflight
LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<path W3> LDBA_SKIP_POLICY=report \
  /tmp/node services/orchestrator/scripts/ldba-03-backfill.cjs --execute
```

Kỳ vọng: `PREFLIGHT_READY` rồi `APPLIED`, exit 0. `report.skips` phải liệt kê **đúng** các hàng đã chọn ở §3.4 với **đúng** code. `report.workflowDuplicates` phải in **key thật**, không phải `undefined`.

**Lượt 2 — cùng fixture, chính sách cứng:**

```
LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<path W3> LDBA_SKIP_POLICY=fail \
  /tmp/node services/orchestrator/scripts/ldba-03-backfill.cjs --preflight
```

Kỳ vọng: `BLOCKED_SKIPPED_ROWS`, exit 1. Chứng minh cứng hoạt động.

**Lượt 3 — hồi quy adapter LDBA-08 (chỉ đọc, không sửa):**

```
LDBA_A1_PASSED=1 LDBA03_ADAPTER_MODULE=<path adapter LDBA-08> \
  /tmp/node services/orchestrator/scripts/ldba-03-backfill.cjs --preflight
```

Kỳ vọng: **không** còn `INVALID_UUID` cho override (đã thành skip có lý do); **không** còn `TRANSFORM_ERROR` cho user (đã thành skip `IDENTITY_PENDING_REHASH`); **còn** `TRANSFORM_ERROR` cho connector/profile/workflow/file vì những context policy đó vẫn chưa tồn tại — và đó là **đúng**, không phải hồi quy. Ghi rõ từng code còn lại trong receipt.

**Đối chiếu source/target counts** cho từng entity trong `DESTINATION_ORDER` ở Lượt 1. **Zero parse failure** ngoài các skip đã liệt kê. **Idempotent**: chạy execute **2 lần**, lần 2 toàn bộ `identical`.

## 4. A1 (timezone) — giới hạn trung thực

Runner LDBA-03 đọc timestamp naive là UTC cố định. **A1 (timezone runtime legacy thật) vẫn mở** và LDBA-09 **không thể** đóng nó vì không được đọc DB legacy thật. Trên rehearsal, dữ liệu synthetic dùng UTC tường minh nên giả định UTC của runner được kiểm soát. **Ghi rõ trong receipt:** đây là bằng chứng runner đúng với dữ liệu UTC, **không phải** đóng A1. A1 vẫn mở cho real backfill.

## 5. Tiêu chí nghiệm thu — đã chốt cụ thể

- [ ] Runner có `RowSkip` và `SKIP_POLICIES`, xuất qua `module.exports`.
- [ ] `SKIP_POLICIES` chỉ gồm đúng bốn bảng `ExternalApiConnection`, `ExternalApiOverride`, `User`, `UserProfileAssignment`; không bảng khác.
- [ ] Skip được ghi vào `report.skips` với đủ `table`, `sourceKey`, `field`, `code`, `reason`.
- [ ] Skip làm tăng `report.sourceRows.skipped` và `report.perTable[table].skipped`.
- [ ] `(table, code)` ngoài allowlist → `UNAPPROVED_SKIP` → `BLOCKED_TRANSFORM` (không phải skip).
- [ ] `CONTEXT_POLICY_REQUIRED` (lỗi cấu hình) **không** bao giờ thành skip.
- [ ] `LDBA_SKIP_POLICY=fail` + có skip → `BLOCKED_SKIPPED_ROWS`, exit 1.
- [ ] `LDBA_SKIP_POLICY` nhận giá trị lạ → exit 2.
- [ ] `mapUser` nhận `{ pending: true }` → skip `IDENTITY_PENDING_REHASH`, **không** ghi hàng `admin_local_users`.
- [ ] `mapUser` nhận `error.code === 'PASSWORD_RESET_REQUIRED'` từ adapter → skip `IDENTITY_PENDING_REHASH` (tương thích ngược).
- [ ] `mapUser` vẫn `fail` với `INVALID_IDENTITY_ADAPTER_OUTPUT` cho dạng trả về không hợp lệ.
- [ ] `mapOverride` skip đúng ba code `OVERRIDE_*`; `mapAssignment` skip đúng ba code `ASSIGNMENT_*`.
- [ ] Sort tiebreak `:758` dùng `row.key`; báo cáo `:773-774` in `row.key` thật, không phải `undefined`.
- [ ] `mapOverride` và `mapAssignment` nhận `report` và dùng registry skip.
- [ ] Test offline W2 pass, exit 0 (fake adapter, không cần DB).
- [ ] Harness W4 dựng được container disposable PG16, `--network none`, không publish port.
- [ ] Áp được **cả hai** bộ migration vào cùng container; ghi rõ số file + số bảng + ledger count.
- [ ] Seed synthetic legacy-shaped, timestamp UTC tường minh, đúng bảng §3.4.
- [ ] Lượt 1: `PREFLIGHT_READY` rồi `APPLIED`, exit 0.
- [ ] Lượt 1: `report.skips` khớp **đúng** danh sách hàng + code đã chọn ở §3.4.
- [ ] Lượt 1: `report.workflowDuplicates` in key thật.
- [ ] Lượt 2: `BLOCKED_SKIPPED_ROWS`, exit 1.
- [ ] Lượt 3: không còn `INVALID_UUID` cho override; không còn `TRANSFORM_ERROR` cho user; còn `TRANSFORM_ERROR` cho connector/profile/workflow/file.
- [ ] **Source/target counts khớp** cho từng entity trong `DESTINATION_ORDER` (Lượt 1).
- [ ] **Zero parse failure** ngoài các skip đã liệt kê.
- [ ] **Idempotent**: execute 2 lần, lần 2 toàn bộ `identical`.
- [ ] **A1 ghi rõ là vẫn mở** (rehearsal UTC không đóng A1).
- [ ] Receipt ghi: mỗi entity số source/target, **danh sách skip đầy đủ từng hàng kèm code và lý do**, mọi open item.
- [ ] File receipt **không** ký tự nháy kép, **không** trailing whitespace.

## 6. Ranh giới (bắt buộc)

- **KHÔNG** đọc DB production/legacy/shared `:5433`. Chỉ container disposable.
- **KHÔNG** chạy migration lên DB thật. Chỉ container rehearsal.
- **KHÔNG** chạy backfill lên DB thật. Chỉ container rehearsal.
- **KHÔNG** sửa source production ngoài W1 (migration, contract, catalog, crypto, BFF, UI, adapter LDBA-04/05/06, adapter LDBA-08).
- **KHÔNG** nới `connector_prompt_overrides.connection_id` sang text — `0026_profile_policy.sql:121-139` có ghi chú correction từ chối điều đó; override với connection id text phải **skip**, không phải mở rộng schema.
- **KHÔNG** sinh hash scrypt, hash giả, hoặc ghi `admin_local_users` với `password_hash` rỗng — `0023_admin_local_users.sql:10-11` cấm.
- **KHÔNG** thêm bảng vào `SKIP_POLICIES` ngoài bốn bảng đã liệt kê.
- **KHÔNG** commit, `git add`, push, không tick gate.
- **KHÔNG** để container rehearsal sau khi xong (remove).
- **KHÔNG** dùng dữ liệu thật làm fixture.

## 7. Khi nào **phải dừng**

Dừng và ghi `Open items for coordinator` nếu:

- Không dựng được container PG16 disposable (Docker lỗi, port xung đột).
- Migration `001..0037` hoặc `001..009` chạy lên rehearsal lỗi (schema conflict).
- Lượt 1 không ra `PREFLIGHT_READY` + `APPLIED`.
- Lượt 2 không ra `BLOCKED_SKIPPED_ROWS`.
- Lượt 3 vẫn còn `INVALID_UUID` cho override, hoặc vẫn còn `TRANSFORM_ERROR` cho user.
- `report.workflowDuplicates` vẫn in `undefined`.
- Bất kỳ skip nào ngoài danh sách đã chọn ở §3.4.
- Bất kỳ parse failure không giải thích được.
- Bất kỳ yêu cầu nào ở §6.

**Dừng đúng cách là hành vi được chấp nhận.**

## 8. Dispatch proof

- **Request ID:** `LDBA-09-2026-10-09`
- **Owner:** `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` (Codex-4) — đã đọc màn hình, **IDLE tại prompt**, tác giả runner `ldba-03-backfill.cjs`.
- **Dependency evidence:** LDBA-03 ACCEPTED (runner); LDBA-04/05/06 ACCEPTED (adapter chuyên biết); LDBA-07 NOT-PASS; LDBA-08 NOT-PASS (`BLOCKED_TRANSFORM`, receipt `ldba-08-production-adapter.md`); plan §4 (sáu mismatch), bảng LDBA-09.
- **Acceptance:** runner có controlled skip có kiểm soát + pending-rehash identity + diagnostic `row.key` đúng, chứng minh trên PG thật disposable, không hồi quy LDBA-08.

## 9. Errata của coordinator (2026-10-09, sau khi review receipt)

Hai yêu cầu fixture ở §3.4 **tự mâu thuẫn**, coordinator chốt lại như sau. Packet tiếp theo `2026-10-09-LDBA-09A-fixture-unblock.md` thực hiện đúng chốt này.

1. **AppSetting — §3.4 yêu cầu khác `key`, nhưng slug suy từ `key`.** `appSettingSlug(row)` (`ldba-03-backfill.cjs:650-654`) lấy `row.key.slice('wb_schema:'.length)` ⇒ hàng khác `key` thì **luôn** khác slug. Yêu cầu không thỏa được. **Chốt:** seed 2 hàng **cùng** `key` (`wb_schema:analyze`), cùng `updatedAt` — vẫn chạy nhánh winner/duplicate và chứng minh `:773-774` in key thật. Nguồn legacy thật có `AppSetting.key` UNIQUE nên va chạm khác-key là không thể; tiebreak `:758` chỉ verify bằng đọc code, không chứng minh bằng fixture.
2. **User / assignment — §3.4 yêu cầu 3 user pending VÀ assignment trỏ user đã ghi.** Mâu thuẫn nhau trừ khi có sẵn hash scrypt, mà tạo hash trong fixture vi phạm §6. **Chốt:** cả 3 user pending; assignment[0] trỏ user pending (skip `ASSIGNMENT_USER_NOT_MIGRATED`), assignment[1] dùng `userId` non-UUID (skip `ASSIGNMENT_USER_ID_NOT_UUID`). Không tạo hash. Đường ghi assignment được bù bằng test offline trong W2.
3. **Harness `assertReportSkips` bị hoán hai dòng override** — seed `fixtureOverride(index)` đặt `connectionId: CONNECTOR_IDS[index]`; runner check `OVERRIDE_CONNECTOR_NOT_MIGRATED` **trước** `OVERRIDE_CONNECTION_ID_NOT_UUID` (`:549-554`) ⇒ `OVERRIDE_IDS[1]` phải là `OVERRIDE_CONNECTOR_NOT_MIGRATED`, `OVERRIDE_IDS[2]` phải là `OVERRIDE_CONNECTION_ID_NOT_UUID`. Bug thật của W4, sửa trong LDBA-09A.
