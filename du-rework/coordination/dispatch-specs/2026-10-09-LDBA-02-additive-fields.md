# DISPATCH — LDBA-02 — Xác nhận KHÔNG cần DDL additive + tài liệu hoá

**Task ID:** `LDBA-02`
**Repo scope:** `D:/Git/dugate` — **CHỈ** đọc `services/orchestrator/migrations/**`, `services/connector/src/db/migrations/**`, `services/orchestrator/src/**`, `apps/admin-web/src/**`, `lib/db/schema.ts` (root) + **GHI** duy nhất `du-rework/coordination/reports/ldba-02-additive-fields.md`
**Canonical plan:** `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (§6, §6.1, §6.2, §6.3, §3.4, §9.2)
**Owner:** `codex_worker_4` — terminal `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` (đã đọc màn hình: **IDLE tại prompt**, vừa xong LDBA-01-C1)
**Dependencies:** LDBA-01 ACCEPTED (ADR `reports/ldba-01-adapter-adr.md`, verdict L1..L7) + LDBA-00 VERIFIED
**Mode:** đọc + ghi receipt. **KHÔNG** viết file migration. **KHÔNG** chạy DB/build/test. **KHÔNG** commit/stage/push.
**Receipt path:** `du-rework/coordination/reports/ldba-02-additive-fields.md`

> Không dùng ký tự nháy kép trong prompt hay trong phần ghi file.

---

## 0. Vì sao có packet này

Plan §6 ban đầu đề xuất 8 cột cần thêm vào DB rework. ADR LDBA-01 đặt gate: *"consumer inventory phải quyết định từng field đề xuất"*. Coordinator đã quét field-level (§8.1.2) và thấy **0/8 cột có consumer**. Packet này để owner **độc lập xác minh** kết quả đó và ghi receipt — không tin coordinator mà không kiểm.

## 1. Việc cần làm

### 1.1. Quét lại consumer cho từng cột (độc lập, không tin số của coordinator)

Với **mỗi** cột trong bảng §6.1 của plan, quét `services/orchestrator/src/**` + `apps/admin-web/src/**` + `services/connector/src/**` để tìm:
- Cột rework tương ứng (nếu có) — tìm trong `migrations/0001..0037`
- Mọi đọc/ghi field đó trong code rework
- Cơ chế thay thế (nếu có) — ví dụ `artifacts`, `deleted_at`, `state` enum

**Bắt buộc:** ghi ra receipt từng lệnh grep + số hit + file:line tương ứng. Không ghi "0 hit" nếu không chạy lệnh.

### 1.2. Xác minh 3 cơ chế thay thế

Đọc code để xác minh 3 claim:
1. `operations.deleted_at` thay `filesDeleted` — tìm trong `legacy-host-adapter.ts` hoặc tương đương
2. `operations.state` enum thay `done` — tìm trong `0001_platform_v1.sql`
3. `artifacts.storage_key` thay `filesJson` — tìm trong `0001_platform_v1.sql` + `0003`

### 1.3. Ghi receipt

Receipt `reports/ldba-02-additive-fields.md` phải chứa:
- Bảng quét từng cột (tên cột legacy, cột rework tương ứng, số hit consumer, file:line, cơ chế thay thế, verdict)
- Xác minh 3 cơ chế thay thế (file:line + mô tả ngắn)
- Kết luận: **KHÔNG cần DDL additive** (nếu quét xác nhận 0 consumer)
- Hai hệ quả hành vi (per-user scoping, key-level admin) — trích §6.2 của plan
- Danh sách cột `0024` đã thêm (trích §6.3 của plan) — để reviewer biết phần đã có sẵn

## 2. Ranh giới (bắt buộc)

- **KHÔNG** viết file migration. Packet này chỉ đọc + ghi receipt.
- **KHÔNG** sửa source, test, migration, plan, docs khác.
- **KHÔNG** chạy DB, build, test.
- **KHÔNG** commit, `git add`, push, không tick gate.
- Nếu phát hiện cột nào **có** consumer (trái với kết quả của coordinator), **KHÔNG** tự thêm vào plan — ghi vào receipt dưới dạng `Open items for coordinator` và báo lại.

## 3. Acceptance criteria

- [ ] Quét lại đủ 8 cột §6.1, mỗi cột có lệnh grep + số hit + file:line trong receipt
- [ ] 3 cơ chế thay thế được xác minh bằng file:line
- [ ] Kết luận rõ ràng: KHÔNG cần DDL additive (hoặc liệt kê cột nào cần)
- [ ] Hai hệ quả hành vi được trích từ §6.2
- [ ] Danh sách cột `0024` được trích từ §6.3
- [ ] File vẫn không có ký tự nháy kép, không có trailing whitespace
- [ ] Báo lại kết quả: số cột quét, số cột có consumer, có/không có `Open items` mới

## 4. Dispatch proof

- **Request ID:** `LDBA-02-2026-10-09`
- **Owner:** `codex_worker_4` / `term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6` — đã đọc màn hình trước khi chọn, **IDLE tại prompt** (vừa xong LDBA-01-C1, 3m 57s)
- **Dependency evidence:** LDBA-01 ACCEPTED (ADR 94 dòng, L1..L7 + 6 transform + A1/A2) + LDBA-00 VERIFIED (9 bảng mapping) + plan §6.1/§6.2/§6.3 đã ghi danh sách 8 cột + 3 cơ chế thay thế
- **Acceptance:** quét độc lập 8 cột + xác minh 3 cơ chế + receipt đầy đủ
