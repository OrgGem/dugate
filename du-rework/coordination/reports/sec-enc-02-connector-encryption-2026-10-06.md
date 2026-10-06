# SEC-ENC-02 — Connector invocation encryption (SD-01)

- Task: `SEC-ENC-02` (`tasks/SEC-SENSITIVE-PERSISTENCE-2026-10-06.md`), parent `DU-PLATFORM-MIGRATION-2026-10-05.md` / SEC-SENSITIVE-DATA-20261006
- Owner: OpenCode 3 (`oc_3` / `term_8a432ae3-63b7-41fd-929e-0797860c7426`), Connector backend
- HEAD tham chiếu: `b088eec` (worktree dirty, nhiều lane mở)
- Constraints honored: **không commit, không push, không cutover**; offline only (NO PostgreSQL/Redis/S3/Vault/live provider)
- Status: **IMPLEMENTED + offline-verified**; **real-PG persistence inspection + Vault Transit wiring + independent VFY/review còn thiếu. Không claim ACCEPTED, không tick.**

## 0. TL;DR

- Envelope AES-256-GCM (v1, per-value DEK, DEK wrapped by key provider, AAD = `sha256(tenantId|slot|refId)`) cho **`request` / `result` / `session_ref`** của `connector_invocations`; format dùng cùng shape với metadata crypto của Orchestrator (slot namespaced `connector_invocations.*`) để tránh hai format song song.
- **Seal before SQL**: mọi INSERT/UPDATE ghi 3 trường trên đều đi qua `sealField`; mọi đọc đi qua `openField`/`openSessionRef` với AAD tenant+row+slot. Không còn `JSON.stringify(request|result)` plaintext trong repository.
- **Fail-closed**: thiếu crypto config → từ chối ghi (`PROVIDER_UNAVAILABLE`, không retry); key outage → không có row/không plaintext; tamper/wrong tenant-row-slot → `INVOCATION_UNKNOWN`; migration window đọc legacy là **explicit opt-in** và **read-only** (ghi vẫn phải seal).
- **Production wiring**: composition inject crypto (explicit config hoặc env `CONNECTOR_INVOCATION_ENCRYPTION_KEYS` / `CONNECTOR_INVOCATION_LEGACY_PLAINTEXT_READS`); malformed key config fail ngay lúc composition.
- Offline evidence: connector unit **33 suites / 422 passed / 1 skipped**, exit 0; focused SEC-ENC-02 **40/40 ×3**, exit 0; `tsc` exit 0; `git diff --check` exit 0. Real PG (`CONNECTOR_INTEGRATION=1`) chưa chạy — thuộc VFY/window.

## 1. Phạm vi field và quyết định format

| Field (bảng `connector_invocations`) | Column | Slot AAD | Trạng thái |
|---|---|---|---|
| Invocation request (prompt/text/options/artifact bytes) | `request` JSONB | `connector_invocations.request` | **sealed** |
| Provider result (content/data/session/providerRequestId/usage) | `result` JSONB | `connector_invocations.result` | **sealed** |
| Continuation session (CR06-04 async 202) | `session_ref` TEXT | `connector_invocations.session_ref` | **sealed** |

- Envelope: `{version:1, algorithm:'aes-256-gcm', keyRef, dek:{version,keyName,keyVersion,wrappedKey}, nonce, tag, aad, ciphertext, plaintextSha256}`; `aad = sha256(tenantId|slot|invocationId)`; `plaintextSha256` được verify khi open (defense-in-depth ngoài GCM tag).
- Không thêm cột/migration: envelope self-describing nằm trong cột sẵn có (`request`/`result` jsonb từ 001, `session_ref` text từ 009). Version bump là đường nâng cấp format.
- Metadata không nhạy cảm vẫn queryable plaintext: `invocation_id`, `tenant_id`, `operation_id`, `task_id`, `step_key`, `input_hash` (business hash cho replay), `state`, timestamps, poll/quota lease, `provider_request_id`.
- **Adapter config (`connector_revisions.config`) chưa nằm trong danh sách field của dispatch này** (credential secret đã có `AesCredentialCipher`); task §47 "arbitrary sensitive adapter configuration identified by inventory" phụ thuộc inventory SEC-ENC-01 — ghi nhận là open item, không tự mở rộng.

