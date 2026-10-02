# Audit — consumer so sánh INVALID_PROVIDER_RESPONSE sau 2c

- **Receipt**: `qwen-connector-error-code-consumer-audit-2026-10-02.md`
- **Trigger**: coordinator yêu cầu đóng khoảng trống §6 của receipt `qwen-connector-enforcement-2c-2026-10-02.md`
- **Phạm vi**: audit read-only. **Turn này không sửa file nào** — chỉ tạo receipt này. Không tick gate, không commit.

## §0 Trả lời thẳng câu hỏi

Không có consumer nào — trong lẫn ngoài repo — so sánh `INVALID_PROVIDER_RESPONSE` như một **nhánh xử lý lỗi 4xx**. Nên không có rủi ro breaking do so sánh.

Toàn bộ 54 chỗ khớp `INVALID_PROVIDER_RESPONSE` trong `D:\Git\dugate` đã được phân loại hết. Chỉ có **hai loại so sánh thật**, và cả hai đều ở trong chính connector service:

| Chỗ | Loại | Đã xử lý? |
|---|---|---|
| `services/connector/src/http/server.ts:375,411` | hai switch `errorStatus` | Rồi — tôi thêm mã mới vào **cả hai** |
| `services/connector/src/adapters/http.ts:87` | `classifyFailure` fallback | Rồi — đây là nơi tôi thêm nhánh 4xx |

Tất cả chỗ còn lại là **throw site** (`:22,73`, `transport.ts:80,89,103`, `invoke.ts:141,389,396`) cho response hỏng, hoặc là **test**, hoặc là **receipt/dispatch spec** (văn bản, không thực thi).

**Nhưng audit này tìm ra hai thứ nặng hơn câu hỏi đã hỏi** — xem §2 và §3. Một trong hai là hồi quy do chính 2c gây ra.

## §1 Bảng consumer đầy đủ

| Consumer | Dùng taxonomy connector? | Ảnh hưởng 2c | Bằng chứng |
|---|---|---|---|
| `services/connector` (bản thân nó) | Có | Đã xử lý | diff 7 file của 2c |
| `packages/worker-sdk` | Có, 2 chỗ | **Không** — xem §2 | `connector-invoker.ts:71,145`; `worker.ts:519` |
| `packages/connector-client` | Có, 2 chỗ | **CÓ — retryable sai** | `transport.ts:128,140` |
| `packages/contracts` | Có (định nghĩa) | Đã xử lý | `errors.ts:70-71` |
| `services/orchestrator` | **Không** | Không | grep `ConnectorErrorCode`/`PROVIDER_*`/`INVALID_PROVIDER_RESPONSE` trong `src` → **0 match** |
| Admin UI (`services/orchestrator/src/app/admin`) | **Không** | Không | grep `retryable`/`errorCode`/`error_code` → **0 match** |
| Legacy Next.js app (ngoài `du-rework`) | **Không** | Không | `errorCode` của riêng nó: `PIPELINE_ERROR`, `WORKFLOW_ERROR`, `STALLED`, `PIPELINE_INVALID_JSON` |
| `docs/21-openapi.json` | **Không** | Không | grep `PROVIDER_*`/`ConnectorErrorCodes` → **0 match** |
| `tools/openapi` | **Không** | Không | grep `PROVIDER_`/`ConnectorError` → **0 match** |
| `businesses/*` | **Không** | Không | không chạm connector error code |

Suite đã chạy để có số thay vì suy đoán:

| Package | Kết quả | Exit |
|---|---|---|
| `@du/connector-client` | 4 suite pass, 1 skip — **31 passed / 1 skipped / 32 total** | **0** |
| `@du/worker-sdk` | 23/23 suite — **645 passed / 645 total** | **0** |

645/645 khớp **đúng baseline** coordinator ghi ở `dispatch-specs/2026-10-02-1028-postcommit-offline-regression.md:12`. Không red mới.

`connector-client` có 1 suite skip là `real-service.test.ts:29` (`describe.skip` khi thiếu env) — nó cũng **không** assert `retryable` hay `INVALID_PROVIDER_RESPONSE`, nên khi bật live cũng không vỡ vì 2c.

## §2 Đường worker — mất chẩn đoán, nhưng KHÔNG mất tính đúng retry

Đây là chỗ tôi cần **đính chính so với receipt 2c §4**.

Receipt 2c nói mã bị flatten trên đường POST đồng bộ. Điều đó **đúng**. Nhưng tôi chưa kiểm nốt hệ quả với retry, và hoá ra hệ quả đó **nhẹ hơn tôi lo**.

`packages/worker-sdk/src/worker.ts:519`:

```
519      retryable: !nonRetryableConnectorCode && (err.status === 429 || err.status === 503),
```

