# P745-CARRIER-IMPL-B2 (qwen_2) — T6 forward + T7 build-prompt wiring — 2026-10-05

**Lease:** document-core src {worker.ts, actions/*, types/context.ts, types/results.ts} + tests. Read-only: contracts/runtime/submission/worker-sdk.
**Offline. No commit/push/reset. Khong tick gate.**

## 1. Da lam

### T6 — forward pinned.promptOverrides + connectorBindings
- `src/types/context.ts` — them `readonly promptOverrides?: readonly PinnedPromptOverride[] | null` + `readonly connectorBindings?: Readonly<Record<string, string>>` (ca hai additive/optional).
- `src/worker.ts` `toInternalContext` — forward ca hai bang `!== undefined` guard (pattern hien co): context cu khong co field giu shape cu; `null` duoc forward nhu null (khong gop thanh empty).
- Tuyen bo: doc B1 SDK bang cung pattern o `packages/worker-sdk/src/{worker,task-context,types}.ts` (worker.ts:347 `promptOverrides: snapshot.pinned.promptOverrides`).

### T7 — wiring build-prompt (PC-2(a): apply ? prompt : defaultText)
- `src/actions/prompt-application.ts` (MOI) — `applyPinnedStepPrompt(ctx, {slot, stepId, defaultText, codePrompt})` + `connectionIdForSlot`. Goi `resolveStepPrompt` da co (PREFCONSUME), chi thay the va trao cho gap: `resolved.apply ? resolved.prompt : defaultText`. ConnectionId lay tu pin `connectorBindings[slot]` (format `connectorId@revision` — xac nhan tu contract comment + SDK test fixture `mock-ocr@1`).
- `src/actions/extract/index.ts` — trang `BUILD_PROMPT` dua `promptText` qua helper (day la trang co `defaultText` tuyet doi).
- Bo `connectorBindings` vao internal ctx + forward (additive, file trong lease) — can cho resolver suy connectionId.

### 3 — Xoa `ProfileSnapshot.promptOverrides`: KHONG THUC HIEN (Δ-T3, xem §4)

## 2. Bang chung (literal Exit Codes)

- Test moi `tests/p745-carrier-impl-b2.test.ts` — **10/10, Exit Code: 0** (3 T6 + 7 T7, co 'observed request' mo phong tap hop truyen vao ctx.connector.invoke).
- Focused x3 (B2 + p745-session + execution-pin): `Test Suites: 3 passed` / `Tests: 31 passed` — **Exit Code: 0** ca 3 lan. **DELTA-A: execution-pin 10/10 xanh, khong sua 1 dong test nao.**
- `tsc --noEmit -p tsconfig.json` — **Exit Code: 0**.
- Regression toan package: `Test Suites: 4 failed, 58 passed, 62 total` / `Tests: 1 failed, 1 skipped, 942 passed, 944 total`. **4 do do cung mot danh sach baseline** (config, sdk-consumer, provider-backed-variant, bullmq-smoke) — pre-existing, thuoc W1/W2. +1 suite = cua toi; test tuong (+11: 10 cua toi + 1 cua lane khac).

## 3. Δ / can coordinator phan xu

- **Δ-B2-1 (T3 BLOCKED — co chung minh; DA GIAI QUYET o §5):** `ProfileSnapshot.promptOverrides` CHUA duoc xoa vi xung dot truc tiep voi condition 'execution-pin KHONG sua + phai xanh'. `tests/execution-pin.functional.test.ts` day field nay trong literal **typed** `PIN_PROFILES: ProfileSnapshot[]` o **:35** (`promptOverrides: {}`) va **:56** (`promptOverrides: { extract_invoice: 'IGNORED-BY-BUSINESS' }`) -> xoa field => excess-property TS error => suite RED. Con 3 cho kia (:202, :257, :264) la `as` cast/payload. Vi the 2 lua chon: (a) cho phep sua 2 dong test do, (b) dat field `@deprecated` thay vi xoa. Toi khong chon 1 trong 2, danh cho coordinator.
- **Δ-B2-2 (1/6 site da wire):** chi `extract` co defaultText tuyet doi. 5 site con lai (analyze, generate, compare, transform, ingest) khong co default prompt text trong payload — chung truyen structured payload va adapter (`worker.ts:392-400`) xep thanh prompt text. Nen 'profile prompt thay cho gi' voi 5 site do khong co cau truc ro => KHONG doan. Can adjudication (vd: thay nguyen chuoi prompt cuoi cung cua adapter, hoac add truong rieng).
- **Δ-B2-3 (connectionId binding):** resolver can connectionId; document-core khong co truong ~ (stepId -> connectionId) chinh thuc, toi suy tu `connectorBindings[slot]` theo format contract. Neu format khac (khac '@') -> connectionId=null -> **SKIP** (an toan, khong ap nham), nhung se dung cac prompt co ban. Can nhan viet (xac dinh format hay bo them field).
- **Δ-B2-4 (build artifact):** da rebuild `packages/worker-sdk` dist (`npx tsc -p tsconfig.json`, exit 0) de dc doc duoc B1 types — **khong sua source SDK**, chi build output.

## 4. Trang thai

- T6 + T7 (1 site) + T7 tests: **IMPLEMENTED + VERIFIED-OFFLINE**.
- T3: BLOCKED, khong pha lease. 5 site con lai: CHUA (Δ-B2-2).
- File da ghi: extract/index.ts, types/context.ts, worker.ts (trong lease); prompt-application.ts, tests/p745-carrier-impl-b2.test.ts (MOI, trong lease). **Khong cham contracts, runtime, submission, worker-sdk source.** (types/results.ts: xem follow-up §5 — T3 da chay o vong adjudication sau.)

## 5. FOLLOW-UP — ADJUDICATION Δ-B2-x (2026-10-05 00:42) — DA THUC HIEN

### Δ-B2-1 (a) — xoa field + sua 2 literal (coordinator phe duyet)
- `src/types/results.ts` — **XOA** `ProfileSnapshot.promptOverrides` (dead field, 0 caller trong src).
- `tests/execution-pin.functional.test.ts` — sua **2 dong literal da duyet: :35** (`promptOverrides: {}`) va **:56** (`promptOverrides: { extract_invoice: 'IGNORED-BY-BUSINESS' }`) — CHI bo field khoi literal. **Giu nguyen moi assertion pinned-variant/slot; khong doi test logic.**
- Cho :200 (`invalidProfiles: unknown[]` roi `as ProfileSnapshot`) khong can sua va khong loi compile: bien `unknown` khong kiem excess property, probe van chay dung. Xac nhan bang tsc + test that.

### Δ-B2-2 — thay TAI DIEM GHEP TEXT cua adapter (huong da CHOT)
- `src/worker.ts` `toInternalContext.connector.invoke` — tach `assembledPromptText` (text ghep nhu truoc), rieng `promptText`: neu caller khai bao `options.promptStepId` (non-empty) thi `promptText = applyPinnedStepPrompt(promptView, {slot, stepId, defaultText: assembledPromptText})`; **khong co promptStepId => SKIP, dung nguyen assembled text** (fail-la-nhed, khong doan binding).
- `src/types/context.ts` — them `ConnectorInvocationOptions.promptStepId?: string` (optional, additive).
- `src/actions/prompt-application.ts` — nong tham so `ctx` thanh `PinnedPromptView` (chi 3 field pin) de adapter truyen view cua chinh `pin`; `TaskContext` van structural-compat nen test cu chay nguyen.
- **REVERT wiring build-prompt o extract (muc §1)**: neu giu se DOUBLE-APPLY voi duong adapter (mat prefix `extract_invoice:`). Hien **1 diem thay the duy nhat = adapter**, dung huong CHOT.
- `src/actions/extract/index.ts` — khai bao `promptStepId: STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE` tai invoke (site dai dien du context). Con lai CHUA khai => adapter SKIP, giu hanh vi cu (GAP §7).

### Δ-B2-3 / Δ-B2-4
- Δ-B2-3: giu suy `connectionId` tu `connectorBindings[slot]` theo format `connectorId@revision` da XAC NHAN; format la -> connectionId=null -> SKIP.
- Δ-B2-4: rebuild dist worker-sdk da duyet (build output, khong sua source SDK).

## 6. Bang chung follow-up (literal Exit Codes)

- `npx jest tests/p745-carrier-impl-b2.test.ts` — **12/12, Exit Code: 0** (3 T6 + 7 T7 + **2 test adapter**: co promptStepId => thay the; khong co => SKIP giu nguyen `extract_invoice: DEFAULTPY`).
- Focused x3 (B2 + p745-session + execution-pin): `Test Suites: 3 passed` / `Tests: 33 passed` — **Exit Code: 0** ca 3 lan.
- `tsc --noEmit -p tsconfig.json` — **Exit Code: 0** (sau khi xoa field; execution-pin van compile).
- **DELTA-A:** `execution-pin.functional.test.ts` **10/10 xanh** sau khi sua 2 literal — assertion pinned-variant/slot nguyen ven.
- Regression toan package: `Test Suites: 4 failed, 58 passed, 62 total` / `Tests: 1 failed, 1 skipped, 944 passed, 946 total` — **4 do do cung danh sach baseline** (config, sdk-consumer, provider-backed-variant, bullmq-smoke), pre-existing thuoc W1/W2.

## 7. GAP con lai (khong doan)

- **5 site chua khai bao `promptStepId`** (analyze, generate, compare, transform, ingest): adapter SKIP => pinned prompt CHUA ap cho cac step do. Can packet wiring tiep cung co che (moi action khai stepId tai invoke) — khong ton tai mo ta context thi van SKIP.
- Provider-side ap dung prompt that + carrier `null` (adjudication 1c) thuoc leg live/Connector.

## 8. File da ghi trong follow-up

Trong lease: `src/types/results.ts`, `src/types/context.ts`, `src/worker.ts`, `src/actions/extract/index.ts`, `src/actions/prompt-application.ts`, `tests/execution-pin.functional.test.ts` (2 literal da duyet), `tests/p745-carrier-impl-b2.test.ts`.
Khong cham: contracts, runtime, submission, worker-sdk source.

## 9. FOLLOW-UP — PACKET B2-WIRING (2026-10-05 01:02) — DA THUC HIEN

**Muc tieu:** 5 action con lai khai `promptStepId` tai invoke de adapter chokepoint ap pinned prompt (truoc do SKIP vi thieu stepId).

**Da wire 10 call site (5 action), stepId = step key cua chinh no:**
- `ingest` — `ingest:execute-ocr` (slot ocr), `ingest:execute-digitize` (slot vision).
- `analyze` — `analyze:fact-check-extract-claims`, `analyze:fact-check-verify-claims`, va `stepKey` bien (`analyze:connector-inference` / `analyze:summarize-eval-inference`).
- `generate` — `generate:connector-inference`.
- `compare` — `compare:execute-semantic`, `compare:execute-version`.
- `transform` — `transform:execute-translate`, `transform:execute-rewrite`.
- `extract` — da wire o vong truoc (`extract:connector-inference`).

**Bang chung:**
- `npx jest tests/p745-carrier-impl-b2.test.ts` — **17/17, Exit Code: 0** (them 5 test invariant B2-WIRING: moi handler chay, MOI invocation ghi duoc phai co `promptStepId` non-empty dung step key).
- Focused x3 (B2 + p745-session + execution-pin): `Test Suites: 3 passed` / `Tests: 38 passed` — **Exit Code: 0** ca 3 lan.
- `tsc --noEmit -p tsconfig.json` — **Exit Code: 0**.
- **DELTA-A:** `execution-pin.functional.test.ts` **10/10 xanh**.
- Regression toan package: `Test Suites: 4 failed, 58 passed, 62 total` / `Tests: 1 failed, 1 skipped, 949 passed, 951 total` — **4 do do cung danh sach baseline** (config, sdk-consumer, provider-backed-variant, bullmq-smoke), pre-existing thuoc W1/W2.

**Ghi chu trung thuc (khong pha huy):**
- Test B2-WIRING bat loi output-validation cua handler (chay SAU invoke) nhung van assert dung: `connectorInvocations` da ghi truoc khi validate, nen invariant ve site invoke van chung minh duoc. Neu handler throw TRUOC khi invoke, `calls.length === 0` -> test van FAIL (khong che loi).
- Viec ap dung prompt that van phu thuoc carrier `pinned.promptOverrides` khac null/absent (producer hien `{}`/`null`) va provider-side session/prompt semantics — thuoc leg live/Connector, chua chung minh.

**File da ghi:** `src/actions/{ingest,analyze,generate,compare,transform}/index.ts` (trong lease actions/*), `tests/p745-carrier-impl-b2.test.ts` (extend). Khong cham contracts/runtime/submission/worker-sdk.
