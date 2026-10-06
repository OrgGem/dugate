# CR06-04 — Provider session sống sót qua pending-yield (async 202 → PendingInvocationError → resume)

- Task: CR06-04 / MEDIUM (`CODE-REVIEW-FOLLOWUP-2026-10-06.md`), parent P3/P4 async; owner Connector + worker-sdk
- Owner: OpenCode (`oc_3`), lane Connector + worker-sdk
- HEAD tham chiếu: `b088eec` (worktree **dirty**, nhiều lane đang mở — xem §7)
- Constraints honored: **không commit, không tick, không push**; offline only (NO PostgreSQL/Redis/S3/Vault/live provider); chỉ ghi receipt + source/test trong phạm vi Connector/worker-sdk/contracts
- Status: **IMPLEMENTED + offline-verified**; **independent VFY + Claude review còn thiếu. Không tuyên bố VERIFIED/ACCEPTED, không tick parent.**

## 0. TL;DR

- Quyết định contract: provider **được phép** trả `sessionRef` ở body 202 accept; Connector persist vào pending record (`connector_invocations.session_ref`, migration 009), trả top-level `sessionRef` trên mọi response PENDING/GET, **re-attach session đã lưu vào provider request ở poll đến hạn** (cùng Idempotency-Key/invocationId/inputHash — không blind retry), và giữ session khi result cuối không echo lại.
- worker-sdk: `classifyInvocation` mang session lên `pending-yield`; `PendingInvocationError.sessionRef` giữ token (property, không vào message/log); resume dùng lại đúng invocationId, Connector khôi phục session từ pending record.
- Test async-202 mang sessionRef end-to-end qua **real Connector HTTP boundary + mock provider loopback**; resume trước-due không dispatch lại; poll đến hạn giữ session; kết quả cuối omit session vẫn giữ. Kèm negative fail-closed cho sessionRef sai kiểu.
- Toàn bộ suite offline liên quan xanh: connector unit 30 suite/377 pass/1 skip; worker-sdk 30 suite/702 pass/1 todo; contracts 27/527; connector-client focused 4/32; 3× focused cho 2 lane CR06-04 đều exit 0.

## 1. Quyết định contract (bắt buộc theo acceptance)

**Provider MAY trả `sessionRef` trong 202 accept body** (không bắt buộc; provider vẫn có thể chỉ trả ở result cuối). Khi 202 có `sessionRef`:

1. `null`/vắng = "không có session mới" (không ghi đè session đã lưu); chuỗi non-empty được nhận; sai kiểu/chuỗi rỗng → fail-closed `INVALID_PROVIDER_RESPONSE` (ledger FAILED, không gọi provider thêm).
2. Session được persist trên **pending record** của Connector (`session_ref`, first non-null wins — COALESCE) và trả ở top-level `sessionRef` của mọi `PENDING` response, kể cả replay trước `nextPollAt`; `GET /invocations/{id}` cũng trả.
3. Ở lần poll đến hạn, Connector **re-attach session đã lưu** vào provider request, dù request của worker (và canonical hash) vẫn là bản gốc. Grant/hash/invocationId/Idempotency-Key **không đổi** → replay đúng một provider execution, không blind retry.
4. Khi invocation hoàn tất: `result.sessionRef` do provider trả **thắng** (provider có thể xoay session); nếu provider omit, session đã lưu ở pending record được giữ làm continuation.
5. Live provider-session semantics (provider thật có honor session không, có chấp nhận sessionRef khi replay không) **vẫn thuộc live window** (`LIV-SS-01`), không claim trong packet này.

Wire change: `InvocationResponseSchema` thêm top-level `sessionRef: z.string().nullable().optional()` — additive, wire cũ giữ nguyên khi provider không trả session.

## 2. Producer/consumer và đường đi thay đổi (sau khi sửa)