## 2. Crypto seam và key management

- `services/connector/src/db/invocation-crypto.ts` (mới):
  - `InvocationFieldCrypto` (seal/open/isSealed), `InvocationDekKeyProvider` (wrapDek/unwrapDek) — interface tương thích để cắm Vault Transit provider (shape `WrappedDek` giống `vault-transit-provider.ts` của Orchestrator).
  - `createLocalInvocationKekProvider`: KEK AES-256-GCM versioned (`{keyRef, activeVersion, keys:{version: base64-32B}}`), wrap = `base64(nonce12|tag16|cipher32)`, AAD riêng cho KEK; **rotation-ready** (envelope giữ `keyVersion`; unwrap không đoán version).
  - `resolveInvocationStorageCryptoFromEnv`: `CONNECTOR_INVOCATION_ENCRYPTION_KEYS` (JSON) + `CONNECTOR_INVOCATION_LEGACY_PLAINTEXT_READS`; malformed → throw `INVALID_CONFIGURATION` (fail loud).
- Key material không vào envelope/log/error; DEK zero-fill sau dùng; `timingSafeEqual` cho AAD; context check **trước khi** unwrap DEK.
- **Vault Transit**: chưa wire (không có Vault client trong connector; canonical provider nằm ở Orchestrator). Interface `InvocationDekKeyProvider` là điểm tích hợp 1 class cho SEC-ENC-01/05 hoặc integration owner; local KEK là implementation production-capable cho deployment inject key trực tiếp (cùng trust model `CONNECTOR_ENCRYPTION_KEY` hiện có).

## 3. Đường đi thay đổi

| Điểm | File | Hành vi |
|---|---|---|
| Seal/open seam | `db/invocation-crypto.ts` (mới) | envelope, AAD, KEK provider, env resolver |
| Ledger write/read | `db/repository.ts` | `claim` seal request trước INSERT; `complete` seal result trước UPDATE; `markPending` seal session_ref; mọi record-return mở envelope qua `toRecord` |
| Existence pre-check | `db/repository.ts` claim | replay không tốn DEK wrap; key outage nổi lên trước khi chạm SQL; race vẫn xử lý bằng `ON CONFLICT` + `SELECT ... FOR UPDATE` |
| Production injection | `composition.ts` | `new PostgresInvocationLedger(database, config.invocationStorageCrypto ?? resolveInvocationStorageCryptoFromEnv(process.env))`; thêm `ConnectorConfig.invocationStorageCrypto` |
| Error mapping | `db/repository.ts` | `KEY_PROVIDER_FAILED` → `PROVIDER_UNAVAILABLE` (safeToRetry=true); tamper/context/not-sealed → `INVOCATION_UNKNOWN`; no-crypto → `PROVIDER_UNAVAILABLE` (safeToRetry=false) |
| Backfill hook | `invocation-crypto.ts` export | SEC-ENC-06 dùng `seal`/`open` + slot constants để backfill; ledger có `legacyPlaintextReads` cho read window |

**Lease note (disclosure):** dispatch spec §2 liệt kê `db/**`, `ledger.ts`, `invoke.ts`, migrations, tests — không liệt kê `composition.ts`; nhưng task file §45 cấp "runtime/ledger composition" và mục tiêu §1.1 yêu cầu "inject managed crypto into the production ledger". Tôi đã sửa **tối thiểu** `composition.ts` (import + 1 config field + 1 constructor arg) để production thực sự nhận crypto; nếu coordinator muốn giữ nguyên composition, đây là hunk duy nhất cần revert và khi đó ledger vẫn fail-closed (không có plaintext).

## 4. Fail-closed matrix

