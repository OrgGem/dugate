# V1-BOOT-DENIAL-DECISION — missing profile-cipher key policy (2026-10-05)

**Task:** `task_602ccacaf42b` / dispatch `ctx_6c8b66876677` · Owner claude (`term_19edcad8`) · REVIEW/DECISION, 0 edit, offline, no commit.
**Evidence base:** `coordination/reports/tester.md:13537-13567` (V1-CONDITIONS-802, 3× boot + resolver probe + raw SHA), `coordination/reports/raw/v1-conditions-802-boot-x1.txt`, `coordination/reports/raw/v1-conditions-802-resolver-no-key.txt`.
**DB window:** FREE. No source/test/docs touched except this record.

## 0. What the evidence proves (read-only findings)

- F1 — Boot does NOT fail without keys: 3× `node services/orchestrator/dist/main.js` with `ENCRYPTION_KEY` + `NEXTAUTH_SECRET` both UNSET → `artifact encryption enabled` + `orchestrator listening`, `HARNESS_READY_SEEN=true`, business rows unchanged (0/0/0/0/0). Boot requirement "fail-fast on missing key" is **not current behavior**.
- F2 — Consume fails, but UNTYPED: resolver probe with configured cipher + absent keys → plain `Error` (`ENCRYPTION_KEY (or NEXTAUTH_SECRET) is not set...`), `code: null`, `status: null`, `typedSourceAuthDenial: false`, `networkCalls: 0`. No silent unauthenticated fall-through (good), but retry classification is wrong (see F3).
- F3 — Root cause located: `resolveProfileCryptoKey()` (`file-url-auth.ts:37-46`) throws generic `Error` BEFORE `decryptFileUrlAuthConfig`'s try/catch (`file-url-auth.ts:103-110` only wraps `decipher.update/final`). The generic escapes `acquisition-ref-resolver.ts:199` instead of becoming `denial(500,'AUTH_DECRYPT_FAILED',...)` (`:200-203`), and `failureCode()` (`ingestion-consumer.ts:336-346`) maps non-typed errors to `INGESTION_FAILED`, which is **not** in `PERMANENT_CODES` → the consumer will **retry a deterministic failure** until budget exhaustion.
- F4 — Correction to packet premise: `AUTH_DECRYPT_FAILED` is **already** in `PERMANENT_CODES` (`ingestion-consumer.ts:276`) and in `SourceAuthDenialCode` (`acquisition-ref-resolver.ts:53`), and `failureCode` already maps `SourceAuthDeniedError.code` (`ingestion-consumer.ts:340-341`). No code-list change needed — only the throw site needs to produce the typed error.
- F5 — Key scope is NARROW: `ENCRYPTION_KEY`/`NEXTAUTH_SECRET` are consumed ONLY by the profile `fileUrlAuthConfig` cipher (`encryptFileUrlAuthConfig` at `profiles.ts:210`; `decryptFileUrlAuthConfig` at `profiles.ts:252` and `acquisition-ref-resolver.ts:199`). Artifact/metadata encryption is a SEPARATE Vault-transit seam (`main.ts:148-153` `buildEncryptionBootOptions`), which is why boot log "artifact encryption enabled" appears with profile keys absent — the two keys are unrelated.

## 1. Startup policy decision: ALLOW BOOT + typed denial at consumption + boot WARNING (reject fail-fast)

**Chosen: (b) cho phép boot + typed denial khi tiêu thụ cipher đã cấu hình + log cảnh báo lúc boot. Reject (a) fail-fast và reject (c) warning-only.**

- Reject fail-fast (a): impact thật — key chỉ phục vụ profile cipher (F5); deployment không dùng `fileUrlAuthConfig` cipher (DB 0 `profile_bindings`, như fixture boot) boot và phục vụ bình thường hôm nay. Bắt fail-fast sẽ **hạ deployment đang chạy mà không dùng artifact encryption / không dùng profile cipher** — đúng rủi ro packet nêu. Fail-fast còn lẫn scope: log "artifact encryption enabled" thuộc Vault seam, không liên quan key này, nên gate boot trên key này là sai seam.
- Reject warning-only (c): warning không đủ — tiêu thụ cipher với key vắng hôm nay ra lỗi generic + retry sai (F2/F3). Phải có typed denial để fail-closed đúng phân loại.
- Chosen (b): boot không bao giờ fail vì thiếu key; `main.ts` emit `logger.warn` một lần khi cả hai key vắng ("profile cipher key absent — configured-cipher consumption will deny with AUTH_DECRYPT_FAILED"); mọi request không cần key phục vụ bình thường; chỉ request nào chạm cipher đã cấu hình thì deny typed tại resolver (mục 3).

