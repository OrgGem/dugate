# Dispatch Spec: LDBA-A1 Timezone Guard (chặn backfill thật cho tới khi chứng minh timezone legacy)

- Date: 2026-10-09
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Codex-4 (`term_d93ff3b1-d562-4302-94dc-5fccbe59b8b6`)
- Repo scope: `du-rework` (không đụng legacy root, không đụng DB production/legacy)
- Canonical plan: `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (dòng 329-330, 428-448, 497-503)
- Status: DISPATCHED

---

## 1. Context and Problem Statement

Plan `:330` ghi rõ: **timezone legacy chưa chứng minh** — runner đang giả định UTC cố định, A1 phải xác nhận trước backfill thật.

Đã verify trực tiếp trong source (không qua report):

- `orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs:197-204` — hàm `timestampUtc` chỉ nhận timestamp **naive** (không offset, không `Z`). Regex tại `:201` là
  `^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$`
  Bất kỳ offset hay suffix `Z` nào ⇒ `TIMESTAMP_NOT_NAIVE` ⇒ fail toàn bộ backfill.
- Nếu legacy ghi naive, runner sẽ **hiểu nó là UTC cố định** ⇒ lặng lẽ dịch chuyển instant của mọi row.

Hai nhánh đều là risk thật. Fixture explicit-UTC **không** đóng A1 vì nó không chứng minh legacy DB thật gì.

Plan `:499` nói coordinator **không** tạo packet LDBA mới ở đây — packet này được cắt theo đúng receipt §7 item 4 (sau khi sổ tay ổn định), không phải packet mới ngoài plan.

## 2. Work Objectives for Codex-4

1. Xác định từ **source legacy** (không đọc DB) timestamp legacy được sinh và lưu thế nào: naive local, naive UTC, hay có offset. Đọc drizzle schema + writer path ở legacy root.
2. Đối chiếu với hành vi `timestampUtc` ở `ldba-03-backfill.cjs:197-204` và với cách runner diễn giải giá trị naive.
3. Thêm **fail-closed guard** trong runner: chặn backfill thật tới khi timezone legacy được chứng minh, thay vì ngầm giả định UTC.
4. Viết test offline (không cần DB thật) cho cả hai nhánh: naive-UTC được chấp nhận, offset/Z bị từ chối, guard chặn khi chưa chứng minh.
5. Ghi receipt: kết luận timezone legacy + guard đã đặt + test pass.

## 3. Lease Area (exact paths)

- `du-rework/orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs` (thêm guard)
- `du-rework/orchestrator/services/orchestrator/tests/ldba-03-backfill-offline.test.cjs` (hoặc test file offline hiện có)
- `du-rework/coordination/reports/ldba-a1-timezone-guard-2026-10-09.md` (receipt)

**Read-only** (không sửa): `ldba-03-production-adapter.cjs`, `ldba-09-harness.cjs`, `ldba-08-harness.cjs`, toàn bộ legacy root.

## 4. Dependencies

- Không phụ thuộc packet khác. Có thể chạy song song với packet composition (MDB-01 / WT-01) vì lease không giao nhau.
- **Không** được chạy backfill thật trên DB production/legacy. Rehearsal chỉ trên PG16 container `--network none`, tmpfs, không publish port, remove sau dùng.

## 5. Acceptance

- [ ] Có kết luận rõ ràng về timezone legacy, trích dẫn file:line trong source legacy (không phải report).
- [ ] Guard fail-closed đã có trong `ldba-03-backfill.cjs` và bật theo mặc định.
- [ ] Test offline pass cho: naive-UTC chấp nhận, offset/Z từ chối, guard chặn khi chưa chứng minh.
- [ ] Không có thay đổi ngoài lease. Không commit, không push, không git add.
- [ ] Receipt ghi rõ guard có thể được tắt bằng cờ nào (và cờ đó **không** được bật trong môi trường thật).

## 6. Receipt Path

`du-rework/coordination/reports/ldba-a1-timezone-guard-2026-10-09.md`

---

Tuan thu COORDINATOR-CONTRACT: khong git commit, khong push, khong git add, khong dung ky tu nhay kep trong prompt.
