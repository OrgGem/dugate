# CR06-07 — Tri-state Policy Discipline (qwen_2) — 2026-10-06

**Task:** CR06-07 (MEDIUM, `tasks/CODE-REVIEW-FOLLOWUP-2026-10-06.md`) · Worker SDK Developer.
**Write lease:** `packages/worker-sdk/src/task-context.ts` + `packages/worker-sdk/tests/**`. Khong commit, khong push.

## 1. Defect

`task-context.ts:307` (truoc fix):
```ts
this.profilePolicy = task.profilePolicy ?? null;
```

`?? null` gop `undefined` (pre-pin) vao `null` (admitted-without-policy) — **lam mat phan biet 3 trang thai**, dung o cho comment ngay ben duoi (:308-311) noi ro "`null` (no carrier) stays null, `undefined` (a context that never carried the pin) stays undefined. Neither is coalesced." Comment va code **mau thuan**, va code sai.

## 2. Fix

```ts
// CR06-07 (tri-state discipline): straight pass-through. `undefined`
// (pre-pin / a context that never carried the pin) MUST stay `undefined`,
// `null` (admitted-without-policy) MUST stay `null`, and a populated policy
// must pass through untouched. The previous `?? null` silently collapsed the
// first two states into one, which is exactly the distinction a consumer
// needs in order to tell "no pin" from "pinned, and the pin says no".
this.profilePolicy = task.profilePolicy;
```

Kieu field da khai san cho phep ca 3 trang thai (`PinnedProfilePolicy | null | undefined`) — **chi can bo coalesce**, khong doi type.

## 3. Test (moi, trong lease)

`packages/worker-sdk/tests/cr06-07-tri-state-policy.test.ts` — 4 test:
1. `undefined` (pre-pin) giu nguyen `undefined`, **khong** phai `null`.
2. `null` (admitted-without-policy) giu nguyen `null`.
3. populated policy truyen qua nguyen ven.
4. ba trang thai **phan biet duoc voi nhau** (`prePin !== noPolicy`).

## 4. Bang chung (literal Exit Codes)

- `npx tsc --noEmit -p tsconfig.json` (worker-sdk) — **Exit Code: 0**.
- `npx jest tests/cr06-07-tri-state-policy.test.ts` — **4/4, Exit Code: 0**.
- Focused x3 (cr06-07 + worker.test + p730-sdk-consume-pin-passthrough): `Test Suites: 3 passed` / `Tests: 33 passed` — **Exit Code: 0** ca 3 lan.
- **MUTATION PROBE (A/B control):** tam khoi lai `?? null` -> test **FAIL 2/4**, dung ly do canh chon:
  - `keeps undefined (pre-pin) as undefined, NOT null` → `Expected: undefined / Received: null`.
  - `the three states are distinguishable from each other` → `expect(prePin).not.toBe(noPolicy)` fail.
  Re-apply fix → 4/4 xanh. **Test co tac dung, khong pass vi ly do sai.**

## 5. Regression toan package

`Test Suites: 1 failed, 31 passed, 32 total` / `Tests: 1 failed, 1 todo, 711 passed, 713 total`.

- **`tests/crypto-seam.test.ts` (1 test) — PRE-EXISTING, KHONG lien quan thay doi nay.** Chi tiet: diff o mot so sanh object co `keyRef` / `keyVersion` (`Expected -14 / Received +8`), **khong co `profilePolicy` trong diff**. Thay doi cua toi chi dung mot dong gan `profilePolicy`; khong duong nao cham vao crypto seam.

## 6. Gioi han

- Khong sua shared contracts. Khong commit, khong push.
- **Khong tick gate** — CR06-07 la MEDIUM follow-up, acceptance thuoc reviewer/coordinator.
- Khong tach `undefined` ra kieu `null` o `toInternalContext` cua document-core (ngoai lease nay) — neu do muon tiep, can packet rieng.

## 7. File da ghi

`packages/worker-sdk/src/task-context.ts`, `packages/worker-sdk/tests/cr06-07-tri-state-policy.test.ts`, receipt nay.
