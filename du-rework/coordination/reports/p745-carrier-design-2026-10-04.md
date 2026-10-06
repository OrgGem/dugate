# P745-CARRIER-DESIGN (Δ-PC-1) — sealed prompt-content carrier — 2026-10-04

**Packet:** P745-CARRIER-DESIGN (READ-ONLY) · task `task_77e15edce138` · lane cc_1 · dispatch 23:23.
**Snapshot pin:** 2026-10-04 23:3x +07 · HEAD `b088eec` · offline. **0 source edits; không tick; không commit/push.**

## Snapshot — file đã đọc (symbol-anchored)

| File | mtime_ns | SHA-256 (short) |
|---|---|---|
| `services/orchestrator/src/modules/runtime/metadata-crypto.ts` | `1790620267305026816` | `aa200211680cbba6f1a8…` |
| `services/orchestrator/src/modules/operations/submission.ts` (P745-IMPL) | `1791128975323339264` | `3007bcfaf047cfce4be3…` |
| `services/orchestrator/src/modules/runtime/runtime.ts` (P745-IMPL) | `1791128703867496192` | `c4c7ff41ece181962c67…` |
| `packages/contracts/src/runtime.ts` | `1791112701855430400` | `4cc34f0fac916f0acd35…` |
| `packages/worker-sdk/src/types.ts` + `worker.ts` | `1791121036560812800` / `1791121149408071168` | `9ab4af514be8f84df409…` / `6e82be42c66b3fe1f270…` |
| `businesses/document-core/src/{worker.ts, actions/prompt-precedence.ts, actions/extract/index.ts}` | `1791121336869352192` / `1791128170766044672` / `1790849518048840704` | `56fa3520fbd963b14030…` / `83a64e7ce9de666ecaec…` / `ba21fdc723ef25be0ee0…` |
| `tasks/PLAN-COMPLETION-2026-10-04.md` | `1791130056445015552` | `0f96ca42be018726400c…` |
| `migrations/0030_prompt_revisions_pin.sql` (phase 1) | `1791128611712283392` | `3709a5d4df0e3f8bf302…` |

Nguồn chốt: coordinator decision PC-1..PC-5 (`coordination/coordinator-state.json:904`), `w1-review-part4-2026-10-04.md:65-81` (AW-C), `PLAN-COMPLETION-2026-10-04.md:38` (T-PROM-02), `:259`/`:295` (điều kiện đóng + next step). **Static read-only; không chạy test** (design packet).

## 1. Δ-PC-1 — Carrier FORM: so sánh + khuyến nghị

### Ràng buộc từ seam ENC-META hiện có (đọc code, không suy đoán)

- `METADATA_SLOTS` là **union đóng** 4 slot (`metadata-crypto.ts:44-51`); `MetadataSlot` chỉ mở rộng bằng sửa module này (orchestrator-local, **không phải contracts**).
- AAD = `sha256(tenantId|slot|refId)` (`:146-150`), so sánh **trước khi chạm cipher** (`:283-291`); doc nói rõ mục đích: *“a tasks.payload_ref blob replayed into operations.input_ref is refused”* (`:39-43`) — nên **không được** tái dùng slot `operations.input_ref` cho carrier (mất tính chất phân cách cột).
- Envelope gồm `plaintextSha256` (`:80-91`) — hash canonical của plaintext (dùng được như một cross-check tổng).
- `readStored(value, ctx, allowPlaintext)` (`:309-321`): plaintext chỉ được trả khi `allowPlaintext=true`; mọi caller khác **fail-closed**.

### Phương án

