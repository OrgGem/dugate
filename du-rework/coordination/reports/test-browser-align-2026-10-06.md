# TEST-BROWSER-ALIGN - receipt (3 assertion edits; run BLOCKED by missing server)

> **RESUME POINT (qwen_5, 2026-10-06)** - task TEST-BROWSER-ALIGN. **3 test edits applied.**
> **The packageplaywright run did NOT pass: the suite expects a server at
> `http://127.0.0.1:5173` that is not running.** No product source touched, no commit, no push.

---

## 1. Edits applied (test assertions only, inside the allowed lease)

| File | Line | Before | After |
|---|---|---|---|
| navigation-completion.spec.ts | 23 | `expect(...nav.getByRole('link').count()).toBe(14)` | `toBe(15)` (SC-03 Secrets item) |
| admin-web.spec.ts | 49 (and twin) | `Admin Web bootstrap is running` | `Orchestrator Portal bootstrap is running` (PLAT-MIG-08 rename). Two identical occurrences, both updated via replace_all |
| identity-security-settings.spec.ts | 76 | `getByText('legacy:admin')` | `getByText('legacy:admin').first()` (strict-mode safe) |

Nav selector at `navigation-completion.spec.ts:22` already reads `Admin Web Navigation`, which is one of
the two labels the packet allows - left as-is.

## 2. The validation run - and why it did not pass

```
cd tests\browser
npx playwright test --config admin-web/playwright.config.ts navigation-completion.spec.ts

Running 4 tests using 1 worker
  x 1 …desktop navigation, account dialog, and logout endpoint
  x 2 …business/version suggestions and unavailable-registry fallback
  x 3 …320px navigation and UTC calendar validation
  x 4 …connector suggestions come from the advertised management list

Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/admin/web/...
4 failed   Exit Code: 1
```

**Every failure is `ERR_CONNECTION_REFUSED` at the page.goto** - the suite drives a real server that
listens on `http://127.0.0.1:5173`, and that server is **not running**. This is an environmental block, not
an assertion regression: the corrected assertions themselves were never evaluated.

## 3. What this packet did NOT prove

- **4/4 PASS was NOT achieved.** The acceptance criterion is unmet.
- Whether `14 -> 15` matches the real rendered nav depends on a rebuilt `apps/admin-web/dist` that
  includes the SC-03 Secrets entry; I did not rebuild dist, so even with a server up the count may also
  fail until a build is run.
- Same caveat for the `Orchestrator Portal bootstrap is running` heading - it depends on the P3/PLAT-MIG-08
  rename having been built into dist.

## 4. To actually verify

1. Rebuild: `pnpm --filter @du/admin-web build`
2. Start the expected server on port 5173 (the suite hardcodes that BASE; the harness seam uses a
   different port and would not satisfy this suite).
3. Re-run the same playwright command and paste the literal exit code.

## 5. Ledger

- TEST-BROWSER-ALIGN - Muc 1 - 3 assertion edits applied exactly as specified (nav count 14->15, product
  heading renamed to Orchestrator Portal bootstrap is running via replace_all on both occurrences, and the
  legacy:admin strict-mode fix via .first()). Validation run attempted and FAILED with 4/4 ERR_CONNECTION_REFUSED:
  the suite expects a real server on port 5173 that is not running, and dist was not rebuilt. Acceptance NOT
  met. No product source touched, no commit, no push.
