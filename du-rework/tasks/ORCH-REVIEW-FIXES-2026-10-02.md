# Orchestrator review fixes — crypto, upload path, boot wiring

**Trạng thái 2026-10-02:** Đây là inventory lỗi và acceptance, **không phải active dispatch board**. Nguồn: (a) lượt review đọc-kỹ 18 file `services/orchestrator/src/modules/{encryption,artifacts,public-api}` (verify trực tiếp từng dòng code), (b) đọc trực tiếp `src/main.ts`, `src/server.ts`, `src/http/ingress.ts`, `src/http/errors.ts`, `src/shutdown.ts`. Bốn luồng review còn lại (entrypoints/DB sâu, compat legacy, admin/auth/billing, migrations/tests/config) đang chạy — khi xong sẽ bổ sung **addendum** vào file này, không tạo file mới. Xem [execution overlay](IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md) và ledger/terminal hiện tại trước khi giao; không suy trạng thái từ snapshot này. Owner phải đọc lại source trước khi nhận packet (file:line dưới đây là working tree quanh HEAD `f2be0de`, có thể lệch sau rebase). Các packet là sub-packet của ENC/CR28/DATA/SEC/COMP, không tạo gate mới, không tick parent hai lần. Các gate `G-ENC`, `G-DATA`, `G-SEC`, `G-COMP`, `G-ADMIN-OPS` và `G6` giữ **NO-GO**. Cần Claude Code `APPROVED` trước khi tick `[x]`; mock xanh không thay live evidence.

**File-lease bắt buộc (serialize, một owner tại một thời điểm):**
- `services/orchestrator/src/server.ts` — RFX-10/11/12 (chung một owner boot/wiring).
- `services/orchestrator/src/modules/artifacts/multipart-service.ts` — RFX-03/07.
- `services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts` — RFX-04/05/06.
- `services/orchestrator/src/modules/public-api/delivery-encryption.ts` — RFX-01/02.
- `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` — RFX-08 (+RFX-16 liên quan).
- `services/orchestrator/src/modules/artifacts/storage-migration.ts` + `s3-storage-facade.ts` — RFX-09/13.

## RFX-01 — Delivery encryption AES-GCM thiếu AAD (crypto thực sự)

**Priority/parent:** P0; `ENC-07`, `G-ENC`. **Owner gợi ý:** Encryption owner (delivery path).

**ISSUE:** `services/orchestrator/src/modules/public-api/delivery-encryption.ts:226-230` gọi `createCipheriv('aes-256-gcm', dek, nonce)` rồi `update/final`, không gọi `setAAD`. Envelope header (`version`, `suite`, `recipientKeyId`, `recipientKeyVersion`, `nonce`, `tag`, `enc`) không được bind cryptographically: header bị sửa mà tag vẫn verify được; toàn bộ bộ (nonce/tag/enc/ciphertext) của response cũ có thể substitute sang response mới mà tầng crypto không phát hiện. (Đối chứng: storage path `crypto-storage-facade` có AAD đầy đủ tenant/artifact/version/purpose — delivery path là ngoại lệ.)

**Xử lý:** `setAAD` với canonical JSON của các trường header envelope trước `final()` ở phía encrypt, và cùng canonical bytes ở phía decrypt/verify (contract phía client phải được cập nhật đồng bộ — đây là wire change, cần version envelope hoặc compat note). Không dùng AAD = ciphertext (circular). Zero DEK sau dùng đã có (`dek.fill(0)` line 236) — giữ nguyên.

**Acceptance:** Unit test tamper từng trường header (đổi `recipientKeyVersion`, swap nonce/tag từ envelope cũ) phải fail tag check; envelope hợp lệ round-trip đúng. Receipt: command, cwd, build digest, passed/failed, exit code. Wire change phải có consumer-side evidence (external decrypt), không chỉ producer unit.

## RFX-02 — `policy.suite` bị bỏ qua lặng lẽ

**Priority/parent:** P1; `ENC-07`. **Owner gợi ý:** cùng owner RFX-01.

