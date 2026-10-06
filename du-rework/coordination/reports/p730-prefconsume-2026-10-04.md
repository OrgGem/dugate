# P730-PREFCONSUME (Δ-C) — customer-side prompt precedence — cc_2 — 2026-10-04

**Packet:** coordinator 22:37 (+07) · **Task:** `task_9dba7eee7db1` · dispatch `ctx_e4b519212c97` (review `2026-10-04-2237-coordinator.md` §C3; reassign từ qwen_2 chết stream).
**Lane:** cc_2 · **Run:** `run_069ecd6957cd`. **Mode:** offline; 0 commit/push/reset; không tick.
**Lease dùng:** `businesses/document-core/src/actions/*` (leaf mới) + test mới tên riêng. **Read-only:** contracts/runtime/submission/orchestrator — không chạm.

---

## 0. TL;DR — phạm vi thực thi + verdict

Phân tích nguồn: adjudication **DELTA-C-PRECEDENCE** (`coordinator-state.json:783-785`: "resolve consumer-side từ snapshot (Code>Profile>Connector + _default)") + PREP §5 vectors (`p730-sdk-prep-2026-10-04.md:47-52`) + prep producer của cc_1 (**`p745-prompt-producer-prep-2026-10-04.md:9-11,40-49`**): **carrier cho prompt CONTENT là Δ-1 CHƯA CHỐT** (P2-b sealed bucket vs snapshot extension; key-format flat `{stepId→rev}` vs composite chưa chốt; producer hiện hardcode `promptRevisions: {}`).

⇒ Phần **khả thi offline và không bịa carrier** của Δ-C đã làm xong: **resolver precedence thuần + pin toàn bộ semantics bằng test**. Phần **wiring substitution vào 6 action consumers** giữ nguyên CHƯA làm — có chủ đích, vì chưa có nguồn content để truyền (xem Δ §3; rule lane: không tự mở nguồn ngoài scope, không để code chết).

**Verdict:** resolver core **DONE (offline, 17 test)**; kích hoạt substitution **BLOCKED-BỞI-Δ-PC-1** (chờ chốt carrier) — khi chốt, wiring = 1 dòng/site như mô tả §4.

## 1. Đã làm (2 file mới, trong lease)

| File | Nội dung | sha16 |
|---|---|---|
| `businesses/document-core/src/actions/prompt-precedence.ts` (MỚI, 7.7 KB) | Resolver thuần Δ-C | `83A64E7CE9DE666E` |
| `businesses/document-core/tests/p730-prefconsume.test.ts` (MỚI, 8.6 KB) | 17 test pin semantics | `BEF4794AB85DC169` |

**API:** `resolveStepPrompt(inputs) -> ResolvedStepPrompt` (discriminated union **có `apply`**); `pickPinnedPromptOverride(bucket, connectionId, stepId)` (parity `pickPromptOverride` :209); re-export `PROMPT_OVERRIDE_PRECEDENCE`.

**Semantics đã pin (test đối chiếu từng vector PREP §5):**
1. Thứ tự `code > profile > connector` đúng hằng số frozen; code trim-empty = absent.
2. Key-4: exact `(connectionId, stepId)` → `_default` fallback; rows connection khác bị bỏ; thiếu/empty `connectionId` → skip profile level.
3. **null vs '' = clear** (trim): row cleared → không có hiệu lực; **cleared exact short-circuit `_default`** (parity `pickPromptOverride`: exact thắng bất kể nội dung) rồi rơi xuống connector level.
4. **`profilePolicy === null` = admitted-without-policy** → skip profile level kể cả khi bucket có rows khớp; `undefined` (pre-pin) như nhau. Không coalesce thành empty.
5. **Không bịa connector default** (vector §5 negative): bucket rỗng/absent → `{source:'connector_default'|'none', apply:false}` — connector default chỉ được **label**, không áp dụng; caller giữ nguyên prompt cũ (byte-identical).
6. Call-site pattern demo trong test: `resolved.apply ? resolved.prompt : defaultText`.

**Bucket interface = rows key-4 ĐÓNG BĂNG** (`Pick<PromptOverrideRead,'connectionId'|'stepId'|'promptOverride'>`) — consumer chỉ cần `connectionId` + `stepId` vì bucket đã **pre-scoped tại admission** (`listFor(apiKeyId, endpointSlug)` theo thiết kế `prompt-overrides.ts:93-113`).

## 2. Gates (literal)

