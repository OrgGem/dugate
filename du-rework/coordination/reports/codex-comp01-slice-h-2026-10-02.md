# COMP-01 slice H — file/url ingestion policy matrix (READ-ONLY)

TaskRef `task_a670881aa747` · spec `coordination/dispatch-specs/2026-10-02-0205-COMP01-slice-h.md`

**READ-ONLY.** Khong sua file nao (ke ca test). Khong implement gi. Khong chay test, khong upload/download
file that, khong chay cleanup that. Khong doc gia tri secret/key/credential — chi **ten field + file:line**.
Khong tick gate, khong commit, khong nhac `nocobase-10`.

## 0. PHAM VI DOC (va 3 file ngoai danh sach, co ly do)

Danh sach "duoc phep doc" cua spec: `lib/upload.ts`, `upload-helper.ts`, `file-url-downloader.ts`, `zip.ts`,
`lib/pipelines/submit.ts`, `lib/cleanup.ts`, `lib/cleanup-scheduler.ts`, AppSetting S3 key names, Prisma
`FileCache`.

**Ngoai danh sach, doc de lam Acceptance #2 va de khong overclaim:**

- `lib/pipelines/processors/http-client.ts` — noi `assertSafeUrl` that. Khong nam trong danh sach, **cung
  khong nam trong danh sach CAM** (`server.ts`, `contracts`, `tasks/*.md`, `AGENTS.md`, overlay,
  `businesses/document-core/**`). Acceptance #2 yeu cau "SSRF guards (cho co / cho thieu)" thi khong doc file
  giu SSRF thi khong tra loi duoc. Doc **chi de dac ta**.
- `lib/endpoints/runner.ts` — noi `MAX_FILE_URL_ENTRIES` duoc enforce.
- `app/api/v1/docs/workflows/route.ts` + `.../schema/route.ts` — hai noi goi truc tiep `submitPipelineJob`;
  doc de **xac nhan** bound co bi duong khac bypass hay khong.

## 1. BANG UPLOAD POLICY

| muc | rule | bound | file:line |
|---|---|---|---|
| size / file | `> MAX_FILE_SIZE` reject | **300 MiB** | `lib/upload.ts:8`, check `:56` |
| size / request | tong `> MAX_TOTAL_SIZE` reject + xoa het file da luu | env `MAX_TOTAL_UPLOAD_SIZE`, default **1 GiB** | `lib/pipelines/submit.ts:185`, check `:236-247` |
| extension allow | allowlist; mac dinh `.docx`,`.pdf` | override bang `allowedExtsStr` (CSV, trim, lower) | `lib/upload.ts:10`, `:38-45` |
| MIME | `MIME_MAP` chi co **2** muc; **mime rong duoc phep** | neu co gui thi phai khop | `lib/upload.ts:12-15`, `:51-57` |
| macro | `.docm` reject rieng, co message rieng | — | `lib/upload.ts:30-36`, `:81-84` |
| filename normalize | `normalize(NFC)` (NFD→NFC, tieng Viet) | — | `lib/upload.ts:112-114` |
| path traversal | `sanitizeFilename` = `path.basename()` + strip ky tu control va ky tu nguy hiem filesystem | — | `lib/upload-helper.ts:18-21` |
| storageKey | `${operationId}/${safeName}` — namespace theo operation | — | `lib/upload-helper.ts:38` |
| so luong file upload | **KHONG cap** | — | `lib/endpoints/runner.ts:36-52` |
| compressLevel | 4 muc, default `ebook` | — | `lib/upload.ts:132-137` |

**Thu tu co tinh:** validate chay tren **ten raw** truoc, sanitize chay **sau** (`upload-helper.ts:34-36`).
Khong sai ve mat bao mat (storageKey co `operationId/` + basename), nhung nghia la rule ap tren `file.name`
chu khong phai ten da sanitize.