Chú ý là **`=== 503`**, không phải `>= 500`. Với 502 của tôi: `429` sai, `503` sai → `retryable: false`. Đúng như mong muốn.

| Đường | Mã lọc tới đâu | `retryable` với 4xx | Đúng? |
|---|---|---|---|
| Service, `invoke.ts:430` `safeToRetry` | — | false | ✓ |
| Đọc bất đồng bộ, `connector-session.ts:105` | `error.code` + `error.message` **nguyên văn** | false (wire không có field, `?? false`) | ✓ |
| Đồng bộ qua worker, `worker.ts:519` | bị flatten thành `PROVIDER_UNAVAILABLE` | **false** | ✓ retry đúng, ✗ chẩn đoán sai |

Tóm lại trên đường worker: **2c chỉ mất thông tin chẩn đoán, không gây retry mù**. Đính chính này làm §4 của receipt 2c nhẹ đi, không nặng lên.

## §3 A-1 — Hồi quy do 2c gây ra trong `connector-client`

**Đây là phát hiện nghiêm trọng nhất của audit, và nó là do 2c gây ra.**

`packages/connector-client/src/transport.ts:137-141`:

```
137      throw new ConnectorClientError(code, message, retryAfterMs, {
138        status: response.status,
140        retryable: response.status === 429 || response.status >= 500,
141      });
```

Đối chiếu trước và sau 2c, cùng một tình huống provider từ chối 4xx:

| | HTTP status service trả | `>= 500`? | `retryable` |
|---|---|---|---|
| **Trước 2c** | **400** (`INVALID_PROVIDER_RESPONSE` map 400) | không | **false** ✓ |
| **Sau 2c** | **502** (mã mới) | **có** | **true** ✗ |

Nghĩa là một từ chối **tất định** — retry không bao giờ thành công — giờ được báo cho consumer là *có thể retry*. Đây là hồi quy thật, không phải suy đoán: nó thuần tuý từ số HTTP đổi.

**Mức độ: MEDIUM, có kiểm soát.**

- Chưa tới production path: `@du/connector-client` **không phải dependency của package workspace nào**. Grep `**/package.json` cho `connector-client` → **1 match, chính nó** (`packages/connector-client/package.json:2`). `architecture/11-subprojects.md:59` ghi rõ: *không là dependency trực tiếp của hai service trong manifest hiện tại*.
- Nhưng nó là **package phát hành cho consumer ngoài** (`packages/connector-client/README.md`), và `tests/integration/p4-08-sdk-consumer.integration.test.ts:30` import từ source của nó. Nên consumer ngoài có thể dựa vào `err.retryable` để quyết định retry.
- Không có consumer consumer trong repo nào đọc `ConnectorClientError.retryable` — nên không có gì hỏng **ngay trong repo này**.

## §4 A-2 — Nguyên nhân gốc: `retryable` không có trên wire dù type đã khai

Nếu chỉ vá `connector-client` thì chỉ chữa triệu chứng. Nguyên nhân gốc là **tín hiệu `retryable` không bao giờ được gửi lên wire**, dù kiểu dữ liệu đã khai nó từ trước:

| Bước | Thực tế | File:line |
|---|---|---|
| Kiểu wire đã khai | `error?: { code, message, retryable?, retryAfterMs? }` kèm chú thích *Additive (W39-CC2): wire `error.retryable` passthrough for SDK classification* | `packages/connector-client/src/types.ts:25-26` |
| Service **không** gửi | `{ error: { code, message } }` — không `retryable` | `services/connector/src/http/server.ts:75-77` |
| Service **không** gửi (đường đọc) | `error: { code, message: 'Invocation did not complete.' }` | `services/connector/src/services.ts` (`toHttpResult`) |
| Client **không** đọc | `transport.ts:129` khai kiểu parse chỉ gồm `code`/`message`/`retryAfterMs` — **không có** `retryable` | `packages/connector-client/src/transport.ts:129` |

Nghĩa là passthrough W39-CC2 được **khai báo nhưng chưa implement**. Đây đúng là cùng họ với 4 hook capability treo tôi tìm trong memo options — một khai báo contract không có đường dữ liệu.

Hệ quả trực tiếp và đáng chú ý: **hai client trong repo suy ra cùng một tín hiệu theo hai quy tắc khác nhau** —

| Client | Quy tắc | 502 |
|---|---|---|
| `packages/worker-sdk/src/worker.ts:519` | `status === 429 \|\| status === 503` | false |
| `packages/connector-client/src/transport.ts:140` | `status === 429 \|\| status >= 500` | **true** |

Một cái dùng `=== 503` (có vẻ cố ý), một cái dùng `>= 500`. Chỉ cần một lần đổi status là lộ ra. 2c chỉ là lần đổi đó.

