# COMP01-Q15 CLOSE 1-HOP — decoded `callback.url` tới delivery path (READ-ONLY)

**Spec:** `coordination/dispatch-specs/2026-10-02-0955-COMP01-Q15-close-1hop.md`
**Nền:** `cmdcomp01-q15-1hop-2026-10-02.md` + `qwen-comp01-q15-consumer-inventory-2026-10-02.md` §9.2
**Status:** characterization read-only. Chỉ ghi file receipt này; không sửa source; không tick gate; không commit; không giao implementation; không nhắn `nocobase-10`; không đọc giá trị secret; không chạy test/build.

---

## 1. Verdict từng hop (acceptance #1)

| Hop | Verdict | file:line | Nội dung |
|---|---|---|---|
| (a) `submitLegacy` dùng decoded callback thế nào | **CONFIRMED** | `legacy-host-adapter.ts:51`, `:65-79`, `:77` | Forward `decoded.submission.callback` verbatim vào `ctx.submission.submit({ submission: {...} })` |
| (b) `submission.ts` có ghi `operations.callback_url` không | **CONFIRMED** | `submission.ts:284-318` — cột `:287`, bind `:290` ($11), giá trị `:303` | INSERT `callback_url = submission.callback?.url ?? null` |
| (c) call-site `maybeScheduleWebhook` ở terminal transition | **CONFIRMED** | `runtime.ts:567-572` (SUCCEEDED), `:672-677` (FAILED), `:1236-1243` (LEASE_EXPIRED), `:1459-1464` (JOIN_FAILED); scheduler `webhooks.ts:59-100` | Gọi trong CÙNG tx, ngay sau `UPDATE operations` terminal |

### (a) — decoded callback được dùng thế nào

`legacy-host-adapter.ts:51` `submitLegacy: async (principal, action, decoded) => {` … `:65-79`:

```ts
65:       const result = await ctx.submission.submit({
...
72:         submission: {
73:           input: decoded.submission.input,
74:           output: decoded.submission.output,
75:           ...(artifacts.length > 0 ? { artifacts } : {}),
76:           ...(decoded.submission.sourceUrl === undefined ? {} : { sourceUrl: decoded.submission.sourceUrl }),
77:           ...(decoded.submission.callback === undefined ? {} : { callback: decoded.submission.callback }),
78:         },
79:       });
```

Không transform, không drop: decoded callback đi thẳng vào seam `ctx.submission.submit`.

### (b) — `callback_url` được ghi từ submission callback

`submission.ts:145` `SubmissionSchema.safeParse(ctx.submission)` → `:284-289` INSERT 16 cột có `callback_url` → `:303`:

```ts
301:             // P2-08: callback destination pinned at submit (docs 06). The
302:             // webhook scheduler reads this on the terminal transition.
303:             submission.callback?.url ?? null,
```

Vị trí bind $11 khớp cột thứ 12 (`:290` `VALUES ($1,...,$11,...)` sau literal `1` cho `state_version`). Shape hợp lệ theo contract: `packages/contracts/src/operations.ts:264-279` `CallbackConfigSchema = { url: string().url().superRefine(adjudicateUrlDestination) }`; `:290` `callback` optional trong `SubmissionSchema` (`.strict()`).

### (c) — call-site ở terminal transition

`runtime.ts` — cả hai đường terminal của một operation, mỗi lệnh gọi nằm trong cùng transaction với UPDATE terminal:

```ts
567:         await client.query(`UPDATE operations SET state='SUCCEEDED', state_version = state_version + 1, ...`);
572:         await maybeScheduleWebhook(client, t.operation_id);   // completeTask, tx mở tại :508
...
672:         await client.query(`UPDATE operations SET state='FAILED', state_version = state_version + 1, ...`);
677:         await maybeScheduleWebhook(client, t.operation_id);   // failTask, tx mở tại :582
```

Hai call-site cùng class trong `runtime.ts`: `:1236-1243` (sweepExpiredLeases, retry budget cạn → `FAILED` + `LEASE_EXPIRED`) và `:1459-1464` (`reconcileParentJoin` fail branch → `JOIN_FAILED`).

Scheduler `webhooks.ts:59-100`: `:61` SELECT `callback_url`; `:73` không có URL → return; `:74` không terminal → return; `:86-93` INSERT `webhook_deliveries` (ON CONFLICT unique `(operation_id, state_version, destination_url)` → idempotent).

---

## 2. Chain hoàn chỉnh — decoded `callback.url` → fetch (file:line)

