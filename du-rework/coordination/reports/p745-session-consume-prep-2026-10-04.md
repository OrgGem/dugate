# P745-SESSION-CONSUME-PREP — prep session seam consume (READ-ONLY) — 2026-10-04

**Packet:** P745-SESSION-CONSUME prep (message-only spec). **Lane:** cc_1 (`term_c03791d1`). **Run:** `run_069ecd6957cd`.
**Snapshot đo:** 2026-10-04 **22:02–22:20 +07**. **Mode:** READ-ONLY — file duy nhất ghi là receipt này; 0 source edits; không tick/commit.

## 0. TL;DR

- **SDK seam (P4-07) đã hoàn chỉnh + có unit test**: `runConnectorStep` (connector-session.ts:288-324) tính stable hash gồm `sessionRef`, đọc fallback từ `ctx.step.peek(stepKey)` (:293-294), gọi `step.run(..., {sessionRef})` (:309-323) và `connector.invoke(..., {sessionRef, deadlineAt})` (:313-316). Contract `CheckpointRefSchema.sessionRef` đã có (`contracts/runtime.ts:48`), claim mang `checkpointRefs` (:117).
- **GAP #1 (chặn fallback qua yield/restart — runtime persistence)**: SDK gửi `sessionRef` trong saveStep body (`task-context.ts:389-399`), nhưng server side **bỏ luôn** — `runtime.saveStep` body type không có sessionRef (`modules/runtime/runtime.ts:484`), bảng `step_checkpoints` **không có cột `session_ref`** (migration 0001:102-111; INSERT :526 chỉ 6 cột), claim SELECT :1583-1604 cũng không đọc. ⇒ `prior?.sessionRef` chỉ sống trong **cùng một task attempt** (in-memory `checkpointList`); **mất qua yield/redelivery/restart**. `peek` (:412-414) chỉ đọc list này.
- **GAP #2 (business consumption)**: **0 call-site `runConnectorStep`** trong `businesses/**` (chỉ SDK tests + index export); ~20 site vẫn `ctx.connector.invoke(...)` trực tiếp (2–3 arg); **0 consumer** của `connectionsOverride`/`captureSession`/`injectSession` trong business (chỉ admin UI/orchestrator round-trip) — W1b SDK-CONSUME (pinned `profilePolicy`) đang in-flight là carrier dự kiến.
- **GAP #3 (bridge)**: document-core bridge (`worker.ts:180-491`) `connector.invoke` chỉ 3 tham số (:370-375, :415 — **drop `invokeOpts`**), `step` facade 3 tham số (:469-475 — **drop `opts.sessionRef`**), không có `peek` ⇒ `runConnectorStep` không chạy được trên bridge (shape khác `TaskContext`).
- **Đề xuất (nhỏ trước, lớn sau)**: (1) fix runtime persistence — **Δ-A, không đổi contracts**; (2) hoàn thiện bridge forwarding additive — **Δ-B**; (3) chỉ migrate **flow session-relevant** (capture→inject) sang `runConnectorStep`, **giữ nguyên ~18 site single-shot** — **Δ-C**. Chi tiết §2.

## 1. Bản đồ seam (file:line hiện tại)

**S1 — SDK (đã xong):**
- `runConnectorStep` `packages/worker-sdk/src/connector-session.ts:288-324`: `prior = await ctx.step.peek(params.stepKey)` → `sessionRef = params.sessionRef ?? prior?.sessionRef ?? null` (:293-294); hash `hashInvocationInput({…, sessionRef, deadlineAt})` (:296-307); `ctx.step.run(stepKey, inputHash, fn, {sessionRef})` (:309-323); invoke 4-arg (:313-316). Kết quả trả `sessionRef` (:53,:88,:203).
- Types: `invoke(slot, input, options?, invokeOpts?: {sessionRef?, deadlineAt?})` `types.ts:118-129`; `StepFacade.run(…, opts?: {sessionRef?})` `:165,:170-173`; `peek` `:167`.
- `DefaultTaskContext.step.run` `task-context.ts:369-410`: gửi body `{leaseEpoch, inputHash, outputRef, status, sessionRef}` (:389-399 — comment "Additive (P4-07): undefined dropped"); push `CheckpointRef` incl. `sessionRef` vào `checkpointList` (:401-408). `peek` `:412-414` (**chỉ đọc list trong memory**).
- Tests SDK đã phủ: persist/fallback/fail-closed/pending/concurrent `tests/connector-session.test.ts:610-741` (fallback từ checkpoint FAILED :630-640; malformed fail-closed :652-681; pending yield :683-704).

