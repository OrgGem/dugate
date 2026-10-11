# Verify độc lập (DSH) — AWEB-14 workflow business ownership + profile selection — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), read-only lease trên migration 0040, `profile-workflow-bindings`, workflow catalog router/repo, `tests/aweb-14-workflow-business-offline.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd: `orchestrator/services/orchestrator` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-14-2026-10-10/DSH/` (`aweb14-jest.log`, `tsc.log`, `SHA256SUMS.txt`).
**Receipt gốc:** `coordination/reports/receipt-aweb-14-workflow-business-2026-10-10.md` — **tồn tại**.

## 1. Bằng chứng chạy

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb-14-workflow-business-offline.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 7 passed, 7 total`** · không block lỗi |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output · `tsc_error_lines=0` |

Test file 238 dòng; nguồn liên quan `src/modules/admin-read/profile-workflows.ts` 131 dòng; migration `migrations/0040_workflow_business_profile_bindings.sql` 20 dòng.

**Ghi nhận cập nhật trạng thái cây:** ở lượt verify AWEB-20a UI trước đó, `tsc` của **admin-web** đỏ 7 lỗi `TS6133/TS6192` tại `profiles-screen.tsx`; lượt này `tsc` của **orchestrator** (project khác) xanh 0 lỗi — hai project độc lập, không mâu thuẫn. Tôi **không** kiểm lại admin-web trong lượt này.

## 2. Migration 0040 — additive và `business_id` nullable (đọc trực tiếp)

Nguyên văn các dòng cốt lõi:

```
4: ALTER TABLE legacy_workflow_schemas
5: ADD COLUMN IF NOT EXISTS business_id text NULL;
6: ALTER TABLE legacy_workflow_schemas
7: ADD COLUMN IF NOT EXISTS business_version text NULL;
9: CREATE INDEX IF NOT EXISTS legacy_workflow_schemas_business_lookup
10: ON legacy_workflow_schemas (tenant_id, business_id, business_version, slug, revision DESC);
12: CREATE TABLE IF NOT EXISTS profile_workflow_bindings (
13:   profile_id        uuid NOT NULL,
14:   workflow_slug     text NOT NULL CHECK (workflow_slug ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
15:   workflow_revision integer NOT NULL CHECK (workflow_revision > 0),
16:   enabled           boolean NOT NULL DEFAULT true,
17:   config            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
18:   created_at        timestamptz NOT NULL DEFAULT now(),
```

| Bound theo packet | Kết quả |
|---|---|
| `business_id` **nullable** | **ĐẠT** — `:5` `business_id text NULL` (và `business_version text NULL` ở `:7`) ⇒ hàng cũ không cần backfill giá trị |
| Migration **additive** | **ĐẠT** — toàn bộ là `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (`:4-7`), `CREATE INDEX IF NOT EXISTS` (`:9-10`), `CREATE TABLE IF NOT EXISTS` (`:12`); **không** có `DROP`/`NOT NULL` áp lên cột cũ |
| Bảng binding mới có ràng buộc | **ĐẠT** — `profile_workflow_bindings` với CHECK hợp lệ cho `workflow_slug`, `workflow_revision > 0`, `config` là JSON object |

## 3. Logic lọc theo tenant/business/version (đối chiếu test)

- `tests/aweb-14-workflow-business-offline.test.ts:46` — ca *ships an additive migration with nullable legacy ownership and profile bindings*; `:50` assert migration chứa **đúng** chuỗi `ADD COLUMN IF NOT EXISTS business_id text NULL` ⇒ chốt tính nullable ở tầng test, không chỉ ở tài liệu.
- `:56` — *filters the workflow catalog by tenant, business, and version in SQL*; `:76-77` assert SQL có `tenant_id = $1 AND business_id = $2 AND business_version = $3` và tham số đúng thứ tự `[tenantId, businessId, businessVersion]` ⇒ **ownership theo business được áp trong truy vấn**, không lọc ở tầng ứng dụng.
- `:87` — *lists only owned workflow revisions and keeps a selected retired revision visible*; `:108-111` assert cả hai truy vấn (nhánh `n.` và nhánh `w.`) đều mang `tenant_id=$1 AND business_id=$2 AND business_version=$3`, tham số gồm `profile-1` ⇒ **profile selection** giữ revision đã retired nếu nó đang được chọn (không làm biến mất lựa chọn hiện tại của operator).
- Describe `:45` `AWEB-14 workflow ownership and profile selection` — phạm vi đúng packet.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| Suite AWEB-14 | **PASS** — 7/7, exit 0 |
| Typecheck orchestrator | **PASS** — exit 0, 0 lỗi |
| `business_id` nullable | **ĐẠT** — migration `:5` (và `:7`), test assert `:50` |
| Migration additive | **ĐẠT** — chỉ ADD COLUMN/INDEX/TABLE `IF NOT EXISTS`, không DROP |
| Lọc ownership theo tenant/business/version | **ĐẠT** — SQL trong test `:76-77`, `:108-111` |
| Profile selection giữ revision retired đang chọn | **ĐẠT** — ca `:87` |

⇒ **AWEB-14: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Offline, không PostgreSQL thật:** test đọc **nội dung file migration** và dùng DB giả để bắt SQL; việc migration 0040 chạy thật (khoá bảng, thời gian, `IF NOT EXISTS` khi đã có cột) và việc truy vấn trả đúng hàng trên dữ liệu thật **chưa** được chứng minh — cần gate live/rehearsal.
2. **Chưa kiểm `profile-workflow-bindings` ở tầng ghi:** tôi đọc migration + test lọc; phần router/repo ghi binding (`admin-read/profile-workflows.ts` 131 dòng và các route BFF liên quan) tôi **chưa** đọc hết, nên không kết luận về đường ghi.
3. **Chưa đối chiếu nội dung receipt gốc** `receipt-aweb-14-workflow-business-2026-10-10.md` (chỉ xác nhận tồn tại).
4. **Chưa chạy suite admin-web** trong lượt này (không thuộc lease) ⇒ tình trạng typecheck admin-web sau sự cố `profiles-screen.tsx` ở lượt trước **không** được cập nhật ở đây.
5. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (2 file).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
