# CORRECTION — LDBA-01-C1 — Sửa trích dẫn sai trong ADR

**Task ID:** `LDBA-01-C1` (correction của `LDBA-01`, cùng owner, cùng lease)
**Repo scope:** `D:/Git/dugate` — **CHỈ** đọc file migration + sửa duy nhất `du-rework/coordination/reports/ldba-01-adapter-adr.md`
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (§8, §8.1, §9)
**Owner:** `codex_worker_4` — terminal `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` (đã đọc màn hình: **IDLE tại prompt**, ADR §5 đã viết xong)
**Dependencies:** `LDBA-01` receipt `reports/ldba-01-adapter-adr.md` (20860 bytes) — **giữ nguyên toàn bộ nội dung ngoài 3 dòng bên dưới**
**Mode:** sửa giới hạn trong chính receipt của bạn. KHÔNG đụng source/test/migration/plan/docs khác.
**Receipt path:** sửa tại chỗ `du-rework/coordination/reports/ldba-01-adapter-adr.md`

> Không dùng ký tự nháy kép kép trong prompt hay trong phần sửa file.

---

## 0. Vì sao có correction này

Coordinator đã spot-check toàn bộ trích dẫn của ADR (cùng kỷ luật đã dùng cho LDBA-00). Kết quả:

**Đã verify ĐÚNG (giữ nguyên, không sửa):**
- `0026_profile_policy.sql:54-60` (`allowed_file_extensions` là CSV text) — đúng
- `0007_webhook_deliveries.sql:7` (`operations.callback_url` đã tồn tại) — đúng
- `0001_platform_v1.sql:16,24,36,38,58,70,94,102,114,127` — đúng
- `0024:39` (`pipeline_json jsonb`), `0024:61` (`total_cost_usd numeric(20,6)`) — đúng
- `0037_legacy_workflow_schema_catalog.sql` — đúng nguyên văn
- `0027_profile_active_pointer.sql:32-41` — đúng nguyên văn
- `src/modules/workflow-schemas/workflow-schemas.ts:70-75,202-210,287-295` — đúng
- `lib/db/schema.ts:11,20,23,27-28,33,34,54,60-61,73,86-87,104,123,127-131,130-131,134-137,146-150,157,175,177,179-182,191` — **đúng toàn bộ 22 vị trí**
- `PLAN-LEGACY-DB-ADAPTER-2026-10-09.md:76,148,254-255,260-263` — đúng

**Đã verify SAI (phải sửa): `0023_admin_local_users.sql:1-20`**

ADR khẳng định file này chứa policy `Deliberately NOT backfilled`. Đo thật:

```
$ wc -l du-rework/orchestrator/services/orchestrator/migrations/0023_admin_local_users.sql
23
$ grep -n -i "backfill" du-rework/orchestrator/services/orchestrator/migrations/0023_admin_local_users.sql
No matches found
```

File dài **23 dòng**, chứa **0** lần xuất hiện `backfill`. Nội dung thật của nó là: bảng `admin_local_users`, CHECK `username_normalized = lower(...)`, CHECK regex `^[a-z0-9][a-z0-9._-]{0,63}$`, CHECK password scrypt `^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$`, UNIQUE `(tenant_id, username_normalized)`, index `(tenant_id, created_at DESC, id DESC)`. **Không có dòng nào nói về backfill.**

Header `Deliberately NOT backfilled` thật nằm ở **hai file khác**:

- `migrations/0024_legacy_parity_columns.sql:24-30`
- `migrations/0026_profile_policy.sql:172-180`

Cả hai đều là **comment** (tiền tố `--`), nằm trong block giải thích chứ không phải constraint SQL.

---

## 1. Việc cần sửa — đúng 3 chỗ

### Chỗ 1 — bảng §3, dòng mismatch `§4.3 password`

Tìm dòng bảng có nội dung gần đúng với: `Do not copy bcrypt text into the target` … `The migration also says this table is deliberately not backfilled, so LDBA-04 must reconcile that policy explicitly before any population. Sources: 0023_admin_local_users.sql:1-20`

**Sửa thành:**

> Không copy bcrypt dạng text vào đích. Đích là `admin_local_users.password_hash text NOT NULL` với CHECK định dạng scrypt (`0023_admin_local_users.sql:12-14`). **Lưu ý framing:** policy không-backfill **không** nằm trong `0023` — nó là giả định **cấp deploy** được viết ở `0024_legacy_parity_columns.sql:24-30` và `0026_profile_policy.sql:172-180`, cả hai đều trích `docs/14-reference-compatibility.md` rằng rework là dự án mới hoàn toàn, không migrate dữ liệu/credential nào. LDBA-04 phải **đảo ngược giả định cấp deploy đó** trước khi ghi bất kỳ dòng identity nào — không phải hòa giải một policy riêng của bảng (policy riêng của bảng không tồn tại).

