# SKIPPED-TESTS-TRIAGE-816 - receipt (classification of the skipped tests)

> **RESUME POINT (qwen_5, 2026-10-05)** - task SKIPPED-TESTS-TRIAGE-816. DOC/TRIAGE: no source edit,
> no commit, no tick. Method: `findstr` over `services/orchestrator/tests` + one `jest --listTests`.

---

## 0. Count discrepancy - reported before anything else

The packet says **230 skipped**. **I could not reproduce that number.** My measurements:

```
jest --listTests            -> 217 test files in services/orchestrator
last full run (after my 9-suite fix) -> 41 skipped
full run before that fix             -> 229 skipped  (but 9 suites were failing to run)
```

So **229 is the number that matches** the packet, and it came from a run where 9 suites were red for an
unrelated reason (a broken pg mock - see WRAPPER-FIX-812). A suite that fails to run contributes its tests
as neither passed nor skipped, which is why the figure moved to 41 once those suites compiled again.
**Neither number is trustworthy until the full suite is green** - and it currently is not, because a
concurrent lane is mid-edit in `src/modules/runtime/runtime.ts` (TS2554 at :478).

---

## 1. Classification by GATE MECHANISM (the axis that matters)

33 of 217 files reference a skip gate. Grouped by *why* they skip:

### Class A - live infrastructure window (BY DESIGN, the dominant class)

```
const liveDescribe = LIVE ? describe : describe.skip;   // LIVE = DU_LIVE_INFRA
```

Files: `admin-action-rbac-live`, `admin-audit`, `admin-base-routes`, `admin-error-boundary`,
`admin-keyset-explain`, `admin-shell-live-pane`, `artifact-grant-fencing`, `artifacts-fencing-pg`,
`blob-wire-binary`, `data-02-04-live-s3`, `ingress-bounded`, `migrations`, `vault-live`,
`webhook-reclaim-fence.live`, plus the shared `helpers/runtime-harness.ts` that exports `liveDescribe`.

Each of these prints its own reason, e.g. `admin-audit.test.ts:58: SKIPPED - set DU_LIVE_INFRA=1 inside an
open DB window to run.`

**Verdict: legitimate, not a defect.** These require a real PostgreSQL/Redis/S3/Vault window, which the
programme deliberately does not open in a shared checkout. The skip is the safety property, not a gap.

### Class B - a narrower live gate (BY DESIGN)

| Gate | File | Why narrower |
|---|---|---|
| `DU_LOCAL01_LIVE_MIGRATION=1` | `admin-local-users-migration.test.ts:12` | private-schema migration smoke; needs its own schema, not the shared window |
| `GATE_AUTH_PG_URL` | `gate-authenticate-808-pg16.test.ts:23` | the auth-gate PG16 fixture; deliberately points at a throwaway DB |

**Verdict: legitimate.** Both are the same class as A with a tighter prerequisite.

### Class C - conditional `skipIf` inside otherwise-offline suites (REVIEW THESE)

Files that run offline but skip individual cases on a condition:
`admin-oidc04-claims-tenant-offline`, `oidc02-multi-replica-offline`, `oidc02-process-replicas-offline`,
`oidc03-role-action-tenant-offline`, `operation-tenant-fence`, `usage-summary`, `workspace-reference`, and the
`runtime-*` family (`runtime`, `runtime-admin-auth`, `runtime-facade`, `runtime-health`, `runtime-hitl`,
`runtime-recovery`, `runtime-version-lifecycle`, `runtime-webhook`).

**Verdict: this is where a real gap could hide.** A `skipIf` inside an offline suite can silently disable a
case in CI forever. Each one needs its condition read and stated. **I did not read all of them** - that is
the remaining work, and I am flagging it rather than guessing.

### Class D - a static `describe.skip` block

`oidc02-multi-replica-offline.test.ts:291` carries a commented rationale: "Offline unit runs NEVER touch this
block (describe.skip => zero sockets...)". That is a deliberate socket-safety block.

**Verdict: legitimate, and the rationale is already in the file.**

---

## 2. What is NOT a skip

Two of the 33 grep hits are not test files: `fixtures/oidc02-replica-harness.ts` and
`helpers/runtime-harness.ts`. They *define* the gate for others. Counting them as "skipped suites" would
inflate the number - worth stating because it is an easy miscount.

---

## 3. Triage summary

| Class | Count | Verdict |
|---|---:|---|
| A live-infra window (`DU_LIVE_INFRA`) | 14 files + 1 shared helper | legitimate by design |
| B narrow live gate | 2 files | legitimate by design |
| C conditional `skipIf` in offline suites | ~15 files | **REVIEW** - the only place a real gap can hide |
| D static `describe.skip` block | 1 file | legitimate, rationale in-file |
| not test files | 2 | miscount risk, not skips |

**Bottom line: the large majority of skips are the live-window gate working as intended. The actionable
work is Class C** - read each `skipIf` condition and state whether it can ever be true in CI.

## 4. Honest limits

1. **The count is not settled.** 230/229/41 differ because the denominator moved; no number here should be
   quoted as "the skipped count" until the full suite is green (currently blocked by the concurrent runtime.ts
   edit).
2. **Class C is unread.** I classified by grep pattern, not by reading each condition. Saying otherwise would
   be inventing the result.
3. **No test was run for this triage** beyond `--listTests`.

## 5. Ledger

- SKIPPED-TESTS-TRIAGE-816 - Muc 1 - triaged the skipped tests by gate mechanism: 33/217 files reference a
  skip gate, split into Class A live-infra window (14 + 1 shared helper, legitimate), Class B narrow live
  gates (2, legitimate), Class C conditional skipIf in offline suites (~15, FLAGGED as the only place a real
  gap can hide, conditions not yet read), Class D static describe.skip (1, rationale in-file), plus 2
  non-test files that would inflate a naive count. Count discrepancy disclosed: 230/229/41 depending on how
  many suites compiled; not settled while the concurrent runtime.ts edit blocks a green full suite. No source
  edit, no commit, no tick.