| Trạng thái | Ghi sensitive | Đọc sealed | Đọc plaintext legacy |
|---|---|---|---|
| crypto configured, strict (default) | seal | open | **refuse** `INVOCATION_UNKNOWN` |
| crypto configured + `legacyPlaintextReads` | seal | open | trả nguyên trạng (window) |
| không crypto (unset env), strict | **refuse** `PROVIDER_UNAVAILABLE` | **refuse** | refuse |
| không crypto + `legacyPlaintextReads` | **refuse** | **refuse** | trả nguyên trạng (window) |
| key outage (wrap) | **không có row**, không plaintext | – | – |
| key outage (unwrap) | – | `PROVIDER_UNAVAILABLE` | – |
| tamper / sai tenant-row-slot | – | `INVOCATION_UNKNOWN` | – |

## 5. File thay đổi + SHA-256

| File | SHA-256 |
|---|---|
| `services/connector/src/db/invocation-crypto.ts` (new) | `A5071250FB216AC2D1AF0787EC3FFAC4271C9F315F4ADF4ADC0EB9B994010CCC` |
| `services/connector/src/db/repository.ts` | `BE9F61845436F299D795FC58E85B7EC8801529A30A508F7591EA56E34767D053` |
| `services/connector/src/composition.ts` | `19D5067D43C967EC0E0E2ED99D967911AD558E4251EE215A6497D9025C89FB03` |
| `services/connector/tests/sec-enc-02-invocation-crypto.test.ts` (new) | `23755FC91F3A6B60D5CCB386E33A0CBE94974E10EAE74D69FD51F436700906BC` |
| `services/connector/tests/sec-enc-02-ledger-encryption.test.ts` (new) | `D846B40881B7BD0AC735F30D461D81944979BDAA564F451320E687AD99D6CBB6` |
| `services/connector/tests/sec-enc-02-schema.test.ts` (new) | `B99C43A3ACBDCE41C557C6F382DFCCE2EFCD9EBEB188F282F0BF074E9FD3B850` |
| `services/connector/tests/connector.test.ts` | `04DFDE1A89463C67B4BE832FA8962EDAFAEB85E95F885F000796CD2AD97CEC49` |
| `services/connector/tests/black-box-durable.test.ts` | `0B59108D3505C8F9F38DFA6144F113FC112EC4637E11A5B4CD68B5C8E66EB929` |
| `services/connector/tests/cr06-04-session-ref.schema.test.ts` | `78AA84ED5D5AC87DB9712D36DE56B2D1F8E5BEA48EFAC9CECE8D853C1B4D088B` |

Không đổi: `types.ts`, `errors.ts`, `invoke.ts`, migrations (không cần migration mới), `worker-sdk`, `packages/contracts`.

## 6. Test evidence (offline; literal)

| Command (cwd `du-rework/services/connector`) | Kết quả |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit **0** |
| `npx jest tests/sec-enc-02-invocation-crypto.test.ts tests/sec-enc-02-ledger-encryption.test.ts --runInBand` ×3 | mỗi lần **2 suites / 40 tests passed**, exit **0** |
| `npx jest tests/sec-enc-02-schema.test.ts --runInBand` | **1 suite / 5 passed**, exit **0** |
| `npx jest --config jest.unit.config.cjs --runInBand --forceExit` | **33 suites passed / 422 passed, 1 skipped, 423 total**, exit **0** |
| `git diff --check -- services/connector` | exit **0** |

Nội dung pin chính:
- **Crypto unit** (`sec-enc-02-invocation-crypto.test.ts`, 22 test): roundtrip + canonical hash; fresh DEK/nonce; tenant/slot/row transplant → `CONTEXT_MISMATCH` trước khi unwrap; tamper ciphertext/tag/aad/nonce/plaintextSha256; wrap/unwrap outage; unknown key version; rotation v1→v2; config parse fail; env resolution.
- **Ledger với recording SQL fake** (`sec-enc-02-ledger-encryption.test.ts`, 13 test): INSERT param request là envelope, **không chứa sentinel**; UPDATE complete result envelope không sentinel; UPDATE markPending session envelope; replay/restart/conflict mở đúng giá trị gốc; rotation sau restart; wrong tenant/row/slot; tamper; wrap outage → `insertCount=0`, không plaintext trong `db.calls`; no-crypto refuse; strict legacy refuse; migration window read-only + write vẫn seal.
- **Schema/source pin** (`sec-enc-02-schema.test.ts`): repository không còn `JSON.stringify(request|result)`; 3 slot được seal/open; version/algorithm constants; composition injection; format dùng cột sẵn có (001/009).
- **DB suite** (`black-box-durable.test.ts`): đã inject crypto (test key) vào composition + 5 ledger probes — sẵn sàng chạy thật khi có window `CONNECTOR_INTEGRATION=1`; **chưa chạy** (zero-DB rule).

