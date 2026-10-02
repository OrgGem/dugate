# 2c implemented — provider rejection separated from malformed provider response

- **Receipt**: `qwen-connector-enforcement-2c-2026-10-02.md`
- **Trigger**: coordinator đã duyệt implement 2c, 2026-10-02 (theo memo `codex-connector-enforcement-options-2026-10-02.md` §3)
- **Diff**: 7 file sửa, +45/-3; thêm 1 file test mới. Không tick gate, không commit.

## §0 Kết quả

Yêu cầu là tách hai thứ đối lập nhau. Trước đây chúng **dùng chung một mã**:

| | Trước | Sau |
|---|---|---|
| Provider **từ chối** yêu cầu (4xx) | `INVALID_PROVIDER_RESPONSE` | **`PROVIDER_REQUEST_REJECTED`** |
| Provider trả **200 nhưng body sai contract** | `INVALID_PROVIDER_RESPONSE` | `INVALID_PROVIDER_RESPONSE` (giữ nguyên) |
| Message khi 4xx | `Provider request failed.` — không status, không task | `Provider returned HTTP 400 for task 'disbursement_classfy'.` |

Mã mới là `PROVIDER_REQUEST_REJECTED`, HTTP **502**. Tôi **không** dùng 400: 400 nói với orchestrator rằng chính yêu cầu của nó sai, trong khi yêu cầu đó hợp lệ và bị upstream từ chối — đúng là 502.

## §1 Diff, từng file

| File | Sửa gì |
|---|---|
| `services/connector/src/types.ts:24-25` | Thêm `'PROVIDER_REQUEST_REJECTED'` vào `ConnectorErrorCode` |
| `packages/contracts/src/errors.ts:70-71` | Thêm cùng mã vào `ConnectorErrorCodes` — **bắt buộc**, vì `services/connector/src/contracts.ts:108` validate code theo danh sách này |
| `services/connector/src/adapters/http.ts:81-87` | `classifyFailure`: thêm nhánh `status >= 400` → mã mới, trước fallback |
| `services/connector/src/invoke.ts:425-431` | Dùng `describeNonSuccessResponse(...)` thay chuỗi cố định |
| `services/connector/src/invoke.ts:456-474` | Hàm mới `describeNonSuccessResponse` |
| `services/connector/src/http/server.ts:393-399` và `:430-436` | `errorStatus` map mã mới → 502, ở **cả hai** bản sao của hàm |
| `services/connector/tests/p8-03-convergence.test.ts:438` | Sửa assertion cũ đang ghim hành vi cũ |
| `services/connector/tests/provider-rejection-diagnostics.test.ts` | **Mới**, 15 test |
| `docs/08-connector-api.md:59-60` | Thêm dòng taxonomy + làm rõ dòng `INVALID_PROVIDER_RESPONSE` |

Hai bản sao `errorStatus` là điểm dễ sót: bản trong `createConnectorServer` lồng ở `:372`, bản module-level ở `:404`, và chúng **khác nhau** — bản lồng không có nhánh `CANCELLED`. Bỏ sót bản nào là mã mới rơi vào `default: 500`. Tôi đã sửa cả hai.

`multipartHttpAdapter` kế thừa `classifyFailure` qua spread (`http.ts:86`), nên một sửa ở `jsonHttpAdapter` phủ cả hai. Có test riêng chốt điều này.

## §2 Ràng buộc chống rò rỉ trong message

`input` là dữ liệu do bên gọi gửi, và message này đi thẳng ra orchestrator (`http/server.ts:77` trả `connectorError.message`). Nên tôi **không** echo `task` vô điều kiện:

```
const echoableTask = typeof task === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(task) ? task : undefined;
```

Chỉ giữ lại giá trị trông như literal do business viết (`disbursement_classify`, `doc_compare_structure`). Ngoài ra thì rút gọn thành `Provider returned HTTP <status>.` Có 4 test giữ điều này, gồm một task chứa khoảng trắng, `=` và một task có newline — cái sau còn khẳng định message **không** sinh dòng thứ hai.

Message không chứa provider body, không chứa header, không chứa credential. Bám `docs/08-connector-api.md:64`.

## §3 Test

