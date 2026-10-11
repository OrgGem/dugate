# Verify độc lập (DSH2) — Contracts operations list alignment (Codex-2) — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY**: `packages/contracts/tests/operations-list-contract.test.ts`, `packages/contracts/src/public-api.ts` (đọc), và suite conformance phía orchestrator để kiểm phạm vi còn sót.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/typecheck offline; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add`/commit/push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/mạng ngoài.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`).
**Raw:** `coordination/reports/raw/verify-contracts-alignment-2026-10-10/DSH2/` — `01-contracts-full.log`, `02-orchestrator-conformance.log`, `03-dsh2-probe.log`, `04-contracts-typecheck.log`, `05-dsh2-probe.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `coordination/reports/receipt-contracts-operations-alignment-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| Toàn bộ suite `packages/contracts` | **TÁI HIỆN ĐÚNG TỪNG CON SỐ** — `Test Suites: 30 passed, 30 total` · `Tests: 570 passed, 570 total` · `Snapshots: 0 total` · exit **0** (4.77 s) |
| Số suite khớp số file test | **ĐÚNG** — 30 file `*.test.ts` trong `tests/` ↔ 30 dòng `PASS` |
| Thay đổi trong `operations-list-contract.test.ts` | **ĐÚNG như receipt mô tả** — `+8/−1`, chỉ trong 1 `it`: đổi tên `six` → `eight`, thêm `'from','to'` vào kỳ vọng, thêm 1 assertion dương (UTC hợp lệ) + 1 assertion âm (date-only bị từ chối) |
| Số test của file **không đổi** | **ĐÚNG** — 16 `it(` (khớp AWEB-20a: 15/16 trước đây) |
| `git diff --check` file test | **ĐÚNG** — exit 0 |
| **Không còn lỗi from/to cũ** | **ĐÚNG trong `packages/contracts`**; **CÒN SÓT ở orchestrator**: `tests/operations-list-contract-conformance.test.ts:123` vẫn là `it('the contract declares six parameters')` và suite đó **2 failed / 19** (§3) |
| Kiểm độc lập ngữ nghĩa contract (probe của tôi) | **8/8 PASS** — allow-list đúng 8 tham số theo thứ tự, schema không drift, UTC (Z/millis/micro giây) nhận, date-only + offset + ngày không tồn tại bị từ chối, comparator giữ micro giây, `dist` đồng bộ với `src` |
| Typecheck `packages/contracts` | **exit 0**, 0 diagnostics (bổ sung của tôi; receipt không claim) |
| Raw log receipt nêu | **TỒN TẠI** và khớp 3 dòng tổng kết (`raw/contracts-operations-alignment-2026-10-10/jest-full.log`) |

