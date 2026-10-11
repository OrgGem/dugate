# INDEPENDENT VERIFY — draft-decision-artifact-read-auth (2026-10-09)

**Vai trò:** verifier độc lập cho DRAFT PACKET, lane khác tác giả. **KHÔNG sửa gì.**
**Scope:** chỉ du-rework · chỉ đọc + chạy test · không edit source/test/config/docs · không commit / `git add` / push · không tick gate · không đọc `.env.live` · OFFLINE (không PG/Redis).
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`
**node:** `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` → literal `v24.21.0`
**Đối tượng kiểm:** `du-rework/coordination/reports/draft-decision-artifact-read-auth-2026-10-09.md`

## Tổng hợp

| Claim | Phán quyết |
|---|---|
| CLAIM 1 — docs/28:1399 lệch code ở 2 mệnh đề | **ĐÚNG** |
| CLAIM 2 — bản B sửa 3 dòng thì case 1 & 3 vẫn đỏ | **ĐÚNG** (phần con số 2 failed/88 passed là suy luận, chưa đo) |
| CLAIM 3 — `:751`/`:754` là `conflict()` 409; `forbidden()` 403 không dùng trên đường đọc | **ĐÚNG** |
| CLAIM 4 — 5 failed / 85 passed / 90 total / exit 1, không flake | **ĐÚNG** |

---

## CLAIM 1 — docs/28-test-inventory.md:1399 lệch code ở HAI mệnh đề

**Nguyên văn `docs/28-test-inventory.md:1399`** (đọc trực tiếp, file 2211 dòng):

```md
- **Ordering matters and is asserted**: cross-operation plus declared plus `STAGING` returns **409 `STATE_CONFLICT`**, not `PERMISSION_DENIED`. For leases, a wrong epoch plus an expired lease yields `LEASE_LOST`, whereas expiry plus a wrong state yields 403, and a live lease with the correct epoch still grants.
```

**Nguyên văn code tương ứng** (`src/modules/artifacts/artifacts.ts`, nhánh đọc trong `async requestAccess` khai báo tại `:678`):

```ts
:704  if (task.lease_epoch !== req.leaseEpoch) {
:705    throw conflict('LEASE_LOST', 'requester lease epoch is stale');
:706  }
:707  if (!task.lease_active) throw conflict('LEASE_LOST', 'requester lease has expired');
:708  if (task.state !== 'RUNNING') {
:709    throw conflict('STATE_CONFLICT', 'requester task is not RUNNING');
:710  }
:736  if (art.state === 'DELETED') throw conflict('STATE_CONFLICT', 'artifact deleted');
:746  const declaredReference =
:747    sameTenant &&
:748    isPublicArtifactPurpose(art.purpose) &&
:749    hasDeclaredArtifactReference(task.submitArtifacts, artifactId);
:750  if (!sameOperation && !declaredReference) {
:751    throw conflict('PERMISSION_DENIED', 'task is not authorized to read artifact');
:752  }
:753  if (art.taskId !== req.taskId && art.state !== 'READY') {
:754    throw conflict('PERMISSION_DENIED', 'foreign task cannot access unready artifact');
:755  }
:756  if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY');
```

**Nguyên văn `src/http/errors.ts:53` và `:55-56`:**

```ts
export const forbidden = (msg = 'action not permitted') => new HttpError(403, 'PERMISSION_DENIED', msg);
export const conflict = (code: string, msg: string, extra?: Partial<ProblemDetails>) =>
  new HttpError(409, code, msg, extra);