**S2 — Contracts (đã sẵn):** `CheckpointRefSchema {…, sessionRef: nullable().optional()}` `packages/contracts/src/runtime.ts:42-50`; claim `checkpointRefs` `:117`; hashing `hashing.ts:74,:90` (sessionRef trong canonical hash).

**S3 — Runtime persistence (THIẾU):**
- Table `step_checkpoints` (migration `0001_platform_v1.sql:102-111`): task_id/step_key/generation/input_hash/output_ref/status/created_at — **không `session_ref`**.
- Server handler `saveStep` `modules/runtime/runtime.ts:481-527`: body `{leaseEpoch, inputHash, outputRef, status}` (:484, **không sessionRef**); INSERT 6 cột (:526). Route `http/routes/runtime.ts:412`.
- Claim mapping `runtime.ts:1583-1604`: SELECT không có `session_ref` → `CheckpointRef.sessionRef` không bao giờ được nạp từ DB.
- Migration mới nhất hiện tại: **0029** (`0029_audit_actor_principal.sql`) → migration kế tiếp đề xuất `0030_step_checkpoints_session_ref.sql`.

**S4 — Document-core bridge (cần hoàn thiện):**
- `toInternalContext` `businesses/document-core/src/worker.ts:180-491`; `isInternal = typeof ctx.step === 'function'` (:181 — legacy ctx vs SDK ctx).
- `connector.invoke` (:370-375): `(slot, promptOrPayload, options)`; internal branch forward 3 arg (:374); legacy branch map payload rồi `invoke(slot, input, options)` (:415) — **4th arg `invokeOpts` không tồn tại ở wrapper**.
- `step` (:469-475): `(stepKey, inputHash, fn)` → forward 3 arg; `getCheckpoint` (:476-489). **Không có `run`/`peek`** kiểu `StepFacade` ⇒ bridge không phải `TaskContext`.
- Actions nhận bridge: `toInternalContext(ctx)` gọi tại `:1234, :1797, :1878-1988` (các handler chính); `DualTaskHandler` (:497-500) nhận `SdkTaskContext | TaskContext`.

**S5 — Business call-sites (giữ invoke trực tiếp):** document-core: `transform/index.ts:117,:164`; `compare/index.ts:97,:133`; `extract/index.ts:93`; `ingest/index.ts:268,:309`; `generate/index.ts:102`; `analyze/index.ts:135,:153,:171`; `pipelines/workflows/doc-compare/runner.ts:369`; `worker.ts:896,:1016,:1482`. lc-checker: `worker.ts:266,:304,:335,:357,:374`. example-review: `review.ts:557,:895`. — **Tổng ~20 site, tất cả 2–3 arg, 0 site dùng runConnectorStep**.

**S6 — connectionsOverride (chưa có consumer):** schema `profile-policy.ts:148-164` (`captureSession: string|null?, injectSession: string|null?` :152-153); business grep = 0 (chỉ fixtures `p730-*` + admin UI `profiles-screen.tsx`). Anchor acceptance: `tests/harness/w2-profile-policy-prompt-override.md:15` ("two valid steps exercise captureSession then injectSession" — chưa implement).

## 2. Đề xuất (business chuyển hay giữ invoke?)

| Phần | Đề xuất | Lý do | Blast radius |
|---|---|---|---|
| **Δ-A. Runtime persistence (BẮT BUỘC trước)** | Thêm migration additive `ALTER TABLE step_checkpoints ADD COLUMN IF NOT EXISTS session_ref text NULL`; `saveStep` nhận + lưu `sessionRef`; claim SELECT/mapping nạp `checkpointRefs[].sessionRef` (NULL → undefined giữ wire cũ) | Không có nó thì mọi flow session đều mất continuation qua yield/restart — kể cả business có dùng runConnectorStep | Migration (single-writer) + `modules/runtime/runtime.ts` (**serialize với P2-FIX** — coordinator đang giữ runtime.ts cho P745-PROMPT-PRODUCER) + route context; **không đổi contracts** (field đã khai :48) |
| **Δ-B. Bridge forwarding additive** | `worker.ts` bridge: `connector.invoke` nhận + forward `invokeOpts` (sessionRef/deadlineAt); bổ sung đường session cho `step` (forward `opts {sessionRef}` khi gọi `ctx.step.run`) + expose `peek` tương đương | `runConnectorStep` cần `TaskContext` shape; bridge hiện drop cả 4th arg lẫn step opts | `businesses/document-core/src/worker.ts` + tests; không đổi legacy shape khi không truyền (additive) |
| **Δ-C. Migrate CHỌN LỌC** | Chuyển **chỉ flow capture→inject** (2 step: step1 captureSession → checkpoint.sessionRef → step2 injectSession) sang `runConnectorStep`; **giữ nguyên ~18 site single-shot** `invoke` | Single-shot không có lợi ích session; chuyển hết = refactor lớn, rủi ro input-shaped (bridge map legacy payload) | 1–2 action (đề xuất làm đầu tiên theo đúng harness W2 :15) + bridge; mở rộng sau theo nhu cầu |
| (giữ nguyên không đổi) | `connectionsOverride.captureSession/injectSession` chỉ được **đọc** để quyết step nào capture/inject (từ pinned profilePolicy W1b); không sửa contracts | Tránh mở rộng scope plan04 khi chưa cần | Phụ thuộc W1b SDK-CONSUME (in-flight) |

