# Verify độc lập (DSH2) — Connectors suites + Audit event links + sweep 11 file — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `orchestrator/apps/admin-web/tests/**` và build của `apps/admin-web`.
**Tuân thủ COORDINATOR-CONTRACT:** chỉ **đọc** + chạy test/build **offline**; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/mạng ngoài; receipt **0 ký tự nháy kép** (đã tự đếm, §6).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`).
**Raw:** `coordination/reports/raw/verify-connectors-and-audit-suites-2026-10-10/DSH2/` — `01-sweep-round1..3.log`, `02-three-rounds.log`, `03-connectors-state-honesty.log`, `03-connectors-fixtures.log`, `03-audit-event-links.log`, `04-vite-build.log`, `SHA256SUMS.txt`.
**Receipt liên quan (đã có):** `verify-aweb-connectors-suites-INDEPENDENT-DSH2-2026-10-10.md` (audit sâu 2 suite Connectors) · `verify-aweb-audit-workflow-tests-INDEPENDENT-DSH2-2026-10-10.md` (audit sâu audit-event-links) · `verify-admin-web-updated-sweep-INDEPENDENT-DSH2-2026-10-10.md` (sweep 80/17 lượt trước).

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| **3 vòng** toàn bộ 11 file `tests/*.test.mjs` | **80/80 PASS, exit 0 cả 3 vòng** — `ℹ tests 80` · `ℹ suites 17` · `ℹ pass 80` · `ℹ fail 0` · `skipped 0` · `todo 0` (606 / 642 / 775 ms) |
| Suite `connectors-state-honesty` | **6/6 PASS, exit 0** |
| Suite `connectors-fixtures` | **2/2 PASS, exit 0** |
| Suite `audit-event-links` | **5/5 PASS, exit 0** |
| `vite build` | **exit 0** — `✓ 2698 modules transformed.` · `✓ built in 12.80s` (advisory chunk >500 kB đã biết) |
| File sản phẩm mà 3 suite trọng tâm kiểm | **không drift** — `state.ts`, `curl-import.ts`, `connectors-screen.tsx` **tracked & sạch**; `audit-screen.tsx` `??` (mtime 23:05:02) |
| 11 file test có bị sửa giữa các lượt verify? | **KHÔNG** — sha256 của **cả 11 file** trùng khớp receipt sweep trước ⇒ chỉ đọc, không ai ghi |

**Một dòng cho coordinator:** Connectors suites + Audit event links **đạt verify độc lập** — 3 vòng sweep đều **80/80** exit 0, ba suite trọng tâm 6/2/5 đều xanh, `vite build` exit 0; không có drift ở file test lẫn file sản phẩm liên quan.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd `apps/admin-web`) | Exit | Literal |
|---|---|---:|---|
| 1 | `node --test tests/*.test.mjs` — **vòng 1** | **0** | `ℹ tests 80` · `ℹ suites 17` · `ℹ pass 80` · `ℹ fail 0` · `ℹ skipped 0` · `ℹ todo 0` · `606.2 ms` |
| 2 | y hệt — **vòng 2** | **0** | 80 / 17 / 0 fail · `642.0 ms` |
| 3 | y hệt — **vòng 3** | **0** | 80 / 17 / 0 fail · `775.0 ms` |
| 4 | `node --test tests/connectors-state-honesty.test.mjs` | **0** | `✔ Connectors state honesty` · `tests 6` · `pass 6` · `fail 0` |
| 5 | `node --test tests/connectors-fixtures.test.mjs` | **0** | `✔ connector read and config summary fixtures` · `tests 2` · `pass 2` · `fail 0` |
| 6 | `node --test tests/audit-event-links.test.mjs` | **0** | `✔ audit event deep links` · `tests 5` · `pass 5` · `fail 0` |
| 7 | `node node_modules/vite/bin/vite.js build` | **0** | `✓ 2698 modules transformed.` · `dist/assets/index-mWPChVFG.js 1,054.06 kB │ gzip: 260.21 kB` · `✓ built in 12.80s` |

**17 suite trong 3 vòng** (đều xanh): audit event deep links · audit state helpers · connector read and config summary fixtures · Connectors state honesty · Trace and Audit URL query hydration · buildOperationsQuery · operations population fingerprint · operationsCursorIsStale · profile row identity — F2 unique keying · keyProfileListRows … · groupProfileListRows … · parseProfileListPage · trace state helpers · parseWorkerInstanceList · worker inventory API client · computeWorkerTelemetry · workflow simulation honesty.

Artifact (11 file test, tất cả `??` untracked ⇒ provenance bằng sha256):

| File | sha256 (20 ký tự đầu) |
|---|---|
| `audit-event-links.test.mjs` | `ad7c58c6cac41d8cda1f` |
| `audit-state.test.mjs` | `afe9446a57aa5869c509` |
| `connectors-fixtures.test.mjs` | `41d026ebc3f19c508aac` |
| `connectors-state-honesty.test.mjs` | `c64c477fb6fca29dd349` |
| `deep-link-query-hydration.test.mjs` | `b146b462e1a6bffc5ad7` |
| `operations-state.test.mjs` | `995cc505234c17986986` |
| `profiles-row-key.test.mjs` | `2205923b4536e931ad36` |
| `profiles-state.test.mjs` | `b9fcca13b50f781a32f1` |
| `trace-state.test.mjs` | `e5bb31cf0f91309c6276` |
| `worker-instance-state.test.mjs` | `b00608f040973d8b4c04` |
| `workflow-simulation-honesty.test.mjs` | `4acf1df1b4c838741933` |

File sản phẩm liên quan: `connectors/state.ts` `7a9006f2…c3ae` (sạch) · `connectors/curl-import.ts` `2a97245d…c830` (sạch) · `connectors/connectors-screen.tsx` `7c53f008…606b` (sạch) · `audit/audit-screen.tsx` `54ce19a6…afb5` (`??`, 23:05:02).

---

## 2. Hai suite Connectors — nội dung được xác nhận (đã audit sâu ở receipt riêng)

- **`connectors-state-honesty` (6 test):** fail-closed khi quảng cáo capability thiếu/không đọc được (cả 6 cờ gate false + reason nêu advertisement unavailable); cờ độc lập management / test / credential-workflow với 2 tổ hợp trái chiều; summary chỉ lộ **keys đã sort + tên header** (header bí mật và `[REDACTED]` vào `redactedHeaderNames`), không lộ giá trị; parse curl mẫu với **mask trong preview** (`****9876`, header secret `****5432` + `valueChars`, form secret, file chỉ `@customer-file.pdf`); `connectorConfigFromDraft`/`buildConnectorUpsertParams` **không** mang secret hay local path (bearer chỉ nằm ở draft in-memory, `secretPresent: true`); 11 regex wiring (tôi đã đối chiếu 6 regex quan trọng vào đúng dòng `connectors-screen.tsx:155, 156, 258, 427, 676, 803`).
- **`connectors-fixtures` (2 test):** reader đếm row hỏng là `skipped: 3` và giữ nguyên thứ tự row hợp lệ; summary giữ **tên** top-level key và **tên** header thường nhưng bỏ **giá trị** (cả header bí mật lẫn thường); guard của suite phủ **cả hàm và hằng** + guard diagnostics.
- **Kỹ thuật:** suite honesty nạp **module sản phẩm thật** (transpile ESNext → rewrite import tương đối `./curl-import` thành `file://` tuyệt đối, có `assert.notEqual` buộc rewrite xảy ra → `data:` URL → `import()`); suite fixtures **trích + thực thi** khai báo thật, không copy code.
- **Probe độc lập của tôi ở lượt trước: 7/7** với input riêng (10 dạng capability hỏng, ma trận gate 4 tổ hợp, 3 nhánh lỗi của upsert plan + trim, curl command riêng, reader skipped/order).

## 3. Suite `audit-event-links` — nội dung được xác nhận

- 5 test: `operation:<id>` → **cả** link Audit + Trace; resource hợp lệ khác → chỉ Audit, **không** bịa link Trace; trim + encode ký tự đặc biệt; resource rỗng/không hợp lệ (gồm control char và 129 ký tự) → cả hai null; `operationId` vượt giới hạn (65) → **giữ** link Audit, mất link Trace.
- Assertion **thực thi** `safeQueryValue` + `auditEventLinks` trích từ `audit-screen.tsx` (guard chống bỏ sót + guard diagnostics), không so chuỗi.
- **Probe độc lập của tôi ở lượt trước: 11/11** — thêm ranh giới: tiền tố `OPERATION:` không phân biệt hoa/thường và giữ nguyên case giá trị; giới hạn operationId **bao gồm 64 / loại 65**; giới hạn resource **128 giữ / 129 loại**; `operation:` trần **giữ link Audit**; link luôn query-safe (không `#`/space thô) và **không bao giờ** sinh `/operations?id=`.

---

## 4. Số liệu sweep: phân rã và tính liên tục

- **17 suite ↔ 11 file** khớp 1-1 với `describe()`: audit-event-links 1 · audit-state 1 · connectors-fixtures 1 · connectors-state-honesty 1 · deep-link-query-hydration 1 · operations-state 3 · profiles-row-key 3 · profiles-state 1 · trace-state 1 · worker-instance-state 3 · workflow-simulation-honesty 1 = **17**.
- **80 test = 75 khai báo `it(` + 5** sinh trong vòng lặp: `operations-state.test.mjs:126` bọc một `it(` (`:134`) trong `for … of` **6 phần tử** ⇒ chạy 6 lần. Đếm tĩnh `^\s*it\(` cho 75; runner báo 80 — dùng literal `ℹ tests N`, không dùng đếm tĩnh.
- **Không có drift:** sha256 của cả **11 file test** trùng khớp receipt sweep trước, và 3 file sản phẩm Connectors vẫn tracked & sạch ⇒ kết quả 3 vòng này áp cho đúng revision đã ghi.
- **Build không đổi:** bundle `index-mWPChVFG.js` (1 054 062 B) và `index-Coqr0O_e.css` trùng tên & kích thước với lượt sweep trước ⇒ các suite mới là file test, không vào bundle.

---

## 5. GAP / open items

1. **Không có browser/Playwright**: 80 test là `node:test` thuần (helper/state/render tĩnh + regex wiring) ⇒ **không** thay gate browser/live; hành vi UI thật (mở deep link, gate control trên DOM, mask trên màn hình) chưa được chứng minh.
2. **`dist/` bị ghi đè bởi chính lệnh build của tôi** (gitignored; `git status` trên `dist` sạch) — không file nguồn nào bị chạm.
3. **Mọi file test đều `??` untracked** ⇒ kết luận gắn sha256 tại §1; nếu lane khác sửa test, phải chạy lại sweep.
4. **`buildConnectorUpsertParams` hiện luôn `mode: 'create'`** (`connectors/state.ts:332`, không có nhánh update) — quan sát sản phẩm, không phải vấn đề của hai suite.
5. **Con số 2698 modules phụ thuộc revision nguồn**; lượt này không đổi so với lượt trước vì không thêm/bớt module app.

---

## 6. Xác nhận

- Chỉ **đọc** + chạy `node --test`/`vite build` offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate; không DB/Redis, không claim DB window, không đọc `.env.live`.
- File tôi tạo: receipt này + 8 file raw trong `coordination/reports/raw/verify-connectors-and-audit-suites-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`).
- Tự kiểm theo COORDINATOR-CONTRACT: **0 ký tự nháy kép** trong receipt này (đếm bằng mã hoá ký tự, không in ký tự đó ra), **0 dòng trailing whitespace**; không có hành động ghi nào ngoài `coordination/reports/**`.
