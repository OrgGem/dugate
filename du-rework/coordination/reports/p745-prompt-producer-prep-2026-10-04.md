# P745-PROMPT-PRODUCER-PREP — Δ-2 producer `promptRevisions` (READ-ONLY) — 2026-10-04

**Packet:** P745-PROMPT-PRODUCER prep (message-only spec, Δ-2). **Lane:** cc_1 (`term_c03791d1`). **Run:** `run_069ecd6957cd`.
**Snapshot đo:** 2026-10-04 **22:13–22:28 +07**. **Mode:** READ-ONLY — file duy nhất ghi là receipt này; 0 source edits; không tick/commit.

## 0. TL;DR

- **Producer gap xác nhận đúng**: claim builder hardcode `promptRevisions: {}` (`runtime.ts:1634`); `submission.ts` **0 mention prompt** ⇒ chưa resolve, chưa pin bucket; `createPromptOverrideService`/`pickPromptOverride` **0 call-site** ngoài file mình (repo T-PROM-01 tồn tại nhưng chưa wire); submission service chưa có dep promptOverrides (`SubmissionServiceOptions:68-92` chỉ có maxBlobBytes/storageBackend/metadataCrypto).
- **Design intent đã ghi sẵn trong repo**: `prompt-overrides.ts:96-97` — *"T-SUB-02 pins this bucket into the operation so the worker never reads the live table"*; `:201-203` — *"T-PROM-02 pins the bucket at submit"*. ⇒ Producer phải: **`listFor(apiKeyId, endpointSlug, tenantId)` tại submit → pin vào operations** → claim map ra `promptRevisions`. Contract claim **đã có sẵn** `promptRevisions: z.record(z.string(), z.string()).default({})` (`contracts/runtime.ts:85`) ⇒ **không cần đổi contracts cho map** (marker-only).
- **Đề xuất staged (khuyến nghị)**: **(P2-a)** cột mới additive `operations.prompt_revisions_pin jsonb NULL` chứa marker non-secret `[{connectionId, stepId, revision}]` với `revision = sha256(content)`; claim map `{[stepId]: revision}` + fail-closed khi pin hỏng. **Δ-1 (ghi, không làm)**: pin prompt **content** (cho precedence Code > Profile > Connector) là phase sau — cần quyết định carrier (sealed bucket ENC-META `..._ref` kiểu `input_ref`, hoặc mở rộng snapshot = contract change/re-freeze).
- **Test pin**: producer fill → claim rev thật; không override → `{}`; submit xong update override / publish revision mới → op cũ **bất biến**; malformed pin → fail-closed.

## 1. Bản đồ tuyến producer (file:line hiện tại)

**S1 — Claim builder (điểm hardcode):**
- `modules/runtime/runtime.ts:1632-1634`: `pinned: { profileRevision: t.profile_revision ?? 0, promptRevisions: {}, connectorBindings: … }` — comment :1629-1631 nói claim mang "PIN captured at submit", legacy giữ zero-value.
- Claim DTO: `packages/contracts/src/runtime.ts:85` `promptRevisions: z.record(z.string(), z.string()).default({})`.
- Consumer passthrough (đã xong/in-flight): SDK `packages/worker-sdk/src/worker.ts:342` (`snapshot.pinned.promptRevisions` → ctx), `task-context.ts:158,:180,:303`; document-core `worker.ts:216-221` forward vào internal pin; `types/context.ts:90`; tests `p730-sdk-consume-forwarding.test.ts:40-49`, `p730-sdk-consume-pin-passthrough.test.ts:169-177,:215-222`.

**S2 — Submission (thiếu hoàn toàn):**
- `modules/operations/submission.ts` — grep `prompt` = **0 match**; builder snapshot (`:502-533`) chỉ có enabled/parameters/jobPriority/allowedFileExtensions/fileUrlAuthConfigured/credentialRef; INSERT `:373-395` không có cột prompt nào.
- `SubmissionServiceOptions:68-92` chưa có dep `promptOverrides`; `create-app.ts` chưa instantiate service.