## §5 Đề xuất sửa — chưa làm, chờ coordinator

Tôi **không** sửa gì trong turn này. Ba lựa chọn, xếp theo thứ tự tôi đề nghị:

| # | Sửa | Chạm gì | Đánh giá |
|---|---|---|---|
| **1 (đề xuất)** | Service gửi kèm `error.retryable` lấy từ `connectorError.safeToRetry` | `services/connector/src/http/server.ts:75-77` và `toHttpResult` | **Nguồn sự thật đúng một chỗ** — service đã biết đáp án. Additive, field đã có trong kiểu client. Sửa được cả A-1 lẫn A-2 cùng lúc |
| **2** | `connector-client` đọc `error.retryable` từ body, và coi `PROVIDER_REQUEST_REJECTED` là không retry được | `packages/connector-client/src/transport.ts:129,140` | Vá triệu chứng; vẫn còn hai client suy ra hai kiểu nếu service chưa gửi field |
| **3** | Căn hai quy tắc ở `worker.ts:519` và `transport.ts:140` về cùng một phép so sánh | 2 file, 2 lane khác nhau | Rẻ nhất nhưng **chỉ đồng bộ triệu chứng**, và sẽ vỡ lần nữa khi có status mới |

Lưu ý về quyền sở hữu: `packages/connector-client` thuộc lane khác — comment tại `packages/worker-sdk/src/connector-invoker.ts:7` nói *replay/poll lives in @du/connector-client (Copilot lane)*. Nên tôi không tự sửa nó.

## §6 Đính chính cần ghi vào receipt 2c

Receipt `qwen-connector-enforcement-2c-2026-10-02.md` §4 nói worker thấy *đúng cái chẩn đoán sai mà 2c sinh ra để diệt*. Câu đó **đúng về mã**, nhưng dễ bị đọc quá nặng thành *gây retry mù*. Đính chính:

- **Đúng**: mã `PROVIDER_REQUEST_REJECTED` không tới được worker trên đường POST đồng bộ, bị ép thành `PROVIDER_UNAVAILABLE` (`connector-invoker.ts:145`).
- **Sai nếu hiểu là có hậu quả retry**: `worker.ts:519` dùng `=== 503` nên `retryable` vẫn `false`. Không có retry mù trên đường production.
- **Còn lại đúng**: việc mất chẩn đoán vẫn là thiệt hại thật, và bản vá đóng nốt vẫn cần — nay đã biết chính xác chỗ: `connector-invoker.ts:145`, và nó nên đi cùng phương án 1 ở §5.

Tôi không sửa receipt 2c (không phải file của tôi trong turn này, và coordinator chưa yêu cầu). Mục này là đính chính có dẫn chứng để coordinator quyết có cập nhật hay không.

## §7 Giới hạn của audit này — đọc trước khi dùng

- **Tôi không thể audit consumer nằm ngoài máy này.** Phạm vi thật của tôi là `D:\Git\dugate`. Điều tôi khẳng định được là: *trong* checkout này không có consumer nào so sánh `INVALID_PROVIDER_RESPONSE` cho lỗi 4xx. Điều tôi **không** khẳng định được là: `@du/connector-client` là package phát hành, nên consumer bên ngoài repo có thể tồn tại và không nằm trong tầm tay tôi.
- Tôi chưa kiểm có hệ thống bên thứ ba nào khác (gateway, SDK ngoài, script vận hành) tiêu thụ trực tiếp HTTP của connector không. Chưa có bằng chứng trong repo; cũng không có cách nào suy ra từ repo.
- `grep` không thấy được enforcement sinh bằng reflection hay sinh code. Tôi đã đọc tay các đường quan trọng (`transport.ts`, `connector-invoker.ts`, `worker.ts` `classifyFailure`, `connector-session.ts`) nhưng không đọc từng dòng của cả repo.
- Số liệu suite là **offline**. Không PostgreSQL, không Redis, không provider thật. `connector-client` bỏ qua 1 suite live-gated; `worker-sdk` chạy đủ 23 suite nhưng trong đó có suite RSS đo bộ nhớ (`artifact-multipart-rss`, 134s) — con số đó không phải thứ audit này dùng.
- A-1 là **hồi quy suy ra từ mã**, chưa quan sát runtime: tôi chưa chạy một consumer thật nhận 502 rồi đọc `err.retryable`. Phép so sánh `502 >= 500` là hiển nhiên và tôi coi là đủ, nhưng nói rõ là chưa có bằng chứng chạy.
- Turn này **không sửa file nào**; git diff vẫn đúng bằng 7 file của 2c. Không tick gate, không commit.
