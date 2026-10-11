# Verify độc lập (DSH2) — SEC-OR-04 fix trong packages/egress — 2026-10-11

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `orchestrator/packages/egress/**`.
**Tuân thủ COORDINATOR-CONTRACT:** chỉ **đọc** + chạy test/probe offline; **KHÔNG** sửa mã/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** mạng ngoài (chỉ loopback); receipt **0 ký tự nháy kép** (tự đếm, §6).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (khớp `engines` của package).
**Đối tượng:** `packages/egress/src/pinned-fetch.ts` (sha256 `8fd4b2116e868338ff150a69f51bf762ac5a4ce88bebfa823589625c48d4543a`, 453 dòng, ` M`, mtime 00:23:02) — bản đã sửa so với revision mà review SEC-OR-20261011-04 đã đọc (`aeae34a7…377e`, 425 dòng).
**Raw:** `coordination/reports/raw/verify-sec-04-pinned-fetch-2026-10-11/DSH2/` — `01-pnpm-test.log`, `02-probe-stdout.log`, `03-probe-stderr.log`, `04-old-crash-script-stdout.log`, `05-old-crash-script-stderr.log`, `06-egress-typecheck.log`, `07-probe.cjs`, `SHA256SUMS.txt`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| `pnpm --dir orchestrator/packages/egress test` | **35 tests PASS, exit 0** — `Test Suites: 3 passed, 3 total` · `Tests: 35 passed, 35 total` · `Snapshots: 0` · 3.239 s |
| Bounds/handling 204 / 205 / 304 | **ĐÚNG** — cả ba resolve với **body null**, không throw, tiến trình sống |
| Bounds/handling HEAD | **ĐÚNG** — HEAD resolve `status 200`, **body null** |
| Regression body thường | **KHÔNG có** — 200 body vẫn stream **byte-equal** (56 ký tự) |
| Socket sau nhánh null-body | **DRAIN, không treo** — 204 rồi 200 trên cùng client đều hoàn tất |
| Bound timeout/abort | **GIỮ NGUYÊN** — response treo bị reject sau ~201 ms (`TimeoutError`) |
| **Đối chứng trước/sau bằng chính script cũ** | **ĐÃ SỬA**: cùng script (sha256 `a36eab83…`) trước đây **exit 1 + TypeError** nay **exit 0** + `CALLER_CAUGHT_NOTHING status=204` + `PROCESS_SURVIVED`, stderr rỗng |
| Typecheck package | **exit 0**, 0 diagnostics |
| Probe độc lập của tôi | **7/7 PASS**, exit 0, stderr rỗng |

**Một dòng cho coordinator:** SEC-OR-04 **đã được sửa đúng và kiểm chứng độc lập** — `pnpm test` cho **35/35** exit 0, cả 204/205/304/HEAD trả body null và không còn giết tiến trình (script crash cũ nay exit 0), body 200 không hồi quy, timeout vẫn giữ.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `pnpm --dir orchestrator/packages/egress test` (`du-rework`) | **0** | `PASS` ×3 suite · `Test Suites: 3 passed, 3 total` · `Tests: 35 passed, 35 total` · `Snapshots: 0 total` · `Time: 3.239 s` |
| 2 | probe độc lập của tôi (`07-probe.cjs`, tiến trình riêng, loopback) | **0** | `PROBE_RESULT 7/7 checks passed` · `PROCESS_SURVIVED` · stderr **rỗng** |
| 3 | **script crash cũ** (`raw/verify-orchestrator-security-2026-10-11/DSH2/05-crash-204.cjs`, sha256 `a36eab83…`) chạy lại | **0** | `CALLER_CAUGHT_NOTHING status=204` · `PROCESS_SURVIVED` · stderr rỗng — trước đây cùng script là **exit 1** + `TypeError: Response constructor: Invalid response status code 204` |
| 4 | `tsc --noEmit -p tsconfig.json` (`packages/egress`) | **0** | 0 dòng output |

Artifact:

| File | sha256 | mtime | lines | git |
|---|---|---|---|---|
| `src/pinned-fetch.ts` | `8fd4b2116e868338ff150a69f51bf762ac5a4ce88bebfa823589625c48d4543a` | 00:23:02 | 453 | ` M` |
| `src/index.ts` (barrel) | `53d74040f273de966bdf1142d22d372855c19551f8816d82f184e0f6929e1940` | 10-07 04:30:17 | 9 | **sạch** |
| `tests/egress-boundaries.boundary.test.ts` | `e3a11944afee30f209e006384126d363923e593f6bac67e53549e57892cb219a` | 00:23:11 | 233 | ` M` |
| `tests/egress-ssrf-deny-matrix.boundary.test.ts` | `55e7ff5e6fdb972218342546ac9faf4c3a19fd69ec5ca1b42438577dca46db6d` | 10-07 10:48:40 | 102 | **sạch** |
| `tests/egress-ssrf-redirect-matrix.boundary.test.ts` | `262b09fe93b0a5a793804f8d9c3dff10df77e19976ad92c047720c79fe906ead` | 10-07 10:48:40 | 107 | **sạch** |

---

## 2. Code audit — từng khuyến nghị của SEC-04 đã được thực hiện