File mới `services/connector/tests/provider-rejection-diagnostics.test.ts`, 15 test trong 4 nhóm:

| Nhóm | Phủ cái gì |
|---|---|
| classifyFailure taxonomy | 6 status 4xx bằng `test.each`; 429/5xx/Error **không đổi**; 302 giữ fallback; multipart kế thừa |
| end-to-end qua `invokeAdapter` | 400 → mã mới + message + ledger `FAILED` + `safeToRetry:false`; **200 body sai schema vẫn `INVALID_PROVIDER_RESPONSE`**; 503 vẫn retryable; 429 giữ `retryAfterMs` |
| chống echo | task lạ không bị phản chiếu, task có newline không phá message, task vắng, task quá dài |
| HTTP surface | `GET /invocations/:id` → **502** kèm `error.code` và `error.message` |

Test thứ hai trong nhóm end-to-end là cái **chứng minh** yêu cầu tách: cùng một provider, cùng một `invokeAdapter`, chỉ khác 400-vs-200-wrong-body, cho ra hai mã khác nhau.

### Kết quả chạy

| Suite | Kết quả | Exit |
|---|---|---|
| `pnpm --filter @du/connector test` | 22 suite pass, 1 fail, 2 skip — **278 passed / 1 failed / 7 skipped / 286 total** | 1 |
| `pnpm --filter @du/connector exec tsc --noEmit` | sạch | 0 |
| `pnpm --filter @du/contracts test` | 22 suite pass, 1 fail — **462 passed / 2 failed / 464 total** | 1 |
| `pnpm --filter @du/contracts exec tsc --noEmit` | sạch | 0 |
| `pnpm --filter @du/orchestrator exec tsc --noEmit` | sạch | 0 |

**Hai red, đều không phải do thay đổi này — và tôi không claim live:**

1. `p8-03-convergence.test.ts` USE-02 `connect ECONNREFUSED 127.0.0.1:5433`. Đây là test **live-PG**: nó seed row thật vào `operations` (`:636-652`). Tôi đã kiểm `Test-NetConnection 127.0.0.1 -Port 5433` → **False**, tức không có PostgreSQL chạy. Ba suite phụ thuộc `:5433`: `p8-03`, `black-box-durable`, `durable-integration` (hai cái sau nằm trong 2 skip).
2. `packages/contracts/tests/vault-policies.test.ts:104,179` — `expect(...).toThrowError is not a function`. `toThrowError` bị xoá từ Jest 27. **Baseline này đã được coordinator ghi sẵn** trong `coordination/dispatch-specs/2026-10-02-1028-postcommit-offline-regression.md:11`: *2 red pre-existing `vault-policies.test.ts:104,179`*. Tôi chạy ra **đúng hai dòng đó**, không thêm, không bớt.

Tôi **không** sửa test nào để làm xanh, và **không** claim DB window.

## §4 Giới hạn quan trọng — 2c chưa đóng trên đường POST đồng bộ

Đây là phát hiện phải nói thẳng, vì nó quyết định 2c còn giá trị bao nhiêu.

Tôi truy đường đi của mã mới từ connector tới người vận hành và thấy **hai đường, một đi được, một đi mất**:

| Đường | Mã mới tới được operator? | Bằng chứng |
|---|---|---|
| **Bất đồng bộ** — `GET /invocations/{id}` rồi đọc `state: FAILED` | **Có** | `classifyInvocation` chuyển nguyên văn `response.error.code` và `.message` (`packages/worker-sdk/src/connector-session.ts:102-110`) |
| **Đồng bộ** — `POST /invocations` | **Không** | xem dưới |

Ở đường đồng bộ, `packages/worker-sdk/src/connector-invoker.ts:121-145` chỉ **parse code từ body** cho 401/403/409. Mọi status khác, gồm 502 của tôi, rơi vào dòng cuối (`:145`):

```
145  throw new ConnectorTransportError(response.status, statusErrorCode(response.status));
```

và `statusErrorCode` (`:71-77`) map 502 → `PROVIDER_UNAVAILABLE`. Nghĩa là worker nhìn thấy **đúng cái chẩn đoán sai mà 2c sinh ra để diệt**: một yêu cầu bị provider từ chối vẫn hiện ra là provider không sẵn sàng.

