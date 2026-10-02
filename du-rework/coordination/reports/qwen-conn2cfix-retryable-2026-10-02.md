# CONN-2C-FIX — retryable signal carried on the wire (A-1) + policy written once

- **Receipt**: `qwen-conn2cfix-retryable-2026-10-02.md`
- **Dispatch**: 2026-10-02T13:02:56+07:00, coordinator `command-code`
- **Input**: audit `qwen-connector-error-code-consumer-audit-2026-10-02.md` §3 (A-1) và §4 (A-2)
- **Diff lũy kế** (2c + turn này): 8 file, +99/-10; thêm 3 file test. Không tick gate, không commit.

## §0 Đính chính quan trọng — A-2 của tôi trong audit là **sai một nửa**

Tôi đã viết trong audit rằng passthrough `retryable` *chưa bao giờ được implement*, và suy ra từ đó rằng đường đọc vi phạm `InvocationResponseSchema`. **Khi bắt đầu code, tôi đọc kỹ hơn và phát hiện điều đó không đúng.**

`services/connector/src/contracts.ts:78-86` — hàm `toContractInvocationResponse` **đã** dựng `retryable` từ error code từ trước, và dòng `:81` viết đúng phép so sánh `PROVIDER_RATE_LIMITED` hoặc `PROVIDER_UNAVAILABLE`. Dòng `:86` là `InvocationResponseSchema.parse(response)` — **hard parse**, không phải `safeParse`.

Nghĩa là nếu `retryable` vắng thì hàm **đã ném ngay**. Đường đọc vì thế **luôn hợp lệ với contract** — không có lỗi nào ở đó.

Tôi đã **revert** phần sửa `services.ts` tương ứng, kể cả comment khẳng định sai mà tôi đã viết vào trước đó. `git diff --stat` xác nhận `services.ts` **không còn trong diff**.

Một chi tiết để không ai đọc nhầm: `git status --porcelain` vẫn hiện ` M` cho file đó, còn `git diff` trên đúng đường dẫn đó trả **rỗng**. Đây là stat cache của git trên Windows do file bị ghi lại rồi hoàn nguyên về đúng nội dung cũ, **không phải** thay đổi còn sót. `git diff` mới là so sánh nội dung và nó là nguồn đáng tin.

**Phần đúng của A-2** nằm ở chỗ khác: passthrough thiếu ở **envelope lỗi non-2xx** (`http/server.ts:76-77`), không phải ở đường đọc. Đây mới là chỗ 502 phát sinh, và là chỗ A-1 thực sự xảy ra. Tôi đã sửa đúng chỗ đó.

Bài học tôi ghi lại: tôi kết luận *service không gửi retryable* từ việc đọc `toHttpResult`, mà không truy ra tới nơi khối `error` thật sự được dựng cho wire. Một tầng giữa đã bị bỏ qua khi đọc.

## §1 Trước / sau

### Service — envelope lỗi non-2xx

| | Envelope trước | Envelope sau |
|---|---|---|
| body | `{error:{code,message}}` | `{error:{code,message,retryable,retryAfterMs}}` |
| ai quyết định retry | client tự suy từ HTTP status | **service** (`connectorError.safeToRetry`) |

`server.ts:76-88`. `retryAfterMs` là `undefined` thì `JSON.stringify` tự bỏ field, nên 429 vẫn mang nó còn các mã khác không mang field rỗng.

### Client

| | Trước (`transport.ts:140`) | Sau |
|---|---|---|
| ưu tiên | chỉ HTTP status | **wire `error.retryable`**, thiếu mới fallback |
| 502 + `PROVIDER_REQUEST_REJECTED` | `true` — sai | wire có thì `false`; wire thiếu thì fallback theo code ra `false` |
| 502 + `PROVIDER_UNAVAILABLE` | `true` | `true` — đúng |

## §2 Lựa chọn fallback — và vì sao

Spec yêu cầu: khi wire thiếu `retryable`, phải phân biệt được **502-từ-chối** với **502-gateway**, và phải **ghi rõ lựa chọn + lý do**.

**Tôi chọn: dùng `code` đã parse, giữ nguyên heuristic status cho mọi trường hợp còn lại.**

```
function fallbackRetryable(code: string, status: number): boolean {
  if (code === 'PROVIDER_REQUEST_REJECTED') return false;
  return status === 429 || status >= 500;
}
```

