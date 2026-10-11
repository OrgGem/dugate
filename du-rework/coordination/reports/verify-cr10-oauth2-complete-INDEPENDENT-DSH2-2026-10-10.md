# Verify độc lập (DSH2) — CR10-03/04 OAuth2 token acquisition completion — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY**: `services/orchestrator/src/modules/webhooks/oauth2-client.ts`, `packages/egress/src/pinned-fetch.ts`, `tests/cr10-oauth2-body-and-egress.test.ts`, `tests/cr10-oauth2-stream-bounds.test.ts` (mở rộng đọc sang route/detail mà typecheck chạm, và docs mà receipt nêu).
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/typecheck offline; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** DB/Redis; **KHÔNG** IdP thật / mạng ngoài (chỉ loopback).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`) · ambient `NODE_ENV=production`.
**Raw:** `coordination/reports/raw/verify-cr10-oauth2-complete-2026-10-10/DSH2/` — `01-oauth2-regression.log`, `02-egress-regression.log`, `03-egress-typecheck.log`, `04-orchestrator-typecheck.log`, `05-dsh2-probe.log`, `06-dsh2-probe.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `coordination/reports/receipt-cr10-oauth2-complete-2026-10-10.md` (+ raw gốc `raw/cr10-oauth2-complete-2026-10-10/`).

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| **Regression receipt nêu** (9 suite/111 test; egress 3/34) | **TÁI HIỆN ĐÚNG TỪNG CON SỐ** — exit 0 cả hai |
| **Typecheck egress** | **ĐÚNG** — exit 0, không output |
| **Typecheck orchestrator** (receipt ghi exit 2, `admin.ts:644,733 Expected 4 arguments, but got 5`) | **KHÔNG TÁI HIỆN ĐƯỢC** — hiện exit **0**, không output; `admin.ts` đã được lane khác viết lại lúc `22:14:26` (trước khi log typecheck `22:14:29` được ghi) và giờ 5-arg đi vào hàm tenant-scoped riêng (§5) |
| **CR10-03: một deadline duy nhất phủ secret + retry + backoff + DNS/transport + headers + body** | **ĐÚNG** — code + probe A6/A7/A8 (bị cắt bởi deadline, **không** retry, provider nhận signal đã abort) |
| **CR10-03: byte cap theo từng chunk, không drain EOF** | **ĐÚNG** — probe A1/A2/A3 (đúng cap nhận, vượt 1 byte bị từ chối **tại chunk đó**, `content-length` thấp hơn thực tế không cứu được) |
| **CR10-03: body không có reader an toàn thì fail-closed, không gọi `text()`** | **ĐÚNG** — probe A4/A5 (`text()` không bao giờ được gọi; body null = rỗng) |
| **CR10-04: DNS race với abort; kiểm abort trước khi chuẩn bị request/mở socket** | **ĐÚNG** — probe B1/B2 (abort thắng resolver 250 ms sau ~33 ms) + code `:225, :244-246, :263, :273` |
| **CR10-04: mọi DNS answer được adjudicate theo **tập**, địa chỉ đã duyệt là địa chỉ được dial** | **ĐÚNG** — probe B3 (4 tập bị từ chối trước khi connect) + B4 (dial loopback, `Host` giữ nguyên tên miền) |
| **CR10-04: redirect không bao giờ được follow** | **ĐÚNG** — probe B5 (302 trả nguyên trạng, `requests=1`) |
| `git diff --check` trên 5 path receipt nêu | **ĐÚNG** — exit 0 |
| **Probe độc lập của tôi** | **14/14 checks passed**, exit 0 |

**Một dòng cho coordinator:** CR10-03/04 **đạt verify độc lập ở phạm vi offline** (14/14 probe + 9/111 + 3/34 + typecheck egress 0); **orchestrator typecheck hiện đã xanh** nên dòng 'exit 2' trong receipt là ảnh chụp giữa-edit đã hết hiệu lực; ba quan sát nhỏ (message deadline có 2 biến thể, cancel là fire-and-forget, mã lỗi redirect khác nhau theo transport) — không có defect nào được chứng minh.

