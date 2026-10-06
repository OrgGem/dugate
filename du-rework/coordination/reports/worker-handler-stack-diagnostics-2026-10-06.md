# WORKER-HANDLER-ERROR-STACK-FIX (qwen_2) — 2026-10-06

**Task:** task_51ac703914e0 · ctx_d31dda12697a · tham chieu `coordination/reports/live-stack-deploy-e2e-2026-10-06.md`.
**Lease:** `packages/worker-sdk/src/worker.ts`. Doc-only o phan con lai. Khong commit, khong tick.

## 1. Fix 1 — logger that chi errorCode (XONG)

`packages/worker-sdk/src/worker.ts:401-417`:

```ts
const classified = classifyFailure(err);
logger.error('handler failed', {
  taskId: ctx.taskId,
  errorCode: classified.errorCode,
  retryable: classified.retryable,
  retryAfterMs: classified.retryAfterMs,
  errorName: err instanceof Error ? err.name : typeof err,
  message: err instanceof Error ? err.message : String(err),
  stack: err instanceof Error ? err.stack : undefined,
  detail: classified.detail,
  detailCause: err instanceof Error && err.cause instanceof Error
    ? { name: err.cause.name, message: err.cause.message, stack: err.cause.stack }
    : undefined,
});
```

Truoc day chi co `{ taskId, errorCode }`. Live receipt ghi ro: "the current worker logs expose only HANDLER_ERROR, so the underlying exception is unresolved" — fix nay dung thuoc do doc.

**Bang chung:** `npx tsc --noEmit -p tsconfig.json` (worker-sdk) — **Exit Code: 0**, khong diagnostic.

## 2. Fix 2 — dieu tra root cause (KET LUAN GIU HAN)

### Chuoi bang chung da xac minh

1. `classifyFailure` (worker-sdk) tra `HANDLER_ERROR` **chi khi loi khong co thuoc tinh `code` chuoi** — nghĩa la loi phai la **plain `Error` / `TypeError` / `ReferenceError`**, khong phai `BusinessExecutionError`/`ValidationError` (nhung cai sau nay deu co `.code` nen se bao ro ten rieng).
2. Da **loai tru** cac ung vien co ma: `BusinessExecutionError`, `ValidationError`, `LeaseLostError` — tat ca deu co `.code`, se ra `OPERATION_CANCELLED` / `MISSING_*` / `INPUT_HASH_MISMATCH`, khong phai `HANDLER_ERROR`.
3. **Co mot diem plain-Error dang chay TRUOC checkpoint dau tien:** `RecipeRegistry.getRecipe` (`recipes/recipe-definitions.ts:466`) throw `new Error('Unknown recipe for action "..."')` — plain Error. `selectRecipe` chay o `worker.ts` **truoc** `executeRecipe` (checkpoint dau tien). Day la **duong khop trieu chung**.
4. **NHUNG giac dinh do bi loai cho 2 fixture cu the:** `ingest:parse` (`recipe-definitions.ts:33`) va `extract:invoice` deu **da duoc dang ky**. Neu live gui dung 2 variant nay, `getRecipe` khong throw.

### Dieu kien "truoc checkpoint dau tien" — cac diem can chay (theo thu tu)

| # | Diem | File | Loi plain o day? |
|---|---|---|---|
| 1 | `assertActive(ctx)` | `worker.ts` (moi action) | it |
| 2 | `toInternalContext(ctx)` / `taskCrypto(ctx)` | `worker.ts:179/157` | co the |
| 3 | `XAction.validateInput` -> `InputNormalizer.normalize*` | `validation/input-normalizer.ts` | co the |
| 4 | `SchemaValidator.validateCustomSchema` (chi khi `type==='custom'`) | `actions/extract/index.ts:16` | it voi fixture invoice |
| 5 | `XAction.selectRecipe` -> `RecipeRegistry.getRecipe` | `recipes/recipe-definitions.ts:466` | **da kiem: 2 variant da dang ky** |
| 6 | `XAction.prepareSources` (doc artifact / parse pin) | `actions/{ingest,extract}/index.ts` | co the |

### Ket luan trung thuc

- **Khong the dat ten root cause tu doc code.** Live receipt noi ro "the underlying exception is unresolved"; stack chua bao gi. Bat bien code offline khong cho biet **loi runtime nao** no ra tren **deployment** build tu worktree dang in-flight (nhieu lane), va live stack da bi `down`.
- **Nhung dieu da chung minh duoc:** loi la **plain Error** (khong co `.code`), **nam truoc checkpoint dau tien**, va ** dung 2 action** => dung **mot diem dung chung** trong chuoi 1-6 o bang tren, KHONG phai mot diem rieng cua tung action.
- **Buoc tiep theo (dung, nhan):** chay lai live E2E, doc `stack`/`message`/`errorName` moi trong log worker. Fix 1 chinh la bo do do.

## 3. Gioi han

- **Khong chay live stack** (khong co window/permission trong packet nay) => khong co root cause da chung minh.
- **Khong sua business code** — chi worker-sdk/src/worker.ts. Khong dung `it.failing` hay ha test de 'xac nhan' gi.
- Khong commit, khong tick.

## 4. File da ghi

`packages/worker-sdk/src/worker.ts`, receipt nay.
