# P745-CARRIER-IMPL-A (core) — sealed prompt-content carrier — 2026-10-04

**Packet:** P745-CARRIER-IMPL-A · task `task_0aa4370bf6bf` · lane cc_1 · dispatch 23:36.
**Snapshot:** 2026-10-04 23:37–23:45 +07 · HEAD `b088eec` · offline. **Không tick; không commit/push.**

## 0. LEASE-ANNOUNCE (trước khi ghi)

| File | Pre | Post SHA-256 |
|---|---|---|
| `packages/contracts/src/runtime.ts` | `4cc34f0fac916f0acd35…` | `c527b56646581c6b90643cd93e6c07f47193213731cb6bf1517a4356935daa5f` |
| `packages/contracts/dist/{runtime.d.ts,runtime.js}` | (dist cũ) | `a48cc3b6a254de5587bf…` / `d15f46cb508d8358f1cd…` (**rebuild `tsc -p tsconfig.json`, exit 0**) |
| `migrations/0031_prompt_overrides_ref.sql` | **ABSENT** | `3bd0abe39f69fa2cdab2…` |
| `src/modules/runtime/metadata-crypto.ts` | `aa200211680cbba6f1a8…` | `4cd9db049a124ad262ea6a…` |
| `src/modules/operations/submission.ts` (**W1 hot — đã announce**) | `3007bcfaf047cfce4be3…` | `19b04ac516dd34cfdc42f548ad43a217a46d0248f3ddc1a9f0a8cb66afef32af` |
| `src/modules/runtime/runtime.ts` | `c4c7ff41ece181962c67…` | `89e6acc5b89ec7a23860f2f3d3a68fef5a6bad0ba2c62bebbdea554fe4381c8a` |
| `tests/p745-prompt-carrier-producer.test.ts` | **MỚI** | `5691acba60f77502daaf…` |
| `tests/p745-prompt-carrier-claim.test.ts` | **MỚI** | `eeb9b7bf6b9a075002e2…` |

**Không chạm:** `publish.ts` (`ae76ac4b…` nguyên), SDK `worker.ts` (`6e82be42…` nguyên), document-core (ngoài lease). Ghi chú ambient: `businesses/document-core/src/worker.ts` đổi bởi **lane khác** trong cửa sổ này (`56fa3520…` → `c1a8f514…`, mtime `1791132223309872384`) — không phải lane này.

## 1. Adjudications áp dụng (1a–1g)

| # | Chốt | Thi hành |
|---|---|---|
| 1a | Form A: cột `prompt_overrides_ref` + slot MỚI, không đổi semantics open/seal | Migration 0031; `METADATA_SLOTS` +`'operations.prompt_overrides_ref'` (`metadata-crypto.ts:44-54`); `seal/open/readStored` **không đụng** |
| 1b | Cross-check markers↔carrier tại claim: multiset + recompute, fail-closed | `openPromptCarrier` (`runtime.ts` sau `parsePromptRevisionsPin`): count-equality, duplicate-key deny, `markers[key]===row.revision`, recompute `sha256(connId\|stepId\|content)` — lệch ⇒ `INVALID_SCHEMA` |
| 1c | No-seam → carrier NULL + markers vẫn ghi; không bao giờ plaintext | `submission.ts` seal chỉ khi `metadataCrypto && rows>0`; T1 no-seam + T2 `carrier:null` verify |
| 1d | Caps 64/16 KiB/256 KiB + 422 `PROMPT_CARRIER_TOO_LARGE` | `PROMPT_CARRIER_LIMITS` + `assertPromptCarrierCaps` (chạy TRƯỚC seal/tx); 3 case T1 zero-write |
| 1e | Decrypt orchestrator-side tại claim; substitution business-side | `pinned.promptOverrides = await openPromptCarrier(metadataCrypto, …)` trong `buildClaimResult` |
| 1f | Contracts additive `pinned.promptOverrides` + rebuild dist | `PinnedPromptOverrideSchema` (`contracts/runtime.ts:83-89`) + field (`:96`); dist rebuilt; regression SDK/contracts chạy (dưới) |
| 1g | Tên field `pinned.promptOverrides` | đúng tên |

## 2. Thay đổi (anchors — re-anchor theo symbol nếu dòng dịch chuyển)