**ISSUE:** Interface comment tại `delivery-encryption.ts:116-120` nói "Policy suite preference is honored only if compatible with the key", nhưng `resolveSuite(key)` (`:121-124`) không nhận policy, không đọc `policy.suite` — policy pin suite bị override lặng lẽ theo key algorithm (RSA→rsa-oaep, X25519→hpke). Sai contract; HPKE hiện throw `DELIVERY_CRYPTO_FAILURE` (`:215-220`) nên tenant pin HPKE nhận lỗi khó hiểu thay vì policy decision rõ ràng.

**Xử lý:** Một trong hai: (a) truyền policy vào `resolveSuite`, tôn trọng pin khi tương thích và fail-closed với code rõ ràng khi không tương thích; hoặc (b) sửa comment + contract thành "suite do key quyết định, policy.suite không dùng" và xóa field khỏi policy type. Không để doc và behavior lệch nhau.

**Acceptance:** Matrix test: RSA key + pin rsa-oaep → ok; X25519 + pin rsa-oaep → fail-closed với code định trước (không phải crypto error chung); doc/contract khớp behavior. Typecheck + focused suite xanh.

## RFX-03 — Public multipart ghi PLAINTEXT thẳng S3, bypass encryption gateway (vi phạm invariant)

**Priority/parent:** P0; `ENC-02/03/05`, `CR28-01`, `G-ENC`. **Owner gợi ý:** Artifact/storage owner; serialize `multipart-service.ts` với RFX-07.

**ISSUE:** `services/orchestrator/src/modules/artifacts/multipart-service.ts:908-1010` (`publicInit`/`publicGrantPart`/`publicComplete`) presign URL cho client PUT bytes trực tiếp vào S3, không qua `CryptoStorageFacade`. Trong khi `services/orchestrator/src/modules/encryption/boot-options.ts:155-160,204-209` khẳng định S3 backend thì encrypted upload gateway là write path duy nhất và bật encryption bắt buộc. Không có guard nào từ chối lifecycle này khi encryption enabled → plaintext at rest trong cùng bucket; nếu `encryptionRequired=true` (`modules/encryption/artifact-read-decrypt.ts:86`) thì artifact đó sau đó read path fail-closed 503 (ghi xong không đọc được).

**Xử lý:** Quyết định scope trước (giữ hay cấm public multipart khi encryption bật), rồi hoặc (a) chặn `publicInit`/`publicGrantPart` fail-closed khi encryption required, hoặc (b) buộc public multipart đi qua gateway mã hóa (server-side seal sau complete, manifest + marker đầy đủ). Không để hai write path với hai tính chất mã hóa khác nhau cùng tồn tại lặng lẽ. Kiểm tra cả nhánh single-PUT public (`server.ts:1456-1474`) đã qua gateway — giữ tính nhất quán.

**Acceptance:** Với S3 + encryption bật: public multipart hoặc bị từ chối rõ ràng, hoặc round-trip ciphertext-only (S3 byte-scan không thấy plaintext sentinel, read path decrypt đúng). Public single-PUT behavior không đổi (regression suite). Live S3 evidence, không chỉ mock storage.

## RFX-04 — `originalToken` trong gateway claim không phải token gốc

**Priority/parent:** P2; `ENC-05`. **Owner gợi ý:** Upload gateway owner; serialize `upload-encryption-gateway.ts` với RFX-05/06.

**ISSUE:** `services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts:340` query `token AS "claimToken", token AS "originalToken"` — cả hai alias cùng cột `token` hiện tại. Sau một claim hết hạn (CLAIM_TTL 1h, line 39) rồi claim lại, `commit` (line 684, `token=$7=originalToken`) và `release` (line 381-385) restore về token của claim TRƯỚC, không phải token init. Hiện token không dùng authorize sau READY nên impact thấp, nhưng invariant "originalToken" sai và `release` có điều kiện `token=$3` (claimToken) có thể miss trong chuỗi claim chồng.

**Xử lý:** Lưu token gốc thật (cột riêng hoặc đọc từ session init row trước khi claim đầu tiên ghi đè), `commit`/`release` dùng đúng giá trị gốc. Hoặc chứng minh token sau READY không còn ý nghĩa và xóa khái niệm originalToken khỏi type + query (bỏ chứ không để sai).