| Chặng | File:line | Hành vi |
|---|---|---|
| Provider → Connector (202 parse) | `services/connector/src/invoke.ts:431-445` | validate + nhận `sessionRef` từ 202 body |
| Pending record | `services/connector/src/invoke.ts:465-473` → `types.ts:183-193` → `ledger.ts:160-183` / `db/repository.ts:199-236` (`session_ref = COALESCE($9, session_ref)`) | lưu first non-null; migration `009_connector_invocation_session_ref.sql` |
| Connector → worker (wire) | `contracts.ts:44-57,95-98`; `services.ts:152-170,412-425`; `http/server.ts:11-25` | top-level `sessionRef` trên PENDING/SUCCEEDED/GET |
| Poll replay | `invoke.ts:303-314` (storedSessionRef/providerInput) + `:350-363` | re-attach session vào provider call, identity giữ nguyên |
| Completion fallback | `invoke.ts:501-509` | result-side thắng; fallback stored pending session |
| Worker-sdk classify | `packages/worker-sdk/src/connector-session.ts:100-119` | pending-yield mang `sessionRef`; result fallback top-level |
| Worker-sdk yield error | `connector-session.ts:160-186,245-252` | `PendingInvocationError.sessionRef`; không leak vào message |
| Contract schema | `packages/contracts/src/connector.ts:131-142` | top-level `sessionRef` optional |
| Docs | `docs/08-connector-api.md` (Response shape + mục "Async 202 và sessionRef (CR06-04)") | chốt hành vi |

`runConnectorStep` không đổi shape: pending vẫn **không** ghi checkpoint (resume phải re-enter step); durable carrier là pending record phía Connector + typed error phía SDK.

## 3. File thay đổi + SHA-256 (tại thời điểm viết receipt)

| File | SHA-256 |
|---|---|
| `services/connector/src/invoke.ts` | `2276B94BDD950DEDE8B66AB53D3D5D16401CC54743003327CE2E55C7AF264920` |
| `services/connector/src/types.ts` | `F1B36B09A1EAC3E264386F10E549E027D8E4EDB269C19B9EB87211E57B0BC822` |
| `services/connector/src/ledger.ts` | `A048730127EA74D516E3D093FBAD97F75E2FB944480931E88E42C91CCA492B8C` |
| `services/connector/src/services.ts` | `216EDA58FDFD43893CE0CD557FC1AA6BE0B119D55AEF4EA1BDF1E7303F645C55` |
| `services/connector/src/contracts.ts` | `7D5D36879FA4C9747F429CDE7CCFF143FB089527973C43C9ED1488E9E30CB42A` |
| `services/connector/src/http/server.ts` | `586F84DB111A43D020168EE0781B86133E44DA60C92E7EAECCDD3D71FA35F97D` |
| `services/connector/src/db/repository.ts` | `46891F2C451E48184E988215B45078F94FC4744998FB05342E688B96F35623C7` |
| `services/connector/src/db/pg-client.ts` | `4D1F1C7868236E3AFB5BA2CF42CA746A283C1E0E8B8DE79ABCBF759429EA3C6C` |
| `services/connector/src/db/migrations/009_connector_invocation_session_ref.sql` (new) | `04A5947F4E80C243BD577AC2A9C9B27089B511887B639735C00C562B63F4F1D5` |
| `packages/contracts/src/connector.ts` | `328CB8E29C0A3DB576E798E1B5AE2E14694BCFD325E30BD12B796783BF93573D` |
| `packages/worker-sdk/src/connector-session.ts` | `13D4A729E93A085B5BC02B3E7D880EDC618D375DCE22A7CADADD292A7294C90C` |
| `services/connector/tests/cr06-04-async-202-session.test.ts` (new) | `6455B483D4C0804116A5DECF506F52F454CFADDA7FD9EBC6A5F9F40E0639A37F` |
| `services/connector/tests/cr06-04-session-ref.schema.test.ts` (new) | `C1D24FEEC9CB106D3C3FF0D42C7466ABCE38273D0AB854E339F107002F64D503` |
| `packages/worker-sdk/tests/connector-session.test.ts` | `87CFB02D4B02A3226DBFE160F4244F253E48218331144B0771B5570CDDD2C817` |
| `docs/08-connector-api.md` | `C0DA0E257A10B3305D0E0CF9EB7F7D42BD84C55BA334D03F4E5746E6694D8AAB` |

