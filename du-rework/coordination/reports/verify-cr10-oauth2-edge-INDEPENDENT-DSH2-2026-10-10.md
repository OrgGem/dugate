# Verify độc lập (DSH2) — CR10-03/04 edge-case suite (`cr10-oauth2-stream-bounds`) — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY**: `services/orchestrator/tests/cr10-oauth2-stream-bounds.test.ts`, `tests/cr10-oauth2-body-and-egress.test.ts`, `src/modules/webhooks/oauth2-client.ts`, `packages/egress/src/pinned-fetch.ts`, harness `tests/harness/network-boundaries/mock-listener.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/typecheck offline; **KHÔNG** sửa source/test/config/docs; **KHÔNG** mutation trên file sống; **KHÔNG** `git add`/commit/push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/IdP thật.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`).
**Raw:** `coordination/reports/raw/verify-cr10-oauth2-edge-2026-10-10/DSH2/` — `01-two-suites-run1.log`, `02-three-runs.log`, `03-tests-typecheck.log`, `04-starvation-probe.log`, `05-starvation.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `coordination/reports/receipt-cr10-oauth2-edge-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| Suite tồn tại đúng như receipt mô tả | **ĐÚNG** — 555 dòng, sha256 `118bb9e9…b4f`, **22 `it(` / 4 `describe`**, **0** `.skip`/`.only`/`todo` |
| Chạy 2 suite × 3 lần | **TÁI HIỆN ĐÚNG** — `2 passed` · `35 passed, 35 total` (22 + 13 companion), exit 0 cả 3 lần |
| Typecheck phần test (package tsconfig **không** phủ) | **ĐÚNG** — `tsconfig.json` có `include: ['src/**/*.ts']`, `exclude: ['tests', …]`; tôi typecheck độc lập **2 suite + harness** bằng CLI (không ghi file nào) → **exit 0, 0 diagnostics** |
| Tính load-bearing của nhóm **byte cap** | **ĐÚNG** — 6 test, mỗi test khẳng định **đúng mã lỗi** + counter witness (`pulls`, `cancels`, `delivered`, `textCalls`), có **negative control** (đúng cap được nhận) |
| Tính load-bearing của nhóm **stream timeout/deadline** | **ĐÚNG** — cửa sổ thời gian thật (100–190 ms phân biệt deadline đơn vs theo-attempt), `attemptCount`, `fetchCalls`, `pulls`, `delivered`; có negative control (stream chậm nhưng hợp lệ vẫn ra token) |
| Tính load-bearing của ca **DNS race** | **ĐÚNG** — resolver do test điều khiển; thả answer **sau** deadline rồi khẳng định `listener.requests === 0` (không mở kết nối) |
| Số test đỏ khi neutralise byte cap (§3 receipt: **6**) | **NHẤT QUÁN** — đúng **6** dòng khẳng định `TOKEN_RESPONSE_TOO_LARGE` (L174/184/195/214/386/530) và **không** test nào khác dùng mã đó; tôi **không** chạy lại mutation (read-only) |
| **F1** (`maxLifetimeSeconds` là knob chết) | **XÁC NHẬN trên revision hiện tại** — chỉ xuất hiện ở khai báo/validate/gán (`:113, :305, :371-373, :405`), **không** nơi nào đọc |
| **F2** (fallback `text()` đọc vô hạn rồi mới kiểm) | **ĐÃ HẾT HIỆU LỰC** — sản phẩm hiện **không có** lời gọi `.text()` nào; nhánh không có `getReader` fail-closed (`:561-564`), và **hai test của suite đã được cập nhật đúng** (`textCalls === 0`). Mô tả trong receipt §1/§4-F2 là ảnh chụp bản cũ |
| Cơ chế starvation ở §5 receipt | **XÁC NHẬN bằng probe riêng** — vòng chỉ-microtask (kể cả `Promise.race` với promise đã settle) **không** cho `setTimeout` chạy; nhường macrotask mỗi pull thì timer chạy (4/4) |