**Acceptance:** Test chuỗi claim → expire → claim lại → commit/release: token cuối bằng token init (hoặc type không còn field originalToken nếu chọn hướng xóa). Focused gateway suite xanh, không vỡ replay test hiện có.

## RFX-05 — Manifest sidecar ghi/verify không pin VersionId

**Priority/parent:** P1; `ENC-05`, `CR28-01`. **Owner gợi ý:** cùng owner RFX-04.

**ISSUE:** `upload-encryption-gateway.ts:642-667` (`storeAndVerifyManifest`) PutObject + Head/Get không kèm `VersionId`; retry đồng thời overwrite manifest key làm `completeReplay` (line 880-906, Get không VersionId) verify nhầm manifest mới → 409 sai (fail-closed nhưng sai lý do, retry hợp lệ bị từ chối). Delete manifest ở `deleteWrittenObjects:700` không VersionId → chỉ tạo delete marker, bản cũ chứa wrapped DEK vẫn nằm trong bucket (rác mã hóa + tốn lưu trữ).

**Xử lý:** Pin VersionId từ PutObject response cho Head/Get verify; delete kèm VersionId cụ thể; `completeReplay` đọc đúng version đã commit trong cùng attempt. Nếu backend PG (không có version) thì code path đã tách — chỉ sửa nhánh S3.

**Acceptance:** Test retry đồng thời (2 complete cùng session): một thắng, một nhận replay-409 đúng với manifest của chính nó (không verify nhầm). Sau delete, Get version cũ phải 404 (không còn delete-marker che). Live S3 versioned bucket evidence.

## RFX-06 — Claim mutex chặn retry tới 1 giờ sau crash

**Priority/parent:** P1; availability; `ENC-05`. **Owner gợi ý:** cùng owner RFX-04.

**ISSUE:** `upload-encryption-gateway.ts:354-357`: upload crash giữa chừng không `release` → `token_expires_at` còn hiệu lực tới 1h (CLAIM_TTL_MS line 39) → mọi retry nhận 409 "another upload request is already active" dù không request nào đang chạy. Self-healing duy nhất là chờ hết TTL.

**Xử lý:** Rút ngắn CLAIM_TTL cho phù hợp (phân biệt single vs multipart), và/hoặc heartbeat/renew claim trong lúc upload streaming, và/hoặc fencing bằng claimToken (retry mang cùng uploadToken + proof được tiếp quản thay vì 409 cứng). Giữ nguyên tính chất mutex chống double-write thật.

**Acceptance:** Test crash-giả (claim rồi drop không release): retry sau grace ngắn thành công; hai uploader thật đồng thời vẫn chỉ một thắng (mutex không bị yếu đi). Ghi rõ TTL mới vào docstring/config.

## RFX-07 — `grantPart` cho phép overwrite declaration của part đã grant

**Priority/parent:** P1; `DATA-04`. **Owner gợi ý:** cùng owner RFX-03 (serialize `multipart-service.ts`).

**ISSUE:** `multipart-service.ts:400-413` (`insertPartDeclaration`) dùng `ON CONFLICT (artifact_id, part_number) DO UPDATE` — hai grantPart đồng thời cùng part với hash khác nhau đều thành công; client upload theo grant thứ nhất thì `complete` CHECKSUM_MISMATCH (line 539) vì declaration đã bị grant thứ hai ghi đè. Lỗi trỏ nhầm vào client trong khi race thuộc về server.

**Xử lý:** `DO NOTHING` + so khớp hash cũ (cùng hash → trả grant replay; khác hash → 409 PART_CONFLICT rõ ràng), hoặc lock session row xuyên suốt grant (đã có `lockSessionTenant` trong tx — kiểm tra tại sao vẫn lọt: `insertPartDeclaration` có chạy cùng tx lock không). Áp dụng cho cả runtime branch (line 779) và public branch (line 1006).

**Acceptance:** Test 2 grantPart đồng thời cùng part khác hash: grant 2 nhận 409 conflict (không overwrite lặng lẽ); cùng hash → cả hai thành công (replay). `complete` sau đó verify đúng hash của grant thắng.

