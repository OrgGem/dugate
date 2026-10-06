# WORKER-TEMPLATE-PILOT-890 - receipt (dependency map complete; materialisation NOT done)

> **RESUME POINT (qwen_5, 2026-10-05)** - task WORKER-TEMPLATE-PILOT-890R (task_8af7a4699d4c).
> **Status: the dependency map is COMPLETE and measured. The vendoring was NOT materialised.**
> No template directory created, no source vendored, no isolated build run. No commit, no tick.
>
> Why: context exhausted again, but this time before any write - so nothing is half-built. The map
> below is the deliverable; it is what the next session needs and it is expensive to re-derive.

---

## 1. Measured dependency map of `businesses/document-core`

### 1a. Declared workspace deps (`package.json`)

```
"@du/contracts":    "workspace:*"
"@du/document-kit": "workspace:*"
"@du/worker-sdk":   "workspace:*"
"zod": "^3.23.8"
```

### 1b. A SECOND, deeper dependency: tsconfig paths into sibling BUILD OUTPUT

`tsconfig.json` and `tsconfig.test.json` both declare:

```
"paths": {
  "@du/orchestrator": ["../../services/orchestrator/dist/index.d.ts"],
  "@du/connector":    ["../../services/connector/dist/index.d.ts"]
}
```

**This is the acceptance-critical one.** A template cannot be self-contained while its tsconfig resolves
types from a sibling service `dist/` that only exists after that service is built. Item (4) isolated build
will fail on this before it fails on any `workspace:*` import.

Note: no `src/**` import of `@du/orchestrator` or `@du/connector` appeared in the grep (section 1c), so the
paths may be vestigial - **verify before deleting them**; if unreferenced, dropping them is the fix.

### 1c. Every sibling import site (file:line, exact symbols)

| Source | Package | Symbols |
|---|---|---|
| `src/actions/compare/index.ts:9` | document-kit | `DiffEngine` |
| `src/actions/extract/index.ts:11` | worker-sdk | `LeaseLostError` |
| `src/actions/ingest/index.ts:9` | document-kit | `DocumentFormatDetector`, `PdfSplitter` |
| `src/actions/ingest/index.ts:12` | contracts | `CONNECTOR_ARTIFACT_MAX_BYTES`, `InvocationArtifactContent` |
| `src/actions/prompt-application.ts:2` | contracts | `PinnedProfilePolicy`, `PinnedPromptOverride` |
| `src/actions/session-seam.ts:1` | contracts | `PinnedProfilePolicy` |
| `src/main.ts:1` | worker-sdk | `createLogger` |
| `src/pipelines/parser-budget.ts:33` | contracts | `MULTIPART_MIN_TOTAL_BYTES` |
| `src/pipelines/parser-budget.ts:41` | worker-sdk | `ArtifactStreamError`, `createTempWorkspace` |
| `src/pipelines/step-checkpoint.ts:3` | worker-sdk | `LeaseLostError` |
| `src/pipelines/step-checkpoint.ts:4` | worker-sdk | `SealedArtifact` (type) |
| `src/types/actions.ts:5` | contracts | `IngestionReceipt` (type) |
| `src/types/context.ts:1` | contracts | `ArtifactRef`, `PinnedProfilePolicy`, `PinnedPromptOverride` |
| `src/types/context.ts:2` | document-kit | `SupportedFormat` (type) |
| `src/types/context.ts:3` | worker-sdk | `TaskArtifactCrypto` (type) |
| `src/validation/input-normalizer.ts:11` | contracts | `resolveIngestionSource`, `IngestionReceipt` |
| `src/worker.ts:22` | document-kit | `DocumentFormatDetector` |
| `src/worker.ts:80` | worker-sdk | `LeaseLostError`, `TaskArtifactBinding`, `TaskArtifactCrypto`, `WorkerCryptoSeam` |
| `src/worker.ts:399,437` | contracts | `InvocationArtifactContent` (inline `import(...)` type) |

**Total: 3 packages, 20 import sites, 18 distinct symbols.**

## 2. Vendoring plan (what to materialise, with provenance)

### `@du/contracts` - vendor a subset, not the package

| Symbol | Source |
|---|---|
| `IngestionReceiptSchema` + `IngestionReceipt` | `packages/contracts/src/operations.ts:335-347` |
| `INGESTION_HANDLE_REGEX` | `packages/contracts/src/operations.ts` (same file, above :335) |
| `PinnedProfilePolicySchema` / `PinnedProfilePolicy` | `packages/contracts/src/runtime.ts:69-70` |
| `PinnedPromptOverrideSchema` / `PinnedPromptOverride` | `packages/contracts/src/runtime.ts:83-89` |
| `ArtifactRef` | `packages/contracts/src/*` (locate before vendoring) |
| `CONNECTOR_ARTIFACT_MAX_BYTES`, `InvocationArtifactContent` | `packages/contracts/src/connector.ts` |
| `MULTIPART_MIN_TOTAL_BYTES` | `packages/contracts/src/*` |
| `resolveIngestionSource` | `packages/contracts/src/*` |

**Transitive trap:** `PinnedProfilePolicy = ProfilePolicySnapshotSchema` is an **alias**, not an inline
schema (`runtime.ts:69`). It pulls in `profile-policy.ts` and its nested schemas
(`ProfileParametersSchema`, `ProfileJobPrioritySchema`, `ProfileAllowedFileExtensionsSchema`,
`ProfileConnectionsOverrideSchema`, `ProfileCredentialRefSchema`). Vendor that closure, or the vendored
file will not typecheck.

