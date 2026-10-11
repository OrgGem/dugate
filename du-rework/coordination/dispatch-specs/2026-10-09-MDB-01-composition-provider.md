# Dispatch Spec: MDB-01 Composition Provider (nối LDBA03 context provider vào composition seam)

- Date: 2026-10-09
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Codex-1 (`term_ca784044-5910-4d55-9d41-36c1d90fcf24`)
- Repo scope: `du-rework` (không đụng legacy root, không đụng DB production/legacy)
- Canonical plan: `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (dòng 423, 432, 467, 471, 496-503)
- Status: DISPATCHED
- **Lease sequencing:** packet này và packet `2026-10-09-WT01-callback-secret-resolver.md` **cùng lease** `src/app/bootstrap/create-app.ts` + `src/main.ts`. Hai packet **không được chạy song song**. Thứ tự bắt buộc: **MDB-01 trước, WT-01 sau**. Một owner duy nhất giữ cả hai.

---

## 1. Context and Problem Statement

Plan `:432` (hàng MDB-01) verdict: **Đúng, nghiêm trọng hơn review nói**. Plan `:500`: MDB-01 là blocker cutover thật, **không owner**.

Đã verify trực tiếp trong source (không qua report):

- `orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs:122` phụ thuộc env `LDBA03_CONTEXT_MODULE`.
- Symbol `LDBA03_CONTEXT_MODULE` có **đúng 1 occurrence** trong toàn bộ repo — chính là env read tại `ldba-03-production-adapter.cjs:149` bên trong `loadContextProvider`.
- **Không có provider module nào tồn tại** trong repo.

Hệ quả: `loadContextProvider` không bao giờ nạp được provider thật ⇒ adapter chạy thiếu ngữ cảnh ⇒ cutover thật bị chặn.

Plan `:471` (mục E) đặt ràng buộc composition: khi `create-app.ts` được tách, LDBA-03 context provider **phải** được đăng ký tại **composition seam MỚI**, nếu không fix MDB-01 sẽ bị mất trong lần refactor.

## 2. Work Objectives for Codex-1

1. Đọc `ldba-03-production-adapter.cjs` (đặc biệt `loadContextProvider` và env read tại `:149`) để xác định chính xác hàm/shape mà provider phải cung cấp.
2. Đọc composition seam hiện tại (`src/app/bootstrap/create-app.ts`, `src/main.ts`) để xác định điểm nối đúng.
3. Viết provider module + nối vào composition seam.
4. Viết test offline chứng minh provider được nạp và adapter nhận đúng context.
5. Ghi receipt.

## 3. Lease Area (exact paths)

- `du-rework/orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs` (nếu cần điều chỉnh cách nạp provider)
- `du-rework/orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` (provider mới — hoặc vị trí tương đương theo quy ước `scripts/`)
- `du-rework/orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts` (composition seam)
- `du-rework/orchestrator/services/orchestrator/src/main.ts` (entrypoint)
- `du-rework/orchestrator/services/orchestrator/tests/` (test offline tương ứng)
- `du-rework/coordination/reports/mdb-01-composition-provider-2026-10-09.md` (receipt)

**Read-only** (không sửa): `ldba-03-backfill.cjs`, `ldba-09-harness.cjs`, `ldba-08-harness.cjs`, toàn bộ legacy root.

## 4. Dependencies

- **Phụ thuộc:** không có packet khác chặn. Nhưng **phải chạy TRƯỚC** packet WT-01 (cùng lease).
- **Không** được chạy song song với packet WT-01.
- **Không** được chạy backfill thật trên DB production/legacy. Rehearsal chỉ trên PG16 container `--network none`, tmpfs, không publish port, remove sau dùng.

## 5. Acceptance

- [ ] Provider module tồn tại và được nạp qua `LDBA03_CONTEXT_MODULE` (hoặc cơ chế nạp tương đương đã quyết).
- [ ] Composition seam (`create-app.ts` + `main.ts`) truyền context provider tới adapter.
- [ ] Test offline pass: provider nạp đúng, adapter nhận đúng context, thiếu provider fail-closed rõ ràng (không ngầm undefined).
- [ ] Ràng buộc `:471`: nếu `create-app.ts` tách, provider vẫn được đăng ký tại composition seam mới.
- [ ] Không có thay đổi ngoài lease. Không commit, không push, không git add.
- [ ] Receipt ghi rõ: provider export gì, composition seam nạm ở đâu, test pass với literal + exit code.

## 6. Receipt Path

`du-rework/coordination/reports/mdb-01-composition-provider-2026-10-09.md`

---

Tuan thu COORDINATOR-CONTRACT: khong git commit, khong push, khong git add, khong dung ky tu nhay kep trong prompt.