**Δ (không tự mở contracts):**
- **Δ-A**: không phải contract change (implementation completion — field đã có trong `CheckpointRefSchema:48`); nhưng thay đổi **migration + runtime wire body** ⇒ cần coordinator cấp lease migration + serialize runtime.ts.
- **Δ-B/Δ-C**: additive ở business layer; nếu muốn "chính danh hoá" đường business→runConnectorStep bằng type mới trong worker-sdk → **ghi nhận là Δ-contract đề xuất, KHÔNG thực hiện trong packet này**.

## 3. Test plan pin (KHÔNG implement)

**Offline — orchestrator (`services/orchestrator/tests/`):**
1. `p745-session-runtime-persistence.test.ts`:
   - *"saveStep persists sessionRef and claim maps it back into checkpointRefs"* — PUT với `sessionRef` → capture INSERT có cột/giá trị; claim mapping trả `checkpointRefs[0].sessionRef === 'sess-1'`.
   - *"saveStep without sessionRef keeps the pre-W39 row/body shape"* — không truyền → body/INSERT byte-identical, cột NULL.
   - *"replayed SUCCEEDED checkpoint keeps its original sessionRef"* (cùng inputHash → replayed, giá trị không đổi).
   - *"legacy NULL row exposes sessionRef undefined, not null"* (JSON-dropped).
2. (nếu chạm) `runtime.test.ts` cells liên quan — chỉ rerun cell bị ảnh hưởng.

**Offline — worker-sdk (`packages/worker-sdk/tests/`):**
3. `p745-session-two-step.test.ts` (pin mới; bổ sung phần chưa có của `connector-session.test.ts`):
   - *"step1 captures sessionRef; step2 without explicit sessionRef injects 'sess-1' on the wire"* — 2 lần `runConnectorStep`, assert payload[1].sessionRef = 'sess-1' và `PUT /steps` bodies.
   - *"resume after restart: fresh ctx built from claim checkpointRefs (with sessionRef) falls back identically"* (mô phỏng restart bằng ctx mới + storage mock).
   - *"pre-fix gap pin (RED): claim without sessionRef → step2 sends null"* — gap-detector, sẽ xanh sau Δ-A.
4. Existing cells giữ nguyên (`connector-session.test.ts:610-741`) — không sửa.

**Offline — document-core (`businesses/document-core/tests/`):**
5. `p745-session-consume.test.ts` (sau Δ-B/Δ-C):
   - *"bridge forwards invokeOpts.sessionRef for session steps"* — fake connector ghi payload nhận được.
   - *"capture/inject chosen from pinned profilePolicy.connectionsOverride"* — step có `captureSession`, step sau `injectSession`; wire step1 không sessionRef, step2 có.
   - *"no behavior change for direct single-shot invoke sites"* (regression: 1 site giữ 2-arg → payload/checkpoint y hệt trước).

**Live (window riêng):**
6. Worker restart mid-session (PG thật): step1 capture → kill/redelivery → step2 inject sau khi claim lại; yield PENDING → resume giữ sessionRef. Chỉ chạy trong window được cấp; mock xanh không thay live.

## 4. Limitations

- Static read-only; chưa chạy test/build; chưa mở stack. Đã đối chiếu code + contract + test fixtures; chưa verify hành vi runtime trên PG thật.
- Kết luận "drop sessionRef" dựa body type + INSERT + SELECT tại các dòng nêu trên; khi implement cần test pin đúng chỗ (mục §3.1) thay vì tin suông.
- Phụ thuộc: W1b SDK-CONSUME (profilePolicy carrier) đang in-flight; runtime.ts đang serialize với P2-FIX; migration single-writer.
- Đây là prep + khuyến nghị — không phải quyết định scope hay lease; chờ coordinator chốt.

READ-ONLY compliance: chỉ receipt này được ghi; không tick/sửa; không commit/push.
