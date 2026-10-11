# Verify độc lập (DSH) — CR10-03 + CR10-04 OAuth2 token client — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet CR10-03/04 do lane Qwen implement.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code (kể cả mutation tạm); **KHÔNG** tick gate; artifact ghi thêm duy nhất: receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd mọi lệnh: `orchestrator/services/orchestrator`.
**Node:** v22.23.3 (PATH) cho các lượt chính; v24.21.0 cho lượt khớp runtime của receipt gốc.
**Raw:** `du-rework/coordination/reports/raw/verify-cr10-03-04-2026-10-10/DSH/` (`batch-run1..3.log`, `typecheck.log`, `focused-node24.log`, `SHA256SUMS.txt`).

## 0. Đối tượng kiểm (digest tại thời điểm verify)

| File | Dòng | sha256 (16 ký tự đầu) | Git |
|---|---:|---|---|
| `src/modules/webhooks/oauth2-client.ts` | 631 | `465da6925b8b6277` | ` M` |
| `tests/cr10-oauth2-body-and-egress.test.ts` | 402 | `495746ead6798e56` | `??` |

`git diff --numstat` của source = **180 insertions / 29 deletions** — khớp chính xác receipt §2. **`packages/egress` sạch** (`git status` rỗng) ⇒ DELTA-1 (chỉ import, không sửa egress) **đúng**.

## 1. Bằng chứng chạy (REAL_EXIT đo ngay sau mỗi lệnh)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | batch 8 suite: `cr10-oauth2-body-and-egress` + `cb-03-outbound-auth` + `cb-02-webhook-result-delivery` + `cb02c-retry-callback-pin` + `cb02-admission-writer` + `cb02b-profile-publish-callback` + `cb03-composition-resolver` + `vfy-cb01-dispatch-matrix` (`node node_modules/jest/bin/jest.js --runInBand --runTestsByPath <8 file>`, lần 1) | **0** | `Test Suites: 8 passed, 8 total` · `Tests: 89 passed, 89 total` · `Time: 3.449 s` · không FAIL |
| 2 | y hệt, lần 2 (tiến trình riêng) | **0** | `Test Suites: 8 passed, 8 total` · `Tests: 89 passed, 89 total` · `Time: 3.506 s` · không FAIL |
| 3 | y hệt, lần 3 (tiến trình riêng) | **0** | `Test Suites: 8 passed, 8 total` · `Tests: 89 passed, 89 total` · `Time: 3.561 s` · không FAIL |
| 4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output · `error_lines=0` |
| 5 | focused trên **node v24.21.0**: `--runInBand --forceExit --testTimeout=15000 --runTestsByPath tests/cr10-oauth2-body-and-egress.test.ts` | **0** | `Tests: 13 passed, 13 total` |

Ghi chú quan trọng: 3 lượt batch **không** dùng `--forceExit` mà vẫn exit sạch trong ~3.5 s ⇒ trieu chung handle treo của bản trước khi sửa (receipt ghi RED đầu tiên treo 300 s khi thiếu `--forceExit`) **không còn**. Số liệu trùng khớp từng con số với receipt §4.2/§4.3/§4.4.

## 2. Kiểm source — CR10-03 (deadline + byte cap + giải phóng body)