- **contracts** `PinnedPromptOverrideSchema` `{connectionId, stepId, promptOverride≥1, revision /^sha256:[0-9a-f]{64}$/}`; `pinned.promptOverrides: z.array(...).nullable().default(null)`.
- **0031**: `ADD COLUMN IF NOT EXISTS prompt_overrides_ref jsonb NULL` (additive, no backfill).
- **submission.ts**: `sealSubmitMetadata` slot type ⤳ `MetadataSlot` (:142); `buildPromptCarrier` + caps (:604-660); bucket read + BOTH pins **trước tx** (:318-332, caps-first); `sealedPromptCarrier` seal trước tx (:340-353, CR28-04 ordering); INSERT `prompt_overrides_ref` `$18` (:423-424, :471-473).
- **runtime.ts**: `openPromptCarrier` (sau `parsePromptRevisionsPin`); claim SELECT +`o.prompt_overrides_ref` (:385-386); `pinned.promptOverrides` (:1763-1769); union slot 2 chỗ (sealMetadata/openMetadata).

## 3. Evidence literal (cwd `services/orchestrator` trừ khi ghi khác)

| Lệnh | Kết quả |
|---|---|
| `npx tsc --noEmit` sau edits | **TICA_EXIT=2** — 1 lỗi thật: `submission.ts(649,3)` narrowing `promptOverride: string\|null` → fix type-predicate filter → **TICA2_EXIT=0** |
| `npx tsc --noEmit` cuối (sau tests) | **TSC_FINAL=0**, ERR=0 |
| T1 `p745-prompt-carrier-producer.test.ts` — lượt đầu | 5 failed (harness thiếu row cho `loadOperationView` — lỗi test, đã fix inline) |
| T1 chốt | **7/7 PASS, exit 0** |
| T2 `p745-prompt-carrier-claim.test.ts` — lượt đầu | suite failed to run (TS2352 cast) → fix `as unknown as` + import `createHash` → **7/7 PASS, exit 0** |
| **Focused 11 suite** (T1+T2+producer-impl+w1-sub02+w1-sub03+p730-profile-snapshot+p730-legacy-snapshot-failclosed+mm10-claim-cancel+url-ingestion ×3) **× 3 lượt** | **RUN1/2/3_EXIT=0 — mỗi lượt `11 suites / 115 tests` PASS** |
| `packages/contracts`: `npx jest --runInBand` | **24/25 suite** — 502/504 test; 1 suite đỏ `vault-policies.test.ts` (2 test) **PRE-EXISTING** (xem §4) |
| `packages/worker-sdk`: `npx jest --runInBand` | **28 suites / 683 passed + 1 todo, exit 0** |

Ghi chú minh bạch: lượt chạy 3× đầu dùng biến PowerShell `.Split(' ')` bị nối thành 1 arg (`No tests found`) — đã chạy lại **literal** đúng 3 lượt (kết quả trên).

## 4. Pre-existing red (re-attribute, không nhận là regression)

- `contracts/tests/vault-policies.test.ts` — 2 test fail `TypeError: expect(...).toThrowError is not a function` (lỗi API matcher của chính test, không liên quan schema). **A/B hash-verified:** tái tạo contracts src pre-edit byte-exact (`prev sha 4cc34f0f… MATCH: true`) → chạy riêng suite: **PRE_EDIT_VAULT_EXIT=1, cùng `toThrowError is not a function`, 2 failed/60 passed**; restore hash OK. ⇒ pre-existing, owner khác.
- `br12-isolation-offline` đã biết pre-existing (A/B từ P745-PRODUCER-IMPL) — **không** nằm trong focused set lần này.

## 5. Hành vi được pin (14 test mới)

- **Producer (7):** markers + carrier cùng 1 bucket, envelope mở đúng slot/tenant/refId, rows khớp markers & sort deterministic; sentinel sống ở đâu (kể cả base64) trong **mọi** param bound; legacy → 2 pin NULL, không đọc bucket; no-seam → markers giữ, carrier NULL; key-provider fail → **0 INSERT**; caps 3 dạng → `PROMPT_CARRIER_TOO_LARGE` + 0 INSERT; immutability (sửa bucket → chỉ submit MỚI đổi).
- **Claim (7):** mở carrier → `pinned.promptOverrides` đúng + `promptRevisions` nguyên; NULL → `null` (không `[]`); tampered tag → `AUTHENTICATION_FAILED` + **0 committed writes**; drift marker (thừa row) → `INVALID_SCHEMA` + 0 writes; sai slot → `CONTEXT_MISMATCH` + 0 writes; carrier có mà thiếu crypto → `INVALID_SCHEMA` + 0 writes; sentinel chỉ xuất hiện ở `promptOverrides`, không log/field khác.

## 6. Δ / chuyển tiếp