| # | Form | Ưu | Nhược / blast radius | Kết luận |
|---|---|---|---|---|
| **A (khuyến nghị)** | **Cột mới** `operations.prompt_overrides_ref jsonb NULL`, sealed envelope kiểu `input_ref`, **slot mới `operations.prompt_overrides_ref`**; plaintext = mảng row `{connectionId, stepId, promptOverride, revision}` (đúng tập row mà marker đã pin) | Tách cột ⇒ không đụng shape `input_ref`/snapshot policy; AAD phân cách cột đúng triết lý seam; migration thuần additive; fail-closed tự nhiên (cột mới không có row legacy) | +1 slot = sửa `METADATA_SLOTS` + 2 union inline trong runtime (:312,:322); +1 migration 0031 | ✅ |
| B | Nhồi content vào `profile_policy_snapshot` (P1 cũ) | Không cột mới | Snapshot là DTO `.strict()` của policy (`PinnedProfilePolicySchema`); thêm content = **contracts change + re-freeze** + phá validator hiện có; content nặng nằm trong cột bị nhiều consumer parse | ❌ |
| C | Bảng riêng `prompt_carrier` | Tách hoàn toàn | Thêm 1 write-path + FK + tx; không có lợi ích hơn A (cột đã đủ); phá “one tx writes operation+task+outbox” | ❌ |
| D | Tái dùng slot `operations.input_ref` (refId=operationId) | 0 slot mới | Phá bảo đảm chống replay liên-cột của AAD (envelope carrier decrypt được nếu bị đặt vào `input_ref`) | ❌ (vi phạm design constraint của chính seam) |

**Khuyến nghị A** với plaintext = **mảng row thô** (không wrapper riêng; envelope đã tự versioning `:31-32`), `revision` mỗi row = **cùng công thức phase 1** `'sha256:'+hex(sha256(connectionId|stepId|promptOverride))` — để claim có thể **đối chiếu chéo** với `prompt_revisions_pin`.

**Bindings:** `{tenantId, slot:'operations.prompt_overrides_ref', refId: operationId}` — cùng row identity như `input_ref` ⇒ copy sang row khác cùng tenant cũng bị `CONTEXT_MISMATCH`.

## 2. Producer flow (submit) — tái dùng 1 lần đọc đã có

Hiện trạng sau P745-IMPL: submit pinned-mode gọi **1 lần** `promptOverrides.listFor(apiKeyId, canonicalAction, tenantId)` → `buildPromptRevisionsPin` → cột `prompt_revisions_pin` (markers non-secret), seal `input_ref`/`payload_ref` **trước tx** để key-provider lỗi ⇒ 0 write (CR28-04 ordering, `submission.ts:304-325`).

Phase 2b (content) thay đổi tối thiểu:

1. **Cùng một read**: `buildPromptCarrier(rows)` chạy trên **chính tập row đã lọc** cho markers (content-bearing; row cleared bị loại — parity P745) → plaintext array `[{connectionId, stepId, promptOverride, revision}]`.
2. **Seal trước tx** bằng `metadataCrypto.seal(carrier, {tenantId, slot:'operations.prompt_overrides_ref', refId: operationId})` — cùng vị trí với `sealSubmitMetadata(input_ref)`; key-provider down ⇒ submit abort **0 row**. `metadataCrypto` đã có sẵn trong closure (`options.metadataCrypto`) — **không cần wiring create-app mới**.
3. **INSERT** thêm cột `prompt_overrides_ref` ($18) cùng tx với markers. Legacy mode → NULL cả hai.
4. **No-seam policy (đề xuất — cần chốt)**: deployment **không** cấu hình `metadataEncryption` ⇒ carrier = **NULL** (markers vẫn ghi như phase 1). Lý do: “prompt nhạy cảm phải mã hóa at-rest” (T-PROM-02 `:38`); không có seam thì ghi plaintext content vào jsonb là vi phạm, mà từ chối submit thì phá deployment chưa bật crypto. Hệ quả: no-seam → consumer thấy `promptOverrides:null` → connector default (hành vi cũ), feature dark có kiểm soát. *(Đây là decision item Δ-PC-1c.)*
5. **Giới hạn kích thước (đề xuất — cần chốt)**: cap carrier tại submit (đề xuất ≤64 row, ≤16 KiB/row, ≤256 KiB tổng) → 422 code riêng `PROMPT_CARRIER_TOO_LARGE` (fail-closed, không cắt ngầm). *(Δ-PC-1d.)*

## 3. Claim/consumer open path — ai giải mã, khi nào, ranh giới plaintext

**Ai:** orchestrator — bên duy nhất giữ key (Vault Transit / `metadataCrypto`); worker **không** có key (không có đường Vault). “Consumer-side” trong PC-2(a) = **phía substitution** (business), decrypt là orchestrator-side theo custody — **diễn giải cần coordinator ratify** (Δ-PC-1e).