**`zip.ts` (chi output):** `createZipStream` (`zip.ts:20`) — `archiver` zlib level 6. Doc file ton tai qua
`fs.existsSync`/readdir; DOCX: full.md + text-only.md + images/; PDF: text-only.md. **Khong co** bound so file /
so entry / zip64. Ten `${slug}-${today}.zip` (`:22`) — `slug` do caller truyen, **khong sanitize tai day**
(chi anh huong `Content-Disposition`, khong phai ghi ra dia).

## 2. BANG `file_urls`

### 2.1 Auth config shapes (`lib/file-url-downloader.ts:26-32`)

| `type` | field | tao header/query | guard khi thieu |
|---|---|---|---|
| `none` | — | `buildDownloadHeaders:76-78` tra rong | — |
| `bearer` | `token?` | `Authorization: Bearer <token>` (`:79-81`) | thieu token ⇒ **im lang, khong header** |
| `header` | `header_name?` + `header_value?` | `headers[header_name] = header_value` (`:82-84`) | thieu 1/2 ⇒ **im lang** |
| `query` | `query_key?` + `query_value?` | `url.searchParams.set` (`:88-98`) | thieu 1/2 ⇒ `return urlStr` (im lang) |

**Thu tu dung:** `applyQueryAuth` chay **TRUOC** `assertSafeUrl` (`:137`) ⇒ URL co token van duoc validate SSRF
day du. Day la diem **DUNG**, ghi la de khong sua nham.

### 2.2 SSRF — cho co / cho thieu (`lib/pipelines/processors/http-client.ts`)

| guard | trang thai | file:line |
|---|---|---|
| scheme allowlist http/https | **CO** | `:89-91` |
| private/reserved IP string check | **CO** — 127/10/192.168/172.16-31/169.254/0. + ::1, ::, ::ffff mapped, fc, fd, fe80 | `:44-65` |
| `localhost` check | **CO** | `:69-71` |
| DNS resolve + check resolved IP | **CO** | `:113-122` |
| DNS resolve fail ⇒ fail-closed | **CO** (dong) | `:125-128` |
| redirect re-validate **moi hop** | **CO** — manual, goi lai `assertSafeUrl` | downloader `:122`, max 5 (`:13`) |
| IP literal decimal/octal/hex | **CO** — WHATWG `new URL()` canonicalize | `:84-88` + patterns |
| **DNS-rebinding TOCTOU** | **THIEU** | xem M3 |
| **Escape hatch Docker** | **CO — va return som, bo qua 2 check** | `:96-101` |
| **`ALLOWED_PRIVATE_HOSTS`** | bypass **ca 2** check (string + DNS) | `:102-107`, `:109`, `:115` |
| IPv6 `[::1]` literal | hostname co ngoac vu khong khop pattern; `isIpLiteral` true ⇒ **bo qua DNS check** | `:115`, `:52` |

**Escape hatch Docker (`:96-101`)** — dieu kien `UPLOAD_DIR === '/app/uploads'` va hostname `localhost`
⇒ doi thanh `host.docker.internal` roi `return` **ngay** ⇒ bo qua `isPrivateHostname` **va** DNS check.
`host.docker.internal` thuong resolve ve IP private. Gate la env string, khong phai flag.

**`ALLOWED_PRIVATE_HOSTS`** — tach CSV roi `Array.includes` (so sanh dung, **khong** phai substring). Trusted host
thi bo qua **ca** check hostname private **lan** DNS check ⇒ hostname public resolve ve IP private van qua.
Parse sai (subdomain) **khong lo** — diem nay dung.

### 2.3 Timeout / bounds

