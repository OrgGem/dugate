# A1-TZ-EVIDENCE — Bằng chứng timezone của DB legacy (read-only) — 2026-10-10

**Task:** `A1-TZ-EVIDENCE` (PLAN-OPEN §9.2 #1 · §9.3 hạng 4).
**Canonical plan:** `coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (mục D `:462-465`), `coordination/PLAN-OPEN-2026-10-09.md:60,275-282`.
**Repo scope:** `D:/Git/dugate` (root = hệ legacy, read-only) + `du-rework` (đọc). Ghi duy nhất 1 file receipt này.
**Lease:** READ-ONLY hoàn toàn — 0 sửa code/test/migration/schema; **không** mở cửa sổ DB/Redis/S3, **không** chạy suite; không `git add`/`commit`/`push`.
**Owner:** lane A1-TZ-EVIDENCE. **Verifier:** chưa chỉ định (receipt này là intake, không tick gate).

---

## 0. VERDICT (đọc trước)

**Chưa chứng minh được từ repo. Hai nhánh còn sống, lệch nhau đúng 7 giờ cho MỌI hàng.**

| Nhánh | Nội dung | Mức bằng chứng trong repo |
|---|---|---|
| **A. UTC** | cột naive lưu **UTC wall time** ⇒ runner `ldba-03-backfill.cjs` (đọc naive là UTC) **đúng** | **Gián tiếp, mạnh**: toàn bộ code legacy coi cột naive là UTC (E4), và topology deploy được tài liệu hoá không pin timezone ở cả hai phía (E5/E6) |
| **B. Local (+07:00)** | cột naive lưu **local wall time** (Asia/Bangkok) ⇒ runner dịch sai instant của **mọi** hàng, **im lặng, 0 lỗi** | **Có thật**: đường cài "Postgres cục bộ" trong README trên máy này, và host dev là +07 (E8) |

**Không có artifact nào trong repo chứa một giá trị timestamp legacy đã lưu để đối chiếu với một mốc đồng hồ đã biết.** Vì vậy A1 **không đóng được bằng đọc repo**; theo PLAN-OPEN §9.2 (`Nếu không tìm ra ⇒ A1 phải hỏi user chứ không đoán`), đề xuất ở §6 là **xin user uỷ quyền 1 truy vấn read-only duy nhất** trên DB legacy.

**Phát hiện phụ, quan trọng không kém:** trong **cùng một bảng**, `createdAt` được ghi bởi **DB** (`CURRENT_TIMESTAMP(3)`, phụ thuộc session TimeZone) còn `updatedAt` được ghi bởi **JS** (driver serialize UTC) ⇒ hai nguồn gốc khác nhau. Xem §4. Nghĩa là ngay cả `SHOW TimeZone` một mình **cũng chưa đủ** để chốt.

---

## 1. Phương pháp

Đọc tĩnh trên working tree (không build/test/DB). Công cụ: `glob`, `grep_search`, `read_file` — chỉ đọc.

Các truy vấn đã chạy (nguyên văn, để tái lập):

| # | Pattern | Phạm vi | Kết quả |
|---|---|---|---|
| 1 | `timezone`, `TimeZone`, `TIMEZONE`, `UTC` | `du-rework` | 140 / 140 / n/a / 2466 hit — phần lớn là rework (`timestamptz`, ledger UTC), không phải legacy |
| 2 | `PGTZ` | toàn repo | **0 hit** |
| 3 | `SET TIME ZONE` / `setTimeZone` / `set timezone` | toàn repo | **0 hit** |
| 4 | `process.env.TZ` \| `TZ=` | toàn repo | **0 hit** |
| 5 | `withTimezone` \| `with time zone` \| `timestamptz` \| `TimeZone` | `lib`, `app`, `drizzle`, `components`, `tests`, `docs` (legacy) | **0 hit ở cả 6 thư mục** |
| 6 | `::timestamp` \| `::timestamptz` \| `AT TIME ZONE` | toàn repo | có, xem E4 (chỉ `::timestamp`, **không** có `::timestamptz` trong legacy) |
| 7 | `naive` \| `wall time` \| `wall-clock` | toàn repo | có, xem E7 |

**Giới hạn công cụ (ghi để không ai đọc nhầm):** `grep_search` tôn trọng `.gitignore`; truy vấn #5 phải chạy theo **từng thư mục legacy** vì grep toàn repo bị nhiễu bởi `node_modules/` + bundle `worker.js` (383 hit, gần hết là `.d.ts` và bundle drizzle). Truy vấn #5 ở dạng thư-mục-scoped là bằng chứng phủ định hợp lệ.

---

## 2. Bảng bằng chứng

### E1 — Cột timestamp legacy là NAIVE (`timestamp without time zone`) — **CHẮC CHẮN**

Mọi cột thời gian của cả 9 bảng legacy đều khai `timestamp(...)` **không** có `withTimezone`:

- `lib/db/schema.ts:36` `webhookSentAt`, `:40` `createdAt`, `:41` `updatedAt`, `:42` `deletedAt` (bảng `Operation`)
- `:63-64` (`ApiKey`), `:93-94` (`ExternalApiConnection`), `:110-111` (`ExternalApiOverride`), `:136-137` (`ProfileEndpoint`), `:150` (`AppSetting.updatedAt`), `:164-165` (`FileCache`), `:183-184` (`User`), `:194` (`UserProfileAssignment`)
- DDL đã sinh: `drizzle/0000_violet_franklin_storm.sql:11-12, 20, 45-46, 57-58, 69-70, 100, 104-106, 120-121, 128, 140-141` — literal `timestamp (3)`, không có `with time zone`
- Snapshot: `drizzle/meta/0000_snapshot.json` + `0001_snapshot.json` — `"type": "timestamp (3)"`

Kiểm chứng phủ định: truy vấn #5 ⇒ **0 hit** `withTimezone`/`timestamptz` trong `lib`, `app`, `drizzle`, `components`, `tests`, `docs`.

⇒ Bảng legacy **không có** cột nào giữ offset. Đây là tiền đề mà mục D của plan đã ghi (`PLAN-LEGACY-DB-ADAPTER-2026-10-09.md:464`) và LDBA-01 đã ghi lại (`coordination/reports/ldba-01-adapter-adr.md:88`: *"Legacy Drizzle timestamps have no timezone option"*).

### E2 — Ghi phía DB: `CURRENT_TIMESTAMP(3)` ⇒ **phụ thuộc session TimeZone**

- `lib/db/schema.ts:40,63,93,110,136,164,165,183,194`: `.default(sql`CURRENT_TIMESTAMP(3)`)`
- `drizzle/0000_violet_franklin_storm.sql:11,45,57,69,104,120,128,140`: `DEFAULT CURRENT_TIMESTAMP(3)`
- `drizzle_migration_plan.md:141,161,186,200,219,241,257,265`: bản nháp cũ dùng `.default(sql`now()`)` — cùng ngữ nghĩa

PostgreSQL render `CURRENT_TIMESTAMP`/`now()` **theo `TimeZone` của session** rồi mới cast về `timestamp` naive. ⇒ Giá trị lưu = **wall time của zone mà session đang dùng**.

### E3 — Ghi phía app: driver serialize JS `Date` thành **UTC ISO**

- `node_modules/postgres/src/types.js:28-33`, cụ thể `:31` `serialize: x => (x instanceof Date ? x : new Date(x)).toISOString()` và `:32` `parse: x => new Date(x)`
- Phiên bản đã cài: `node_modules/postgres/package.json:3` `"version": "3.4.9"`; khai báo `package.json:45` `"postgres": "^3.4.9"`
- `lib/db/index.ts:8-9` — pool config **chỉ** có `max`; **không** `options`, **không** `connection: { TimeZone }`
- `$onUpdate(() => new Date())` trên mọi `updatedAt`: `lib/db/schema.ts:41, 64, 94, 111, 137, 150, 184, 195`

⇒ Mọi giá trị do app ghi (`updatedAt`, và bất kỳ `new Date()` nào truyền vào insert/update) rời driver dưới dạng `YYYY-MM-DDTHH:MM:SS.mmmZ`.

**Lưu ý (chưa đo trong lượt này):** ngữ nghĩa khi chuỗi có `Z` được nạp vào cột `timestamp without time zone` là **hành vi tài liệu PostgreSQL**, không đo được offline. Hai khả năng — (i) offset bị **bỏ qua** ⇒ lưu UTC wall time; (ii) offset được **áp** vào session zone ⇒ lưu session wall time — dẫn tới hai kết luận khác nhau. Đây là **câu hỏi con phải chốt cùng lúc với A1**, xem §6.

### E4 — Mọi so sánh cửa sổ thời gian của legacy đều nạp instant UTC

- `app/api/internal/analytics/route.ts:38, 50, 70, 86, 101`: `WHERE "createdAt" >= ${startDate.toISOString()}::timestamp` (nhánh `24h`/`7d`/`30d` dựng ở `:22-25`; bucket `DATE_TRUNC('hour'|'day', "createdAt")` ở `:32,44`; trả `new Date(t.time_bucket).toISOString()` ở `:112`)
- `app/api/internal/recover-stalled/route.ts:33, 74`: `new Date(Date.now() - STALL_THRESHOLD_MS)`
- `lib/cleanup.ts:41, 130`; `app/api/settings/cache/route.ts:42, 88`; `app/api/v1/billing/usage/route.ts:34`

⇒ Hợp đồng ngầm của code legacy: **cột naive = UTC wall time**. Không có chỗ nào trong legacy so sánh bằng giờ local.

### E5 — Không có ghim timezone ở bất kỳ config deploy nào

- `docker-compose.yml:37-49` service `db`: `postgres:16-alpine` (`:38`), env **chỉ** `POSTGRES_USER/PASSWORD/DB` (`:41-44`), volume `pgdata` (`:46`). **Không `TZ`, không `PGTZ`, không `command:`, không `POSTGRES_INITDB_ARGS`.**
- `docker-compose.yml:7-26` (app) và `:74-95` (worker, `command: ["node","worker.js"]` ở `:79`, env ở `:80-81`): **không `TZ`**.
- `Dockerfile`: **0 hit** `TZ`/`tzdata`/`localtime`/`apk add tzdata`.
- `docker-entrypoint.sh`: chỉ có nhánh `BASELINE`/`MIGRATION`/`DB_PUSH`/`SEED` rồi `exec node server.js` — **không** bước timezone.
- `.env.example:2`: `DATABASE_URL=postgresql://user:password@localhost:5432/dugate` — **không** `?options=`.
- Không có `PGTZ`, `SET TIME ZONE`, `setTimeZone`, `process.env.TZ` ở đâu trong repo (truy vấn #2/#3/#4 ⇒ 0 hit).
- Không connection string nào trong repo ghim `options=-c timezone=...` (các test rework chỉ dùng `options=-csearch_path=public`, ví dụ `du-rework/tests/isolation/concurrent-interference.test.ts:247`).

### E6 — Topology deploy được tài liệu hoá: cả hai phía là container stock, không cấu hình zone

- `docs/SOLUTION_ARCHITECTURE.md:496, 530`: app/worker = `vietbn/AISkillHub:4.0.0` (Cmd `node server.js` / `npx tsx worker.ts`), db = `postgres:16-alpine` — bảng "Service Configuration" **không** có dòng ENV nào về TZ.
- `:543-567` "Kubernetes — Production Topology": `postgres:16` StatefulSet `PVC: 50Gi`, redis `redis:7` — cũng **không** TZ.
- `:226`: db là *"Nguồn sự thật duy nhất"*.

⇒ Theo tài liệu này, cả Node process lẫn PG session đều lấy zone **mặc định của image**. `postgres:16-alpine`/`postgres:16` chính thức không set `TZ` và Alpine không có `/etc/localtime` mặc định ⇒ mặc định là **UTC**. **Đây là hành vi tài liệu của image, KHÔNG đo trong lượt này** (không mở container). Vì cả hai phía cùng mặc định, hệ thống **tự nhất quán** dưới **bất kỳ** zone chung nào — nên tính nhất quán **một mình không chọn được** UTC.

### E7 — Lập luận nhất quán: vì sao nhánh B là defect thật nhưng im lặng

Chuỗi đọc/ghi của legacy:

1. Ghi default: `CURRENT_TIMESTAMP(3)` → wall time của session.
2. Ghi app: driver → `toISOString()` (`Z`) → cột naive.
3. Đọc: `types.date.parse = x => new Date(x)` (`node_modules/postgres/src/types.js:32`). Với giá trị naive `2026-08-21 10:00:00.000` (dạng có dấu cách), V8 parse theo **zone của Node process**.
4. Phát ra wire: `lib/pipelines/format.ts:29-30` đặt **`Date` thô** (`create_time: op.createdAt`, `update_time: op.updatedAt`) vào response; `JSON.stringify` biến nó thành `toISOString()` (UTC `Z`).
5. Hiển thị: `app/operations/[id]/page.tsx:430,437` và `components/ConversionHistory.tsx:271` — `new Date(metadata.create_time).toLocaleString('vi-VN')`.

Vì (3) parse theo zone Node và (4) phát lại UTC, hai phép biến đổi **triệt tiêu nhau khi và chỉ khi zone của Node process == zone của PG session**. Khi đó UI luôn hiển thị đúng giờ local — **bất kể** zone chung là UTC hay +07.

⇒ Hệ quả: **UI hiển thị đúng KHÔNG chứng minh DB là UTC.** Nó chỉ chứng minh hai phía cùng zone.

Còn nếu **hai phía lệch zone** (ví dụ app chạy ngoài container trên host +07 còn PG trong container UTC):
- `createdAt` (DB default, wall time session) và `updatedAt` (JS, UTC) **lệch nhau đúng offset** ngay trên cùng một hàng vừa tạo;
- mọi cửa sổ (`24h`/`7d`/`30d` của analytics, `recover-stalled`, TTL cleanup, expiry FileCache) **lệch offset, im lặng, exit 0**.

Đây đúng là mức rủi ro mà plan mục D mô tả (`PLAN-LEGACY-DB-ADAPTER-2026-10-09.md:462-465`) và `ldba-09A-fixture-unblock.md:50` + receipt DSH xác nhận *fixture UTC tường minh không đóng A1*.

### E8 — Host dev hiện tại là +07:00 (đường cài "Postgres cục bộ")

- `README.md:64`: *"Setup your Postgres Database locally, then run:"* — đây là đường cài **thứ hai** được tài liệu hoá, **không** dùng container cho DB.
- Nhiều receipt ghi `Asia/Bangkok`/`Asia/Saigon, UTC+7` (ví dụ `du-rework/coordination/reports/verify2-f2-oc-2026-10-08.md:3`, `f1-cursor-scope-fix-2026-10-08.md:3`), và `du-rework/tests/browser/tests/a11y-summary.ts:119` ghi *"Real wall-clock timestamp (Asia/Ho_Chi_Minh = +07)"*.
- **Không** file nào trong repo pin `TZ` cho app/DB (E5).

⇒ Nếu DB legacy thực tế được tạo bởi đường "Postgres cục bộ" trên máy Windows này, session TimeZone mặc định = zone OS = **+07:00** ⇒ nhánh B. Nếu được tạo bởi compose/K8s (E6) ⇒ nhánh A. **Repo không có bằng chứng nào cho biết đường nào đã dùng.**

### E9 — Tài liệu legacy tự khai wire là UTC

- `docs/API_PROFILES_SPEC.md:71, 89`: mẫu response chung `"create_time": "2026-08-21T10:00:00.000Z"` (cả `202 Accepted` lẫn `200 OK`).

Đây là bằng chứng **ý định** (tài liệu do đội legacy viết), khớp E4 — **không phải** bằng chứng về giá trị đã lưu.

### E10 — Governance đã biết A1 mở

- `coordination/PLAN-OPEN-2026-10-09.md:60` (LDBA-A1: *"Timezone legacy vẫn chưa chứng minh"*), `:269` (guard chỉ chặn, không chứng minh), `:275-282` (§9.2: packet read-only, nếu không tìm ra ⇒ hỏi user).
- `coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md:330, 462-465`.
- `coordination/reports/ldba-01-adapter-adr.md:88`.

---

## 3. Vì sao bằng chứng repo **không** đủ

Ba lỗ hổng riêng biệt, cả ba đều phải bịt mới chốt được A1:

1. **Session TimeZone của DB legacy production không được pin ở đâu trong repo.** E5 chứng minh *không ai cấu hình*; nó **không** chứng minh *giá trị đang chạy*. Mặc định image là suy luận từ hành vi tài liệu (E6), không đo.
2. **Không có artifact nào chứa giá trị legacy đã lưu.** Mọi fixture/golden trong repo đều là **synthetic do rework tự dựng**: `du-rework/orchestrator/services/orchestrator/tests/fixtures/legacy-envelope-golden.json:27,66,130,185,220,248` (`2026-10-02T03:00:00.000Z`), `tests/legacy-operations.test.ts:64`. Fixture UTC tường minh **không** đóng A1 — chính plan đã ghi.
3. **Ngữ nghĩa cast `'…Z'` → `timestamp without time zone` chưa đo** (E3). Nếu PostgreSQL **áp** offset thay vì bỏ qua, thì cả `createdAt` lẫn `updatedAt` đều là wall time session ⇒ hệ thống **thuần nhất** và câu trả lời là "zone của session", chứ không phải "UTC".

Nói cách khác: repo cho biết **code kỳ vọng gì** (UTC — E4/E9) và **ai không cấu hình gì** (E5), nhưng không cho biết **giá trị đang nằm trên đĩa**.

---

## 4. Phát hiện phụ: hai nguồn gốc timestamp trong CÙNG một bảng

| Cột | Ai ghi | Zone của giá trị |
|---|---|---|
| `createdAt` (`lib/db/schema.ts:40` và 8 chỗ tương ứng) | **DB**: `DEFAULT CURRENT_TIMESTAMP(3)` | wall time **session** |
| `updatedAt` (`lib/db/schema.ts:41` và 7 chỗ tương ứng) | **JS**: `$onUpdate(() => new Date())` | UTC ISO qua driver (hoặc session zone, tuỳ E3) |
| `AppSetting.updatedAt` (`lib/db/schema.ts:150`) | **JS** | như trên |
| `FileCache.lastAccessedAt` (`:165`) | **DB default** `CURRENT_TIMESTAMP(3)` | wall time session |

**Hệ quả cho A1 và cho runner:**

- Nếu session TZ **khác** UTC (nhánh B), thì ngay sau khi tạo một hàng, `updatedAt` sẽ **nhỏ hơn** `createdAt` đúng bằng offset — một mâu thuẫn nội tại quan sát được. Đây là **probe phân biệt rẻ nhất** nếu được phép chạm DB: `SELECT count(*) FROM "Operation" WHERE "updatedAt" < "createdAt";` (nhánh A ⇒ kỳ vọng 0; nhánh B ⇒ nhiều hàng).
- Runner `ldba-03-backfill.cjs` (`:197-204` `timestampUtc`, `:205` `TIMESTAMP_NOT_NAIVE`) **giả định một zone duy nhất cho mọi cột**. Nếu hai nguồn gốc khác zone, giả định đó sai **theo từng cột**, không theo từng hàng — và không có guard nào hiện tại phát hiện được.

---

## 5. Dead-end đã loại trừ (ghi để không ai đi lại)

PLAN-OPEN §9.2 gợi ý nguồn *"giá trị `CURRENT_TIMESTAMP` đã lưu kèm app setting"*. Đã kiểm:

- `lib/db/schema.ts:147-152` — bảng `AppSetting` **chỉ có** `id`, `key` (UNIQUE), `value` (text), `updatedAt`. **Không** cột timezone/clock nào.
- `lib/db/seed.ts` — chỉ seed `externalApiConnections`, `profileEndpoints`, `apiKeys`, `users`. **Không** seed hàng `AppSetting` nào.
- `AppSetting` chỉ được dùng cho workflow schema (`wb_schema:*`, xem `ldba-01-adapter-adr.md:64`).

⇒ Nguồn này **không cho bằng chứng nào offline**. Cần một hàng `AppSetting` thật + một mốc đồng hồ đã biết mới dùng được — tức lại cần DB.

---

## 6. Kết luận + đề xuất đóng A1

**Trạng thái:** `A1-TZ-EVIDENCE` = **DONE (read-only, 0 sửa)** về mặt *điều tra*; **A1 = NOT PROVEN** về mặt *kết luận*. Đây là kết quả âm tính có chủ đích, không phải thất bại: nó chặn một backfill chạy trên giả định chưa kiểm chứng.

**Đề xuất (cần user uỷ quyền — đây là quyết định scope, không phải việc executor tự chọn):**

Cách rẻ nhất đóng A1 = **một cửa sổ read-only duy nhất** trên DB legacy, không ghi gì:

```sql
SHOW TimeZone;                                                   -- zone của session
SELECT now(), current_setting('TimeZone');                        -- chéo
SELECT max("createdAt"), max("updatedAt") FROM "Operation";       -- so với đồng hồ tường
SELECT count(*) FROM "Operation" WHERE "updatedAt" < "createdAt"; -- probe §4
SELECT '2026-01-01T00:00:00Z'::timestamp;                         -- chốt ngữ nghĩa cast của E3
```

Đọc kết quả:
- `TimeZone` = `UTC` **và** probe §4 = 0 **và** `::timestamp` bỏ qua `Z` ⇒ **nhánh A**; runner đúng; gỡ A1.
- `TimeZone` = `Asia/Bangkok`/`+07` ⇒ **nhánh B**; **mọi** instant lệch 7h; runner phải sửa (dịch `-07:00`) trước khi backfill thật, hoặc phải re-derive instant từ một mốc ngoài DB.
- Probe §4 > 0 nhưng `TimeZone` = UTC ⇒ **hai nguồn gốc lệch zone** ⇒ phải xử lý **theo từng cột**, không theo từng hàng.

**Cho tới khi có kết quả:** giữ nguyên hành vi fail-closed hiện tại — `LDBA_ALLOW_UNVERIFIED_TIMEZONE` **không** được đặt; runner trả `BLOCKED_TIMEZONE_UNVERIFIED`/`LEGACY_TIMEZONE_UNVERIFIED` (`scripts/ldba-03-backfill.cjs:41, 939-946, 1347-1348`). **Không** tick gate, **không** mở `MDB-POLICY-01..05` trên nền A1 chưa chốt (PLAN-OPEN §9.3 hạng 5 ghi rõ phụ thuộc này).

---

## 7. Ranh giới bằng chứng của receipt này

- **Read-only tuyệt đối:** 0 file source/test/migration bị sửa; 0 container; 0 DB/Redis/S3; 0 suite chạy. Chỉ ghi đúng file receipt này.
- **Không** `git add`/`commit`/`push`/`reset`.
- **Chưa** có verifier độc lập. Mọi `file:line` ở §2 đã đọc trực tiếp trên working tree tại 2026-10-10; **`node_modules/postgres` là dependency đã cài** (`3.4.9`), không phải source được version-control ⇒ nếu `npm install` đổi patch version, hành vi serialize cần đọc lại.
- Các claim **hành vi tài liệu, chưa đo**: mặc định UTC của `postgres:16-alpine` (E6) và ngữ nghĩa cast `'…Z'::timestamp` (E3). Đã đánh dấu tại chỗ, **không** trình bày như số đo.
- **Không** kết luận thay user về nhánh A/B — đó là quyết định scope theo PLAN-OPEN §9.2.

---

## RESUME POINT (cho lượt sau)

- **Task:** A1-TZ-EVIDENCE. **Trạng thái:** DONE (read-only) · **A1 vẫn NOT PROVEN** · 0 gate tick.
- **Đã chứng minh chắc chắn:** cột legacy là naive `timestamp (3)` không offset (E1); default `CURRENT_TIMESTAMP(3)` phụ thuộc session (E2); driver app serialize UTC ISO (E3); mọi cửa sổ legacy so sánh bằng UTC instant (E4); **không** config nào trong repo pin TZ/PGTZ/timezone, ở cả compose, K8s doc, Dockerfile, entrypoint, env (E5/E6).
- **Còn mở:** (1) session TimeZone thật của DB legacy; (2) ngữ nghĩa cast `'Z'::timestamp`; (3) hai nguồn gốc `createdAt`(DB) vs `updatedAt`(JS) có lệch zone không.
- **Bước tiếp theo (cần user):** uỷ quyền 1 cửa sổ read-only chạy 5 câu SQL ở §6. Không có nó thì A1 không đóng được từ repo.
- **Ledger:** `A1-TZ-EVIDENCE — 2026-10-10 — read-only, 0 sửa code/test — A1 NOT PROVEN, cần 1 cửa sổ DB read-only (§6)`.