**Khi:** tại **claim** trong `buildClaimResult` (`runtime.ts:1629+`), **trước** mọi substitution — mirror đúng cách `input_ref` đang mở: `openMetadata(metadataCrypto, t.prompt_overrides_ref ?? {}, {tenantId, slot, refId: operationId}, /*allowPlaintext*/ FALSE)` → `pinned.promptOverrides`.

- **allowPlaintext=false** (khác `input_ref` dùng `true` cho legacy): cột mới không có row legacy ⇒ mọi giá trị non-null không phải envelope = `NOT_SEALED` ⇒ **fail-closed**.
- **Đối chiếu chéo với markers**: nếu carrier non-null — tập `(connectionId, stepId, revision)` của carrier phải **bằng đúng** tập markers; đồng thời `revision` recompute từ content phải khớp. Lệch ⇒ throw `INVALID_SCHEMA` (cùng family `parsePinnedProfilePolicy`/`parsePromptRevisionsPin`; corrupt admission record, không phải lỗi lease).
- **NULL semantics**: carrier NULL → `pinned.promptOverrides = null` (**null ≠ []**); markers có thể vẫn non-empty (no-seam deployment) — hợp lệ, không phải corrupt.
- **Vị trí trên wire**: field additive `pinned.promptOverrides` trong `ExecutionSnapshotSchema` (`contracts/src/runtime.ts:83-100`, cạnh `promptRevisions:85`) — **Δ-CONTRACTS** (xem §4, có tension với câu “không đổi contracts” của PC-2).
- **Ranh giới plaintext**: content (1) không bao giờ vào DB dạng thô (sealed at rest); (2) không vào outbox/queue/checkpoint (không có writer nào ghi nó — carrier chỉ nằm ở cột operations + claim response); (3) không vào log: mọi throw dùng message tĩnh + pointer, không giá trị (mirror `parsePinnedProfilePolicy` :232-241); (4) tồn tại transient trong claim response (worker-auth) và trong RAM worker cho 1 delivery — **đúng trust model hiện tại của `resolvedInputRef`** (:1666-1672), không mở rộng.
- **Vòng đời**: mở tại mỗi lần claim/redelivery (retry/restart/child/HITL đều re-claim) — luôn đọc từ cột pinned, không bao giờ đọc live bảng overrides (PRF-02).

**Phương án thay thế B’ (không khuyến nghị):** endpoint riêng cho worker fetch content ngay trước substitution — tránh mở rộng claim, nhưng thêm API surface + auth + SDK plumbing + contracts cho endpoint + live e2e; **không tăng secrecy** (claim cũng đã worker-auth, transient). Chọn A’ (claim) trừ khi coordinator muốn giữ claim size tuyệt đối nhỏ.

## 4. Xác nhận Δ-PC-2(a) + Δ-PC-3; migration/additive plan

**Δ-PC-2(a) — substitution tại payload construction: CONFIRMED khả thi.** Điểm chèn quan sát được: 6 site `worker.ts:{ingest:1881, extract:1903, analyze:1925, transform:1947, generate:1969, compare:1991}`; ví dụ `extract/index.ts:67-83` dựng `promptPayload.promptText` (default) **trước** `ctx.connector.invoke` (`:93-98`). Wiring = `resolveStepPrompt({codePrompt: variables._prompt, pinnedOverrides: <carrier rows>, connectionId: recipe…, stepId: STEP_KEYS.*.BUILD_PROMPT, profilePolicy, connectorDefaultPrompt: promptText})` → `apply ? resolved.prompt : promptText`. **Bản thân substitution không cần sửa contracts** (đúng PC-2).
> **Tension cần chốt (Δ-PC-1f):** câu “không đổi contracts” của PC-2 chỉ đúng cho *site substitution*; việc **chở content tới worker** cần **1 field additive** vào `ExecutionSnapshotSchema.pinned` (A’) — hoặc endpoint mới (B’, cũng cần wire contract). Đề xuất: chấp nhận additive field (optional + nullable + default ⇒ không phá consumer hiện có, re-freeze nhẹ) và ghi rõ đây là **Δ-CONTRACTS** để coordinator cấp lease contracts.

