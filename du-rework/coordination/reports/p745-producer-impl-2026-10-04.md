# P745-PRODUCER-IMPL (step 1: marker-only) — 2026-10-04

**Packet:** P745-PRODUCER-IMPL (adjudications từ coordinator 22:48) · **Lane:** cc_1 (`term_c03791d1`) · task `task_9d1ffbf78b99`.
**Snapshot lease-announce:** 2026-10-04 22:43:11 +07 (15:43:11Z) · HEAD `b088eec` · offline; no commit/push; no tick.

## 0. LEASE-ANNOUNCE (trước khi ghi)

Single writer cho write-set sau (theo adjudication):

| File | Trạng thái trước | mtime_ns (pre) | SHA-256 (pre) |
|---|---|---|---|
| `services/orchestrator/migrations/0030_prompt_revisions_pin.sql` | **ABSENT** | — | — |
| `src/modules/operations/submission.ts` | có sẵn (W1 hot) | `1791113053845433600` | `1655be49d843093f733eec451ded511ec64826ac0efe234f377d8fcd8934f244` |
| `src/modules/runtime/runtime.ts` | có sẵn | `1791123264790188288` | `34c5f1e5f881081d9cdbcd8f454c210ffb96fc35f22cde797a957970671fe27f` |
| `src/app/bootstrap/create-app.ts` | có sẵn | `1790968473111780608` | `29fcbbbf7b92a01e1d8e625f23adf6fb91cceaa19066af3932b63283ce5664d0` |
| `tests/p745-prompt-producer-impl.test.ts` | MỚI | — | — |

**Cam kết trong runtime.ts:** giữ NGUYÊN `parsePinnedProfilePolicy` + P2 tuple fix (`runtime.ts:201-241`, "credentialRef does not match the OPERATION pinned identity") và T-SUB-04; chỉ sửa đúng dòng map `promptRevisions` (~:1634) + thêm 1 helper parse mới.
**Không chạm:** contracts, worker-sdk, document-core, profiles.ts, publish.ts, migration ≤0029, execution snapshot khác.

## 1. Adjudications áp dụng

- P2-a marker-only = phase 1; **Δ-1 (content carrier P2-b) ghi lại, không làm**.
- Cột `operations.prompt_revisions_pin jsonb NULL`; marker `[{connectionId, stepId, revision}]`; `revision = 'sha256:'+hex(sha256(connectionId|stepId|content))`.
- Claim map key **`connectionId::stepId`** (composite, luôn; `_default` → `connectionId::_default`).
- NULL pin (legacy) → `{}`; pin hỏng → fail-closed `INVALID_SCHEMA`; migration **0030**.

## 2. Evidence — file + lệnh + kết quả literal

### 2.1 Write set (post) + no-touch proof

| File | Trạng thái | mtime_ns (post) | SHA-256 (post) |
|---|---|---|---|
| `migrations/0030_prompt_revisions_pin.sql` | **MỚI** | `1791128611712283392` | `3709a5d4df0e3f8bf3021aca39ebe84f9818118af1c418490f095f67b2016625` |
| `src/modules/operations/submission.ts` | sửa (9 hunk nhỏ) | `1791128975323339264` | `3007bcfaf047cfce4be3bd69f0d5e0ecca6a21f3cfc491ea26ac615473c3fa03` |
| `src/modules/runtime/runtime.ts` | sửa (SELECT + parser + map; P2/T-SUB-04 nguyên) | `1791128703867496192` | `c4c7ff41ece181962c67a2325aada9c4a6228000608cc8f31edbf1d01d8836ac` |
| `src/app/bootstrap/create-app.ts` | sửa (import + 1 dòng wiring) | `1791128975323339264` | `b55c570665d3e0cf66e9d3adf4b1af9075ff6e2e383af164e7c631db762990ec` |
| `tests/p745-prompt-producer-impl.test.ts` | **MỚI** | `1791128731512176128` | `64b48771a768e5bd6165a7652403170dda8f446b7a111bca3b7e61a7eab06016` |

**No-touch (hash y hệt pre-lease):** `contracts/profile-policy.ts` `759c5100…4e80d`; worker-sdk `source-acquisition.ts` `be7ac23a…`; `file-url-auth.ts` `15cfbed3…`; `prompt-overrides.ts` `ca2ec15c…` (chỉ READ, không sửa); **`ingestion-consumer.ts` `b737b5fa…` + `acquisition-ref-resolver.ts` `4b0226c1…` giữ nguyên hash từ P730-ACQUIRE** (không đụng chéo packet).

**Git status scoped:** `M submission.ts`, `M runtime.ts`, `?? 0030_…sql`, `?? p745-prompt-producer-impl.test.ts`, `?? create-app.ts (untracked có sẵn — CONV split)`, `?? receipt`.

### 2.2 Lệnh + literal (cwd `du-rework/services/orchestrator`)