## 2. Typed error code: YES — emit `AUTH_DECRYPT_FAILED`, NO-OP on `PERMANENT_CODES`

- Bổ sung typed code: CÓ — thiếu key khi decrypt cipher đã cấu hình phải ra `SourceAuthDeniedError(500, 'AUTH_DECRYPT_FAILED', 'stored auth cipher could not be decrypted with this deployment key')`, đúng message hiện tại ở `acquisition-ref-resolver.ts:202`.
- Đánh vào `PERMANENT_CODES`: KHÔNG cần sửa — đã có (`ingestion-consumer.ts:276`). Sau fix, `failureCode` → `AUTH_DECRYPT_FAILED` → `isPermanent` true → escalate ngay, không đốt retry budget. Điều kiện chấp nhận: test chứng minh typed denial đi qua `failureCode`/`isPermanent` thành permanent (mục 5c).

## 3. Scope: thiếu key được phục vụ request không cần key; chặn ở tầng request (resolver), không chặn ở boot

- Được tiếp tục: mọi op có `fileUrlAuthConfigured=false`/snapshot null (`acquisition-ref-resolver.ts:111,171` → `{kind:'none'}`), mọi route không đọc `file_url_auth_cipher`, toàn bộ read path legacy-plaintext (cipher không phải cipher-shape → `legacy-plaintext`, `file-url-auth.ts:117-121`).
- Bị chặn (fail-closed, typed, permanent): op đã pin (`configured=true` + ref hợp lệ) mà `binding.cipher` là cipher-shape nhưng key vắng/sai/tag rách → `AUTH_DECRYPT_FAILED` tại `acquisition-ref-resolver.ts:199-203`, trước mọi network (`networkCalls=0` đã chứng minh).
- Cấm: (i) fail-open thành `{kind:'none'}` khi cipher-shape tồn tại mà không mở được; (ii) boot gate trên key này; (iii) sửa `decryptFileUrlAuthConfig` thành silent-`null` — vì `decodePolicy` (`profiles.ts:252-260`) map `null → config null`, silent-null sẽ biến "cipher tồn tại nhưng không mở được" thành "no auth" trên read path (fail-open). Fix phải nằm ở resolver (throw typed), không nằm ở helper dùng chung.

## 4. Minimal fix + file:line (implementer làm theo)

**Đường ngắn nhất đã chọn: 2 hunk, 2 file. Không chạm helper dùng chung, không chạm code-list.**

- Hunk 1 (bắt buộc) — `services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts:199-203`: bọc `decryptFileUrlAuthConfig(binding.cipher, env, warnLegacy)` trong try/catch; catch mọi throw đồng bộ từ `resolveProfileCryptoKey` (key vắng) → `throw denial(500, 'AUTH_DECRYPT_FAILED', 'stored auth cipher could not be decrypted with this deployment key')`. Giữ nguyên nhánh `decrypted === null` hiện tại. Không đổi signature, không đổi `SourceAuthDenialCode`.
  - Rejected alternative: sửa trong `file-url-auth.ts:37-46` để throw typed — helper này dùng chung cho `encrypt` (`profiles.ts:210`, contract `HttpError`) và `decodePolicy` (`profiles.ts:252`, contract nullable), ép typed `SourceAuthDeniedError` vào helper sẽ vỡ contract hai caller còn lại. Fix tại resolver là seam duy nhất có đúng error contract.
- Hunk 2 (bắt buộc, 3 dòng) — `services/orchestrator/src/main.ts` sau block `:149-154`: `if (!process.env.ENCRYPTION_KEY && !process.env.NEXTAUTH_SECRET) logger.warn('profile cipher key absent — configured-cipher acquisition will deny with AUTH_DECRYPT_FAILED; set ENCRYPTION_KEY or NEXTAUTH_SECRET')`. Warn-only, không throw, không exit.
- Follow-up ngoài slice (ghi nhận, không làm ở đây): `profiles.ts:210` (save-time encrypt thiếu key → generic throw; nên typed `HttpError` 500 cùng code để UI hiện đúng), `profiles.ts:252` decodePolicy khi cipher-shape + key vắng (hiện cũng generic throw — fail-closed đúng nhưng message chưa typed; giữ nguyên hành vi, chỉ typed hóa khi chạm).