| muc | gia tri | file:line |
|---|---|---|
| so entry `file_urls` | **20** | `downloader:40`, enforce `runner.ts:141-142` |
| download timeout | env `FILE_URL_DOWNLOAD_TIMEOUT_MS`, default **120000 ms** | `downloader:12` |
| read-stall timeout (slowloris) | env `FILE_URL_READ_STALL_TIMEOUT_MS`, default **60000 ms** | `downloader:14` |
| so redirect | **5** | `downloader:13` |
| do dai ten file | **200** char, `truncateFilename` giu ext | `downloader:15`, `:71-76` |
| concurrency | **5**/batch; batch fail ⇒ xoa het batch + ket qua truoc do | `downloader:273`, `:283-320` |
| Content-Length pre-check | `> MAX_FILE_SIZE` reject truoc khi stream | `downloader:177-181` |
| streaming size cap | `bytesWritten > MAX_FILE_SIZE` throw giua stream | `downloader:222-227` |
| validate som (truoc download) | `validateFileMetadata(filename, mime, 0)`, **bo qua** loi qua-lon | `downloader:195-198` |
| validate cuoi | `validateFileMetadata(..., bytesWritten)`; fail ⇒ `backend.delete` | `downloader:255-260` |

**`MAX_FILE_URL_ENTRIES` chi enforce o `runner.ts:141-142`; `submit.ts` khong tu kiem.** Da kiem 2 route goi
truc tiep `submitPipelineJob` (`workflows/route.ts:88`, `workflows/schema/route.ts:81`) — ca hai chi truyen
`files`, **khong truyen `fileUrls`** ⇒ cap **KHONG bi bypass** qua duong do. Ghi ro de khong bao loi gia.

**Filename sanitize `file_urls` KHAC upload:** `path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')`
(`downloader:206`) — **ASCII-only**, dau tieng Viet bi thay bang `_`; duong upload giu Unicode
(`upload-helper.ts:18-21`). Hai path cung `operationId/` nen khong lo duong di.

### 2.4 MUST-NOT-REPLICATE — SSRF bypass qua `fileUrlFieldName` (M1, nghiem trong nhat)

`submit.ts:252-268`: neu connector dau tien co `fileUrlFieldName`:

1. `forwardUrls = true`, **khong download**.
2. moi entry push `{ path: '', size: 0, url: entry.url, isRemoteUrl: true }`.
3. `assertSafeUrl` **KHONG BAO GIO chay** (khong co `downloadFileUrl` ⇒ khong co `assertSafeUrl` tai `:137`).
4. Khong size bound (0 byte), khong ext/MIME validate, khong 300 MiB cap, khong stall/timeout, khong dedup.
5. `external-api.ts:103-107`: `formData.append(connection.fileUrlFieldName, url)` — **URL raw vao thang
   multipart cua connector**.

⇒ SSRF tro thanh **van de cua connector**, orchestrator mat toan bo visibility: khong validate, khong audit
download, khong ghi nhan byte nao. `file_urls` la input **tu do** cua user, khong can tham quyen fetch.
**Day la MUST-NOT-REPLICATE, khong phai parity.**

## 3. BANG STORAGE / DEDUP / RETENTION

### 3.1 Backend

| muc | trang thai | file:line |
|---|---|---|
| chon backend | **chi dua tren `s3_bucket` co gia tri hay khong** | `lib/storage/index.ts:24-45` |
| fallback | bucket rong ⇒ `LocalStorageBackend`, **im lang khong canh bao** | `index.ts:44-45` |
| creds | bucket co nhung key rong ⇒ SDK default chain (EC2/ECS/env) | `index.ts:31-33` |
| cache | singleton per-process, `resetStorageBackend()` khi doi setting | `index.ts:14`, `:47-49` |
| AppSetting key **TEN** | `s3_bucket`, `s3_endpoint`, `s3_access_key`, `s3_secret_key`, `s3_region`, `s3_cache_ttl_hours` | `index.ts:25-30`, `cleanup.ts:126` |

**KHONG doc gia tri** setting/credential — chi ten field, nhu spec yeu cau.

### 3.2 Dedup (Prisma `FileCache`, `lib/db/schema.ts:152-164`)

