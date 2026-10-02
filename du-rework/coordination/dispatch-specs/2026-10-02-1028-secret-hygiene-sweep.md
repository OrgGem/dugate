# Secret-hygiene sweep (READ-ONLY) — sau sự cố GitHub secret scanning chặn push

## Bối cảnh

Commit `6fb5294` chứa **2 Vault token thật** (`hvs.CAES…`) hardcode tại
`services/orchestrator/tests/rv0104-live-encryption.test.ts:39-40` → GitHub chặn push; lane claude đang sửa
(env vars + amend). Cần sweep độc lập để xác nhận không còn credential hardcode nào khác trong cây du-rework.

## Mục tiêu

1. Quét cây `du-rework/` (loại trừ `node_modules/`, `.git/`, `dist/`, `coverage/`, file log/tmp) tìm mẫu credential hardcode:
   `hvs.`, `sk-`, `AKIA`, `ghp_`, `xox[baprs]-`, PEM blocks (`BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY`),
   và các gán literal dạng `password|secret|token|apiKey` trong source/test/config/fixture.
2. Với mỗi hit: **file:line + loại + phân loại** (`real-looking` vs `placeholder/mock` — ví dụ `hvs.mock-…`, `hvs.encrypt-token`).
   **TUYỆT ĐỐI KHÔNG chép giá trị secret vào report** — chỉ mô tả loại/độ dài/redaction.
3. Xác nhận trạng thái fix của case `rv0104-live-encryption.test.ts` (đã chuyển env `RV0104_VAULT_ENC_TOKEN/DEC_TOKEN`? đã amend? token còn trong git index/HEAD?).
4. Khuyến nghị ngắn (1-2 dòng) cho CI/scan định kỳ — không triển khai.

## Ranh giới

- READ-ONLY: không sửa gì, không tick gate, không commit, không chạy infra.
- Report mới: `coordination/reports/tester-secret-sweep-2026-10-02.md` — **đã redact**, không raw match values.
- Không nhắm `nocobase-10`; không quét space nocobase (ngoài scope).

## Acceptance

- Bảng hit đầy đủ (file:line, loại, real vs placeholder) + kết luận: còn secret thật nào không, ở đâu.
- Ghi rõ giới hạn: pattern-based, không thay thế GitHub secret scanning.
