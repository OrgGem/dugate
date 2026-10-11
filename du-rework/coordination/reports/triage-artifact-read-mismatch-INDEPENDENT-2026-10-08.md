# TRIAGE ĐỘC LẬP — 5 MISMATCH trong `tests/artifact-read-authorization.test.ts` — 2026-10-08

- **Vai trò:** leg triage **độc lập, READ-ONLY**. Không sửa file nào (không `src/**`, không `tests/**`), không
  commit/add/push, không tick gate, không hand-edit `docs/21-openapi.json`, offline (không claim DB window).
- **Nhiệm vụ:** ghi và phân loại 5 MISMATCH đã báo cáo; **không tự sửa bên nào**.
- **Environment:** Node **v24.21.0**, jest 30.2.0, Windows.
- **Mốc so sánh:** HEAD `72e225a` (2026-10-08 09:49). File test **đang `M` (dirty) so với HEAD**: bản sửa
  *test double* của lượt triage trước **vẫn chưa commit** (HEAD blob `d2ea35b…`, working file sha256
  `3deb94faa3e78c039af9ffd1687e212efea5f354a2c92447bcbf12fcd1ca60b5`). Mọi số dòng dưới đây là **của cây
  đang làm việc** (lệch nhẹ so với receipt trước vì receipt trước trích dòng `it(...)`).
- **Raw:** `coordination/reports/raw/triage-artifact-read-mismatch-INDEPENDENT-2026-10-08/`
  (`01-red-run.txt`, `01-red-run-full.txt`, `02-failure-blocks.txt`, `SHA256SUMS.txt`).

## 1. Verbatim expected/received — 5 assertion (tự chạy lại, không chép receipt cũ)

```
cwd D:\Git\dugate\du-rework\orchestrator\services\orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts
```
**exit code 1** — `Test Suites: 1 failed, 1 total` / **`Tests: 5 failed, 85 passed, 90 total`** / 1.855 s.

| # | Test (dòng `it()`) | Assertion | Expected (verbatim) | Received (verbatim) |
|---|---|---|---|---|
| 1 | `:371` does not grant reads for STAGING artifacts, even in the same operation | `:375` | `Object { "code": "STATE_CONFLICT" }` | `Object { "code": "PERMISSION_DENIED" }` |
| 2 | `:381` rejects expired and fenced requesters before minting a read grant | `:386` | `Object { "code": "PERMISSION_DENIED", "status": 403 }` | `Object { "code": "LEASE_LOST", "status": 409 }` |
| 3 | `:588` reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact | `:597` | `Object { "code": "STATE_CONFLICT" }` | `Object { "code": "PERMISSION_DENIED" }` |
| 4 | `:724` prefers expiry over task state when both are wrong | `:732` | `Object { "code": "PERMISSION_DENIED", "status": 403 }` | `Object { "code": "LEASE_LOST", "status": 409 }` |
| 5 | `:736` FINDING: the lease_active boolean collapses a missing expiry and a past one | `:742` | `Object { "code": "PERMISSION_DENIED", "status": 403 }` | `Object { "code": "LEASE_LOST", "status": 409 }` |

Test #2 còn một nhánh **đang xanh** cùng `it()`: `:391-393` (epoch cũ) mong `{ code: 'LEASE_LOST' }` — khớp code.
Ngoài 5 dòng này, **không** có assertion `403` nào khác trong file (grep `status: 403` = đúng `:386`, `:732`, `:742`;
các `code: 'PERMISSION_DENIED'` còn lại ở `:365`, `:402`, `:506`, `:523`, `:535`, `:566`, `:581`, `:584`, `:612`
**không** assert status và đang xanh).

## 2. Code verbatim — `src/modules/artifacts/artifacts.ts` quanh `:707`