### `@du/worker-sdk` - vendor SOURCE with a pin (no build artifact)

Symbols: `LeaseLostError`, `createLogger`, `createTempWorkspace`, `ArtifactStreamError`, `SealedArtifact`,
`TaskArtifactCrypto`, `WorkerCryptoSeam`, `TaskArtifactBinding`.

**Packet rule:** do NOT import from a `@du/worker-sdk` build artifact and do NOT build a separate SDK.
Vendor the `.ts` source under a pinned path with provenance.

### `@du/document-kit`

Symbols: `DiffEngine`, `DocumentFormatDetector`, `PdfSplitter`, `SupportedFormat`. These are the
**executable** document-parsing helpers item (6) protects - they must stay code, never become markdown.

## 3. Provenance record to write with each vendored file

```
// VENDORED from @du/<pkg> @ <version-or-commit> on 2026-10-05
// source: packages/<pkg>/src/<file>.ts:<startLine>-<endLine>
// why: <symbol(s)> required by src/<consumer>.ts
```

## 4. Acceptance procedure (item 4) - must be PROVEN, not asserted

1. `package.json`: remove all three `workspace:*` entries; point at the vendored local paths.
2. `tsconfig.json`: **remove the `@du/orchestrator` / `@du/connector` `paths`** (verify unreferenced first).
3. Prove isolation by building where siblings are **absent**, e.g. copy `businesses/document-core` (plus
   the template) to a temp dir OUTSIDE the repo and run the build there. A build that still resolves
   `../../services/*/dist` or a sibling `node_modules` has NOT passed.
4. Record the literal exit code of that out-of-repo build.

## 5. Ledger

- WORKER-TEMPLATE-PILOT-890R - Muc 1 - **dependency map complete and measured**: 3 declared workspace deps,
  a SECOND tsconfig `paths` dependency on sibling service `dist/`, 20 import sites / 18 symbols, and the
  `PinnedProfilePolicy` alias trap that pulls in the whole `profile-policy.ts` closure. Vendoring plan and
  provenance format written. **Materialisation NOT done** - no template created, nothing vendored, no
  isolated build, no test run. No commit, no tick.

---

## 6. WORKER-TEMPLATE-PILOT-890R2 — PHASE 1 inventory captured (qwen_2, 2026-10-05)

**Status: Phase 1 inventory MEASURED and pinned. Materialisation NOT started — deliberately, so nothing is half-built.**

### Pin (base)

- Repo base commit: **`b088eececcb5f3df0b4edbe073a29401dafda624`** (2026-10-02 14:27:29 +07).
- Package versions at capture: `@du/contracts` 0.1.0 · `@du/worker-sdk` 0.1.0 · `@du/document-kit` 1.0.0.
- **Caveat:** the shared worktree is dirty (many lanes). The hashes below are of the **working tree at 2026-10-05**, not of `b088eec`. A vendor pin must record BOTH: base commit + per-file sha256.

### Exact source files defining the required symbols (file:line measured)

| Vendored source file | lines | sha256[0:16] | Defines (file:line) |
|---|---|---|---|
| `packages/contracts/src/operations.ts` | 403 | `34454DD2AB549A47` | `ArtifactRef` :169 · `IngestionReceiptSchema` :335 · `resolveIngestionSource` :397 |
| `packages/contracts/src/runtime.ts` | 540 | `66656BD6CADFC79F` | `PinnedProfilePolicySchema` :69 · `MULTIPART_MIN_TOTAL_BYTES` :339 |
| `packages/contracts/src/connector.ts` | 189 | `859979838C367631` | `CONNECTOR_ARTIFACT_MAX_BYTES` :8 · `InvocationArtifactContentSchema` :26 |
| `packages/contracts/src/profile-policy.ts` | 594 | `41C79CB3655B4938` | the `PinnedProfilePolicy` alias closure (map §2 trap) |
| `packages/worker-sdk/src/crypto-seam.ts` | 158 | `54C238AA566BCF04` | `WorkerCryptoSeam` :34 · `TaskArtifactBinding` :43 · `SealedArtifact` :56 · `TaskArtifactCrypto` :69 |
| `packages/worker-sdk/src/task-context.ts` | 960 | `F81D4D56D782F168` | `LeaseLostError` :52 |
| `packages/worker-sdk/src/artifact-streams.ts` | 984 | `21CD0FA96956AB7D` | `ArtifactStreamError` :63 (+ `createTempWorkspace`) |
| `packages/document-kit/src/types.ts` | 123 | `D1B18CBA1AC80F9E` | `SupportedFormat` :5 |
| `packages/document-kit/src/converters/diff-engine.ts` | 102 | `4913A030EBCBF972` | `DiffEngine` :6 |
| `packages/document-kit/src/formats/pdf-splitter.ts` | 280 | `1944DB98BD082944` | `PdfSplitter` :6 |
| `packages/document-kit/src/formats/detector.ts` | 172 | `B076CBC15F8193D2` | `DocumentFormatDetector` :7 |

### Two symbols NOT yet located (blocking a clean vendor)

- **`createTempWorkspace`** — used by `parser-budget.ts:41` but NOT found by an `export … createTempWorkspace` grep in `packages/**`; its defining file must be found before vendoring.
- **`INGESTION_HANDLE_REGEX`** — named in map §2 for `operations.ts` but **not found** by the same export grep. Verify it still exists; do **not** vendor a symbol that is gone.

### Why materialisation was NOT started (honest, not a stall)