## RFX-08 — `collectStream` decrypt không giới hạn kích thước (OOM)

**Priority/parent:** P0 availability/DoS; `ENC-05`. **Owner gợi ý:** Encryption owner (read path).

**ISSUE:** `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` (`collectStream`, được gọi từ decrypt path ~line 254-263) tải toàn bộ plaintext vào memory; upload tối đa 8 GiB (`DEFAULT_MAX_UPLOAD_BYTES`) → OOM trên artifact lớn qua authenticated read path (`server.ts` blob GET decrypt + `decryptStoredArtifact`). Chú ý `server.ts:161-178` (`readStreamBounded`) đã có bound 64 MiB cho ciphertext fetch — nhưng plaintext collect sau decrypt không có bound tương ứng.

**Xử lý:** Bound plaintext collect (từ chối + hướng dẫn dùng chunked/streaming decrypt khi vượt ngưỡng), hoặc chuyển read path sang streaming decrypt thực sự (không collect). Ngưỡng phải nhất quán với `MAX_DECRYPT_BYTES` ở `server.ts:158` và `maxBytes` của gateway.

**Acceptance:** Test decrypt artifact vượt ngưỡng: fail-closed 413/503 rõ ràng thay vì OOM (đo RSS có trần); artifact dưới ngưỡng round-trip đúng. Không vỡ decrypt test hiện có.

## RFX-09 — `importLegacyBlob` race tạo orphan S3 version

**Priority/parent:** P2; hygiene; `DATA-04`. **Owner gợi ý:** Storage-migration owner; serialize với RFX-13.

**ISSUE:** `services/orchestrator/src/modules/artifacts/s3-storage-facade.ts:885-891`: hai import đồng thời cùng blob đều PutObject (2 version), CAS ở `storage-migration.ts:194-201` chỉ cho 1 row commit; version thua thành orphan không bao giờ bị dọn (cleanup `.catch(() => undefined)` best-effort, không có sweep).

**Xử lý:** Hoặc dọn version thua ngay trong CAS-loser branch (cần VersionId từ Put response — kiểm tra đã giữ chưa), hoặc ghi orphan vào bảng sweep và có job dọn định kỳ. Kết hợp với RFX-13 (thu hẹp lock window) để giảm xác suất race.

**Acceptance:** Test 2 import đồng thời: 1 row commit + bucket chỉ còn 1 version live (version thua bị xóa hoặc có sweep record). Liệt kê version sau test làm evidence.

## RFX-10 — Dev fallback tenant/api_key rows chèn vô điều kiện cả khi boot production

**Priority/parent:** P1; security hygiene; `SEC`. **Owner gợi ý:** Boot/wiring owner (chung `server.ts` với RFX-11/12).

**ISSUE:** `services/orchestrator/src/server.ts:466-477` chèn `tenants(id=...0001)` + `api_keys(dev-fallback-placeholder, ACTIVE)` `ON CONFLICT DO NOTHING` vô điều kiện — kể cả `autoMigrate=false` (production path). Auth vẫn fail-closed (hash placeholder không match key thật) nhưng DB production có sẵn row `dev-fallback` ACTIVE; row này còn là FK target cho legacy rows — che giấu lỗi referential thay vì lộ ra.

**Xử lý:** Gate khối seed này theo env (ví dụ chỉ khi `NODE_ENV=development` hoặc flag `DU_SEED_DEV_FALLBACK=true`), production boot không chèn gì. Kiểm tra không có code path nào phụ thuộc row này ngoài FK (nếu có, sửa cho fail rõ thay vì dựa fallback).

**Acceptance:** Boot production-mode (`autoMigrate=false`, không flag): `SELECT * FROM api_keys WHERE prefix='dev-fallback'` trả 0 row; boot dev/test với flag vẫn có row. Typecheck + boot smoke cả hai mode.

## RFX-11 — Grant URL build từ Host header (host-header injection)

**Priority/parent:** P0 security; `SEC`. **Owner gợi ý:** cùng owner RFX-10.