`requestAccess` (thứ tự kiểm tra, `:684-710`):
```ts
704:        if (task.lease_epoch !== req.leaseEpoch) {
705:          throw conflict('LEASE_LOST', 'requester lease epoch is stale');
706:        }
707:        if (!task.lease_active) throw conflict('LEASE_LOST', 'requester lease has expired');
708:        if (task.state !== 'RUNNING') {
709:          throw conflict('STATE_CONFLICT', 'requester task is not RUNNING');
710:        }
```
và nhánh đọc artifact (`:750-756`):
```ts
750:          if (!sameOperation && !declaredReference) {
751:            throw conflict('PERMISSION_DENIED', 'task is not authorized to read artifact');
752:          }
753:          if (art.taskId !== req.taskId && art.state !== 'READY') {
754:            throw conflict('PERMISSION_DENIED', 'foreign task cannot access unready artifact');
755:          }
756:          if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY');
```
**Taxonomy quyết định status** — `src/http/errors.ts:53-56`:
```ts
53: export const forbidden = (msg = 'action not permitted') => new HttpError(403, 'PERMISSION_DENIED', msg);
55: export const conflict = (code: string, msg: string, extra?: Partial<ProblemDetails>) =>
56:   new HttpError(409, code, msg, extra);
```
⇒ **mọi** `conflict(...)` là **409**, kể cả khi `code` là `PERMISSION_DENIED`. Đây chính là cái làm kỳ vọng
`{status: 403, code: 'PERMISSION_DENIED'}` trông hợp lý nhưng sai cho các đường này: `PERMISSION_DENIED` tồn tại
ở **hai** status trong codebase (403 qua `forbidden()`, 409 qua `conflict()`).

**Đối chiếu từng case:**

| Case test dựng | Đường code | Code trả |
|---|---|---|
| lease hết hạn, epoch đúng (`:382-386`, `:725-732`, `:737-742`) | `:707` | **409 `LEASE_LOST`** |
| epoch sai (`:389-393`, `:697-706`, `:710-720`) | `:704-706` | **409 `LEASE_LOST`** |
| epoch sai **và** lease hết hạn (`:710-720`) | `:704` trước `:707` | **409 `LEASE_LOST`** (khớp test) |
| expiry **và** state sai (`:724-732`) | `:707` trước `:708` | **409 `LEASE_LOST`** (expiry thắng) |
| STAGING do task khác tạo, cùng operation (`:371-375`) | `:753-755` trước `:756` | **409 `PERMISSION_DENIED`** |
| STAGING cross-operation **đã khai báo** (`:588-597`) | qua `:750`, rồi `:753-755` | **409 `PERMISSION_DENIED`** |

## 3. Tài liệu — bên nào nói gì (verbatim + dòng)

**Dòng DUY NHẤT nói 403** — `docs/28-test-inventory.md:1399` (mục W-PLAT-CR28-03):
> "For leases, a wrong epoch plus an expired lease yields `LEASE_LOST`, whereas **expiry plus a wrong state yields
> 403**, and a live lease with the correct epoch still grants."

**Các tài liệu nói 409 `LEASE_LOST`** (đây là nhóm mà receipt trước gọi là *"docs/28:1323 + 5 tài liệu khác"* —
nói cho đúng: **5 tài liệu này back 409, KHÔNG phải 403**):

| # | Tài liệu:dòng | Câu chữ |
|---|---|---|
| 1 | `docs/28-test-inventory.md:1323` | "**expired task lease** (lease chết ⇒ grant upload mới bị từ chối **409 `LEASE_LOST`**; grant cấp khi lease còn sống **rồi** lease chết ⇒ read grant 409)" |
| 2 | `docs/28-test-inventory.md:1287` | "**Pin liveness**: **task lease đã hết hạn** → `LEASE_LOST` và pin không được tạo; **lease epoch cũ** → `LEASE_LOST` **trước khi** chạm bảng `artifacts`." |
| 3 | `docs/04-data-state.md:57` | "Stale worker trả **409 LEASE_LOST**; không được gọi provider mới sau mất lease." |
| 4 | `docs/06b-api-spec-overview.md:170` (+ `:215` bảng `LEASE_LOST` = 409) | "Stale lease (worker) → **409** `LEASE_LOST`" |
| 5 | `docs/00-business-analysis.md:64` | "\| Worker (`RUNTIME_TOKEN`) \| stale lease \| **409** `LEASE_LOST` \|" |
| 6 | `docs/17-operational-runbooks.md:146` (+ `:765`) | "Late reports, stale progress, or **expired heartbeats** return HTTP **409 `LEASE_LOST`** and are rejected at the database level." |
| 7 | `docs/18-release-readiness-report.md:66` (+ `:141`) | "Stale, preempted, or delayed worker reports fail closed with HTTP **409 `LEASE_LOST`**." |
| 8 | `docs/07-internal-api.md:49,51,81` | liệt kê `409 LEASE_LOST/…` cho các route artifact/task |
| 9 | `docs/19-traceability-audit-matrix.md:186` | "Rejections are **409 `LEASE_LOST` or 403 `PERMISSION_DENIED`**" — câu này nói **cả hai tồn tại** (đúng: 403 đến từ `forbidden()`, 409 từ `conflict()`), không phải back cho 403 ở case lease |

