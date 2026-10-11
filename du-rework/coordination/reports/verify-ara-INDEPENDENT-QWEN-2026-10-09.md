# VERIFIER ĐỘC LẬP THỨ HAI — verify-ara (2026-10-09)

Vai trò: verifier độc lập thứ hai, lane khác, để đối chiếu chéo với lane đã làm. **Không sửa gì.**
Scope: chỉ du-rework. Chỉ đọc và chạy test. Không edit source/test/config/docs. Không commit / git add / push. Không tick gate. Không đọc .env.live. Offline.
CWD mọi lệnh: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`
Node dùng để chạy: `%TEMP%/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe -v` → literal: `v24.21.0`

## 0. Kết luận nhanh

| Kết luận | Nội dung kiểm | Phán quyết |
|---|---|---|
| **A** | 5 RED trong `artifact-read-authorization.test.ts`, tất cả phải ra từ code, không phải test hỏng | **ĐỒNG MỘT PHẦN** — đủ 5 RED, tái lập được, không phải flake, không phải test hỏng; nhưng "phải ra từ code" chỉ được chứng minh cho 2/5 case, 3/5 còn lại là xung đột hợp đồng code-vs-test, cần adjudicate |
| **B** | `public-upload-encryption-gateway.test.ts` GREEN 12/12 trên Node v24.21.0 | **ĐỒNG** — 12 passed / 12 total, REAL_EXIT=0 |
| **C** | docs/28 mâu thuẫn nội tại: dòng 1323 nói lease hết hạn là 409 LEASE_LOST, dòng 1399 nói 403 | **ĐỒNG** (mâu thuẫn có thật trên bề mặt), kèm 2 phát hiện thêm: dòng 1399 trái với code hiện tại, và "Verification 90 passed" ở dòng 1400 đã sai |

## 1. Bảng lệnh + REAL_EXIT

REAL_EXIT đọc ngay sau tiến trình, không qua pipe (dùng `cmd /v:on` + `!errorlevel!` để không bị pipe che).

| # | Lệnh | REAL_EXIT | Literal `Test Suites:` / `Tests:` |
|---|---|---|---|
| L1 (fail-first) | `node.exe node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts` | **1** | `Test Suites: 1 failed, 1 total` / `Tests:       5 failed, 85 passed, 90 total` |
| L3 (chạy lại, tiến trình độc lập) | y như L1 | **1** | `Test Suites: 1 failed, 1 total` / `Tests:       5 failed, 85 passed, 90 total` |
| L4 | `node.exe node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | **0** | `Test Suites: 1 passed, 1 total` / `Tests:       12 passed, 12 total` |

L1 literal bổ sung: `Snapshots: 0 total`, `Time: 2.351 s`, `Ran all test suites matching tests/artifact-read-authorization.test.ts.`
L4 literal bổ sung: `PASS  tests/public-upload-encryption-gateway.test.ts`

**Chống flake (L1 vs L3):** hai tiến trình riêng biệt, cùng REAL_EXIT=1, cùng con số `5 failed, 85 passed, 90 total`, cùng **đúng 5 tên test** đỏ:

1. `R1-A ... › does not grant reads for STAGING artifacts, even in the same operation` (dòng 375)
2. `R1-A ... › rejects expired and fenced requesters before minting a read grant` (dòng 386)
3. `CR28-03 ... declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact` (dòng 597)
4. `CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong` (dòng 732)
5. `CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one` (dòng 742)

## 2. Trích code

### 2.1 `src/modules/artifacts/artifacts.ts` (700-760)