---

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh (cwd) | Exit | Literal | Khớp receipt? |
|---|---|---:|---|---|
| 1 | batch 9 suite: `cr10-oauth2-body-and-egress` + `cr10-oauth2-stream-bounds` + `cb-03-outbound-auth` + `cb-02-webhook-result-delivery` + `cb02c-retry-callback-pin` + `cb02-admission-writer` + `cb02b-profile-publish-callback` + `cb03-composition-resolver` + `vfy-cb01-dispatch-matrix` (`services/orchestrator`) | **0** | `Test Suites: 9 passed, 9 total` · `Tests: 111 passed, 111 total` · `Time: 9.315 s` | **khớp** |
| 2 | egress 3 suite: `egress-ssrf-redirect-matrix.boundary` + `egress-ssrf-deny-matrix.boundary` + `egress-boundaries.boundary` (`packages/egress`) | **0** | `Test Suites: 3 passed, 3 total` · `Tests: 34 passed, 34 total` | **khớp** |
| 3 | `tsc --noEmit -p tsconfig.json` (`packages/egress`) | **0** | 0 dòng output | **khớp** |
| 4 | `tsc --noEmit -p tsconfig.json` (`services/orchestrator`) | **0** | 0 dòng output | **KHÔNG khớp** — receipt ghi exit 2 (§5) |
| 5 | probe độc lập DSH2 (`06-dsh2-probe.cjs`) | **0** | `PROBE_RESULT 14/14 checks passed` | bổ sung |
| 6 | `git diff --check` trên 5 path receipt nêu | **0** | không output (chỉ warning CRLF của docs) | **khớp** |

Raw gốc của receipt **tồn tại và đúng nội dung đã công bố**: `oauth2-regression.log` (`9 passed`/`111 passed`), `egress-regression.log` (`3 passed`/`34 passed`), `egress-typecheck.log` (rỗng), `orchestrator-typecheck.log` (`admin.ts(644,9): error TS2554: Expected 4 arguments, but got 5.` + dòng 733 tương tự) — tôi đã đọc lại 4 file này, không chỉ tin phần chữ trong receipt.

Artifact đã kiểm (sha256 · mtime · git):

| File | sha256 | mtime | lines | git |
|---|---|---|---|---|
| `services/orchestrator/src/modules/webhooks/oauth2-client.ts` | `ee61663b…033b` | 22:13:42 | 662 | ` M` |
| `packages/egress/src/pinned-fetch.ts` | `aeae34a7…377e` | 22:05:07 | 425 | ` M` |
| `services/orchestrator/tests/cr10-oauth2-body-and-egress.test.ts` | `495746ea…1808` | 12:37:05 | 402 | `??` |
| `services/orchestrator/tests/cr10-oauth2-stream-bounds.test.ts` | `118bb9e9…b4f` | 22:13:49 | 555 | `??` |
| `packages/egress/src/index.ts` | `53d74040…1940` | 10-07 04:30:17 | 9 | sạch (không đụng barrel) |
| `services/orchestrator/src/http/routes/admin.ts` | `4f515649…c98e` | 22:14:26 | 1161 | ` M` |
| `docs/19`, `docs/28`, `docs/35` | `cbe3fc64…`/`ba6f49df…`/`c94c00fc…` | 22:12–22:14 | — | ` M` (owner notes; tôi **không** thẩm định nội dung) |

---

## 2. CR10-03 — đối chiếu claim với code và hành vi đo được