### Chỗ 2 — bảng §4, dòng gate `LDBA-04 — identity adapter`

Tìm dòng có nội dung gần đúng với: `Reconcile the explicit Deliberately NOT backfilled policy in 0023_admin_local_users.sql:1-20 with the proposed identity import before writing rows.`

**Sửa thành:**

> Đảo ngược giả định cấp deploy `fresh project, no data/credential migration` (nguồn: `0024_legacy_parity_columns.sql:24-30` + `0026_profile_policy.sql:172-180`, cùng trích `docs/14-reference-compatibility.md`) **trước khi** ghi bất kỳ dòng `admin_local_users` nào. Lưu ý `0023_admin_local_users.sql` **không** chứa policy backfill nào — file đó chỉ nêu schema và CHECK. Gate này chặn vì plan LDBA đảo ngược đúng cái premise mà hai comment trên dùng để biện minh cho việc không backfill, chứ không phải vì có một policy riêng của bảng cần hòa giải.

### Chỗ 3 — thêm một ghi chú trung thực vào §5

Thêm vào cuối §5 (`Execution boundary and status`), giữ nguyên mọi câu đang có:

> **Correction LDBA-01-C1 (2026-10-09, coordinator spot-check):** hai chỗ trong bản đầu của ADR trích `0023_admin_local_users.sql:1-20` cho policy `Deliberately NOT backfilled`. Trích dẫn đó sai — `0023` dài 23 dòng và có 0 lần xuất hiện `backfill`. Nguồn thật là `0024_legacy_parity_columns.sql:24-30` và `0026_profile_policy.sql:172-180`. **Kết luận không đổi** (LDBA-04 vẫn phải hoà giải trước khi import identity) nhưng framing đã sửa: đó là giả định cấp deploy về việc không migrate gì, không phải policy riêng của bảng `admin_local_users`. 20 trích dẫn còn lại của ADR đã được coordinator đọc lại và khớp thực tế.

---

## 2. Ranh giới (bắt buộc)

- Sửa **duy nhất** `du-rework/coordination/reports/ldba-01-adapter-adr.md`.
- KHÔNG sửa source, test, migration, plan, docs khác.
- KHÔNG chạy DB, build, test.
- KHÔNG commit, `git add`, push, không tick gate.
- **KHÔNG** viết lại ADR từ đầu, **KHÔNG** đổi verdict L1..L7, **KHÔNG** đổi quyết định A1/A2, **KHÔNG** đổi bất kỳ transform §4.1..§4.6 nào. Đây là sửa trích dẫn, không phải sửa quyết định.
- Nếu bạn thấy chỗ nào khác trong ADR cũng sai, **KHÔNG tự sửa** — ghi vào cuối §5 dưới dạng `Open items for coordinator` và báo lại.

---

## 3. Acceptance criteria

- [ ] `grep -c '0023_admin_local_users.sql:1-20'` trong ADR = **0**
- [ ] Cả 2 chỗ sửa có trích `0024_legacy_parity_columns.sql:24-30` và `0026_profile_policy.sql:172-180`
- [ ] Cả 2 chỗ nói rõ đây là **giả định cấp deploy** (trích `docs/14-reference-compatibility.md`), **không phải** policy riêng của bảng
- [ ] Ghi chú LDBA-01-C1 có trong §5
- [ ] Verdict L1..L7, transform §4.1..§4.6, quyết định A1/A2 **không đổi một ký tự**
- [ ] File vẫn không có ký tự nháy kép kép, không có trailing whitespace
- [ ] Báo lại kết quả: số dòng trước/sau, xác nhận 3 chỗ đã sửa, và có/không có `Open items` mới

## 4. Dispatch proof

- **Request ID:** `LDBA-01-C1-2026-10-09`
- **Owner:** `codex_worker_4` / `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` — đã đọc màn hình trước khi chọn, **IDLE tại prompt** (ADR §5 đã viết xong lúc 2:51 AM)
- **Dependency evidence:** LDBA-01 receipt tồn tại, 20860 bytes; coordinator đã verify 22/22 dòng `lib/db/schema.ts`, 9/9 dòng migration, 5/5 dòng plan, 3/3 vùng `workflow-schemas.ts` — **chỉ 1 trích dẫn sai**, đã khoanh vùng chính xác
- **Acceptance:** 3 chỗ sửa + giữ nguyên mọi quyết định đã chốt