**Một dòng cho coordinator:** suite edge **đạt verify độc lập ở phạm vi offline** — 22 test, 3 lần xanh, typecheck test 0 lỗi, mọi nhóm (cap/deadline/DNS race) đều có assertion cụ thể + negative control, và con số mutation 6 khớp tĩnh; **cần đính chính 2 mục trong receipt**: F2 đã hết hiệu lực và mô tả nhóm `text()` đã cũ, còn số test mang ngữ nghĩa một-deadline là **4** (không phải 3) — tức phần receipt tự nhận 'không sở hữu' đang thiếu một test.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `jest --runInBand --config jest.unit.config.cjs --runTestsByPath tests/cr10-oauth2-stream-bounds.test.ts tests/cr10-oauth2-body-and-egress.test.ts` × **3 lần** (`services/orchestrator`) | **0/0/0** | `PASS` cả 2 suite · `Test Suites: 2 passed, 2 total` · `Tests: 35 passed, 35 total` mỗi lần |
| 2 | `tsc --noEmit` (CLI, 2 suite + `mock-listener.ts`, options mirror `tsconfig.base.json`) | **0** | 0 dòng output — chứng minh phần test **typecheck được** dù package config loại `tests` |
| 3 | probe starvation của tôi (`05-starvation.cjs`) | **0** | `PROBE_RESULT 4/4 checks passed` |
| 4 | đếm khai báo test + quét skip/only | — | `it(=22`, `describe(=4`, `test(=0`, `it.each=0`; `.skip/.only/todo/xit/xdescribe` = **0 hit** |

Artifact đã kiểm (sha256 · mtime · git):

| File | sha256 | mtime | lines | git |
|---|---|---|---|---|
| `tests/cr10-oauth2-stream-bounds.test.ts` | `118bb9e9f3ccca2da4b71d257b13a231e3b128ba0258a079755ee800341f5b4f` | 22:13:49 | 555 | `??` |
| `tests/cr10-oauth2-body-and-egress.test.ts` | `495746ead6798e560e208b9fa7774b9ff078fb7bff6ddb224979fb99b47e1808` | 12:37:05 | 402 | `??` |
| `src/modules/webhooks/oauth2-client.ts` | `ee61663b47bd8a0d60ad85594c6fbd878f93bfe1ef9770df2a4647a0dba4033b` | 22:13:42 | 662 | ` M` |
| `packages/egress/src/pinned-fetch.ts` | `aeae34a754ca5cd932ac7689bf6ac4e5ed2b279cf62e4a85feb80221bc24377e` | 22:05:07 | 425 | ` M` |
| `tests/harness/network-boundaries/mock-listener.ts` | (đọc, 8 856 byte) | — | — | sạch |

Không có `tsconfig.cr10-tmp.json` hay `.tmp*` sót lại trong `services/orchestrator` (chỉ `tsconfig.json`, `tsconfig.live-tests.json`, `tsconfig.pg-tests.json`) ⇒ lời khai 'throwaway config đã xoá' của receipt **đúng**.

---

## 2. Kiểm tính load-bearing theo từng nhóm (đọc trực tiếp, không chỉ tin tên test)

### 2.1 Byte cap — 6 test (`:163-235`)
| Test | Assertion đáng giá | Vì sao không vacuous |
|---|---|---|
| `:164` content-length **thấp hơn** body thật | `rejects {code: TOKEN_RESPONSE_TOO_LARGE}` + `cancels === 1` | header khai 1024-cap nhưng body thật 8 KiB ⇒ chỉ accumulator mới bắt được |
| `:178` content-length không phải số | cùng mã lỗi | `Number('not-a-number')` = NaN ⇒ nhánh header bị bỏ qua, cap chunk phải giữ |
| `:187` vượt cap do **cộng dồn** | mã lỗi + `pulls === 3` + `cancels === 1` | `pulls === 3` chứng minh dừng **đúng chunk vi phạm**, không pull thứ 4 |
| `:201` **đúng** cap qua nhiều chunk | `getToken() === 'tok-multi'` | **negative control**: xanh không thể có nghĩa 'chặn tất' |
| `:208` vượt **1 byte** qua nhiều chunk | mã lỗi | bắt off-by-one của accumulator |
| `:217` ký tự nhiều byte bị cắt ngang chunk | token đúng + `expect(bytes.byteLength).toBeGreaterThan(body.length)` | guard chống 'âm thầm thoái hoá thành ASCII' — nếu body hết multi-byte, test tự báo |