- **Δ-PACKET-B (chưa làm — ngoài lease):** SDK forward (`pinned.promptOverrides` → ctx) + wiring 6 site build-prompt; T5 (SDK pass-through) để packet B; contracts đã sẵn field.
- **Δ-note:** `openMetadata` hiện giữ `allowPlaintext=true` cho input_ref/payload (legacy window) — carrier dùng `allowPlaintext=false` **riêng** (cột mới không có row legacy) — đúng adversarial design, không đổi semantics seam.
- **Live gaps:** PG thật + Vault thật (envelope trên row thật), claim live; worker-kill/restart immutability live; observed provider request live — thuộc window live.

## 7. Compliance

Write-set đúng lease: contracts src+dist, migration 0031, metadata-crypto.ts, submission.ts (announce), runtime.ts, 2 test mới, receipt này. Không chạm SDK/document-core/publish. `git status` scoped: các entry khác trong `packages/contracts/` (`index.ts`, `profile-commands.ts`, `profile-policy.ts`, tests) thuộc **lane khác** — không phải lane này. Offline; không tick; không commit/push.

---

## 8. FOLLOW-UP — IMPL-A-CAPFIX (2026-10-05 00:2x) — 2 gap từ IMPL-REVIEW-A đã đóng

Packet `IMPL-A-CAPFIX` (review AW-C của claude + tester). Lease: `runtime.ts` + tests; submission/contracts/worker-sdk/document-core **read-only** (qwen_2 đang B2). Offline; no commit/tick.

### 8.1 Gap 1 — claim enforce caps (đồng bộ producer)

**Code chọn: `PROMPT_CARRIER_TOO_LARGE` (422)** — lý do ghi rõ:
- Cùng **mã deterministic** producer dùng ⇒ operator thấy một định danh duy nhất cho "bucket quá lớn" ở cả 2 đầu;
- Phân biệt được với các họ lỗi khác tại claim (`INVALID_SCHEMA` = shape/marker drift; `MetadataCryptoError` = key/cipher);
- Deterministic (redelivery không làm row nhỏ đi) ⇒ escalate, không retry.

**Vị trí:** trong `openPromptCarrier`, **sau** shape-parse, **TRƯỚC** marker cross-check — đo payload trước khi băm từng row; test (d) pin thứ tự này (oversize + markers drift ⇒ vẫn `PROMPT_CARRIER_TOO_LARGE`).

**Đồng bộ số:** `PROMPT_CARRIER_LIMITS_CLAIM = {64, 16 KiB, 256 KiB}` — **cố ý duplicate** với `submission.ts PROMPT_CARRIER_LIMITS` (cùng rationale như sealing helper: runtime không import producer module để tránh kéo cả stack submit vào mọi consumer runtime); 2 phía đều được test pin, giữ numbers + measure utf8 giống nhau.

**Single-bucket invariant giữ nguyên (điều kiện claude):** `openPromptCarrier` vẫn reconcile **đúng 1 carrier** (`prompt_overrides_ref`) với markers của nó — caps chỉ đo thêm, không mở nguồn thứ hai.

### 8.2 Gap 2 — tag-tamper test thật

- Case cũ (ciphertext flip) **retitle** thành "tampered CIPHERTEXT…".
- **Case mới:** sửa 1 ký tự trong `envelope.tag` (ciphertext nguyên) ⇒ `AUTHENTICATION_FAILED` + **0 committed writes**.
- `p745-prompt-carrier-claim.test.ts` giờ 9 case (7 + tag + caps-4-subcase).

### 8.3 Evidence literal + pin

| Lệnh | Kết quả |
|---|---|
| `npx jest --runInBand tests/p745-prompt-carrier-claim.test.ts` | **T2C_EXIT=0 — 9/9 tests passed** |
| Focused 11 suite (như §3) **× 3 lượt** | **CF_R1/R2/R3_EXIT=0** — mỗi lượt `11 suites / 117 tests passed` |
| `npx tsc --noEmit -p tsconfig.json` | **CF_TSC_EXIT=0**, ERR=0 |

| File | Post SHA-256 |
|---|---|
| `src/modules/runtime/runtime.ts` | `52effa490a13298d3cc6601a31463854154352828290e6ab7dda79a0afcccb1e` |
| `tests/p745-prompt-carrier-claim.test.ts` | `c78357567b4746519740f9de1bf0d7e81014466c14d49a8c5612fad4cb198a2d` |

**Delta liên quan (từ B1, nhắc để reviewer không lệch hash):** contracts `runtime.ts` hiện `66656bd6…` (B1 đổi `default(null)`→`optional()`, đã báo riêng ở receipt B1 §2) — khác hash §0 của receipt này (lịch sử). Mọi thứ khác của IMPL-A không đổi.
