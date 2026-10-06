# P745-CONNECTOR-PASSTHROUGH (T5) — whitelist tường minh options → provider body + canonical hash — 2026-10-04

**Packet:** P745-CONNECTOR-PASSTHROUGH (T5, tách từ MEDIUM-1 prep — `p730-medium1-prep-2026-10-04.md` §3 hàng "(T5 riêng)" + §4 mục 4).
**Lane:** cc_3 (`term_58db0267`, `run_069ecd6957cd`). **Repo:** `D:\Git\dugate` (du-rework) — HEAD `b088eececcb5f3df0b4edbe073a29401dafda624` KHÔNG đổi.
**Mode:** offline; KHÔNG commit/push/tick; không chạm file lane khác. **Giờ đo:** 2026-10-04 ~23:50–00:15 +07.

## 0. TL;DR

- **Chọn REJECT (fail-closed), không allowlist-drop**: `InvocationOptionsSchema` (contracts `connector.ts:70`) chuyển `.passthrough()` → **closed allowlist tường minh** = typed keys (`temperature`/`model`/`maxTokens`) + 2 key đang sống `responseFormat` (enum `'json'|'text'`) / `jsonSchema` (record). Key lạ thứ ba → reject ở **cả 2 đầu wire bằng cùng 1 schema** (SDK outbound `connector-invoker.ts:135`, connector inbound `services/connector/src/contracts.ts:21`) → không bao giờ tới provider body hay canonical hash.
- Diff nguồn **duy nhất 1 file**: `packages/contracts/src/connector.ts:64-80`. Ba điểm còn lại của chain **giữ nguyên byte-identical** (SHA-256 không đổi): `connector-invoker.ts:135`, `adapters/http.ts:35,:101`, `hash.ts:22` — đúng theo cấu trúc vì chỉ nhận options đã qua schema.
- Positive pin đủ chain: `responseFormat`/`jsonSchema` → provider body (json + multipart) **và** vào canonical hash (sensitivity + parity `@du/contracts`); key lạ → reject ở 3 tầng test.
- Focused set **3/3 lượt liên tiếp xanh** (contracts 3×45; connector full suite 3×303; worker-sdk 3×117) + re-run xác nhận; full worker-sdk 691 green; connector-client 39 green; scoped typecheck 3 package 0 lỗi.

## 1. Lease-announce (pre-write)

| File (lease) | SHA-256 pre-write | mtime | git (scoped) |
|---|---|---|---|
| `packages/contracts/src/connector.ts` | `4a436a6b3460e0c3848f6a1dbf5c2a1180aa5ea990ba8c86b15f356dd0f5e489` | 2026-09-28T06:44:11Z | clean |
| `packages/worker-sdk/src/connector-invoker.ts` | `a6f8d54cbd813dd9c9e0bed79b7d46ee73641fbdbf2cf04c53ee641574f1ef88` | 2026-10-02T07:05:35Z | clean |
| `services/connector/src/adapters/http.ts` | `8df114af9959f825efe3b03536f9f749c11426f9b1dfdebb8c852ff85626cf6f` | 2026-10-02T05:36:04Z | clean |
| `services/connector/src/hash.ts` | `9b88d361bc758318f4ef48b7ae423c4e5410654627bd9e36bb8c4d010e5c8ac2` | 2026-09-24T17:31:15Z | clean |

3 file test mới tạo trong `tests/` (mục 4). EOL note: working-tree file là **CRLF** (189 CRLF / 0 LF); `git show HEAD:…connector.ts` là blob LF `7021c367…` — chỉ dùng làm bản A/B (mục 5.4), không phải bản pre-write.

## 2. Quyết định contract: REJECT unknown key (4 lý do cốt lõi)