**Một dòng cho coordinator:** alignment **đạt verify độc lập** — 30/30 suite và 570/570 test PASS exit 0 đúng như receipt, diff đúng +8/−1 và không nới lỏng assertion nào; **nhưng** câu 'không còn lỗi from/to cũ' chỉ đúng trong `packages/contracts`: suite conformance phía orchestrator vẫn còn nguyên kỳ vọng **six parameters** và đỏ 2 test — cần một packet riêng cho file đó.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand` (`packages/contracts`) | **0** | `Test Suites: 30 passed, 30 total` · `Tests: 570 passed, 570 total` · `Snapshots: 0 total` · `Time: 4.77 s`; **30 dòng `PASS`**, **0 dòng `FAIL`** |
| 2 | `tsc --noEmit -p tsconfig.json` (`packages/contracts`) | **0** | 0 dòng output |
| 3 | probe độc lập DSH2 (`05-dsh2-probe.cjs`) | **0** | `PROBE_RESULT 8/8 checks passed` |
| 4 | `git diff --check -- tests/operations-list-contract.test.ts` | **0** | không output |
| 5 | `jest --runTestsByPath tests/operations-list-contract-conformance.test.ts` (`services/orchestrator`) | **1** | `Test Suites: 1 failed, 1 total` · `Tests: 2 failed, 17 passed, 19 total` — xem §3 |

Artifact đã kiểm (sha256 · mtime · git):

| File | sha256 | mtime | lines | git |
|---|---|---|---|---|
| `packages/contracts/tests/operations-list-contract.test.ts` | `74b9babe7e1fe234de5f906b31f810813575d761327a1fe57fb674c7d8e4fb8c` | 22:41:38 | 237 | ` M` |
| `packages/contracts/src/public-api.ts` | `f5594486f979d6b0c3c4f6f133b14fa397f1eacc4eaf2c1b3731f6bf843e53ce` | 21:09:30 | 771 | ` M` |
| `packages/contracts/dist/public-api.js` | `12b62d8021a593141ef9d9d560cc9fee6faf26874d0c7b4293cdf4af1854fa02` | 22:35:01 | 655 | ignored, **mới hơn `src`** |
| `services/orchestrator/tests/operations-list-contract-conformance.test.ts` | `7dfc97e6c95ead3a7bcdd6bca67b1cd5c22c03284ebb90ec325052324145f71b` | 10-07 04:30:18 | 370 | **sạch, không đụng tới** |

`jest.config.cjs` của contracts: `preset: ts-jest`, `roots: ['<rootDir>/tests']`, `testMatch: ['**/*.test.ts']` ⇒ 30 file = 30 suite, không có file nào bị bỏ qua ngoài ý muốn.

---

## 2. Đối chiếu receipt từng claim

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Scope chỉ `packages/contracts/tests/operations-list-contract.test.ts` | **ĐÚNG** | `git status` lượt này: chỉ file đó ` M` trong `packages/contracts/tests`; `git diff --stat` = 1 file, `+8/−1` |
| 2 | Kỳ vọng nay là **8** tham số gồm `from`/`to` | **ĐÚNG** | diff: đổi tên `six parameters the route reads` → `eight parameters the route reads`, thêm `'from',` và `'to',` vào mảng `OPERATIONS_LIST_QUERY_PARAMS` |
| 3 | Test cũ **xác nhận bound UTC hợp lệ** và **từ chối `from` chỉ có ngày** | **ĐÚNG** | 2 assertion mới trong cùng `it`: `safeParse({from:'2026-10-10T00:00:00Z',to:'2026-10-10T23:59:59Z'}).success === true` và `safeParse({from:'2026-10-10'}).success === false` |
| 4 | Số test của suite **không đổi** | **ĐÚNG** | 16 `it(` (khớp 15/16 của AWEB-20a: 1 test đỏ cũ nay xanh, không thêm/bớt test) |
| 5 | Lệnh: `node ./node_modules/jest/bin/jest.js --runInBand`, cwd `packages/contracts`, Node v24.21.0 | **ĐÚNG** | lệnh #1 chạy đúng lệnh/cwd/runtime đó |
| 6 | Kết quả `exit 0; 30/30 suites và 570/570 tests; 0 snapshots` | **ĐÚNG** | literal ở §1 (khớp cả 3 dòng tổng kết) |
| 7 | `git diff --check` pass | **ĐÚNG** | lệnh #4 exit 0 |
| 8 | Raw log ở `raw/contracts-operations-alignment-2026-10-10/jest-full.log` | **ĐÚNG** | file tồn tại (147 byte), chứa đúng `Test Suites: 30 passed` · `Tests: 570 passed` · `Snapshots: 0 total` |
| 9 | Không stage/commit/push | **ĐÚNG** | không có gì staged; file vẫn ` M` |
| 10 | Hàm ý 'không còn lỗi from/to cũ' (theo đề bài) | **ĐÚNG một phần** | `packages/contracts`: 0 hit `six parameters`; **orchestrator conformance còn 1 hit** và đỏ 2 test (§3) |

---

## 3. Phạm vi thật của 'không còn lỗi from/to cũ'

| Nơi | Trạng thái |
|---|---|
| `packages/contracts/tests/operations-list-contract.test.ts` | **SẠCH** — không còn chuỗi `six`; kỳ vọng 8 tham số; 16/16 xanh |
| `packages/contracts` toàn bộ | **SẠCH** — 30/30 suite, 570/570 test; quét `six parameters\|declares six` trong toàn orchestrator chỉ còn **1 hit** và nó nằm ngoài package này |
| `services/orchestrator/tests/operations-list-contract-conformance.test.ts:123` | **CÒN STALE** — `it('the contract declares six parameters', …)`; suite **2 failed / 17 passed / 19** với 2 test `W-CONTRACT-ALIGN-1: the route reads exactly the contract parameter set › the contract declares six parameters` và `› every contract parameter is actually wired into the parser` |

Đây **không phải** hồi quy của packet này: file conformance giữ nguyên mtime `10-07 04:30:18`, `git status` **sạch**, và AWEB-20a đã công bố trước đó rằng file này có kỳ vọng 6 tham số lỗi thời nhưng **ngoài lease** của packet đó. Kết luận đúng: alignment đã hoàn tất **phía contracts**, còn **phía orchestrator** cần một packet riêng (2 test, cùng bản chất from/to) — nếu không, bất kỳ ai chạy batch orchestrator vẫn thấy đỏ.

---

## 4. Audit diff — không nới lỏng assertion nào

`git diff` đầy đủ cho thấy đúng 3 thay đổi, tất cả **siết chặt hơn**, không có thay đổi nào làm test dễ xanh hơn một cách giả tạo:

1. Đổi **tên** test `six parameters` → `eight parameters` (mô tả đúng thực tế; tên cũ sẽ là tài liệu sai).
2. Thêm `'from'`/`'to'` vào mảng kỳ vọng của `OPERATIONS_LIST_QUERY_PARAMS` — trước đó mảng này thiếu 2 phần tử nên test đỏ; nay khớp.
3. Thêm 2 assertion **mới** (không thay assertion cũ): 1 dương (`{from,to}` UTC hợp lệ → `success === true`) và 1 âm (`from: '2026-10-10'` → `success === false`).
4. **Giữ nguyên** dòng chống drift quan trọng nhất: `expect(Object.keys(ListOperationsQuerySchema.shape).sort()).toEqual([...OPERATIONS_LIST_QUERY_PARAMS].sort())` ⇒ schema và allow-list vẫn bị buộc phải là **cùng một tập**; nếu ai thêm tham số chỉ ở một phía, test vẫn đỏ.

⇒ Không có assertion nào bị xoá hay nới; không có `it.skip`/`todo` mới (đã quét: 0 hit trong file).

---

## 5. Kiểm độc lập ngữ nghĩa (probe của tôi, không dùng test của tác giả)

Probe nạp **source TS** của `packages/contracts` qua transpile hook và tự kiểm:

| # | Kiểm | Kết quả |
|---|---|---|
| P1 | Allow-list đúng **8** tham số **theo thứ tự** `limit, cursor, state, tenant, id, sort, from, to` | ok |
| P2 | Tập key của `ListOperationsQuerySchema` **bằng** allow-list (chống drift) | ok (8 = 8) |
| P3 | `Z` instants, milli giây, **micro giây** (`…T00:00:00.123456Z`) đều được nhận | ok |
| P4 | `2026-10-10` (chỉ ngày), thiếu `Z`, offset `+07:00`, ngày không tồn tại `2026-13-01`, chuỗi rác → **đều bị từ chối**, message khớp `/UTC ISO timestamp/` | ok (5 giá trị) |
| P5 | Chuỗi rỗng `from=''`/`to=''` **được** schema chấp nhận (route quyết định ngữ nghĩa 'không bound') | ok |
| P6 | Range đảo (`from > to`) **không** phải việc của schema; `compareAdminListTimeBounds` mới là bên so, và **không cắt micro giây** (`…000001Z > …000000Z`) | ok |
| P7 | 6 tham số cũ giữ nguyên hành vi: `{}` hợp lệ, `sort` sai bị chặn; **và hai cap được giữ tách biệt** — public list `OPERATIONS_LIST_LIMIT_MAX = 100` (101 bị chặn) vs admin resource list `ADMIN_LIST_LIMIT_MAX = 200` (200 **không** được schema public chấp nhận) | ok |
| P8 | `dist/public-api.js` (thứ consumer thật import) có **cùng 8 tham số** và **mới hơn** `src` ⇒ alignment đã tới artifact build | ok |

Ghi chú P7 là một **đính chính kỳ vọng của chính tôi**: lượt probe đầu tôi tưởng schema dùng `ADMIN_LIST_LIMIT_MAX = 200`, chạy thật thì bị chặn với `Number must be less than or equal to 100` — tức public operations list cap là **100**, khác admin cap **200**. Đã sửa **probe** (không sửa sản phẩm) và ghi lại vì đây là chi tiết dễ nhầm khi đọc hai hằng số cạnh nhau trong cùng file.

---

## 6. GAP / open items

1. **Packet riêng cho `services/orchestrator/tests/operations-list-contract-conformance.test.ts`** (2 test đỏ, stale `six parameters`, file sạch không ai sở hữu). Đây là chỗ duy nhất còn lại của cùng loại lỗi from/to trong workspace.
2. **Không có bằng chứng HTTP/live** cho route với `from`/`to` trong lượt này — phạm vi là contract/schema + test offline; route đã có test riêng (`or10-operations-time-filter`, `admin-operations-sql`) nhưng đó không thuộc packet alignment.
3. **`src/public-api.ts` đang ` M`** (từ lane AWEB-20a, mtime 21:09) — alignment test bám trên revision đó; nếu contract đổi tiếp, phải chạy lại suite.
4. **`dist/` là build artifact** (ignored): P8 xác nhận dist hiện đồng bộ, nhưng nếu ai rebuild contracts sau lượt này thì nên chạy lại P8/suite để giữ hiệu lực.
5. **`tsconfig.json` của contracts loại `tests`** ⇒ `tsc --noEmit -p tsconfig.json` (exit 0) **không** phủ file test; phần typecheck của test chỉ được chứng minh gián tiếp qua việc ts-jest biên dịch và chạy 570 test thành công. Nếu muốn chắc, cần một entry typecheck riêng cho `tests/**`.

---

## 7. Xác nhận

- Chỉ **đọc** + chạy jest/tsc/probe offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 5 file raw trong `coordination/reports/raw/verify-contracts-alignment-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`, nạp source TS của contracts; không bind cổng, không mạng.
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Ghi chú trung thực: probe của tôi có **1 FAIL ở lượt đầu** do kỳ vọng sai của tôi về cap (P7) — đã sửa probe và chạy lại **8/8**; không có dòng sản phẩm nào bị chạm.
- Mọi kết luận gắn sha256 tại §1; các file liên quan đều **chưa commit** nên kết quả chỉ đúng cho revision đã ghi.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