| truong | dac ta | dong |
|---|---|---|
| `md5Hash` | `text().unique().notNull()` — **global unique** | `:154` |
| `s3Key` | `text().notNull()` | `:155` |
| `refCount` | `integer().default(1).notNull()` | `:159` |
| `lastAccessedAt` | timestamp(3), default `CURRENT_TIMESTAMP(3)` | `:161` |
| index | `refCount`, `lastAccessedAt` | `:163-164` |

`dedup()` (`lib/storage/dedup.ts:21-79`): upsert `onConflictDoUpdate` target `md5Hash`, set `refCount+1`,
`lastAccessedAt=now`. Neu `result.s3Key !== s3Key` ⇒ **trung hop**: `backend.exists(result.s3Key)`
(catch ⇒ `false`) → co thi **xoa object cua loser** + tra canonical (`:41-48`); khong co ⇒ **adopt object moi
lam canonical** + `UPDATE s3Key` (`:50-54`). Fallback unique-violation race `:58-77`. **Co self-heal** khi
object canonical bi xoa ngoai doi.

### 3.3 Retention — HAI cua so, KHONG phai mot

| job | dieu kien xoa | cua so | file:line |
|---|---|---|---|
| `cleanupExpiredFiles` | `createdAt < cutoff` **AND** `filesDeleted=false` **AND** `deletedAt IS NULL` | `EXPIRY_MS = 24h` | `lib/cleanup.ts:15`, `:41-47` |
| `cleanupExpiredCache` | `refCount <= 0` **AND** `lastAccessedAt < cutoff` | `s3_cache_ttl_hours` default `168` = **7 ngay** | `lib/cleanup.ts:126-131` |

Xoa tung file trong operation: `fileCacheId` ⇒ **`refCount - 1`** (khong xoa S3 ngay) (`cleanup.ts:83-89`);
`s3Key` ⇒ xoa truc tiep (`:90-95`); con lai ⇒ legacy local path + `rmdir` parent (`:96-107`). Sau do
`filesDeleted = true` (`:110`).

⇒ **Vong doi thuc te:** operation bi quet sau **24h**; **blob S3 con lai** va chi bi xoa khi `refCount <= 0`
**va** sau them **7 ngay** nua. Hai con so doc lap, **KHONG phai mot "7-day auto-delete"**.

**Scheduler** (`cleanup-scheduler.ts`): singleton guard `scheduled` (`:12-15`), chay lan dau sau **10s** (`:27`),
lap moi **6h** (`:10`, `:30`). Import tu `layout.tsx`.

## 4. IDEMPOTENCY (spec yeu cau "idempotency voi file")

- Check `submit.ts:141-148`, **truoc** `§4 save file` (`:185`) ⇒ idempotent hit **khong save server-side, khong
  tang `refCount`**. Thu tu nay **DUNG**.
- Race: unique violation ⇒ re-select ⇒ tra existing (`:318-329`).

**MISMATCH / MUST-NOT-REPLICATE (M2):** `operations.idempotencyKey` la **`.unique()` GLOBAL**
(`schema.ts:14`), **khong** composite voi `apiKeyId` (cung `schema.ts:13` la cot rieng). Lookup `submit.ts:143`
chi filter `eq(operations.idempotencyKey, idempotencyKey)` — **khong co filter `apiKeyId`** ⇒ tenant B gui cung
`idempotencyKey` voi tenant A se **nhan lai operation cua tenant A** (`filesJson`, `outputFilePath`,
`extractedData`, `outputContent`). Cross-tenant leak qua idempotency key. **MUST-NOT-REPLICATE.**

## 5. MISMATCH LEDGER (docs/spec claim vs code that)