1. **Hash parity không thể làm sạch bằng egress filter**: `inputHash` được tính ở `task-context.ts:877`/`connector-session.ts:296` (ngoài lease) TRƯỚC khi invoker gửi; sanitize/drop ở `adapters/http.ts`/`hash.ts` sẽ tạo "hash chứa key lạ nhưng body không" (hoặc vỡ parity với grant đã ký). Chỉ **reject tại schema** mới đóng cả provider payload lẫn hash influence.
2. **Single source of truth**: cả 2 đầu wire parse chung 1 schema → allowlist không thể drift; fail-closed khớp convention schema family (`InvocationInputSchema`/`InvocationRequestSchema` strict).
3. **Zero migration**: inventory 11 call site sống trong `businesses/**` chỉ gửi `responseFormat`/`jsonSchema` (grep literal `responseFormat: '…'` = toàn bộ `'json'|'text'`); `options` khác duy nhất là typed keys (test) hoặc `{}`. → hành vi với traffic hợp lệ **byte-identical** (options object giữ nguyên ⇒ cùng provider body, cùng hash). Không caller nào cần migrate.
4. **So với allowlist-drop** (giữ passthrough, lọc khi egress): drop âm thầm (caller tưởng provider nhận) + để key lạ tiếp tục vào identity hash — đúng thứ T5 cần đóng. REJECT cho lỗi ồn ào, sửa được ngay.

Case key lạ: `unexpectedOption`/`apiKey`/`systemPrompt` → ZodError trước HTTP (SDK) / 400 INVALID_INPUT (connector); proto keys `__proto__`/`constructor`/`prototype` cũng bị reject tại schema (test pin + assert `Object.prototype` không bị polluted).

## 3. Diff nguồn (duy nhất) + trạng thái 4 điểm chain

```diff
packages/contracts/src/connector.ts:64-80
+/**
+ * P745-CONNECTOR-PASSTHROUGH (T5): explicit, closed option set. The typed
+ * keys plus the two connector passthrough keys the business layer actually
+ * sends (`responseFormat`/`jsonSchema`) are the entire surface forwarded to
+ * a provider and hashed into the canonical invocation input. Anything else
+ * is rejected at both wire ends (SDK outbound + connector inbound) instead
+ * of silently extending the provider payload and the invocation identity.
+ */
 export const InvocationOptionsSchema = z
   .object({
     temperature: z.number().min(0).max(2).optional(),
     model: z.string().optional(),
     maxTokens: z.number().int().min(1).optional(),
+    responseFormat: z.enum(['json', 'text']).optional(),
+    jsonSchema: z.record(z.string(), z.unknown()).optional(),
   })
-  .passthrough();
+  .strict();
 export type InvocationOptions = z.infer<typeof InvocationOptionsSchema>;
```

| # | Điểm packet nêu | Sau fix | SHA-256 |
|---|---|---|---|
| 1 | `packages/contracts/src/connector.ts:70` (`.passthrough()`) | **Đã thay** — closed set `:72-80`, `.strict()` tại `:80`; không còn `.passthrough()` nào trong file | `85997983…` (đổi) |
| 2 | `packages/worker-sdk/src/connector-invoker.ts:135` (`InvocationRequestSchema.parse(payload)`) | **Không sửa** — thừa hưởng allowlist; key lạ fail trước fetch (pin test) | `a6f8d54c…` (nguyên) |
| 3 | `services/connector/src/adapters/http.ts:35,:101` (provider body) | **Không sửa** — chỉ nhận options đã parse; `writeMapped` copy nguyên object vào body / `form.set('options', …)` (pin test) | `8df114af…` (nguyên) |
| 4 | `services/connector/src/hash.ts:22` (canonical hash) | **Không sửa** — delegate `@du/contracts`; options hợp lệ vào hash y nguyên (pin sensitivity + parity) | `9b88d361…` (nguyên) |

Bất biến: `services.ts:69` `parseContractInvocationRequest(body)` → `toLocalRequest` → `services.ts:77` `validateGrant(…, hashInvocationInput(local))` → `invokeAdapter` → `adapter.buildRequest` — không nhánh nào khác tới provider body/hash, nên không cần chặn thêm ở egress.

## 4. Test mới (3 file, focused literal)

