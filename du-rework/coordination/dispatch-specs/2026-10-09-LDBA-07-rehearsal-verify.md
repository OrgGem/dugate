# DISPATCH — LDBA-07 — Verify độc lập trên DB rehearsal (fresh schema, synthetic data)

**Task ID:** `LDBA-07`
**Repo scope:** `D:/Git/dugate` — đọc `du-rework/orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs` + `src/modules/identity/legacy-user-adapter.ts` + `du-rework/orchestrator/services/connector/src/db/legacy-connector-adapter.ts` + `du-rework/orchestrator/services/orchestrator/src/modules/workflow-schemas/legacy-workflow-schema-backfill-adapter.ts` + `src/app/admin/bff/health.ts` + `src/db/migrations.ts` + `src/migrate-cli.ts`. **VIẾT:** harness rehearsal (script/test throwaway, không phải adapter production) + receipt `du-rework/coordination/reports/ldba-07-verify.md`.
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` — **đọc lại §5 (điều kiện bắt buộc getHealth), §9 Q1 (điều kiện mở real migration), bảng LDBA-07 (dòng 319).**
**Owner:** terminal `term_8bfe6adc-f0da-41a1-a4aa-fc835bcb1535` (đã đọc màn hình: **IDLE tại prompt**; vừa hoàn tất verify độc lập LDBA-06 R4; là **tester**, **không phải** implementer LDBA-00..06).
**Dependencies:** LDBA-02 ACCEPTED · LDBA-03 ACCEPTED (module) · LDBA-04 ACCEPTED (module) · LDBA-05 ACCEPTED-WITH-CONDITIONS (module) · LDBA-06 R4 ACCEPTED (module) — **tất cả đã đóng ở phạm vi module**.
**Mode:** verify độc lập trên **DB rehearsal dùng một lần** (disposable PG16, fresh schema, synthetic data). **KHÔNG** đọc DB production/legacy. **KHÔNG** chạy lên DB thật. **KHÔNG** sửa source production.
**Receipt path:** `du-rework/coordination/reports/ldba-07-verify.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet này

LDBA-00..06 đã đóng **ở phạm vi module** (offline, fake db, synthetic fixture). Chưa packet nào chạy các adapter trên **PostgreSQL thật** với **schema mới** và **dữ liệu synthetic**. Plan §5 đặt điều kiện bắt buộc cho LDBA-07: `getHealth()` phải trả `unknown` (không phải `ok`) khi bảng `tasks`/`outbox` chưa tồn tại — nếu không UI sẽ hiện xanh giả. Plan §9 Q1 đặt điều kiện mở real migration: LDBA-07 phải chứng minh rehearsal DB đạt **fresh schema + synthetic data, source/target đếm khớp, zero parse failure**.

⇒ LDBA-07 là packet **verify độc lập** duy nhất, chạy trên DB rehearsal dùng một lần, không đụng DB thật.

## 1. Phạm vi verify — chốt cụ thể

### 1.1. DB rehearsal (dùng một lần)

- Dựng **một container PG16 disposable** theo đúng tiền lệ `migration-0032-restore-rehearsal-2026-10-05.md` (container tên `du-ldba07-rehearsal`, `--network none`, tmpfs, **không publish port**, **remove** sau khi xong). Docker đã sẵn sàng (server 28.5.1).
- Trên container chạy **toàn bộ migration rework** (`001..0037`) để có **fresh schema** — dùng `src/migrate-cli.ts` / `npm run migrate` với `DATABASE_URL` trỏ container này. Đây là schema rework sạch, chưa có dữ liệu sống.
- **KHÔNG** kết nối DB production, DB legacy, DB shared `:5433`. Chỉ container disposable này.

### 1.2. Dữ liệu synthetic (tự dựng, không từ DB thật)

- Seed **dữ liệu legacy-shaped** vào các bảng legacy (PascalCase: `Operation`, `ApiKey`, `User`, `AppSetting`, `ExternalApiConnection`…) — dữ liệu **bạn tự dựng**, không đọc từ DB thật.
- Seed **timestamp dùng UTC tường minh** (ví dụ `2026-01-01T00:00:00Z`) để giả định timezone của runner được kiểm soát. Xem mục 1.4 về hệ quả A1.
- Mỗi bảng seed **ít nhất 2–3 hàng** để kiểm tra chọn lọc (ví dụ 2 `AppSetting` cùng slug khác `updatedAt` để test tiebreak; 2 `ExternalApiConnection` khác `authType`).

### 1.3. Chạy và đối chiếu — 4 adapter

| Adapter | Module đã ACCEPTED | Việc LDBA-07 làm trên DB rehearsal |
|---|---|---|
| **LDBA-03** backfill | `scripts/ldba-03-backfill.cjs` (runner) | Chạy runner với **adapter synthetic** (mục 1.5) trên schema fresh. Đối chiếu source/target counts. |
| **LDBA-04** identity | `src/modules/identity/legacy-user-adapter.ts` | Gọi `migrateLegacyLocalCredentialOnLogin` + `mapLegacyUserProfileAssignment` trên synthetic user; verify tenant resolve theo name, không cast text→uuid. |
| **LDBA-05** connector | `services/connector/src/db/legacy-connector-adapter.ts` | Gọi `projectLegacyExternalApiConnection` trên synthetic connection; verify id giữ TEXT, tenant unbound (`''`), `credential_source.kind === 'legacy-db'`. |
| **LDBA-06** workflow schema | `legacy-workflow-schema-backfill-adapter.ts` | Gọi `runWorkflowSchemaBackfill` trên synthetic `appSettings`; verify round-trip writer→reader, tenant by name, egress skip. |