```ts
        if (task.lease_epoch !== req.leaseEpoch) {
          throw conflict('LEASE_LOST', 'requester lease epoch is stale');
        }
        if (!task.lease_active) throw conflict('LEASE_LOST', 'requester lease has expired');
        if (task.state !== 'RUNNING') {
          throw conflict('STATE_CONFLICT', 'requester task is not RUNNING');
        }

        const artifactRes = await client.query(
          `SELECT tenant_id AS "tenantId", operation_id AS "operationId",
                  storage_key AS "storageKey", storage_backend AS "storageBackend",
                  storage_version_id AS "storageVersionId", file_name AS "fileName", mime_type AS "mimeType",
                  size_bytes AS "sizeBytes", sha256,
                  state, task_id AS "taskId", purpose
            FROM artifacts WHERE id=$1 FOR UPDATE`,
          [artifactId]
        );
        if (!artifactRes.rowCount) throw notFound(`artifact ${artifactId} not found`);
        ...
        if (art.state === 'DELETED') throw conflict('STATE_CONFLICT', 'artifact deleted');

        const sameTenant = art.tenantId === task.tenantId;
        const sameOperation = sameTenant && art.operationId === task.operationId;
        let readVersionId: string | undefined;
        if (req.mode === 'read') {
          const declaredReference =
            sameTenant &&
            isPublicArtifactPurpose(art.purpose) &&
            hasDeclaredArtifactReference(task.submitArtifacts, artifactId);
          if (!sameOperation && !declaredReference) {
            throw conflict('PERMISSION_DENIED', 'task is not authorized to read artifact');
          }
          if (art.taskId !== req.taskId && art.state !== 'READY') {
            throw conflict('PERMISSION_DENIED', 'foreign task cannot access unready artifact');
          }
          if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY');
          readVersionId = art.storageVersionId ??
            ((art.storageBackend ?? 'postgres') === 'postgres' ? art.sha256 ?? undefined : undefined);
```

Ánh xạ chính xác (số dòng theo revision hiện tại, file 1403 dòng):

| Ném ra | Dòng | Helper | Status thực tế |
|---|---|---|---|
| `LEASE_LOST` (epoch lệch) | 705 | `conflict` | **409** |
| `LEASE_LOST` (lease hết hạn / không có expiry) | 707 | `conflict` | **409** |
| `STATE_CONFLICT` (task không RUNNING) | 709 | `conflict` | **409** |
| `STATE_CONFLICT` (artifact DELETED) | 736 | `conflict` | **409** |
| `PERMISSION_DENIED` (không sameOperation và không declared) | 751 | `conflict` | **409** |
| `PERMISSION_DENIED` (foreign task + artifact chưa READY) | 754 | `conflict` | **409** |
| `STATE_CONFLICT` (artifact không READY) | 756 | `conflict` | **409** |

**Điểm mấu chốt:** module này **không** dùng `forbidden()` ở đường đọc; nó ném `PERMISSION_DENIED` **qua `conflict()`**, mà `conflict()` luôn stamp **409**. Vậy `code: 'PERMISSION_DENIED'` ở artifacts.ts **luôn đi kèm status 409**, không bao giờ 403.

### 2.2 `src/http/errors.ts` (50-58)

```ts
export const unauthorized = (msg = 'missing or invalid api key') =>
  new HttpError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'action not permitted') => new HttpError(403, 'PERMISSION_DENIED', msg);
export const notFound = (msg: string) => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (code: string, msg: string, extra?: Partial<ProblemDetails>) =>
  new HttpError(409, code, msg, extra);
export const gone = (msg: string) => new HttpError(410, 'TASK_TERMINAL', msg);
export const unprocessable = (code: string, msg: string, extra?: Partial<ProblemDetails>) =>
  new HttpError(422, code, msg, extra);
```

- `conflict()` → status **409** (code do caller truyền vào, không cố định).
- `forbidden()` → status **403** với code **PERMISSION_DENIED**.
- ⇒ Cùng code `PERMISSION_DENIED` có thể mang **409** (qua `conflict`) hoặc **403** (qua `forbidden`). Hai helper này là hai status khác nhau cho cùng một code — đây là gốc của xung đột ở kết luận C.

## 3. Danh sách suite bị live-gate bỏ qua (LENH 5)

`jest.unit.config.cjs` định nghĩa `liveSuites` (15 mục) và gán `testPathIgnorePatterns: liveSuites`. Comment tại chỗ ghi rõ lý do: "excludes the suites that boot the real app against PG :5433 / Redis :6380 (the DB-window protocol)".

**15 suite bị BỎ QUA — không chạy, KHÔNG được tính là pass:**

1. `admin-action-rbac-live.test.ts`
2. `admin-audit.test.ts`
3. `admin-base-routes.test.ts`
4. `admin-error-boundary.test.ts`
5. `admin-shell-live-pane.test.ts`
6. `artifact-grant-fencing.test.ts`
7. `artifacts-fencing-pg.test.ts`
8. `blob-wire-binary.test.ts`
9. `ingress-bounded.test.ts`
10. `migrations.test.ts`
11. `operation-tenant-fence.test.ts`
12. `runtime.test.ts`
13. `usage-summary.test.ts`
14. `webhook-reclaim-fence.live.test.ts`
15. `workspace-reference.test.ts`

