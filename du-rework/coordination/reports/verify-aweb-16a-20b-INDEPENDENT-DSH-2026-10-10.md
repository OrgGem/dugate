# Verify độc lập (DSH) — AWEB-16a + AWEB-20b — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), lease READ-ONLY trên `apps/admin-web/src/features/overview/overview-screen.tsx` và `apps/admin-web/src/features/operations/operations-screen.tsx`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/build; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-16a-20b-2026-10-10/DSH/` (`aweb16a-jest.log`, `aweb20b-harness.log`, `aweb16a-vite-build.log`, `SHA256SUMS.txt`).

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb-16a-overview-tenant-operations.test.ts` — cwd `orchestrator/services/orchestrator` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 3 passed, 3 total` · không block lỗi |
| 2 | `node tests/operations-timeline-filters-offline.cjs` — cwd `orchestrator/services/orchestrator` | **0** | in các dòng `ok  OPS-1/OPS-2/OPS-4 …` (ví dụ: `OPS-2: a 1s tick interval exists while a non-terminal op is shown`; `OPS-2: unknown start renders Unknown, never a fabricated 0`; `OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor`; `OPS-4: toolbar renders an id search input`) |
| 3 | `node node_modules/vite/bin/vite.js build` — cwd `orchestrator/apps/admin-web` | **0** | `✓ built in 9.32s` (không lỗi biên dịch) |

Kích thước artifact kiểm: `aweb-16a-overview-tenant-operations.test.ts` 137 dòng · `operations-timeline-filters-offline.cjs` 399 dòng.

## 2. Pass/Fail rõ ràng

- **AWEB-16a**: suite jest **PASS 3/3**, exit 0.
- **AWEB-20b**: harness timeline/filters **PASS**, exit 0 (harness tự quyết pass/fail bằng exit code; các dòng `ok` bao phủ tick 1s, `Unknown` thay vì số 0 bịa, link tải artifact có/không `downloadUrl`, không mở interval khi mọi op đã terminal, toolbar có ô tìm id + ô ngày from/to).
- **AWEB-18-style build gate**: `vite build` **PASS**, exit 0.
- **Không có FAIL** trong 3 lệnh.

## 3. Ranh giới `client.ts` — OUT-OF-LEASE (ghi nhận rõ)

- `orchestrator/apps/admin-web/src/lib/api/client.ts` đang **` M`**, mtime `2026-10-10 19:16`, 555 dòng — **ngoài lease** của AWEB-16a/20b.
- ⇒ Tôi **không** kiểm chứng nội dung thay đổi của file này và **không** quy nó cho hai packet trên. Điều duy nhất được chứng minh **gián tiếp**: `vite build` bao gồm `client.ts` và build thành công ⇒ biên dịch/bundle được, **hành vi runtime chưa** được test nào trong lượt này phủ.
- Mtime `19:16` **giống hệt** lần tôi ghi nhận ở lượt verify AWEB-17/18 ⇒ cùng một thay đổi đang tồn tại, không phải thay đổi mới phát sinh trong lượt này.
- Đề nghị coordinator chốt `client.ts` thuộc packet nào; nếu thuộc AWEB-16a/20b thì lease phải được mở rộng bằng văn bản trước khi tính ACCEPTED.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| AWEB-16a (jest) | **PASS** — 3/3, exit 0 |
| AWEB-20b (harness) | **PASS** — exit 0, các dòng `ok` đúng phạm vi timeline/filters |
| Build admin-web | **PASS** — exit 0, `built in 9.32s` |
| 2 file trong lease | **` M`** đúng như mong đợi (`overview-screen.tsx`, `operations-screen.tsx`) |
| `client.ts` | **OUT-OF-LEASE** — ` M`, chỉ được chứng minh gián tiếp là build được |

⇒ **AWEB-16a + AWEB-20b: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline/build**, với một điểm lease cần coordinator xử lý. Không tick gate.

## 5. GAP / open items

1. **`client.ts` ` M` ngoài lease** (mục 3) — điểm chặn acceptance nếu thay đổi đó thuộc hai packet này.
2. **Không có bằng chứng browser/runtime**: chỉ `jest` offline + harness đọc mã/`node` + `vite build`; **không** Playwright, không gọi API thật, không DB ⇒ hành vi UI (tick 1s thật trên trình duyệt, tìm kiếm/ngày trên dữ liệu thật) **chưa** được chứng minh.
3. **Chưa đọc nội dung 2 receipt** (`receipt-aweb-16a-2026-10-10.md` và `receipt-aweb-20b-2026-10-10.md` — cả hai tồn tại) để đối chiếu từng claim; lượt này verify bằng lệnh chạy thật.
4. **Harness không được tôi đọc từng assertion**: tôi dựa vào exit code 0 + danh sách dòng `ok`; muốn chắc độ phủ cần đọc 399 dòng của harness.
5. **Ghi chú nhỏ về chính lượt này:** lệnh kiểm tra sự tồn tại `client.ts` đầu tiên của tôi dùng đường dẫn tương đối sai (`..\admin-web\…`) nên in `exists=False`; đường dẫn đúng là `orchestrator/apps/admin-web/src/lib/api/client.ts` (đã xác nhận qua `git status`). Không ảnh hưởng kết quả 3 lệnh.
6. Không commit: hai file trong lease ` M`, `client.ts` ` M` ⇒ kết quả gắn cây làm việc tại HEAD §0.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (3 file) và `dist/` do chính lệnh build sinh ra (gitignored).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
