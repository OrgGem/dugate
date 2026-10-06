# WTV-03 — Verify RFX crypto: RFX-01/02/08/16 (READ-ONLY + tests)

**Packet:** wtv03-crypto-verify · **Lane:** cc_1 · **Date:** 2026-10-03 · **Dispatch:** 2026-10-03T13:52+07:00 (coordinator command-code).
**Status:** verification tại seam offline (đọc code + chạy focused suite). Không sửa source/test, không tick gate (mọi gate giữ **NO-GO**), không commit, không chạm `nocobase-10`. File duy nhất được ghi: receipt này.
**Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` (WTV-03) + `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` rows RFX-01/02/08/16. Receipts `qwen-rfx-crypto-*`/`tester-rfx-crypto-*` chỉ đọc tham khảo — **không dùng làm bằng chứng**; mọi kết luận dưới đây tự đo trên cây hiện tại.

## 1. RFX-01 — AES-GCM AAD cho delivery envelope → **CONFIRMED**

**Code (encrypt + canonical AAD):**
- `public-api/delivery-encryption.ts:157-191` — `DeliveryAadFields` + `canonicalDeliveryAad()`: canonical JSON theo thứ tự cố định `{version, suite, recipientKeyId, recipientKeyVersion, nonce, enc}`; comment nêu rõ `tag`/`ciphertext` cố ý KHÔNG bind (tag là output của `final()`, bind sẽ circular — GCM `setAuthTag` mới verify nó).
- `:293-315` — thứ tự đúng: wrap DEK **trước** (`:298`, để `enc` có mặt trong AAD) → `createCipheriv` → `cipher.setAAD(canonicalDeliveryAad({...version:1, suite, recipientKeyId, recipientKeyVersion, nonce, enc}))` → `update/final` → `getAuthTag`.
- `:317-318` zero DEK; `:334-339` envelope phải qua `RecipientDeliveryEnvelopeSchema` (ENC-01).
- **Wire-change note (hợp lệ & có chủ):** `:174-177` — version envelope KHÔNG bump; consumer chưa cập nhật sẽ fail tag check thay vì mis-decrypt im lặng.

**Test (consumer-side stand-in `externalDecrypt` tự set lại AAD — `tests/delivery-encryption.test.ts:121-125`):**
| hành vi | bằng chứng |
|---|---|
| round-trip đúng | `:902-905` (`externalDecrypt(envelope)` == payload), dùng chung ở nhiều case |
| tamper **từng trường header** → fail tag | `:907-919` — `it.each` 7 trường: `recipientKeyVersion`, `recipientKeyId`, `suite`, `version`, `nonce`, `enc`, **`tag`** |
| splice group (nonce/tag/enc/ciphertext của envelope cũ dưới header mới) | `:921-945` — splice throw; **cả hai bản gốc vẫn decrypt** (:943-944) → splice fail thật, không phải fixture vỡ |
| ciphertext flip 1 byte | `:846-855` |
| nonce replay sang envelope khác | `:858-863` |
| giới hạn trung thực của AAD (cùng key + header giống hệt → re-heading chính là bản cũ, không phải attack) | `:947+` — ghi nhận tường minh, không over-claim freshness |

**Kết luận:** không nhận nhầm (mọi trục tamper đều fail tag), round-trip đúng, đúng hướng spec. **Phần cần live/external:** `externalDecrypt` là consumer **trong cùng repo**; bằng chứng consumer thật (external app áp AAD) ngoài repo chưa có — đúng như spec "wire change phải có consumer-side evidence" (ghi ở §6).

## 2. RFX-02 — `policy.suite` fail-closed → **CONFIRMED**

**Code:** `delivery-encryption.ts:79-83` thêm code `DELIVERY_SUITE_INCOMPATIBLE` (policy decision, tách khỏi crypto failure chung); `:133-146` `resolveSuite(key, policy)` — pin khớp key → tôn trọng; pin không khớp → **throw `DELIVERY_SUITE_INCOMPATIBLE`** kèm message nêu cả hai phía; `:279` gọi trước `try` nên không bị nuốt thành `DELIVERY_CRYPTO_FAILURE`; HPKE chưa implement bị chặn riêng (`:281-287`).

**Test — matrix đủ 4 ô + 1:**
| case | kỳ vọng | bằng chứng |
|---|---|---|
| RSA key + pin `rsa-oaep-sha256` | OK, round-trip | `:754-762`, thêm `:1003-1008` ("pinned rsa") |
| RSA key + pin `hpke-rfc9180` | `DELIVERY_SUITE_INCOMPATIBLE` (không phải crypto error chung) | `:737-752` |
| X25519 key + pin `rsa-oaep-sha256` | `DELIVERY_SUITE_INCOMPATIBLE` + message nêu `rsa-oaep-sha256` & `hpke-x25519` | `:1011-1018`, `:1021-1033` |
| không pin | key algorithm quyết định (hành vi trước-fix giữ nguyên) | `:1036-1039` |
| X25519 + không pin | `DELIVERY_CRYPTO_FAILURE` "not implemented", không downgrade RSA | `:261-269` |

**Residual finding (đã được pin là FINDING, không phải drift):** `:702-735` — registry row chỉ shape-validate lúc đăng ký; `resolveSuite` gate **chỉ** trên `hpke-x25519`, mọi giá trị khác (PSS, typo, chuỗi rỗng) rơi về RSA-OAEP; **envelope report đúng cái đã làm** (không mislabel) nhưng field `algorithm` của registry không được đối chiếu với material. Owner nên quyết định có cần cross-check registry hay không — ngoài scope WTV-03.

## 3. RFX-08 — bound plaintext collect → **CONFIRMED**

**Code:** `crypto-storage-facade.ts:16` (hằng bound), `:500-520` (`maxPlaintextBytes`, mặc định = `CRYPTO_STORAGE_MAX_DECRYPT_BYTES`, validate ≤ trần), **pre-check** `:695-701` (`manifest.totalSizeBytes > bound` → `SIZE_LIMIT` trước khi decrypt), **backstop mid-stream** `:896-902` + re-throw `SIZE_LIMIT` không relabel `:911`.
**Mapping ra caller:** `encryption/artifact-read-decrypt.ts:113-123` — `SIZE_LIMIT` → `fail(413, 'TOO_LARGE', 'encrypted artifact exceeds the maximum decryptable size')`; `AUTHENTICATION_FAILED` giữ 503 (không phân biệt wrong-key/tamper/context — chống oracle, `:125-129`).

**Test:**
- `tests/crypto-storage-plaintext-bound.test.ts`: default bound + override rác (:115), round-trip dưới bound (:131), **đúng-bằng bound vẫn đọc được** (:144), vượt bound → `SIZE_LIMIT` (:179, :201), **vượt giữa stream** → `SIZE_LIMIT` + bytes đã phát ≤ bound + 1 chunk (:205-231), **RSS evidence** (:235-277): giữ mọi chunk như `decryptStoredArtifact` rồi concat; assert deterministic `retainedBytes ≤ bound + CHUNK` (:277); RSS delta được **ghi lại chứ không assert** trong jest (comment :271-276 nói rõ worker heap dùng chung — trung thực, không over-claim).
- `tests/artifact-read-decrypt-offline.test.ts:595-647` — "F1: an over-bound read is 413 `TOO_LARGE`, not an authentication verdict".
- `packages/worker-sdk/tests/crypto-storage-plaintext-bound.test.ts` — bản consumer cùng chạy (§5).

**Số đo RSS (literal):** trong suite: `[rfx08] artifact=12582912 bound=5242880 retained=4194304 peakRssDelta=12767232 code=SIZE_LIMIT` (lần chạy trước 12,685,312 — cùng bậc). Bổ sung process-level (harness `opt-perf-02-crypto-chunk-bench.cjs`, trần chunk thay được, đo **đường encrypt-stream**, không phải đường collect): `--size-mib=64 --runs=2 --chunk-mib=4,8` → 4 MiB: `peakRssDelta=0` cả 2 run; 8 MiB: `36,036,608` / `54,702,080`, `roundTrip:"pass"`, throughput ~405-462 MiB/s, EXIT=0. Trần RSS không scale theo artifact (64 MiB input, delta ≤ ~52 MiB) — labeled rõ vì đây là đường stream không collect.

## 4. RFX-16 — rationale unwrap-trước-MAC → **CONFIRMED**

`crypto-storage-facade.ts:830-851` — comment đủ 4 điểm spec yêu cầu: (a) MAC key derive **từ** DEK (`manifestMacKey` HKDF) nên unwrap trước là **bắt buộc**, không có đường MAC-first; (b) đường single-shot unwrap SAU AAD check vì AAD của nó không cần key — giải thích vì sao hai thứ tự khác nhau; (c) chi phí đã được giảm trước generator: `validateManifest` (unknown field / foreign context AAD / geometry / thứ tự & kích thước chunk / tổng chunk khớp totalSizeBytes / maxChunks) + pre-check RFX-08 — attacker-crafted manifest chỉ tới được unwrap khi shape+context đúng; (d) rate-limit/backoff là việc của Vault caller nếu bị abuse, và error path giữ "wrap sai" ≡ "MAC sai" (không oracle). Vị trí dời so với spec (795-810 → **830-851** sau các thay đổi khác) — nội dung đúng, không drift.

## 5. Commands (literal — cwd `D:\Git\dugate`)

```
> pnpm --dir du-rework/services/orchestrator exec jest tests/delivery-encryption.test.ts tests/crypto-storage-plaintext-bound.test.ts tests/crypto-storage-facade.test.ts tests/artifact-read-decrypt-offline.test.ts tests/webhook-delivery-encryption.test.ts tests/enc08-wire-enc07.test.ts tests/encryption-boot-options.test.ts --runInBand
PASS ×7; Test Suites: 7 passed, 7 total; Tests: 249 passed, 249 total; EXIT=0
[rfx08] artifact=12582912 bound=5242880 retained=4194304 peakRssDelta=12767232 code=SIZE_LIMIT