### 1.4. A1 (timezone) — giới hạn trung thực

Runner LDBA-03 đang đọc timestamp naive là UTC cố định. **A1 (timezone runtime legacy thật) vẫn mở** và LDBA-07 **không thể** đóng nó vì không được đọc DB legacy thật. Trên rehearsal, dữ liệu synthetic dùng UTC tường minh nên giả định UTC của runner được kiểm soát và round-trip đúng. **Ghi rõ trong receipt:** đây là bằng chứng runner đúng với dữ liệu UTC, **không phải** đóng A1. A1 vẫn mở cho real backfill.

### 1.5. Adapter synthetic cho LDBA-03 — bắt buộc, không phải adapter production

Coordinator đã xác minh trên disk: **adapter source/sink production của LDBA-03 chưa tồn tại** (chỉ có runner `ldba-03-backfill.cjs` + test offline). Runner bắt buộc `LDBA03_ADAPTER_MODULE` trỏ một module adapter. ⇒ LDBA-07 **tự dựng một adapter synthetic** (test-only) để chạy runner trên DB rehearsal:

- Adapter synthetic đọc từ schema legacy (source) và ghi vào schema rework (sink) trên **cùng** container rehearsal.
- Adapter synthetic **chỉ** dùng cho rehearsal; **không** commit, **không** thay adapter production.
- Mục đích: chứng minh **runner + count-matching + zero parse failure** hoạt động trên PG thật, không phải chứng minh adapter production (nó chưa có).

### 1.6. getHealth fail-closed — điều kiện bắt buộc (plan §5)

- Trên rehearsal, trước khi seed bảng `tasks`/`outbox`, gọi `getHealth()` (qua route hoặc trực tiếp) và assert trả `status === 'unknown'` (không phải `'ok'`), vì `health.ts:83-84` fail-closed khi `db === null || redis === null`.
- Đây là **điều kiện chặn**: nếu `getHealth()` trả `ok` khi `tasks`/`outbox` chưa có → rehearsal **FAIL**, báo cáo ngay.

## 2. Tiêu chí nghiệm thu — đã chốt cụ thể

- [ ] DB rehearsal disposable PG16 dựng được, fresh schema từ migration `001..0037`, **không** publish port, remove sau.
- [ ] Seed synthetic legacy-shaped data (tự dựng, không từ DB thật), timestamp UTC tường minh.
- [ ] **getHealth() trả `unknown`** khi `tasks`/`outbox` chưa tồn tại (fail-closed) — bằng chứng bằng route hoặc gọi trực tiếp.
- [ ] LDBA-03 runner chạy `--preflight` → `PREFLIGHT_READY`; `--execute` → `APPLIED`; **source/target counts khớp**; **zero parse failure**.
- [ ] LDBA-04: tenant resolve theo name, không cast text→uuid; `user_profile_assignments` không bịa cột tenant.
- [ ] LDBA-05: id giữ TEXT; tenant unbound (`''`); `credential_source.kind === 'legacy-db'`; `authSecret` không lộ vào `config`.
- [ ] LDBA-06: round-trip writer→reader trên DB thật; tenant by name; egress động/non-HTTPS skip + báo cáo; idempotent (chạy 2 lần không sinh revision 2).
- [ ] Idempotency: mỗi adapter chạy 2 lần, lần 2 skip, không sinh trùng.
- [ ] **A1 ghi rõ là vẫn mở** (rehearsal UTC không đóng A1).
- [ ] Receipt ghi: mỗi adapter số source/target, số skip + lý do, mọi open item.
- [ ] File receipt **không** ký tự nháy kép, **không** trailing whitespace.

## 3. Ranh giới (bắt buộc)

- **KHÔNG** đọc DB production/legacy/shared `:5433`. Chỉ container disposable.
- **KHÔNG** chạy migration lên DB thật. Chỉ container rehearsal.
- **KHÔNG** sửa source production (adapter, migration, contract, catalog, crypto). Chỉ đọc + gọi.
- **KHÔNG** commit, `git add`, push, không tick gate.
- **KHÔNG** để container rehearsal sau khi xong (remove).
- **KHÔNG** dùng dữ liệu thật làm fixture.

## 4. Khi nào **phải dừng**

Dừng và ghi `Open items for coordinator` nếu:
- Không dựng được container PG16 disposable (Docker lỗi, port xung đột).
- Migration `001..0037` chạy lên rehearsal lỗi (schema conflict).
- `getHealth()` trả `ok` khi `tasks`/`outbox` chưa có (fail-closed hỏng).
- Bất kỳ adapter ném parse failure không giải thích được.
- Bất kỳ yêu cầu nào ở §3.

**Dừng đúng cách là hành vi được chấp nhận.**

## 5. Dispatch proof

- **Request ID:** `LDBA-07-2026-10-09`
- **Owner:** `term_8bfe6adc-f0da-41a1-a4aa-fc835bcb1535` — đã đọc màn hình, **IDLE tại prompt**, tester (không phải implementer).
- **Dependency evidence:** LDBA-02..06 đều ACCEPTED ở phạm vi module; plan §5 (getHealth fail-closed), §9 Q1 (điều kiện mở real migration), bảng LDBA-07 dòng 319.
- **Acceptance:** fresh schema + synthetic data + source/target đếm khớp + zero parse failure + getHealth fail-closed + idempotent.
