# WTV-08 — Gap-check các row RFX không marker (READ-ONLY)

**Packet:** wtv08-rfx-gapcheck · **Lane:** cc_1 · **Date:** 2026-10-03 · **Dispatch:** 2026-10-03T13:20+07:00 (coordinator command-code).
**Status:** read-only; **không chạy test**, không sửa source/plan, không tick gate (tất cả gate giữ **NO-GO**), không commit, không chạm `nocobase-10`. File duy nhất được ghi: receipt này.
**Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` (WTV-08) + `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` (RFX-04/06/07/09/10/11/12/13/14). Đối chiếu = đọc source hiện tại + `git diff b088eec -- <file>`; method tĩnh, không suy diễn behavior ngoài code.

## 0. Marker status thực tế trong worktree hiện tại (đính chính inventory)

WTV inventory (`tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md:26-27`) ghi "không thấy marker RFX-04/06/07/09/10/11/12/13/14". Kiểm lại cây hiện tại **sau** các đợt CONV-01..03 (code đã dời file):

| row | marker string trong code hiện tại | vị trí |
|---|---|---|
| RFX-07 | **CÓ** (comment trong hàm sửa) | `multipart-service.ts:455` ("RFX-07 finding — why the session lock did not save this") |
| RFX-10 | **CÓ** | `app/bootstrap/create-app.ts:155`, `:227` |
| RFX-11 | **CÓ** | `http/routes/runtime.ts:106`, `:131`, `:161` |
| RFX-12 | **CÓ** | `http/routes/runtime.ts:349` |
| RFX-04 / 06 / 09 / 13 / 14 | **KHÔNG có marker string** | fix nằm trong code + test nhưng không gắn nhãn RFX |

⇒ Inventory stale cho 07/10/11/12 (marker nằm ở file đã dời sau CONV, có thể grep trượt ở snapshot trước); 04/06/09/13/14 đúng là không marker. Ghi chú cho WTV-01: RFX-10/11/12 giờ nằm trong `app/bootstrap/create-app.ts` + `http/routes/runtime.ts` (do CONV-02/03 di chuyển) — phải re-verify chúng không mất trong refactor (đúng như WTV-01 tự yêu cầu ở `WORKTREE-VERIFY-COMMIT-2026-10-03.md:34`).

## 1. Kết quả gap-check

| row | verdict | bằng chứng (file:line, ngắn) | còn thiếu / note | owner (theo RFX plan) |
|---|---|---|---|---|
| **RFX-04** (originalToken) | **`done-in-worktree`** — hướng (b) "xóa khái niệm originalToken" (spec cho phép: hoặc giữ token gốc thật, hoặc xóa nếu chứng minh vô nghĩa — `ORCH-REVIEW-FIXES-2026-10-02.md:49`) | `upload-encryption-gateway.ts`: không còn symbol `originalToken` (grep 0); select chỉ còn `token AS "claimToken"` (:349); claim trả `{claimToken}` (:385); release CAS theo claim hiện tại (:389-394); commit CAS `token=$3=claimToken` (:715-724). `git diff b088eec` **xóa toàn bộ** dòng `originalToken` (type + 2 query + 2 bind). Token gốc (bearer) vẫn sống riêng ở cột `upload_token` (:347, :385) và được test khẳng định không đổi qua takeover (`public-upload-encryption-gateway.test.ts:789,799,851`) | Không có marker; **live S3 consumer-evidence + xác nhận hướng (b) là chủ ý** thuộc WTV-04/owner (static không thấy decision record) | upload gateway owner |
| **RFX-06** (claim mutex 1h) | **`còn mở (một phần)`** — cơ chế đã có + test, nhưng đúng đoạn availability mà spec phàn nàn vẫn nguyên ở production: crash → retry bị 409 tới **1h** | Cơ chế: `claimTtlMs` configurable (:325; validate :336-338), takeover sau grace + claim-token CAS fencing (:363-366, :380-384); doc comment grace/CAS (:117-121). Test: takeover sau grace + fence stale uploader (`public-upload-encryption-gateway.test.ts:747-835`), retry sau lost release (:837-863). **Thiếu:** production default vẫn `DEFAULT_CLAIM_TTL_MS = 60*60*1000` (:39) và **không composition nào truyền `claimTtlMs`** (grep `claimTtlMs` toàn `src/` = chỉ 5 hit trong chính module); không heartbeat/renew; acceptance "ghi rõ TTL mới vào docstring/config" chưa có giá trị mới để ghi | Cần owner **chốt + wire** TTL ngắn hơn (hoặc heartbeat), hoặc chứng minh 1h là chấp nhận được; static **không kết luận được** đây là quyết định có chủ hay bỏ sót | upload gateway owner |
| **RFX-07** (grantPart overwrite) | **`done-in-worktree`** | `multipart-service.ts:446-492`: `ON CONFLICT … DO NOTHING` + read-back + khác hash → `409 PART_CONFLICT` (:471, :487-492); cả 2 nhánh dùng chung `insertPartDeclaration` — runtime (:863) và public (:1094); diff thêm `PART_CONFLICT`/`DO NOTHING`. Test: `multipart-service-offline.test.ts:226` (khác hash → conflict), `:233` (cùng hash → replay OK), `:252` | Marker có dạng comment :455; không thiếu mục nào thấy được từ tĩnh | artifact/storage owner (cùng RFX-03) |
| **RFX-09** (orphan S3 version) | **`done-in-worktree`** | `storage-migration.ts:220-234` `discardImportedVersion` (delete đúng `versionId`); :284-291 — xóa version khi integrity mismatch **và** khi CAS thua, surface `ORPHAN_VERSION_CLEANUP_FAILED` nếu xóa fail; `s3-storage-facade.ts:912-926` xóa version của chính mình khi verify fail, :931-944 `delete()` bắt buộc VersionId. Test: `storage-migration.test.ts:329-355` ("deletes the losing exact S3 version when concurrent imports race", còn đúng 1 version live), `:406` | Không marker; **live S3 versioned-bucket evidence thuộc WTV-04** (test ở đây là mock storage) | storage-migration owner |
| **RFX-10** (dev fallback seed) | **`self-authored — cần verify chéo`** (lane này viết trong packet RFX-SERVER; KHÔNG tự chấm PASS) | `app/bootstrap/create-app.ts:155` `shouldSeedDevFallback` + :227-248 khối seed được gate; test `tests/rfx10-seed-gate.test.ts` (unit matrix :135-154 + boot-scan :159+, mô phỏng đúng acceptance query `prefix='dev-fallback'`) | Cần verify chéo độc lập (gate behavior + CONV-03 không làm mất); evidence only, không phải PASS | boot/wiring |
| **RFX-11** (host-header grant URL) | **`self-authored — cần verify chéo`** | `http/routes/runtime.ts:106-167` (`allowHostDerivedGrantUrl`, `GrantUrlOptions`, `absoluteGrantUrl`, `requestGrantUrl`); re-export `server.ts:41`; test `tests/rfx11-12-route-hardening.test.ts:115-166` (Host `evil.example` + base cấu hình → base thắng; dev/zero-config giữ legacy; production không base → relative, không echo Host) | Cần verify chéo (đặc biệt sau CONV-02/03 đã dời code) | boot/wiring |
| **RFX-12** (heartbeat stub) | **`self-authored — cần verify chéo`** + **deviation cần chốt** | `http/routes/runtime.ts:348-368`: comment "STUB COMPAT SURFACE… must not report HEALTHY", trả `health: 'DEGRADED'` (:367). Test `rfx11-12-route-hardening.test.ts` (mục "must not report 'HEALTHY'"). **Deviation:** spec gợi ý `'UNKNOWN'`; chọn `'DEGRADED'` vì `HeartbeatAckSchema` enum = HEALTHY/DEGRADED/OFFLINE và worker SDK zod-parse — rationale ghi trong comment :353-355 và receipt `cc-rfx-server-2026-10-02.md` §4 | Cross-verify + **Product/coordinator xác nhận deviation**; ops-doc note (`/health` + queueIntegrity là monitoring thật) đã nằm trong comment, chưa có doc ngoài lease | boot/wiring |
| **RFX-13** (FOR UPDATE xuyên S3) | **`done-in-worktree`** | `storage-migration.ts`: grep `FOR UPDATE` = **0** trong file; snapshot đọc bằng SELECT thường (:157-168), S3 I/O trong `action`, CAS ngắn trong `db.tx` (:193-214) với đủ guard (`state='READY'`, `storage_backend='postgres'`, `storage_version_id IS NULL`, tenant/key/size/sha); comment thiết kế (:31, :115) | Acceptance đo **p99 lock-wait/statement_timeout** là evidence live → thuộc WTV-04; static chỉ chứng minh lock đã được gỡ khỏi đường S3 | storage-migration owner |
| **RFX-14** (withDeadline không cancel) | **`done-in-worktree`** | `integrity-scanner.ts`: signal xuyên ports (:36-38); pg query bounded + `SET LOCAL statement_timeout` + đóng client khi abort (:78-109); `withDeadline` → `controller.abort()` (:194-236); **single-flight** `activeSources` + `onSkippedTick` + warn "tick skipped: previous scan still running" (:285-295). Test: `artifact-integrity-scanner.test.ts:240` (destroy stream sau deadline), :266, :284 (abort slow read), :307 (cancel pg bytea query), :360-366 + :397 (overlap tick bị skip) | Không marker; không thiếu mục nào thấy được từ tĩnh | artifact owner |

## 2. Không kết luận từ tĩnh (nói thẳng)

- **RFX-06**: không thể kết luận từ static liệu `DEFAULT_CLAIM_TTL_MS = 1h` là **quyết định có chủ** (chấp nhận chờ TTL) hay **phần chưa làm** của spec "rút ngắn TTL". Bằng chứng chỉ có: cơ chế + test tồn tại; composition không override. Cần owner xác nhận + (nếu cần) wire giá trị mới → nếu owner xác nhận 1h là chủ ý, row chuyển `done-in-worktree` với ghi chú đó.
- **RFX-13**: acceptance yêu cầu **đo** lock-wait/statement_timeout khi blob lớn chạy song song — static không thay được; thuộc WTV-04 (live PG). Ở đây chỉ chứng minh **cơ chế** (không còn lock xuyên S3).
- **RFX-09 / RFX-04**: acceptance có phần **live S3 versioned-bucket / consumer-side**; static chỉ chứng minh cơ chế + mock test → WTV-04 (đúng phân công WTV, không phải gap mới).
- **RFX-12**: deviation `'DEGRADED'` vs spec `'UNKNOWN'` cần chốt; nếu coordinator muốn đúng chữ 'UNKNOWN' thì phải sửa cả `HeartbeatAckSchema` + worker SDK parse (ngoài phạm vi row) — nêu để không tự đóng row bằng suy đoán.
- **Không có row nào thuộc diện "không đủ dữ liệu để phân loại" hoàn toàn**: 5 row đủ bằng chứng tĩnh để kết luận cơ chế; 3 row self-authored chờ verify chéo; 1 row (RFX-06) kết luận `còn mở (một phần)` với đúng phần thiếu được chỉ đích danh.

## 3. Verdict

- **done-in-worktree (cơ chế + test tĩnh)**: RFX-04 (hướng xóa concept), RFX-07, RFX-09, RFX-13, RFX-14 — kèm các caveat live-evidence ở §2 thuộc WTV-04, không phải gap implementation.
- **còn mở (một phần)**: RFX-06 — thiếu quyết định + wire TTL production (hoặc heartbeat); owner upload gateway.
- **self-authored — cần verify chéo**: RFX-10, RFX-11, RFX-12 (lane cc_1 viết; không tự chấm PASS; RFX-12 kèm deviation cần chốt).
- Marker đính chính: 07/10/11/12 **có** marker trong cây hiện tại; 04/06/09/13/14 không có — inventory WTV stale một phần, không phải "không implemented".

**Không gate nào được tick. Không file nào ngoài receipt này được ghi (read-only; chỉ đọc source + `git diff`/`git status`).**