| # | Claim của receipt | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Một acquisition deadline tạo **trước** khi resolve client secret | **ĐÚNG** | `acquire()` `:443-450` tạo `createAcquisitionDeadline(this.timeoutMs)` rồi race + `dispose()` trong `finally`; `requestToken()` `:472-475` resolve secret **bên trong** deadline |
| 2 | Cùng một signal + deadline phủ secret, mọi attempt, retry backoff, DNS/transport, headers, mọi lần đọc body | **ĐÚNG** | secret: `:474` (race + truyền `deadline.controller.signal`); transport: `:527-538` (`signal`, race, và `releaseLateResponse` huỷ response đến muộn); body: `:570` race **từng** `reader.read()` |
| 3 | Timeout dừng các retry sau đó | **ĐÚNG** | `:461` `if (deadline.timedOut || !isRetryable(error) || attempt >= maxAttempts) break;`; probe A6/A8: `attempts=1` |
| 4 | Secret provider nhận abort signal | **ĐÚNG** | `:636-639` `provider(signal)`; probe A7: `resolverSignal.aborted === true`, `fetchCalls === 0` |
| 5 | Byte limit **tăng dần theo từng chunk** | **ĐÚNG** | `:573-577`: cộng `chunk.byteLength` rồi ném `TOKEN_RESPONSE_TOO_LARGE` **trước khi** push chunk vượt; probe A1 (cap 42 nhận / cap 41 từ chối), A2 (43 chunk 1 byte → từ chối tại chunk vi phạm), A3 (`content-length: 5` nhưng body 43 byte → vẫn từ chối) |
| 6 | Response không có body đọc theo chunk thì fail-closed, **không** gọi `response.text()` | **ĐÚNG** | `:561-564` (`typeof body.getReader !== 'function'` → `cancelResponse` + `TOKEN_RESPONSE_INVALID`); probe A4: `textCalled === false` |
| 7 | Body null = rỗng | **ĐÚNG** | `:560` `if (!body) return '';`; probe A5 (đi tiếp vào parse JSON và bị từ chối `not valid JSON`, không gọi `text()`) |
| 8 | Từ chối sớm (status / content-type / content-length) huỷ body | **ĐÚNG** | `:498-511` gọi `cancelResponse(response)` trước mỗi `invalid(...)`; helper `cancelResponse` `:227-234` bọc try/catch, không ném |
| 9 | Stream cleanup **không chặn** việc trả lỗi timeout/size | **ĐÚNG** | `:586-588` `finally { void cancelQuietly(reader); }` — không `await`; probe A2/A3/A6 đo được cancel đến **sau** khi lỗi đã nổi lên (tôi phải chờ 1 nhịp mới quan sát được, xem §6) |
| 10 | Tách `parseTokenResponse()` để giữ **một** phạm vi deadline | **ĐÚNG** | `:592-634` là hàm thuần, không tạo deadline/không I/O |
| 11 | Không đổi union mã lỗi | **ĐÚNG** | `:118-126` vẫn 8 mã cũ; `TOKEN_RESPONSE_TOO_LARGE` và `TOKEN_ENDPOINT_DENIED` đã có từ trước |

---

## 3. CR10-04 — đối chiếu claim với code và hành vi đo được

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Transport pinned race DNS với abort signal của request | **ĐÚNG** | `resolveUntilAbort` (`:58-95`): pre-check `signal.aborted` (`:64`), listener `once` + cờ `settled`, gỡ listener ở cả 3 nhánh; dùng ở `:244`. Probe B2: abort ở 25 ms thắng resolver 250 ms (AbortError sau ~33 ms) |
| 2 | Kiểm abort **trước khi** chuẩn bị request / mở socket | **ĐÚNG** | `:225` (ngay sau khi parse URL), `:263` (sau DNS, trước `prepareBody`), `:273` (sau `prepareBody`, trước `http(s)Request`) |
| 3 | Mọi DNS answer được adjudicate **theo tập** | **ĐÚNG** | `:255-259`: `answers.every(isDestinationAddressAllowed)` khi `NEEDS_RESOLUTION`, và `answers.length === 0` → deny. Probe B3: private-only, mixed public+private, link-local metadata, rỗng — **cả 4** bị `DestinationDeniedError` trước khi connect |
| 4 | Địa chỉ đã duyệt **là** địa chỉ được dial (không re-resolve) | **ĐÚNG** | `:237-265`: `candidates` = chính các answer đã adjudicate, dedup, IPv4 ưu tiên; `attemptOne(dialHost)`. Probe B4: resolver trả `127.0.0.1`, server loopback nhận request với `Host: pinned.example:<port>` |
| 5 | Credential không tự động đi qua redirect | **ĐÚNG (hai tầng)** | oauth2-client gửi `redirect: 'error'` (`:531`); pinned-fetch **không bao giờ** follow (comment `:296-301`, tự adjudicate hop nếu caller tự xử). Probe B5: 302 trả nguyên trạng, `requests === 1` |
| 6 | `DestinationDeniedError` → `TOKEN_ENDPOINT_DENIED`, message không chứa secret | **ĐÚNG** | `:543-545`; test `:536` của suite stream-bounds có case riêng cho điều này |
| 7 | Mặc định production là pinned fetch (không global fetch) | **ĐÚNG** | `:390-397` `this.fetchImpl = options.fetchImpl ?? createPinnedFetch({...})` với `allowHosts`/`allowPrivateNetworks`/`resolve` |