**Hệ quả trực tiếp cho kết luận C:** `artifact-grant-fencing.test.ts` — đúng cái suite mà docs dòng 1323 mô tả — **nằm trong danh sách bị bỏ qua**, nên offline tôi **không thể** chạy nó. Còn `artifact-read-authorization.test.ts` **không** bị bỏ qua (đó là lý do L1/L3 chạy được).

## 4. Kết luận A

Claim: `tests/artifact-read-authorization.test.ts` có 5 RED và **tất cả đều phải ra từ code, không phải test hỏng**.

**Phần ĐỒNG (chắc chắn):**
- Đúng **5 RED**, đúng 5 tên, tái lập ở 2 tiến trình độc lập, REAL_EXIT=1 cả hai lần. Không flake.
- **Không phải test hỏng về mặt cơ học**: 85/90 test trong cùng suite vẫn xanh, harness chạy bình thường, không có lỗi compile/import/runtime ngoài ý muốn.
- `src/modules/artifacts/artifacts.ts` **sạch trong git** (không có `M` trong `git status --porcelain`); chỉ **hai file test** đang `M`. Nghĩa là RED **không** do một sửa đổi chưa commit nào đó của product module. Code product đang ở đúng revision đã commit (lần cuối bởi `72e225a`).

**Phần KHÔNG chứng minh được (phải nói thẳng):**

| # | Test đỏ | Kỳ vọng của test | Code thực tế ném | RED này ra từ đâu |
|---|---|---|---|---|
| 1 | STAGING same-operation (dòng 375) | `code: STATE_CONFLICT` | `PERMISSION_DENIED` (409) | **Code** — guard thứ tự: dòng 754 ném trước dòng 756 |
| 3 | declared cross-operation STAGING (dòng 597) | `code: STATE_CONFLICT` | `PERMISSION_DENIED` (409) | **Code** — cùng nguyên nhân thứ tự guard 754 trước 756 |
| 2 | expired + fenced requester (dòng 386) | `{status: 403, code: PERMISSION_DENIED}` | `{code: LEASE_LOST, status: 409}` | **Xung đột hợp đồng** — code (dòng 707) cố ý ném LEASE_LOST 409 |
| 4 | prefers expiry over task state (dòng 732) | `{status: 403, code: PERMISSION_DENIED}` | `{code: LEASE_LOST, status: 409}` | **Xung đột hợp đồng** — dòng 707 kiểm tra trước dòng 709 |
| 5 | lease_active collapses missing/past expiry (dòng 742) | `{status: 403, code: PERMISSION_DENIED}` | `{code: LEASE_LOST, status: 409}` | **Xung đột hợp đồng** — projection boolean gộp hai ca thành một |

- Với #1 và #3: code **chắc chắn** sai so với ý định đã ghi trong chính docs (dòng 1399: "cross-operation plus declared plus `STAGING` returns 409 `STATE_CONFLICT`, not `PERMISSION_DENIED`"). Guard ở dòng 754 chặn trước guard ở dòng 756 nên `STATE_CONFLICT` không bao giờ tới được. Đây là **lỗi thứ tự guard trong code**, test không hỏng.
- Với #2/#4/#5: bằng chứng chỉ chứng minh **code ≠ test**. Code ném LEASE_LOST/409 **có chủ đích và có tài liệu** (docs dòng 1323: "lease chết ⇒ ... 409 `LEASE_LOST`"). Test đòi PERMISSION_DENIED/403. Việc **bên nào đúng là quyết định hợp đồng**, không phải sự kiện đo được. Vì vậy câu "tất cả đều phải ra từ code" **chưa được chứng minh** cho 3/5 case này.
- Ghi nhận thêm một bất khả thi về mặt code: `forbidden()` (403 PERMISSION_DENIED) **không hề được dùng** ở đường đọc của artifacts.ts, nên một kỳ vọng `{status: 403, code: PERMISSION_DENIED}` **không thể** đạt được từ module này ở revision hiện tại, dù code có sửa thứ tự guard hay không. Muốn 403 thì phải đổi cách ném (dùng `forbidden()`) — tức đổi hành vi wire, không phải chỉ sửa thứ tự.

⇒ **A: ĐỒNG một phần.** 5 RED và tính "không phải test hỏng" được xác nhận độc lập. Quy kết "tất cả ra từ code" chỉ đúng cho 2/5; 3/5 là xung đột hợp đồng cần adjudicate (và nhiều khả năng docs dòng 1399 mới là bên sai — xem kết luận C).

## 5. Kết luận B

Claim: `tests/public-upload-encryption-gateway.test.ts` GREEN 12/12 trên Node v24.21.0.

