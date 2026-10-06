# Dispatch spec — W2 (Phase A): fixture + baseline cho producer/consumer verification — 2026-10-04 18:05 +07

- **Owner:** codex_tester_offline — `term_2ea0ce2e-1612-449f-b772-b177fe15df31`
- **Run:** `run_069ecd6957cd` (command-code coordinator `term_58db0267`)
- **Trạng thái của bạn:** `READY / AWAITING_DISPATCH` (receipt `coordination/reports/tester.md`, 17:53). Packet này mở khóa Phase A; Phase B mở khi W1 báo checkpoint.

## Phase A — làm ngay, song song W1 (topology §4 dòng W2: "Chuẩn bị fixture song song")

1. **Fixture/harness độc lập** cho ma trận PLAN04-01/02 (nguồn: `tasks/PLAN-COMPLETION-2026-10-04.md` §2-3):
   - snapshot non-secret + ref `(tenantId, profileId, profileRevision)`;
   - sentinel-bag (token/header/query) để quét rò rỉ ở operation snapshot/outbox/claim/queue/logs;
   - priority map (hướng F-PP1 đã đóng: `{LOW:20, MEDIUM:10, HIGH:1}`);
   - prompt precedence (Code > Profile > Connector default; `_default` fallback);
   - step mapping / connection binding; extension cases (upload / sourceUrl / file_urls / Test Endpoint).
   - Harness phải mô tả được cách **observe request của mock provider** (theo PLAN04-02 acceptance) — chưa cần chạy.
2. **Baseline focused:** các suite được đặt tên cho W2 (`tests/profile-policy.test.ts`, `tests/prompt-override.test.ts` — nếu đường dẫn khác, tìm và ghi chú đường dẫn thật) + ghi trạng thái pre-W1. Kết quả baseline **không** là verdict coverage.
3. **Không chạm** 5 file test-stub thuộc lease W1: `artifact-submit-guards`, `public-upload-encryption-gateway`, `url-ingestion-offline.functional`, `url-ingestion-backend-failclosed-offline`, `runtime`. Không sửa source.

## Phase B — chờ tín hiệu

Khi coordinator chuyển tiếp "W1 CHECKPOINT (a)/(b)": chạy focused theo slice implemented; VFY-ENC/COMP/REG trên build ổn định; verdict + receipt đầy đủ. Sửa test-stub fallout (nếu phát hiện) **không được giảm security/contract assertion**.

## Deliverable

- Receipt Phase A vào `coordination/reports/tester.md`: danh sách fixture/harness + baseline evidence (literal Exit Code) + câu hỏi (nếu có).

## Constraints

- Offline-only; không mở DB/Redis/S3/Vault; không commit/push/reset; SKIP ≠ PASS; Δ-DEVIATION flag.