| File | Pin |
|---|---|
| `packages/contracts/tests/p745-options-allowlist.test.ts` | full allowed set verbatim; `responseFormat` enum (json/text) — reject ngoài domain; `jsonSchema` record — reject array/null/string; reject key lạ thứ ba / `systemPrompt` / `apiKey`; proto keys reject + no pollution; `{}` accepted |
| `services/connector/tests/p745-options-passthrough.test.ts` | json adapter body `options` **toStrictEqual** literal; multipart form field `options` literal; hash **sensitivity** (có/không options, đổi `jsonSchema` → đổi digest) + **parity** `hashInvocationInput` == `contractsHash`; inbound parse giữ đúng 2 key; inbound parse **reject** key lạ |
| `packages/worker-sdk/tests/p745-options-passthrough.test.ts` | outbound wire body chứa đúng options (đọc body capture); key lạ **reject trước HTTP** — `fetch = 0 lần` (negative evidence) |

## 5. Evidence — lệnh literal + kết quả

### 5.1 Focused set, 3 lượt liên tiếp (mỗi lượt cùng lệnh)
```
pnpm --filter @du/contracts test -- "p745-options-allowlist|invocation-hash|dto"
→  run1: Test Suites: 3 passed, 3 total — Tests: 45 passed, 45 total
→  run2: Test Suites: 3 passed, 3 total — Tests: 45 passed, 45 total
→  run3: Test Suites: 3 passed, 3 total — Tests: 45 passed, 45 total

pnpm --filter @du/connector test -- "p745-options-passthrough|canonical-hash-parity|connector.test|p8-03-convergence"
→  run1/2/3: Test Suites: 2 skipped, 25 passed, 25 of 27 total — Tests: 8 skipped, 303 passed, 311 total
   (scope thực tế = TOÀN BỘ suite connector service: pattern `connector.test` khớp cả cây `connector/tests`
    vì tên thư mục khớp regex. 2 suite skip theo gate `CONNECTOR_INTEGRATION=1`
    (`black-box-durable.test.ts:16,:36`, `durable-integration.test.ts:4`); 8 test skip live-gated.)

pnpm --filter @du/worker-sdk test -- "p745-options-passthrough|connector-invoker|connector-input-contract|connector-sync-post-code"
→  run1/2/3: Test Suites: 4 passed, 4 total — Tests: 117 passed, 117 total
```
Re-run xác nhận sau A/B (mục 5.4): connector file mới verbose — `5 passed, 5 total`, liệt kê đúng 5 tên test ở trên.

### 5.2 Full-suite bổ sung (1 lượt)
```
pnpm --filter @du/worker-sdk test        → Test Suites: 30 passed, 30 total — Tests: 1 todo, 691 passed, 692 total
pnpm --filter @du/connector-client test  → Test Suites: 1 skipped, 5 passed, 5 of 6 total — Tests: 1 skipped, 39 passed, 40 total
   (skip = real-service.test.ts:17,:29 gate `CONNECTOR_INTEGRATION === '1'`)
pnpm --filter @du/contracts test         → Test Suites: 1 failed, 25 passed, 26 total — Tests: 2 failed, 520 passed, 522 total
   (1 fail = vault-policies.test.ts, pre-existing — chứng minh bằng A/B mục 5.4)
```

### 5.3 Scoped typecheck (exit 0, không output)
```
pnpm --filter @du/contracts lint    (tsc --noEmit -p tsconfig.json)
pnpm --filter @du/worker-sdk lint   (tsc --noEmit -p tsconfig.json)
pnpm --filter @du/connector typecheck (tsc --noEmit -p tsconfig.json)
```

### 5.4 A/B pre-existing `vault-policies` (không phải regression của packet này)
- Swap HEAD version (`git show HEAD:du-rework/packages/contracts/src/connector.ts`, blob `7021c367…`) vào file → `pnpm --filter @du/contracts test -- vault-policies` → `Tests: 2 failed, 60 passed, 62 total`, lỗi `TypeError: expect(...).toThrowError is not a function` tại `tests/vault-policies.test.ts:104,:179`.
- Swap bản của tôi trở lại (verify hash `859979…` == pre-swap) → chạy lại → **identical** `2 failed, 60 passed`.
- File này không import `connector.ts` (chỉ `../src/vault-policies`, `../src/vault`, stub) → độc lập nhân quả; failure counts identical → **pre-existing**, thuộc lane vault (không sửa — ngoài scope).