```
Focused set (tests/p730-prefconsume + p730-sdk-consume-forwarding + execution-pin.functional + manifest) ×3 liên tiếp:
  RUN 1: Test Suites: 4 passed / Tests: 45 passed — JEST_EXIT=0
  RUN 2: Test Suites: 4 passed / Tests: 45 passed — exit=0
  RUN 3: Test Suites: 4 passed / Tests: 45 passed — exit=0
pnpm run lint (tsc src):  LINT_EXIT=0
```
- **DELTA-A giữ nguyên:** `execution-pin.functional.test.ts` KHÔNG sửa, xanh trong cả 3 lượt (assertions pinned-variant/slot nguyên).
- W1b forwarding (`p730-sdk-consume-forwarding`) vẫn xanh (pin context → internal).

**`pnpm run test:typecheck` = exit 2 — PRE-EXISTING, không thuộc slice (6 lỗi, 3 file, mtime cũ):**
`tests/bullmq-smoke.test.ts` (1 lỗi, mtime 09-25) · `tests/provider-backed-variant.test.ts` (1, 09-28) · `tests/sdk-consumer.test.ts` (4, 10-02) — nguyên nhân đã được qwen_2 ghi **Δ-1** (`p730-sdk-consume-2026-10-04.md` §4): fixture `pinned` thiếu `profilePolicy` trong khi `contracts/dist/runtime.d.ts` (build bởi lane producer) đã REQUIRED. Không file nào của slice này; fix thuộc leases W1/contracts + W2. (Tôi không sửa — ngoài lease.)

## 3. Δ (chờ coordinator chốt — không tự mở)

- **Δ-PC-1 (blocker wiring)**: carrier **content** cho prompt pin = Δ-1 của cc_1 prep (P2-b sealed ENC-META bucket vs mở rộng snapshot = contract change) + **key-format chốt** (flat `{stepId→rev}` khuyến nghị vs composite). Resolver đã tách khỏi format (nhận bucket rows), nên **bất kể carrier nào chốt, chỉ cần producer đưa được rows vào consumer ctx** là wiring được. Đề xuất: chốt carrier + cấp packet producer (submission/runtime — hot files) rồi packet wiring document-core.
- **Δ-PC-2 (transport substitution)**: `InvocationInputSchema` STRICT không có field effective-prompt (= qwen_2 Δ-4/DELTA-E). Hai đường: (a) substitution tại **payload construction trước `ctx.connector.invoke`** (không đổi contracts — khả thi nhất); (b) nếu prompt phải đi qua grant/input → contract seam riêng. Đề xuất (a) khi wiring.
- **Δ-PC-3 (design assumption)**: `apiKeyId`/`endpointSlug` KHÔNG có trên consumer ctx; bucket phải **pre-scoped ở producer** (đúng thiết kế `listFor`). Nếu producer pin rows unscoped → consumer không đủ khóa → cần đổi producer, không phải consumer.
- **Δ-PC-4 (marker selection)**: `promptRevisions` marker-map dùng làm tín hiệu chọn step (exact/_default) chỉ khả thi sau khi key-format chốt (cc_1 §2) — chưa làm.
- **Δ-PC-5 (interpretation call)**: "cleared exact row KHÔNG hồi sinh `_default`" là chọn theo parity `pickPromptOverride` (exact ?? _default theo step). Nếu coordinator chốt ngược (cleared exact → rơi về `_default`), sửa 1 nhánh resolver + 2 test — nêu rõ để adjudicate.

## 4. Wiring points chính xác cho packet kế (không thực thi ở đây)

- 6 site build-prompt: `actions/{extract:67-83, analyze:84-133, generate:78-100, transform, compare, ingest}` — nơi `promptText`/`promptPayload` được dựng → chèn `resolveStepPrompt({...})` và dùng `apply ? prompt : defaultPromptText`.
- Legacy-shaped carrier tham chiếu: `selectRecipe(input, _profile?)` (6 chữ ký) + `ProfileSnapshot.promptOverrides?: Record<string,string>` (`types/results.ts:50-55` — DEAD, chưa ai dựng) — ứng viên map mới khi Δ-PC-1 chốt.
- Demo pattern đã pin trong test §1.6.

## 5. Limitations / không tuyên bố

- **Không claim PREFCONSUME đầy đủ**: observed provider request (key-4/step mapping/fallback trên wire) chưa thể chạy vì (i) producer chưa pin content, (ii) wiring chưa kích hoạt. Full acceptance T-PROM-02 cần Δ-PC-1 + wiring + independent verify.
- `test:typecheck` đỏ pre-existing 3 file (ngoài lease, không sửa).
- Resolver chưa có production call-site — **cố ý** (không dựng carrier giả); sẽ nối 1 dòng/site khi Δ-PC-1 chốt.
- Boundary: chỉ 2 file mới + receipt này được ghi; không chạm execution-pin/contracts/runtime/submission/orchestrator; không commit/push; không tick.