### 2.2 Stream timeout / deadline — 9 test (`:237-397`)
| Test | Assertion đáng giá |
|---|---|
| `:238` reader reject giữa body | `TOKEN_REQUEST_FAILED` + `pulls === 2` + `cancels === 1` |
| `:247` zero-byte chunk vô hạn | `pulls > 1` + `delivered === 0` + `cancels === 1` + thời gian < 5 s ⇒ **deadline là bound duy nhất** (cap không bao giờ tiến) |
| `:262` stream chậm nhưng hợp lệ | **negative control**: token ra, `delivered === bytes.byteLength`, `cancels === 1` |
| `:276` body không có `getReader` | `TOKEN_RESPONSE_INVALID` + **`textCalls === 0`** + `delivered === 0` + `cancels === 1` |
| `:288` body `null` | `TOKEN_RESPONSE_INVALID` + `textCalls === 0` |
| `:299` backoff trong cùng deadline | `attemptCount === 2` + `secondSignal.aborted === true` + `elapsed ∈ [100, 190)` ⇒ **phân biệt được** deadline đơn (≈120 ms) với theo-attempt (≈210 ms) |
| `:327` secret resolver chậm | `secretSignal.aborted === true`, sau khi secret resolve xong vẫn `fetchCalls === 0` |
| `:354` deadline hết hạn trong backoff | `fetchCalls === 1` + `elapsed < 500` |
| `:372` over-cap **không** retry | `calls === 1` với `maxAttempts: 3` |
| `:390` exchange treo | bị chặn, `elapsed < 500` |

### 2.3 DNS race + socket thật — 6 test (`:400-555`)
| Test | Assertion đáng giá |
|---|---|
| `:401` **DNS về sau timeout** | resolver do test giữ (`dnsAnswers`); sau khi `getToken()` reject vì deadline mới thả `['127.0.0.1']` rồi khẳng định **`listener.requests === 0`** ⇒ answer muộn **không** mở được kết nối |
| `:434` socket không bao giờ gửi header | `TOKEN_REQUEST_FAILED` + `listener.requests === 1` |
| `:454` socket bị destroy giữa body | `TOKEN_REQUEST_FAILED` + `waitFor(abortedRequests > 0 \|\| closedWithoutFinish > 0)` |
| `:481` body **dưới** cap trên socket thật | token ra + `listener.bytesWritten === size` |
| `:509` body **vượt** 1 byte | `TOKEN_RESPONSE_TOO_LARGE` |
| `:536` sentinel secret | 5 script khác nhau, mỗi lần khẳng định `message` **và** `code` không chứa `CLIENT_SECRET` |

**Đối chiếu với mutation §3 của receipt:** đúng **6** dòng khẳng định `TOKEN_RESPONSE_TOO_LARGE` (L174/184/195/214/386/530) và không test nào khác dùng mã đó ⇒ con số '6 failed' khi neutralise `received > this.maxResponseBytes` là **nhất quán về mặt tĩnh**. Lưu ý phụ đã kiểm: test socket `:509` từ chối qua **nhánh header** (harness `respond` không set `content-length`, nhưng `maxResponseBytes: size - 1` nên header thật vẫn vượt) — nghĩa là nó **vẫn** đỏ khi cap chunk bị neutralise **chỉ khi** header không được set; tôi đã xác nhận harness `respond` (`mock-listener.ts:176,188`) chỉ ghi `script.headers` mà test không truyền `content-length` ⇒ nhánh chunk là nhánh chặn. Không chạy lại mutation (read-only) nên đây là **phân tích tĩnh**, không phải tái hiện.

---

## 3. Đối chiếu receipt từng mục

