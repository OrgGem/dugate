# Verify độc lập (DSH2) — Orchestrator operations conformance alignment — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `orchestrator/services/orchestrator/tests/operations-list-contract-conformance.test.ts` (mở rộng đọc sang `src/modules/operations/list-query.ts` để kiểm tính đúng của kỳ vọng mới).
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/typecheck **offline**; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add`/commit/push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/mạng ngoài.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`).
**Raw:** `coordination/reports/raw/verify-orchestrator-operations-conformance-2026-10-10/DSH2/` — `01-conformance-run1.log`, `02-two-runs.log`, `03-conformance-verbose.log`, `04-orchestrator-typecheck.log`, `05-wiring-probe.log`, `06-wiring-probe.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `coordination/reports/receipt-orchestrator-operations-conformance-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| Jest conformance `19/19`, exit 0 | **TÁI HIỆN ĐÚNG** — `Test Suites: 1 passed, 1 total` · `Tests: 19 passed, 19 total`, 2 lần chạy liên tiếp đều exit 0 |
| Typecheck orchestrator exit 0, no diagnostics | **ĐÚNG** — `tsc --noEmit -p tsconfig.json` → 0 dòng output |
| `git diff --check` exit 0 | **ĐÚNG** |
| **Hết điểm đỏ 2 test cũ** | **XÁC NHẬN** — `the contract declares six parameters` (đỏ) nay là `the contract declares eight parameters` (**√ pass**); `every contract parameter is actually wired into the parser` (đỏ) nay **√ pass**; chuỗi `six parameters` **không còn** trong file |
| Không xoá/skip assertion nào | **ĐÚNG** — diff `+8/−1` (dòng `−1` là chính câu nhãn được đổi), **0** `.skip/.only/xit/xdescribe/todo` |
| Kỳ vọng mới đúng với sản phẩm (không phải test tự chiều) | **ĐÚNG** — route thật sự đọc/parse `from`/`to` và áp predicate SQL; probe độc lập xác nhận 7 fixture từ chối đều throw, bound hợp lệ round-trip, range đảo 422 |
| Probe độc lập của tôi (bổ sung) | **15/15 PASS**, exit 0 — trong đó M15 kiểm đúng tính 'mỗi tham số đã khai đều có kiểm tra từ chối' |

**Một dòng cho coordinator:** receipt conformance **đạt verify độc lập** — 19/19 × 2 lần, typecheck 0, `diff --check` 0, và **cả 2 điểm đỏ cũ đã hết** bằng một thay đổi `+8/−1` không nới lỏng assertion nào (fixture `from`/`to` là **bắt buộc** bởi chính bất biến dẫn-xuất-từ-contract trong test).

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `jest --runInBand --config jest.unit.config.cjs --runTestsByPath tests/operations-list-contract-conformance.test.ts` × **2** (`services/orchestrator`) | **0/0** | `PASS tests/operations-list-contract-conformance.test.ts` · `Test Suites: 1 passed, 1 total` · `Tests: 19 passed, 19 total` |
| 2 | như trên + `--verbose` (bắt tên từng test) | **0** | `√ the contract declares eight parameters` · `√ an unknown parameter is ignored, so a future page/offset cannot half-exist` · `√ every contract parameter is actually wired into the parser` |
| 3 | `tsc --noEmit -p tsconfig.json` (`services/orchestrator`) | **0** | 0 dòng output |
| 4 | `git diff --check -- tests/operations-list-contract-conformance.test.ts` | **0** | không output |
| 5 | probe độc lập DSH2 (`06-wiring-probe.cjs`) | **0** | `PROBE_RESULT 15/15 checks passed`; M15: `8/8 wired: 7 rejecting fixtures throw, bounds round-trip, inverted range 422, unknown ignored` |

Artifact đã kiểm:

| File | sha256 | mtime | lines | git |
|---|---|---|---|---|
| `services/orchestrator/tests/operations-list-contract-conformance.test.ts` | `3d056544e87bf9bd75e9794d37f94118b69554d0f2d31a292e373284311c3492` | 22:57:02 | 374 | ` M` |
| `services/orchestrator/src/modules/operations/list-query.ts` (đường route) | `9aff3229df547d8e53cce1f0…` | 21:06:10 | 654 | ` M` |
| `packages/contracts/src/public-api.ts` (nguồn allow-list) | `f5594486f979d6b0c3c4f6f1…` | 21:09:30 | 771 | ` M` |

---

## 2. Đối chiếu receipt từng claim

