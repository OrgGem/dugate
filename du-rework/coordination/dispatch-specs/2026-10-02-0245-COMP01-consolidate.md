# COMP01-CONSOLIDATE — đối chiếu 8 receipts với acceptance COMP-01 (read-only, KHÔNG tick)

## Mục tiêu

Đọc toàn bộ receipts COMP-01 (slices A/B/C/D/E/F/G/H) + đối chiếu với acceptance
của `COMP-01` trong plan, cho ra bảng coverage: acceptance nào đã đủ, còn gap nào.
KHÔNG tự tick COMP-01, KHÔNG code.

## Được phép đọc (read-only tuyệt đối)

- `tasks/API-COMPAT-DUGATE-2026-09-28.md` dòng `COMP-01` + `COMP-01a/b/c`
  (acceptance: matrix từng route + 31 core variants, 3 workflows + schema,
  status/header/body/error/binary/webhook; MISMATCH ledger).
- 8 receipts slice-A→H trong `coordination/reports/` (H dùng bản hiện có —
  row8 đang second-pass citations).
- `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` nếu cần cross-ref workflow phần.

## Cấm

- KHÔNG tick/đổi trạng thái COMP-01/a/b/c (quyền reviewer/user).
- KHÔNG tự bổ sung characterization bằng cách đọc sâu source (chỉ tổng hợp từ receipts;
  gap thì ghi "cần slice bổ sung", không tự làm).
- KHÔNG sửa bất kỳ file nào ngoài receipt của chính mình; không đụng `tasks/*.md`,
  `AGENTS.md`, execution overlay, lockfile, `server.ts`, `contracts/src`.
- KHÔNG tick gate, KHÔNG commit, KHÔNG nhắn `nocobase-10`.
- KHÔNG copy/tái hiện lỗi bảo mật legacy (chỉ trích factual đã có trong receipts).

## Acceptance

Receipt → `coordination/reports/` (`qwen-comp01-consolidate-2026-10-02.md`):

1. Bảng acceptance COMP-01 × (receipt nào cover / mức đầy đủ / gap còn lại).
2. Ma trận 31 variants: đếm từ các receipts xem đã đủ 31 dòng map discriminator chưa,
   thiếu variant nào.
3. MISMATCH ledger gộp (kế thừa M1..M8 các slice + G-01..G-10 + MM-ledger F),
   deduplicate, đánh số thống nhất để COMP-00 dùng.
4. List gap cần slice bổ sung (nếu có) — mô tả, không tự làm.

## COMMON

Task tổng hợp read-only (không sửa file, không chạy infra) → không cần COMP-00,
không va chạm lease (COMP-02..09 implementation vẫn bị cấm tuyệt đối khi chưa có
COMP-00). Exclusive lease không áp dụng. Không tái hiện lỗi bảo mật legacy
(x-api-key-id tự khai, ADMIN fallback, list-no-resolve, plaintext fallback,
fake CANCELLED). Không tick gate. Không commit thay đổi lane khác. Không nhắm
nocobase-10. Không sửa AGENTS.md, tasks/README.md, execution overlay.
Evidence là đầu vào quyết định, không phải blocker.