| # | Hop | file:line | Nội dung |
|---|---|---|---|
| 0 | Mount live | `server.ts:69-70` import; `:1751` `handleLegacyRoute(...)`; `:1764` `legacyCompatHost(ctx)` | Compat đang trên request path |
| 1 | Mount decode | `legacy-http-mount.ts:32` import `decodeLegacyWire`; `:419` `decodeLegacyMultipart`; `:281-286` `decodeLegacyWire(action, ...)` | Nhánh submit 6 core actions (`:390-455`) |
| 2 | Decoder | `legacy-wire-decoders.ts:191-193` đọc alias `webhook_url`/`webhookUrl` + canonical `callback`; `:427-439` `decodeCallback` trả `{url}`; `:238-243` gán `submission.callback`; `:251-271` return; `:264` cờ `presence.callback` | `callback.url` nguyên vẹn trong decoded return |
| 3 | Hand-off | `legacy-http-mount.ts:442-446` `await host.submitLegacy?.(principal, docs.action, decoded.decoded)` | Mount chỉ quyết định wire; host sở hữu admission/artifact/queue |
| 4 | Host | `legacy-host-adapter.ts:77` forward `callback` → `ctx.submission.submit` | Hop (a) |
| 5 | Wiring service | `server.ts:513` `createSubmissionService(db, registry, profiles, {...})`; `:791` RouteContext nhận `submission`; interface `:1178` | Cùng một instance tới `ctx.submission` |
| 6 | Persist | `submission.ts:145` schema; `:287`/`:290`/`:303` INSERT `callback_url` | Hop (b) |
| 7 | Terminal | `runtime.ts:567-572` (SUCCEEDED) / `:672-677` (FAILED) (+ `:1236-1243`, `:1459-1464`) | Hop (c) |
| 8 | Schedule | `webhooks.ts:59-100` → row `webhook_deliveries` | Cùng tx với terminal UPDATE |
| 9 | Dispatcher wiring | `server.ts:920-945` `webhookTimer` → `deliverWebhooks(db, {...})`; bật khi `webhookIntervalMs > 0 && config.webhookSecret` (`:922`), default 5s (`:696-697`) | Production path có thật |
| 10 | Dispatch + fetch | `webhooks.ts:313-542` — claim `:354-388`, adjudicate destination `:426-433`, body/sign `:439-457`, POST `:450-459`, retry/backoff `:521-537` | Leg cuối |

**Không còn hop mù** trong chuỗi tĩnh: mọi mắt đã đọc nội dung và đối chiếu file:line.

---

## 3. Kết luận cuối (acceptance #2)

**REACHABLE** — decoded `callback.url` đi được từ wire tới delivery path trên mounted route, ở mức code-path tĩnh:

`legacy-wire-decoders.ts:427-439` → `:242` → mount `:442-446` → host `:77` → `submission.ts:303` (`operations.callback_url`) → runtime terminal `:572`/`:677` → `webhooks.ts:59-100` (`webhook_deliveries`) → `server.ts:928` dispatcher → `webhooks.ts:450-459` fetch.

**Gap còn lại chính xác (không overclaim):**

1. **Chưa live-proven.** Toàn bộ evidence là static code-path reading; chưa chạy server/DB nên chưa quan sát một row `webhook_deliveries` hay một POST thực phát sinh từ legacy submit. Evidence class = structural; live E2E vẫn là gap.
2. **Dispatcher config-gated.** Delivery chỉ chạy khi `config.webhookSecret` được set và `webhookDispatchIntervalMs !== 0` (`server.ts:922`; default 5s tại `:696-697`). Không set secret → disabled by design (fail-closed) — điều kiện vận hành, không phải lỗi code.
3. **Không claim webhook parity** (acceptance #3). Rework delivery khác legacy có chủ đích: HMAC signature (`webhooks.ts:107-110`, `:447`, `:452-457`), destination adjudication trước connect (`:426-433`), submit-time URL adjudication (`operations.ts:264-279`), optional tenant encryption (`webhooks.ts:210-223`). Legacy unsigned + destination không validate — **MUST-NOT-REPLICATE: chỉ ghi nhận factual, không mô tả cách tái hiện**. REACHABLE ≠ parity.
4. **Call-site ngoài phạm vi (c)**: grep thấy `lifecycle.ts:65,97` và `ingestion-consumer.ts:455` nhưng không đọc nội dung trong pass này — note completeness, ngoài 3 hop spec yêu cầu.
5. **Decoder thứ hai không mount**: `legacy-input-decoders.ts` cũng có xử lý callback (`:310-330`) nhưng không có importer trong `src/` (grep toàn repo: chỉ `tests/compat-decoders.test.ts:6` + docs). Live mount dùng `legacy-wire-decoders` (`legacy-http-mount.ts:32`). Ghi nhận để tránh nhầm hai decoder khi đọc tiếp.

---

## 4. Phạm vi / giới hạn

- **Đọc nội dung:** 3 điểm spec (a)(b)(c) + các file cần trực tiếp để chốt verdict: `legacy-wire-decoders.ts:180-274,418-442` (đối chiếu decode leg), `legacy-http-mount.ts:383-467` (hand-off), `server.ts:495-564,775-859,890-969` (wiring + dispatcher), `packages/contracts/src/operations.ts:240-299` (shape callback).
- **Grep metadata:** `callback_url|callbackUrl`, `maybeScheduleWebhook`, `createSubmissionService`, `deliverWebhooks`, `handleLegacyRoute|legacyCompatHost`, `webhookIntervalMs|webhookSecret`, `legacy-input-decoders`.
- **Không đọc:** nội dung `lifecycle.ts`, `ingestion-consumer.ts` (chỉ grep định vị); không đọc secret values.
- Không chạy test/build; không sửa source; không mount; không tick gate; không commit; không giao COMP-02..09 (COMP-00 chưa mở).