Lưu ý cộng sinh worktree (không phải hunk CR06-04): `packages/contracts/src/connector.ts` còn delta P745-CONNECTOR-PASSTHROUGH (`InvocationOptionsSchema` strict + responseFormat/jsonSchema); `services/connector/src/http/server.ts` còn delta **CR06-05** (identity fail-closed + `allowUnauthenticatedTestTraffic`); `packages/worker-sdk/src/types.ts` mang delta W1b từ trước (packet này **không sửa** file đó).

## 4. Test async-202 end-to-end + resume (mock provider) — nội dung

`services/connector/tests/cr06-04-async-202-session.test.ts` (7 test, offline):

- **invokeAdapter**: 202 trả `sess-async-a` → pending record lưu; replay trước due trả lại session, **provider.calls giữ 1** (không dispatch lại); poll đến hạn gửi provider body `sessionRef: sess-async-a` với **cùng Idempotency-Key**; provider final body omit session → result vẫn giữ `sess-async-a`; tổng provider calls = 2.
- **HTTP e2e real boundary** (`createConnectorServer` + `DurableConnectorRuntime` + `FetchProviderTransport` + loopback mock provider): 202 wire top-level `sessionRef`; `GET /invocations/{id}` trả session; resume trước due → 202 + session, provider calls không tăng; resume sau due → 200 `SUCCEEDED`, `result.sessionRef` + top-level session giữ nguyên dù provider body omit; 2 dispatch cùng Idempotency-Key.
- **Negative**: 202 `sessionRef` ∈ {`42`, `''`, `['sess']`, `{}`} → `INVALID_PROVIDER_RESPONSE`, record `FAILED`; `null`/vắng giữ wire session-less cũ.
- `cr06-04-session-ref.schema.test.ts` (3 test, read-only): migration 009 replay-safe (`ADD COLUMN IF NOT EXISTS ... TEXT`, không NOT NULL); đăng ký trong `PgSqlClient.migrate()` sau 008; SQL `markPending` + mapping đọc `session_ref`.

`packages/worker-sdk/tests/connector-session.test.ts` (thêm 6 test CR06-04, tổng 63):

- `classifyInvocation` pending mang top-level session; missing → `null`; SUCCEEDED result omit session → fallback top-level; schema từ chối session sai kiểu.
- `PendingInvocationError.sessionRef` giữ token và **message không chứa token** (không leak log).
- `runConnectorStep` 2 delivery: delivery 1 pending `sess-async-1` → error mang session, **0 checkpoint**; delivery 2 resume → cùng invocationId + inputHash, `out.sessionRef = sess-async-1`, checkpoint chỉ chứa session **đã gửi** (delivery này không biết token nên không có key — capture cho lượt sau thuộc seam CR06-03).
- Malformed top-level session fail-closed trước khi checkpoint.

## 5. Evidence (offline; literal)

| Command (cwd) | Kết quả literal |
|---|---|
| `npx tsc -p tsconfig.json` (`packages/contracts`) | exit **0** |
| `npx tsc --noEmit -p tsconfig.json` (`services/connector`) | exit **0** |
| `npx tsc --noEmit -p tsconfig.json` (`packages/worker-sdk`) | exit **0** |
| `npx jest tests/cr06-04-async-202-session.test.ts tests/cr06-04-session-ref.schema.test.ts --runInBand` ×3 (`services/connector`) | mỗi lần **2 suites / 10 tests passed**, exit **0** |
| `npx jest --config jest.unit.config.cjs --runInBand --forceExit` (`services/connector`) | **30 suites passed / 377 passed, 1 skipped, 378 total**, exit **0** (DB suites `black-box-durable`/`durable-integration` bị unit config loại trừ) |
| `npx jest tests/connector-session.test.ts --runInBand` ×3 (`packages/worker-sdk`) | mỗi lần **1 suite / 63 tests passed**, exit **0** |
| `npx jest --runInBand` (`packages/worker-sdk`) | **30 suites passed / 702 passed, 1 todo, 703 total**, exit **0** |
| `npx jest --runInBand` (`packages/contracts`) | **27 suites / 527 tests passed**, exit **0** |
| `npx jest tests/transport.test.ts tests/sdk-invoker.test.ts tests/client.test.ts tests/retry-signal-passthrough.test.ts --runInBand` (`packages/connector-client`) | **4 suites / 32 tests passed**, exit **0** |
| `git diff --check -- services/connector packages/worker-sdk packages/contracts docs/08-connector-api.md` | exit **0** (chỉ còn warning LF→CRLF của git, không phải whitespace error) |

