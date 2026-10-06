# WTV-04 — Verify RFX-03/05/14/15 (upload/storage) trong CONV refactor (cc_2)

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Dispatch:** 2026-10-03T14:01+07:00 (coordinator command-code).
- **Mode:** READ-ONLY + được chạy test. Không sửa file nào; **không tick; không commit; không chạm `nocobase-10`**.
- **Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` row WTV-04; `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` RFX-03/05/14/15. Tự re-derive từ source hiện tại (sau CONV-01..03) + chạy focused suite; các receipt cũ (`qwen-rfx-multipart`, `codex-rfx05-full-v2`, `cc-crx02-rfx05res`, `codex-rfx-scanner`, `cc-conv13-rfx15`) chỉ dùng đối chiếu, **không** làm bằng chứng.
- **Live-S3 rows:** mọi phần live (byte-scan S3, versioned bucket, pg_stat_activity, E2E client thật) **chỉ ghi gap** — không đóng, không giả live.

## 0. TL;DR verdict

| Row | Verdict offline | Bằng chứng chính (file:line worktree hiện tại) | Còn cần live / decision |
|---|---|---|---|
| **RFX-03** | **CONFIRMED (chặn, không phải seal)** — không còn đường public-multipart PLAINTEXT khi encryption bật | guard `publicMultipartBlockedByEncryption`/`assertPublicMultipartAllowed` `multipart-service.ts:73-89`; gọi ở `publicInit:994`, `publicGrantPart:1083`, `publicComplete:1103`; `publicAbort:1173` mở có chủ đích | Live S3 byte-scan (acceptance gốc) chưa chạy; variant (b) server-side seal **chưa làm** — decision của coordinator |
| **RFX-05** | **CONFIRMED offline** (pin/verify/delete theo VersionId + wiring qua vị trí mới của CONV) | gateway `upload-encryption-gateway.ts:706-722` (commit persist), `:730-770` (verify đúng VersionId), `:769-789` (delete kèm VersionId), `:942`,`:976`,`:994-995` (replay theo id đã commit); reader `create-app.ts:125-143`; call sites `runtime.ts:78-101/:322`, `public.ts:509-547`; forward `artifact-read-decrypt.ts:243-245`; migration `0025_artifact_manifest_version.sql` | Live versioned-bucket + apply migration 0025 + hành vi `NoSuchVersion` thật |
| **RFX-14** | **CONFIRMED offline** (cancel thật + single-flight) | `integrity-scanner.ts:36-38` (signal xuyên adapter), `:80-112` (client riêng + `SET LOCAL statement_timeout` + abort→end), `:194-242` (`withDeadline` abort + chỉ settle sau khi op dừng), `:403-413` (destroy stream khi stop), `:285-294` (skip tick + `onSkippedTick` + warn), `:456-459` (gate giữ tới khi op nền settle) | Live `pg_stat_activity`; `openRead` không nhận AbortSignal (residual đã ghi) |
| **RFX-15** | **CONFIRMED theo nhánh đã chọn** (URL-borne + TTL ngắn + single-use + log-capture test) | `artifacts.ts:31-43` (TTL 15m→2m + rationale), `runtime.ts:294-310` (GET single-use atomic, replay→404, PUT không consume), doc-note redaction; test `crx02-…:572-606` (stdout + body không chứa token/`grant=`) | DEPLOY doc redaction mới là doc-note (docs/ chưa sửa); E2E blob PUT/GET client thật |

## 1. RFX-03 — public multipart plaintext (P0)

**Hiện trạng worktree:** write path public-multipart **vẫn tồn tại về code** nhưng **bị chặn fail-closed khi encryption required**; hướng đã thi hành là **(a) CHẶN** (reversible), không phải seal.

- `multipart-service.ts:73-79` `publicMultipartBlockedByEncryption()` — dùng đúng `encryptionIsRequired(process.env)` từ `boot-options` (cùng hàm boot dùng, không copy); **throw được đọc là REQUIRED** (`catch { return true }`).
- `:81-89` `assertPublicMultipartAllowed()` → `HttpError(501, 'PUBLIC_MULTIPART_UNAVAILABLE', …)`.
- Guard chạy **trước mọi side effect**: `publicInit:994` (trước schema parse/session row/provider upload), `publicGrantPart:1083` (trước presign), `publicComplete:1103` (session mở trước khi bật encryption cũng không publish được).
- `publicAbort:1173-1201` **không guard** — có chủ đích (cleanup/giải phóng storage; comment ở `qwen-rfx-multipart` §2c; code xác nhận không gọi assert).

**Wire dispatch hiện tại (sau CONV-02, `http/routes/public.ts`):**
- `PUT /api/v1/uploads/:id/content` `:215-230` → **gateway** (`publicUploadGateway.upload`) — single-PUT qua encrypted gateway (đúng acceptance "single-PUT đã qua gateway").
- `POST /api/v1/uploads` `:247-249` — `sizeBytes < MULTIPART_MIN_TOTAL_BYTES` → `gateway.initSingle`; ngược lại → `multipart.publicInit` → gặp guard 501 khi encryption required.
- `POST …/part` `:259-261` → **409 `STATE_CONFLICT` cứng** ("direct S3 upload grants are disabled for public uploads") — đến từ lane khác (hardening bổ sung), nên `publicGrantPart`/`publicComplete` hiện **không còn caller trên wire** (grep src: chỉ còn định nghĩa trong service) — guard của chúng là defense-in-depth seam, vẫn được test trực tiếp.
- `POST …/complete` `:262-266` → `gateway.completeReplay`; `POST …/abort` `:268` → `multipart.publicAbort` (mở, đúng thiết kế).

**Kết luận RFX-03:** khi `encryptionIsRequired` = true, **không** còn route nào mint presigned PUT/parts cho public multipart, và `publicInit` từ chối trước khi có session row/presign → **không thể ghi plaintext tại rest** qua đường này (seam offline). Không phải BLOCKER code.
**Gap/decision (không tự đóng):**
1. Acceptance gốc "S3 byte-scan không thấy plaintext sentinel" + "round-trip" cần **live S3** — chưa chạy (`data-02-04-live-s3` skip, xem §5). Properties thay thế đã chứng minh: presigned URL không bao giờ tồn tại ⇒ không có byte nào để scan.
2. Variant **(b) server-side seal** cho public multipart trên encrypted deployment: **chưa làm** — đây là decision của coordinator (đã ghi trong receipt gốc, giữ nguyên).

## 2. RFX-05 — manifest sidecar pin VersionId

**Offline đã đủ chuỗi (tất cả ở vị trí mới sau CONV):**
- **Ghi + persist:** gateway commit `:706-722` (`manifest_version_id=$7` với id từ PutObject); `:942` trả `manifestVersionId: writtenManifestVersion`.
- **Verify đúng version đã commit:** `:730-770` `verifyCommittedManifest` — Head/Get **kèm `VersionId`**, mismatch → không replay; `:976`/`:994-995` `completeReplay` select `manifest_version_id` và verify bằng chính id đó.
- **Delete đúng version:** `deleteWrittenObjects` `:775-788` — DeleteObject kèm `VersionId: manifestVersionId` **và** `VersionId: versionId` cho object (hết delete-marker-đơn-độc).
- **Read path:** `create-app.ts:125-143` `readManifest(manifestKey, versionId?)` → `GetObject` có `VersionId` khi defined, `undefined` giữ legacy key-only; ref `manifestVersionId` forward `artifact-read-decrypt.ts:243-245`; SELECT + ref ở 2 call site: `runtime.ts:78-101,:322` (runtime GET) và `public.ts:509-547` (public download).
- **Migration:** `migrations/0025_artifact_manifest_version.sql` (nullable, additive, không backfill).

**Test pin (chạy lại, PASS):** `public-upload-encryption-gateway.test.ts` — persist id (`:595,:646`), replay Head/Get đúng `committedManifestVersionId` dù có object mới hơn cùng key (`:811-833`), row NULL giữ legacy (`:599-606`); `artifact-read-decrypt-offline.test.ts:181-212` (forward id + NULL→undefined); `crx02-rfx05res-s3-read-guard.test.ts` 5 case HTTP (gồm "manifest pin `mv-committed`, không chạm `mv-newer`" và legacy NULL fail-closed).
**Gap live:** versioned bucket thật (MinIO/S3), apply 0025 trên PG thật, hành vi `NoSuchVersion` sau delete (stub trả 404 thường) — chưa chứng minh.

## 3. RFX-14 — scanner deadline cancellation + single-flight

**Hiện trạng (re-verify sau các lane edit):**
- `integrity-scanner.ts:36-38` — `signal?: AbortSignal` + `timeoutMs` xuyên `countLegacyBlobs/listBatch/readLegacyBlob`.
- `:80-112` `scanQuery` — pooled client riêng, kiểm tra `timeoutMs` hợp lệ, `BEGIN READ ONLY` + `SET LOCAL statement_timeout`, abort → `client.end()` + `release(discard)` (cancel ở socket).
- `:194-242` `withDeadline` — AbortController per-op, timeout/abort gọi `controller.abort()` + `onStop(code)`, promise **chỉ settle sau khi op dừng** (stopCode → reject `ScanFailure`), `track(running)` vào `pending`.
- `:403-413` — stream S3 đang mở bị `destroy()` khi stopCode; `:255` destroy khi vượt size.
- `:285-294` — single-flight `activeSources`: tick chồng trả `state:'aborted'` + `SCAN_ABORTED` + `onSkippedTick()` + warn không chứa dữ liệu artifact.
- `:456-459` — gate chỉ được `delete` khi `pending` rỗng, ngược lại `Promise.allSettled` rồi mới xoá (giữ gate tới khi tác vụ nền settle).

**Test pin (PASS):** `artifact-integrity-scanner.test.ts` — `statement_timeout` trên từng query (`:123,:349`), overlap tick skip + `onSkippedTick` (`:360-366`), destroy stream/abort query theo deadline (các case 240/266/284/307 theo wtv08 — chạy lại xanh).
**Gap live:** `pg_stat_activity` thật; residual đã ghi: `openRead` không nhận AbortSignal (nếu lời gọi mở stream không bao giờ resolve, scanner giữ in-flight + skip tick sau — ngoài lease scanner).

## 4. RFX-15 — grant token URL-borne

**Nhánh đã chọn: giữ URL-borne, làm triệt để bằng TTL + single-use + log-redaction doc-note** (lý do hợp lệ: worker SDK fetch grant như presigned URL trần — `packages/worker-sdk/src/artifact-streams.ts:416-420,:701-711`; đổi sang Authorization sẽ phá consumer ngoài lease).
- `artifacts.ts:31-43` — `GRANT_TTL_MS = 2*60*1000` (15m→2m, leak window −7.5×) + rationale đầy đủ trong comment.
- `runtime.ts:294-310` — GET download **single-use atomic**: `UPDATE … SET token_expires_at=now() WHERE id=$1 AND token=$2 AND token_mode='download' AND token_expires_at>now()`; `rowCount=0` → **404** (không phân biệt spent/expired/chưa từng có); consume nằm **sau** mọi fence token/mode/expiry; **PUT không consume** (retry idempotent theo content hash trong TTL ngắn).
- **Log/body:** test HTTP thật `crx02-…:572-606` capture `process.stdout.write` + body lỗi → `not.toContain(token)` và `not.toContain('grant=')`; app chỉ log `pathname`, không log `req.url`/searchParams.
- **Doc-note (KHÔNG sửa docs/):** reverse proxy/LB phải redact tham số `grant` trên path `/api/runtime/v1/artifacts/blob/*` (hoặc tắt query logging path này); consumer phải dùng grant ngay, gặp 404 thì xin grant mới (không retry URL cũ). Hai rule này đang nằm ở receipt/comment, **chưa vào DEPLOY doc** → open item cho docs owner.

**Gap live:** E2E blob PUT/GET với worker SDK thật (chưa có DB/S3 window); redaction ở proxy thật là cấu hình ngoài repo.

## 5. Focused run (literal)

cwd `D:\Git\dugate\du-rework\services\orchestrator`, `NODE_ENV=test`:

```
> pnpm exec jest --runInBand tests/multipart-service-offline.test.ts tests/multipart-routes-offline.test.ts tests/encryption-boot-options.test.ts tests/public-upload-encryption-gateway.test.ts tests/artifact-read-decrypt-offline.test.ts tests/crx02-rfx05res-s3-read-guard.test.ts tests/s3-storage-facade.test.ts tests/storage-migration.test.ts tests/artifact-integrity-scanner.test.ts tests/artifact-read-download-route.test.ts tests/artifact-storage-service.test.ts tests/data-02-04-live-s3.test.ts
JEST_EXIT=0

PASS tests/multipart-service-offline.test.ts
PASS tests/crx02-rfx05res-s3-read-guard.test.ts
PASS tests/public-upload-encryption-gateway.test.ts
PASS tests/artifact-read-decrypt-offline.test.ts
PASS tests/artifact-storage-service.test.ts
PASS tests/artifact-read-download-route.test.ts
PASS tests/storage-migration.test.ts
PASS tests/artifact-integrity-scanner.test.ts
PASS tests/multipart-routes-offline.test.ts
PASS tests/encryption-boot-options.test.ts
PASS tests/s3-storage-facade.test.ts
Test Suites: 1 skipped, 11 passed, 11 of 12 total
Tests:       5 skipped, 225 passed, 230 total

> pnpm exec tsc --noEmit -p tsconfig.json
TSC_EXIT=0
```

Skip duy nhất = `data-02-04-live-s3.test.ts` (live-gated: `:38` `LIVE = DU_LIVE_INFRA === '1'`, `:39` `liveDescribe = LIVE ? describe : describe.skip`, `:41` warn SKIPPED; 5 test skip — đúng cửa sổ live chưa mở). Đây là **gap có kiểm soát**, không phải fail.

## 6. Verdict tổng

- **RFX-03: CONFIRMED (offline/HTTP-local)** — hướng "CHẶN" đã thi hành đúng acceptance mức cơ chế (không còn plaintext path reachable khi encryption required). **Không còn BLOCKER code**; các phần phải live/decision: byte-scan S3 thật + variant (b) seal (coordinator chốt).
- **RFX-05: CONFIRMED offline** — pin/verify/delete theo VersionId đủ chuỗi + wiring sống sót nguyên qua CONV (reader/call sites/file mới). Live versioned-bucket + 0025 apply = gap.
- **RFX-14: CONFIRMED offline** — cancel thật (DB client/stream) + single-flight giữ gate tới khi settle. Live pg = gap.
- **RFX-15: CONFIRMED theo nhánh đã chọn** — TTL 120s + GET single-use 404 + log capture test; DEPLOY doc redaction còn là doc-note (docs owner).
- Không có DRIFT nào giữa hành vi được thi hành và các claim đã kiểm (các claim cũ đều khớp source hiện tại — khác biệt duy nhất: `publicGrantPart/publicComplete` mất caller trên wire do hardening của lane khác, guard vẫn giữ nguyên và được test).
- **Không tick gate nào; không commit; không file nào ngoài receipt này được ghi (read-only + chạy test).**
