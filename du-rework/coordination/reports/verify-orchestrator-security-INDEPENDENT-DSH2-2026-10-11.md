# Verify độc lập (DSH2) — Orchestrator security review SEC-01..SEC-04 — 2026-10-11

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `du-rework/orchestrator/**` và `compose/**` (chỉ đọc), cùng hai file review/evidence.
**Tuân thủ COORDINATOR-CONTRACT:** chỉ **đọc** + chạy probe offline; **KHÔNG** sửa mã/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** mạng ngoài (chỉ loopback cho probe crash); receipt **0 ký tự nháy kép** (tự đếm, §8).
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` = baseline của review · **Node** v24.21.0 (khớp runtime review).
**Đối tượng:** `coordination/reports/orchestrator-security-review-2026-10-11.md` (203 dòng, sha256 `a3a19bf53f1bcf789544aea9970fb7aa56ea8cd418e0c0bb4b63d3470c4c2370`) và `.evidence.json` (90 dòng, sha256 `c3c74b16a53d50fb3d15e44745bd2cf839d1b30e9ece8444887aea7c7d937ed6`).
**Raw:** `coordination/reports/raw/verify-orchestrator-security-2026-10-11/DSH2/` — `01-sec01-03-probe.log`, `02-sec04-stdout.log`, `03-sec04-stderr.log`, `04-probe.cjs`, `05-crash-204.cjs`, `SHA256SUMS.txt`.

---

## 0. Kết luận ngắn

| Finding | Verdict độc lập | Bằng chứng chính |
|---|---|---|
| **SEC-01** Admin legacy dùng quyền platform cho session operator/viewer | **XÁC NHẬN** | 4 check probe: claims chỉ còn `iss/role/iat/exp`; section legacy nhận `adminToken=platform-admin-token` + filter tenant do caller gửi; BFF có `credentialForTenant` còn legacy thì không |
| **SEC-02** Mặc định `warn` vẫn gửi credential tới origin ngoài allowlist | **XÁC NHẬN** | 3 check: mặc định code + Compose đều `warn`; ở `warn` credential **được gắn** vào `https://unapproved.example`; ở `enforce` ném `ORIGIN_NOT_ALLOWLISTED` với **0** lần gọi fetcher; allowlist rỗng ở `warn` vẫn gắn (header) |
| **SEC-03** Bootstrap source ingestion bỏ qua writer mã hoá | **XÁC NHẬN** | 2 check: `PutObject.Body` **byte-equal plaintext** (52 B, không marker mã hoá); bootstrap dùng `createS3PinnedSourceStorage`, **không** tham chiếu writer mã hoá và **không** truyền `requireEncryptedSourceWrites`; policy real-data đòi mã hoá |
| **SEC-04** HTTP 204 từ upstream làm tiến trình Node thoát | **XÁC NHẬN + TÁI HIỆN** | Tiến trình riêng, loopback 204: **exit code 1**, stderr `TypeError: Response constructor: Invalid response status code 204` ném từ callback `ClientRequest`; **không** có dòng `CALLER_CAUGHT` và **không** có `PROCESS_SURVIVED` ⇒ `try/catch` quanh `await` **không** bắt được |
| **Tính toàn vẹn evidence** | **ĐẠT** | **10/10** sha256 trong `source_hashes_at_review_closeout` **khớp** cây làm việc hiện tại; HEAD = baseline ⇒ review đúng revision, không drift |
| Probe độc lập của tôi | **9/9** (SEC-01..03) + crash probe tái hiện SEC-04 | tự viết harness, input tổng hợp, không dùng lại script của reviewer |

**Một dòng cho coordinator:** cả **4 finding SEC-01..SEC-04 đều đứng vững** khi kiểm độc lập; SEC-04 **tái hiện được** (process exit 1, caller catch không chạy) và không có handler `uncaughtException`/`unhandledRejection` nào trong source production; evidence JSON khớp **10/10** hash.

---

## 1. Toàn vẹn bằng chứng (kiểm trước mọi kết luận)

