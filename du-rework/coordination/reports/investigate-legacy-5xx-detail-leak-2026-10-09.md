# INVESTIGATE — legacy 5xx detail leak qua workflowHostErrorResponse (2026-10-09)

**Vai trò:** verifier/investigator độc lập — lane khác tác giả, lane khác Codex (term_ca784044). **KHÔNG sửa gì.**
**Scope:** chỉ du-rework · chỉ đọc + phân tích · không edit source/test/config/docs · không commit / `git add` / push · không tick gate · không đọc `.env.live` · OFFLINE (không PG/Redis, không claim DB window).
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`
**Bối cảnh:** residual R5 từ `coordination/reports/investigate-legacy-http-503-2026-10-09.md`.

## Kết luận nhanh

| Câu hỏi | Trả lời |
|---|---|
| (a) Rủi ro thật hay 5xx luôn public-safe? | **Rủi ro thật nhưng đang ở dạng TIỀM ẨN (latent)**: cơ chế rò có thật và không được chặn, nhưng **chưa chứng minh được đường rò cụ thể nào** trên đường legacy workflow hôm nay |
| (b) Mức độ | **LOW** — kèm điều kiện leo thang: thành MEDIUM ngay khi có ai thêm một HttpError 5xx mang chi tiết upstream/DB vào đường submit |
| (c) Fix tối thiểu | Chỉ redact khi `status >= 500` (giữ nguyên detail 4xx cho legacy parity), tại 3 điểm forward giống nhau, tái dùng đúng câu chữ của `internalError()`; **kèm** một test 5xx + một test parity 4xx |

---

## Phương pháp — lệnh/grep đã chạy

| # | Loại | Lệnh / mẫu grep | Kết quả dùng cho |
|---|---|---|---|
| 1 | read | `src/compat/legacy-http-mount.ts` 400-459 | Q1 |
| 2 | read | `src/http/errors.ts` 1-49 và 59-108 | Q3, Q4 |
| 3 | grep | `src/compat`: `function legacyError\|internalError\|titleForStatus` | Q1, Q4 |
| 4 | grep | `src`: `new HttpError\(\s*5\d\d` (60 hit) | Q2 |
| 5 | grep | `src`: `new HttpError\([^\n]*\$` (56 hit) | Q2 (message động) |
| 6 | grep | `src`: `new HttpError\([^\n]*(\.message\|String\()` (13 hit) | Q2 (message nhúng lỗi khác) |
| 7 | read | `src/compat/legacy-http-mount.ts` 193-222, 328-341, 388-407, 508-521, 540-599, 612-623 | Q1 |
| 8 | grep | `src`: `submitLegacyWorkflow` | Q2 (reachability) |
| 9 | read | `src/compat/legacy-host-adapter.ts` 105-179 | Q2 (reachability) |
| 10 | read | `src/modules/artifacts/artifacts.ts` 1374-1403 (`storageErrorToHttp`) | Q2 |
| 11 | grep | `src`: `safeInternalErrorProblem\|errorClassOf` (15 hit) | Q4 |
| 12 | grep+read | `src/app/bootstrap/create-app.ts` 714-735, 795-814, 883-893 | Q4 |
| 13 | grep | `tests`: `Internal Error\|internal error \(correlationId\|Service Not Available` (15 hit) | Q5 (test coverage) |
| 14 | grep+read | `tests/legacy-http-mount.test.ts` `new HttpError\|detail:` + dòng 258-320 | Q5 |

---

## Q1 — `workflowHostErrorResponse` (:428-450) và `legacyError`: nhánh nào trả 5xx, message có thể chứa gì

**Nguyên văn `src/compat/legacy-http-mount.ts:428-450`:**

```ts
function workflowHostErrorResponse(
  error: unknown,
  correlationId: string | undefined,
): LegacyRouteResponse {
  if (error instanceof HttpError) {
    const title = error.status === 422 ? 'Invalid Parameter' : titleForStatus(error.status);
    return legacyError(error.status, title, error.message, correlationId);
  }
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'SCHEMA_NOT_ACTIVE') {
    return legacyError(409, 'Conflict', 'The requested workflow schema has no active revision.', correlationId);
  }
  if (code === 'SCHEMA_INVALID') {
    return legacyError(400, 'Invalid Schema', 'The requested workflow schema is invalid.', correlationId);
  }
  if (code === 'SCHEMA_CRYPTO_UNAVAILABLE') {
    return legacyError(503, 'Service Not Available', 'Workflow schema storage is temporarily unavailable.', correlationId);
  }
  return internalError(correlationId);
}
```

**Nguyên văn `legacyError` (`:195-210`):**

```ts
export function legacyError(
  status: number,
  title: string,
  detail: string,
  correlationId?: string,
): LegacyRouteResponse {
  const body: Record<string, unknown> = {
    type: `${LEGACY_ERROR_BASE}${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
  };
  if (correlationId !== undefined) body.correlationId = correlationId;
  return { status, body, headers: {} };
}
```

**`internalError` (`:331-340`) — redactor duy nhất của file này:**

```ts
/** Map a DB error onto the legacy surface without echoing driver text. */
function internalError(correlationId: string | undefined): LegacyRouteResponse {
  const id = correlationId ?? '';
  return legacyError(
    500,
    'Internal Error',
    `The request could not be completed (correlationId ${id}).`,
    id === '' ? undefined : id,
  );
}
```

**Phân nhánh:**

| Nhánh | Điều kiện | Status | `detail` lấy từ đâu |
|---|---|---|---|
| **A. HttpError** (`:429-435`) | `error instanceof HttpError` | `error.status` — **gồm mọi 5xx** | **`error.message` nguyên văn** ⇒ đây là nhánh 5xx duy nhất, và nó forward thẳng |
| B. code = `SCHEMA_NOT_ACTIVE` | non-HttpError | 409 | chuỗi literal |
| C. code = `SCHEMA_INVALID` | non-HttpError | 400 | chuỗi literal |
| D. code = `SCHEMA_CRYPTO_UNAVAILABLE` | non-HttpError | 503 | **literal** an toàn |
| E. fallback (`:448`) | non-HttpError còn lại | 500 | `internalError()` → đã redact |

`titleForStatus` (`:393-405`): 400/401/403/404/409/413/415/503 → title tương ứng; **503 → 'Service Not Available'**; mọi 5xx khác (500/501/502/504) → **default 'Internal Error'**.

**Hai call site của `workflowHostErrorResponse`** (grep: `:548`, `:575`):

| Dòng | Ngữ cảnh | Có thể ném 5xx gì |
|---|---|---|
| `:548` | `resolveLegacyWorkflowSchema(...)` (schema resolution/pin) | crypto/storage unavailable |
| `:575` | `await host.submitLegacyWorkflow(principal, workflowRequest, schemaPin)` | admission + preflight + upload artifact + submit |

**Cùng một mẫu forward `error.message` còn xuất hiện ở HAI chỗ nữa** (không qua `workflowHostErrorResponse` nhưng cùng hình dạng):

- `:514` — catch quanh `readLegacyWorkflowMultipart(request)` (400 parse, đúng như packet nêu ở dòng :425 cũ; nay là **:513-515**):
  `if (error instanceof HttpError) { return legacyError(error.status, titleForStatus(error.status), error.message, correlationId); }`
- `:619` — catch quanh `decodeLegacyMultipart(...)`: cùng một dòng y hệt.

⇒ **Kết luận Q1:** nhánh 5xx là nhánh **A**, và `detail` = `error.message` của bất kỳ `HttpError` nào có `status >= 500`. Message có thể chứa **bất cứ thứ gì mà service ném ra** — không có bộ lọc nào ở tầng mount. Tầng mount **chỉ** redact cho **non-HttpError** (nhánh E).


---

## Q2 — Grep `src/compat` và `modules`: có HttpError 5xx nào bị ném với message chi tiết không?

### Kết quả grep tổng

| Mẫu (grep) | Số hit | Ghi chú |
|---|---|---|
| `new HttpError(\s*5\d\d` trên toàn `src` | **60** | mọi HttpError 5xx |
| `new HttpError([^\n]*\$` (message có interpolation) | **56** | gần hết là 4xx (404/409/422/413/415) |
| `new HttpError([^\n]*(.message\|String()` (nhúng message lỗi khác) | **13** | 2 nhóm: credential fence + Vault |

### Các HttpError 5xx có message ĐỘNG (danh sách đầy đủ đã tìm được)

| file:line | Status / code | Message động | Nhạy cảm |
|---|---|---|---|
| `src/modules/connectors/connectors.ts:78` | 502 `CONNECTOR_UNAVAILABLE` | `` `connector ${connectorId} ${reason}` `` | có — lộ **connectorId** nội bộ + `reason` từ provider |
| `src/modules/connector-credentials/workflow.ts:160` | 502 `VAULT_WRITE_FAILED` | `'Vault write failed: ' + String(code ?? 'unknown')` | **cao nhất trong danh sách** — embed **mã lỗi upstream Vault** (theo đúng mô tả của policy ADM-BASE-03 ở `errors.ts:78-84`: *"upstream Vault/IdP errors can echo DSNs with passwords, filesystem paths or bearer tokens"*) |
| `src/modules/usage/usage.ts:226` | 500 `TEMPORARY_UNAVAILABLE` | `` `usage ledger contains an invalid ${field} timestamp` `` | thấp — chỉ tên field |
| `src/modules/usage/budget-reservations.ts:164` | 503 `BUDGET_RESERVATION_UNAVAILABLE` | `` `quota reservation contains an invalid ${field}` `` | thấp — tên field |
| `src/modules/usage/budget-reservations.ts:167` | 503 | `` `quota reservation ${field} is outside the supported range` `` | thấp |
| `src/modules/usage/budget-reservations.ts:175` | 503 | `` `quota ${field} exceeds the supported range` `` | thấp |

Mọi HttpError 5xx còn lại có **message literal cố định** — ví dụ: `submission.ts:235/307` (`workflow submissions require configured metadata encryption`), `artifacts.ts:179,929,932,1109,1112,1391,1393,1395,1401` (static `unavailable(...)`), `create-app.ts:110/191`, `runtime.ts:544`, `public.ts:58/114/121/251/268/308/349/358/373/690`, `admin.ts:257/588/597/735`, `usage.ts:371/402/436/518/521/615`, và toàn bộ 20 site `dispatcher.ts` dạng `credential workflow not wired`.

### Reachability: 6 site đó **CÓ** tới được 2 call site của `workflowHostErrorResponse` không?

Đọc `submitLegacyWorkflow` (`src/compat/legacy-host-adapter.ts:114-180+`) cho thấy nó gọi đúng 4 thứ:

1. `ctx.submission.preflightLegacyWorkflow(...)` — HttpError 4xx; 5xx = `submission.ts:235,307` **static**.
2. `ctx.artifacts.assertPublicArtifactEncryptionReady()` — 5xx **static**.
3. `ctx.artifacts.putPublicArtifact({...})` — bọc qua `storageErrorToHttp`.
4. `ctx.submission.submit(...)` — admission; 4xx + 503 static.

**`storageErrorToHttp` (`src/modules/artifacts/artifacts.ts:1374-1403`) đóng đường rò storage:** `ArtifactStorageError` chỉ mang `code` cố định (union type, `storage-facade.ts:38-66`), và `s3-storage-facade.ts:229-230,267-268` ném `STORAGE_UNAVAILABLE` **không kèm message gốc**. Map về HttpError dùng chuỗi literal nguyên khối; dòng cuối ghi rõ chủ ý:

```ts
  // Never propagate provider exception messages, request IDs, URLs or paths.
  return unavailable('artifact storage is temporarily unavailable');
```

⇒ **4/6 site message-động (connectors, Vault, usage x4) KHÔNG thuộc đường legacy workflow host.**

**Lỗ hổng còn lại của `src/compat`:** grep `new HttpError(|\bunavailable(` trong `src/compat` cho **14 hit — tất cả là 4xx** (400/413/415, ở `legacy-multipart.ts` và `legacy-http-mount.ts:308/453`). Không có HttpError 5xx nào được khai báo trong chính `compat`.

⇒ **Kết luận Q2:** **KHÔNG** tìm thấy HttpError 5xx nào bị ném với message chứa DB error / path / secret **trên đường legacy workflow**. Nhưng **có** 6 HttpError 5xx message-động ở nơi khác, trong đó `connector-credentials/workflow.ts:160` embed mã lỗi Vault — chứng minh quy ước "HttpError message phải public-safe" **không được kiểm** (không có lint/test nào chặn). Đây là lý do rủi ro còn tồn tại ở dạng tiềm ẩn.

---

## Q3 — `HttpError` trong `src/http/errors.ts`: khi nào message an toàn public, khi nào là internal?

**Nguyên văn `src/http/errors.ts:9-27`:**

```ts
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Partial<ProblemDetails>
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toProblem(correlationId?: string): ProblemDetails {
    return problem(this.status, this.code, this.message, undefined, {
      correlationId,
      ...this.extra,
    });
  }
}
```

**Trả lời câu hỏi khi nào an toàn:**

Câu trả lời bọc lại — **không có thuộc tính nào trong class phân biệt public-safe hay internal.**

- `toProblem()` chèn `this.message` thẳng vào `detail` (`:22-26`), không qua bước nào.
- Vì vậy phân loại do **người throw quyết định ở nơi throw**, không phải do lớp đối tượng.
- **An toàn public** = message được biên soạn có chủ đích, chuỗi cố định, chỉ chứa từ vựng domain đã biết là ổn: ví dụ `'encrypted delivery is unavailable'`, `'artifact storage is temporarily unavailable'`, `'the legacy workflow submission service is not available on this deployment.'`. Các câu này **nằm nguyên văn trong các assertion của test** — tức là *được* coi là public, và chính test đó khoá chúng lại.
- **Internal** = message gồm text thô từ bên ngoài/lớp dưới: DB driver, DSN, filesystem path, request-ID URL, bearer token, mã lỗi upstream (Vault/IdP/provider), `String(err)`. **Không có đường phân biệt kỹ thuật nào ở đây.**

Doctrine chính thức của repo — comment **ADM-BASE-03** (`errors.ts:78-84`) — nêu rõ:

```text
 * ADM-BASE-03 (tasks/SEC-OIDC-VAULT-2026-09-24.md): the one text policy for
 * surfaces that show UNEXPECTED errors (HTTP problem bodies, rendered Admin
 * pages, logs). Raw `err.message`/`String(err)` must never enter any of
 * them — DB drivers, HTTP clients and (once VAULT/OIDC land) upstream
 * Vault/IdP errors can echo DSNs with passwords, filesystem paths or bearer
 * tokens. Only stable codes, fixed safe text and correlation IDs cross the
 * boundary; operators join a wire correlationId to the class-only log line.
```

Và `safeInternalErrorProblem` (`errors.ts:98-105`) — redactor cho **non-HttpError**:

```ts
export function safeInternalErrorProblem(correlationId: string): Record<string, unknown> {
  return {
    type: 'urn:du:error:temporary_unavailable',
    title: 'internal error',
    status: 500,
    code: 'TEMPORARY_UNAVAILABLE',
    detail: `internal error (correlationId ${correlationId})`,
    correlationId,
  };
}
```

⇒ **Kết luận Q3:** chính sách của repo (ADM-BASE-03) nói rạch ròi *"Only stable codes, fixed safe text and correlation IDs cross the boundary"* — nhưng nó **chỉ được thi hành ở phía non-HttpError**. Một `HttpError` 5xx không tuân thủ → `message` của nó lọt nguyên ra client ở mọi surface (legacy lẫn modern), không cảnh báo, không lint, không test.


---

## Q4 — Có nhánh nào khác đã redact 5xx trước khi trả client, để đề xuất cách nhất quán?

### Đã grep toàn `src`: `safeInternalErrorProblem` / `errorClassOf` (15 hit) và `safeTransportErrorText` / `unavailable(` (42 hit)

| Surface | Cơ chế redact | Có redact **HttpError 5xx** không? |
|---|---|---|
| **Modern HTTP boundary** — `app/bootstrap/create-app.ts:722-725` | `if (isHttpError(err)) { res.end(JSON.stringify(err.toProblem(fallbackId))) }` | **KHÔNG** — forward `err.message` cho **mọi** status |
| **Modern ingress** — `create-app.ts:801-806` | như trên | **KHÔNG** |
| **Modern request** — `create-app.ts:883-887` | như trên | **KHÔNG** |
| Modern boundary, nhánh non-HttpError — `create-app.ts:729, 811, 893` | `sanitizedInternalError(id)` = `safeInternalErrorProblem` | ✅ redact |
| **Legacy workflow/schema mount** — `legacy-http-mount.ts:434` (+ `:514`, `:619`) | nhánh HttpError → `legacyError(..., error.message, ...)` | **KHÔNG** |
| Legacy mount, nhánh non-HttpError — `legacy-http-mount.ts:448, 516, 554, 561, 577, 608, 621, 641` | `internalError(correlationId)` | ✅ redact |
| Legacy action router — `compat/legacy-action-router.ts:474` | `internalErrorResponse(correlationId)` (dùng ở `:385, :410, :431`) | ✅ redact (non-HttpError) |
| Admin shell / admin section-data | `safeTransportErrorText(prefix)` — `shell-server.ts:263, :857`; `overview/business/connector/profile/operation/audit/api-key-section-data.ts` | ✅ redact — câu cố định `'… Details redacted (see server log).'` |

**Nguyên văn nhánh modern (`create-app.ts:722-725`) để đối chiếu trực tiếp:**

```ts
      if (isHttpError(err)) {
        res.statusCode = err.status;
        res.end(JSON.stringify(err.toProblem(fallbackId)));
        return;
      }
      logger.error('unhandled listener error', { errorName: errorNameOf(err), correlationId: fallbackId });
      res.statusCode = 500;
      res.end(JSON.stringify(sanitizedInternalError(fallbackId)));
```

### Phát hiện quan trọng cho Q4

**Ranh giới redact của codebase là *lớp đối tượng* (`HttpError` vs không), KHÔNG phải *dải status*.** Cả legacy mount lẫn modern boundary đều đối xử y hệt: `HttpError` ⇒ tin `message`; mọi thứ khác ⇒ redact.

Hệ quả cần owner biết:

1. Đây là **nhất quán** — nhưng nhất quán trên một quy ước **không được thi hành** (Q3).
2. Nếu chỉ vá `legacy-http-mount.ts`, legacy mount sẽ **nghiêm hơn** modern surface cho cùng một lớp lỗi ⇒ tạo ra một loại lệch mới. Cần nêu rõ đây là quyết định phạm vi, không phải chi tiết kỹ thuật.
3. Có **sẵn hai câu chữ** để tái dùng, không cần đặt câu thứ ba: `internalError()` → `'The request could not be completed (correlationId X).'` (legacy vocabulary) và `safeTransportErrorText()` → `'<prefix>. Details redacted (see server log).'`.
4. `safeInternalErrorProblem` là hình dạng bị **pin bởi test live W46-C2** (comment `errors.ts:94-97`), nên sửa nó là thay đổi có blast radius lớn hơn — không nằm trong fix tối thiểu.

---

## Q5 — Kết luận (a)(b)(c)

### (a) Đây có phải rủi ro thật, hay message 5xx luôn public-safe?

**Rủi ro THẬT về cơ chế, nhưng đang ở dạng TIỀM ẨN (latent) — chưa chứng minh được đường rò cụ thể nào.**

Phía **có rủi ro** (chứng cứ):

- `legacy-http-mount.ts:434` forward `error.message` **nguyên văn** cho mọi `HttpError`, kể cả 5xx. Không có bộ lọc theo status.
- Cùng mẫu ở `:514` và `:619` ⇒ 3 điểm forward, không chỉ 1.
- Chính sách ADM-BASE-03 (`errors.ts:78-84`) tuyên bố raw `err.message` **không bao giờ** được qua ranh giới — nhưng chỉ thi hành cho non-HttpError. Đây là **khoảng trống giữa chính sách và thi hành**.
- **Không có test nào** phủ nhánh HttpError-5xx-message của `workflowHostErrorResponse`. Đã grep `tests`: 15 hit cho `Internal Error` / `Service Not Available` / `internal error (correlationId` — **không hit nào** throw một `HttpError` 5xx qua `workflowHostErrorResponse`. `tests/legacy-http-mount.test.ts` hiện có 3 assertion `detail:` 503 (`:274`, `:292`, `:313`) — cả ba là **literal của mount** (2 nhánh cấu hình + nhánh `SCHEMA_CRYPTO_UNAVAILABLE`), đi qua nhanh **non-HttpError**, không phải `error.message`. ⇒ **Xác nhận tiền đề của packet: không có test cho nhánh 5xx forward qua HttpError.** (Phần lưu ý đồng thời dưới đây.)
- Đã **có** 6 HttpError 5xx message-động trong repo, trong đó `connector-credentials/workflow.ts:160` embed **mã lỗi Vault** — đúng loại dữ liệu mà ADM-BASE-03 nói phải chặn. Quy ước đang bị vi phạm ở nơi khác, nên "5xx luôn public-safe" là **không được bảo đảm bằng bất kỳ cơ chế nào**.

### Ghi chú A — một test hygiene đã tồn tại, nhưng nằm ở nhánh khác

`tests/legacy-http-mount.test.ts:524-535` có test:

`ts
  it('never echoes a decoder or host error message into a 500', async () => {
    const r = await handleLegacyRoute(req({ /* garbage multipart */ }), host());
    expect(r?.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r?.body)).not.toMatch(/secret|SQL|password/i);
  });
`

→ Đây chính là **hình mẫu nên copy** để viết test còn thiếu. Nhưng nó **chỉ phủ nhánh non-HttpError**: garbage multipart ném decode error → `internalError()` (`:621`) đã redact sẵn. Nó **không** đi qua nhánh `error instanceof HttpError` (`:434`) nên không bắt được lỗi này. Có một redactor hoạt động đúng không có nghĩa là đường còn lại cũng được test — đó chính là residual R5.

### Ghi chú B — hai file này đã bị lane khác sửa ĐỒNG THỜI trong lúc tôi điều tra (không phải tôi)

Chạy `git status --porcelain` **sau** lượt đọc cho thấy:

```text
 M du-rework/orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts   (+21 / -5)
 M du-rework/orchestrator/services/orchestrator/tests/legacy-http-mount.test.ts     (+63)
```

- Cả hai **sạch ở lượt `git status` đầu của tôi** trong cùng phiên, giờ `M` ⇒ lane khác (không phải tôi) đang sửa đúng khu vực này. Tôi chỉ dùng `read_file` / `grep`, không hề `edit` file nào ngoài receipt này.
- `git diff -- tests/legacy-http-mount.test.ts` cho thấy đúng **3 test 503 được thêm mới** (các test tôi vừa trích ở `:274/:292/:313`) — **toàn bộ đi qua nhánh non-HttpError, 0 hit `new HttpError`**, nên **kết luận của tôi không đổi**.
- Hậu quả cho packet: **R5 đang được một lane khác xử lý song song.** Nếu lane đó còn `legacy-http-mount.ts`, đề xuất (c) bên dưới rất có thể **trùng phạm vi** — cần coordinator xác nhận trước khi giao tiếp, tránh hai lane cùng vá một file.

Phía **chưa phải rò đang xảy ra** (chứng cứ):

- 4/6 site message-động (connectors, Vault, usage, budget) **không thuộc** đường legacy workflow host — đã truy reachability qua `legacy-host-adapter.ts:114-180`.
- Mọi HttpError 5xx **có thể** tới từ `submitLegacyWorkflow` đều mang message **literal cố định** (`submission.ts:235/307`; `artifacts.ts:1391-1401`).
- Lỗi DB/driver thô **không** phải HttpError ⇒ rơi vào nhánh E (`internalError`, `:448`) ⇒ **đã redact**. Đây là lý do "DB error" không rò qua đường này.
- Lỗi storage/provider đã bị `storageErrorToHttp` (`artifacts.ts:1374-1403`) chặn bằng thiết kế, có comment chủ ý ở `:1401`, và `ArtifactStorageError` chỉ mang `code` cố định.
- Không có HttpError 5xx nào được khai báo trong `src/compat` (14 hit, tất cả 4xx).

⇒ Phát biểu chính xác nhất: **cơ chế rò đang mở và không được test, nhưng hiện chưa có payload 5xx nào mang chi tiết nội bộ đi qua nó trên đường legacy workflow.**

### (b) Nếu rủi ro, mức độ LOW / MEDIUM?

**LOW.**

Lý do:

1. **Chưa có đường rò được chứng minh** — không có input nào của khách tạo ra được một 5xx HttpError chứa chi tiết nội bộ trên đường này hôm nay (đã truy reachability).
2. **Bề mặt hẹp và có xác thực**: đây là legacy-compat mount sau API key; không phải endpoint ẩn danh.
3. **Hai lớp nhạy cảm nhất đã đóng bằng thiết kế**: text driver DB (non-HttpError → `internalError`) và text provider storage (`storageErrorToHttp`).
4. **Điều kiện leo thang rõ ràng** — leo lên **MEDIUM** ngay khi có ai thêm một HttpError 5xx mang chi tiết upstream/DB/Vault vào đường submit (ví dụ dùng lại `connector-credentials/workflow.ts:160` trong preflight, hoặc bọc lỗi driver thành `new HttpError(500, ..., err.message)`). Vì guard đang **vắng mặt**, khoảng cách từ LOW lên MEDIUM chỉ là **một lần sửa code**, không cần lỗ hổng mới.
5. Không có dấu hiệu đã bị khai thác; không có log/evidence nào trong phạm vi đọc cho thấy payload 5xx chứa chi tiết nội bộ đã ra tới client.

### (c) Đề xuất fix tối thiểu (KHÔNG implement — chỉ đề xuất)

**Nguyên tắc: chỉ redact khi `status >= 500`; giữ nguyên detail 4xx cho legacy parity.**

1. **Phạm vi tối thiểu (chỉ legacy mount):** tại 3 điểm forward giống nhau — `legacy-http-mount.ts:434` (trong `workflowHostErrorResponse`), `:514`, `:619` — thay
   `legacyError(error.status, title, error.message, correlationId)`
   bằng một helper dùng chung, ví dụ
   `legacyHostDetail(error, correlationId)` trả về `error.message` khi `error.status < 500`, và trả về **đúng câu chữ của `internalError()`** — `'The request could not be completed (correlationId X).'` — khi `status >= 500`.
   Giữ **nguyên** `status` và `titleForStatus(status)` (503 vẫn ra `'Service Not Available'`, 500/502 ra `'Internal Error'`) ⇒ không đổi hợp đồng status/title, chỉ đổi `detail`.

2. **Không đụng** các literal 5xx đã an toàn (`:443-444` `SCHEMA_CRYPTO_UNAVAILABLE`, `:568-570` `submitLegacyWorkflow === undefined`). Ba assertion hiện có ở `tests/legacy-http-mount.test.ts:274/292/313` **không** đi qua nhánh HttpError, nên fix này **không làm đỏ test nào** — đã kiểm bằng grep (`new HttpError` trong file test: 0 hit).

3. **Giữ khả năng truy vết**: log thật ở server (`logger.error` với `errorClassOf(err)` + `correlationId`, không log `err.message`), để operator join bằng `correlationId` — đúng mô hình ADM-BASE-03 (`errors.ts:80-83`).

4. **Thêm 2 test** (đây là phần bắt buộc để không tái phát):
   - **Test 5xx redaction**: host ném `new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'pg: password authentication failed for dsn postgres://user:secret@host/db')` ⇒ assert `body.detail` **KHÔNG** chứa `secret`/`postgres://`/`password`, và **có** `correlationId`.
   - **Test parity 4xx**: host ném `new HttpError(409, 'CONFLICT', 'the requested workflow schema has no active revision.')` ⇒ assert `body.detail` **vẫn là nguyên văn message** (khoá legacy parity lại, để lần sau không ai redact nhầm cả 4xx).

5. **Câu hỏi phạm vi owner PHẢI quyết** (không tự quyết): vá **chỉ legacy mount** (nhỏ nhất, đóng residual R5, nhưng làm legacy nghiêm hơn modern surface) hay **tập trung hoá** ở một hàm dùng chung cho cả `create-app.ts:722-725 / :801-806 / :883-887` (nhất quán, blast radius lớn hơn, không đụng `safeInternalErrorProblem` vì hình dạng đó bị pin bởi W46-C2).

6. **Cách khác đáng cân nhắc (rẻ hơn, phòng ngừa thay vì chữa):** thêm một kiểm tra tĩnh/unit (kiểu test của `adm-base-03-safe-error-offline.functional.test.ts`, vốn đã grep source để chặn mẫu `'Internal error: ' + raw`) để cấm `new HttpError(5xx, ..., <interpolation động>)` — biến quy ước thành thứ được thi hành, thay vì chỉ vá một call site.

---

## XÁC NHẬN

- **KHÔNG sửa gì.** Chỉ đọc file + grep + phân tích. Không edit source/test/config/docs; không đụng `legacy-http-mount.ts`, `errors.ts`, `create-app.ts`, `artifacts.ts` hay bất kỳ test nào.
- **KHÔNG commit, KHÔNG `git add`, KHÔNG push.**
- **KHÔNG tick gate** nào (VERIFIED / ACCEPTED / IMPLEMENTED đều của coordinator).
- **KHÔNG đọc `.env.live`.** OFFLINE: lượt này **không chạy test nào** (chỉ đọc + grep) — không mở PostgreSQL/Redis/S3, không claim DB window.
- **Giới hạn lượt này:** kết luận reachability dựa trên **đọc code tĩnh** (grep + trace call), **không** dựng được một request thật để chứng minh 5xx có chi tiết nội bộ đi ra client. Phần "chưa có đường rò cụ thể" là **kết luận từ phân tích tĩnh**, không phải từ thực nghiệm.
- **Trạng thái git trong phạm vi tôi đọc, lúc kết thúc:** `src/compat/legacy-http-mount.ts`, `src/http/errors.ts`, `src/app/bootstrap/create-app.ts`, `src/modules/artifacts/artifacts.ts` → **sạch**. Riêng `src/compat/legacy-host-adapter.ts` và `tests/legacy-http-mount.test.ts` → ` M` **do lane khác sửa đồng thời** (chi tiết ở Ghi chú B), **không phải do tôi**: lượt này tôi không `edit` bất kỳ file nào trong repo ngoài receipt này.
- **Đề xuất (c) CHƯA được áp dụng** — không có dòng nào của nó nằm trong repo; số liệu "test hiện có sẽ không đỏ" là suy luận từ grep, chưa chạy lại suite.