| Mục receipt | Verdict |
|---|---|
| §0 bảng attribution (file nào của ai) | **KHÔNG KIỂM ĐƯỢC** (không có git history cho file `??`); ghi nhận là lời khai minh bạch, không phải bằng chứng |
| §0 '19 test của tôi, nay 22' | **ĐÚNG về con số hiện tại** (22 `it(`) |
| §1 17 edge case không có ở file companion | **ĐÚNG** — đối chiếu tên test trong file: đủ 17 nhóm (6 cap + 5 stream/deadline + 3 real-socket + 2 no-reader/null + 1 sentinel), mỗi nhóm đều có assertion riêng |
| §2 `Tests: 35 passed, 35 total` × 3 | **TÁI HIỆN ĐÚNG** (lệnh #1) |
| §2 'package tsconfig exclude tests' | **ĐÚNG** — `exclude: ['tests','dist','node_modules']`, `include: ['src/**/*.ts']` |
| §2 'typecheck 2 suite + harness bằng config tạm → 0' | **TÁI HIỆN ĐỘC LẬP** bằng CLI (không ghi file) → exit 0 |
| §2 'config tạm đã xoá' | **ĐÚNG** (không còn file lạ) |
| §3 mutation cap → `6 failed, 13 passed, 19 total` | **KHÔNG chạy lại** (read-only); **nhất quán tĩnh** với 6 dòng `TOKEN_RESPONSE_TOO_LARGE` hiện có |
| §3.1 mutation 2 bỏ hoang + lý do | **HỢP LÝ** — 'mutation không compile thì không chứng minh gì' và 'treo 300 s không tính là bằng chứng' là cách ghi đúng |
| §4 **F1** `maxLifetimeSeconds` chết | **XÁC NHẬN** — 6 lần xuất hiện, tất cả là khai báo/validate/gán; `getToken()` tính `renewAt` thuần từ `expires_in` (`:424-427`) ⇒ knob không có tác dụng |
| §4 **F2** `text()` đọc vô hạn trước khi kiểm | **HẾT HIỆU LỰC** — sản phẩm hiện không có `.text()` nào (`grep` = 0 hit); nhánh `:561-564` fail-closed; suite `:276/:288` đã khẳng định `textCalls === 0` |
| §4 **F3** một deadline cho cả acquisition | **ĐÚNG** — `acquire()` `:443-450` tạo một deadline; 4 test trong file khẳng định ngữ nghĩa này (xem §4.2) |
| §5 OOM do microtask starvation | **XÁC NHẬN cơ chế** — probe của tôi 4/4: timer **không** chạy trong 1e6 vòng microtask và trong 200k `Promise.race` với promise đã settle; nhường macrotask mỗi pull thì chạy |
| §5 'harness bị lane khác viết lại, hash đổi' | **KHÔNG KIỂM ĐƯỢC** (sự kiện quá khứ); hiện `oauth2-client.ts` = `ee61663b…` và có `deadline.gate` như receipt mô tả |
| §6 git state | **ĐÚNG** — ` M` source + `??` hai test; không có gì staged |
| §7 không live, F1 chưa sửa | **ĐÚNG** |

---

## 4. Findings cho coordinator

### 4.1 F2 của receipt đã hết hiệu lực (và mô tả §1 đi kèm cũng vậy)
`oauth2-client.ts` hiện **không** có lời gọi `.text()` nào. Nhánh 'body không có `getReader`' giờ `cancelResponse` + `TOKEN_RESPONSE_INVALID` (`:561-564`), tức **không** còn đường 'đọc vô hạn rồi mới kiểm'. Hai test của suite đã được cập nhật đúng theo hành vi mới (`textCalls === 0`), nhưng **mô tả trong receipt** — §1 dòng 10 ('fallback `text()` path still enforces the size verdict'), dòng 11 ('same fallback, opposite shape') và §4-F2 — vẫn tả bản cũ. Nếu coordinator đọc receipt để quyết định, nên biết F2 **không còn là việc phải sửa** trên revision hiện tại.

### 4.2 Số test mang ngữ nghĩa 'một deadline' là **4**, không phải 3
Receipt §0/§4-F3 nói 3 test (do lane khác thêm) khẳng định ngữ nghĩa single-deadline. Trong file có **4** test thuộc nhóm đó: `:299` (retry delay trong cùng deadline), `:327` (secret resolver trong deadline — test này **cũng** chỉ xanh dưới thiết kế một-deadline, vì deadline được tạo **trước** khi resolve secret), `:354` (deadline hết hạn trong backoff), `:390` (exchange treo). Hệ quả: phần receipt tự nhận 'không sở hữu/không thẩm định' đang **thiếu một test** — về mặt bằng chứng thì tốt hơn (nhiều test hơn), nhưng nên ghi đúng để không ai tưởng `:327` là của tác giả receipt.

### 4.3 Rủi ro flake thời gian (thấp, nhưng có thật)
`:299` khẳng định `elapsed ∈ [100, 190)` với backoff 90 ms và timeout 120 ms. Cửa sổ 70 ms là hợp lý trên máy rảnh (3/3 lần của tôi và 3/3 lần của receipt đều xanh), nhưng trên checkout dùng chung, khi nhiều lane chạy jest song song, `elapsed` có thể vượt 190 ms ⇒ test đỏ **không** do sản phẩm. Đề nghị nới cận trên (ví dụ `< 400`) hoặc chuyển sang khẳng định quan hệ `elapsed < backoff + timeout + margin` — vẫn phân biệt được hai thiết kế (210 ms vs 120 ms) mà bớt giòn.

### 4.4 Phần attribution trong receipt không kiểm được
File `??` (untracked) nên không có `git diff`/blame để xác minh '19 test của tôi, 3 của lane khác'. Tôi chỉ xác nhận **nội dung và số lượng** hiện tại; phần quy công là lời khai, không phải bằng chứng — đúng như tinh thần receipt đã tự ghi.

---

## 5. GAP / open items

1. **Không có live run** (đúng như receipt §7): toàn bộ là double tổng hợp + loopback; deadline chưa được đo trên endpoint chậm thật, DNS chưa phải DNS thật. Offline pass **không** thay live gate.
2. **F1 (`maxLifetimeSeconds` chết) vẫn mở** — cần owner quyết: hoặc clamp `renewAt` theo `maxLifetimeSeconds`, hoặc xoá knob và sửa doc comment (`:112`). Đây là fail-open trước IdP trả `expires_in` phi lý.
3. **Mutation §3 chưa được tái hiện độc lập** (read-only). Nếu coordinator muốn bằng chứng mutation thật, nên giao một lane có lease ghi **trên bản sao** file (không phải file sống) — đúng khuyến nghị §5 của chính receipt.
4. **Suite phụ thuộc harness ngoài service** (`../../../../tests/harness/network-boundaries/mock-listener`) ⇒ typecheck phải lift `rootDir`; nếu harness đổi API (`BoundaryListener`, `waitFor`), suite vỡ mà package typecheck **không** bắt được (vì `tests` bị exclude). Đề nghị một entry typecheck riêng cho `tests/**` trong CI.
5. **Cổng chờ**: 2 test stale ở `operations-list-contract-conformance` (đã biết từ AWEB-20a) không liên quan suite này, nhưng nếu chạy batch rộng sẽ gặp.

---

## 6. Xác nhận

- Chỉ **đọc** + chạy jest/tsc/probe offline; **không** sửa source/test/config/docs; **không** mutation trên file sống; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 5 file raw trong `coordination/reports/raw/verify-cr10-oauth2-edge-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe starvation chạy trong `%TEMP%`, không dính sản phẩm; typecheck test dùng **CLI flags**, không tạo tsconfig nào trong repo (đã kiểm lại: không có file lạ).
- Không DB/Redis/IdP, không claim DB window, không đọc `.env.live`.
- Ghi chú trung thực: tôi **không** tái hiện mutation §3 (bị chặn bởi lease read-only) và **không** kiểm được phần attribution §0/§5 của receipt; các kết luận thay thế là phân tích tĩnh + probe cơ chế, đã ghi rõ ở §2.3/§3/§4.4.
- Mọi kết luận gắn sha256 tại §1; các file liên quan đều **chưa commit** nên kết quả chỉ đúng cho revision đã ghi.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
