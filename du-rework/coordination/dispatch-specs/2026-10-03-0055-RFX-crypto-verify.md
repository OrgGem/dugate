# RFX-CRYPTO-VERIFY — Xác minh độc lập thay đổi RFX-08/16 trong tree (READ-ONLY)

Bối cảnh: lane qwen_1 thực hiện RFX-08/16 (bound `collectStream` + design note) nhưng **chưa ghi receipt** (stream error lặp); thay đổi đã nằm trong working tree: `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` (+77/−2). Nhiệm vụ này là **verify độc lập** và viết receipt thay cho receipt thiếu.

**File lease:** READ-ONLY; CHỈ ghi `du-rework/coordination/reports/tester-rfx-crypto-verify-2026-10-03.md`.

## Việc

1. Xác nhận diff trong tree đúng phạm vi RFX-08 (bound plaintext collect khi decrypt, fail-closed 413/503, ngưỡng nhất quán `MAX_DECRYPT_BYTES` 64 MiB) + RFX-16 (comment design-rationale tại `decryptChunkGenerator` ~:795-810, không đổi thứ tự unwrap).
2. Chạy focused suites liên quan crypto facade + guard byte-identity (`crypto-seam.test.ts -t "byte-identical"` trong worker-sdk — kỳ vọng XANH sau RFX08-PARITY) + `tsc --noEmit` orchestrator — **lưu ý: `server.ts` có thể đang có lỗi TS tạm thời của lane khác (CRX-02 in-flight); nếu gặp, ghi rõ và dùng cách loại trừ hợp lệ, đừng sửa**.
3. Ghi literal command/cwd/exit; nêu rõ phần không chứng minh được (live/Vault); kết luận PASS/BLOCKED.

## Ranh giới

- Không sửa file; không tick gate; không commit; không nhắm `nocobase-10`.
