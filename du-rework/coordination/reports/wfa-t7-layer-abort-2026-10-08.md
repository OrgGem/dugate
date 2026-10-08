# WFA-T7 layer 3 — abort signal xuống connector service (nói theo dispatch: `wfa-t7-layer-abort-6--8.md`)

> [!IMPORTANT]
> RESUME POINT (2026-10-08): **CHƯA SỬA FILE NÀO.** Layer 1+2 đã land (phiên trước, xem §2).
> Layer 3 = `orchestrator/services/connector/src/{invoke.ts,services.ts}` — chưa động tới vì hết context.
> Việc kế tiếp: đọc `services.ts` (đường `cancel`), thêm registry invocationId→AbortController trong `invoke.ts`,
> abort khi cancel tới, rồi fail-first test `services/connector/tests/wfa-t7-abort-invoke.test.ts` (đỏ trước),
> xanh sau, mutation control (revert → phải đỏ → khôi phục, hash byte-for-byte), `tsc --noEmit`, rồi chốt receipt tại đây.
> Không commit/push. Không chạm `services/orchestrator/src/**`, `worker-sdk/src/**`, `businesses/**`, tests lane khác, docs/21-openapi.json, legacy root.

> [!NOTE]
> RESUME POINT trên là trạng thái **trước khi sửa** (handoff của phiên trước). Đã XONG ở §5 — supersede mục 0.

## 1. Lease duy nhất (task packet)

- `du-rework/orchestrator/services/connector/src/invoke.ts`
- `du-rework/orchestrator/services/connector/src/services.ts`
- Test mới của task: `du-rework/orchestrator/services/connector/tests/wfa-t7-abort-invoke.test.ts`

## 2. Layer 1+2 đã land (không sửa lại, nằm ngoài lease này)

| Layer | File:line | Nội dung |
|---|---|---|
| 1 | `worker-sdk/src/worker.ts:373` | heartbeat `ctx.abort("cancel")` (có sẵn từ trước) |
| 2 | `worker-sdk/src/task-context.ts:94` + `:924` | deps type + `invokeConnector(grant, payload, self.signal)` |
| 2 | `worker-sdk/src/types.ts` | `ConnectorInvokeFunction` + `signal?: AbortSignal` |
| 2 | `worker-sdk/src/connector-invoker.ts` | signal → fetch `AbortController`; on-abort bắn `POST {baseUrl}/invocations/{id}/cancel` (auth + `x-invocation-grant`); invoke bị abort → `CANCELLED` (409) |

Evidence: WFA-T27 (`t27-after-signal-cancel-node24-2026-10-07.log`, exit 1) đã đi qua connector stage, cancel trả 200 — nhưng provider request KHÔNG bị abort (timeout 30 s).

## 3. Đo được về layer 3 (nền cho fix)

- `invoke.ts:367` `response = await options.transport.send(providerRequest, controller.signal);` — **đã có** controller trong `invokeAdapter` (dùng cho deadline/abort ở `:368`, `:380`), và `ProviderTransport.send(request, signal?)` (`invoke.ts:42`) **đã nhận** signal.
- `ledger.ts:124-130` `cancel()` **cho phép** `IN_FLIGHT` (chỉ set state CANCELLED).
- ⇒ Seam còn thiếu đúng một mắt xích: **không có registry nối `invocationId` → controller** đó, nên cancel tới không thể abort `send` đang chạy. Fix tối thiểu: registry trong `invoke.ts` (đăng ký quanh `send`, xoá khi settle) + `services.ts` gọi abort trong đường cancel.

## 4. Verify (chạy từ `du-rework/orchestrator/services/connector`)