## 6. Scope compliance

- `git status --short` scoped (cuối): ` M packages/contracts/src/connector.ts` + 3 `??` test mới (`packages/contracts/tests/p745-options-allowlist.test.ts`, `packages/worker-sdk/tests/p745-options-passthrough.test.ts`, `services/connector/tests/p745-options-passthrough.test.ts`).
- `packages/contracts/dist` rebuild local (bắt buộc vì worker-sdk resolve `@du/contracts` qua dist) — gitignored, không xuất hiện trong status.
- Không commit/push/tick; `submission/runtime/contracts-profiles` (MEDIUM-1) không chạm; `connector-invoker.ts`/`adapters/http.ts`/`hash.ts` SHA-256 giữ nguyên.

## 7. Unresolved gaps / đề xuất coordinator chốt

- **Lease tension (cần chốt)**: packet lease ghi `modules/connectors/{connector,connector-invoker}.ts` trong khi dòng "Read-only … contracts …" cũng nêu `contracts`. Tôi đọc `connector.ts` = `packages/contracts/src/connector.ts` — file `connector.ts` **duy nhất** trong repo, chính là `connector.ts:70` mà packet trỏ, và không thể "whitelist passthrough ở connector.ts:70" mà không sửa file này. Nếu coordinator muốn contracts tuyệt-đối read-only thì hướng thay thế (chặn ở `task-context.ts:877`/`connector-session.ts:296` để giữ hash parity) nằm **ngoài lease hiện tại** — cần packet riêng; đề xuất giữ như hiện tại.
- **`systemPrompt`** (`businesses/document-core/src/types/context.ts:12`): khai báo nhưng **0 caller** — cố ý KHÔNG đưa vào allowlist (giữ surface tối thiểu); muốn gửi thật phải mở bằng contract change tường minh.
- Chưa chạy live E2E (offline by design — cần lane LIVE xác nhận xuyên provider thật).
- Consumer chưa chạy trong packet: orchestrator suite (chỉ nhận inputHash worker ký, không parse schema), businesses document-core suite (đường connector dùng fake port; real-service nằm trong `multi-container-e2e` live-gated).

## 8. Post-write hashes

| File | SHA-256 | Ghi chú |
|---|---|---|
| `packages/contracts/src/connector.ts` | `859979838c36763104497cfdc0fb402826daaa096c1e27ee6899482fc11359d2` | thay đổi (CRLF preserved) |
| `packages/worker-sdk/src/connector-invoker.ts` | `a6f8d54cbd813dd9c9e0bed79b7d46ee73641fbdbf2cf04c53ee641574f1ef88` | không đổi |
| `services/connector/src/adapters/http.ts` | `8df114af9959f825efe3b03536f9f749c11426f9b1dfdebb8c852ff85626cf6f` | không đổi |
| `services/connector/src/hash.ts` | `9b88d361bc758318f4ef48b7ae423c4e5410654627bd9e36bb8c4d010e5c8ac2` | không đổi |
| `packages/contracts/tests/p745-options-allowlist.test.ts` | `aaa70ee25d6042a923a943f42064d225ef3f8af33d43ebb2f73b9d80d37e6098` | mới (68 dòng) |
| `packages/worker-sdk/tests/p745-options-passthrough.test.ts` | `10e4d3b71bebafd59f705801763223b54bb46cec0bdb0b9c34e7acfed27bd698` | mới (70 dòng) |
| `services/connector/tests/p745-options-passthrough.test.ts` | `0d82c3057939adc7ccc365cee9e11bfa345006a07c46d2eba5244e3bedb11729` | mới (116 dòng) |

**Verdict:** packet hoàn thành offline — REJECT contract áp tại schema (single source), chain pin đủ 4 điểm, focused 3× green + typecheck 0 lỗi; chờ coordinator chốt lease-tension (mục 7) và review lane độc lập.
