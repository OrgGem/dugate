# Verify độc lập (DSH) — AWEB-20a + AWEB-19 — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), lease READ-ONLY.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/build; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-19-20a-2026-10-10/DSH/` (`tsc.log`, `or10-filter.log`, `regression.log`, `aweb19-mjs.log`, `aweb19-build.log`, `SHA256SUMS.txt`).

## 1. AWEB-20a — bảng chứng

| # | Lệnh (cwd `orchestrator/services/orchestrator`) | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/or10-operations-time-filter.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 5 passed, 5 total`** (kỳ vọng packet 5/5 — ĐẠT) |
| 3 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-operations-sql.test.ts tests/operations-list-cursor-sort-binding.test.ts` | **0** | `Test Suites: 2 passed, 2 total` · **`Tests: 96 passed, 96 total`** (kỳ vọng packet 96/96 — ĐẠT), không block lỗi |

## 2. AWEB-19 — bảng chứng

| # | Lệnh (cwd `orchestrator/apps/admin-web`) | REAL_EXIT | Literal |
|---|---|---:|---|
| 4 | `node --test tests/*.test.mjs` | **0** | 2 file `.mjs` · **`# tests 12`** · `# pass 12` · `# fail 0` (kỳ vọng packet 12/12 — ĐẠT) |
| 5 | `npm run build` | **0** | `✓ built in 9.54s` · `dist/index.html 0.47 kB` (+ asset) ⇒ build **100% thành công** |

*Ghi chú kỹ thuật:* packet viết `node --test tests/*.test.mjs`; PowerShell không tự mở glob cho lệnh native nên tôi liệt kê file rồi truyền danh sách — thư mục `tests` của `apps/admin-web` hiện có **đúng 2 file** `*.test.mjs`, tổng **12 test**, khớp con số packet.

## 3. Pass/Fail rõ ràng

- **AWEB-20a**: typecheck **PASS**; unit time-filter **PASS 5/5**; regression SQL + cursor-sort-binding **PASS 96/96** ⇒ **không FAIL**.
- **AWEB-19**: 12/12 test `.mjs` **PASS**; production build **PASS** ⇒ **không FAIL**.
- Cả **5/5 lệnh exit 0**.

## 4. Ranh giới lease

- Lượt này chỉ **đọc + chạy lệnh**; không mở/không sửa file nào trong `apps/admin-web/src`.
- **`apps/admin-web/src/lib/api/client.ts` vẫn ` M`** trong cây (mtime `2026-10-10 19:16`, đã ghi nhận ở hai lượt verify trước AWEB-17/18 và AWEB-16a/20b): file này **ngoài lease** của AWEB-19/20a, **không** thuộc phạm vi kết luận ở đây. Nó chỉ được chứng minh **gián tiếp** qua bước 5 (`npm run build` bao gồm file đó và build thành công); **hành vi runtime** của thay đổi đó vẫn **chưa** được test nào phủ.
- Đề nghị coordinator chốt `client.ts` thuộc packet nào; nếu thuộc AWEB-19/20a thì cần mở lease bằng văn bản trước khi tính ACCEPTED.

## 5. Verdict

| Hạng mục | Kết quả |
|---|---|
| AWEB-20a typecheck | **PASS** — exit 0 |
| AWEB-20a `or10-operations-time-filter` | **PASS** — 5/5, exit 0 (khớp kỳ vọng packet) |
| AWEB-20a regression (2 suite) | **PASS** — 96/96, exit 0 (khớp kỳ vọng packet) |
| AWEB-19 `node --test` 12 test `.mjs` | **PASS** — 12/12, exit 0 |
| AWEB-19 `npm run build` | **PASS** — exit 0, `dist/index.html` sinh ra |
| `client.ts` | **OUT-OF-LEASE** — ` M` tồn tại sẵn; chỉ chứng minh gián tiếp là build được |

⇒ **AWEB-20a + AWEB-19: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline/build**, đúng cả ba con số kỳ vọng của packet (5/5, 96/96, 12/12). Không tick gate.

## 6. GAP / open items

1. **`client.ts` ` M` ngoài lease** (mục 4) — điểm cần coordinator chốt; nếu thuộc hai packet này thì acceptance chưa bao hàm thay đổi đó.
2. **Không có bằng chứng browser/runtime**: chỉ `jest` offline, `node --test` và build; không Playwright, không API/DB thật ⇒ hành vi UI của bộ lọc thời gian và của 12 test `.mjs` trên trình duyệt/dữ liệu thật **chưa** được chứng minh.
3. **Chưa đối chiếu nội dung 2 receipt** (`receipt-aweb-20a-2026-10-10.md`, `receipt-aweb-19-2026-10-10.md` — cả hai tồn tại): lượt này verify bằng lệnh chạy thật, không đọc từng claim trong văn bản.
4. **Chưa chạy toàn bộ suite admin-web/orchestrator**: chỉ 3 suite được packet chỉ định + 2 file `.mjs` ⇒ chưa loại trừ regression ngoài phạm vi đó (ví dụ các suite khác trong `tests/` của orchestrator).
5. **Không commit**: `client.ts` và các file khác đang ` M` ⇒ kết quả gắn cây làm việc tại HEAD §0.

## 7. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (5 file) và `apps/admin-web/dist/` do chính lệnh build sinh ra (gitignored).
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