**Δ-PC-3 — bucket pre-scoped ở producer: CONFIRMED.** Producer đã ship `listFor(apiKeyId, canonicalAction, tenantId)` (P745-IMPL); consumer chỉ cần `connectionId`+`stepId` (`prompt-precedence.ts:43-45`, `:110-125`) — **không** có `apiKeyId`/`endpointSlug` trên consumer path. Carrier mang đúng tập row của bucket đó ⇒ không đổi assumption.

**Migration/additive plan:**

| # | Thay đổi | Loại | Ghi chú |
|---|---|---|---|
| 1 | `migrations/0031_prompt_overrides_ref.sql` | additive `ADD COLUMN IF NOT EXISTS prompt_overrides_ref jsonb NULL` | không backfill; row cũ NULL → claim null → connector default (op cũ bất biến) |
| 2 | `METADATA_SLOTS` + `MetadataSlot` (`metadata-crypto.ts:44-51`) | source (orchestrator-local) | +`'operations.prompt_overrides_ref'` |
| 3 | union inline `runtime.ts:312,:322` | source | đồng bộ 2 chỗ (hiện duplicate union — giữ pattern, chỉ thêm giá trị) |
| 4 | slot convention: **không** sửa contracts cho slot (không thuộc contracts) | — | xác nhận lại khi impl |
| 5 | không đổi `prompt_revisions_pin` (phase 1) | — | hai cột cùng tx, cùng tập row |

## 5. Test plan pin (KHÔNG implement — deliverable của packet này)

**Offline — orchestrator (`services/orchestrator/tests/`):**

| # | File mới | Case (assertion) |
|---|---|---|
| T1 | `p745-prompt-carrier-producer.test.ts` | a) pinned+seam: INSERT có `prompt_overrides_ref` = envelope; mở envelope bằng crypto cùng provider ⇒ rows khớp markers (tập `(cid,stepId,rev)` bằng đúng); b) **sentinel scan**: nhét sentinel vào content → quét **mọi** params INSERT/outbox ở mọi nesting + **base64 decode** (mirror `leaks()` w1-sub02) ⇒ âm tính; c) cleared rows bị loại ở cả 2 cột; d) legacy mode → NULL cả hai; e) **no-seam → carrier NULL, markers vẫn ghi** (chốt Δ-PC-1c); f) cap vượt ngưỡng → 422 (chốt Δ-PC-1d) |
| T2 | `p745-prompt-carrier-claim.test.ts` | a) carrier hợp lệ → `pinned.promptOverrides` = rows (đúng thứ tự/tập); b) NULL → `null` (không `[]`); c) envelope tampered / sai key ⇒ throw (`AUTHENTICATION_FAILED`/`KEY_PROVIDER_FAILED`), **claim rollback** — không lease/state write; d) **markers ≠ carrier** (thiếu/thừa/sai revision) ⇒ `INVALID_SCHEMA`; e) cross-tenant/cross-slot replay (AAD) ⇒ `CONTEXT_MISMATCH`; f) sentinel không xuất hiện trong các field khác của snapshot/error message |
| T3 | immutability (gộp T1/T2) | update override sau submit → claim op cũ **bất biến**; publish revision mới → op cũ bất biến, submit mới thấy content mới; op pre-0031 → null mãi |
| T4 | **fail-closed producer** | key-provider throw khi seal (fake provider) ⇒ **0 write** (không operations/tasks/outbox), submit lỗi; và carrier-seal-fail không rơi về plaintext |

**Wire (offline, mock provider tại seam `invokeConnector`):**

| # | File | Case |
|---|---|---|
| T5 | `packages/worker-sdk/tests/*pin-passthrough*` (extend, đã có nền `p730-sdk-consume-pin-passthrough`) | claim `pinned.promptOverrides` → SDK ctx; null-vs-absent giữ nguyên |
| T6 | `businesses/document-core/tests/p730-sdk-consume-forwarding.test.ts` (extend) | `toInternalContext` forward field mới; ctx không có pin ⇒ **absent** (shape cũ) |
| T7 | document-core functional (6 site, 1–2 đại diện là đủ offline): build-prompt nhận `resolveStepPrompt` ⇒ **request body tại `invokeConnector` quan sát được** prompt hiệu dụng (exact/_default/cleared/fallback) — đây là “observed provider request” **mức fake-invoke offline**; bản **live** (provider thật + key-4 mapping trên wire) vẫn thuộc window live, không claim ở đây |