**S3 — Repo overrides (đã xong, chưa dùng):**
- `modules/profiles/prompt-overrides.ts` (T-PROM-01): `get` key-4 (:78-91); **`listFor(apiKeyId, endpointSlug, tenantId?)`** — đúng bucket legacy, :93-113 (comment :96-97 nêu rõ T-SUB-02 sẽ pin bucket); `upsert` (:123-172 — `isActive:false` = DELETE, trim/empty→null); `remove` (:179-191); **`pickPromptOverride(bucket, connectionId, stepId)`** :209-220 (exact → `_default`, pure, không query — "T-PROM-02 pins the bucket at submit").
- Wiring: `createPromptOverrideService` xuất hiện duy nhất tại định nghĩa :68 + type :195; `pickPromptOverride` chỉ định nghĩa :209 ⇒ **0 call-site toàn src**.
- Storage: `connector_prompt_overrides` migration `0026:108-145` (unique key-4; `step_id DEFAULT '_default'`; `prompt_override text`).

**S4 — Contract shapes sẵn dùng:** `PromptOverrideKeySchema` `contracts/profile-policy.ts:336-344`; `PromptOverrideReadSchema` `:376-381`; `PromptOverrideUpsertParamsSchema` `:353`. (Không cần tạo mới cho pin marker.)

**S5 — Acceptance liên quan:**
- `tasks/PLAN-COMPLETION-2026-10-04.md:38` (T-PROM-02): *"resolve key-4 một lần khi admission, pin prompt nội dung/revision… trong snapshot được bảo vệ theo ENC-META policy; prompt nhạy cảm phải mã hóa at-rest; không nhét outbox/queue"*.
- `:175`/`:215`: "producer promptRevisions {} là GAP riêng… không mở producer/session lease từ SDK progress".
- `docs/25-mm-status-crosscheck.md:10` (MM-03) — historical note cùng nội dung.

## 2. Điền `promptRevisions` từ đâu — quyết định + schema

| Phương án | Nội dung | Contract | Blast radius | Đánh giá |
|---|---|---|---|---|
| **P2-a (khuyến nghị cho gap này)** | Submit (pinned mode) gọi `promptOverrides.listFor(apiKeyId, action, tenantId)` → lưu **marker non-secret** vào cột mới `operations.prompt_revisions_pin jsonb NULL` = `[{connectionId, stepId, revision}]`, `revision = 'sha256:'+hex(sha256(connectionId∥stepId∥content))` (hoặc digest content thuần — chốt khi impl). Claim builder map → `{[stepId]: revision}` (sort deterministic), validate typed + fail-closed | **Không đổi** (claim field đã có :85) | Migration additive (0030) + `submission.ts` (**W1 hot file — serialize**) + `runtime.ts` claim (~:1634, **đang serialize với P2-FIX**) + `create-app.ts` wiring + tests | Đóng gap map; không re-freeze; content chưa pin — ghi Δ-1 |
| P2-b | Pin **cả content** bằng sealed bucket ENC-META: cột `operations.prompt_overrides_ref` sealed kiểu `input_ref` (slot mới `operations.prompt_overrides_ref`), claim mở khoá | Không đổi contracts (cột nội bộ) nhưng cần **ENC-META slot decision** | Thêm ENC-META list + submission/runtime + migration; nặng hơn | Đúng full T-PROM-02 ("nội dung/revision") nhưng là **phase 2** — Δ-1 |
| P1 | Mở rộng `ProfilePolicySnapshotSchema` thêm prompt entries | **Contract change (Δ)** + re-freeze consumers (submission/runtime/snapshot tests) | Lớn (contracts single-writer + W1 freeze) | Không khuyến nghị cho marker-only |
| P3 | Claim đọc live `connector_prompt_overrides` | — | — | **Loại** — vi phạm PRF-02/pin (worker không được query live) |