| Lệnh | Kết quả |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` (sau edits, trước fix narrowing) | **TSC3_EXIT=2** — 1 lỗi thật: `runtime.ts(289,5) unknown not assignable to string` → đã sửa bằng function declaration `never` (CFA narrowing chuẩn) |
| `npx tsc --noEmit -p tsconfig.json` (sau fix) | **TSC4_EXIT=0** |
| `npx tsc --noEmit -p tsconfig.json` (cuối, sau test) | **TSC5_EXIT=0**, ERR=0 |
| `npx jest --runInBand tests/p745-prompt-producer-impl.test.ts` **lượt 1** | `Test Suites: 1 passed` / `Tests: 17 passed, 17 total` / **JEST_EXIT=0**, 3.017s |
| … **lượt 2** | **RUN2_EXIT=0** — 17/17 |
| … **lượt 3** | **RUN3_EXIT=0** — 17/17 |
| Regression 11 suite (`w1-sub02`, `w1-sub03`, `artifact-submit-guards`, `public-upload-encryption-gateway`, `url-ingestion-offline.functional`, `url-ingestion-consumer-offline.functional`, `url-ingestion-backend-failclosed-offline`, `p730-profile-snapshot`, `p730-legacy-snapshot-failclosed`, `mm10-claim-cancel-flag-offline`, `br12-isolation-offline`) | **10 passed / 1 failed (br12) — 137 passed, 1 failed, 138 total**; 11.271s |

### 2.3 `br12-isolation-offline` — re-attribution bằng A/B hash-verified (KHÔNG do packet này)

- Failure post-edit: test `rejects cross-business binding use…` (`:329`) — `Expected constructor: HttpError / Received constructor: TypeError`; nguyên nhân: fake manifest trong test (`br12:296`) là `{ actions: [{ name: 'extract' }] }` **thiếu `inputSchema`**, còn `submission.ts:240` gọi `declaredParameterKeys(actionDef.inputSchema)` (seam Phase-2, **không thuộc hunk nào của tôi**) → TypeError trước cả `tx`.
- **A/B tái tạo byte-exact bản pre-edit** (reverse 9 hunk của submission.ts + 2 hunk của create-app.ts): `submission prev sha 1655be49… MATCH: true`; `create-app prev sha 29fcbbbf… MATCH: true`; chạy br12 với **đúng code pre-edit**: **TRUE_PRE_BR12_EXIT=1 — cùng signature y hệt** (`● rejects cross-business binding use…`, `Expected constructor: HttpError / Received constructor: TypeError`, `1 failed, 17 passed, 18 total`); restore 2 file verify hash OK.
- ⇒ **Pre-existing red**, trùng khớp ghi nhận cũ (`w1-receipt-audit` §6; `plan-review-730:12` "file không chứa inputSchema"). Owner: lane fixture-vs-seam của Phase-2 (không phải packet này); đề xuất fix riêng (thêm `inputSchema` vào fixture hoặc nới `declaredParameterKeys` — quyết định owner khác).

### 2.4 Hành vi được pin (17 test)

- **Producer (6):** pin sorted markers (skip row cleared, content-digest đúng công thức `sha256:<hex>` của `connectionId|stepId|content`); `listFor(KEY,'ingest',TENANT)` gọi đúng 1 lần; roundtrip pin→map composite; bucket giống nhau → **JSON byte-identical** bất kể thứ tự row; không override → `'[]'` → map `{}`; **legacy mode → NULL pin + không đọc bảng**; pinned nhưng thiếu seam → NULL (feature dark).
- **Claim parser (9):** map `connectionId::stepId` (kể cả `_default`); NULL/undefined → `{}`; 6 dạng malformed fail-closed `INVALID_SCHEMA` (non-array, non-object marker, thiếu field, revision sai format, connectionId rỗng, trùng composite key); cùng stepId 2 connection → 2 key phân biệt.
- **Immutability (2):** sửa override sau submit → pin op MỚI khác, pin op CŨ giữ nguyên revision đã capture; helper thuần (rows→markers deterministic).

## 3. Δ — quyết định & chuyển tiếp

- **Δ-1 (phase 2, KHÔNG làm ở đây):** pin prompt **content** (sealed ENC-META carrier) cho precedence Code > Profile > Connector — theo adjudication P2-a/P2-b; ghi nhận cho packet sau.
- **br12 pre-existing red:** chuyển owner (fixture Phase-2 seam), kèm bằng chứng A/B; không sửa ngoài lease.
- **Migration 0030:** additive `ADD COLUMN IF NOT EXISTS`, nullable, không backfill; runner `AUTO_MIGRATE` áp dụng; không chạm migration ≤0029.
- **Không mở contracts/worker-sdk/document-core** — đúng adjudication.

## 4. Giới hạn / live

- Offline prove ở mức service + parser (fake DB có giám sát) — **chưa live**: claim thật trên PG (row có pin), upsert override qua Admin API thật, và re-verify W2-B trong môi trường live vẫn thuộc các window riêng.
- `promptRevisions` chưa có consumer business thực sự *đọc* (SDK/W1b chỉ pass-through tới `ctx.promptRevisions`); acceptance T-PROM-02 đầy đủ vẫn chờ consumer-use + Δ-1.
- Không tick; không commit/push; offline.

READ-ONLY cho mọi file ngoài write-set; single-writer đúng lease; A/B artifacts giữ ở scratchpad phiên (không vào repo).