⇒ Tỉ lệ: **1 dòng (28:1399)** nói 403; **8+ dòng / 7 tài liệu** nói 409 `LEASE_LOST`.

## 4. Receipt triage trước đó — CÓ, và raw dir cũng CÓ

- **Receipt:** `coordination/reports/triage-artifact-read-authorization-2026-10-08.md` (**tồn tại**, 89 dòng).
  Nó triage **6 test đỏ**, sửa **test double** (thêm `lease_active` vào nhánh không-`T.STATE`), còn lại **5 đỏ**
  và tự ghi rõ **không sửa 5 assertion** vì đó là MISMATCH thuộc owner.
- **Raw dir:** `coordination/reports/raw/triage-artifact-read-authorization-2026-10-08/` — **TỒN TẠI** với 5 file:
  `red-run.log`, `post-double-fix.log`, `tsc-noemit.log` (78 B, chứa `EXIT_CODE=0`), `tsc-test-inclusive.log`
  (42 B, `EXIT_CODE=0`), `SHA256SUMS.txt`. *(Ghi chú phương pháp: lần glob đầu của tôi báo "không có file" vì
  glob khớp **file**, không khớp thư mục — `Test-Path` xác nhận thư mục có thật.)*
- **Đối chiếu độc lập với raw của lượt trước:** `red-run.log` = `6 failed, 84 passed, 90 total`;
  `post-double-fix.log` = **`5 failed, 85 passed, 90 total`** — **trùng khít** kết quả tôi chạy hôm nay
  (5/85/90, exit 1) và trùng đúng 5 tên test. Ngoài ra working file sha256 hiện tại
  `3deb94fa…` **trùng** hash mà receipt trước ghi ở §5 ⇒ cây đang ở đúng trạng thái lượt trước để lại.

## 5. Phân loại 5 MISMATCH (2 họ khác nhau — không gộp)

| Họ | Test | Expected → Received | Bản chất |
|---|---|---|---|
| **A. Lease (403 vs 409 + code)** | #2 `:386`, #4 `:732`, #5 `:742` | `403 PERMISSION_DENIED` → **`409 LEASE_LOST`** | Lệch **cả status lẫn code**. Code + **7 tài liệu** nói 409 `LEASE_LOST`; **1 dòng** (28:1399) nói 403. |
| **B. Readiness (chỉ code, status vẫn 409)** | #1 `:375`, #3 `:597` | `STATE_CONFLICT` → **`PERMISSION_DENIED`** | Lệch **chỉ chuỗi `code`** (cả hai đều 409 qua `conflict()`). Là **thứ tự ưu tiên giữa hai fence** (`:753-755` "foreign task cannot access unready artifact" chạy trước `:756` "artifact is not READY"), tức một **quyết định thiết kế**, không phải lỗi chính tả tài liệu. |

## 6. Kết luận: docs hay code là canonical?

**Không có một câu trả lời duy nhất cho cả 5 — phải tách hai họ:**