```
node node_modules/jest/bin/jest.js --runInBand --config <config-cua-repo> --silent --runTestsByPath tests/wfa-t7-abort-invoke.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Chưa có test nào đỏ cho case này (T27 đỏ là evidence khác, thuộc harness `tests/workflow-api/` của lane trước). Nếu không dựng được case đỏ thì ghi "pre-existing green", không bịa.

## 5 — CYCLE 2 (2026-10-08): HOÀN THÀNH — fix + evidence (bổ sung, RESUME POINT phía trên giữ nguyên như cũ)

### Fix (chỉ 2 file trong lease)

| File | Vị trí | Nội dung |
|---|---|---|
| `services/connector/src/invoke.ts` | ngay trước `export async function invokeAdapter` (~:60-73) | module-level `inFlightProviderDispatches = new Map<string, AbortController>()` + export `abortInFlightProviderDispatch(invocationId): boolean` |
| `services/connector/src/invoke.ts` | sau `const controller = new AbortController();` (~:359) | `inFlightProviderDispatches.set(request.invocationId, controller)` — đăng ký đúng controller gửi vào `transport.send` |
| `services/connector/src/invoke.ts` | `finally` của khối send (~:406) | unregister có điều kiện (`get(id) === controller`) để không xoá đăng ký của lần dispatch mới hơn |
| `services/connector/src/services.ts` | `:4` | import `abortInFlightProviderDispatch` từ `./invoke` |
| `services/connector/src/services.ts` | trong `DurableConnectorRuntime.cancel`, ngay sau `this.ledger.cancel(...)` (~:187) | gọi `abortInFlightProviderDispatch(invocationId)` — cancel chạm tới socket provider, không chỉ đảo trạng thái ledger |

Không file nào ngoài 2 file lease bị sửa. Test mới: `services/connector/tests/wfa-t7-abort-invoke.test.ts` — 1 test, drive qua `runtime.cancel` THẬT + `invokeAdapter` THẬT, transport treo tới khi signal abort.

### Fail-first (bắt buộc — có)

- Test viết TRƯỚC khi sửa product source. **RED**: `Expected: true / Received: false` tại `expect(providerAborted).toBe(true)` — cancel trả `state: cancelled` nhưng provider socket KHÔNG bị abort. **Exit Code: 1**. Log: `raw/wfa-t7-abort-2026-10-08/01-fail-first-red.log`.

### Sau fix (xanh)

- `03-after-fix-green.log`: PASS 1/1 **Exit Code: 0** (node v22.16.0); chạy lại sau khôi phục mutation PASS **Exit Code: 0**; tái xác nhận bằng Node **v24.21.0** (theo engine) PASS **Exit Code: 0**.

### Mutation control (bắt buộc — có)

- `git checkout --` cả 2 file → chạy lại test → **RED, Exit Code: 1**, đúng cùng assertion (`02-mutation-revert-red.log`).
- Khôi phục byte-for-byte từ backup `%TEMP%\t7-{invoke,services}.fixed.ts` → SHA-256 trước/sau TRÙNG (`04-hash-mutation-verify.log`):
  - `invoke.ts` = `8967a6b71e70e417af5ae0c3379e20f2fbf54b67893fc4ecb392f1e8e7b411bc`
  - `services.ts` = `55aa2043111cd739cab424f0b464bef5cc1603aeaee0a9933a99587ddb2f0a6a`
- Chạy lại sau khôi phục → PASS Exit Code: 0.

### Verify (literal, cwd `du-rework/orchestrator/services/connector`)

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → Output (empty) → **Exit Code: 0**.
- Regression 3 suite cùng đường cancel/invoke (`connector.test.ts`, `invocation-access.test.ts`, `r1-d-lifecycle-offline.test.ts`): 3 suites / **38 tests passed** → **Exit Code: 0**.
- Chi tiết: `raw/wfa-t7-abort-2026-10-08/05-verify-typecheck-regression.log`.

### Boundary với layer 1/2 (không sửa trong cycle này)

- Layer 1 (`worker-sdk/src/worker.ts:373`) và layer 2 (`worker-sdk/src/{task-context.ts:94,924; types.ts; connector-invoker.ts}`) thuộc lease khác, đã land trước (§2). Cycle này không đụng `worker-sdk/**`, `services/orchestrator/**`, `businesses/**`.
- Đường đầy đủ: heartbeat cancel → `ctx.abort` → signal vào `invokeConnector` (L2) → abort socket + `POST /invocations/{id}/cancel` → `DurableConnectorRuntime.cancel` → `ledger.cancel` **+ abort registry** (L3, cycle này) → `transport.send` signal aborted → provider request dừng.

### Giới hạn CHƯA cover (không tick VERIFIED/ACCEPTED)

1. **Chưa chạy lại end-to-end WFA-T27** (`tests/workflow-api/http-worker.integration.test.ts`; log đỏ trước đó `t27-after-signal-cancel-node24-2026-10-07.log`) — suite thuộc harness/lease lane khác; cần chạy lại ở lane WFA-HANDOVER (mục 5) để chứng minh T27 qua tầng 3.
2. **Chưa chạy live PG/Vault/Redis** — chỉ unit/offline trong package connector (test dùng `InMemoryInvocationLedger`).
3. Registry là **per-process**: dispatch ở tiến trình connector khác tiến trình nhận cancel thì abort không đi tới (cần tín hiệu chia sẻ qua DB/queue — ngoài scope).
4. Chỉ đăng ký **lần dispatch đầu** (send ban đầu); async-202 polling và cancel đến trước-khi-send / sau-khi-settle không có dispatch để abort → `abortInFlightProviderDispatch` trả `false`, ledger vẫn cancel đúng.
5. Không commit, không push, không tick VERIFIED/ACCEPTED, không hand-edit `docs/21-openapi.json`, không dùng legacy root.