Vendoring the three `document-kit` executables is **not a leaf operation**: `DocumentFormatDetector` / `PdfSplitter` / `DiffEngine` are the executable helpers the pilot must keep as code, and they import further `document-kit` internals (parsers / zip / converters). Vendoring them pulls a transitive closure well beyond the 18 symbols. Starting that with the remaining budget would leave a **half-vendored tree** — exactly what the 890R notes say to avoid.

### Next session — exact first actions

1. Resolve the two missing symbols (locate `createTempWorkspace`; confirm/deny `INGESTION_HANDLE_REGEX`).
2. Compute the transitive closure of the three `document-kit` files **before** copying anything (import graph, not symbol list).
3. Then vendor one package at a time, writing the §3 provenance header on every file, and report after each package.


### §7.1 — 2 missing symbols RESOLVED (Antigravity unblock, 2026-10-05) + closure measured

- **`createTempWorkspace`** — found, `export async function` at **`packages/worker-sdk/src/artifact-streams.ts:159`** (Antigravity reported `:88`; measured line is **159**), re-exported via `packages/worker-sdk/src/index.ts`. Vendoring `artifact-streams.ts` covers it.
- **`INGESTION_HANDLE_REGEX`** — found as a **PRIVATE** const at **`packages/contracts/src/operations.ts:312`** (`/^[-!-~]+$/`, printed via `\x20-\x7e` in source). It is NOT exported; it is consumed *inside* `operations.ts` by `IngestionReceiptSchema` (`:337`, `:341`). **No export needed** — vendoring `operations.ts` whole carries it.

**Transitive closure — measured (import-graph, not symbol-list):**

```
contracts (7 files):
  operations.ts      -> ./ip-policy, ./encryption
  runtime.ts         -> ./operations, ./encryption, ./profile-policy
  connector.ts       -> (no local import; zod only)
  profile-policy.ts  -> ./request-redaction
  CLOSURE = { operations, runtime, connector, profile-policy,
              ip-policy, encryption, request-redaction }   (7, all inside contracts)

document-kit (5 files):
  types.ts                    -> (leaf)
  converters/diff-engine.ts   -> ../types
  formats/pdf-splitter.ts     -> ../types           (+ external pdf-lib)
  formats/detector.ts         -> ../types, ../archives/zip-extractor
  archives/zip-extractor.ts   -> ../types + node path/zlib/crypto  (692 lines)
  CLOSURE = { types, diff-engine, pdf-splitter, detector, zip-extractor } (5, all inside document-kit)

worker-sdk (3 files):
  crypto-seam.ts      -> (leaf)
  task-context.ts     -> heavy internal deps (960 lines) — NOT a leaf
  artifact-streams.ts -> ArtifactStreamError + createTempWorkspace (:63, :159)  (984 lines, not a leaf)
  CLOSURE = { crypto-seam } is leaf-only; the other two pull most of worker-sdk.
```

**Critical new finding for Phase 1 planning:** `LeaseLostError` lives in `task-context.ts` and `ArtifactStreamError`/`createTempWorkspace` in `artifact-streams.ts` — both are **large non-leaf worker-sdk files**. Vendoring them whole is close to vendoring the whole SDK. The alternative (extract the 3 symbols into small vendored files) is a code change, not a copy, and must be decided before any copy starts.

**Vendor status:** NOTHING copied. No template dir created. No file has a provenance header yet. No package.json/tsconfig edit. No build, no test. No commit, no tick.

## 8. PHASE 1 — PACKAGE 1 (@du/contracts) VENDORED COMPLETE (qwen_2, 2026-10-05)

**Location:** `businesses/document-core/template/vendor/contracts/src/` (7 files).

| File | srcLines | src sha16 | vendored sha16 |
|---|---|---|---|
| `operations.ts` | 403 | `34454DD2AB549A47` | `57E06B0FE191D8B1` |
| `runtime.ts` | 540 | `66656BD6CADFC79F` | `7A0EC41F35F3212D` |
| `connector.ts` | 189 | `859979838C367631` | `13DA0D8957C4A6F9` |
| `profile-policy.ts` | 594 | `41C79CB3655B4938` | `A142F61432813205` |
| `ip-policy.ts` | 279 | `B5A78AFBD8C16C5E` | `3D72028F4E9D455B` |
| `encryption.ts` | 299 | `395E08800E3E7D6B` | `85890B54C1D17B55` |
| `request-redaction.ts` | 13 | `39AAC7F386092C03` | `381148CEFB50A809` |

**Provenance header** on every file (byte-prepended, body untouched):
```
// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/contracts/src/<file>.ts (lines=N) sha256=<full>
// why: <symbols> for <consumers>
```

**Closure VERIFIED CLOSED:** after vendoring, grepped the 3 newly-pulled files (`encryption.ts`, `ip-policy.ts`, `request-redaction.ts`) for `^import .* from './` → **no matches**. The 7-file set is self-contained apart from `zod` (already a document-core dep).