| # | Kiểm | Kết quả |
|---|---|---|
| 1 | 10 file trong `source_hashes_at_review_closeout` so với cây hiện tại | **MATCH 10/10**, 0 lệch/0 thiếu |
| 2 | HEAD so với `baseline_head` | **trùng** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` |
| 3 | `product_files_edited_by_reviewer` | `[]` — và tôi xác nhận 5 file nguồn liên quan vẫn ở trạng thái sạch hoặc ` M` **từ trước** review (mtime ≤ 22:33), không file nào bị sửa bởi lượt verify này |

⇒ Mọi kết luận dưới đây áp cho **đúng revision** mà review đã đọc.

---

## 2. SEC-01 — Admin legacy dùng quyền platform

**Đối chiếu source (khớp từng dòng review nêu):**
- `auth-dispatch.ts:290-299`: session sống → claims chỉ `{iss, role, iat, exp}`; dòng `role: rec.role` ở `:295` — **không** mang tenant/identity.
- `section-dispatch.ts:410-428` (`resolveOperationExtras`): input fetcher có `adminToken: config.adminToken` (`:421`) + `tenantFilter: list.tenantFilter` lấy từ query; tham số `_role` **không được dùng**.
- `section-dispatch.ts:474-481` (`resolveOverviewExtras`): `tenantId` từ query + `adminToken: config.adminToken` (`:480`). Toàn file có **8** chỗ `adminToken: config.adminToken`.
- `public.ts:468-475`: nhánh admin-bearer → `authorizeAuditTenantRead(listPrincipal, query.tenantId)`; platform principal được phép chọn **bất kỳ** tenant và khi không có `?tenant=` thì `scope === ''` → `listOperationsPage(..., null, ...)` = **không fence tenant**.
- `shell-server.ts` vẫn mount `/admin/legacy/*`.

**Probe độc lập (4 check, tự viết harness):**

| Check | Kết quả đo |
|---|---|
| SEC-01a | `resolveOpaqueSession` với store giả trả session `{role: operator, tenantId: tenant-a}` → `state=live`, `claims` keys = `exp, iat, iss, role` (**không** có tenantId) |
| SEC-01b | `resolveOperationExtras(request có ?tenant=tenant-b, config.adminToken=platform-admin-token, role=operator)` → fetcher nhận `adminToken=platform-admin-token`, `tenantFilter=tenant-b` |
| SEC-01c | `resolveOverviewExtras(?tenantId=tenant-b, role=viewer)` → fetcher nhận `adminToken=platform-admin-token`, `tenantId=tenant-b` |
| SEC-01d | BFF có `credentialFor(principal, runtime)` + `credentialForTenant`; `section-dispatch.ts` **không** tham chiếu `rbacPrincipal`/`authorizeAuditTenantRead`/`credentialForTenant` |

**Giới hạn của probe (trung thực):** fetcher trong probe là dependency giả để **quan sát token/filter** — nó chứng minh shell trao platform token + filter do caller chọn, đúng như review mô tả; phần API thật bỏ fence cho platform được xác nhận bằng **đọc source** (`public.ts:468-475`), không bằng truy vấn dữ liệu tenant thật.

---

## 3. SEC-02 — Mặc định warn vẫn gửi credential

**Đối chiếu source:**
- `ingestion-consumer.ts:176-183`: `sourceCredentialOriginModeFromEnv` → unset/`''` ⇒ **`warn`**; chỉ nhận `warn|enforce`, giá trị khác ném lỗi.
- `acquisition-ref-resolver.ts:181-201`: tính `code` (`ORIGIN_POLICY_MISSING` khi list rỗng, `ORIGIN_NOT_ALLOWLISTED` khi origin không khớp) rồi **chỉ** ném khi `mode === 'enforce'`; `warn` trả warning.
- `acquisition-ref-resolver.ts:347-360` (`withSourceAuth`): gọi `assertCredentialOriginAllowed` cho origin đầu, sau đó **vẫn** `headers.set('authorization', Bearer …)` / header credential.
- `compose/orchestrator.yml:63`: `DU_SOURCE_CREDENTIAL_ORIGIN_MODE: ${DU_SOURCE_CREDENTIAL_ORIGIN_MODE:-warn}`.

**Probe độc lập (3 check):**

| Check | Kết quả đo |
|---|---|
| SEC-02a | Hàm thật (trích + transpile): `{}` → `warn`; `''` → `warn`; `enforce` → `enforce`; `off` → ném; Compose mặc định `warn` |
| SEC-02b | Credential `bearer` + allowlist `[https://approved.example]`: `warn` + gọi `https://unapproved.example/document.pdf` → fetcher nhận `authorization: Bearer synthetic-source-secret` (**1** call); `enforce` cùng input → ném `ORIGIN_NOT_ALLOWLISTED`, fetcher **0** call; origin đã duyệt vẫn nhận credential |
| SEC-02c | Allowlist **rỗng** + credential `header`: `warn` vẫn gắn header vào `https://anywhere.example`; `enforce` ném `ORIGIN_POLICY_MISSING` |

⇒ Đúng như review: allowlist không ngăn gửi credential trong cấu hình mặc định, kể cả khi policy thiếu.

---

## 4. SEC-03 — Bootstrap bỏ qua writer mã hoá

**Đối chiếu source:**
- `create-app.ts:652-661`: composition dùng `createS3PinnedSourceStorage({bucket, send, db})` (writer plaintext).
- `ingestion-consumer.ts:634-650`: chỉ bọc `createEncryptedSourceStorageWrapper` khi `options.requireEncryptedSourceWrites` truthy.
- `ingestion-storage-s3.ts:697-736`: `putVerified` yield **nguyên chunk** vào `PutObjectCommand.Body` (`:722`, `:734`) — chỉ hash/đếm, không mã hoá.
- `ingestion-storage-s3.ts:391`: `createS3EncryptedPinnedSourceStorage` **tồn tại** nhưng chỉ được tham chiếu trong `tests/sec-enc-03-source-s3-encryption.test.ts` (grep toàn orchestrator), **không** trong bootstrap.
- `boot-options.ts:39-46`: `DU_DATA_MODE` mặc định `real` và real-data **đòi** mã hoá persistence PG/S3 cho **mọi producer**.

**Probe độc lập (2 check):**

| Check | Kết quả đo |
|---|---|
| SEC-03a | Writer plaintext thật + `send` giả đọc `PutObject.Body`: bytes ghi ra **byte-equal** với plaintext tổng hợp (52 B), `Bucket=probe-bucket`, receipt `sizeBytes=52`, body **không** chứa marker `du-encrypted`/`crypto-manifest`/`manifest_version` |
| SEC-03b | Tĩnh: bootstrap có `createS3PinnedSourceStorage(`, **không** có `createS3EncryptedPinnedSourceStorage`/`createEncryptedSourceStorageWrapper`, **không** có `requireEncryptedSourceWrites`; consumer vẫn gate theo flag đó; factory mã hoá tồn tại; policy real-data đòi mã hoá |

⇒ Đúng như review: đường bootstrap ghi source object **plaintext ở tầng ứng dụng** dù policy real-data yêu cầu mã hoá.

---

## 5. SEC-04 — HTTP 204 làm tiến trình thoát (tái hiện độc lập)

**Đối chiếu source:** `pinned-fetch.ts:351-361`: `fulfillResponse` luôn `Readable.toWeb(decoded)` rồi `new Response(web, { status, … })` — **không** xử lý null-body status và **không** try/catch; hàm được gọi trong callback `ClientRequest` (`:344-348`). Review nêu `:355` — khớp **chính xác** dòng `new Response(web, {` (tôi grep lại: `pinned-fetch.ts:355`).

**Probe crash (tiến trình riêng, chỉ loopback):**
- Upstream loopback trả **204**; client `createPinnedFetch({allowHosts:{127.0.0.1}, allowPrivateNetworks:true})`; caller có `try/catch` quanh `await`.
- **Kết quả đo:** `EXIT_CODE=1`; stdout chỉ có dòng probe JSON, **không** có `CALLER_CAUGHT…`, **không** có `PROCESS_SURVIVED`; stderr: `TypeError: Response constructor: Invalid response status code 204` với stack `at new Response (undici)` ← `at fulfillResponse (pinned-fetch.ts:313:25)` ← `at ClientRequest.<anonymous> (pinned-fetch.ts:308:17)`.
- Số dòng trong stack là của **bản transpile trong bộ nhớ** (transpileModule nén dòng); vị trí **source** đúng là `:351/:355` như review ghi.
- **Handler toàn cục:** grep `uncaughtException|unhandledRejection|process.on(` trong `services/orchestrator/src`, `packages/egress/src`, `packages/worker-sdk/src` → **không** có handler nào (chỉ `shutdown.ts:85` đăng ký signal) ⇒ trong production cũng không có lưới hứng.
- **Reachability (tĩnh, khớp review):** `webhooks.ts:533` `createPinnedFetch({…})` (transport webhook mặc định) và `packages/worker-sdk/src/source-acquisition.ts:201` `options.fetcher ?? createPinnedFetch()`.

⇒ SEC-04 **đúng và tái hiện được**: một response 204 bình thường giết tiến trình; `try/catch` của caller không cứu được.

---

## 6. Phạm vi và giới hạn của lượt verify

1. **Offline hoàn toàn:** mọi probe chạy trên source TS hiện tại (transpile trong bộ nhớ) + loopback tạm cho SEC-04; **không** gọi mạng ngoài, **không** dùng tenant/secret/dữ liệu thật, **không** chạm PostgreSQL/Redis/S3/Vault.
2. **Không phải pentest deployment:** không xác minh image đang chạy, NetworkPolicy, ingress, Vault policy hay bucket policy — đúng như review tự giới hạn. Kết luận chỉ áp cho **working tree** đã pin hash.
3. **SEC-01 dùng fetcher giả** để quan sát token/filter (giống reviewer); mắt xích API bỏ fence cho platform là **đọc source** (`public.ts:468-475`), không phải truy vấn dữ liệu thật.
4. **SEC-03 chưa chạy ingest end-to-end** qua S3/Vault thật; probe chứng minh **bytes ghi ra = plaintext** ở writer mà bootstrap dùng, cộng bằng chứng tĩnh về wiring.
5. **Không đánh giá mức độ/khả năng khai thác trong môi trường thật**, không gán CVSS — nhất quán với review.
6. **Ghi chú trung thực về probe của tôi:** lượt chạy đầu có **3 FAIL đều do lỗi probe của tôi** — (a) đánh giá khai báo TS có type annotation bằng `new Function` (thiếu transpile), (b) chuỗi fixture tự chứa chữ `envelope` làm regex marker của tôi khớp, (c) regex policy của `boot-options.ts` không tính dòng xuống. Đã sửa **probe** (không đụng sản phẩm) rồi chạy lại: **9/9** + crash probe tái hiện.

---

## 7. Đề xuất cho coordinator (không tự quyết)

1. SEC-04 là **ưu tiên 1** đúng như review: sửa null-body status + bọc callback thành rejection; verify sau sửa bằng chính probe này (204/205/304/HEAD không làm chết tiến trình).
2. SEC-02 có thể **giảm rủi ro ngay** bằng `DU_SOURCE_CREDENTIAL_ORIGIN_MODE=enforce` sau khi khai đủ approved origins — nhưng đây là quyết định vận hành, cần owner deployment.
3. SEC-01/SEC-03 cần owner sửa theo hướng review đề xuất; sau sửa nên chạy lại **đúng 4 probe** này (tôi đã để lại script trong raw) để so kết quả trước/sau.
4. Nên ghi rõ trong acceptance rằng các kết luận này **chưa** được xác minh trên image/deployment thật.

---

## 8. Xác nhận

- Chỉ **đọc** + chạy probe offline; **không** sửa mã sản phẩm/test/config/docs; **không** `git add`/commit/push; **không** tick gate; không DB/Redis/S3/Vault, không mạng ngoài (SEC-04 chỉ loopback tạm, đóng trong tiến trình).
- File tôi tạo: receipt này + 5 file raw trong `coordination/reports/raw/verify-orchestrator-security-2026-10-11/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`.
- Tự kiểm theo COORDINATOR-CONTRACT: **0 ký tự nháy kép** (đếm bằng mã hoá ký tự), **0 dòng trailing whitespace**; không hành động ghi nào ngoài `coordination/reports/**`.
