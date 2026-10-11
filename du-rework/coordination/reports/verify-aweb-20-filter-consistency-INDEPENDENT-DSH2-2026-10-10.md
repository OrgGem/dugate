# Verify độc lập (DSH2) — AWEB-20 filter consistency + reset cursor — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY**: `apps/admin-web/src/features/operations/{state.ts, operations-screen.tsx}`, `apps/admin-web/tests/operations-state.test.mjs` (mở rộng đọc sang route `list-query.ts` để kiểm premise, và harness operations để xem có chạm được không).
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/typecheck offline; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** DB/Redis; **KHÔNG** browser/Playwright.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`) · ambient `NODE_ENV=production`.
**Raw:** `coordination/reports/raw/verify-aweb-20-filter-consistency-2026-10-10/DSH2/` — `01-admin-web-node-test.log`, `02-operations-jest-batch.log`, `03-dsh2-probe.log`, `04-operations-state-3runs.log`, `05-admin-web-typecheck.log`, `06-dsh2-probe.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `coordination/reports/receipt-aweb-20-filter-consistency-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| **Lỗi thật (đổi tenant toàn cục giữ cursor cũ)** | **CÓ THẬT** — premise đúng: token cursor chỉ mang `ts\|id\|sort\|dir` (`list-query.ts:155-159`) và route chỉ chặn **sai sort** (`:303-308`) ⇒ cursor của tenant A được chấp nhận cho tenant B |
| **Bản sửa (fingerprint + một điểm vào `applyCursor` + effect bỏ cursor)** | **ĐÚNG và phủ hết** — probe độc lập **13/13**: mọi trường shaping đổi fingerprint, cursor không nằm trong fingerprint của chính nó, 8 đường gán cursor đều qua `applyCursor`, `setCursor` chỉ còn 3 lần xuất hiện (khai báo + 2 call) |
| **Bounds giữa state/tenantId/id/from/to/limit** | **KHỚP WIRE** — probe A2 kiểm bất biến *đổi query ⇔ đổi population* cho từng trường; đúng **một** bất đối xứng lành tính (`ALL` vs rỗng) |
| **Test mới** | **22/22 PASS × 3 lần liên tiếp**, exit 0, digest 3 file **y hệt trước/sau** (khớp §5.3 receipt) |
| **Digest §8 của receipt** | **KHỚP CHÍNH XÁC CẢ 3 sha256** — không có writer nào chạm vào giữa |
| **Toàn bộ test admin-web + typecheck** | **PASS** — `node --test` 3 file: `34 passed`; `tsc --noEmit`: exit 0 |
| **Jest operations batch (bổ sung của tôi)** | 9/10 suite PASS; 1 suite đỏ là **2 test stale đã biết của AWEB-20a** (`W-CONTRACT-ALIGN-1`), không phải hồi quy mới |
| **Mutation 'bỏ tenant khỏi fingerprint' (§5.2 receipt)** | **KHÔNG chạy được** (read-only) — tôi kiểm tính load-bearing bằng cách khác: population A≠B và `operationsCursorIsStale` bật; hai test mà receipt nêu đúng là hai test phụ thuộc tenant (đọc trực tiếp) |
| **Quan sát còn lại (mới)** | Trên đường **đổi tenant**, effect `load` được khai báo **trước** effect reset ⇒ vẫn có **1 request mang cursor cũ** được gửi đi; trang cuối vẫn đúng nhờ guard `listRequest` (§5) |

**Một dòng cho coordinator:** AWEB-20 **đạt verify độc lập ở phạm vi offline** (13/13 probe + 22/22 × 3 + tsc 0, digest khớp receipt); còn **một quan sát MEDIUM-LOW**: đường tenant vẫn phát sinh 1 request với cursor cũ trước khi effect reset chạy — kết quả hiển thị đúng nhờ sequence guard, nhưng nên dời quyết định stale vào trong `load()` nếu muốn sạch ở tầng request.

---

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `node --test tests/operations-state.test.mjs tests/audit-state.test.mjs tests/trace-state.test.mjs` (`apps/admin-web`) | **0** | `ℹ tests 34` · `ℹ pass 34` · `ℹ fail 0` · 5 suite xanh (operations population fingerprint, operationsCursorIsStale, buildOperationsQuery, audit state, trace state) |
| 2 | `node --test tests/operations-state.test.mjs` × 3 lần liên tiếp | **0/0/0** | `tests 22 · pass 22 · fail 0` mỗi lần; `DIGEST_STABLE=True` |
| 3 | batch 10 suite jest operations (`services/orchestrator`) | **1** | `Test Suites: 1 failed, 9 passed, 10 total` · `Tests: 2 failed, 271 passed, 273 total` — 2 đỏ là `W-CONTRACT-ALIGN-1: the route reads exactly the contract parameter set` (**stale đã biết của AWEB-20a**) |
| 4 | probe độc lập DSH2 (`06-dsh2-probe.cjs`) | **0** | `PROBE_RESULT 13/13 checks passed` |
| 5 | `tsc --noEmit -p tsconfig.json` (`apps/admin-web`) | **0** | 0 dòng output |

**Digest — khớp §8 receipt và ổn định trong cả lượt của tôi:**

| File | sha256 (đo được) | receipt §8 | dòng (tôi / receipt) |
|---|---|---|---|
| `src/features/operations/state.ts` | `ac9e825bc1b40d9c93fc34abe15e8228c1109bd0bc539e9d266b89cdb29dc4d1` | **khớp** | 200 / 200 |
| `src/features/operations/operations-screen.tsx` | `f2ca1c649ef262c715c46bb1620467c6f1d25a3bdb2219f2395bbedce1b522b4` | **khớp** | 912 / 913 |
| `tests/operations-state.test.mjs` | `995cc505234c179869861f1fcde48764468bf29dd250522a9a8fc82bebe23c9d` | **khớp** | 203 / 202 |

Chênh 1 dòng ở hai file là **quy ước đếm** (dòng cuối không newline / `Get-Content` bỏ dòng trống cuối) — **byte khớp tuyệt đối**, nên bằng chứng §5.3 của receipt vẫn hiệu lực trên đúng revision này. `state.ts` ` M` (mtime 22:06:40), `operations-screen.tsx` ` M` (21:57:23), test `??` — đúng như receipt §8 mô tả (provenance bằng sha256 vì file untracked).

---

## 2. Đối chiếu claim của receipt

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Token cursor chỉ mang `createdAt\|id\|sort\|dir`, không mang tenant/state/window/id | **ĐÚNG** | `list-query.ts:155-159` `Buffer.from(`${ts}\|${id}\|${formatOperationsListSort(sort)}${dir}`)` |
| 2 | Route chỉ chặn **sai sort**, không kiểm tenant của token | **ĐÚNG** | `list-query.ts:303-308` chỉ so `decoded.sort.field/direction`; không có nhánh nào so tenant/state/window |
| 3 | Trước khi sửa: `state/limit/id/from/to` có onChange reset cursor, **tenant thì không** | **ĐÚNG (cấu trúc)** | 5 control gọi `applyCursor(null)` trong onChange (`:264, :280, :287, :291, :295`); tenant đến từ `useTenant()` (`:45`) — không có handler nào |
| 4 | `operationsPopulation` gồm state + tenant + id(trim) + from + to + limit | **ĐÚNG** | `state.ts:179-188` join 6 trường bằng `\|`; probe A1/A2 |
| 5 | `operationsCursorIsStale` = cursor còn sống **và** population gốc khác population đang chọn | **ĐÚNG** | `state.ts:194-200`; probe B1 (null / giống / khác / không rõ nguồn gốc / 5 trường) |
| 6 | Cả **8 đường gán cursor** đi qua `applyCursor`; grep `setCursor` còn **3 chỗ** | **ĐÚNG** | probe C1: `setCursor` xuất hiện ở dòng **47** (khai báo), **136** (trong `applyCursor`), **142** (trong effect) — 2 trong đó là call; probe C2: đúng **8** call `applyCursor` (5 filter + Previous + Next + Newest) |
| 7 | 14 test mới, 8 → 22 | **ĐÚNG** | test file: 8 `it(` ở `buildOperationsQuery` + 9 ở `operations population fingerprint` + 5 ở `operationsCursorIsStale` = **22**; 22 − 8 = 14 |
| 8 | §5.3: 3 lần chạy exit 0, digest trước = sau | **TÁI HIỆN** | lệnh #2: `RUN1/2/3_EXIT=0`, `DIGEST_STABLE=True` |
| 9 | §5.4: toàn bộ test admin-web PASS + `TSC=0` | **ĐÚNG** | lệnh #1 (`34 passed`) và #5 (exit 0) |
| 10 | §5.2: mutation bỏ tenant khỏi fingerprint ⇒ **đúng 2** test đỏ, và chỉ hai test đó | **KHÔNG CHẠY ĐƯỢC** (read-only, không được sửa `state.ts`) | Kiểm gián tiếp: hai test được nêu (`changes when tenantId changes`, `drops a cursor minted for another tenant`) đúng là hai test phụ thuộc tenant (đọc `:134-141`, `:172-177`); probe A1/B1 chứng minh **tính load-bearing** của tenant (population A≠B, stale bật) |
| 11 | §4: test `treats an absent tenant and an empty one as the same population` là **bằng tài liệu**, xanh cả khi bỏ tenant | **ĐÚNG** | nếu bỏ tenant khỏi fingerprint thì `null` và `''` vẫn bằng nhau ⇒ test vẫn xanh; tác giả đã tự khai đúng, không đếm nhầm thành test bẫy |
| 12 | §6 DELTA: có lúc `node --test` đỏ vì `operationsPopulation` trả **chuỗi JSON** thay vì `join('\|')`, không phải bản của tác giả | **KHÔNG KIỂM ĐƯỢC** (sự kiện quá khứ, không có log) | Bản hiện tại đúng là `join('\|')` với `tenantId ?? ''` (`state.ts:180-187`) — khớp mô tả; digest ổn định trong lượt của tôi ⇒ không có writer nào chạm vào giữa lượt này |
| 13 | §7: không chạy UI thật, không gọi API thật | **ĐÚNG** | lượt của tôi cũng vậy (xem §5 về hệ quả) |

---

## 3. Bounds giữa state/tenantId/id/from/to/limit — kiểm độc lập

**Bất biến tôi tự kiểm (probe A2):** với từng trường, *query đổi ⇔ fingerprint đổi*; riêng `cursor` thì *query đổi nhưng fingerprint **không*** (cursor không được nằm trong population của chính nó).

| Trường | Query wire đổi? | Fingerprint đổi? | Kết luận |
|---|---|---|---|
| `state` `ALL`→`RUNNING` | có (`state=RUNNING`) | có | khớp |
| `tenantId` `tenant-a`→`tenant-b` | có (`tenant=`) | có | khớp — đúng lỗ AWEB-20 |
| `id` `''`→`abc` | có (`id=abc`) | có | khớp |
| `id` `abc`→` abc ` | **không** (trim) | **không** | khớp — gõ thêm khoảng trắng không giết cursor |
| `fromDate` `''`→`2026-10-01` | có (`from=…T00:00:00.000Z`) | có | khớp |
| `toDate` `''`→`2026-10-10` | có (`to=…T23:59:59.999Z`) | có | khớp |
| `limit` `20`→`50` | có | có | khớp |
| `cursor` `null`→`CURSOR` | có | **không** | đúng thiết kế |
| `tenantId` `null`↔`''` | không | không | khớp (probe A4) |

**Bất đối xứng duy nhất (probe A3, lành tính):** `state: 'ALL'` và `state: ''` cho **cùng** query (route bỏ qua cả hai) nhưng **khác** fingerprint ⇒ nếu có đường nào chuyển giữa hai giá trị này, cursor bị bỏ **thừa** một lần. Hướng sai là an toàn (bỏ thừa, không bao giờ bỏ sót); screen khởi tạo `stateFilter = 'ALL'` (`:57`) nên không có đường như vậy trong code hiện tại.

---

## 4. Wiring trong screen — kiểm bằng probe (C1–C5)

- `applyCursor` (`:134-137`): gán `mintedPopulation.current = next === null ? null : selectedPopulation` rồi `setCursor(next)`; `useCallback` phụ thuộc `selectedPopulation` ⇒ không bao giờ ghi nhớ population cũ.
- Effect reset (`:139-144`): `operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation)` → xoá **cả** `mintedPopulation.current` và `cursor`; deps `[cursor, selectedPopulation]` ⇒ chạy đúng khi population hoặc cursor đổi, và không có vòng lặp (`cursor = null` ⇒ stale = false).
- `selectedPopulation` (`:125-132`): đúng 6 trường, **không** có `cursor` (probe C5).
- 8 đường gán: 5 filter + Previous (`:433`) + Next (`:434`) + Newest (`:435`) — probe C2 khớp từng anchor.

---

## 5. Quan sát còn lại (mới, MEDIUM-LOW) — thứ tự effect trên đường đổi tenant

**Chuỗi thực tế (đọc code, không chạy được React ở đây):**
1. Operator đổi tenant ở selector toàn cục ⇒ `globalTenantId` đổi.
2. Render N: `cursor` **vẫn** là token cũ (state), `selectedPopulation` đã là tenant mới, `mintedPopulation.current` là tenant cũ.
3. Effect chạy theo **thứ tự khai báo**: effect `load` (`:117-119`) **trước**, effect reset (`:139-144`) **sau** (probe D1: byte 5494 < 6302).
4. ⇒ `load()` ở render N đọc `cursor` từ state (`:100`) và **gửi 1 request mang cursor cũ** cho tenant mới — đúng cơ chế seek sai mà task này nhắm vào.
5. Effect reset chạy ngay sau đó ⇒ `cursor = null` ⇒ render N+1 ⇒ `load` đổi identity (vì `cursor` nằm trong deps `:115`) ⇒ request thứ hai với `cursor = null` ⇒ trang 1 của tenant mới.
6. **Trang cuối vẫn đúng** vì `load` có guard sequence: `const seq = ++listRequest.current` (`:88`) và `if (seq !== listRequest.current) return;` (`:104`) ⇒ response của request cursor-cũ (seq cũ hơn) bị **bỏ**, không ghi vào state (probe D2).

**Đánh giá:** không phải lỗi hiển thị (không có hàng nào bị bỏ/lặp trên UI), nhưng là **1 request thừa mang vị trí sai** cho mỗi lần đổi tenant, và tính đúng lúc đó **phụ thuộc vào sequence guard** chứ không phụ thuộc quy tắc cursor. Hai cách làm sạch (đề xuất, ngoài lease này):
- dời quyết định stale **vào trong `load()`** (nếu `operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation)` thì truyền `null` cho `buildOperationsQuery`), hoặc
- xoá cursor **đồng bộ trong lúc render** khi population đổi (derived state / `key` remount) thay vì chờ effect.

**Vì sao không kết luận nặng hơn:** các đường filter cục bộ (state/limit/id/from/to) gọi `applyCursor(null)` **ngay trong onChange** ⇒ cùng một batch ⇒ render kế tiếp đã có `cursor = null`, nên **không** phát sinh request cursor-cũ. Chỉ đường tenant (không có handler) mới đi qua khe này — tức bản sửa đã thu hẹp hệ quả từ *trang sai* xuống *một request bị bỏ*.

---

## 6. GAP / open items

1. **Chưa có bằng chứng runtime/browser** cho effect + ref (receipt §7.1 đã tự khai). Quan sát §5 là hệ quả trực tiếp của việc đó: nó chỉ lộ ra khi chạy React thật. Đề nghị một lượt harness/browser có **đổi tenant** để đếm số request và xác nhận chỉ request cuối ghi state.
2. **Harness hiện có không chạm được kịch bản này**: `tests/operations-timeline-filters-offline.cjs:83` stub `useTenant` bằng một tenant **cố định** ⇒ không thể đổi tenant. Cần mở rộng stub (lease khác) nếu muốn phủ.
3. **Mutation §5.2 chưa được kiểm độc lập** (tôi không được sửa `state.ts`); tính load-bearing của tenant đã được chứng minh bằng probe A1/B1.
4. **`state 'ALL'` vs rỗng** là bất đối xứng lành tính (bỏ thừa cursor) — chỉ cần biết, không cần sửa; nếu muốn khít tuyệt đối thì chuẩn hoá `state === 'ALL' ? '' : state` khi dựng fingerprint.
5. **2 test đỏ ở `operations-list-contract-conformance.test.ts`** vẫn treo từ AWEB-20a (stale kỳ vọng 6 tham số) — không thuộc AWEB-20, nhưng nếu coordinator chạy batch operations sẽ gặp; nên tách thành task riêng.
6. **Không debounce cho ô `id`** (mỗi ký tự gọi API) — receipt §7.5 đã khai là tình trạng có trước, ngoài phạm vi.

---

## 7. Xác nhận

- Chỉ **đọc** + chạy `node --test`/jest/tsc/probe offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 6 file raw trong `coordination/reports/raw/verify-aweb-20-filter-consistency-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`, nạp **chính source TS** của `state.ts`; không bind cổng, không mạng.
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Ghi chú trung thực về chính lượt này: probe của tôi có **2 FAIL ở lượt đầu** — cả hai do regex đếm của tôi (`setCursor(` chỉ khớp 2 call, còn khai báo là `setCursor]`; `applyCursor(` chỉ khớp 8 call, không có dòng khai báo). Đã sửa **probe** (không sửa sản phẩm) và chạy lại: **13/13**.
- Mọi kết luận gắn sha256 tại §1; ba file trong lease đều **chưa commit** nên kết quả chỉ đúng cho revision đã ghi.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
