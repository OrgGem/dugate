# INDEPENDENT VERIFY leg B — WFA section 8 MED-2 existence oracle (2026-10-08)

> **RESUME POINT — VERIFIED-CLEAN (có caveat, chưa chốt gate).** Leg B = agent thứ hai, provider khác, chạy độc lập với leg A. 3/3 lệnh đã chạy: tsc `exit 0`; test mới `2 passed / 2 total` `exit 0`; regression 3 suite `exit 1` với **đúng 1 RED đã có sẵn** (không liên quan fix MED-2 — phân tích ở §4). Doc review a–d: **4/4 PASS**. Confunder `public.ts` đo 3 lần, **không đổi**. Leg này KHÔNG tick gate, KHÔNG viết VERIFIED/ACCEPTED, KHÔNG sửa gì.

- **Đối tượng:** fix MED-2 (operation-existence oracle) — receipt của lane fix: `coordination/reports/fix-section8-med2-existence-oracle-2026-10-08.md`.
- **Vai trò:** READ-ONLY — chỉ chạy test, đọc code, ghi receipt. Không sửa source, không sửa test, không commit/push/git add, không tick gate, không hand-edit `docs/21-openapi.json`.
- **Scope:** chỉ `du-rework`. Không claim DB window, không chạy live DB — mọi lệnh dưới là **offline unit/typecheck**.
- **Raw logs:** `coordination/reports/raw/verify-section8-med2-independent-legB-2026-10-08/` (`legB-1-tsc.log`, `legB-2-newtest.log`, `legB-3-regression-3suites.log`).

## 1. Bảng lệnh / cwd / exit / Tests: literal

| # | Command (cwd `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`) | Exit | Tests: (literal) |
|---|---|---:|---|
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | *(không có dòng Tests — tsc im lặng khi sạch)* |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/wfa-section8-med2-existence-oracle.test.ts` | **0** | `Tests:       2 passed, 2 total` |
| 3 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/legacy-public-artifact.test.ts tests/public-upload-encryption-gateway.test.ts tests/rcr-http-offline.functional.test.ts` | **1** | `Tests:       1 failed, 21 passed, 22 total` |

Chi tiết literal từng lệnh:

### Lệnh 1 — typecheck

```
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
command: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
(stdout/stderr rỗng — tsc không in gì khi typecheck sạch)
exit: 0
```

### Lệnh 2 — test mới của fix

```
  PASS  tests/wfa-section8-med2-existence-oracle.test.ts
  WFA section 8 MED-2 operation existence oracle
    √ tenant-operator detail returns the same problem for missing and foreign operation IDs (6 ms)
    √ API-key result returns the same problem for missing, foreign-tenant, and foreign-profile workflow IDs (1 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
exit: 0
```

### Lệnh 3 — regression 3 suite

```
  FAIL  tests/public-upload-encryption-gateway.test.ts
  ● public upload encryption gateway › completes the public grant, binary upload, finalize replay, and submit route journey

    unexpected test DB query: UPDATE artifacts SET operation_id=$2 WHERE id = ANY($1::uuid[])
    AND tenant_id=$3 AND state='READY' AND operation_id IS NULL AND task_id IS NULL

      > 386 |     throw new Error('unexpected test DB query: ' + query);
      at Object.execute [as query] (tests/public-upload-encryption-gateway.test.ts:386:11)
      at src/modules/operations/submission.ts:660:24
      at Object.submit (src/modules/operations/submission.ts:530:23)
      at handlePublicRoutes (src/http/routes/public.ts:398:22)
      at route (src/server.ts:376:24)
      at Object.<anonymous> (tests/public-upload-encryption-gateway.test.ts:550:23)

  PASS  tests/rcr-http-offline.functional.test.ts
  PASS  tests/legacy-public-artifact.test.ts

Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 21 passed, 22 total
```
- Kèm warning: `Jest did not exit one second after the test run has completed.` (không tính FAIL).

## 2. Confunder checkpoints

| Mốc | File | SHA-256 |
|---|---|---|
| TRƯỚC run đầu | `orchestrator/services/orchestrator/src/http/routes/public.ts` | `e17ee5bf94e6cfb85c2334b3dcde26866ef31d9b949631349311bfe51d8c3fb7` |
| GIỮA (sau lệnh 3) | cùng file | `e17ee5bf94e6cfb85c2334b3dcde26866ef31d9b949631349311bfe51d8c3fb7` |
| SAU run cuối | cùng file | `e17ee5bf94e6cfb85c2334b3dcde26866ef31d9b949631349311bfe51d8c3fb7` |

**Không đổi ở cả 3 mốc** → không có lane nào vá `public.ts` trong lúc leg B chạy, nên kết quả xanh là của đúng code đó. **Không có BLOCKER.**

