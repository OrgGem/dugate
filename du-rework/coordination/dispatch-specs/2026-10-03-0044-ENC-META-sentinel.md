# ENC-META-SENTINEL — Hiện thực test plan offline từ ENC-META-SCAN (TEST-ONLY)

Nguồn: `coordination/reports/cc-enc-meta-writer-scan-2026-10-03.md` §2 (test plan) — chính lane này đã soạn.

**File lease:** các file test mới trong `services/orchestrator/tests/` (+ helpers test nếu cần). **KHÔNG sửa source production** (kể cả khi test fail — fail = finding, ghi receipt).

## Việc

1. Hiện thực các test offline **khả thi nhất** từ §2 (ưu tiên: `sourceUrl` trong outbox payload, `tasks.result_ref`/`operations.result_ref`, `human_waits.*`) qua `createApp` + fake PG + fake crypto seam + sentinel-leak helper (sentinel không được xuất hiện ở bất kỳ giá trị persist nào đã seal, kể cả base64).
2. Chạy; **nếu test lộ plaintext thật → đó là kết quả đúng**: ghi finding rõ (writer nào, đường nào) trong receipt, KHÔNG tự sửa source.
3. Nêu rõ test nào chưa hiện thực được offline (cần quyết định slot/live) + lý do.

## Acceptance

- Tests mới chạy được, có literal command/cwd/exit + kết quả từng case; `tsc --noEmit` nếu chạm test TS.
- Receipt: `du-rework/coordination/reports/cc-enc-meta-sentinel-2026-10-03.md`.

## Ranh giới

- Không tick gate; không commit; không nhắm `nocobase-10`; không sửa source.
