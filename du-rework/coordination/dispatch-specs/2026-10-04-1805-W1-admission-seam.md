# Dispatch spec — W1: hoàn tất admission seam (T-SUB-01..03) + test-stub fallout — 2026-10-04 18:05 +07

- **Owner:** qwen_1 — `term_7cb640ae-5ffe-4675-9f7b-0c99c1070268`
- **Run:** `run_069ecd6957cd` (command-code coordinator `term_58db0267`)
- **Bối cảnh:** Claude (lane implement trước) đã DỪNG giữa Phase 2 theo Chỉ thị 17:18; user phê duyệt redistribution W1/W2/W3 (17:58). Bạn đã tự audit readiness lúc ~17:53 (baseline: 4 suite pass / 43 test exit 0; `runtime.test.ts` skip 40 do gate `DU_LIVE_INFRA` — không tính là pass). Packet này là nhiệm vụ chính thức.

## Trả lời câu hỏi của bạn (audit 17:53)

1. **Cơ chế lease:** giữ nguyên hiện hành — single worktree + **file-lease serialize** (topology §4). Bạn là lane duy nhất được ghi trong W1 hot-set dưới đây.
2. **T-SUB-04:** ĐÚNG — tách sang **W1b** (lease riêng, sau DTO freeze). W1 **không** claim T-SUB-04. Khi DTO freeze đạt, báo coordinator (checkpoint (a)) để mở W2/W1b.
3. **F-PP1:** giữ nguyên hướng đã đóng (closure VERIFIED 15:33) — `{LOW:20, MEDIUM:10, HIGH:1}`; T-SUB-03 enqueue theo contract frozen, không tự áp weight mới.
4. **5 test-stub:** audit trước, chỉ sửa phần còn dở; nếu đã xanh thì chốt bằng bằng chứng; **không được giảm security/contract assertion**.

## Lease (write-set)

- `services/orchestrator/src/modules/operations/submission.ts`
- `services/orchestrator/src/modules/profiles/**` (profiles, policy, publish, file-url-auth, prompt-overrides)
- `services/orchestrator/src/modules/queue/dispatcher.ts`
- `services/orchestrator/src/modules/runtime/runtime.ts`
- `packages/contracts/src/profile-policy.ts`, `runtime.ts`, `index.ts`
- `services/orchestrator/migrations/0026_profile_policy.sql`, `0027_profile_active_pointer.sql` (chỉ khi bắt buộc — không sửa lịch sử đã áp)
- 5 file test-stub: `tests/artifact-submit-guards.test.ts`, `tests/public-upload-encryption-gateway.test.ts`, `tests/url-ingestion-offline.functional.test.ts`, `tests/url-ingestion-backend-failclosed-offline.test.ts`, `tests/runtime.test.ts` (+ nếu audit phát hiện file thứ 6 thì báo coordinator)
- **Receipt:** `coordination/reports/qwen1.md` (mở bằng RESUME POINT, section đánh số tăng dần)

## Ngoài lease — không chạm

`src/server.ts`, `modules/admin-actions/**`, api-key/crypto/vault paths, `docs/21-openapi.json` (nếu cần sửa OpenAPI → báo coordinator, không tự sửa). Nếu buộc phải chạm file ngoài lease → **dừng + Δ-DEVIATION**, chờ coordinator phân xử.

## Việc cần làm (4 hạng mục — theo chỉ đạo user)

1. **Audit in-flight (ghi vào receipt TRƯỚC khi sửa):** đối chiếu phần Claude đã làm vs phần dở. Mốc tham chiếu: `submission.ts` (~218-439), `dispatcher.ts:55`, `runtime.ts`, `contracts/runtime.ts:52-87`, `migrations/0026`. Chốt danh sách: đã xong / còn thiếu / nghi vấn.
2. **Hoàn tất admission seam trong `submission.ts`:** operations insert + outbox payload dùng resolver/snapshot mới (bước Claude làm dở: "repoint the operations insert and outbox payload at the new resolver"). Snapshot non-secret + ref bất biến `(tenantId, profileId, profileRevision)` tới credential mã hóa của revision đã pin. **KHÔNG raw credential** (token/header/query/`fileUrlAuthConfig`) trong snapshot/outbox/claim/queue payload.
3. **Validate effective input:** DTO snapshot chuyên biệt, **runtime-validate** trước khi ghi (không serialize nguyên `EffectiveProfilePolicy`). Giữ DB format `iv:tag:ciphertext`; không chuyển Profile key sang Vault.
4. **Test-stub fallout (5 file):** hoàn tất phần dở nếu có; giữ nguyên mức assertion; ghi rõ trạng thái từng file.

## Verify + acceptance

- Focused: jest các suite liên quan + `tsc --noEmit` scoped (literal Exit Code; lane rule: 3 lần liên tiếp exit 0 cho [PASS]; SKIP ≠ PASS).
- Báo coordinator **W1 CHECKPOINT (a)** ngay khi DTO freeze đạt (để mở W2/W1b) và **(b)** khi hoàn tất toàn bộ (kèm receipt path + tóm tắt).
- Sau khi bạn hoàn tất: coordinator gọi **W2 verify độc lập (Codex Tester)** + **Claude review-only** trước khi tick bất kỳ acceptance nào.
- Không commit/push/reset; offline-only (không mở DB/Redis/S3/Vault).

## Lane rules (đang áp dụng)

Receipt lossless + RESUME POINT; literal Exit Code; Δ-DEVIATION flag; không tự tick gate.