| Phương án | Vì sao không chọn |
|---|---|
| Chỉ dựa status (hiện trạng) | Đây chính là A-1. 502 không phân biệt được hai nguyên nhân đối lập |
| Thu hẹp heuristic, ví dụ chỉ 503 mới retry (giống `worker.ts:519`) | Sẽ **hạ cấp âm thầm** một sự cố 5xx thật mà service cũ vẫn báo retryable, và đổi hành vi cho *mọi* mã ngoài phạm vi 2c. Một bản vá retry trở nên quá rộng |
| Dùng `code` cho mọi mã | Với `PROVIDER_UNAVAILABLE` thì code và status cùng kết luận; nhưng với mã lạ, `code` không mang thông tin gì. Giữ heuristic status làm mặc định giữ hành vi cũ khi gặp thứ lạ |

Điểm dễ hiểu nhầm: heuristic **cũ** được giữ nguyên cho mọi mã trừ `PROVIDER_REQUEST_REJECTED`, vì đó là hành vi một peer chạy service cũ đang dựa vào. Chỉ thay đúng một tình huống đã biết là sai.

## §3 Policy viết đúng một chỗ

Trước đây cùng một phép so sánh nằm ở **hai** chỗ, và còn một bản thứ ba suy từ status:

| Chỗ | Trước | Sau |
|---|---|---|
| `invoke.ts:430` (khi throw) | inline hai mã transient | `isRetryableErrorCode(code)` |
| `contracts.ts:81` (đường đọc) | inline, **giống hệt** | `isRetryableErrorCode(...)` |
| `server.ts:76-88` (envelope) | không có | forward `connectorError.safeToRetry` |

Hàm mới ở `errors.ts:17-23`. Tập retryable **đúng bằng** hai mã cũ — tôi không thêm mã nào, vì dispatch yêu cầu *theo taxonomy hiện có* và thêm mã là đổi ngữ nghĩa chứ không phải sửa hồi quy.

**Cố ý loại trừ, và vì sao:**

- `PROVIDER_REQUEST_REJECTED` — chính là lỗi A-1.
- `INVOCATION_UNKNOWN` — kết quả chưa chắc, phải **reconcile** với ledger chứ không replay (`invoke.ts` nhiều chỗ gọi `markUnknown` chứ không `fail`).
- `QUOTA_EXHAUSTED` — thoạt nhìn có vẻ transient và đúng là vậy ở `invoke.ts:261`. Nhưng nó **không bao giờ** được ghi thành `error_code` của record: nhánh hết quota gọi `ledger.markPending` để retry, không gọi `fail`. Thêm nó vào đây là thêm một nhánh chết.

Hướng fail-closed: `isRetryableErrorCode` là `Set.has`, nên một mã không nhận ra trả `false` — không retry. Ở `contracts.ts:80-83` tôi để cast sang `ConnectorErrorCode` và ghi rõ cast đó an toàn **theo hướng fail-closed**.

## §4 Test

| File | Nội dung | Số test |
|---|---|---|
| `services/connector/tests/retry-signal-passthrough.test.ts` | mới | 20 |
| `packages/connector-client/tests/retry-signal-passthrough.test.ts` | mới | 8 |
| `services/connector/tests/provider-rejection-diagnostics.test.ts:205` | sửa assertion envelope của 2c | — |

Phía service (20): 2 mã transient và 12 mã từ-chối/lỗi vĩnh viễn bằng `test.each`; `invokeAdapter` ném đúng `safeToRetry` cho 400/429/503; và **envelope HTTP thật qua loopback** — 502 kèm `retryable:false` cho từ chối, `retryable:true` cho outage, `retryable:true` cùng `retryAfterMs` cho 429.

Phía client (8): wire có field thì 502 từ-chối ra `false`; và một test chiều ngược lại (**400 kèm `retryable:true` ra `true`**) để chứng minh client *đọc field* chứ không phải chỉ đặc biệt hoá 502; wire thiếu field thì fallback phân biệt từ-chối, outage, 429 và 400; và một `state:'FAILED'` mang `retryable` vẫn parse được qua contract đóng băng.

Một test của tôi ở turn trước **đã đỏ** sau thay đổi này: `provider-rejection-diagnostics.test.ts:205` ghim envelope cũ không có `retryable`. Tôi cập nhật kèm chú thích trỏ sang file test mới. Đây là hành vi mới đúng, không phải regression.

