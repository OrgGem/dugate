# Verify độc lập (DSH) — AWEB-17 + AWEB-18 — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), lease READ-ONLY trên các file đã sửa của admin-web.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/build; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-17-18-2026-10-10/DSH/` (`aweb17-audit-state.log`, `aweb17-audit-state-retry.log`, `aweb17-jest.log`, `aweb18-vite-build.log`, `SHA256SUMS.txt`).

## 1. Bằng chứng chạy

| # | Lệnh (cwd ghi rõ) | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node --test apps/admin-web/tests/audit-state.test.mjs` — cwd **`du-rework/orchestrator`** | **0** | `# tests 5` · `# pass 5` · `# fail 0` · `ok 1 - audit state helpers` |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb-17-workflow-test-honesty.test.ts` — cwd `du-rework/orchestrator/services/orchestrator` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 6 passed, 6 total` |
| 3 | `node node_modules/vite/bin/vite.js build` — cwd `du-rework/orchestrator/apps/admin-web` | **0** | `✓ built in 9.10s` · `dist/index.html 0.47 kB` · `dist/assets/index-BYrvbGWZ.css 59.43 kB` · `dist/assets/index-DmGPI8La.js 1,013.04 kB` |

**Đính chính trung thực (lượt chạy đầu):** lần đầu tôi chạy lệnh 1 từ `du-rework` (sai cwd) và nhận `REAL_EXIT=1` với nguyên văn `Could not find 'apps/admin-web/tests/audit-state.test.mjs'` — **đó là lỗi đứng sai thư mục của tôi, không phải lỗi sản phẩm**; file nằm ở `du-rework/orchestrator/apps/admin-web/tests/`. Chạy lại đúng cwd cho kết quả xanh ở bảng trên. Cả hai log đều được giữ trong raw.

Artifact: `dist/index.html` tồn tại, mtime `2026-10-10 20:31:41`. Digest (16 ký tự đầu): `audit-state.test.mjs` = `afe9446a57aa5869` · `aweb-17-workflow-test-honesty.test.ts` = `0bfb6f3a36ab4e96`.

## 2. Pass/Fail rõ ràng

- **AWEB-17**: `audit-state.test.mjs` **PASS** 5/5 (exit 0) — test cho helper trạng thái audit của admin-web.
- **AWEB-17 (jest)**: `aweb-17-workflow-test-honesty.test.ts` **PASS** 6/6 (exit 0) — test tính trung thực của workflow test ở tầng orchestrator.
- **AWEB-18**: `vite build` **PASS** (exit 0) — bundle production dựng được, không lỗi biên dịch.
- **Không có FAIL** nào trong 3 lệnh (sau khi sửa cwd của lượt 1).

## 3. Ranh giới `client.ts` — OUT-OF-LEASE (ghi nhận rõ)

- `orchestrator/apps/admin-web/src/lib/api/client.ts` đang ở trạng thái **` M`** (đã sửa), 555 dòng, mtime `2026-10-10 19:16`.
- Theo packet, file này **ngoài lease** của AWEB-17/18 ⇒ **tôi không kiểm chứng nội dung thay đổi của nó**, và **không** quy nó cho hai packet này.
- Điều tôi **có** chứng minh về nó: chỉ là **hệ quả gián tiếp** của lệnh 3 — bundle `vite build` bao gồm `client.ts` và build **thành công** ⇒ file hiện tại **biên dịch/bundle được**, nhưng **hành vi runtime** của thay đổi đó **chưa** được test nào trong lượt này phủ.
- Đề nghị: nếu `client.ts` thuộc packet khác, cần receipt + verify riêng; nếu nó là phần của AWEB-17/18 thì lease cần được mở rộng bằng văn bản trước khi tính ACCEPTED.

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| AWEB-17 `audit-state.test.mjs` | **PASS** — 5/5, exit 0 (cwd `du-rework/orchestrator`) |
| AWEB-17 `aweb-17-workflow-test-honesty.test.ts` | **PASS** — 6/6, exit 0 |
| AWEB-18 `vite build` | **PASS** — exit 0, `dist/index.html` + 2 asset sinh ra |
| Ranh giới `client.ts` | **OUT-OF-LEASE** — có ` M` trong cây; chỉ được chứng minh gián tiếp là build được |

⇒ **AWEB-17 + AWEB-18: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline/build**, với một điểm cần coordinator xử lý về lease. Không tick gate.

## 5. GAP / open items

1. **`client.ts` ` M` ngoài lease** (mục 3): cần chốt thuộc packet nào và verify riêng; nếu thuộc AWEB-17/18 thì phải mở lease bằng văn bản — nếu không, acceptance của hai packet này **không** bao hàm thay đổi đó.
2. **Không có bằng chứng browser/runtime**: lượt này chỉ chạy `node --test`, `jest` offline và `vite build`; **không** mở browser, không Playwright, không gọi API thật ⇒ hành vi UI của AWEB-17/18 (ví dụ trạng thái audit trên màn hình) **chưa** được chứng minh.
3. **Chưa đọc kỹ nội dung 2 receipt** (`receipt-aweb-17-2026-10-10.md` 12 dòng, `receipt-aweb-18-2026-10-10.md` 26 dòng — cả hai tồn tại) để đối chiếu từng claim; lượt này verify **bằng lệnh chạy thật**, không bằng đối chiếu văn bản.
4. **Không chạy suite admin-web rộng hơn**: không có `jest`/`node --test` cho toàn bộ `apps/admin-web/tests` ⇒ chưa loại trừ regression ở các test khác cùng thư mục.
5. Không commit: test jest là file mới (`??`), `client.ts` ` M` ⇒ kết quả gắn digest §1.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (4 file) và thư mục `dist/` do chính lệnh build sinh ra (gitignored).
- Receipt tự quét: **0 dòng trailing whitespace**; **0 ký tự nháy kép**.