- **Deadline phủ cả body:** `deadlineGate` (`src/modules/webhooks/oauth2-client.ts:444-448`) là promise chỉ reject khi hết hạn và được **race với từng `reader.read()`** (`:539` `await Promise.race([reader.read(), deadlineGate])`) ⇒ ngắt được cả một read đang treo, kể cả transport inject bỏ qua `AbortSignal`. `clearTimeout` + gỡ reject nằm trong `finally` của phương thức (không xoá timer sau headers như bản cũ).
- **Byte cap ngay trong lúc đọc:** `readBoundedBody()` (`:512-556`) cộng dồn theo chunk và ném `TOKEN_RESPONSE_TOO_LARGE` **ngay khi vượt cap** (`:544-545`), không đợi EOF; nhánh `finally` gọi `cancelQuietly(reader)` (`:556`) ⇒ giải phóng socket ở mọi đường thoát. Fallback chỉ dùng khi body không có `getReader` (`:518-524`) và vẫn kiểm tra kích thước cuối.
- **Nhánh từ chối giải phóng body:** `releaseBody(response)` (định nghĩa `:171`) được gọi trước khi throw ở cả 3 nhánh: status (`:457`), content-type (`:462`), declared-length (`:466-468`).
- **Không đổi mã lỗi/union:** chỉ khác message (`did not complete within its deadline` vs `unreachable`), union lỗi vẫn `TOKEN_REQUEST_FAILED` (`:120-124` gồm `TOKEN_ENDPOINT_DENIED`, `TOKEN_RESPONSE_TOO_LARGE`) ⇒ mapping outbound-auth không đổi.
- Tách `parseTokenResponse()` giữ một phạm vi deadline duy nhất (đúng như receipt mô tả).

## 3. Kiểm source — CR10-04 (egress pinned, fail-closed)

- **Không còn global fetch:** grep source cho `?? fetch`, `globalThis.fetch`, `global.fetch`, `fetch(input`, `await fetch(` = **0 hit mọi mẫu**; mặc định là `this.fetchImpl = options.fetchImpl ?? createPinnedFetch({...})` (`:344-347`) với `allowHosts` / `allowPrivateNetworks` / `resolve` (resolver seam) truyền qua. Import `createPinnedFetch, DestinationDeniedError` từ `@du/egress` (`:2`) — chỉ import, không sửa package (đã xác nhận `packages/egress` sạch).
- **Fail-closed mã hoá:** `DestinationDeniedError` được map sang `TOKEN_ENDPOINT_DENIED` tại `fetchTokenResponse()` (`:498-499`), message không chứa secret.
- **Redirect không bao giờ được follow:** `redirect: 'error'` tại request credential-bearing (`:494`).
- **Chuẩn hoá allowlist:** `normalizeAllowHosts()` (`:158-163`) lowercase, bỏ bracket IPv6, chặn giá trị rác; option hợp lệ hoá tại `:318-339` (`maxResponseBytes` phải là số nguyên dương, `allowPrivateNetworks` boolean, `resolveDns` function).

## 4. Kiểm test — bounds, cancel, timeout, egress oracle

13 test (`tests/cr10-oauth2-body-and-egress.test.ts`), bao phủ đúng ma trận receipt §3; các bound/oracle tôi đọc trực tiếp:

| Nhóm | Assertion có thật (file:line) |
|---|---|
| CR10-03 body không kết thúc | `captured.signal?.aborted === true` (`:126`), `state.pulls === 1` (`:127`), `state.cancels === 1` (`:128`) |
| CR10-03 chunked vượt cap | `state.pulls <= 2` (`:142`), `state.delivered <= 64 KiB` (`:143`), `state.cancels === 1` (`:144`) |
| CR10-03 boundary | body đúng cap được nhận; 1 byte vượt bị từ chối (`:147-165`) |
| CR10-03 nhánh từ chối | `state.cancels === 1` cho status / content-type / declared-length (`:181`) |
| CR10-03 socket thật (stall) | `listener.requests === 1` (`:199`) + `waitFor(closedWithoutFinish > 0)` (`:200`) ⇒ socket bị te |
| CR10-03 socket thật (chunked 1 MiB, paced) | `listener.bytesWritten < 256 KiB` (`:228`) ⇒ không drain hết |
| CR10-03 token hợp lệ qua transport thật | `getToken() === 'tok-live'` (`:246`), `listener.requests === 1` (`:247`), `method === 'POST'` (`:250`) |
| CR10-04 literal không allowlist | `TOKEN_ENDPOINT_DENIED` (`:271`) + **`listener.requests === 0`** (`:272`) ⇒ negative oracle, không hề connect |
| CR10-04 ma trận literal | mỗi URL reject `TOKEN_ENDPOINT_DENIED` (`:296`), message không chứa secret |
| CR10-04 ma trận DNS | 7 case mixed/RFC1918/metadata/ULA/link-local/CGNAT đều deny (`:301-325`), **`seen === [entry.host]`** (`:325`) ⇒ resolver đúng **1 lần** với hostname |
| CR10-04 public answers | dial đúng IP đã adjudicate, **Host giữ tên gốc** (`:335-345`: tokenUrl `http://idp.example.test:<port>/token` + `resolveDns → ['127.0.0.1']`) |
| CR10-04 redirect → metadata | `TOKEN_ENDPOINT_DENIED` (`:374`), `listener.requests === 1` (`:375`), message không chứa `CLIENT_SECRET` (`:376`) ⇒ không follow hop |
| CR10-04 redirect → public | không follow; client fail-closed `TOKEN_HTTP_ERROR` status 302, không request thứ hai (`:382-402`) |