| # | claim | code that | file:line | verdict |
|---|---|---|---|---|
| **M1** | (spec) SSRF co guard tren `file_urls` | `fileUrlFieldName` ⇒ **khong validate, forward raw** | `submit.ts:252-268`, `external-api.ts:103-107` | **MUST-NOT-REPLICATE** |
| **M2** | (spec) idempotency "voi file" | `idempotencyKey` global unique, lookup khong filter tenant | `schema.ts:14`, `submit.ts:143` | **MUST-NOT-REPLICATE** |
| **M3** | `http-client.ts:78` comment: *"prevents DNS rebinding attacks"* | resolve/check DNS roi `fetch()` **tu resolve lai** ⇒ **TOCTOU**, check khong gan voi connection thuc | `:113-122` vs `file-url-downloader.ts:106-110` | comment **overclaim** |
| **M4** | (spec) *"7-day auto-delete"* trong `cleanup.ts` | operation cleanup = **24h**; 7 ngay la **FileCache TTL**, gated `refCount<=0` | `cleanup.ts:15` vs `:126-131` | spec **gop 2 cua so** |
| **M5** | (spec) path-traversal guard o `lib/upload.ts` | `upload.ts` **khong co** guard nao; guard o `upload-helper.ts:18-21` | — | spec **sai file** |
| **M6** | (spec) `file_urls` cap 20 | cap chi o `runner.ts:141-142`, `submit.ts` khong kiem | — | **khong phai gap** (da verify 2 route khong truyen `fileUrls`) |
| **M7** | — | `validateFile:52` thieu guard `expectedMime &&`; `validateFileMetadata:95` co guard | `upload.ts:52` vs `:95` | **2 validator disagree** khi ext ngoai `MIME_MAP` |
| **M8** | — | `file_urls` cap 20 nhung `files[]` **khong cap so luong** | `runner.ts:36-52` | asymmetry (chi `MAX_TOTAL_UPLOAD_SIZE` chan byte) |
| **M9** | — | `ALLOWED_PRIVATE_HOSTS` + `UPLOAD_DIR==='/app/uploads'` bo qua **ca 2** check SSRF | `http-client.ts:96-107` | fail-open **co chu dich**, phai ghi lai khi review |

**M7 chi tiet:** `MIME_MAP` chi co `.docx`/`.pdf`. Neu operator them `.txt` vao `allowedExtsStr`,
`MIME_MAP['.txt']` la `undefined`:

- upload path (`validateFile:52`): `file.type='text/plain' !== undefined` ⇒ **REJECT**, message in ra
  *"Mong doi undefined"* — rule sai.
- `file_urls` path (`validateFileMetadata:95`): `expectedMime` falsy ⇒ **skip** ⇒ **ACCEPT**.

⇒ cung 1 policy, **2 ket qua khac nhau** tuy duong vao.

## 6. GIOI HAN / PHAT SINH

- **Khong sua file nao.** Khong implement. Khong chay test. Khong upload/download that, khong chay cleanup that.
- Khong doc **gia tri** secret/key/credential/setting — chi **ten field** + `file:line`.
- Khong doc `server.ts` (ke ca doc), `contracts`, `tasks/*.md`, `AGENTS.md`, overlay,
  `businesses/document-core/**`.
- **3 file doc ngoai danh sach** (`http-client.ts`, `runner.ts`, 2 route `workflows`) — deu **khong nam trong danh
  sach CAM**; ly do ghi o §0. Khong dung de sua gi.
- Khong tick gate, khong commit, khong nhac `nocobase-10`.
- **Khong quyet dinh** 9 muc tren la bug hay tinh nang — chi ghi nhan trung thuc + nhan MUST-NOT-REPLICATE.
  Verdict thuoc COMP-00.
- Acceptance #5: **khong can chay lenh doc hieu** ⇒ khong co literal lenh nao de ghi.

**Tom tat 1 dong:** 3/4/5 PASS tren ha tang that; 2/4/5 co MISMATCH; **2 MUST-NOT-REPLICATE
(`fileUrlFieldName` SSRF bypass, cross-tenant idempotency)** + 1 comment overclaim (DNS-rebinding).