**Method note (tooling):** copy was **byte-level** (`ReadAllBytes` + `Write`), NOT `Get-Content`/`Set-Content` — the latter double-encodes UTF-8 and adds a BOM. The first script attempt failed because the exec layer decoded the PowerShell `` `n `` escape into a real newline; fixed by using `[char]10` instead of any backtick.

**Not done:** no `package.json` / `tsconfig.json` edit (Phase 2), no document-kit or worker-sdk vendor, no isolated build (Phase 3). No commit, no tick.

### Worker-sdk decision point (for coordinator, per Antigravity instruction)

Two options, both with a real cost — **not decided by this lane**:

- **Option A — vendor the 2 large files whole** (`task-context.ts` 960 lines, `artifact-streams.ts` 984 lines). Simple, but it pulls most of worker-sdk's own imports, so the 'vendor' becomes a near-copy of the SDK — defeating the pilot's purpose.
- **Option B — extract the 3 needed symbols** (`LeaseLostError`, `ArtifactStreamError`, `createTempWorkspace`) into small vendored files. Keeps the template lean, but it is a **code change, not a copy**, and must be reviewed before it starts.

**Recommendation:** Option B, because the pilot's whole point is that document-core stops depending on the sibling; vendoring 1900 lines of SDK to avoid 3 symbols inverts that. But Option B needs a reviewer sign-off before implementation.

**Next:** vendor document-kit (5 files + `pdf-lib` dep) once the worker-sdk option is settled, or in parallel if the coordinator prefers.

## 9. PHASE 1 — PACKAGE 2 (@du/document-kit) + OPTION B (worker-sdk) LANDED (qwen_2, 2026-10-05)

**Location:** `businesses/document-core/template/vendor/` → `document-kit/src/`, `worker-sdk/src/`.

### 9.1 document-kit — 5 files VENDORED (whole file, closure preserved)

| File | srcLines | src sha16 | vendored sha16 |
|---|---|---|---|
| `types.ts` | 123 | `D1B18CBA1AC80F9E` | `526223F78E38BFB1` |
| `converters/diff-engine.ts` | 102 | `4913A030EBCBF972` | `8CFEFDB8E88A9938` |
| `formats/pdf-splitter.ts` | 280 | `1944DB98BD082944` | `86381A4CF220A078` |
| `formats/detector.ts` | 172 | `B076CBC15F8193D2` | `9F857D4EB0BCDC43` |
| `archives/zip-extractor.ts` | 691 | `EBECDD01F3767313` | `DDD13F7A4D280F2D` |

**Closure VERIFIED CLOSED** (grepped the vendored copies): every `from '../'`/`from './'` resolves inside the vendored tree — `../types` (x4) + `../archives/zip-extractor` (x1). Only remaining external dep is **`pdf-lib`** (used by `pdf-splitter.ts`).

### 9.2 Option B — worker-sdk 3 symbols EXTRACTED (not whole-file copy)

`vendor/worker-sdk/src/index.ts` — holds `LeaseLostError`, `ArtifactStreamError` (+ `ArtifactStreamErrorCode`), `createTempWorkspace` (+ `TEMP_WORKSPACE_PREFIX`, `liveWorkspaces`, `TempWorkspace`/`TempWorkspaceOptions`, `sanitizeTaskId`, `assertSafeFileName`, `WINDOWS_RESERVED`).

- **Typecheck: `npx tsc --noEmit --skipLibCheck --target es2020 --module commonjs --moduleResolution node --strict` → Exit Code: 0, no errors.**
- **Extraction, not rewriting** — every symbol body is copied from upstream with its original logic and comment; only the module wrapper is new. Line provenance is in the file header.
- **Accepted deviation from upstream (documented):** the extracted `ArtifactStreamErrorCode` union lists the 11 codes needed; if upstream adds a code, the vendored copy must be re-synced. `liveWorkspaces` stays in scope because the sweeper (not vendored) is the other writer.

### 9.3 Still open (Phase 2 / Phase 3)

- Phase 2: `package.json` / `tsconfig.json` not edited — document-core still declares `workspace:*` and the tsconfig `paths` into `../../services/*/dist`.
- Phase 3: no isolated out-of-repo build, no tests run.
- **`pdf-lib` must be added** to the template deps when Phase 2 rewires imports.

### Ledger

- WORKER-TEMPLATE-PILOT-890R2 — Muc 2 — **Package 1 (@du/contracts, 7 files) + Package 2 (@du/document-kit, 5 files) VENDORED, Option B (worker-sdk 3 symbols) EXTRACTED, typecheck exit 0.** Phase 2/3 NOT done. No commit, no tick.

## 10. PHASE 2 + PHASE 3 — DECLARED + ISOLATED BUILD PROVEN (qwen_2, 2026-10-06)

### Phase 2 — declaration rewire (template-local)

- **`template/package.json`** — name `@du/document-core-template`, **KHONG con `workspace:*`**. deps = `zod ^3.23.8`, `pdf-lib ^1.17.1`; devDeps = `@types/node ^20.19.0`, `typescript ^5.4.0`. Scripts `build` / `typecheck`.
- **`template/tsconfig.json`** — `paths` tro vao LOCAL VENDORED barrels, **khong con `@du/orchestrator` / `@du/connector`** (dependency vao `../../services/*/dist` da bi loai):
```json
"paths": {
  "@du/contracts":    ["vendor/contracts/src/index.ts"],
  "@du/document-kit": ["vendor/document-kit/src/index.ts"],
  "@du/worker-sdk":   ["vendor/worker-sdk/src/index.ts"]
}
```
- **Barrels bridge**: `vendor/contracts/src/index.ts` (7 re-export), `vendor/document-kit/src/index.ts` (5), `vendor/worker-sdk/src/index.ts` (Option B). File extracted doi ten thanh `worker-sdk-symbols.ts` de barrel khong tu-import.

### Phase 3 — ISOLATED BUILD (bang chung thuc te, khong phai assert)

Thu tuc: copy `template/` ra **`%TEMP%/p730-iso/template` (NGOAI repo)**, loai `node_modules`/`dist`; copy CHI `zod`, `pdf-lib`, `typescript`, `@types/node` tu pnpm store vao `node_modules` cua cay co lap; chay tsc.

```
TEMPLATE_OUTSIDE_REPO=True
DEP_OK zod
DEP_OK pdf-lib
DEP_OK typescript
DEP_OK @types/node
TSC_EXIT=0
```

**Vi sao day la bang chung:** cay co lap khong co sibling `du-rework/`, nen `../../services/*/dist` khong ton tai va khong `node_modules` nao cua repo cham toi duoc. Hai lan chay, doc trung thuc:

- **Lan 1 (`TSC_EXIT=2`)** — moi loi deu la `TS2580 Cannot find name 'Buffer'` / `TS2307 Cannot find module 'path'|'zlib'|'crypto'` = **thieu `@types/node`**. Dac biet: **KHONG** co loi `Cannot find module '@du/*'` va **KHONG** co loi resolve `../../services/*/dist` — tuc la buoc rewire `paths` cua Phase 2 da chay dung; chi thieu mot devDep chuan.
- **Lan 2 (`TSC_EXIT=0`)** — them `@types/node` → **build sach**.

### Con mo (ghi trung thuc)

- Build nay bien dich **cay vendored** (`include: vendor/**/*.ts`). `src/` cua document-core **chua** duoc rewire sang barrels — package.json that van dang `workspace:*`. Buoc tiep: rewire import cua src (hoac chung minh barrels du moi symbol `@du/*` ma document-core dung).
- **Phai chay lai Phase 3 sau khi rewire** — exit 0 hien tai chung minh cay vendored tu chua, chua phai document-core build duoc tren no.
- Lan chay Phase 3 la **typecheck** (`--noEmit`); chua emit artifact va chua chay test.

### Ledger

- WORKER-TEMPLATE-PILOT-890R2 — Muc 3 — **Phase 2 da khai (khong `workspace:*`, khong paths services; barrels vendored) + Phase 3 isolated build DA CHUNG MINH: `TSC_EXIT=0` ngoai repo voi chi dep local.** Con rewire src doc-core + chay lai. Khong commit, khong tick.

## 11. PHASE 3 RE-RUN with `src/` REWIRED — 33 REAL GAP ERRORS MEASURED (2026-10-06)

### Cach chay (va vi sao lan dau `TSC_EXIT=0` KHONG tinh)

Copy `businesses/document-core/src` vao `template/src` (byte copy, byte-level), chay lai Phase 3 co lap.

**Lan truoc `include` chi la `vendor/**/*.ts` va `rootDir: vendor` → src KHONG duoc bien dich.** `TSC_EXIT=0` khi do chi chung minh cay vendored, khong chung minh gi cho document-core. Da sua `rootDir` -> `.` va `include` -> `["vendor/**/*.ts", "src/**/*.ts"]`, chay lai.

### Ket qua that (after fixing barrel thieu do toi tao leak)

- **`TSC_EXIT=2`, `ERROR_COUNT=33`.**
- Sua loi cua toi: barrel `vendor/worker-sdk/src/index.ts` lan dau khong duoc ghi (TS2307 `Cannot find module '@du/worker-sdk'`); da tao, hien tai khong con loi resolve nao — **moi loi con lai deu la TS2305/TS2724 (thieu symbol)**, tuc gap do su that.

### Missing-symbol inventory (do bang chung, dung cho buoc vendor tiep theo)

**`@du/contracts` — 4:** `BusinessManifest`, `ActionManifest`, `ConnectorSlotManifest`, `WIRE_CONTRACT_VERSION` (the manifest triet cho `src/manifest/*`).

**`@du/document-kit` — 6:** `FormatConverter`, `PiiRedactor`, `TemplateEngine`, `TextChunker` (src/actions/transform), `defaultParserFactory`, `DocumentParserFactory` (src/pipelines/parser-budget).

**`@du/worker-sdk` — 6+:** `createLogger` (src/main.ts), `SealedArtifact` (step-checkpoint), `resolveFanoutConcurrency`, `runBoundedFanout` (disbursement/fanout), `TaskArtifactCrypto` (types/context), va toan bo worker surface o `src/worker.ts` (`startWorker`, `defineBusiness`, `TaskHandler`, `WorkerConfig`, `WorkerHandle`, `QueueConsumer`, `LeaseLostError` da co).

**Cascade loi (khong phai gap doc lap):** `runtimeUrl` khong trong `DocumentCoreWorkerConfig`, `traceability.ts` implicit any, `connectorSlots` tren `{}` — se het khi cac manifest types len.

### Ket luan trung thuc

- **Option B giu template gon NHUNG khong dung rang buoc**: tach 3 symbol la du cho 20 import site trong PREP, nhung src document-core can nhieu hon nhieu. Lay lai toan bo symbols = gan nhu vendor ca SDK va ca document-kit (giong A nhoc nhat).
- **Bang chung ma buoc tiep can:** vi tri cho 4/6/6 symbol do (main file:line) roi vendor tung chuc. Khong sua gi tu`khi khong co chay phan tich do.
- Phase 3 van chua PASS cho document-core (exit 2).

### Ledger

- WORKER-TEMPLATE-PILOT-890R2 — Muc 4 — **Phase 3 rerun voi src: `TSC_EXIT=2`, 33 loi gap (4 contracts + 6 document-kit + 6+ worker-sdk + cascade). Thieu barrel worker-sdk da sua. Inventory missing symbols do chinh xac.** Khong commit, khong tick.

## 12. MANIFEST GROUP VENDORED — 33 -> 26 ERRORS (qwen_2, 2026-10-06)

### Da lam

- Vendor them **2 file contracts** (gu Provenance, byte-copy):
  - `manifest.ts` — 114 lines, src sha16 `64C823443654ED83` -> `BusinessManifest`/`ActionManifest`/`ConnectorSlotManifest`.
  - `version.ts` — 38 lines, src sha16 `490DA72632B9DB65` -> `WIRE_CONTRACT_VERSION` + `SCHEMA_LIMITS`.
- Closure: `manifest.ts -> ./version` (leaf). `version.ts` khong import gi -> **dong 2 file**.
- **Loi cua toi da sua:** 2 file vendored nhung **chua duoc them vao barrel** `vendor/contracts/src/index.ts` (cung 1 loi err voi barrel worker-sdk truoc do) — lan dau van do 4 TS2305 manifest. Da them `export * from './manifest'` + `'./version'`, chay lai.

### Ket qua (bang chung literal)

```
VENDORED manifest.ts lines=114 sha16=64C823443654ED83
VENDORED version.ts lines=38 sha16=490DA72632B9DB65
TSC_EXIT=2
ERROR_COUNT=26
```

**Giam 33 -> 26 = 7 loi (21.2%).** Cac loi da het:

| Lien quan | Trang thai |
|---|---|
| `BusinessManifest`, `ActionManifest`, `ConnectorSlotManifest`, `WIRE_CONTRACT_VERSION` (4) | **DA HOA** |
| `traceability.ts` implicit any x2 + `connectorSlots` tren `{}` (3 cascade) | **DA HOA** — dung duong nhu du doan |

### 26 loi con lai (khong doi, chua vendor)

- **document-kit (6):** `FormatConverter`, `PiiRedactor`, `TemplateEngine`, `TextChunker` (transform), `defaultParserFactory`, `DocumentParserFactory` (parser-budget).
- **worker-sdk (17+):** `createLogger`, `SealedArtifact`, `resolveFanoutConcurrency`, `runBoundedFanout`, `TaskArtifactCrypto`, `defineBusiness` + toan bo surface `src/worker.ts` (`startWorker`, `TaskHandler`, `WorkerConfig`, `WorkerHandle`, `QueueConsumer`, ...).
- 1+ cascade lien quan `runtimeUrl` trong `DocumentCoreWorkerConfig`.

### Hoc hop — loi trung lap dang quan sat

Hai lan lien tiep (worker-sdk barrel, contracts barrel) tich file vendor nhung **quen barrel**. Next time: **sau khi copy 1 file phai mo barrel cung lap, roi chay tsc, trong khi trang trai` chua chay tsc (phat hien 33/26 chi sau khi vay).

### Ledger

- WORKER-TEMPLATE-PILOT-890R2 — Muc 5 — **Manifest group (2 file) vendored; barrel da them; 33 -> 26 loi (giam 7, 4 manifest + 3 cascade hoa toan bo).** Phase 3 van `TSC_EXIT=2`. Khong commit, khong tick.

## 13. DOCUMENT-KIT GROUP VENDORED — 26 -> 20 ERRORS (qwen_2, 2026-10-06)

### Da vendor (11 file, byte-copy + provenance header)

| File | lines | src sha16 |
|---|---|---|
| `converters/pii-redactor.ts` | 70 | `5F7B440B275FA234` |
| `converters/format-converter.ts` | 78 | `1A7DB031E41EB852` |
| `converters/text-chunker.ts` | 57 | `9BF2CEA5F369A9E3` |
| `converters/template-engine.ts` | 39 | `3B89B5BDA6DE5172` |
| `parsers/factory.ts` | 142 | `971FECC350B2F6AB` |
| `parsers/text-parser.ts` | 72 | `992BC845C05595DC` |
| `parsers/word-parser.ts` | 231 | `DB1E5E317503DBBF` |
| `parsers/excel-parser.ts` | 393 | `6D47CB0445CA97FF` |
| `parsers/pdf-parser.ts` | 122 | `AFCBEDC62F52F851` |
| `parsers/limits.ts` | 84 | `4A6F95BD46E7B8C1` |
| `parsers/worker-isolation.ts` | 192 | `665EB4CBE8C03B43` |

**Luu:** `parsers/factory.ts` keo them 6 file transitive (4 parser + `limits` + `worker-isolation`) — cho nen 4 `converters` + 11 file co the va `types` da co. Tong document-kit = 16 file.

### Barrel updated CUNG LAN CHAY (bai hoc Muc 5 da ap dung)

`vendor/document-kit/src/index.ts` duoc ghi lai toan bo **trong cung mot script** sau khi copy — `BARREL_EXPORTS=16` (16 `export *`). Khong con loi vao `BARREL_EXPORTS` o bat ky lan chay nao.

### Bang chung literal

```
BARREL_EXPORTS=16
TSC_EXIT=2
ERROR_COUNT=20
```

**Giam 26 -> 20 = 6 loi (toan bo 6 mat document-kit cung thanh hien), 23.1%.** Toan bo `error TS2305`/`TS2724` cua `@du/document-kit` khong con.

### 26 -> 20: 20 loi con lai = cung mot nhom worker-sdk (19) + 1 contracts

- **`@du/worker-sdk` (19):** `createLogger`, `SealedArtifact`, `resolveFanoutConcurrency`, `runBoundedFanout`, `TaskArtifactCrypto`, `defineBusiness`, `startWorker`, `TaskHandler`, `TaskContext`, `BusinessDefinition`, `WorkerConfig`, `WorkerHandle`, `QueueConsumer`, `TaskArtifactBinding`, ...
- **`@du/contracts` (1):** `TaskDisposition`.
- **Cascade (1+):** `runtimeUrl` khong trong `DocumentCoreWorkerConfig`.

### Ledger

- WORKER-TEMPLATE-PILOT-890R2 — Muc 6 — **Document-kit group (11 file) vendored + barrel update CUNG LAN (16 exports); 26 -> 20 loi (giam 6).** Con lai 19 worker-sdk + 1 contracts. Phase 3 van `TSC_EXIT=2`. Khong commit, khong tick.

## 14. FINAL GROUPS VENDORED — 26 -> 20 -> 17 ERRORS (qwen_2, 2026-10-06)

### Da vendor them

- **contracts `sdk.ts`** — 50 lines, sha16 `5E193929A19A5447` → `TaskDisposition`.
- **contracts `errors.ts`** — 120 lines, sha16 `C2D82F050D5263B8` → `ConnectorErrorCodes`, `ConnectorErrorCode`, `ProblemSchema`, `ProblemDetails`.
- **worker-sdk 15/15 file src** (byte-copy + provenance): artifact-multipart 348, artifact-streams 984, bounded-fanout 82, connector-invoker 236, connector-session 324, crypto-seam 158, crypto-storage 984, fan-out 717, runtime-client 289, source-acquisition 391, source-ingestion 493, task-context 960, types 380, worker 555.
- **observability 7 file**: context 56, elasticsearch-collector 845, log-events 61, log-metadata 42, logger 169, metrics 203, redaction 136.
- **egress 2 file**: index 9, pinned-fetch 365.

### Barrels (3 lan chay, quen barrel 3 lan — cua toi)

`contracts/index.ts` (11 exports, da co errors) · `worker-sdk/index.ts` (14) · `observability/index.ts` (7, **Tao sau khi chan chinh** — lan chay thu 2 moi phat hien `TS2307 Cannot find module '@du/observability'`).

### Bang chung literal (3 lan isolated)

```
Lan A: TSC_EXIT=2  ERROR_COUNT=20   (sau worker-sdk + observability + contracts sdk.ts)
Lan B: TSC_EXIT=2  ERROR_COUNT=25   (them contracts errors/egress, nhung barrel obs thieu)
Lan C: TSC_EXIT=2  ERROR_COUNT=17   (tao observability barrel)
```

**26 -> 20 -> 17**. Tien do thuc te do cac ban do; 25 la thap xuong do barrel quen, khong phai do cod.

### 17 loi con lai (do chinh xac, cho phien sau)

- **contracts (7-8 symbol):** `hashInvocationInput`, `contentHash`, `BusinessJobV1`, `BusinessJobV1Schema`, `businessQueueName`, `validateManifest` + cac luu y con lai (queue.ts likely).
- **worker-sdk barrel:** `createLogger` — barrel moi cua toi CHI re-export file local, khong con re-export tu `@du/observability` nhu barrel goc. **Fix 1 dong**: them `export { createLogger } from '@du/observability';` vao `vendor/worker-sdk/src/index.ts` (hoac doi `src/main.ts` import truc tiep).
- **2 loi type that:** `fan-out.ts:358` `Buffer` khong giao cho `BodyInit`; `runtime-client.ts:97` `cause` khong ton tai tren `AmbiguousReportError`. Day la **khac biet lib/tsconfig** (cod goc chay voi `dom` lib), khong phai gap symbol.

### Trang thai

- Vendor hien tai: contracts 10 + worker-sdk 15 + document-kit 16 + observability 7 + egress 2 = **50 file vendored** + 5 barrels.
- **Phase 3 van chua PASS** (`TSC_EXIT=2`, 17 loi).
- Duong di con lai qua `1c` 2 den: (1) vendor 7-8 symbol contracts con lai + 1 dong barrel `createLogger`; (2) lam ro 2 loi lib (them `dom` vao tsconfig hoac sua type).
- Khong commit, khong tick.

### Ledger

- WORKER-TEMPLATE-PILOT-890R2 — Muc 7 — **worker-sdk 15 + observability 7 + egress 2 + contracts sdk/errors vendored; 26 -> 17 loi; 3 lan isolated exit 2.** Van `TSC_EXIT=2`. Khong commit, khong tick.

## 15. FINAL PASS ATTEMPT — 17 -> 7 -> 1 ERROR (2026-10-06)

### Ba fix da chot (dung chi dao)

1. **`dom` + `dom.iterable` trong `lib`** — sua `FormData.entries`, `cause` (target `es2022`).
2. **`export { createLogger } from '@du/observability';`** them vao barrel worker-sdk.
3. **Vendor 4 contracts con lai**: `queue.ts` (57) `8CF57F09B6C910AF` · `manifest-validator.ts` (122) `F909EDA5ECBC6F71` · `hashing.ts` (95) `A0FFAFE5219F760F` · `json-schema-guard.ts` (95) `FAB971307B5A3E9F`. + `bullmq ^5.34.0` vao package.json va deps isolated.

### Bang chung literal (4 lan isolated)

```
Lan A: ERROR_COUNT=7   (sau worker-sdk + obs + sdk.ts + errors.ts + egress)
Lan B: ERROR_COUNT=1   (sau 3 fix tren + target es2022)
Lan C: ERROR_COUNT=91  (test khac: lib = [ES2022] khong dom -> thieu fetch/FormData types)
Lan D: ERROR_COUNT=1   (khoi lai lib = [ES2022, dom, dom.iterable])
```

### 1 loi con lai (do cu the, khong phai gap symbol)

`vendor/worker-sdk/src/fan-out.ts:358` — `Type 'Buffer<ArrayBufferLike>' is not assignable to type 'BodyInit | null | undefined'`.

- **Nguyen nhan:** xung dot loai giua `@types/node@20.19.43` (undici-types) va `lib.dom` `BodyInit`.
- **Loai test da loai duoc (KHONG phai do code):** `lib: [ES2022]` (giong tsconfig.base.json) gay **91 loi** vi `@types/node` khong cap `RequestInit.headers` / `Headers.forEach` / `FormData.entries` global. `lib: [ES2022, dom, dom.iterable]` = **tot nhat** = 1 loi.
- **Hai cach giai quyet con lai (danh cho chu quyet):**
  - **(a) sua 1 dong cast** trong fan-out:58 `String.fromCharCode(46,46)` vi `as BodyInit`. Do la **doi doc source vendored**, can reviewer phe duyet.
  - **(b) vuot bang `skipLibCheck` khong duoc** (day la loi nguon khong phai loi lib) — thuc te la can hoa don `@types/node` va `lib.dom`.

### Trang thai cuoi

- **54 file vendored** (contracts 15 + worker-sdk 15 + document-kit 16 + observability 7 + egress 2) + 4 barrels.
- **Phase 3 isolated: `TSC_EXIT=2`, `ERROR_COUNT=1`** (tu 33, 26, 20, 17, 7, 1 — 97%).
- Khong commit, khong tick.

### Ledger

- WORKER-TEMPLATE-PILOT-890R2 — Muc 8 — **3 fix da chot + 4 contracts files vendor; 17 -> 1 loi.** Loi cuoi la xung dot lib/`@types/node`, khong phai gap symbol; hai cach quyet de cho chu quyet. `TSC_EXIT=2` van chua 0. Khong commit, khong tick.

## 16. PHASE 3 PASSES — `TSC_EXIT=0`, `ERROR_COUNT=0` (2026-10-06)

### Fix cuoi (duyet option (a))

`vendor/worker-sdk/src/fan-out.ts` (body PUT ~dang 358):
```ts
// VENDOR PATCH (approved option a): @types/node undici-types and
// lib.dom disagree on BodyInit vs Buffer. Upstream compiles because
// its own lib set differs; behaviour is unchanged, types only.
body: buffer as unknown as BodyInit,
```
- **Cast type-only, khong doi runtime.** Day la VENDOR PATCH duyet bo, ghi ro trong source de khong hong noi document.
- Tham chieu con lai xac suat cao: do la **nguon bi thay doi** duy nhat trong toan bo 55 file vendored.

### Bang chung literal (lan cuoi)

```
VENDORED json-schema-guard.ts lines=95 sha16=FAB971307B5A3E9F
CONTRACTS_BARREL=15
DEP_OK zod
DEP_OK pdf-lib
DEP_OK typescript
DEP_OK node
DEP_OK bullmq
TSC_EXIT=0
ERROR_COUNT=0
```

**`TSC_EXIT=0`, `ERROR_COUNT=0` — isolated typecheck PASS.** Bo duong 33 -> 26 -> 20 -> 17 -> 7 -> 1 -> **0** (97% giam, roi het).

### Cac buoc da dat cho cac phien tiep

- **Vendor:** 55 file (contracts 15 + worker-sdk 15 + document-kit 16 + observability 7 + egress 2), moi file co provenance header (base commit `b088eecc` + per-file sha256).
- **`package.json`:** khong `workspace:*`; deps = `zod`, `pdf-lib`, `bullmq`; devDeps = `@types/node`, `typescript`.
- **`tsconfig.json`:** `target ES2022`, `lib [ES2022, dom, dom.iterable]`, `rootDir "."`, `include [vendor, src]`, **paths 5 package den barrels local** (`@du/contracts`, `@du/document-kit`, `@du/worker-sdk`, `@du/observability`, `@du/egress`); khong con `@du/orchestrator`/`@du/connector` vao `services/*/dist`.
- **Isolated procedure** (re-chay duoc): `%TEMP%/p730-final4.ps1` — copy template ra ngoai repo, copy 5 dep tu pnpm store, `tsc --noEmit`.

### Con mo (phai bao thu khong lam doi)

- **Chua chay build (emit) va chua chay test** — chi typecheck `--noEmit`. Nhu dung tai Muc 10, exit 0 nay **chua doc len test suite hay hanh vi chay**.
- **Chua chong doc lai vendor**: khong co kiem tra so voi src goc; 1 VENDOR PATCH da duyet (fan-out.ts).
- **Chua doi source document-core** (`workspace:*` va `tsconfig` trong bo chinh van cu). Day la **template candidate**, khong phai phien san cua document-core goc.
- Chua xong GATE theo thuong: khong commit, khong tick.

### Ledger

- WORKER-TEMPLATE-PILOT-890R2 — Muc 9 — **PHASE 3 PASSES: `TSC_EXIT=0` / `ERROR_COUNT=0` isolated ngoai repo.** 55 file vendored + 4 barrels + VENDOR PATCH fan-out.ts duyet. Chua build-emit, khong test. Khong commit, khong tick.
### Ledger

- WORKER-TEMPLATE-PILOT-PILOT-890R2 — Muc 1 — **Phase 1 inventory captured and pinned** (11 files, line counts + sha16, symbol map). Two symbols unresolved. Materialisation NOT started: no template dir, nothing vendored, no package.json/tsconfig edit, no isolated build, no test run. No commit, no tick.