Tôi **không** sửa chỗ này. Lý do: coordinator nêu phạm vi là `classifyFailure` + `invoke.ts`, còn `connector-invoker.ts` thuộc hợp đồng lỗi của worker-sdk và cần một quyết định riêng.

Ghi rõ để không ai hiểu nhầm là 502 là lựa chọn sai: **400 cũng không sống sót** — `statusErrorCode(400)` ra `INVALID_INPUT`, tức còn tệ hơn vì đổ lỗi sang chính yêu cầu của bên gọi. 502 vẫn là lựa chọn đúng; nó chỉ chưa được đọc.

**Bản vá nhỏ để đóng nốt, cần coordinator duyệt:** mở rộng allowlist đọc code ở `connector-invoker.ts` cho status không phải 401/403/409 — về hình thức giống hệt `parseAllowedErrorCode(text, CONNECTOR_AUTH_ERROR_CODES)` sẵn có ở `:130`, chỉ cần thêm `PROVIDER_REQUEST_REJECTED`. Đây là thay đổi worker-sdk, **tôi không tự làm**.

## §5 Một lệch có sẵn, tôi không sửa

`docs/08-connector-api.md` từ trước đã ghi `INVALID_PROVIDER_RESPONSE` → **502**, còn `http/server.ts:409-411` map nó → **400**. Tôi chỉ sửa lệch này ở phần **mô tả ngữ nghĩa** của dòng đó, **không** đụng số HTTP trong code — vì đổi nó là đổi hành vi public nằm ngoài phạm vi 2c. Nếu coordinator muốn, đây là một delta riêng.

## §6 Blast radius

| Hệ quả | Đánh giá |
|---|---|
| Code mới có thể bị consumer từ chối không? | `packages/contracts/src/errors.ts` và `services/connector/src/types.ts` phải cùng nhập một mã — tôi sửa cả hai, và `contracts.ts:108` bắt buộc điều đó |
| Orchestrator có làm phẳng mã không? | Grep `services/orchestrator/src` cho `ConnectorErrorCode`/`INVALID_PROVIDER_RESPONSE`/`PROVIDER_UNAVAILABLE` → **0 match**. Nó coi mã là chuỗi trong suốt |
| `network-boundaries.boundary.test.ts` có bị ảnh hưởng? | Không. Bốn chỗ `INVALID_PROVIDER_RESPONSE` ở đó đến từ `FetchProviderTransport` (cap/stream), không đi qua `classifyFailure`. Suite pass |
| Retry semantics có đổi không? | Không. `safeToRetry` vẫn chỉ true cho `PROVIDER_RATE_LIMITED`/`PROVIDER_UNAVAILABLE` (`invoke.ts:430`), mã mới không nằm trong đó — đúng, vì 4xx thì retry vô nghĩa |
| Đường 200-wrong-body có đổi không? | Không, vẫn `INVALID_PROVIDER_RESPONSE`. Đây là mục tiêu của việc tách |
| Breaking cho client cũ? | Chỉ nếu client **so sánh bằng** `INVALID_PROVIDER_RESPONSE` cho lỗi 4xx. Tôi chưa kiểm hết client ngoài repo; đây là khoảng trống của việc kiểm này |

## §7 Giới hạn

- **Không chạy live.** Không PostgreSQL (`:5433` trả `False`), không provider thật. Cái được chứng minh là phân loại lỗi và ánh xạ HTTP qua loopback trong process, không phải hành vi với provider thật.
- Provider có **thực sự** phân biệt `disbursement_classify` với chuỗi sai hay không vẫn là OPEN-B, ngoài repo này. Thay đổi này **không** đóng OPEN-B — nó chỉ làm cho khi provider từ chối, người vận hành nhìn ra ngay đó là từ chối chứ không phải sự cố.
- 2 red ở §3 là red có sẵn của môi trường, tôi không xử lý và không tính là xanh.
- Chưa audit toàn bộ client ngoài repo so sánh mã lỗi connector (dòng cuối §6).
- Không tick gate, không commit, không đụng `document-core/**`, không claim DB window.