Môi trường: Node **v22.16.0** (package engines ghi >=24 — đây là runtime test của máy hiện tại), jest 29 + ts-jest, **offline hoàn toàn**: không DB/Redis/S3/Vault/live provider; ports loopback quiet band 441xx/444xx.

Không chạy (thiếu điều kiện): `black-box-durable.test.ts`, `durable-integration.test.ts`, `revision-binding.db.test.ts` (cần PostgreSQL), `connector-client/tests/real-service.test.ts` + `network-boundaries` (live/real-service window), mọi live provider test.

## 6. Không blind retry — kiểm chứng cụ thể

- Replay trước `nextPollAt`: Connector trả pending từ record, **0 dispatch mới** (test e2e: `provider.calls() === 1`).
- Poll đến hạn chỉ chạy khi claim CAS `PENDING→POLLING` thành công; cùng invocationId/inputHash; cùng Idempotency-Key (test assert cả 2 dispatch).
- worker-sdk resume dùng lại stable grant/hash: test assert `ledger.issued[0].invocationId === issued[1].invocationId` và inputHash bằng nhau.
- Session không tham gia quyết định retry: `PendingInvocationError` vẫn `retryable: true` + `retryAfterMs` như cũ; `classifyFailure` giữ `PROVIDER_PENDING`.

## 7. Honest limits / open items

- **Live provider-session semantics chưa chứng minh** (provider thật có đọc `sessionRef` 202 và có chấp nhận nó khi replay không) — thuộc live window `LIV-SS-01`; mock provider chỉ chứng minh contract phía Connector/SDK.
- **PG path chỉ pin tĩnh**: SQL `markPending`, mapping `toRecord`, migration 009 được test schema read-only + unit in-memory; chưa chạy trên PostgreSQL thật (zero-DB rule). DB e2e là hạng mục VFY/window riêng.
- **Worktree dirty / cộng sinh lane**: `services/connector/src/http/server.ts` đang mang delta CR06-05 chưa settle; `packages/contracts/src/connector.ts` mang delta P745-CONNECTOR-PASSTHROUGH. Hunk CR06-04 của tôi trong 2 file này là phần `sessionRef` (server.ts:19-25; connector.ts:131-142). Owner/Tester **re-read sau rebase/các lane settle** trước khi verify.
- **Template vendor chưa re-vendor**: `businesses/document-core/template/vendor/worker-sdk/src/connector-session.ts` là snapshot pinned `@ b088eec` (provenance header trong file) → chưa mang fix CR06-04; đề nghị redistribution owner re-vendor sau khi các lane land (không tự phá provenance trong packet này).
- `markPending` thêm tham số positional thứ 7 (`sessionRef?`) — additive, các wrapper 6 tham số vẫn assignable; nếu muốn options-object hoá là refactor riêng.
- `docs/19/28/35` (traceability/test inventory/acceptance baseline) chưa sync — thuộc docs owner; `docs/08` đã cập nhật mục "Async 202 và sessionRef (CR06-04)".
- Packet này không làm CR06-03: việc capture session trả về vào slot checkpoint cho multi-turn là seam document-core CR06-03 (đã có), CR06-04 chỉ bảo đảm session không mất qua pending-yield.

## 8. Handoff

- **Independent verification nên nhắm**: SHA-256 §3; chạy lại 2 suite CR06-04 + `connector-session.test.ts`; kiểm negative session sai kiểu; kiểm assert "không dispatch trước due" và Idempotency-Key parity; chạy full unit connector + worker-sdk. DB/Vault/live giữ theo window riêng.
- **Claude Code review** quyết acceptance per gate; coordinator settle CR06-04 (không tick parent, không mở gate mới).
- Không commit/push; không tick; không sửa file ngoài phạm vi liệt kê.