```

**Đối chiếu từng mệnh đề:**

| Mệnh đề trong 1399 | Code thực thi | Phán quyết |
|---|---|---|
| **(i)** declared + STAGING trả **409 `STATE_CONFLICT`**, không phải `PERMISSION_DENIED` | Với declared + STAGING: `:753` đúng (`art.state !== 'READY'`) **và** `art.taskId !== req.taskId` → `:754` ném `conflict('PERMISSION_DENIED')` = **409 PERMISSION_DENIED**, chạy **trước** `:756`. Nhánh `:756` không bao giờ tới. Quan sát được từ case 3: `{` + BT + `code: PERMISSION_DENIED` + BT + `}`. | **SAI** — nói sai cả mã code lẫn lời phủ định |
| **(ii)** expiry + wrong state trả **403** | `:707` (`!task.lease_active`) ném `conflict('LEASE_LOST')` = **409 LEASE_LOST**, chạy **trước** `:708-710`; state không được xét. `forbidden()` (403) vắng mặt trong 700-760. Quan sát được: `{` + BT + `code: LEASE_LOST, status: 409` + BT + `}`. | **SAI** |
| kèm: wrong epoch + expired lease → `LEASE_LOST` | `:705` + `:707` → `LEASE_LOST` 409 | **ĐÚNG** — bản thảo cũng ghi vậy |
| kèm: live lease + epoch đúng vẫn grant | không có nhánh nào phủ nhận ở `:704-710` | không phát hiện mâu thuẫn (chưa xác nhận bằng test riêng) |

### CLAIM 1 → **ĐÚNG**

2/2 mệnh đề bị chỉ đích danh đều lệch code; số dòng claim nêu (`artifacts.ts:753-755` và `:707`) **khớp chính xác** dòng tôi đọc. Independent cross-check: lượt verify trước của tôi (`verify-ara-INDEPENDENT-QWEN-2026-10-09.md`) kết luận tương tự — 2 verifier độc lập đồng thuận.

---

## CLAIM 2 — bản B sửa `:386`/`:732`/`:742` thì case 1 (`:375`) và case 3 (`:597`) vẫn đỏ

**Nguyên văn assertion case 1** (`tests/artifact-read-authorization.test.ts:372-378`):

```ts
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    await expect(service.requestAccess(STAGING_OUTPUT, readRequest())).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(db.grantUpdates).toBe(0);
```

**Nguyên văn assertion case 3** (`:595-598`):

```ts
      await expect(
        makeService(db).requestAccess(FOREIGN_STAGING_OUTPUT, readRequest())
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
      expect(db.grantUpdates).toBe(0);
```

**Nguyên văn 3 assertion bản B định sửa** (cả ba cùng dạng, `:386` / `:732` / `:742`):

```ts
      ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });   // :386
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });     // :732
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });     // :742
```

### Kiểm 3 điều kiện

1. **case 1 & 3 là `code: 'STATE_CONFLICT'`** → **ĐÚNG.** Cả hai truyền đúng một khóa duy nhất `code` với giá trị `STATE_CONFLICT`.
2. **không có alias `PERMISSION_DENIED`** → **ĐÚNG.** Không nhánh `||`, không mảng kỳ vọng thứ hai, không `expect.objectContaining`, không khóa `status` — trong hai assertion đó. (Khác với 3 assertion `:386`/`:732`/`:742` vốn *có* `code: 'PERMISSION_DENIED'` — nhưng đó là đoạn khác mà bản B thay.)
3. **sửa 3 dòng → case 1 & 3 không thể xanh** → **ĐÚNG.** Bản B không đụng `:375`/`:597`; kỳ vọng vẫn `STATE_CONFLICT`, code vẫn trả `PERMISSION_DENIED` (CLAIM 1, không đổi code). Kỳ vọng ≠ thực tế ⇒ vẫn đỏ.

### CLAIM 2 → **ĐÚNG**

### Trung thực về con số "2 failed, 88 passed, 90 total"

Con số đó là **suy luận** (5 − 3 = 2), **không phải đo**. Tôi không thể đo vì áp dụng bản B = edit file test → bị cấm với vai trò verifier. Cái tôi xác minh trực tiếp là: (a) nội dung 3 assertion `:386`/`:732`/`:742` đúng như bảng của bản B; (b) 2 assertion còn lại không đổi; (c) code trả về cho chúng là `PERMISSION_DENIED`. Từ (a)(b)(c), 2 RED còn lại là hệ quả tất yếu. ⇒ **bản chất ĐÚNG, con số cụ thể CHƯA ĐO.**


---

## CLAIM 3 — `artifacts.ts:751` và `:754` dùng `conflict()` (=409 qua `errors.ts:55-56`) với code `PERMISSION_DENIED`; `forbidden()` 403 (`errors.ts:53`) không dùng trên đường đọc này

**Nguyên văn `src/http/errors.ts:50-58`** (đọc trực tiếp):

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

**Hai dòng được claim nêu đích danh (grep xác nhận, khớp `:751` / `:754`):**

```ts
:751            throw conflict('PERMISSION_DENIED', 'task is not authorized to read artifact');
:754            throw conflict('PERMISSION_DENIED', 'foreign task cannot access unready artifact');
```

Cả hai gọi `conflict(code, ...)` → `new HttpError(409, code, msg, extra)` ⇒ **status 409 + code `PERMISSION_DENIED`.** Không dòng nào đi qua `forbidden()` ⇒ không có 403 trên đường này.

### Đếm số lần dùng mỗi loại

**Dải 700-760 — đúng phạm vi đường đọc:**

| Loại | Số lần | Các dòng |
|---|---|---|
| `conflict(` | **7** | 705, 707, 709, 736, 751, 754, 756 |
| `forbidden(` | **0** | — |
| `unauthorized(` | **0** | — |

**Toàn file `artifacts.ts` (1403 dòng) — để không diễn đạt sai:**

| Loại | Số lần | Các dòng | Đường dẫn |
|---|---|---|---|
| `forbidden(` | **3** | 495, 501, 556 | đều ở đường **ghi / finalize** (producer): `artifact does not belong to task`, `producer lease has expired`, `producer lease expired before finalization` |
| `conflict(` | **27** | 342 … 1397 | mọi nơi |

Claim viết `forbidden()` 403 **không được dùng trên đường đọc này** → phạm vi xét đúng (0 lần trong 700-760), đồng thời **không** nói sai khi hiểu cả file (nó có 3 lần ở đường finalize).

### CLAIM 3 → **ĐÚNG**

Hệ quả (gián tiếp xác nhận nhận định nền của bản thảo): cặp `409 + PERMISSION_DENIED` chỉ tồn tại vì `PERMISSION_DENIED` — vốn là mã của `forbidden()` (403) — được ném qua `conflict()` (409). Đúng là cặp mà bản thảo gọi là lệch chuẩn.

---

## CLAIM 4 — 5 failed / 85 passed / 90 total, exit 1, không flake qua 2 tiến trình độc lập

**Lệch nhỏ về hình thức (phải nói rõ):** packet đưa cú pháp PowerShell (`& $env:TEMP/…node.exe …` + `$LASTEXITCODE`). Shell mặc định ở lượt này là `cmd.exe`, nên tôi chạy **cùng binary + cùng flags** qua đường tương đương và đọc exit **ngay sau tiến trình, không pipe**:

```cmd
cmd /v:on /c "%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts 2>&1 & echo REAL_EXIT=!errorlevel!"
```

### Bảng kết quả 2 tiến trình độc lập

| Lần | `Test Suites:` (literal) | `Tests:` (literal) | REAL_EXIT |
|---|---|---|---|
| **Lần 1** | `Test Suites: 1 failed, 1 total` | `Tests:       5 failed, 85 passed, 90 total` | **1** |
| **Lần 2** | `Test Suites: 1 failed, 1 total` | `Tests:       5 failed, 85 passed, 90 total` | **1** |

**5 tên test đỏ — giống hệt nhau cả 2 lần, cùng thứ tự:**

1. `R1-A artifact read authorization and storage-facade boundary › does not grant reads for STAGING artifacts, even in the same operation`
2. `R1-A artifact read authorization and storage-facade boundary › rejects expired and fenced requesters before minting a read grant`
3. `CR28-03 artifact read authorization: negatives and boundaries › declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact`
4. `CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong`
5. `CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one`

- Node: `v24.21.0` (đúng binary trong packet, đã đo lại `node -v`).
- Offline, 1 suite, `jest.unit.config.cjs`; không mở PG:5433 / Redis:6380.
- Hai lần là **hai tiến trình `cmd`/`node` riêng biệt** (mỗi lần một process group riêng) → cùng biến số tuyệt đối → **không flake**.
- Khớp với kết quả lượt verify trước của tôi (cùng 5 RED, cùng con số) → thêm một mốc chéo độc lập nữa.

### CLAIM 4 → **ĐÚNG**

---

## Phát hiện thêm (ngoài 4 claim, để owner biết)

1. **Bản thảo bỏ sót một site `conflict()` trong bảng "Cơ chế code".** Dải 700-760 có **7** lần `conflict(`; bản thảo liệt kê **6**, bỏ `:736` `if (art.state === 'DELETED') throw conflict('STATE_CONFLICT', 'artifact deleted');`. Không ảnh hưởng 4 claim — `:736` không nằm trên đường RED nào — nhưng bảng đếm chưa đủ.
2. **Bản thảo nói phần thứ hai của case 2 "đang PASS" — không thể quan sát được.** Ở `:384-386` (assertion `staleDb`) nằm **sau** assertion `expiredDb` trong **cùng một `it()`**. Assertion đầu thất bại → `it()` dừng → dòng `staleDb` **không bao giờ thực thi** trong lượt này. Nó có thể đúng về suy luận, nhưng chữ "đang PASS" là một khẳng định quan sát chưa có bằng chứng. Nên ghi thành: *chưa từng chạy; suy luận sẽ pass*.
3. **Xác nhận ghi chú ngoài phạm vi của bản thảo về dải dòng sai.** `docs/28:1397` ghi `createArtifactService().requestAccess (321-420)` → thực tế `createArtifactService` ở **`:124`**, `requestAccess` khai báo ở **`:678`**, nhánh đọc gây 5 RED ở **`:700-760`** — hoàn toàn ngoài 321-420. → **Ghi chú của bản thảo ĐÚNG.**
4. **Digest khớp — không file nào đổi giữa bản thảo và lượt verify này:**

```
tests/artifact-read-authorization.test.ts  3deb94faa3e78c039af9ffd1687e212efea5f354a2c92447bcbf12fcd1ca60b5   (= 3deb94fa…a60b5)
src/modules/artifacts/artifacts.ts        1fa4d876450463cce1c2979a4ce15c11b34c966ac89be911260f7b1791eae5f2   (= 1fa4d876…ae5f2)
src/http/errors.ts                        35e7eb3aeea4dd43a902c218c75b55eb6c25dd0d6b2b46e5204e0826a6eac4b0   (= 35e7eb3a…c4b0)
```

5. **`docs/28-test-inventory.md` không xuất hiện trong `git status`** → vẫn nguyên trạng; hai phiên bản B/C trong bản thảo **chưa áp dụng**. Nhất quán với khẳng định của bản thảo.

---

## XÁC NHẬN

- **KHÔNG sửa gì.** Chỉ đọc file + chạy test. Không edit source/test/config/docs — không `docs/28`, không `artifact-read-authorization.test.ts`, không `artifacts.ts`, không `errors.ts`, không bản thảo.
- **KHÔNG commit, KHÔNG `git add`, KHÔNG push.** Chỉ `git status` / `git log` / `certutil -hashfile` (đọc).
- **KHÔNG tick gate** nào (VERIFIED / ACCEPTED / IMPLEMENTED đều của coordinator).
- **KHÔNG đọc `.env.live`.** OFFLINE: chỉ 1 suite thuộc unit config; không mở PostgreSQL/Redis/S3; không claim DB window.
- **Trạng thái git trong phạm vi kiểm, trước và sau verify, giống nhau:** `tests/artifact-read-authorization.test.ts` giữ ` M` (thay đổi có từ trước, của lane khác); `src/modules/artifacts/artifacts.ts`, `src/http/errors.ts`, `docs/28-test-inventory.md` đều **sạch** so với HEAD.
- **Giới hạn lượt này:** mọi phần "sau khi áp dụng B/C" trong bản thảo đều là suy luận từ code + assertion đã đọc, **chưa đo**, vì áp dụng sửa đổi nằm ngoài quyền read-only của verifier.