## 3. Doc review (a–d) — verdict từng mục

### a) `public.ts:66-83` — helper chỉ normalize duy nhất 404 NOT_FOUND

**PASS.**
- `throwFencedOperationNotFound` (`public.ts:66-71`) điều kiện `isHttpError(err) && err.status === 404 && err.code === 'NOT_FOUND'` (`:67`) → chỉ khi đúng 404+NOT_FOUND mới ném lại `HttpError(404, 'NOT_FOUND', message)` cố định của route.
- Mọi status/code khác rơi xuống `throw err` (`:70`) — giữ nguyên lỗi gốc (403, 409, 410, 503, 500…). **Không có đường đổi lỗi khác.**
- `getFencedOperation` (`:73-83`) bọc đúng một chỗ gọi `ctx.runtime.getOperation` (`:79`) và chuyển lỗi qua helper (`:81`); không nuốt lỗi, không log lại, không đổi stack ngoài việc ném lại.

### b) `public.ts:487-500` — có bao vây lần đọc thứ hai trong `buildAdminOperationDetail`

**PASS (kèm ghi chú về phạm vi).**
- Nhánh tenant-operator (`:489`) đọc có fence (`:490`), rồi bọc `buildAdminOperationDetail` trong `try` (`:493`) với `catch` trả `throwFencedOperationNotFound(err, 'not found')` (`:495-497`). Có đúng lý do trong comment: hàng bị xoá giữa lần đọc fence và lần đọc detail không được lộ message mang ID.
- **Ghi chú:** nhánh platform-admin (`:500`) cố ý **không** bọc. Điều này đúng với finding: đối tượng là caller không được biết sự tồn tại; platform admin là bảng điều khiển đã thấy cross-tenant, không có oracle để đóng. Không coi là FAIL, nhưng đây là ranh giới cần giữ nếu sau này ai đó thu hẹp quyền platform.

### c) `public.ts:523-535` — fence `api_key_id` chỉ áp cho workflows, không làm mất quyền API key khác

**PASS.**
- Điều kiện tại `:532-533`: `typeof op.endpoint_slug === 'string' && op.endpoint_slug.startsWith('workflows:') && String(op.api_key_id) !== apiKey.id`.
- Cả ba điều kiện phải cùng đúng mới ném 404. Với endpoint **không** phải workflow (`endpoint_slug` không bắt đầu `workflows:`), nhánh này bỏ qua hoàn toàn → **API key khác không mất quyền đọc**.
- Fence nằm trong route `/api/v1/operations/:id/result` (`:523`), không lan sang route khác (grep `endpoint_slug` trong `public.ts` chỉ ra **đúng 1** chỗ dùng).
- Vị trí so với fence tenant: nó chạy **sau** `if ((op.tenant_id) !== apiKey.tenantId) throw 404` (`:526`), nên không thay thế nor làm yếu fence tenant.

### d) Test có kiểm serialized problem body hay chỉ kiểm tra throw

**PASS — kiểm tra serialized body thật, không chỉ throw.**
- `tests/wfa-section8-med2-existence-oracle.test.ts:59-70` hàm `problemFor` bắt `HttpError` rồi gọi `caught.toProblem(CORRELATION_ID)` và trả về **object problem đã serialize**.
- Assertion là `expect(missing).toEqual(foreign)` (`:88`) và `expect(missing).toEqual(foreignTenant)` / `.toEqual(foreignProfile)` (`:112-113`) — so sánh **toàn bộ** problem (status, code, message/title, correlationId), không phải `rejects.toThrow`.
- Test có sức phân biệt thật: hai id khác nhau (`workflow-id-does-not-exist` vs `workflow-id-foreign`, dòng 7/77), nên nếu message vẫn mang ID thì hai chuỗi khác nhau → `toEqual` fail. Đây là oracle đúng, không phải assert hình thức.
- Stub `getOperation` (`:37-42`) ném đúng shape thật của `runtime.ts:1792-1795` (`404 NOT_FOUND`, message `operation ${id} not found`) → chính message ID-specific đó là thứ fix phải xoá.
- **Coverage NOTE (không phải FAIL):** test so *bằng* missing với foreign, không assert *đúng chuỗi* generic (`not found` / `operation not found`). Nếu cả hai cùng điểm sai thì test vẫn xanh. Đây là lựa chọn có chủ ý khớp với mục tiêu finding (không để lộ sự khác biệt), nhưng không khoá được nội dung message.
- Ngoài phạm vi claim của receipt fix: test chỉ chạy seam route offline, không khai báo phủ persistence/SQL fence.

## 4. RED — mọi FAIL (không giấu, không hạ xanh)

### RED #1 — `tests/public-upload-encryption-gateway.test.ts` (1 test)

