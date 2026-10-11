# Dispatch Spec: WT-01 Callback Secret Resolver (bắt webhook auth fail-closed thay vì raise lặp vô hạn)

- Date: 2026-10-09
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Codex-1 (`term_ca784044-5910-4d55-9d41-36c1d90fcf24`)
- Repo scope: `du-rework` (không đụng legacy root, không đụng DB production/legacy)
- Canonical plan: `du-rework/coordination/MASTER_PLAN.md` (dòng 47, 50, 53) + `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` (dòng 471)
- Status: DISPATCHED
- **Lease sequencing:** packet này và packet `2026-10-09-MDB-01-composition-provider.md` **cùng lease** `src/app/bootstrap/create-app.ts` + `src/main.ts`. Hai packet **không được chạy song song**. Thứ tự bắt buộc: **MDB-01 trước, WT-01 sau**. Một owner duy nhất giữ cả hai.
- **Lý do cắt lại:** packet cũ `2026-10-07-WT01-WT02-wave1.md` đang Status `ACTIVE / WORKING` nhưng assign WT-01 cho `term_7cb640ae-5ffe-4675-9f7b-0c99c1070268` — handle này **không còn trong live roster** ⇒ packet cũ stranded, cần packet mới với owner thật.

---

## 1. Context and Problem Statement

`MASTER_PLAN.md:47` và `:50`: WT-01 là **1 HIGH** trong 9 SPECIFIED · 0 IMPLEMENTED. `:53`: 3 WT packet skeleton đang chờ owner thật.

Đã verify trực tiếp trong source (không qua report):

- `src/server.ts:300-304` khai báo `resolveCallbackSecret?` / `callbackOAuth2Options?`.
- `src/app/bootstrap/create-app.ts:1046-1048` forward 2 optionals vào sweep.
- **Không có assignment nào tồn tại ngoài tests** ⇒ sweep luôn nhận `undefined`.
- Hệ quả: `modules/webhooks/webhooks.ts:653-656` raise `WEBHOOK_AUTH_UNAVAILABLE`.

Hai nhánh giải quyết (owner chọn, ghi rõ trong receipt):

- **(a)** Build resolver thật tại composition từ SC-02 Vault resolver — cần SC-01 backend, đã descope ⇒ cần scope decision.
- **(b)** Surface degradation với error code terminal, non-retry, tách bạch khỏi `WEBHOOK_AUTH_UNAVAILABLE` transient.

## 2. Work Objectives for Codex-1

1. Chọn nhánh (a) hoặc (b), ghi rõ lý do vào receipt.
2. Nếu (a): build resolver tại composition, nối vào `create-app.ts` + `main.ts`, đảm bảo không mất khi `create-app.ts` tách (ràng buộc `:471`).
3. Nếu (b): thêm error code terminal non-retry tách khỏi transient, đảm bảo sweep fail-closed thay vì raise lặp.
4. Viết test offline chứng minh hành vi đã chọn.
5. Ghi receipt.

## 3. Lease Area (exact paths)

- `du-rework/orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts` (composition seam)
- `du-rework/orchestrator/services/orchestrator/src/main.ts` (entrypoint)
- `du-rework/orchestrator/services/orchestrator/src/server.ts` (nếu cần điều chỉnh khai báo optionals)
- `du-rework/orchestrator/services/orchestrator/modules/webhooks/webhooks.ts` (nếu nhánh (b))
- `du-rework/orchestrator/services/orchestrator/tests/` (test offline tương ứng)
- `du-rework/coordination/reports/wt-01-callback-secret-resolver-2026-10-09.md` (receipt)

**Read-only** (không sửa): `ldba-03-*.cjs`, `ldba-09-harness.cjs`, `ldba-08-harness.cjs`, toàn bộ legacy root.

## 4. Dependencies

- **Phụ thuộc:** **phải chạy SAU** packet MDB-01 (cùng lease).
- **Không** được chạy song song với packet MDB-01.
- **Không** được chạy backfill thật trên DB production/legacy. Rehearsal chỉ trên PG16 container `--network none`, tmpfs, không publish port, remove sau dùng.

## 5. Acceptance

- [ ] Nhánh (a) hoặc (b) đã chọn, ghi rõ lý do.
- [ ] Nếu (a): resolver thật tồn tại tại composition, forward vào sweep, không undefined.
- [ ] Nếu (b): error code terminal non-retry tách khỏi `WEBHOOK_AUTH_UNAVAILABLE`, sweep fail-closed.
- [ ] Test offline pass với literal + exit code.
- [ ] Ràng buộc `:471`: nếu `create-app.ts` tách, fix WT-01 không bị mất.
- [ ] Không có thay đổi ngoài lease. Không commit, không push, không git add.
- [ ] Receipt ghi rõ: nhánh đã chọn, lý do, file nào đổi, test pass với literal + exit code.

## 6. Receipt Path

`du-rework/coordination/reports/wt-01-callback-secret-resolver-2026-10-09.md`

---

Tuan thu COORDINATOR-CONTRACT: khong git commit, khong push, khong git add, khong dung ky tu nhay kep trong prompt.