**ĐỒNG.** L4 (đúng node v24.21.0 như yêu cầu) cho:

```
PASS  tests/public-upload-encryption-gateway.test.ts
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
REAL_EXIT=0
```

Lưu ý phạm vi: file này **không** nằm trong `liveSuites`, nên chạy offline là hợp lệ và đủ. File đang `M` trong git (do lane khác viết), nhưng product code nó kiểm thì sạch.

## 6. Kết luận C

Claim: docs/28-test-inventory.md mâu thuẫn nội tại — dòng 1323 nói lease hết hạn là **409 LEASE_LOST**, dòng 1399 nói **403**.

**Trích literal hai dòng:**

- **Dòng 1323** (`artifact-grant-fencing.test.ts`, nhóm "expired task lease"):
  > "**expired task lease** (lease chết ⇒ grant upload mới bị từ chối 409 `LEASE_LOST`; grant cấp khi lease còn sống **rồi** lease chết ⇒ read grant 409)"
- **Dòng 1399** (`artifact-read-authorization.test.ts`, mục "Ordering matters and is asserted"):
  > "For leases, a wrong epoch plus an expired lease yields `LEASE_LOST`, whereas **expiry plus a wrong state yields 403**, and a live lease with the correct epoch still grants."

**Phán quyết: ĐỒNG — mâu thuẫn có thật trên bề mặt.** Cùng một điều kiện "lease hết hạn", dòng 1323 nói **409 LEASE_LOST**, dòng 1399 nói **403**. Không thể cả hai đúng cho cùng một đường code.

**Ground truth đo được (offline, revision hiện tại):**

| Nguồn | Nói gì về lease hết hạn |
|---|---|
| Code `artifacts.ts:707` | `conflict('LEASE_LOST', ...)` ⇒ **409 LEASE_LOST** (khớp dòng 1323) |
| Code `artifacts.ts:754/756` | 403 **không thể** xảy ra trên đường đọc (module không dùng `forbidden()`) |
| Test dòng 386 / 732 / 742 | đòi **403 PERMISSION_DENIED** ⇒ **ĐỎ** (khớp dòng 1399) |
| Đo thực tế L1/L3 | `5 failed, 85 passed, 90 total`, REAL_EXIT=1 |

⇒ Về hành vi hiện tại, **dòng 1399 SAI** (nó mô tả một kết quả 403 mà code không tạo ra), và **dòng 1323 ĐÚNG** so với code (409 LEASE_LOST).

**Hai phát hiện thêm khi đối chiếu (ngoài claim, nhưng liên quan trực tiếp):**

1. **Dòng 1400 mâu thuẫn với thực đo.** Literal: "**Verification**: three consecutive runs, each **90 passed, 90 total**, 1 suite passed. `tsc --noEmit` ExitCode 0 with a **0-byte log**, before and after M1." Nhưng L1 và L3 (hai tiến trình độc lập) đều cho `5 failed, 85 passed, 90 total`, REAL_EXIT=1. Suite **không còn** 90/90 như docs ghi.
2. **Dòng 1402 trích sai vị trí code.** Literal: "removing the `sameTenant &&` conjunct from `declaredReference` (artifacts.ts:389-392)". Ở revision hiện tại, `declaredReference` nằm ở **dòng 746-749**; còn `artifacts.ts:389-392` rơi vào khối `INSERT INTO artifacts ... 'STAGING'` của **đường ghi**. Citation này không resolve về thứ nó nói.

**Giới hạn phạm vi của C (phải nói rõ):** dòng 1323 mô tả `artifact-grant-fencing.test.ts`, mà suite đó **bị live-gate bỏ qua** (mục 3) — tôi **không thể** chạy nó offline. Nên: mâu thuẫn **giữa hai dòng docs** là có thật và tôi xác nhận được bằng đọc; nhưng việc dòng 1323 có **thực thi đúng trong suite live của nó** thì tôi **không** kiểm chứng được (cần DB window).

## 7. Xác nhận

- **Không sửa gì.** Chỉ dùng đọc file (`read_file`) và chạy test. Không edit source/test/config/docs.
- **Không commit, không `git add`, không push.** Chỉ chạy `git status` / `git log` (đọc).
- **Không tick gate.**
- **Không đọc .env.live.** Offline: chỉ chạy 2 suite thuộc unit config, không mở PG:5433 / Redis:6380.
- File test đang `M` trong git là do lane khác viết — tôi không đụng vào; trạng thái git sau khi verify y như trước khi verify.