## 7. Acceptance mapping (SEC-ENC-02 §52)

| Acceptance | Trạng thái offline | Còn thiếu |
|---|---|---|
| actual PG persisted request/result/session không chứa synthetic plaintext sentinel | **offline proof** trên SQL parameters + DB suite đã wire crypto | **real PG inspection = VFY/window** |
| wrong tenant/row/slot fails | **PASS** (unit + ledger) | – |
| key outage tạo no plaintext row | **PASS** (unit + ledger) | – |
| poll/resume/replay sống qua restart + key rotation | **PASS** (ledger fake: restart, rotation; CR06-04 session resume vẫn xanh) | real PG restart = VFY |
| Credential encryption alone không đủ | **PASS** — crypto độc lập `AesCredentialCipher`, test riêng | – |

## 8. Honest limits / open items

- **Real PostgreSQL chưa chạy**: chưa inspect JSONB/TEXT bytes thật; `black-box-durable` cần `CONNECTOR_INTEGRATION=1` + PG/Redis window. VFY-SEC-ENC-01 phải là người mở gate này.
- **Vault Transit chưa wire**: local KEK provider dùng env key material; adapter Vault Transit là integration item (interface đã sẵn). Key outage/rotation đã test ở seam provider, không phải Vault thật.
- **Production boot policy**: khi env key unset, invocation writes bị refuse (502 non-retryable). SEC-ENC-05 cần thêm boot refusal + env samples để lỗi xuất hiện lúc start thay vì lúc invoke.
- **Historical rows**: migration window read-only đã có; backfill thật (rewrite rows cũ) thuộc SEC-ENC-06 — dùng `seal()` với cùng slot/AAD; chưa viết CLI trong packet này.
- **Adapter config** (`connector_revisions.config`) chưa mã hóa — chờ inventory SEC-ENC-01 (xem §1).
- **In-memory ledger** vẫn plaintext trong process memory: đúng theo transport/memory exception; không phải durable store.
- **Extra query**: `complete`/`markPending` (khi có session) đọc `tenant_id` trước để bind AAD — 1 roundtrip thêm; có thể gộp sau nếu cần tối ưu.
- **Export surface**: `db/invocation-crypto.ts` chưa thêm vào `src/index.ts` (ngoài lease); composition dùng relative import nên production hoạt động; nếu consumer ngoài package cần helpers (SEC-ENC-06 backfill) thì thêm export ở integration.
- **Docs**: `docs/08-connector-api.md` chưa cập nhật encryption-at-rest note (ngoài lease) — handoff docs owner; `docs/19/28/35` cũng chưa sync.

## 9. Handoff

- **VFY-SEC-ENC-01**: chạy `black-box-durable` + probe SQL `SELECT request,result,session_ref FROM connector_invocations` với sentinel synthetic; verify không plaintext, wrong tenant/AAD, key outage, restart, rotation. Digest candidate theo §5.
- **SEC-ENC-05 (cw1)**: boot policy + env samples (`CONNECTOR_INVOCATION_ENCRYPTION_KEYS`), effective-policy health view; có thể thay local KEK bằng Vault Transit provider qua `InvocationDekKeyProvider`.
- **SEC-ENC-06**: backfill dùng `createInvocationFieldCrypto`/slot constants + `legacyPlaintextReads` window; không tạo plaintext mới.
- **Coordinator**: quyết định hunk `composition.ts` (§3 lease note); không tick parent SEC/SD-01.