**ISSUE:** `services/orchestrator/src/server.ts:1389,1411,1443` gọi `absoluteGrantUrl(ctx.host, …)` trong đó `ctx.host = req.headers.host` (`server.ts:785`). Sau reverse proxy cho phép Host tùy ý, client nhận `uploadUrl`/`downloadUrl`/`partUrl` trỏ tới host giả → phishing credential/token hoặc upload bytes tới attacker endpoint (grant token nằm trong URL — xem RFX-15 — càng nhạy cảm).

**Xử lý:** Cấu hình public base URL cố định ở platform config (đã có tiền lệ `jsonBaseUrl` — xem `server.ts:332,886`); `absoluteGrantUrl` dùng base URL đó, chỉ fallback Host header khi base URL không cấu hình AND ở dev/test. Proxy vẫn forward Host thật thì allowlist Host ở ingress là lớp bổ sung, không phải fix chính.

**Acceptance:** Test gửi `Host: evil.example` với base URL đã cấu hình: grant URL trả về vẫn host cấu hình (không phải evil). Test dev-mode không base URL giữ behavior cũ. Ghi vào DEPLOY doc (reverse-proxy Host allowlist).

## RFX-12 — Worker heartbeat là stub trả về số liệu cố định

**Priority/parent:** P2; ops-honesty; `P8`. **Owner gợi ý:** cùng owner RFX-10.

**ISSUE:** `services/orchestrator/src/server.ts:1592-1601` (`PUT /api/runtime/v1/workers/:instanceId/heartbeat`) trả `{ health: 'HEALTHY', leaseExpiresAt: now+60s, capacity: 1 }` cố định, không ghi DB, không phản ánh trạng thái thật. Operator/autoscaler đọc health này sẽ ra quyết định sai (luôn HEALTHY, capacity luôn 1).

**Xử lý:** Một trong hai: (a) nối heartbeat vào runtime/lease state thật (ghi DB, tính capacity/lease từ dữ liệu); hoặc (b) nếu chỉ là compat surface giữ worker cũ không 404, comment rõ "stub compat — không dùng cho monitoring", trả `health: 'UNKNOWN'` thay vì `HEALTHY`, và ghi vào ops doc endpoint monitoring thật là `/health` + `queueIntegrity`.

**Acceptance:** Sau fix: hoặc heartbeat phản ánh DB state (test ghi DB rồi heartbeat thấy đổi), hoặc response + doc ghi rõ stub + ops doc chỉ monitoring endpoint thật. Không để `HEALTHY` giả trong production.

## RFX-13 — `storage-migration` giữ `FOR UPDATE` xuyên qua S3 network call

**Priority/parent:** P1; availability/lock-contention. **Owner gợi ý:** cùng owner RFX-09.

**ISSUE:** `services/orchestrator/src/modules/artifacts/storage-migration.ts:149-205` giữ `FOR UPDATE OF a` (lock artifact row) xuyên qua các S3 network call (import + verify, hàng chục giây với blob lớn) → block mọi `requestAccess`/`finalize` cùng artifact. Dưới tải migration, lock wait cascade.

**Xử lý:** Thu hẹp lock window: đọc state + quyết định ngoài lock (optimistic), chỉ giữ lock cho CAS update cuối (đã có điều kiện `storage_version_id IS NULL`-style — kiểm tra và tái sử dụng); hoặc lock theo migration-job row riêng thay vì artifact row hot. Đảm bảo loser vẫn dọn version (liên RFX-09).

**Acceptance:** Test migration blob lớn + `requestAccess` đồng thời: requestAccess không bị block quá ngưỡng (đo p99 lock wait hoặc dùng `statement_timeout` ngắn làm evidence); kết quả migration vẫn đúng (1 version live). Không vỡ migration test hiện có.

## RFX-14 — `integrity-scanner` `withDeadline` không cancel tác vụ nền

**Priority/parent:** P2; resource-exhaustion. **Owner gợi ý:** Artifact owner.