> pnpm --dir du-rework/packages/worker-sdk exec jest tests/crypto-storage-plaintext-bound.test.ts tests/crypto-seam.test.ts --runInBand
PASS ×2; Test Suites: 2 passed, 2 total; Tests: 21 passed, 21 total; EXIT=0

> pnpm --dir du-rework/packages/contracts exec jest tests/encryption.test.ts tests/grant-encryption-envelope.test.ts --runInBand
PASS ×2; Test Suites: 2 passed, 2 total; Tests: 51 passed, 51 total; EXIT=0

> (cwd: du-rework/services/orchestrator) node opt-perf-02-crypto-chunk-bench.cjs --size-mib=64 --runs=2 --chunk-mib=4,8
roundTrip:"pass" cho cả 4 run; peakRssDeltaBytes: 0/0 (4 MiB), 36036608/54702080 (8 MiB); EXIT=0
```

Tổng: **11 suite / 321 test pass, 0 fail, 0 skip; 4 lệnh EXIT=0** (không suite nào cần live/skip cho các row này).

## 6. Verdict + phần cần live/external

| row | verdict | cần live/external? |
|---|---|---|
| RFX-01 | **CONFIRMED** (code `delivery-encryption.ts:157-191,293-315`; test tamper ma trận 7 trường + splice + flip + replay) | **CÓ** — consumer-side decrypt thật (external app ngoài repo) cho wire change AAD; offline stand-in `externalDecrypt` chưa thay được |
| RFX-02 | **CONFIRMED** (matrix 3 ô quyết định + 2 ô giữ nguyên; code `:133-146`) | Không (thuần policy); finding registry-algorithm để owner quyết |
| RFX-08 | **CONFIRMED** (pre-check + backstop + mapping 413; test bound/RSS) | Không bắt buộc cho bound; nếu muốn số production thì chạy lại harness với size lớn hơn (labeled) |
| RFX-16 | **CONFIRMED** (rationale `:830-851`) | Không |

**Boundary:** chỉ đọc source + chạy jest/bench; không sửa file; không tick; không commit. Hai finding mở được nêu ở §2 (registry algorithm cross-check) và §6 (consumer-side AAD evidence ngoài repo) — thuộc owner, không tự đóng row.
