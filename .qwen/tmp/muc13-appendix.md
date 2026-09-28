
#### Phụ lục — lệnh tái hiện ( Verify / lane sau chạy lại được )
- cwd du-rework/services/orchestrator.
- Baseline TRƯỚC sửa, 4 suite liên quan: `pnpm run test:unit -- admin-operations-sort-http-offline admin-operations-list-pagination operations-list-contract-conformance admin-keyset-explain` -> Tests: 144 passed, 13 skipped / Exit Code: 0.
- Cùng lệnh SAU sửa (x3): Tests: 14 failed, 130 passed, 13 skipped / Exit Code: 1 (log giu tai .qwen/tmp/targeted-x2.log, targeted-x3.log).
- Typecheck: `pnpm --filter @du/orchestrator typecheck` (tu root du-rework) hoac `npx tsc --noEmit -p tsconfig.json` (tu cwd orchestrator) -> Exit Code: 0 ca hai.
- Byte-identity 0019: `node D:/Git/dugate/.qwen/tmp/w-ingest-0019-2-check.js` -> ALL CHECKS PASS / Exit Code: 0. Logic: lap lai expression COALESCE tu chinh map sentinel trong src, dem so lan xuat hien trong 0019 (ky vong 2 cho moi direction), va kiem bindOperationsListSortKey khong con push param. Scratch co the bi don khi tmp xoa — thu tuc van nguyen o tren.
- Collateral full offline: `pnpm run test:unit` -> Test Suites: 4 failed, 1 skipped, 70 passed, 74 of 75; Tests: 15 failed, 28 skipped, 1774 passed, 1817 total / Exit Code: 1 (log: .qwen/tmp/orch-unit-after.log).

#### Quyết định phạm vi (operator, 2026-09-27)
- CHOT: write scope van la `services/orchestrator/src/server.ts` dung packet. Lane KHONG sua file test cua lane khac trong checkout dung chung.
- Δ29 (14 test Admin) + Δ31 (connector VAULT-06 pre-existing) de coordinator dieu phoi lane Admin/Tester — khong phai bang chung fix sai, la packet thieu pham vi.
- Δ30 (docs/06:74, docs/20:39, 0019 header, neo dong 2547->2556/2594/2668) van mo; lane khong cham docs cung khong cham migration (Δ24).
- Lane khong commit, khong push, khong mo window DB/Redis/S3.