**ISSUE:** `services/orchestrator/src/modules/artifacts/integrity-scanner.ts:150-188`: `withDeadline` chỉ reject promise, không cancel DB query / `readLegacyBlob` đang chạy (chỉ destroy S3 stream qua onStop line 335-338) → operation quá hạn vẫn chạy nền tốn resource; scanner tick tiếp theo chồng thêm.

**Xử lý:** Truyền AbortSignal/cancel xuống DB query (pg `query` với signal hoặc `statement_timeout` per-scan-query) và `readLegacyBlob`; single-flight per tick (tick mới bỏ qua khi tick cũ chưa xong, có metric/log). Timeout value vào config thay vì hardcode nếu chưa có.

**Acceptance:** Test scan với blob chậm + deadline ngắn: sau deadline không còn query/stream nền (đếm open handle hoặc pg `pg_stat_activity`); tick chồng không chạy song song. Không vỡ scanner test hiện có.

## RFX-15 — Grant token nằm trong query string của proxy blob URL

**Priority/parent:** P1; secret hygiene; `SEC`. **Owner gợi ý:** Artifact route owner (`artifacts.ts:143,656` + `server.ts` blob route).

**ISSUE:** Grant token đặt trong query string (`?grant=${token}`) của proxy blob URL — bearer-in-URL dễ leak vào access log (proxy, LB, browser history), đi ngược chính sách ADM-BASE-03 (không để credential vào surface lộ). Token đã có scope method + expiry (CR-12) nên blast radius có hạn, nhưng vẫn là hygiene sai.

**Xử lý:** Chuyển grant sang `Authorization` header (client presigned-flow có thể mang header) hoặc form field POST; nếu URL-borne là bắt buộc vì presigned-GET tương thích, rút ngắn TTL grant, single-use (revoke sau GET đầu), và ghi rõ access-log redaction rule cho param `grant` vào DEPLOY doc. Chọn một hướng và làm triệt để, không nửa vời.

**Acceptance:** Sau fix: token không xuất hiện trong URL (hoặc TTL/single-use + log-redaction doc + test chứng minh log không chứa token). E2E blob PUT/GET với client thật vẫn pass.

## RFX-16 — Chunk-path unwrap DEK trước MAC-check (Vault-call oracle nhẹ)

**Priority/parent:** P3 (ghi nhận, rate-limit khi cần). **Owner gợi ý:** cùng owner RFX-08.

**ISSUE:** `crypto-storage-facade.ts:795-810` (`decryptChunkGenerator`) unwrap DEK qua Vault TRƯỚC khi MAC-check — bắt buộc về thiết kế vì MAC key dẫn xuất từ DEK — nên manifest attacker-crafted bất kỳ cũng gây 1 Vault decrypt call trước khi fail. Đường single-shot (`decrypt`, line 575) unwrap SAU AAD check — đúng. Thực tế `validateManifest` ở `decryptStream:667` đã pre-check contextAad/geometry nên chỉ DEK-wrap hợp lệ + MAC sai mới tốn call — mức nhẹ, không phải vuln độc lập.

**Xử lý:** Không đổi thứ tự (đúng thiết kế). Ghi nhận để đặt rate-limit/backoff phía Vault caller nếu decrypt endpoint bị abuse; đảm bảo error path không phân biệt "wrap sai" vs "MAC sai" bằng timing đáng kể (không oracle padding).

**Acceptance:** Ghi nhận design rationale vào code comment tại 795-810 (vì sao unwrap trước là bắt buộc + pre-check nào đã giảm cost); không cần test mới trừ khi thêm rate-limit.

## Quy tắc đóng chung

- Mỗi packet: focused test đi cùng implementation (ghi command, cwd, build digest, passed/failed/skipped, exit code, raw log); live S3/Vault/PG evidence cho packet chạm storage/crypto/migration (RFX-01/03/05/08/09/13); mock xanh không thay live.
- Không sửa file ngoài packet đã cấp; shared-file lease ở đầu file này là bắt buộc (đặc biệt `server.ts`, `multipart-service.ts`, `upload-encryption-gateway.ts` đang có nhiều lane cùng đụng — rebase + đọc lại source trước khi nhận).
- Wire change (RFX-01 AAD, RFX-15 grant transport) cần consumer-side evidence, không chỉ producer test.