- **Họ A (lease): CODE là canonical, `docs/28:1399` là outlier cũ.** Code (`artifacts.ts:707`) trả
  **409 `LEASE_LOST`**, khớp (i) taxonomy của chính codebase (`conflict()` ⇒ 409), (ii) **7 tài liệu** liệt kê ở
  §3, (iii) entry inventory cùng file (`28:1287`, `28:1323`). Dòng `28:1399` ("expiry plus a wrong state yields
  403") **mâu thuẫn với cả ba**. Test #2/#4/#5 đang encode **dòng outlier đó**, không phải hành vi sản phẩm.
  *Nhưng*: theo `du-rework/AGENTS.md` §2, đây vẫn là **MISMATCH phải ghi lại**, **không** được tự sửa docs hay
  test trong lane này.
- **Họ B (readiness): KHÔNG đủ căn cứ để nói bên nào canonical — cần owner phân xử.** Docs `28:1399` nói
  "cross-operation plus declared plus `STAGING` returns 409 `STATE_CONFLICT`, not `PERMISSION_DENIED`"; code có
  một rule rõ ràng, có chủ đích ở `:753-755` (foreign task không đọc artifact chưa READY) chạy **trước** check
  READY. Đây là **hai thiết kế khác nhau**, không phải một bên gõ nhầm.

**Khuyến nghị (đúng như task yêu cầu — ghi, không sửa):**
1. **Ghi nhận MISMATCH** cho cả 5 (2 họ), kèm file:line hai phía — dùng bảng §1/§2/§3 của receipt này.
2. **Không sửa bên nào** trong lane này: không sửa `artifacts.ts`, không sửa test, không sửa docs.
3. **Chuyển coordinator** để mở packet phân xử với owner `artifacts` + owner docs. Hai quyết định riêng:
   - Họ A: chốt **409 `LEASE_LOST`** là canonical ⇒ sửa `docs/28:1399` **và** cập nhật 3 assertion
     (`:386`, `:732`, `:742`) trong **một** packet có owner, kèm mutation/red-first.
   - Họ B: owner quyết **fence nào thắng**; nếu code thắng thì sửa docs `28:1399` + 2 assertion
     (`:375`, `:597`); nếu docs thắng thì đổi thứ tự/`code` trong `artifacts.ts:753-756` (thay đổi hành vi
     sản phẩm, cần review bảo mật vì nó đổi **loại lỗi** trả cho cross-task read).
4. Nhắc lại giới hạn của lượt trước vẫn đúng: 5 test này **không** chạy trên PostgreSQL thật (double `Map`),
   và `assertLease`/`requestAccess` dùng `now()` của DB — kết luận chỉ ở mức offline.

## 7. Giới hạn của receipt này

- Offline, không DB window, không chạy live suite (`artifact-grant-fencing` cần DB) ⇒ không claim gì về hành vi
  trên PostgreSQL thật; 5 test này chạy trên double `Map` (`OfflineArtifactAccessDb`), không phải PG.
- Số dòng là của **cây đang làm việc** (file test `M` do bản sửa double chưa commit) — nếu bản sửa đó được
  commit/đổi, dòng có thể dịch; receipt trước trích dòng `it(...)` nên lệch nhẹ (ví dụ `:727` vs `:732`).
- Không kết luận thay owner về họ B; không tick `VERIFIED`/`ACCEPTED` cho gate nào, không sửa WFA plan,
  không commit/add/push.

## 8. Read-only proof

- Trong cửa sổ làm việc (13:13–13:16 ngày 08/10), lane này chỉ ghi **5 file**: 4 file trong
  `coordination/reports/raw/triage-artifact-read-mismatch-INDEPENDENT-2026-10-08/` + receipt này. **Không**
  file `src/`, `tests/` hay `docs/` nào bị lane này ghi.
- `git status --porcelain` cho 3 file trong phạm vi: `src/modules/artifacts/artifacts.ts` **sạch**,
  `docs/28-test-inventory.md` **sạch**; `tests/artifact-read-authorization.test.ts` là `M` — nhưng đó là bản
  sửa **test double của lượt triage trước** (sha256 `3deb94fa…` khớp hash họ ghi ở §5), **không phải** thay đổi
  của lane này.
- Không commit/add/push; không tick `VERIFIED`/`ACCEPTED`; không hand-edit `docs/21-openapi.json`.

