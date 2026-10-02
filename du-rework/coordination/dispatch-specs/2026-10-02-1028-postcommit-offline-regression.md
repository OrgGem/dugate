# Post-commit offline regression baseline — contracts + worker-sdk + document-core

## Bối cảnh

Commit `6fb5294` (471 files) vừa land. Cần baseline offline của **cây committed** trước wave mới
(D5 registration, RV01 loopback, P9 workflow integration đang/chuẩn bị chạy song song).

## Mục tiêu

1. Chạy offline, **ghi nguyên lệnh + cwd + commit SHA**:
   - `pnpm --filter @du/contracts test` — so baseline: 2 red pre-existing `vault-policies.test.ts:104,179` (xác nhận còn đúng không).
   - `pnpm --filter @du/worker-sdk test` — baseline 645/645 exit 0.
   - `pnpm --filter @du/document-core test` — baseline gần nhất: 2 red do thiếu PG/Redis (isolated-infra) — xác nhận **không có red MỚI**.
2. Bảng suite → passed/failed/skipped + **exit code literal**; liệt kê mọi red mới so baseline; KHÔNG sửa gì.
3. Ghi rõ suite nào skip/red vì thiếu infra; **không claim live**.
4. Nếu suite treo >10 phút: dừng, ghi lý do, không retry mù.

## Ranh giới

- KHÔNG sửa source/test; không tick gate; không commit; không `npm install` thay đổi lockfile.
- Không chạy Docker/infra; không live.
- Receipt: `coordination/reports/tester-postcommit-offline-2026-10-02.md`. Không nhắm `nocobase-10`.

## Acceptance

- Bảng số liệu literal + so baseline từng package; kết luận đỏ/mới-đỏ/xanh; verdict rõ.