**Live (ghi rõ ngoài scope offline):** submit thật → claim thật (PG row sealed mở bằng Vault thật) → worker thật → provider thật quan sát prompt; worker kill/restart re-claim bất biến.

## 6. Lease file-map pre-scope (cho packet implement — chưa mở)

| Vùng | File | Ghi chú |
|---|---|---|
| Migration | `migrations/0031_prompt_overrides_ref.sql` | single-writer; sau 0030 |
| Seam | `modules/runtime/metadata-crypto.ts` (+ union inline `runtime.ts:312,:322`) | chỉ ADD slot; **không** sửa semantics open/seal |
| Producer | `modules/operations/submission.ts` (helper mới + seal + INSERT $18) | **W1 hot — serialize**; tái dùng `options.metadataCrypto`, không thêm option |
| Claim | `modules/runtime/runtime.ts` (SELECT + open + cross-check + snapshot field) | serialize với lane runtime hiện hữu |
| Contracts (Δ) | `packages/contracts/src/runtime.ts` — `pinned.promptOverrides` additive | **cần coordinator cấp lease contracts** (single-writer) + rebuild dist cho consumers |
| SDK | `packages/worker-sdk/src/{types.ts,worker.ts,task-context.ts}` | forward field như `promptRevisions` (pattern :335-343 / :244-261) |
| Wiring | `businesses/document-core/src/worker.ts` (6 site + pin block :210-222) + (tùy chọn) 6 `selectRecipe`/`executeRecipe` nhận resolved | `resolveStepPrompt` **đã có**, 0 sửa leaf; mỗi site ~1 dòng |
| Tests | T1–T7 ở §5 | mới/extend |

**Thứ tự đề xuất:** contracts field (adjudication) → migration 0031 + slot → producer → claim → SDK forward → wiring 6 site → independent verify (observed request) → live.

## 7. Decision items (coordinator chốt trước implement)

1. **Δ-PC-1a** — Form A (cột `prompt_overrides_ref` + slot mới) chấp thuận? (thay B/C/D).
2. **Δ-PC-1b** — Cross-check markers↔carrier tại claim (multiset + recompute revision): bật (khuyến nghị, fail-closed) hay chỉ shape-check?
3. **Δ-PC-1c** — No-seam: carrier NULL + markers vẫn ghi (khuyến nghị) vs từ chối vs plaintext.
4. **Δ-PC-1d** — Cap kích thước (64 row/16 KiB/256 KiB) + code 422 `PROMPT_CARRIER_TOO_LARGE`?
5. **Δ-PC-1e** — Ratify diễn giải “consumer-side”: decrypt orchestrator-side tại claim; substitution business-side (PC-2a).
6. **Δ-PC-1f** — Chấp nhận **1 field additive** `pinned.promptOverrides` trong contracts (mâu thuẫn nhãn “không đổi contracts” của PC-2 → cần re-label Δ-CONTRACTS) — hay chọn endpoint B’ (nặng hơn)?
7. **Δ-PC-1g** — Field name chính xác: `pinned.promptOverrides` (đề xuất) vs `pinned.promptContents`; và có tái dùng/khai tử dead field `ProfileSnapshot.promptOverrides` (`results.ts:55`) không.

## 8. Limitations / không tuyên bố

- **Design-only, static read** theo snapshot ở đầu file; **không chạy test/build**, mọi loại “blast radius” là dự đoán có căn cứ, chưa prove.
- Chưa verify được: hành vi thật của `ExecutionSnapshotSchema` parse khi thêm field additive (schema strict hay không ở consumer — cần đọc kỹ + test khi impl); kích thước thật của bucket trong vận hành (cap là đề xuất).
- Không mở/sửa bất kỳ file nào ngoài receipt này; **không tick; không commit/push**; không rerun suite (không có source change).
- Các receipt liên quan đã đọc để không lặp: `p745-prompt-producer-prep` §2 (Δ-1), `p730-prefconsume` §3-4, `w1-review-part4` VERDICT 3, `p745-producer-impl` §3 (Δ-1 để mở).

READ-ONLY compliance: chỉ file receipt này được ghi.
