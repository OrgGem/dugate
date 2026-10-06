# LEGACY-AUDIT-TEST-FIX - receipt (3 stale assertions in admin-local-user-repository)

> **RESUME POINT (qwen_5, 2026-10-05)** - task LEGACY-AUDIT-TEST-FIX (task_ba631a1d8782),
> dispatch ctx_e94ec2afbbe9. Status: **fixed, 10/10 x3, related suites green.**
> **TEST-ONLY**: 3 assertions in one test file. `audit.ts` untouched, no audit behaviour reverted,
> no product source edited, no commit, nothing ticked.

---

## 1. Why the assertions were stale (verified, not assumed)

**The writer changed in an earlier wave.** `src/modules/audit/audit.ts:121-135` now inserts nine
columns and binds nine params:

```
INSERT INTO admin_audit_events
  (tenant_id, actor, actor_issuer, actor_sub, actor_role, action, resource, severity, correlation_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
params = [tenantId, actor, actorIssuer ?? null, actorSub ?? null, actorRole ?? null,
          action, resource, severity ?? "info", correlationId ?? null]
```

The old test asserted the previous six-value shape. The failure diff confirmed it exactly - the
received array carried three extra `null` values between the actor and the action:

```
  Array [
    "c1aec1ae-1111-4111-8111-c1aec1aec1ae",
    "admin-local-user-cli",
+   null,
+   null,
+   null,
    "admin_local_user.create",
    "admin_local_user:e3cfc3cf-3333-4333-8333-e3cfc3cfe3cf",
    "success",
    null,
  ]
```

So the action moved from **index 2 to index 5**, and the audit row grew from 6 to 9 params.

---

## 2. The three fixes (test file only)

| # | Line | Before | After |
|---|---|---|---|
| 1 | 179 | `audit?.params` expected 6 values `[tenant, actor, action, resource, severity, null]` | 9 values with `null, null, null` for `actorIssuer`/`actorSub`/`actorRole` at positions 3-5 |
| 2 | 240 | `statement.params[2] === "admin_local_user.disable"` | `statement.params[5] === "admin_local_user.disable"` |
| 3 | 273 | `item.params[2] === "admin_local_user.credentials_rotated"` | `item.params[5] === "admin_local_user.credentials_rotated"` |

All three are index/shape corrections to match the current writer. No assertion was weakened:
fix 1 still pins the full param array, and fixes 2 and 3 still require the exact action string.

---

## 3. Literal runs

`pnpm exec jest tests/admin-local-user-repository.test.ts` - 3 consecutive runs:
```
Tests:       10 passed, 10 total
Exit Code: 0   (run 1)
Exit Code: 0   (run 2)
Exit Code: 0   (run 3)
```

Related admin-local-user suites (one command):
```
PASS  tests/admin-local-user-role-policy.test.ts
PASS  tests/admin-local-user-repository.test.ts
PASS  tests/admin-local-users-cli.test.ts
Test Suites: 1 skipped, 3 passed, 3 of 4 total
Tests:       1 skipped, 25 passed, 26 total
Exit Code: 0
```
The one skip is `admin-local-users-migration.test.ts`, which is gated and skips by design - not a
failure and not something this packet touched.

---

## 4. Attribution - read this before blaming anyone

**This was an old run after another lane's change, and the old test was not modified by me.**

- The stale assertions were written against the pre-wave `audit.ts` (6 params). The wave that added
  `actor_issuer` / `actor_sub` / `actor_role` and pushed placeholders changed the writer; the test
  file was not updated in the same change.
- I changed **only the three assertions** listed in section 2. I did **not** touch `audit.ts`, did
  **not** revert or weaken the audit writer, and did **not** touch any other assertion in the file.
- The other 7 tests in the file were already green and stay green; the 3 that failed failed for the
  single reason shown in section 1.

**Measured attribution (`git status` + write times):**

```
git status  M du-rework/services/orchestrator/src/modules/audit/audit.ts   <- the earlier wave, NOT this packet
git status  M du-rework/services/orchestrator/tests/admin-local-user-repository.test.ts

10/04/2026 09:48 PM    audit.ts                             7,928 B   <- wave change
10/05/2026 05:09 AM    admin-local-user-repository.test.ts  13,327 B  <- this packet
```

`audit.ts` is genuinely modified relative to the repository baseline, but it was last written about
seven hours before this packet opened. I only ever read it in this packet.

---

## 5. Ledger

- LEGACY-AUDIT-TEST-FIX - Muc 1 - fixed 3 stale assertions in
  tests/admin-local-user-repository.test.ts (audit params 6 -> 9 after the actor_issuer/actor_sub/
  actor_role wave); suite 10/10 x3 Exit Code: 0; related admin-local-user suites 25 passed + 1 gated
  skip, Exit Code: 0; audit.ts untouched, no audit behaviour reverted, no product source edited,
  no commit.