## §5 Kết quả chạy — exit code literal

| Lệnh | Kết quả | Exit |
|---|---|---|
| `pnpm --filter @du/connector test` | 23 suite pass, 1 fail, 2 skip — **298 passed / 1 failed / 7 skipped / 306 total** | **1** |
| `pnpm --filter @du/connector-client test` | 5 suite pass, 1 skip — **39 passed / 1 skipped / 40 total** | **0** |
| `pnpm --filter @du/connector exec tsc --noEmit` | sạch | **0** |
| `pnpm --filter @du/connector-client exec tsc --noEmit` | sạch | **0** |
| `pnpm --filter @du/worker-sdk test` (consumer, ngoài acceptance) | 23/23 suite — **645 passed / 645 total** | **0** |

**Suite connector exit 1, nói rõ nguyên nhân:** đúng một test, `p8-03-convergence.test.ts` USE-02, `connect ECONNREFUSED 127.0.0.1:5433`. Đây là test **live-PG** seed row thật (`:636-652`) và PostgreSQL không chạy. Không liên quan thay đổi này, không phải test tôi sửa. Baseline đã được coordinator ghi ở `dispatch-specs/2026-10-02-1028-postcommit-offline-regression.md:11`.

worker-sdk **645/645**, đúng baseline ở `:12` của cùng file spec.

## §6 Additive — consumer cũ không bị ảnh hưởng

- Thêm field. Không xoá, không đổi tên, không đổi kiểu của field cũ.
- `error.retryable` đã nằm sẵn trong `packages/connector-client/src/types.ts:25-26` và trong `InvocationResponseSchema` (`contracts/connector.ts:117`), nên consumer đọc field này không cần đổi gì.
- Client **đọc** wire trước, fallback sau: một peer cũ gửi khoảng trống thì hành vi rơi về đúng heuristic cũ, trừ đúng case đã sửa.
- `retryAfterMs` vẫn optional và vẫn được đọc như trước.

## §7 Còn mở, không làm trong turn này

**Đường POST đồng bộ của worker vẫn làm mất mã.** `packages/worker-sdk/src/connector-invoker.ts:145` chỉ parse code cho 401/403/409, nên `PROVIDER_REQUEST_REJECTED` vẫn bị ép thành `PROVIDER_UNAVAILABLE`.

Phần retry **đã đúng** và không cần gì: `worker.ts:519` dùng `=== 503` nên 502 ra `retryable:false`. Nên đây vẫn là **mất chẩn đoán**, không phải retry mù — đúng như audit đã kết luận.

Tôi **không** sửa vì dispatch giới hạn phạm vi ở `services/connector/src/**` và `packages/connector-client/src/**`; `worker-sdk` không thuộc hai đó. Đây vẫn là phương án 1 trong audit §5, chờ coordinator phân bổ.

Ngoài ra: message trên đường đọc vẫn là chuỗi tổng quát `'Invocation did not complete.'` (`services.ts:404`) vì ledger chỉ persist `error_code`, không persist message. Sửa cần migration — ngoài phạm vi, tôi không đụng.

## §8 Phạm vi và giới hạn

- Chỉ chạm `services/connector/src/**`, `packages/connector-client/src/**` và test của hai package đó. `git diff --stat` xác nhận không file nào ngoài phạm vi.
- **Không chạy live.** Không PostgreSQL, không provider thật. Envelope được kiểm qua HTTP thật trên loopback trong process, không phải với service đang chạy.
- Test mới dùng `listenLoopback` với dải cổng riêng `43620+` cho service, theo quy ước `tests/harness/listen-loopback.ts` tránh dải ephemeral của Windows.
- Tôi **không** chạy lại `@du/contracts` vì turn này không sửa `packages/contracts`; kết quả ở turn 2c là 462/464 với 2 red có sẵn đã được coordinator ghi.
- Phép so sánh trong §2 là **suy ra từ mã** và đã được test khoá bằng wire có/thiếu field; chưa có bằng chứng chạy với một peer cũ thật. Nói rõ là chưa.
- `packages/connector-client` thuộc lane khác (Copilot lane); coordinator đã phân bổ nó cho turn này, tôi sửa trong phạm vi được giao.
- Không tick gate, không commit, không nhắm `nocobase-10`.