**Danh sách file:line liên quan (đủ cho implementer):**

| File:line | Vai trò |
|---|---|
| `services/orchestrator/src/modules/profiles/file-url-auth.ts:37-46` | throw-site generic (nguyên nhân gốc) — KHÔNG sửa |
| `services/orchestrator/src/modules/profiles/file-url-auth.ts:98-113` | decrypt helper, try/catch chỉ ôm decipher — KHÔNG sửa |
| `services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts:48-66` | `SourceAuthDeniedError` + code union (đã có `AUTH_DECRYPT_FAILED`) — KHÔNG sửa |
| `services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts:199-203` | **HUNK 1 — bọc try/catch → denial typed** |
| `services/orchestrator/src/modules/operations/ingestion-consumer.ts:266-278` | `PERMANENT_CODES` (đã có code) — KHÔNG sửa |
| `services/orchestrator/src/modules/operations/ingestion-consumer.ts:336-350` | `failureCode`/`isPermanent` — KHÔNG sửa, dùng để chứng minh |
| `services/orchestrator/src/main.ts:148-154` | Vault seam log (seam khác, không liên quan key này) — ngữ cảnh |
| `services/orchestrator/src/main.ts:155-189` | createApp boot (không gate key) — **HUNK 2 warn sau `:154`** |
| `services/orchestrator/src/modules/profiles/profiles.ts:210,252` | save/decode callers — follow-up, ngoài slice |

## 5. Offline acceptance (từng policy, chạy được không cần live)

- 5a. Boot key-vắng (chứng minh mục 1): `ENCRYPTION_KEY` + `NEXTAUTH_SECRET` UNSET, entrypoint thật `node services/orchestrator/dist/main.js`, disposable PG/Redis, `AUTO_MIGRATE=false` → expect `orchestrator listening` + đúng 1 warn Hunk 2 + exit do SIGTERM harness (không `startup failed`). Đã có baseline 3× pass V1-CONDITIONS-802 (raw SHA `8895310f…`, `b9b685cd…`, `15175d24…`); chạy lại 1× sau Hunk 2 để bắt warn mới.
- 5b. Consume cipher key-vắng (chứng minh mục 2+3): scripted-DB adapter trả cipher-shape bearer + env trống → expect `SourceAuthDeniedError`, `code === 'AUTH_DECRYPT_FAILED'`, `status === 500`, `typedSourceAuthDenial === true`, `networkCalls === 0`, output không chứa secret. Baseline hôm nay FAIL đúng điểm này (generic `Error`, code/status null) — test này đỏ trước fix, xanh sau fix.
- 5c. Retry phân loại (chứng minh mục 2): cùng lỗi 5b đi qua `failureCode`/`isPermanent` → expect permanent `true` (không retry). Hôm nay suy luận code-path (`INGESTION_FAILED` ∉ set); sau fix thành assertion trực tiếp.
- 5d. Key hợp lệ + ciphertext hỏng (hồi quy): key đúng + tag rách → expect cùng typed denial (hành vi hiện tại đã đúng qua nhánh `decrypted === null`; giữ xanh).
- 5e. Không đụng đường lành: op `configured=false`/snapshot null + key vắng → `{kind:'none'}`; legacy-plaintext row + key vắng → `{kind:'legacy-plaintext'}` + warn 1 lần/process. Cả hai đã đúng, giữ xanh.

## 6. Live gates còn mở (không thuộc offline ACCEPTED)

Real PG rows (`profile_bindings` cipher thật) + key cấu hình deployment; restart/replica với key xoay (sai key → deny typed, không half-open); Vault seam không liên quan nhưng cần khai không hồi quy; upstream fetch/header quan sát thật; reviewer APPROVED + coordinator ACCEPTED. Rollout không cần migration (không đổi schema).

**Coordinator tick guidance:** không tick V1 thêm từ decision này — đây là design input cho implementer; tick khi Hunk 1+2 landed + 5a-5e xanh offline.