| # | Claim của receipt | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Chỉ đổi `tests/operations-list-contract-conformance.test.ts` | **ĐÚNG** | `git status` chỉ file đó ` M` trong phạm vi lease; diff = 1 file |
| 2 | Đổi nhãn **six → eight** | **ĐÚNG** | diff `-  it('the contract declares six parameters', () => {` → `+  it('the contract declares eight parameters', () => {`; grep `six parameters` = **0 hit** |
| 3 | Thêm `from`/`to` vào tập tham số kỳ vọng | **ĐÚNG** | diff thêm `'from',` `'to',` vào mảng `OPERATIONS_LIST_QUERY_PARAMS` |
| 4 | Thêm fixture **date-only** cho **cả hai** bound vào test wiring parser | **ĐÚNG** | diff thêm `from: 'from=2026-10-10'`, `to: 'to=2026-10-10'` vào `rejecting` |
| 5 | Mỗi tham số đã khai tiếp tục có kiểm tra từ chối | **ĐÚNG — và là bắt buộc, không phải tuỳ chọn** | Test tự dẫn xuất: `expect(Object.keys(rejecting).sort()).toEqual([...declared].sort())` với `declared = OPERATIONS_LIST_QUERY_PARAMS.filter(n => n !== 'limit')` ⇒ thiếu fixture cho `from`/`to` thì **chính dòng đó đỏ**; probe M15 xác nhận 7/7 fixture throw |
| 6 | Không xoá/skip assertion nào | **ĐÚNG** | `git diff --numstat` = `+8/−1`; dòng `−1` là câu nhãn cũ; quét `.skip/.only/xit/xdescribe/todo(` = **0 hit**; 19 test trước và sau |
| 7 | Jest `exit 0, 1/1 suite, 19/19 tests` | **ĐÚNG** | lệnh #1 (2 lần) |
| 8 | Typecheck `exit 0, no diagnostics` | **ĐÚNG** | lệnh #3 |
| 9 | `git diff --check` exit 0 | **ĐÚNG** | lệnh #4 |
| 10 | Node v24.21.0 | **ĐÚNG** | runtime của mọi lệnh trong lượt này |
| 11 | Không stage/commit/push | **ĐÚNG** | file vẫn ` M`, không có gì staged |

---

## 3. Xác nhận 'hết điểm đỏ 2 test cũ'

| Thời điểm | Revision file | Kết quả | 2 test đỏ |
|---|---|---|---|
| Baseline (receipt `verify-contracts-alignment`, 22:54) | `7dfc97e6…` (mtime 10-07, **sạch**) | `2 failed, 17 passed, 19 total`, exit 1 | `the contract declares six parameters` · `every contract parameter is actually wired into the parser` |
| Hiện tại (lượt này) | `3d056544…` (mtime 22:57:02, ` M`) | `19 passed, 19 total`, exit 0 (×2) | **không còn** — test thứ nhất đã đổi tên thành `eight parameters` và **pass**; test thứ hai giữ nguyên tên và **pass** |

Chuỗi `six parameters` / `six supported` không còn xuất hiện ở bất kỳ đâu trong file; quét toàn `du-rework` (trừ `node_modules`/`dist`) cho mảng 6 tham số cũ và các biến thể `six …` cũng **0 hit** ⇒ drift đã được đóng ở cả hai phía (contracts + orchestrator).

---

## 4. Kỳ vọng mới có đúng với sản phẩm không? (kiểm độc lập, không chỉ tin test)

Nếu route **không** thật sự đọc `from`/`to` thì việc sửa test sẽ là 'test tự chiều'. Đã kiểm ngược bằng probe riêng trên **source TS hiện tại**:

- `parseOperationsListQuery` (`list-query.ts:279-282`) parse `from`/`to` qua `parseOperationsListTimeBound` (dùng `isAdminListTimeBound`), và ném **422** khi `from` sau `to` (`compareAdminListTimeBounds`) ⇒ fixture `from=2026-10-10` / `to=2026-10-10` (date-only) **thật sự bị từ chối**.
- Bound hợp lệ round-trip: `from=2026-10-10T00:00:00Z&to=2026-10-10T23:59:59Z` → `{from, to}` giữ nguyên trong query đã parse.
- Range đảo → **422**; tham số lạ (`page`, `offset`, `order_by`) → **bị bỏ qua**, không 422.
- Tầng SQL áp predicate thật: `list-query.ts:410-411` `created_at >= $n::timestamptz` / `created_at <= $n::timestamptz`.

⇒ Kết luận: **sản phẩm đúng, test cũ stale** — bản sửa đưa test về đúng thực tế, không phải hạ thấp tiêu chuẩn.

---

## 5. GAP / open items

1. **Chưa có bằng chứng HTTP/live** cho route với `from`/`to` trong lượt này (offline only, đúng ràng buộc). Các suite liên quan khác đã xanh trong batch tôi chạy ở lượt trước (`or10-operations-time-filter` + `admin-operations-sql` + `operations-list-cursor-sort-binding` = 101/101, exit 0) nhưng đó là bằng chứng offline.
2. **File vẫn ` M` chưa commit** ⇒ kết luận gắn revision `3d056544…`; nếu lane khác sửa tiếp, phải chạy lại.
3. **`docs/28` / `docs/35`** (test inventory / acceptance evidence) có thể cần cập nhật trạng thái conformance 19/19 — ngoài lease này, chỉ ghi nhận.
4. **Không có skip nào được thêm**, nhưng cũng **không có test mới**: bản sửa chỉ làm test cũ phản ánh đúng contract 8 tham số; độ phủ wiring của `from`/`to` dựa vào fixture date-only (1 case/tham số) — muốn chắc hơn nữa thì nên có thêm case bound hợp lệ + range đảo ở tầng conformance (hiện đã có ở suite route riêng `or10-operations-time-filter`).

---

## 6. Xác nhận

- Chỉ **đọc** + chạy jest/tsc/probe offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 6 file raw trong `coordination/reports/raw/verify-orchestrator-operations-conformance-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`, nạp source TS của contracts + route; không bind cổng, không mạng.
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Mọi kết luận gắn sha256 tại §1; file trong lease **chưa commit** nên kết quả chỉ đúng cho revision đã ghi.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
