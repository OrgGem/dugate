# PERF-01B — ingress `Buffer.concat(chunks, total)` micro-change + chunked-body benchmark

## Bối cảnh

OPT-PERF-01 (receipt `coordination/reports/codex-opt-perf-01-request-path-2026-10-02.md`, §4 Proposal B) đề xuất micro-diff trên `services/orchestrator/src/http/ingress.ts`: truyền `total` (số byte bounded đã tính ở event `end`) vào `Buffer.concat` để bỏ lượt cộng độ dài thừa. Coordinator (command-code) **grant lease** + dispatch 2026-10-02 10:3x. Kiểm tra 10:30: `ingress.ts` sạch (không lane nào giữ), không va chạm server.ts.

## Mục tiêu

1. Áp dụng đúng micro-diff `Buffer.concat(chunks, total)` tại seam đọc body bounded trong `ingress.ts`. **Không đổi hành vi**: cùng bytes, cùng cap/fail-closed, cùng wire.
2. Benchmark offline (new-file-only, prefix `opt-perf-`): đo chi phí concat path theo các hình dạng chunk phổ biến (ví dụ 1×64KiB vs 64×1KiB vs mixed; lặp vài lần lấy median). File mới, ví dụ `du-rework/services/orchestrator/opt-perf-01b-ingress-concat-bench.cjs`.
3. Xác nhận: chạy `tests/ingress-bounded.test.ts` **thủ công** (suite này nằm deny-list FUNCTEST-B — ghi rõ trạng thái deny-list trong receipt) + các suite ingress khác không bị deny-list nếu tồn tại; `tsc --noEmit` orchestrator exit 0.

## Ranh giới (tuyệt đối)

- Chỉ sửa `services/orchestrator/src/http/ingress.ts` (+ test file **chỉ nếu thật cần** và giải thích rõ; ưu tiên không đổi test).
- KHÔNG chạm `server.ts`, `modules/**`, contracts, manifest, gates, tasks/README, AGENTS.md.
- KHÔNG commit; KHÔNG tick gate.
- Không mở rộng sang allocation-path lớn hơn (length-hint single-buffer, fallback design) — ngoài scope.
- Giữ nguyên mọi cap/failure semantics (bounded byte count, 413, destroy/abort, timeout).
- Không tái hiện lỗi bảo mật legacy; không plaintext fallback.

## Acceptance

- Diff thực tế + lập luận an toàn cho edge cases (0 chunk, 1 chunk, đúng sát cap).
- Benchmark: bảng median nhiều lần chạy + kết luận trung thực có/không gain (không overclaim).
- Test/tsc outputs thật kèm exit codes.
- Receipt: `coordination/reports/codex-opt-perf-01b-ingress-concat-2026-10-02.md`. Không tick gate, không commit.

## Dependency

Không chặn. OPT-PERF-01 đã SETTLED; PERF-02 (benchmark crypto) đã SETTLED — không đổi runtime geometry. Đây là bước "start with the tiny diff" trong §5 implementation order của OPT-PERF-01.

## COMMON

- Lease độc quyền: `services/orchestrator/src/http/ingress.ts` — cấp cho lane F8 (codex worker1, `term_2b05b203`); lane khác không giữ file này.
- DH: nếu diff làm đỏ test ngoài phạm vi hoặc lộ semantics bất ngờ → STOP, báo blocker, không vá lan.
- DEV TEST ISOLATION nếu cần chạy gì chạm DB/Redis (dự kiến không cần).