| Khuyến nghị trong review | Trạng thái | Bằng chứng (`pinned-fetch.ts`) |
|---|---|---|
| Dùng **body null** cho null-body status | **ĐÃ LÀM** | `:358` `hasNoBody = requestMethod.toUpperCase() === 'HEAD' \|\| [204, 205, 304].includes(responseStatus)`; `:370` `fulfill(new Response(null, responseInit))` |
| Xử lý **HEAD** đúng | **ĐÃ LÀM** | `:358` (HEAD vào cùng nhánh null-body); `requestMethod` định nghĩa ở `:280` (`init?.method ?? 'GET'`) |
| **Drain/destroy** stream hợp lý | **ĐÃ LÀM** | `:363-368` gắn `once('error')` → clear deadline timer, gỡ listener abort, `req.destroy()`, `reject(err)`; `:369` `response.resume()` để nhả socket |
| Bọc đoạn dựng Response trong callback và **chuyển lỗi thành reject** | **ĐÃ LÀM** | `:352` mở `try`; `:376-378` `catch (err) { failResponse(response, err); }`; thêm `.catch((err) => failResponse(res, err))` ở `:342` và try/catch ở `:346-348` |
| Mọi lỗi transport chỉ kết thúc request/delivery | **ĐÃ LÀM** | `failResponse` (`:403-412`) clear timer, gỡ listener, `response.destroy()` + `req.destroy()`, rồi **`reject(err)`** (không ném) |

⇒ Cả **4** mục sửa mà review đề xuất đều hiện diện; không có nhánh nào còn dựng `Response` với body cho status không cho phép body.

---

## 3. Bounds/handling — kiểm bằng probe độc lập (7/7)

| Check | Kết quả đo |
|---|---|
| S204 | `status=204`, **`body=null`**, không throw, tiến trình sống |
| S205 | `status=205`, **`body=null`** |
| S304 | `status=304`, **`body=null`** |
| HEAD | `status=200`, **`body=null`** (không giao stream cho caller) |
| Body thường | 200 → `response.text()` **byte-equal** payload 56 ký tự (không hồi quy) |
| Socket sau null-body | 204 rồi 200 trên cùng client đều hoàn tất ⇒ nhánh null-body **drain** thay vì treo socket |
| Timeout | response treo bị reject sau **~201 ms** (`timeoutMs: 200`) ⇒ bound thời gian giữ nguyên |

**Đối chứng trước/sau (mạnh nhất):** tôi chạy lại **nguyên script crash** đã dùng ở lượt verify SEC-04 trước (sha256 không đổi `a36eab830a983810…`): trước là `exit code 1` + `TypeError` + `try/catch` của caller không chạy; nay là `exit code 0` + `CALLER_CAUGHT_NOTHING status=204` + `PROCESS_SURVIVED` + stderr rỗng. Cùng một script, cùng một upstream 204, chỉ khác revision sản phẩm ⇒ chứng minh trực tiếp việc sửa có hiệu lực.

---

## 4. Vì sao `pnpm test` báo 35 test (và con số đó có nghĩa gì)

- Đếm tĩnh: `egress-boundaries` 11 + `egress-ssrf-deny-matrix` 4 + `egress-ssrf-redirect-matrix` 4 = **19 khai báo** `it(`/`test(`.
- Runner báo **35 test** vì mỗi file có **một vòng `for (const … of MATRIX)`** bọc khai báo test (ví dụ `egress-ssrf-deny-matrix.boundary.test.ts:62` `for (const vector of DENY_MATRIX) { it('[LOCK] hostname resolving to …') }`) ⇒ ma trận SSRF nở ra thành nhiều test. 19 khai báo → 35 test thực thi.
- Test mới cho fix này: `egress-boundaries.boundary.test.ts:106` `[LOCK] null-body statuses and HEAD responses resolve with a null body` (vòng `[204, 205, 304]` + HEAD, assert `body` **null** ở `:126`); bound timeout vẫn được pin riêng ở `:156` `[LOCK] timeoutMs destroys the socket and rejects TimeoutError before headers`.
- **Nhắc lại cái bẫy đếm tĩnh:** kiểm số test bằng literal của runner (`Tests: 35 passed`), không bằng đếm `it(`.

---

## 5. GAP / open items

1. **Offline only:** mọi thứ chạy trên loopback + source TS hiện tại; **không** chứng minh hành vi trên deployment/upstream thật, không đo socket reuse ở tầng OS, không kiểm HTTP/2 hay proxy.
2. **`pinned-fetch.ts` đang ` M`** (chưa commit) ⇒ kết luận gắn sha256 `8fd4b211…`; nếu lane khác sửa tiếp, phải chạy lại `pnpm test` + probe này.
3. **Nhánh lỗi `failResponse`** được xác nhận bằng **đọc code** + test của suite (timeout/abort/destroy), **không** bằng cách cưỡng bức constructor ném lỗi cho status có body — đường đó hiện không còn khả năng chạm tới qua status hợp lệ, nên đây là giới hạn của probe (không phải lỗ hổng đã biết).
4. **Chưa xác minh trên image** đang triển khai — đúng như review tự giới hạn ở finding gốc.
5. **Barrel `src/index.ts` không đổi** ⇒ fix nằm trọn trong `pinned-fetch.ts` + test, không đổi bề mặt export.

---

## 6. Xác nhận

- Chỉ **đọc** + chạy `pnpm test`/`tsc`/probe offline; **không** sửa mã sản phẩm/test/config/docs; **không** `git add`/commit/push; **không** tick gate; không DB/Redis/S3/Vault; không mạng ngoài (probe chỉ bind loopback tạm và đóng trong tiến trình).
- File tôi tạo: receipt này + 7 file raw trong `coordination/reports/raw/verify-sec-04-pinned-fetch-2026-10-11/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`.
- Tự kiểm theo COORDINATOR-CONTRACT: **0 ký tự nháy kép** (đếm bằng mã hoá ký tự), **0 dòng trailing whitespace**; không hành động ghi nào ngoài `coordination/reports/**`.