---

## 4. Bounds — hai trục được kiểm độc lập

| Trục | Kết quả đo | Ghi chú |
|---|---|---|
| **Timeout** | A6: body không bao giờ kết thúc → cắt ở ~65 ms (timeout 60 ms), `attempts=1`, reader bị cancel. A8: backoff 500 ms với timeout 60 ms → cắt ở ~68 ms, `attempts=1` (không nhân deadline theo attempt). A7: secret resolver treo → **0** fetch, provider signal aborted | deadline là **một** cho cả chuỗi |
| **Byte cap** | A1: đúng cap (42) nhận, cap 41 từ chối. A2: 43 chunk × 1 byte → từ chối **tại chunk vi phạm**, `attempts=1`, cancel=1. A3: header `content-length: 5` + body 43 byte → từ chối theo accumulator | cap tính bằng **byte đã nhận**, không tin header |
| **Fail-closed body** | A4: body không có `getReader` → `TOKEN_RESPONSE_INVALID`, `text()` **không** được gọi. A5: body null → rỗng → từ chối ở parse JSON, `text()` không được gọi | không có đường buffer toàn bộ |
| **DNS/egress** | B1: signal đã abort → AbortError, resolver **0 lần**. B2: abort trong DNS thắng. B3: 4 tập answer bị từ chối trước connect. B4: dial đúng answer. B5: không follow redirect | biên giới 'policy rồi mới connect' giữ nguyên |

---

## 5. Claim không tái hiện được: typecheck orchestrator