**Điểm cần chốt cùng coordinator (ghi Δ, không tự quyết):**
- **Δ-1 (content pin — phase sau)**: carrier cho prompt content tại claim (P2-b sealed bucket vs snapshot extension) + ENC-META slot; phục vụ precedence Code > Profile > Connector ở consumer.
- **Key của map**: giữ phẳng `{stepId → revision}` (khớp fixture `{extract_invoice:'v7'}`) hay `{connectionId:stepId → revision}` khi bucket có nhiều connection trùng stepId. Khuyến nghị: phẳng `stepId` (đúng legacy bucket scope per apiKey+endpoint), ghi caveat collision; đổi key = semantic change phải chốt trước khi consumer dùng.
- **Legacy mode**: op không có profile pin ⇒ giữ `{}` (zero-value shape như comment :1629-1631) — pin chỉ áp cho pinned mode.
- **Fail mode của pin hỏng**: khuyến nghị **fail-closed** (throw `INVALID_SCHEMA` như `parsePinnedProfilePolicy`) thay vì `{}` im lặng.

## 3. Blast radius chi tiết (P2-a)

| Vùng | File | Ghi chú |
|---|---|---|
| Migration | `services/orchestrator/migrations/0030_*.sql` (additive `ADD COLUMN IF NOT EXISTS`) | single-writer; hiện mới nhất 0029 |
| Producer | `modules/operations/submission.ts` (builder + INSERT params) | W1 hot file — cần lease sau W1a/handoff |
| Claim | `modules/runtime/runtime.ts` (~:1632-1634 + typed parse helper) | **đang serialize với P2-FIX** (coordinator hold) |
| Wiring | `app/bootstrap/create-app.ts` (+ deps SubmissionServiceOptions) | inject `promptOverrides` service |
| Repo | `modules/profiles/prompt-overrides.ts` | **đọc-only** (đã đủ API); có thể cần helper build map (thêm hàm pure — vẫn trong file) |
| Contracts | — | **không sửa** |
| Tests | `services/orchestrator/tests/p745-prompt-producer-*.test.ts` | mới |

## 4. Test plan pin (KHÔNG implement)

**Offline — orchestrator:**
1. `p745-prompt-producer.test.ts` (submit side):
   - *"pinned submit writes the override bucket markers into the operation pin"* — fake db có 2 row (`stepA`, `_default`) cho (apiKey, endpoint) → assert INSERT có cột pin + markers đúng + sort deterministic.
   - *"no override rows → pin NULL/empty and claim returns {}"* (legacy shape).
   - *"legacy mode (no profile) keeps {} regardless of bucket"* (quyết định ở §2).
2. `p745-prompt-claim.test.ts` (claim side):
   - *"claim maps the pinned markers into promptRevisions"* — row pin → `pinned.promptRevisions = {stepA: 'sha256:…'}`.
   - *"claim fail-closed on malformed pin jsonb"* (INVALID_SCHEMA; không chạy bằng `{}`).
   - *"NULL pin → {} (pre-W39 wire shape)"*.
3. Immutability (có thể gộp vào 1&2):
   - *"override updated AFTER submit → old operation's claim unchanged"*;
   - *"new profile revision published → old operation's map unchanged; new submit gets new marker"*.
4. Consumer pin (đã có — cite, không viết lại): `packages/worker-sdk/tests/p730-sdk-consume-pin-passthrough.test.ts:169-177` (claim→ctx) + `businesses/document-core/tests/p730-sdk-consume-forwarding.test.ts:40-49` (SDK→internal). End-to-end producer→claim→ctx pin (1 test mới khi consumer land).

**Live:** chưa cần cho marker map (offline đủ theo pattern hiện có); live sẽ thuộc phase Δ-1 (content pin + precedence quan sát trên provider request).

## 5. Limitations

- Static read-only; chưa chạy test/build. Marker/hash formula + key semantics **chưa được chốt** — là đề xuất, coordinator quyết trước khi implement.
- Runtime.ts đang serialize với P2-FIX; submission.ts thuộc W1 hot-set → thứ tự lease quan trọng (không mở từ packet này).
- Chưa xác nhận có consumer nào thực sự *đọc* `ctx.promptRevisions` (hiện mới forward); khi consumer dùng sẽ khép acceptance T-PROM-02 cùng Δ-1.

READ-ONLY compliance: chỉ receipt này được ghi; không tick/sửa; không commit/push.
