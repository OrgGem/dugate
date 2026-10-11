# INVESTIGATE — RED chưa đóng của `tests/artifact-read-authorization.test.ts` — 2026-10-09

- **Vai trò:** investigator. **Đi nguyên nhân, CHƯA sửa gì.** Chỉ đọc + chạy test.
- **KHÔNG** edit source/test/config/docs, **KHÔNG** commit/`git add`/push, **KHÔNG tick gate nào**,
  **KHÔNG** đọc `.env.live`. **Offline**: không PostgreSQL, không Redis, **không claim DB window**. Scope `du-rework`.
- **CWD mọi lệnh:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`. CWD session: `D:/Git/dugate`.
- **Raw logs:** `du-rework/coordination/reports/raw/investigate-artifact-read-auth-2026-10-09/`
  (`01-RED.txt`, `01-RED-full.txt`, `02-expected-received.txt`).

---

## BƯỚC 1 — FAIL-FIRST: đo trước khi kết luận

```
node -v = v24.21.0
node path = C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe
ambient NODE_ENV = [production]

& $n24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts
```

| # | Lệnh | **REAL_EXIT** (`$LASTEXITCODE`, ngay sau lệnh, không pipe) | Literal |
|---|---|---:|---|
| 1 | như trên | **1** | `Test Suites: 1 failed, 1 total` · `Tests: 5 failed, 85 passed, 90 total` · `Snapshots: 0 total` · `Time: 1.918 s` |

**RED CÒN NGUYÊN — 5 case đỏ, khớp đúng mô tả trong brief.** (Nếu RED đã hết thì mục này sẽ ghi "KHÔNG CÒN";
ở đây không phải vậy.) Tên 5 test đỏ:
```
● R1-A artifact read authorization and storage-facade boundary › does not grant reads for STAGING artifacts, even in the same operation
● R1-A artifact read authorization and storage-facade boundary › rejects expired and fenced requesters before minting a read grant
● CR28-03 artifact read authorization: negatives and boundaries › declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact
● CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong
● CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one
```

### Expected / Received **nguyên văn** từng case

**CASE 1 — `tests/artifact-read-authorization.test.ts:375`**
```
    - Expected  - 1
    + Received  + 1

      Object {
    -   "code": "STATE_CONFLICT",
    +   "code": "PERMISSION_DENIED",
      }

    ASSERTION: > 375 |     await expect(service.requestAccess(STAGING_OUTPUT, readRequest())).rejects.toMatchObject({
    at Object.<anonymous> (tests/artifact-read-authorization.test.ts:375:80)
```

**CASE 2 — `:386`**
```
    - Expected  - 2
    + Received  + 2

      Object {
    -   "code": "PERMISSION_DENIED",
    -   "status": 403,
    +   "code": "LEASE_LOST",
    +   "status": 409,
      }

    ASSERTION: > 386 |     ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    at Object.<anonymous> (tests/artifact-read-authorization.test.ts:386:15)
```

**CASE 3 — `:597`**
```
    - Expected  - 1
    + Received  + 1

      Object {
    -   "code": "STATE_CONFLICT",
    +   "code": "PERMISSION_DENIED",
      }

    ASSERTION: > 597 |       ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    at Object.<anonymous> (tests/artifact-read-authorization.test.ts:597:17)
```

**CASE 4 — `:732`**
```
    - Expected  - 2
    + Received  + 2

      Object {
    -   "code": "PERMISSION_DENIED",
    -   "status": 403,
    +   "code": "LEASE_LOST",
    +   "status": 409,
      }

    ASSERTION: > 732 |     ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    at Object.<anonymous> (tests/artifact-read-authorization.test.ts:732:15)
```

**CASE 5 — `:742`**
```
    - Expected  - 2
    + Received  + 2

      Object {
    -   "code": "PERMISSION_DENIED",
    -   "status": 403,
    +   "code": "LEASE_LOST",
    +   "status": 409,
      }

    ASSERTION: > 742 |     ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    at Object.<anonymous> (tests/artifact-read-authorization.test.ts:742:15)
```

**Đính chính một chi tiết của brief (có bằng chứng):** case 1 và 3 nhận `code: "PERMISSION_DENIED"` — nhưng
**KHÔNG phải 403**. Cả hai đường đó ném qua `conflict(...)`, mà `src/http/errors.ts:55-56` là
`new HttpError(409, code, msg, extra)` ⇒ **status là 409**, chỉ *chuỗi code* là `PERMISSION_DENIED`. Đây chính là
cái làm kỳ vọng `{status: 403, code: 'PERMISSION_DENIED'}` trông hợp lý nhưng sai cho các đường này: trong
codebase, `PERMISSION_DENIED` tồn tại ở **hai** status (403 qua `forbidden()` `:53`, 409 qua `conflict()`).

---

## BƯỚC 2 — CODE THẬT: `src/modules/artifacts/artifacts.ts` dòng 690-760

```ts
690:                   (t.lease_expires_at IS NOT NULL AND t.lease_expires_at > now()) AS lease_active
691:            FROM tasks t JOIN operations o ON o.id = t.operation_id
692:            WHERE t.id=$1 FOR UPDATE OF t`,
695:         if (!taskRes.rowCount) throw notFound(`task ${req.taskId} not found`);
704:         if (task.lease_epoch !== req.leaseEpoch) {
705:           throw conflict('LEASE_LOST', 'requester lease epoch is stale');
706:         }
707:         if (!task.lease_active) throw conflict('LEASE_LOST', 'requester lease has expired');
708:         if (task.state !== 'RUNNING') {
709:           throw conflict('STATE_CONFLICT', 'requester task is not RUNNING');
710:         }
721:         if (!artifactRes.rowCount) throw notFound(`artifact ${artifactId} not found`);
736:         if (art.state === 'DELETED') throw conflict('STATE_CONFLICT', 'artifact deleted');
738:         const sameTenant = art.tenantId === task.tenantId;
739:         const sameOperation = sameTenant && art.operationId === task.operationId;
746:           const declaredReference =
747:             sameTenant &&
748:             isPublicArtifactPurpose(art.purpose) &&
749:             hasDeclaredArtifactReference(task.submitArtifacts, artifactId);
750:           if (!sameOperation && !declaredReference) {
751:             throw conflict('PERMISSION_DENIED', 'task is not authorized to read artifact');
752:           }
753:           if (art.taskId !== req.taskId && art.state !== 'READY') {
754:             throw conflict('PERMISSION_DENIED', 'foreign task cannot access unready artifact');
755:           }
756:           if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY');
```

**Điều kiện → mã lỗi, và THỨ TỰ kiểm tra (tất cả đều 409 vì `conflict()`):**

| Thứ tự | Dòng | Điều kiện | Ném ra | Status |
|---:|---|---|---|---|
| 1 | `:695` | task row không tồn tại | `NOT_FOUND` | 404 |
| 2 | `:704-706` | `lease_epoch !== req.leaseEpoch` | `LEASE_LOST` | **409** |
| 3 | **`:707`** | `!task.lease_active` (hết hạn **hoặc** chưa từng có expiry) | `LEASE_LOST` | **409** |
| 4 | `:708-710` | `task.state !== 'RUNNING'` | `STATE_CONFLICT` | 409 |
| 5 | `:721` | artifact row không tồn tại | `NOT_FOUND` | 404 |
| 6 | `:736` | `art.state === 'DELETED'` | `STATE_CONFLICT` | 409 |
| 7 | `:750-752` | read + `!sameOperation` + `!declaredReference` | `PERMISSION_DENIED` | 409 |
| 8 | **`:753-755`** | read + `art.taskId !== req.taskId` + `art.state !== 'READY'` | `PERMISSION_DENIED` | 409 |
| 9 | `:756` | read + `art.state !== 'READY'` | `STATE_CONFLICT` | 409 |

**Hai điểm mấu chốt:**
- **`:707` chạy TRƯỚC `:708`** ⇒ khi lease vừa hết hạn vừa sai state, kết quả là **LEASE_LOST (409)** — đúng
  *thứ tự* mà case 4 muốn ("prefers expiry over task state"), nhưng **sai mã/status** (test đòi 403 PERMISSION_DENIED).
- **`:753-755` chạy TRƯỚC `:756`** ⇒ artifact do task khác tạo và đang `STAGING` trả **PERMISSION_DENIED (409)**,
  không bao giờ tới được nhánh `STATE_CONFLICT` ở `:756`. Đây là gốc của case 1 và 3.

**Đường anh em cùng semantics (quan trọng cho BƯỚC 5):** `assertLease` (`artifacts.ts:327-348`) — dùng bởi
`requestUpload`/finalize — có cùng quy ước:
```ts
341:     if (row.lease_epoch !== leaseEpoch) {
342:       throw conflict('LEASE_LOST', `stale leaseEpoch ${leaseEpoch}, current ${row.lease_epoch}`);
344:     if (!row.lease_active) {
345:       throw conflict('LEASE_LOST', `lease has expired for task ${taskId}`);
```
⇒ lease hết hạn ở đường upload cũng là **409 LEASE_LOST**, không phải 403.

---

## BƯỚC 3 — TÀI LIỆU nói gì

**`docs/28-test-inventory.md:1323`** (mục W-PLAT-CR28-**02**-ARTIFACT-GRANT-FENCING-NEGATIVE) — nguyên văn phần lease:
> "**expired task lease** (lease chết ⇒ grant upload mới bị từ chối **409 `LEASE_LOST`**; grant cấp khi lease còn
> sống **rồi** lease chết ⇒ read grant 409)"

**`docs/28-test-inventory.md:1399`** (mục W-PLAT-CR28-**03**-ARTIFACT-READ-AUTH-NEGATIVE) — nguyên văn:
> "**Ordering matters and is asserted**: cross-operation plus declared plus `STAGING` returns **409
> `STATE_CONFLICT`**, not `PERMISSION_DENIED`. For leases, a wrong epoch plus an expired lease yields
> `LEASE_LOST`, whereas **expiry plus a wrong state yields 403**, and a live lease with the correct epoch still grants."

**`docs/07-internal-api.md:44-53`** — bảng endpoint (`/tasks/{id}/…`, `/artifacts/{id}/multipart/…`):
- `:49` multipart init → "**409** LEASE_LOST/IDEMPOTENCY_CONFLICT/MULTIPART_NOT_AVAILABLE/MULTIPART_EXPIRED; 413"
- `:51` multipart complete → "**409** PART_SET_MISMATCH/CHECKSUM_MISMATCH/**LEASE_LOST**"
- `:52` abort → "200 ABORTED idempotent; **409** STATE_CONFLICT"
- **Không có dòng nào cho route cấp quyền ĐỌC** (`requestAccess`) ⇒ spec API **im lặng** về route này.
  Mọi chỗ nó nhắc `LEASE_LOST` đều gắn **409**, và **không** có chỗ nào nói 403 cho lease.

**Tóm tắt ba nhóm case:**

| Nhóm | Test đòi (theo 1399) | Code làm (artifacts.ts) | Tài liệu nào ủng hộ code |
|---|---|---|---|
| **I. STAGING do task khác tạo** (case 1 `:375`, case 3 `:597`) | `STATE_CONFLICT` | **`PERMISSION_DENIED` (409)** tại `:753-755` | **Không có dòng nào** — chỉ 1399 nói STATE_CONFLICT; 07 im lặng |
| **II. Lease hết hạn** (case 2 `:386`, case 4 `:732`, case 5 `:742`) | `403 PERMISSION_DENIED` | **`LEASE_LOST` (409)** tại `:707` | **28:1323** ("409 LEASE_LOST", kể cả read grant), 07:49/51 (LEASE_LOST=409), `assertLease:345` cùng quy ước |

---

## BƯỚC 4 — TÀI LIỆU NHAU: mâu thuẫn **nội tại** trong cùng một file

`docs/28-test-inventory.md` **tự mâu thuẫn**, hai dòng cách nhau 76 dòng, **cùng nói về lease hết hạn trên đường
artifact**:

| Dòng | Nói | Khớp code? |
|---|---|---|
| **1323** | lease chết ⇒ **409 `LEASE_LOST`**; "grant cấp khi lease còn sống rồi lease chết ⇒ **read grant 409**" | **CÓ** |
| **1399** | "expiry plus a wrong state yields **403**" | **KHÔNG** (code: 409 `LEASE_LOST`) |

⇒ **Mâu thuẫn nội tại dạng A-vs-A** (cùng file, cùng chủ đề, hai kết luận khác nhau). Không phải mâu thuẫn
docs-vs-code đơn thuần: **một trong hai dòng docs đã sai ngay từ đầu**, và dòng 1399 là dòng lệch khỏi **cả**
1323, **cả** 07, **cả** `assertLease`.

**Test assertion bám vào dòng nào?** Cả 5 case bám **dòng 1399**:
- case 2/4/5 (`403 PERMISSION_DENIED`) ← mệnh đề "expiry plus a wrong state yields 403" của 1399;
- case 1/3 (`STATE_CONFLICT`) ← mệnh đề "cross-operation plus declared plus `STAGING` returns 409 `STATE_CONFLICT`,
  not `PERMISSION_DENIED`" của 1399.
Không case nào bám 1323. Nói cách khác: **5 test đỏ này là bản sao của một dòng inventory đã lệch chuẩn**, không
phải của hành vi sản phẩm.

**Bằng chứng bổ sung (blast radius) — `LEASE_LOST` được pin ở 409 bởi rất nhiều suite:**
`artifact-grant-fencing.test.ts:745-773` pin đúng ca tương ứng — *"an expired task lease refuses a NEW **read
grant** (**409 LEASE_LOST**)"* (suite này **live-gated**, `jest.unit.config.cjs:14`, nên không chạy offline);
`mm10-heartbeat-cancel-offline:203-208` (`{status: 409, code:'LEASE_LOST'}`), `multipart-service-offline:144,409,475`,
`multipart-routes-offline:201-202`, `runtime-lease-fencing-offline:474,511,587,620`, `rcr-luna-verification:201,223,249`,
`grant-artifact-pins:230,237`, `artifacts-fencing:256,274`, `artifact-storage-service:324` — tất cả **409**.

---

## BƯỚC 5 — ĐỀ XUẤT PHƯƠNG ÁN (không sửa gì)

### Phương án A — sửa CODE cho khớp `docs/28:1399`
Cần đổi:
1. **Nhóm II** — `src/modules/artifacts/artifacts.ts:707`: đổi `conflict('LEASE_LOST', 'requester lease has expired')`
   thành một lỗi **403** (ví dụ `forbidden(...)` với code `PERMISSION_DENIED`). Kèm theo phải xét `:704-706`
   (epoch) có đổi cùng không, và **`assertLease:344-345`** (đường upload) để không tạo hai quy ước trong cùng file.
2. **Nhóm I** — dời/đổi `:753-755` để `:756` (`STATE_CONFLICT`) thắng: tức artifact `STAGING` của task khác phải
   trả `STATE_CONFLICT`.

**Hệ quả phụ (blast radius) — đây là lý do tôi khuyến nghị KHÔNG chọn A:**
- **Vỡ hợp đồng nền tảng "lease hết hạn/stale ⇒ 409 `LEASE_LOST`"** đang được pin bởi **≥9 suite** (danh sách ở
  BƯỚC 4) và bởi **≥7 tài liệu** (`04-data-state.md:57`, `06b-api-spec-overview.md:170,215`, `07-internal-api.md:49,51,81`,
  `17-operational-runbooks.md:146,765`, `18-release-readiness-report.md:66,141`, `28:1323`, `00-business-analysis.md:64`).
- **Mâu thuẫn nội bộ mới trong cùng file**: `requestUpload` (qua `assertLease`) vẫn 409 LEASE_LOST trong khi
  `requestAccess` thành 403 ⇒ cùng một lease hết hạn, hai mã khác nhau tuỳ endpoint.
- **Đụng pin đã có**: `artifact-grant-fencing.test.ts:745` (read grant + expired lease ⇒ 409) sẽ mâu thuẫn trực tiếp.
- **Hệ quả dây chuyền**: báo cáo/audit (`docs/19`, `docs/35`), runbook vận hành (dạy operator đọc 409 LEASE_LOST là
  fence bình thường — `runbooks/bullmq-queue.md:31`, `runbooks/outbox-retry-fencing.md:54`), client/SDK phân loại
  lỗi retry-vs-terminal, và CLI/ops tooling nếu có nhánh theo mã lỗi.
- Nhóm I: đổi thứ tự fence làm **mất thông tin chẩn đoán** ("foreign task cannot access unready artifact") và có
  khía cạnh rò rỉ: `STATE_CONFLICT` chung chung hơn, nhưng cũng có thể được đọc là "artifact tồn tại" — cần owner
  quyết theo hướng nào mới là fail-closed đúng ý.

### Phương án B — sửa TEST cho khớp code hiện tại
Cần đổi **5 assertion**:
| Case | Dòng | Đổi thành |
|---|---|---|
| 1 | `:375-377` | `{ code: 'PERMISSION_DENIED' }` |
| 2 | `:384-386` | `{ code: 'LEASE_LOST' }` (bỏ `status: 403`; nếu giữ status thì là `409`) |
| 3 | `:595-597` | `{ code: 'PERMISSION_DENIED' }` — **và đổi tên test**: tiêu đề hiện tại ("reports a state conflict, not a permission denial") sẽ trái nội dung |
| 4 | `:730-732` | `{ code: 'LEASE_LOST' }` |
| 5 | `:740-742` | `{ code: 'LEASE_LOST' }` |
Lý do: code là hành vi đang ship, khớp **28:1323** + **07** + `assertLease` + ≥9 suite khác. **Rủi ro:** nếu chỉ
sửa test mà không sửa `28:1399`, tài liệu vẫn mâu thuẫn với cả code lẫn test — tức phải làm **B + C cùng nhau**.

### Phương án C — sửa `docs/28:1399` cho khớp code
Sửa **một dòng duy nhất** `docs/28-test-inventory.md:1399`, hai mệnh đề:
1. "cross-operation plus declared plus `STAGING` returns 409 `STATE_CONFLICT`, not `PERMISSION_DENIED`" → phải nói
   **`PERMISSION_DENIED` (409)**, vì fence `:753-755` ("foreign task cannot access unready artifact") chạy trước
   `:756`; `STATE_CONFLICT` chỉ tới được khi artifact thuộc chính task đang gọi.
2. "expiry plus a wrong state yields **403**" → **409 `LEASE_LOST`** (expiry ở `:707` trước state ở `:708`; cả hai
   đều 409).
**Ghi chú quan trọng:** `docs/28` là **inventory bằng chứng lịch sử** của một lần verify ngày 2026-09-29 (entry còn
ghi "90 passed, 90 total" ba lần — nay đã cũ vì suite đang 5 đỏ). Sửa thẳng câu chữ trong entry lịch sử dễ bị coi là
viết lại lịch sử; cách an toàn hơn là **thêm một dòng đính chính** ngay dưới 1399 (ví dụ "CORRECTION 2026-10-09:
…") và để owner docs quyết. Đây là lựa chọn của coordinator/docs owner, không phải của tôi.

### Khuyến nghị của tôi (chỉ là khuyến nghị)
**C (+ tuỳ chọn B)**: dòng 1399 là outlier so với 1323, 07, `assertLease` và ≥9 suite; nhóm II gần như chắc chắn
code đúng. **Nhóm I thì KHÁC** — không có tài liệu nào ủng hộ code, nên đó là **quyết định contract thật**, không
phải sửa lỗi chính tả. Vì vậy nên tách hai nhóm ra quyết riêng.

---

## CÂU HỎI MỞ (không đoán)

1. **Nhóm I — ai thắng?** Với một reference **đã khai báo** (`submit_artifacts`) trỏ artifact `STAGING` của task
   khác trong cùng operation: mã client thấy phải là `STATE_CONFLICT` (1399) hay `PERMISSION_DENIED` (`:753-755`)?
   Cả hai đều từ chối; khác biệt là *lý do lộ ra*. Không tài liệu nào ngoài 1399 nói về ca này ⇒ **cần owner quyết**.
2. **Route đọc có thuộc quy ước LEASE_LOST=409 không?** `docs/07-internal-api.md:44-53` **không có dòng nào** cho
   route cấp quyền đọc, nên spec chính thức im lặng. Nếu owner muốn 403 cho riêng route đọc thì phải **bổ sung dòng
   spec** và nêu lý do khác biệt; nếu không thì 1399 sai.
3. **`assertLease` có phải đổi theo không?** Nếu chọn A cho nhóm II thì `:344-345` (đường upload) có đổi cùng để
   giữ một quy ước duy nhất không? Nếu không đổi, hệ thống sẽ có hai mã cho cùng một sự kiện lease hết hạn.
4. **Số "90 passed" ở `28:1396,1400,1401`** đã cũ (suite nay 5 đỏ). Có cần đính chính kèm theo không?

---

## BƯỚC 6 — GHI NHẬN TRẠNG THÁI

- **`tests/migrations.test.ts` — live-gate, KHÔNG chạy, KHÔNG tính là pass.** Nguyên văn
  `jest.unit.config.cjs:18`: `'migrations\\.test\\.ts$',` (nằm trong `liveSuites`, áp qua `testPathIgnorePatterns`).
- **`tests/usage-summary.test.ts` — live-gate, KHÔNG chạy, KHÔNG tính là pass.** Nguyên văn
  `jest.unit.config.cjs:21`: `'usage-summary\\.test\\.ts$',`.
- **Không claim DB window.** Toàn bộ bằng chứng ở trên là offline: 1 suite, `90 total`, `0 skipped`, không mở
  PostgreSQL/Redis. Các suite live-gated liên quan trực tiếp tới finding này
  (`artifact-grant-fencing` — `jest.unit.config.cjs:14`, `artifacts-fencing-pg` — `:15`) **không** được chạy ở đây,
  nên kết luận của tôi về chúng chỉ ở mức **đọc code/docs**, không phải runtime.

**Xác nhận:** tôi **KHÔNG sửa gì** (không source, không test, không config, không docs), **KHÔNG tick gate nào**
(không `VERIFIED`/`ACCEPTED`/`IMPLEMENTED`), **KHÔNG commit/`git add`/push**, **KHÔNG** hand-edit
`docs/21-openapi.json`, **KHÔNG** đọc `.env.live`, **KHÔNG** mở PostgreSQL/Redis.

**Bằng chứng read-only (`git status --porcelain` cho đúng các file trong phạm vi điều tra):**
```
 M du-rework/orchestrator/services/orchestrator/tests/artifact-read-authorization.test.ts
```
Chỉ **một** file có trạng thái `M`, và đó là **bản sửa test-double của lượt triage TRƯỚC** (sha256 `3deb94fa…`,
mtime trước phiên này) — **không phải** thay đổi của tôi. `src/modules/artifacts/artifacts.ts`,
`docs/28-test-inventory.md`, `docs/07-internal-api.md` đều **sạch** (không có dòng nào) ⇒ tôi không chạm file nào.
Trong phiên này tôi chỉ ghi **receipt + 3 file raw** (`coordination/reports/**`).