Thiết kế test đáng ghi nhận: mỗi `it()` dựng listener riêng trong **cửa sổ port riêng** (band 45000+) để tránh tái dùng socket keep-alive giữa các test — khớp mục §4.5 của receipt (flap do keep-alive agent của Node, không phải lỗi product).

## 5. Verdict

| Hạng mục | Kết quả |
|---|---|
| Focused suite (13 test) | **PASS** — `13 passed, 13 total`, exit 0 (kể cả trên node v24.21.0) |
| Batch 8 suite (89 test, gồm 76 regression cũ) | **PASS** — 3/3 lượt exit 0, `8 passed, 8 total`, `89 passed, 89 total`, không FAIL, không cần `--forceExit` |
| Typecheck | **PASS** — exit 0, 0 lỗi |
| Bounds stream cancel / timeout | **ĐẠT** — pulls/pulls≤2, delivered≤64 KiB, cancels=1, bytesWritten<256 KiB, closedWithoutFinish>0 |
| Egress pinned IP | **ĐẠT** — `requests=0` cho literal bị chặn, resolver 1 lần, dial đúng answer, Host giữ tên gốc, redirect không follow, message không lộ secret |
| Claim phụ của receipt (180/29, egress sạch, không global fetch) | **KHỚP** với kiểm chứng độc lập |

⇒ **CR10-03 + CR10-04: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (VERIFIED/ACCEPTED thuộc coordinator).

## 6. GAP / open items

1. **TLS/public IdP thật chưa được chứng minh (DELTA-4):** positive control dùng loopback http với opt-in tường minh (`allowPrivateNetworks: true`, `allowHosts`); chưa có token endpoint HTTPS công khai thật, chưa có DNS thật, chưa có IdP/credential thật. Vì vậy acceptance `public HTTPS token endpoint hợp lệ vẫn chạy được` **không** được đóng bởi lượt này (tôi cũng offline).
2. **DELTA-2:** 3 test socket của CR10-03 inject `createPinnedFetch` **làm `fetchImpl`** thay vì dùng transport mặc định của client; đường mặc định chỉ được phủ bởi test CR10-04. Verifier độc lập nên chạy một positive control qua **default transport** nếu muốn khép khe này.
3. **DELTA-3:** Batch B (4 test API mới: DNS matrix, anti-rebinding, 2 redirect) **không có lần RED riêng** — cùng land với Batch A; bằng chứng RED duy nhất là 8 fail/1 pass của Batch A.
4. **Rollout note bắt buộc báo trước khi cutover:** `allowPrivateNetworks` mặc định **false** ⇒ deployment cũ trỏ IdP ở IP private sẽ nhận `TOKEN_ENDPOINT_DENIED` cho tới khi opt-in qua `callbackOAuth2Options` (`server.ts:304`).
5. **Không có mutation độc lập từ tôi** (packet cấm sửa code) ⇒ bằng chứng mutation/RED vẫn thuộc implementer.
6. **Chưa commit:** source ` M` + test `??` ⇒ kết quả gắn digest §0; đổi file là hết hiệu lực.

## 7. Xác nhận

- Không `git add`, không commit, không push (không có gì staged); không tick gate; không sửa source/test/docs — artifact duy nhất: receipt này + raw log.
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