- Receipt ghi: *Latest run exit 2* với `src/http/routes/admin.ts:644,9` và `:733,9` — `error TS2554: Expected 4 arguments, but got 5`. Raw log gốc xác nhận **đúng hai dòng đó** (log `22:14:29`).
- Trên cây hiện tại: `tsc --noEmit -p tsconfig.json` (cwd `services/orchestrator`) → **exit 0, 0 dòng output** (lệnh #4).
- Nguyên nhân, theo dấu vết thời gian (không suy đoán thêm): `admin.ts` được lane khác viết lại lúc **22:14:26** (sha `4f515649…`, 1161 dòng) và hiện tại `:640-642` tách rõ hai nhánh — `loadProfileDetail(db, business, version, name)` 4 tham số cho scope rỗng, và `loadTenantProfileDetail(db, business, version, name, tenantScope)` 5 tham số cho tenant scope. Typecheck của receipt (bắt đầu trước, log ghi lúc 22:14:29) đọc phải revision giữa-edit ⇒ **lỗi đó là race giữa editor và compiler, đã hết hiệu lực**.
- Hệ quả cho coordinator: **không** còn lý do hoãn acceptance của CR10-03/04 vì typecheck; nhưng cũng **không** nên coi dòng đó là 'pre-existing red' — nó thuộc về lane AWEB (detail tenant scope), và lane đó đã sửa xong.

---

## 6. Quan sát (không phải defect — ghi để chính xác hoá)

1. **Message deadline có hai biến thể.** `createAcquisitionDeadline` reject gate bằng `token acquisition exceeded its deadline` (`:197`), còn `fetchTokenResponse`/`readBoundedBody` dùng `token request did not complete within its deadline` (`:541`, `:583-585`) khi **thao tác** quan sát `deadline.timedOut`. Vì `Promise.race` trả về bên nào settle trước, lỗi nổi lên caller có thể là **một trong hai** câu (probe A6–A9 nhận câu của gate). Cả hai đều không chứa secret và cùng mã `TOKEN_REQUEST_FAILED` ⇒ không phải vấn đề, nhưng test nào pin **nguyên văn** một câu sẽ giòn.
2. **Cancel là fire-and-forget có chủ đích.** `void cancelQuietly(reader)` (`:587`) không `await` ⇒ lỗi trả về **trước** khi `cancel()` của underlying source chạy xong. Đây đúng là điều receipt mô tả ('stream cleanup does not block returning the timeout or size failure'), nhưng nó có nghĩa: một test khẳng định `cancels === 1` phải chờ ít nhất một nhịp. Lượt probe đầu của tôi đã fail 2 case vì lý do này (lỗi của probe, không phải của code — xem §7.1).
3. **Mã lỗi khi token endpoint trả 30x khác nhau theo transport.** Với transport inject/undici, `redirect: 'error'` làm fetch **reject** → `TOKEN_REQUEST_FAILED` (`unreachable`); với pinned fetch (mặc định production) 302 được **trả nguyên trạng** → client thấy `status !== 200` → `TOKEN_HTTP_ERROR` (`:498-500`). Cả hai đều fail-closed và **không** forward credential; chỉ khác mã, nên nếu có consumer phân loại theo mã thì cần biết điều này.
4. **`packages/egress/src/index.ts` không đổi** ⇒ thay đổi egress nằm trọn trong `pinned-fetch.ts` (barrel sạch), khớp cách receipt mô tả phạm vi.
5. **Docs (`19`/`28`/`35`) đang ` M`** với mtime 22:12–22:14 — tôi chỉ xác nhận **có** thay đổi và `git diff --check` sạch; **không** thẩm định nội dung owner note (ngoài lease).

---

## 7. Ghi chú trung thực về chính lượt verify này

1. **Probe của tôi có 6 FAIL ở lượt chạy đầu — tất cả là lỗi kỳ vọng của probe, không phải của sản phẩm:**
   - A2/A3: tôi dựng 43 'chunk' nhưng chunk thứ 43 là `TextEncoder().encode(undefined)` → theo spec, tham số mặc định biến nó thành **rỗng**, nên body chỉ 42 byte và hợp lệ; và A3 dùng body **đúng** cap nên được nhận là đúng. Đã sửa thành 43 chunk 1 byte thật / body 43 byte.
   - A6–A9: tôi kỳ vọng nguyên văn `did not complete within its deadline` nhưng nhận câu của **gate** (quan sát §6.1). Đã nới thành khẳng định chứa `deadline`.
   - A2/A3 (lượt hai): cancel chưa quan sát được vì stream tổng hợp đã **closed** trước khi `cancel()` chạy (cancel trên stream đã đóng là no-op theo spec). Đã thêm `keepOpen` để mô phỏng socket còn dữ liệu — đúng hình dạng mà claim 'không drain EOF' nói tới. Tôi cũng viết một script chẩn đoán riêng để chứng minh cancel **có** lan xuống underlying source ở hình dạng stream thường.
2. Vì vậy: **14/14** là kết quả sau khi sửa **probe**, không phải sau khi sửa sản phẩm; mọi sửa đổi chỉ nằm trong `%TEMP%`, không có file nào của repo bị chạm.

---

## 8. GAP / open items

1. **Live gate vẫn mở:** toàn bộ bằng chứng là offline (stream tổng hợp + loopback + resolver tiêm). Chưa có IdP HTTPS thật, chưa có DNS production, chưa có deployment thật ⇒ offline pass **không** thay live/browser/deploy gate (receipt cũng tự ghi đúng điều này).
2. **Suite mới `cr10-oauth2-stream-bounds.test.ts` là file của lane fix (`??`)** — tôi chạy và đọc tên test; nội dung 21 test khớp ma trận receipt (per-chunk cap, stream chết/treo, một deadline, socket thật, DNS sau timeout, không lộ secret).
3. **`admin.ts` + `profile-detail` thuộc lane khác** (tenant scope cho detail read): thay đổi đó làm typecheck xanh trở lại; nếu coordinator cần, nên có một verify riêng cho nhánh tenant-scoped mới (`loadTenantProfileDetail`) — **ngoài** lease CR10 này.
4. **Đề nghị nhỏ cho owner CR10:** hoặc pin **cả hai** biến thể message deadline trong test (nếu test nào đang pin một câu), hoặc thống nhất một câu để tránh giòn (§6.1).

---

## 9. Xác nhận

- Chỉ **đọc** + chạy jest/tsc/probe offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 6 file raw trong `coordination/reports/raw/verify-cr10-oauth2-complete-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`; probe chỉ bind listener loopback tạm và đóng trong `finally`; không gọi mạng ngoài.
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Mọi kết luận gắn sha256 tại §1; `oauth2-client.ts`/`pinned-fetch.ts`/`admin.ts` đều là thay đổi **chưa commit** nên kết quả chỉ đúng cho revision đã ghi.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