```
● public upload encryption gateway › completes the public grant, binary upload, finalize replay, and submit route journey
  unexpected test DB query: UPDATE artifacts SET operation_id=$2 WHERE id = ANY($1::uuid[])
    AND tenant_id=$3 AND state='READY' AND operation_id IS NULL AND task_id IS NULL
  at tests/public-upload-encryption-gateway.test.ts:386:11
```

**Có liên quan tới fix MED-2 không? → KHÔNG.** Ba lý do độc lập:

1. **Call stack không chạm vùng sửa.** Lỗi nổ ra ở `submission.ts:660` ← `submission.ts:530` ← `handlePublicRoutes` tại `public.ts:398`. Fix MED-2 chỉ sửa `public.ts:66-83` (helper), `:489-500` (detail tenant-operator), `:532-535` (fence result của workflow). Dòng `:398` là route submit `POST /api/v1/businesses/:id/actions/:action` — nằm ngoài cả ba vùng đó.
2. **Cơ chế lỗi khác hẳn.** Đây là **stub DB của test** thiếu câu lệnh, không phải oracle 404. `submission.ts:659-665` chạy `UPDATE artifacts SET operation_id=…` trong cùng transaction để nối artifact đã tham chiếu vào operation (có chú thích giải thích lý do ở `:653-658`); test chỉ stub một số câu nhất định và ném `unexpected test DB query` cho phần còn lại (`:386`). Lỗi là **khoảng trống stub của test**, không phải hành vi sai của production code.
3. **Không có mã MED-2 nào trong đường đi này.** Không `throwFencedOperationNotFound`, không `getFencedOperation`, không so `endpoint_slug`. Cơ chế normalize 404 không liên quan tới một câu UPDATE artifacts.

**Vì do gi:** test `public-upload-encryption-gateway.test.ts` được viết trước khi `submission.ts` thêm câu `UPDATE artifacts SET operation_id=…`, và stub DB của nó chưa được cập nhật để chấp nhận câu đó. Journey submit có `referencedArtifactIds.length > 0` nên câu UPDATE được chạy và đụng stub cứng.

**Hành động của leg này:** KHÔNG sửa, KHÔNG nới assertion, KHÔNG xoá test, KHÔNG hạ cho xanh — đúng yêu cầu fail-first. Test đỏ này thuộc lane khác (upload/submission), không nằm trong lease MED-2.

### RED #2 — sự cố công cụ của chính leg (không phải lỗi product)

Lần ghi raw log đầu cho lệnh 1 dùng redirect shell và nhận `error TS5042: Option 'project' cannot be mixed with source files on a command line.` — đây là **lỗi cú pháp lệnh của tôi** (cmd truyền nhầm tham số vào `tsc`), **không phải** lỗi typecheck của repo. Đã ghi lại ở đây để không ai đọc nhầm là RED của product; lệnh 1 sau đó chạy lại đúng dạng và cho `exit 0` với output rỗng. Raw log `legB-1-tsc.log` là bản chạy lại đúng dạng.

### Ngoài ra

Không có FAIL nào khác: không test đỏ nào khác trong 3 lệnh; không có `Test Suites: … failed` nào ngoài lệnh 3; không suite nào bị bỏ qua im lặng (2 suite kia trong lệnh 3 đều PASS và đã ghi rõ tên).

## 5. Verdict

**VERIFIED-CLEAN** với caveat, ở phạm vi leg này có thể kết luận:

| Mục | Verdict |
|---|---|
| Typecheck | exit 0 |
| Test mới MED-2 (2 test) | 2/2 xanh, exit 0 |
| Regression 3 suite | 1 RED đã có sẵn, **không liên quan** fix MED-2 (lý do ở §4) |
| Doc review a | PASS |
| Doc review b | PASS (ghi chú platform-admin cố ý không bọc) |
| Doc review c | PASS |
| Doc review d | PASS + 1 coverage NOTE |
| Confunder | không đổi ở 3 mốc, không BLOCKER |

**Chưa làm và không thuộc quyền leg này:** không tick gate, không ghi VERIFIED/ACCEPTED, không sửa test đỏ của lane khác, không claim DB window. Coordinator/Reviewer mới là bên chốt T26/MED-2 và điều phối RED #1.

## 6. Ranh giới đã giữ

- Không sửa file `src/` hay test/ nào; không `git add`/`commit`/`push`.
- Không hand-edit `docs/21-openapi.json`.
- File duy nhất tạo/ghi: receipt này + 3 file raw log trong `coordination/reports/raw/verify-section8-med2-independent-legB-2026-10-08/`.
- Tất cả lệnh là **offline unit/typecheck**; không có claim nào về live DB hay cửa sổ DB.